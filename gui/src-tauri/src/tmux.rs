// The unified tmux session pool — the persistence substrate the stateless GUI
// itself lacks. Agents and ad-hoc shells all live as tmux sessions in one pool.
// Shells are name-tagged (`iudex-shell-N`); agents carry an *opaque* unique name
// (`iudex-agent-<id>`) with their ticket/role/start-time held in tmux
// user-options (`@iudex_*`), so any number of agents can coexist per ticket. The
// GUI attaches to a session through a PTY for an interactive terminal, and reads
// a session's screen with `capture-pane` for the read-only peeks in the Agents
// grid. Sessions outlive the GUI: closing a terminal only detaches the client.

use std::collections::HashMap;
use std::io::{Read, Write};
use std::path::Path;
use std::process::Command;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Mutex, OnceLock};
use std::time::{SystemTime, UNIX_EPOCH};

use base64::Engine;
use portable_pty::{native_pty_system, Child, CommandBuilder, MasterPty, PtySize};
use tauri::{AppHandle, Emitter, State};

/// Every session this GUI owns is named with this prefix so we never touch the
/// user's own tmux sessions.
const PREFIX: &str = "iudex-";

/// A session in the pool, as surfaced to the frontend. For shells `ticket`,
/// `role`, and `started` are None; for agents they come from tmux user-options.
#[derive(serde::Serialize)]
pub struct Session {
    pub name: String,
    pub kind: String,            // "agent" | "shell"
    pub ticket: Option<String>,  // agent's ticket id (e.g. "t3")
    pub role: Option<String>,    // agent's role at spawn ("impl" | "qa")
    pub started: Option<String>, // agent spawn time (unix millis, sortable)
    pub root: Option<String>,    // workspace this session belongs to (@iudex_root)
    // Auto-Retire mark: kill deadline (unix millis, like `started`) stamped on a
    // superseded agent, and a pardon flag that opts a session out of re-marking.
    #[serde(rename = "retireAt")]
    pub retire_at: Option<String>, // @iudex_retire_at (empty ⇒ None)
    #[serde(rename = "retirePardon")]
    pub retire_pardon: bool, // @iudex_retire_pardon == "1"
    pub title: String,           // display label (frontend may override)
}

/// "" → None, else Some(trimmed). Tmux returns empty strings for unset options.
fn nonempty(s: &str) -> Option<String> {
    let t = s.trim();
    if t.is_empty() {
        None
    } else {
        Some(t.to_string())
    }
}

/// Unix milliseconds, as a string — used for an agent's opaque-name suffix and
/// its `@iudex_started` (sortable for the Agents grid ordering).
fn now_millis() -> String {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis().to_string())
        .unwrap_or_default()
}

/// A live PTY attached to a tmux session, held so its threads/handles outlive
/// the command that created it. Dropping it (via `close_terminal`) kills the
/// attach client — which only detaches; the tmux session lives on.
struct Pty {
    master: Box<dyn MasterPty + Send>,
    writer: Box<dyn Write + Send>,
    child: Box<dyn Child + Send + Sync>,
}

/// Holds every open interactive terminal, keyed by a frontend-supplied id.
#[derive(Default)]
pub struct PtyState(Mutex<HashMap<String, Pty>>);

static SEQ: AtomicU64 = AtomicU64::new(1);

/// The resolved tmux binary, cached after the first successful probe. A GUI
/// launched from Finder/the desktop gets a minimal PATH that misses Homebrew's
/// bin, so invoking a bare `"tmux"` can fail even when tmux is installed;
/// resolution falls back to the login shell's PATH, then well-known install
/// dirs. Every tmux invocation goes through `tmux_bin()`.
fn tmux_cache() -> &'static Mutex<Option<String>> {
    static CACHE: OnceLock<Mutex<Option<String>>> = OnceLock::new();
    CACHE.get_or_init(|| Mutex::new(None))
}

fn tmux_works(bin: &str) -> bool {
    Command::new(bin)
        .arg("-V")
        .output()
        .map(|o| o.status.success())
        .unwrap_or(false)
}

pub(crate) fn tmux_bin() -> String {
    if let Some(p) = tmux_cache().lock().unwrap().clone() {
        return p;
    }
    // Unresolved → still say "tmux", so error messages stay natural.
    refresh_tmux_bin().unwrap_or_else(|| "tmux".to_string())
}

