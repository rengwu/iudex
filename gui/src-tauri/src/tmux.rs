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
use std::sync::Mutex;
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

/// True when a usable `tmux` is on PATH. The Terminal/Agents views degrade to a
/// hint when it isn't.
#[tauri::command]
pub fn tmux_available() -> bool {
    Command::new("tmux")
        .arg("-V")
        .output()
        .map(|o| o.status.success())
        .unwrap_or(false)
}

/// List the pool: every `iudex-…` tmux session. A missing tmux server just means
/// an empty pool, not an error.
#[tauri::command]
pub fn list_sessions() -> Result<Vec<Session>, String> {
    // One call returns every session's name plus its agent metadata (empty for
    // shells / non-pool sessions). Tab-delimited; tmux names never contain tabs.
    let out = Command::new("tmux")
        .args([
            "list-sessions",
            "-F",
            "#{session_name}\t#{@iudex_ticket}\t#{@iudex_role}\t#{@iudex_started}",
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

/// Build a Session from a `list_sessions` line. Agents (opaque `iudex-agent-…`
/// names) take their ticket/role/started from the user-option columns; shells
/// (`iudex-shell-N`) are name-derived. Anything else is skipped.
fn parse_line(line: &str) -> Option<Session> {
    let mut cols = line.split('\t');
    let name = cols.next()?;
    let ticket = nonempty(cols.next().unwrap_or(""));
    let role = nonempty(cols.next().unwrap_or(""));
    let started = nonempty(cols.next().unwrap_or(""));

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
            title,
        })
    } else if let Some(tail) = name.strip_prefix(&format!("{PREFIX}shell-")) {
        Some(Session {
            name: name.to_string(),
            kind: "shell".to_string(),
            ticket: None,
            role: None,
            started: None,
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
    let _ = Command::new("tmux")
        .args(["set-option", "-t", name, "mouse", "on"])
        .status();
}

/// Create a fresh detached shell session with the lowest free index. An optional
/// `cwd` starts the shell in that directory (used by Worktrees' "Open shell" to
/// drop into a worktree); omitted, it starts wherever tmux defaults.
#[tauri::command]
pub fn create_shell(cwd: Option<String>) -> Result<Session, String> {
    let existing = list_sessions()?;
    let mut n = 1;
    while existing.iter().any(|s| s.name == format!("{PREFIX}shell-{n}")) {
        n += 1;
    }
    let name = format!("{PREFIX}shell-{n}");
    let mut args = vec!["new-session", "-d", "-s", &name];
    if let Some(dir) = cwd.as_deref() {
        args.push("-c");
        args.push(dir);
    }
    let st = Command::new("tmux")
        .args(&args)
        .status()
        .map_err(|e| format!("tmux new-session: {e}"))?;
    if !st.success() {
        return Err("tmux new-session failed".to_string());
    }
    enable_mouse(&name);
    Ok(Session {
        name,
        kind: "shell".to_string(),
        ticket: None,
        role: None,
        started: None,
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
#[tauri::command]
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
    let st = Command::new("tmux")
        .args(["new-session", "-d", "-s", &name, &cmd])
        .status()
        .map_err(|e| format!("tmux new-session: {e}"))?;
    if !st.success() {
        return Err("tmux new-session failed".to_string());
    }
    // Keep the pane after the agent process exits, so its exit status survives
    // for the status heuristic (alive→working/idle, exited 0→awaiting-finish,
    // exited non-zero→crashed). Without this the session would just vanish.
    let _ = Command::new("tmux")
        .args(["set-option", "-w", "-t", &name, "remain-on-exit", "on"])
        .status();
    enable_mouse(&name);
    // Stamp identity/metadata as user-options (read back by list_sessions).
    for (opt, val) in [
        ("@iudex_ticket", ticket.as_str()),
        ("@iudex_role", role.as_str()),
        ("@iudex_started", started.as_str()),
    ] {
        let _ = Command::new("tmux")
            .args(["set-option", "-t", &name, opt, val])
            .status();
    }

    Ok(Session {
        name,
        kind: "agent".to_string(),
        ticket: Some(ticket),
        role: nonempty(&role),
        started: Some(started),
        title: String::new(),
    })
}

/// Wrap a string as a single-quoted POSIX shell token (safe for spaces,
/// newlines, quotes). `'` becomes `'\''`.
fn sh_quote(s: &str) -> String {
    format!("'{}'", s.replace('\'', "'\\''"))
}

/// The workspace's configured agent binary (`agent_command` in
/// `.iudex/config.yml`), used to build the idea-agent spawn command. iudex has
/// no read API for it, so we scan the one well-known line; defaults to `pi`.
fn agent_command(root: &str) -> String {
    let path = Path::new(root).join(".iudex").join("config.yml");
    if let Ok(text) = std::fs::read_to_string(path) {
        for line in text.lines() {
            let line = line.trim();
            if line.starts_with('#') {
                continue;
            }
            if let Some(val) = line.strip_prefix("agent_command:") {
                let v = val.trim().trim_matches('"').trim_matches('\'').trim();
                if !v.is_empty() {
                    return v.to_string();
                }
            }
        }
    }
    "pi".to_string()
}

/// Launch an idea-shaping agent into the pool: run the configured agent at the
/// workspace root, preloaded with a front-of-funnel skill (grill-me, …) and an
/// optional seed. The agent loads the skill via AGENTS.md and drives the chain
/// itself (→ to-prd → to-issues → `iudex queue`), so any tickets it creates show
/// up through the events.jsonl doorbell. Ticket-less: `@iudex_role` holds the
/// skill name. The frontend opens this session in the Terminal to converse.
#[tauri::command]
pub fn spawn_idea(root: String, skill: String, seed: String) -> Result<Session, String> {
    let mut prompt = format!(
        "Use the \"{skill}\" skill (.iudex/skills/{skill}/SKILL.md) to shape work \
         into iudex tickets. Follow the skill and its chained skills through to \
         registering tickets with `iudex queue`."
    );
    if !seed.trim().is_empty() {
        prompt.push_str(&format!("\n\nIdea / focus:\n{}", seed.trim()));
    }

    let agent = agent_command(&root);
    // Run the agent at the workspace root (skills live there, not in worktrees).
    let cmd = format!("cd {} && {} {}", sh_quote(&root), agent, sh_quote(&prompt));

    let started = now_millis();
    let name = format!(
        "{PREFIX}idea-{started}-{}",
        SEQ.fetch_add(1, Ordering::Relaxed)
    );
    let st = Command::new("tmux")
        .args(["new-session", "-d", "-s", &name, &cmd])
        .status()
        .map_err(|e| format!("tmux new-session: {e}"))?;
    if !st.success() {
        return Err("tmux new-session failed".to_string());
    }
    let _ = Command::new("tmux")
        .args(["set-option", "-w", "-t", &name, "remain-on-exit", "on"])
        .status();
    enable_mouse(&name);
    for (opt, val) in [("@iudex_role", skill.as_str()), ("@iudex_started", started.as_str())] {
        let _ = Command::new("tmux")
            .args(["set-option", "-t", &name, opt, val])
            .status();
    }

    Ok(Session {
        name,
        kind: "idea".to_string(),
        ticket: None,
        role: nonempty(&skill),
        started: Some(started),
        title: format!("idea: {skill}"),
    })
}

/// The conflict-resolution agent's brief. It **triages** — resolving only what it
/// is confident about and **flagging, never guessing**, anything that needs human
/// judgment — then reports structurally. It commits the merge only if it resolved
/// everything; any flagged file leaves the merge in progress for the human.
const RESOLVE_PROMPT: &str = "You are resolving an in-progress git merge in THIS \
worktree: `main` was merged into this ticket's branch and left conflicts. The two \
branches are siblings cut from a shared base, so conflicts range from trivial \
(duplicated or adjacent lines, import ordering) to genuinely semantic (both sides \
changed the same logic in different ways).\n\n\
For EACH conflicted file:\n\
- If you can resolve it WITH CONFIDENCE, preserving BOTH sides' intent, do so, \
remove all conflict markers, and `git add` the file.\n\
- If resolving it would require GUESSING about intended behavior you cannot \
determine from the code, do NOT guess and do NOT `git add` it — leave its conflict \
markers exactly as they are for a human to decide.\n\n\
Then write a report to `.task/resolution.json` (overwrite it) with exactly this \
shape:\n\
{\"resolved\":[{\"file\":\"path\",\"note\":\"what you did\"}],\"flagged\":[{\"file\
\":\"path\",\"reason\":\"why it needs human judgment\"}]}\n\n\
Finally:\n\
- If you resolved and staged EVERY conflicted file (nothing flagged), complete the \
merge with `git commit --no-edit`.\n\
- If you flagged ANY file, do NOT commit — leave the merge in progress.\n\n\
Touch only the conflicted files; change nothing else.";

/// Launch a conflict-resolution agent into the worktree. Assumes a merge is
/// already in progress there (the GUI runs `begin_resolution` first). It is a
/// normal agent-kind session (ticket set, role `resolve`), so it appears in the
/// Agents grid and can be watched/attached like any other; the human directs or
/// takes over via its terminal. iudex's lifecycle is untouched — conflict
/// resolution is GUI territory, so the prompt is built here, not by the CLI.
#[tauri::command]
pub fn spawn_resolver(root: String, ticket: String, worktree: String) -> Result<Session, String> {
    let agent = agent_command(&root);
    let cmd = format!("cd {} && {} {}", sh_quote(&worktree), agent, sh_quote(RESOLVE_PROMPT));

    let started = now_millis();
    let name = format!(
        "{PREFIX}agent-{started}-{}",
        SEQ.fetch_add(1, Ordering::Relaxed)
    );
    let st = Command::new("tmux")
        .args(["new-session", "-d", "-s", &name, &cmd])
        .status()
        .map_err(|e| format!("tmux new-session: {e}"))?;
    if !st.success() {
        return Err("tmux new-session failed".to_string());
    }
    let _ = Command::new("tmux")
        .args(["set-option", "-w", "-t", &name, "remain-on-exit", "on"])
        .status();
    enable_mouse(&name);
    for (opt, val) in [
        ("@iudex_ticket", ticket.as_str()),
        ("@iudex_role", "resolve"),
        ("@iudex_started", started.as_str()),
    ] {
        let _ = Command::new("tmux")
            .args(["set-option", "-t", &name, opt, val])
            .status();
    }

    Ok(Session {
        name,
        kind: "agent".to_string(),
        ticket: Some(ticket),
        role: Some("resolve".to_string()),
        started: Some(started),
        title: String::new(),
    })
}

/// Bulk-dismiss finished agents: kill every agent session whose pane has exited
/// (dead), leaving live ones untouched. Backs the Agents view "clear finished"
/// action. Returns how many were removed.
#[tauri::command]
pub fn clear_finished() -> Result<u32, String> {
    let out = Command::new("tmux")
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
            let _ = Command::new("tmux")
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

#[tauri::command]
pub fn session_status(name: String) -> Result<PaneStatus, String> {
    let out = Command::new("tmux")
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

/// Kill a pool session (refusing anything outside our prefix). This ends the
/// session for real — used by the explicit "kill" action, not by tab close.
#[tauri::command]
pub fn kill_session(name: String) -> Result<(), String> {
    if !name.starts_with(PREFIX) {
        return Err(format!("refusing to kill non-iudex session {name}"));
    }
    Command::new("tmux")
        .args(["kill-session", "-t", &name])
        .status()
        .map_err(|e| format!("tmux kill-session: {e}"))?;
    Ok(())
}

/// Capture the last `lines` rows of a session's visible pane as plain text — the
/// data source for a read-only peek. Cheap enough to poll for a grid.
#[tauri::command]
pub fn capture_pane(name: String, lines: Option<i32>) -> Result<String, String> {
    let n = lines.unwrap_or(40);
    let start = format!("-{n}");
    let out = Command::new("tmux")
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

    let mut cmd = CommandBuilder::new("tmux");
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