/// Re-probe for a usable tmux and update the cache (also un-caches one that
/// stopped answering). Called by the availability check and after an install.
fn refresh_tmux_bin() -> Option<String> {
    let mut found = None;
    if tmux_works("tmux") {
        found = Some("tmux".to_string());
    } else {
        let login = crate::login_shell_path();
        let known = [
            "/opt/homebrew/bin",
            "/usr/local/bin",
            "/home/linuxbrew/.linuxbrew/bin",
            "/usr/bin",
        ];
        for dir in login.split(':').chain(known) {
            if dir.is_empty() {
                continue;
            }
            let p = Path::new(dir).join("tmux");
            if p.is_file() && tmux_works(&p.to_string_lossy()) {
                found = Some(p.to_string_lossy().into_owned());
                break;
            }
        }
    }
    *tmux_cache().lock().unwrap() = found.clone();
    found
}

/// True when a usable `tmux` can be resolved. The Terminal/Agents views degrade
/// to a hint when it can't.
#[tauri::command(async)]
pub fn tmux_available() -> bool {
    refresh_tmux_bin().is_some()
}

/// Homebrew, resolved the same way as tmux (it lives in the same PATH blind
/// spot). Powers the onboarding one-click install.
fn brew_bin() -> Option<String> {
    let works = |bin: &str| {
        Command::new(bin)
            .arg("--version")
            .output()
            .map(|o| o.status.success())
            .unwrap_or(false)
    };
    if works("brew") {
        return Some("brew".to_string());
    }
    let login = crate::login_shell_path();
    let known = [
        "/opt/homebrew/bin",
        "/usr/local/bin",
        "/home/linuxbrew/.linuxbrew/bin",
    ];
    for dir in known.into_iter().chain(login.split(':')) {
        if dir.is_empty() {
            continue;
        }
        let p = Path::new(dir).join("brew");
        if p.is_file() {
            return Some(p.to_string_lossy().into_owned());
        }
    }
    None
}

/// The tmux prerequisite as onboarding sees it: present (and which version),
/// one-click installable (Homebrew found), and the right copy-paste command
/// for the manual path.
#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TmuxSetup {
    pub installed: bool,
    pub version: Option<String>,
    pub can_install: bool,
    pub install_hint: String,
}

#[tauri::command(async)]
pub fn tmux_setup_status() -> TmuxSetup {
    let bin = refresh_tmux_bin();
    let version = bin.as_deref().and_then(|b| {
        Command::new(b)
            .arg("-V")
            .output()
            .ok()
            .filter(|o| o.status.success())
            .map(|o| String::from_utf8_lossy(&o.stdout).trim().to_string())
    });
    let brew = brew_bin().is_some();
    let install_hint = if brew || cfg!(target_os = "macos") {
        "brew install tmux".to_string()
    } else if Path::new("/usr/bin/apt").is_file() || Path::new("/usr/bin/apt-get").is_file() {
        "sudo apt install tmux".to_string()
    } else if Path::new("/usr/bin/dnf").is_file() {
        "sudo dnf install tmux".to_string()
    } else if Path::new("/usr/bin/pacman").is_file() {
        "sudo pacman -S tmux".to_string()
    } else {
        "install tmux with your system's package manager".to_string()
    };
    TmuxSetup {
        installed: bin.is_some(),
        version,
        can_install: brew,
        install_hint,
    }
}

/// One-click install: `brew install tmux` (no sudo needed, unlike the Linux
/// package managers, which stay copy-paste). Async + spawn_blocking so the
/// minutes-long install never blocks the UI thread. Refreshes the tmux cache on
/// success and returns the installed version.
#[tauri::command]
pub async fn install_tmux() -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(|| -> Result<String, String> {
        let brew = brew_bin().ok_or("Homebrew not found — install tmux manually")?;
        let out = Command::new(&brew)
            .args(["install", "tmux"])
            .output()
            .map_err(|e| format!("{brew}: {e}"))?;
        if !out.status.success() {
            let err = String::from_utf8_lossy(&out.stderr);
            return Err(format!("brew install tmux failed: {}", err.trim()));
        }
        let bin = refresh_tmux_bin()
            .ok_or("brew finished but tmux still isn't runnable — check `tmux -V` in a terminal")?;
        let v = Command::new(&bin)
            .arg("-V")
            .output()
            .map_err(|e| e.to_string())?;
        Ok(String::from_utf8_lossy(&v.stdout).trim().to_string())
    })
    .await
    .map_err(|e| e.to_string())?
}

/// List the *entire* pool — every `iudex-…` tmux session on the machine,
/// unfiltered. A missing tmux server just means an empty pool, not an error.
/// The public `list_sessions` command scopes this to one workspace; internal
/// callers (shell-index allocation) need the full global view, since session
/// names are machine-global.
fn list_all() -> Result<Vec<Session>, String> {
    // One call returns every session's name plus its metadata (empty for shells /
    // non-pool sessions). Tab-delimited; tmux names/option values never hold tabs.
    let out = Command::new(tmux_bin())
        .args([
            "list-sessions",
            "-F",
            "#{session_name}\t#{@iudex_ticket}\t#{@iudex_role}\t#{@iudex_started}\t#{@iudex_root}\t#{@iudex_retire_at}\t#{@iudex_retire_pardon}",
        ])
        .output()
        .map_err(|e| format!("tmux: {e}"))?;
    if !out.status.success() {
        let err = String::from_utf8_lossy(&out.stderr);
        if err.contains("no server running") || err.contains("error connecting") {
            return Ok(vec![]);
        }
        return Err(err.trim().to_string());
    }
    Ok(String::from_utf8_lossy(&out.stdout)
        .lines()
        .filter_map(parse_line)
        .collect())
}

/// List the pool for one workspace: sessions tagged with this `root`, plus any
/// untagged session (legacy ones from before scoping, or one whose tag failed to
/// stamp) so a live agent is never hidden. This is what stops one project's
/// sessions from showing up in another — the GUI polls it with the open
/// workspace's root.
#[tauri::command(async)]
pub fn list_sessions(root: String) -> Result<Vec<Session>, String> {
    Ok(list_all()?
        .into_iter()
        .filter(|s| s.root.as_deref() == Some(root.as_str()) || s.root.is_none())
        .collect())
}

/// Build a Session from a `list_sessions` line. Agents (opaque `iudex-agent-…`
/// names) take their ticket/role/started from the user-option columns; shells
/// (`iudex-shell-N`) are name-derived. Anything else is skipped.
fn parse_line(line: &str) -> Option<Session> {
    let mut cols = line.split('\t');
    let name = cols.next()?;
    let ticket = nonempty(cols.next().unwrap_or(""));
    let role = nonempty(cols.next().unwrap_or(""));
    let started = nonempty(cols.next().unwrap_or(""));
    let root = nonempty(cols.next().unwrap_or(""));
    let retire_at = nonempty(cols.next().unwrap_or(""));
    let retire_pardon = cols.next().unwrap_or("").trim() == "1";

    if name.starts_with(&format!("{PREFIX}agent-")) {
        let title = match (&ticket, &role) {
            (Some(t), Some(r)) => format!("{t} · {r}"),
            (Some(t), None) => t.clone(),
            _ => "agent".to_string(),
        };
        Some(Session {
            name: name.to_string(),
            kind: "agent".to_string(),
            ticket,
            role,
            started,
            root,
            retire_at,
            retire_pardon,
            title,
        })
    } else if name.starts_with(&format!("{PREFIX}idea-")) {
        // Idea-shaping agents: ticket-less, `@iudex_role` holds the skill name.
        let title = role
            .as_ref()
            .map(|r| format!("idea: {r}"))
            .unwrap_or_else(|| "idea".to_string());
        Some(Session {
            name: name.to_string(),
            kind: "idea".to_string(),
            ticket: None,
            role,
            started,
            root,
            retire_at,
            retire_pardon,
            title,
        })
    } else if let Some(tail) = name.strip_prefix(&format!("{PREFIX}shell-")) {
        Some(Session {
            name: name.to_string(),
            kind: "shell".to_string(),
            ticket: None,
            role: None,
            started: None,
            root,
            retire_at: None,
            retire_pardon: false,
            title: format!("shell {tail}"),
        })
    } else {
        None
    }
}

/// Enable mouse mode on a session so the wheel scrolls tmux history (copy-mode)
/// inside the attached xterm. Without it tmux holds the alternate screen and the
/// pane can't be scrolled at all. Set per-session so we never touch the user's
/// global/default tmux configuration.
fn enable_mouse(name: &str) {
    let _ = Command::new(tmux_bin())
        .args(["set-option", "-t", name, "mouse", "on"])
        .status();
}

/// PATH for new sessions when the GUI runs its *bundled* CLI: ~/.iudex/bin
/// prepended to the GUI's own PATH. Agents inside sessions run bare
/// `iudex finish`/`iudex qa`, which a zero-setup install (nothing on the user's
/// PATH) could not resolve otherwise. None when the user overrode the binary —
/// their PATH story, don't shadow it.
fn session_path() -> Option<String> {
    let dir = crate::session_path_prepend()?;
    let cur = std::env::var("PATH").unwrap_or_default();
    Some(if cur.is_empty() {
        dir
    } else {
        format!("{dir}:{cur}")
    })
}

/// `tmux new-session -d -s <name> [-c cwd] [cmd]`, with the bundled-CLI PATH
/// injection (`-e`, tmux ≥ 3.2) when active.
fn new_session(name: &str, cwd: Option<&str>, cmd: Option<&str>) -> Result<(), String> {
    let mut args: Vec<&str> = vec!["new-session", "-d", "-s", name];
    let env;
    if let Some(p) = session_path() {
        env = format!("PATH={p}");
        args.push("-e");
        args.push(&env);
    }
    if let Some(dir) = cwd {
        args.push("-c");
        args.push(dir);
    }
    if let Some(c) = cmd {
        args.push(c);
    }
    let st = Command::new(tmux_bin())
        .args(&args)
        .status()
        .map_err(|e| format!("tmux new-session: {e}"))?;
    if !st.success() {
        return Err("tmux new-session failed".to_string());
    }
    Ok(())
}

/// Create a fresh detached shell session with the lowest free index. An optional
/// `cwd` starts the shell in that directory (used by Worktrees' "Open shell" to
/// drop into a worktree); omitted, it starts wherever tmux defaults.
#[tauri::command(async)]
pub fn create_shell(root: String, cwd: Option<String>) -> Result<Session, String> {
    // Shell names are machine-global, so allocate the index against the full pool.
    let existing = list_all()?;
    let mut n = 1;
    while existing.iter().any(|s| s.name == format!("{PREFIX}shell-{n}")) {
        n += 1;
    }
    let name = format!("{PREFIX}shell-{n}");
    new_session(&name, cwd.as_deref(), None)?;
    enable_mouse(&name);
    // Scope the shell to the workspace it was opened from (read back by list_sessions).
    let _ = Command::new(tmux_bin())
        .args(["set-option", "-t", &name, "@iudex_root", &root])
        .status();
    Ok(Session {
        name,
        kind: "shell".to_string(),
        ticket: None,
        role: None,
        started: None,
        root: Some(root),
        retire_at: None,
        retire_pardon: false,
        title: format!("shell {n}"),
    })
}

/// Launch a new agent for a ticket into the pool. Captures the spawn command
/// iudex prints for the ticket's *current* state (`iudex spawn` — impl while
/// active, QA once pending-qa), then runs it inside a fresh, *opaque-named*
/// `iudex-agent-<id>` tmux session. This is the deliberate bridge: iudex only
/// prints the command, the GUI is the hand that runs it.
///
/// Agents *accumulate* — each call is a distinct session, so one ticket can have
/// several agents over its life (impl, then QA, …). `role` is GUI metadata only
/// (it does not change the command — iudex derives the prompt from ticket state);
/// it and the ticket/start-time are stored as tmux user-options for the Agents
/// view to label and order by.
#[tauri::command(async)]
pub fn spawn_agent(root: String, ticket: String, role: String) -> Result<Session, String> {
    let out = Command::new(crate::iudex_bin())
        .args(["spawn", &ticket])
        .current_dir(&root)
        .output()
        .map_err(|e| format!("iudex spawn: {e}"))?;
    if !out.status.success() {
        return Err(String::from_utf8_lossy(&out.stderr).trim().to_string());
    }
    let cmd = String::from_utf8_lossy(&out.stdout).trim().to_string();
    if cmd.is_empty() {
        return Err("iudex spawn produced no command".to_string());
    }

    // Opaque, collision-free name (millis + monotonic seq); identity/metadata
    // live in user-options, not the name.
    let started = now_millis();
    let name = format!(
        "{PREFIX}agent-{started}-{}",
        SEQ.fetch_add(1, Ordering::Relaxed)
    );
    new_session(&name, None, Some(&cmd))?;
    // Keep the pane after the agent process exits, so its exit status survives
    // for the status heuristic (alive→working/idle, exited 0→awaiting-finish,
    // exited non-zero→crashed). Without this the session would just vanish.
    let _ = Command::new(tmux_bin())
        .args(["set-option", "-w", "-t", &name, "remain-on-exit", "on"])
        .status();
    enable_mouse(&name);
    // Stamp identity/metadata as user-options (read back by list_sessions).
    for (opt, val) in [
        ("@iudex_ticket", ticket.as_str()),
        ("@iudex_role", role.as_str()),
        ("@iudex_started", started.as_str()),
        ("@iudex_root", root.as_str()),
    ] {
        let _ = Command::new(tmux_bin())
            .args(["set-option", "-t", &name, opt, val])
            .status();
    }

    Ok(Session {
        name,
        kind: "agent".to_string(),
        ticket: Some(ticket),
        role: nonempty(&role),
        started: Some(started),
        root: Some(root),
        retire_at: None,
        retire_pardon: false,
        title: String::new(),
    })
}

/// Wrap a string as a single-quoted POSIX shell token (safe for spaces,
/// newlines, quotes). `'` becomes `'\''`.
fn sh_quote(s: &str) -> String {
    format!("'{}'", s.replace('\'', "'\\''"))
}

/// Launch an idea-shaping agent into the pool: run the configured agent at the
/// workspace root, preloaded with a front-of-funnel skill (grill-me, …) and an
/// optional seed. The agent loads the skill via AGENTS.md and drives the chain
/// itself (→ to-prd → to-issues → `iudex queue`), so any tickets it creates show
/// up through the events.jsonl doorbell. Ticket-less: `@iudex_role` holds the
/// skill name. The frontend opens this session in the Terminal to converse.
#[tauri::command(async)]
pub fn spawn_idea(root: String, skill: String, seed: String) -> Result<Session, String> {
    let mut prompt = format!(
        "Use the \"{skill}\" skill (.iudex/skills/{skill}/SKILL.md) to shape work \
         into iudex tickets. Follow the skill and its chained skills through to \
         registering tickets with `iudex queue`."
    );
    if !seed.trim().is_empty() {
        prompt.push_str(&format!("\n\nIdea / focus:\n{}", seed.trim()));
    }

    let agent = crate::resolve_agent_command(&root, "idea")?;
    // Run the agent at the workspace root (skills live there, not in worktrees).
    let cmd = format!("cd {} && {} {}", sh_quote(&root), agent, sh_quote(&prompt));

    let started = now_millis();
    let name = format!(
        "{PREFIX}idea-{started}-{}",
        SEQ.fetch_add(1, Ordering::Relaxed)
    );
    new_session(&name, None, Some(&cmd))?;
    let _ = Command::new(tmux_bin())
        .args(["set-option", "-w", "-t", &name, "remain-on-exit", "on"])
        .status();
    enable_mouse(&name);
    for (opt, val) in [
        ("@iudex_role", skill.as_str()),
        ("@iudex_started", started.as_str()),
        ("@iudex_root", root.as_str()),
    ] {
        let _ = Command::new(tmux_bin())
            .args(["set-option", "-t", &name, opt, val])
            .status();
    }

    Ok(Session {
        name,
        kind: "idea".to_string(),
        ticket: None,
        role: nonempty(&skill),
        started: Some(started),
        root: Some(root),
        retire_at: None,
        retire_pardon: false,
        title: format!("idea: {skill}"),
    })
}

/// The conflict-resolution agent's brief. It **triages** — resolving only what it
/// is confident about and **flagging, never guessing**, anything that needs human
/// judgment — then reports structurally. It commits the merge only if it resolved
/// everything; any flagged file leaves the merge in progress for the human.
// The canonical copy is the embedded template the CLI scaffolds into
// .iudex/prompts/resolve.md on init; include_str! pulls in the *same bytes* at
// build time (cross-tree into the Go template dir) so this fallback can never
// drift from what `iudex init` writes. Cargo rebuilds when the file changes.
pub(crate) const RESOLVE_PROMPT: &str =
    include_str!("../../../templates/dot_iudex/prompts/resolve.md");

/// The resolver prompt: the workspace's editable `.iudex/prompts/resolve.md` if
/// present, else the built-in default (for workspaces created before it existed).
fn resolve_prompt(root: &str) -> String {
    let path = Path::new(root)
        .join(".iudex")
        .join("prompts")
        .join("resolve.md");
    match std::fs::read_to_string(&path) {
        Ok(s) if !s.trim().is_empty() => s,
        _ => RESOLVE_PROMPT.to_string(),
    }
}

/// Launch a conflict-resolution agent into the worktree. Assumes a merge is
/// already in progress there (the GUI runs `begin_resolution` first). It is a
/// normal agent-kind session (ticket set, role `resolve`), so it appears in the
/// Agents grid and can be watched/attached like any other; the human directs or
/// takes over via its terminal. iudex's lifecycle is untouched — conflict
/// resolution is GUI territory, so the prompt is built here, not by the CLI.
#[tauri::command(async)]
pub fn spawn_resolver(root: String, ticket: String, worktree: String) -> Result<Session, String> {
    let agent = crate::resolve_agent_command(&root, "resolve")?;
    let prompt = resolve_prompt(&root);
    let cmd = format!("cd {} && {} {}", sh_quote(&worktree), agent, sh_quote(&prompt));

    let started = now_millis();
    let name = format!(
        "{PREFIX}agent-{started}-{}",
        SEQ.fetch_add(1, Ordering::Relaxed)
    );
    new_session(&name, None, Some(&cmd))?;
    let _ = Command::new(tmux_bin())
        .args(["set-option", "-w", "-t", &name, "remain-on-exit", "on"])
        .status();
    enable_mouse(&name);
    for (opt, val) in [
        ("@iudex_ticket", ticket.as_str()),
        ("@iudex_role", "resolve"),
        ("@iudex_started", started.as_str()),
        ("@iudex_root", root.as_str()),
    ] {
        let _ = Command::new(tmux_bin())
            .args(["set-option", "-t", &name, opt, val])
            .status();
    }

    Ok(Session {
        name,
        kind: "agent".to_string(),
        ticket: Some(ticket),
        role: Some("resolve".to_string()),
        started: Some(started),
        root: Some(root),
        retire_at: None,
        retire_pardon: false,
        title: String::new(),
    })
}

/// Bulk-dismiss finished agents: kill every agent session whose pane has exited
/// (dead), leaving live ones untouched. Backs the Agents view "clear finished"
/// action. Returns how many were removed.
#[tauri::command(async)]
pub fn clear_finished() -> Result<u32, String> {
    let out = Command::new(tmux_bin())
        .args([
            "list-sessions",
            "-F",
            "#{session_name}\t#{pane_dead}",
        ])
        .output()
        .map_err(|e| format!("tmux: {e}"))?;
    if !out.status.success() {
        let err = String::from_utf8_lossy(&out.stderr);
        if err.contains("no server running") || err.contains("error connecting") {
            return Ok(0);
        }
        return Err(err.trim().to_string());
    }
    let agent_prefix = format!("{PREFIX}agent-");
    let mut killed = 0u32;
    for line in String::from_utf8_lossy(&out.stdout).lines() {
        let (name, dead) = line.split_once('\t').unwrap_or((line, ""));
        if name.starts_with(&agent_prefix) && dead.trim() == "1" {
            let _ = Command::new(tmux_bin())
                .args(["kill-session", "-t", name])
                .status();
            killed += 1;
        }
    }
    Ok(killed)
}

/// Process-liveness of a session's pane: whether its command has exited and, if
/// so, the exit code. Combined with output activity and ticket state on the
/// frontend, this yields the synthesized agent status. iudex has no liveness
/// signal of its own; this is the GUI's cheap process-level one.
#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PaneStatus {
    pub dead: bool,
    pub exit_code: Option<i32>,
}

#[tauri::command(async)]
pub fn session_status(name: String) -> Result<PaneStatus, String> {
    let out = Command::new(tmux_bin())
        .args([
            "display-message",
            "-p",
            "-t",
            &name,
            "-F",
            "#{pane_dead}|#{pane_dead_status}",
        ])
        .output()
        .map_err(|e| format!("tmux display-message: {e}"))?;
    if !out.status.success() {
        return Err(String::from_utf8_lossy(&out.stderr).trim().to_string());
    }
    let s = String::from_utf8_lossy(&out.stdout);
    let line = s.trim();
    let (dead_s, code_s) = line.split_once('|').unwrap_or((line, ""));
    let dead = dead_s.trim() == "1";
    let exit_code = if dead {
        code_s.trim().parse::<i32>().ok()
    } else {
        None
    };
    Ok(PaneStatus { dead, exit_code })
}

/// A pool session's liveness, keyed by name — the batch counterpart of
/// `session_status` for the poll paths (agent statuses, automation drains),
/// which ask about every session at once: one tmux spawn instead of N.
#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NamedPaneStatus {
    pub name: String,
    pub dead: bool,
    pub exit_code: Option<i32>,
}

#[tauri::command(async)]
pub fn session_statuses() -> Result<Vec<NamedPaneStatus>, String> {
    // Session formats expand pane variables against the session's active pane;
    // pool sessions are single-pane, so this is exactly their command's status.
    let out = Command::new(tmux_bin())
        .args([
            "list-sessions",
            "-F",
            "#{session_name}\t#{pane_dead}\t#{pane_dead_status}",
        ])
        .output()
        .map_err(|e| format!("tmux: {e}"))?;
    if !out.status.success() {
        let err = String::from_utf8_lossy(&out.stderr);
        if err.contains("no server running") || err.contains("error connecting") {
            return Ok(vec![]);
        }
        return Err(err.trim().to_string());
    }
    Ok(String::from_utf8_lossy(&out.stdout)
        .lines()
        .filter_map(|line| {
            let mut cols = line.split('\t');
            let name = cols.next()?;
            if !name.starts_with(PREFIX) {
                return None;
            }
            let dead = cols.next().unwrap_or("").trim() == "1";
            let exit_code = if dead {
                cols.next().unwrap_or("").trim().parse::<i32>().ok()
            } else {
                None
            };
            Some(NamedPaneStatus {
                name: name.to_string(),
                dead,
                exit_code,
            })
        })
        .collect())
}

/// Kill a pool session (refusing anything outside our prefix). This ends the
/// session for real — used by the explicit "kill" action, not by tab close.
#[tauri::command(async)]
pub fn kill_session(name: String) -> Result<(), String> {
    if !name.starts_with(PREFIX) {
        return Err(format!("refusing to kill non-iudex session {name}"));
    }
    Command::new(tmux_bin())
        .args(["kill-session", "-t", &name])
        .status()
        .map_err(|e| format!("tmux kill-session: {e}"))?;
    Ok(())
}

/// Nudge a live agent's REPL by typing a line + Enter into its pane, exactly as
/// a human would in the console — the "Resume" remedy for a stalled (idle but
/// still-alive) agent after a transient API failure. Deliberately harness-blind:
/// it injects keystrokes rather than modeling the agent CLI, so the *same*
/// primitive resumes pi / claude / kimi / codex / opencode. `-l` sends the nudge
/// literally (never parsed as tmux key-names); a separate plain `Enter` submits
/// it (works for the common single-line REPL — modified-Enter harnesses are out
/// of scope, matching the CLI's own extended-keys caveat). Best-effort by design:
/// only offered on a live+idle pane, and recoverable like a fat-fingered console
/// line if the REPL wasn't actually at its prompt.
#[tauri::command(async)]
pub fn resume_agent(name: String, nudge: String) -> Result<(), String> {
    if !name.starts_with(PREFIX) {
        return Err(format!("refusing to send keys to non-iudex session {name}"));
    }
    // Type the nudge literally first; then submit with a separate Enter (a single
    // `-l` call would treat "Enter" as literal characters, not the key).
    if !nudge.trim().is_empty() {
        let st = Command::new(tmux_bin())
            .args(["send-keys", "-t", &name, "-l", &nudge])
            .status()
            .map_err(|e| format!("tmux send-keys: {e}"))?;
        if !st.success() {
            return Err("tmux send-keys failed (pane may be dead)".to_string());
        }
    }
    Command::new(tmux_bin())
        .args(["send-keys", "-t", &name, "Enter"])
        .status()
        .map_err(|e| format!("tmux send-keys Enter: {e}"))?;
    Ok(())
}

/// Stamp a superseded agent's kill deadline (unix millis, as a string) on its
/// session. The Auto-Retire engine sets this instead of killing immediately; the
/// mark lives in tmux, so it survives GUI restarts.
#[tauri::command(async)]
pub fn set_retire_at(name: String, epoch_ms: String) -> Result<(), String> {
    if !name.starts_with(PREFIX) {
        return Err(format!("refusing to mark non-iudex session {name}"));
    }
    Command::new(tmux_bin())
        .args(["set-option", "-t", &name, "@iudex_retire_at", &epoch_ms])
        .status()
        .map_err(|e| format!("tmux set-option: {e}"))?;
    Ok(())
}

/// Clear a session's retire mark. With `pardon`, also set `@iudex_retire_pardon`
/// so the engine never auto-marks it again (the Agents "Keep" action).
#[tauri::command(async)]
pub fn clear_retire(name: String, pardon: bool) -> Result<(), String> {
    if !name.starts_with(PREFIX) {
        return Err(format!("refusing to unmark non-iudex session {name}"));
    }
    Command::new(tmux_bin())
        .args(["set-option", "-u", "-t", &name, "@iudex_retire_at"])
        .status()
        .map_err(|e| format!("tmux set-option: {e}"))?;
    if pardon {
        Command::new(tmux_bin())
            .args(["set-option", "-t", &name, "@iudex_retire_pardon", "1"])
            .status()
            .map_err(|e| format!("tmux set-option: {e}"))?;
    }
    Ok(())
}

/// Tear down the entire pool — every `iudex-*` session (agents, idea, shells).
/// Called once on full app exit so nothing survives the GUI: per Decision #2, a
/// terminal is a dumb terminal (no detached background survival), and agents are
/// GUI-lifecycle-bound. A workspace switch never calls this — those sessions keep
/// running and reappear when you return. Best-effort: a missing tmux server just
/// means an empty pool, so failures are ignored. (Pool is machine-level, so this
/// also stops any other GUI instance's sessions — fine under a single instance.)
/// Live-session counts for the quit guard: (agents, shells). Agents and
/// idea-shaping agents are grouped as "agents"; ad-hoc shells counted apart.
/// The whole pool, machine-wide, since `kill_pool` tears down all of it.
pub fn pool_summary() -> (u32, u32) {
    let mut agents = 0u32;
    let mut shells = 0u32;
    for s in list_all().unwrap_or_default() {
        match s.kind.as_str() {
            "shell" => shells += 1,
            _ => agents += 1, // "agent" | "idea"
        }
    }
    (agents, shells)
}

pub fn kill_pool() {
    let out = match Command::new(tmux_bin())
        .args(["list-sessions", "-F", "#{session_name}"])
        .output()
    {
        Ok(o) if o.status.success() => o,
        _ => return, // no server / no sessions
    };
    for name in String::from_utf8_lossy(&out.stdout).lines() {
        if name.starts_with(PREFIX) {
            let _ = Command::new(tmux_bin())
                .args(["kill-session", "-t", name])
                .status();
        }
    }
}

/// Capture the last `lines` rows of a session's visible pane as plain text — the
/// data source for a read-only peek. Cheap enough to poll for a grid.
#[tauri::command(async)]
pub fn capture_pane(name: String, lines: Option<i32>) -> Result<String, String> {
    let n = lines.unwrap_or(40);
    let start = format!("-{n}");
    let out = Command::new(tmux_bin())
        .args(["capture-pane", "-p", "-t", &name, "-S", &start])
        .output()
        .map_err(|e| format!("tmux capture-pane: {e}"))?;
    if !out.status.success() {
        return Err(String::from_utf8_lossy(&out.stderr).trim().to_string());
    }
    Ok(String::from_utf8_lossy(&out.stdout).into_owned())
}

/// Attach to a session through a PTY and stream its output to the frontend as
/// `pty-{id}` events (base64 chunks). The frontend supplies the id so it can
/// subscribe before output flows. `readonly` uses tmux's `-r` so a peek can
/// never inject a keystroke. Returns once the attach is running.
#[tauri::command]
pub fn open_terminal(
    app: AppHandle,
    state: State<PtyState>,
    id: String,
    name: String,
    readonly: bool,
    cols: u16,
    rows: u16,
) -> Result<(), String> {
    let pair = native_pty_system()
        .openpty(PtySize {
            rows,
            cols,
            pixel_width: 0,
            pixel_height: 0,
        })
        .map_err(|e| format!("openpty: {e}"))?;

    // Ensure mouse-wheel scrolling works, covering sessions created before this
    // was set at spawn time (applies on the next attach, no recreation needed).
    enable_mouse(&name);

    let mut cmd = CommandBuilder::new(tmux_bin());
    if readonly {
        cmd.args(["attach-session", "-r", "-t", &name]);
    } else {
        cmd.args(["attach-session", "-t", &name]);
    }
    cmd.env("TERM", "xterm-256color");

    let child = pair
        .slave
        .spawn_command(cmd)
        .map_err(|e| format!("spawn tmux attach: {e}"))?;
    drop(pair.slave);

    let reader = pair
        .master
        .try_clone_reader()
        .map_err(|e| format!("clone reader: {e}"))?;
    let writer = pair
        .master
        .take_writer()
        .map_err(|e| format!("take writer: {e}"))?;

    // Pump PTY output to the frontend until EOF, then signal exit.
    let out_event = format!("pty-{id}");
    let exit_event = format!("pty-{id}-exit");
    let app2 = app.clone();
    std::thread::spawn(move || {
        let mut reader = reader;
        let mut buf = [0u8; 8192];
        let engine = base64::engine::general_purpose::STANDARD;
        loop {
            match reader.read(&mut buf) {
                Ok(0) | Err(_) => break,
                Ok(n) => {
                    let _ = app2.emit(&out_event, engine.encode(&buf[..n]));
                }
            }
        }
        let _ = app2.emit(&exit_event, ());
    });

    state.0.lock().unwrap().insert(
        id,
        Pty {
            master: pair.master,
            writer,
            child,
        },
    );
    Ok(())
}

/// Feed keystrokes from xterm into a terminal's PTY.
#[tauri::command]
pub fn write_terminal(state: State<PtyState>, id: String, data: String) -> Result<(), String> {
    let mut map = state.0.lock().unwrap();
    let pty = map.get_mut(&id).ok_or("no such terminal")?;
    pty.writer
        .write_all(data.as_bytes())
        .map_err(|e| e.to_string())?;
    pty.writer.flush().map_err(|e| e.to_string())?;
    Ok(())
}

/// Resize a terminal's PTY (and thus the attached tmux client).
#[tauri::command]
pub fn resize_terminal(
    state: State<PtyState>,
    id: String,
    cols: u16,
    rows: u16,
) -> Result<(), String> {
    let map = state.0.lock().unwrap();
    let pty = map.get(&id).ok_or("no such terminal")?;
    pty.master
        .resize(PtySize {
            rows,
            cols,
            pixel_width: 0,
            pixel_height: 0,
        })
        .map_err(|e| e.to_string())?;
    Ok(())
}

/// Close a terminal: kill the attach client, which detaches without ending the
/// tmux session. The session keeps running for the next attach.
#[tauri::command]
pub fn close_terminal(state: State<PtyState>, id: String) -> Result<(), String> {
    if let Some(mut pty) = state.0.lock().unwrap().remove(&id) {
        let _ = pty.child.kill();
    }
    Ok(())
}

/// Allocate a unique terminal id (used when the frontend wants the backend to
/// pick one; the frontend usually supplies its own).
#[tauri::command]
pub fn next_terminal_id() -> String {
    format!("pty{}", SEQ.fetch_add(1, Ordering::Relaxed))
}
