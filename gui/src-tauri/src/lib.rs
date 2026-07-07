// iudex GUI backend — the read-path spine.
//
// The GUI holds no authoritative state. It discovers a workspace, reads derived
// truth by shelling out to `iudex status --json`, and watches the workspace's
// events.jsonl as a doorbell: on any change it tells the frontend to re-read.
// All mutations (later) likewise go through the iudex CLI, never reimplemented
// here — the GUI drives iudex the way a git client drives git.

mod tmux;

use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::{Mutex, OnceLock};

use notify::{EventKind, RecommendedWatcher, RecursiveMode, Watcher};
use tauri::{AppHandle, Emitter, Manager, State};

/// Holds the live file watcher so it is not dropped (dropping stops watching).
#[derive(Default)]
struct WatcherState(Mutex<Option<RecommendedWatcher>>);

/// User-chosen iudex binary path, persisted in ~/.iudex/config.yml and loaded
/// once at startup. Kept in a process-global so the plain `iudex_bin()` (called
/// from many sites + tmux.rs) needs no AppHandle. `None`/empty means "no
/// override" — fall through to $IUDEX_BIN, then PATH.
fn iudex_bin_override() -> &'static Mutex<Option<String>> {
    static OVERRIDE: OnceLock<Mutex<Option<String>>> = OnceLock::new();
    OVERRIDE.get_or_init(|| Mutex::new(None))
}

/// The iudex binary to invoke: the saved override if set, else `fallback_bin`.
pub(crate) fn iudex_bin() -> String {
    if let Some(p) = iudex_bin_override().lock().unwrap().clone() {
        if !p.is_empty() {
            return p;
        }
    }
    fallback_bin()
}

/// Resolution below the saved override: $IUDEX_BIN, then the CLI bundled with
/// the app, then its managed copy, then `iudex` from PATH. The bundled tiers
/// sit *above* PATH so a packaged GUI always runs the CLI it was released and
/// tested with; a user who wants a different binary states so explicitly (saved
/// path or env), which wins.
fn fallback_bin() -> String {
    if let Ok(v) = std::env::var("IUDEX_BIN") {
        return v;
    }
    if let Some(b) = bundled_cli() {
        return b.to_string();
    }
    if let Some(m) = managed_cli().filter(|p| p.is_file()) {
        return m.to_string_lossy().into_owned();
    }
    "iudex".to_string()
}

/// The CLI bundled next to the GUI executable (Tauri's externalBin places it
/// there). Named `iudex-cli` because the GUI executable in the same directory
/// is itself named `iudex`. None when running unbundled (plain cargo runs).
fn bundled_cli() -> Option<&'static str> {
    static BUNDLED: OnceLock<Option<String>> = OnceLock::new();
    BUNDLED
        .get_or_init(|| {
            let exe = std::env::current_exe().ok()?;
            let p = exe.parent()?.join("iudex-cli");
            p.is_file().then(|| p.to_string_lossy().into_owned())
        })
        .as_deref()
}

/// The managed copy of the bundled CLI at ~/.iudex/bin/iudex, refreshed at
/// startup by `sync_managed_cli`. It exists so processes *outside* the GUI can
/// run `iudex` by name: tmux sessions get its dir prepended to PATH (agents
/// call `iudex finish`/`iudex qa` themselves) and the Settings "Install CLI"
/// symlink points at it. A copy rather than a symlink into the .app because
/// Gatekeeper translocation randomizes an unsigned bundle's path per launch and
/// AppImages mount read-only.
fn managed_cli() -> Option<PathBuf> {
    let home = std::env::var_os("HOME")?;
    Some(PathBuf::from(home).join(".iudex").join("bin").join("iudex"))
}

/// Refresh the managed copy from the bundled CLI when it is missing or reports
/// a different version. Copy-to-temp + rename, so an agent mid-run never sees a
/// truncated binary. Best-effort: the GUI itself uses the bundled path
/// directly, so a failure here only degrades the outside-the-GUI conveniences.
fn sync_managed_cli() {
    let Some(bundled) = bundled_cli() else { return };
    let Some(dest) = managed_cli() else { return };
    if dest.is_file() {
        let same = match (iudex_version(bundled), iudex_version(&dest.to_string_lossy())) {
            (Ok(a), Ok(b)) => a == b,
            _ => false,
        };
        if same {
            return;
        }
    }
    let res = (|| -> std::io::Result<()> {
        let dir = dest.parent().expect("managed cli path has a parent");
        std::fs::create_dir_all(dir)?;
        let tmp = dir.join(".iudex.new");
        std::fs::copy(bundled, &tmp)?;
        std::fs::rename(&tmp, &dest)
    })();
    if let Err(e) = res {
        eprintln!("iudex: cannot sync bundled CLI to {}: {e}", dest.display());
    }
}

/// The PATH prepend for tmux sessions — the managed CLI's directory — but only
/// while the GUI itself resolves to the bundled/managed binary. Agents inside
/// sessions run bare `iudex`, so a zero-setup install needs the injection; a
/// user who overrode the binary (saved path / $IUDEX_BIN) has their own PATH
/// story and must not be shadowed by the bundle.
pub(crate) fn session_path_prepend() -> Option<String> {
    let effective = iudex_bin();
    let managed = managed_cli()?;
    let active = bundled_cli() == Some(effective.as_str())
        || managed.to_string_lossy() == effective.as_str();
    (active && managed.is_file())
        .then(|| managed.parent().unwrap().to_string_lossy().into_owned())
}

/// ~/.iudex/config.yml — the single per-user config file. It holds the
/// machine-level agent-command pool (read by the CLI, and by the GUI via
/// `iudex config --json`) and the GUI's iudex binary path (read directly by the
/// GUI, line-based — it can't shell the CLI to discover the CLI). Distinct from a
/// project's per-workspace `.iudex/`.
fn global_config_path(app: &AppHandle) -> Result<PathBuf, String> {
    let home = app
        .path()
        .home_dir()
        .map_err(|e| format!("cannot resolve home dir: {e}"))?;
    Ok(home.join(".iudex").join("config.yml"))
}

/// Read a top-level scalar `key: value` from config.yml text, line-based so the
/// GUI needs no YAML dep for the one key it reads itself (iudex_bin). Strips
/// surrounding double-quotes; None if the key is absent.
fn yaml_scalar(text: &str, key: &str) -> Option<String> {
    let prefix = format!("{key}:");
    for line in text.lines() {
        // Top-level only (the prefix must start the line — no leading whitespace).
        if let Some(rest) = line.strip_prefix(&prefix) {
            let raw = rest.trim();
            let val = raw
                .strip_prefix('"')
                .and_then(|r| r.strip_suffix('"'))
                .map(|inner| inner.replace("\\\"", "\"").replace("\\\\", "\\"))
                .unwrap_or_else(|| raw.to_string());
            return Some(val);
        }
    }
    None
}

/// Set (Some) or remove (None) a top-level scalar key in config.yml text,
/// preserving every other line. Values are double-quoted (escaping `"`/`\`).
fn yaml_upsert_scalar(text: &str, key: &str, value: Option<&str>) -> String {
    let prefix = format!("{key}:");
    let render = |v: &str| format!("{key}: \"{}\"", v.replace('\\', "\\\\").replace('"', "\\\""));
    let mut lines: Vec<String> = text.lines().map(|l| l.to_string()).collect();
    let pos = lines.iter().position(|l| l.starts_with(&prefix));
    match (value, pos) {
        (Some(v), Some(i)) => lines[i] = render(v),
        (Some(v), None) => lines.push(render(v)),
        (None, Some(i)) => {
            lines.remove(i);
        }
        (None, None) => {}
    }
    let mut out = lines.join("\n");
    if !out.is_empty() {
        out.push('\n');
    }
    out
}

/// The saved iudex binary path from ~/.iudex/config.yml ("" if unset/unreadable).
fn read_iudex_bin(app: &AppHandle) -> String {
    global_config_path(app)
        .ok()
        .and_then(|p| std::fs::read_to_string(p).ok())
        .and_then(|t| yaml_scalar(&t, "iudex_bin"))
        .unwrap_or_default()
}

/// Persist (or clear, with an empty path) the iudex binary path in config.yml,
/// leaving the rest of the file untouched. Creates the file/dir if missing.
fn write_iudex_bin(app: &AppHandle, path: &str) -> Result<(), String> {
    let cfg = global_config_path(app)?;
    let text = std::fs::read_to_string(&cfg).unwrap_or_default();
    let out = yaml_upsert_scalar(&text, "iudex_bin", (!path.is_empty()).then_some(path));
    if let Some(dir) = cfg.parent() {
        std::fs::create_dir_all(dir).map_err(|e| format!("create {}: {e}", dir.display()))?;
    }
    std::fs::write(&cfg, out).map_err(|e| format!("write {}: {e}", cfg.display()))
}

/// GUI behavior pref: tear down the whole tmux pool on full app exit. Stored in
/// ~/.iudex/config.yml as a GUI-owned key the CLI ignores. Absent or unparseable
/// → true (the Decision #2 "no detached survival" default); set "false" to keep
/// agents/shells running detached across a quit.
fn read_kill_pool_on_exit(app: &AppHandle) -> bool {
    global_config_path(app)
        .ok()
        .and_then(|p| std::fs::read_to_string(p).ok())
        .and_then(|t| yaml_scalar(&t, "gui_kill_pool_on_exit"))
        .map(|v| v != "false")
        .unwrap_or(true)
}

#[tauri::command]
fn get_kill_pool_on_exit(app: AppHandle) -> bool {
    read_kill_pool_on_exit(&app)
}

#[tauri::command]
fn set_kill_pool_on_exit(app: AppHandle, value: bool) -> Result<(), String> {
    let cfg = global_config_path(&app)?;
    let text = std::fs::read_to_string(&cfg).unwrap_or_default();
    let out = yaml_upsert_scalar(
        &text,
        "gui_kill_pool_on_exit",
        Some(if value { "true" } else { "false" }),
    );
    if let Some(dir) = cfg.parent() {
        std::fs::create_dir_all(dir).map_err(|e| format!("create {}: {e}", dir.display()))?;
    }
    std::fs::write(&cfg, out).map_err(|e| format!("write {}: {e}", cfg.display()))
}

/// GUI behavior pref: how long a superseded agent's session lingers before
/// Auto-Retire kills it (minutes). Stored in ~/.iudex/config.yml as a GUI-owned
/// key the CLI ignores. Absent or unparseable → 10 (the default grace); 0 = kill
/// immediately (the old instant-retire behavior).
fn read_retire_grace_minutes(app: &AppHandle) -> u32 {
    global_config_path(app)
        .ok()
        .and_then(|p| std::fs::read_to_string(p).ok())
        .and_then(|t| yaml_scalar(&t, "gui_retire_grace_minutes"))
        .and_then(|v| v.parse::<u32>().ok())
        .unwrap_or(10)
}

#[tauri::command]
fn get_retire_grace_minutes(app: AppHandle) -> u32 {
    read_retire_grace_minutes(&app)
}

#[tauri::command]
fn set_retire_grace_minutes(app: AppHandle, value: u32) -> Result<(), String> {
    let cfg = global_config_path(&app)?;
    let text = std::fs::read_to_string(&cfg).unwrap_or_default();
    let out = yaml_upsert_scalar(&text, "gui_retire_grace_minutes", Some(&value.to_string()));
    if let Some(dir) = cfg.parent() {
        std::fs::create_dir_all(dir).map_err(|e| format!("create {}: {e}", dir.display()))?;
    }
    std::fs::write(&cfg, out).map_err(|e| format!("write {}: {e}", cfg.display()))
}

/// Sequential mode: the workspace policy "at most one ticket in flight"
/// (active | pending-qa | pending-human-qa). Stored per workspace in
/// .iudex/config.yml as a GUI-owned key the CLI ignores (its YAML parsing
/// skips unknown fields), matching the gui_* precedent in the global config.
/// The policy persists; the automation-engine toggles deliberately don't.
/// Absent → true (sequential is the safer out-of-the-box default).
#[tauri::command]
fn get_sequential(root: String) -> bool {
    // Default (key absent — a workspace that's never touched the toggle) is
    // sequential-on: one ticket in flight is the safer out-of-the-box policy;
    // parallel is the opt-in.
    std::fs::read_to_string(config_path(&root))
        .ok()
        .and_then(|t| yaml_scalar(&t, "gui_sequential"))
        .map(|v| v == "true")
        .unwrap_or(true)
}

#[tauri::command]
fn set_sequential(root: String, value: bool) -> Result<(), String> {
    let path = config_path(&root);
    let text =
        std::fs::read_to_string(&path).map_err(|e| format!("read {}: {e}", path.display()))?;
    let out = yaml_upsert_scalar(
        &text,
        "gui_sequential",
        Some(if value { "true" } else { "false" }),
    );
    std::fs::write(&path, out).map_err(|e| format!("write {}: {e}", path.display()))
}

/// One line of events.jsonl, verbatim, for the Dashboard's activity feed.
/// Display-only: rendering the log is not deriving state (no replay logic
/// here — the state machine stays single-sourced in the CLI).
#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct EventRow {
    ticket: String,
    from: String,
    to: String,
    trigger: String,
    ts: String,
}

/// The newest `limit` events, newest first. Malformed lines are skipped, same
/// stance as the CLI's ReadAll. A missing file is an empty feed, not an error
/// (fresh workspace).
#[tauri::command(async)]
fn recent_events(root: String, limit: usize) -> Vec<EventRow> {
    let path = Path::new(&root).join(".iudex").join("events.jsonl");
    let text = std::fs::read_to_string(&path).unwrap_or_default();
    let field = |v: &serde_json::Value, k: &str| {
        v.get(k)
            .and_then(|x| x.as_str())
            .unwrap_or_default()
            .to_string()
    };
    let mut rows: Vec<EventRow> = text
        .lines()
        .filter_map(|l| serde_json::from_str::<serde_json::Value>(l).ok())
        .map(|v| EventRow {
            ticket: field(&v, "ticket"),
            from: field(&v, "from"),
            to: field(&v, "to"),
            trigger: field(&v, "trigger"),
            ts: field(&v, "ts"),
        })
        .collect();
    rows.reverse();
    rows.truncate(limit);
    rows
}

/// Load the persisted iudex binary path into the global override. Called once at
/// startup, before any command runs.
fn load_iudex_override(app: &AppHandle) {
    let saved = read_iudex_bin(app);
    if !saved.is_empty() {
        *iudex_bin_override().lock().unwrap() = Some(saved);
    }
}

/// Probe a candidate binary for its version line. Shared by the startup check and
/// save-validation so both judge "is this a working iudex" identically.
///
/// Two failure modes are distinct: a NotFound spawn error means the binary is
/// missing from PATH; a non-zero exit means it's present but broken (or too old
/// to know `--version`, which cobra answers with an unknown-flag error). Both
/// block the GUI, so both return Err — but with messages that point the user at
/// the right fix.
fn iudex_version(bin: &str) -> Result<String, String> {
    match Command::new(bin).arg("--version").output() {
        Ok(out) if out.status.success() => {
            let v = String::from_utf8_lossy(&out.stdout).trim().to_string();
            Ok(if v.is_empty() { bin.to_string() } else { v })
        }
        Ok(out) => {
            let stderr = String::from_utf8_lossy(&out.stderr);
            let detail = stderr.trim();
            Err(if detail.is_empty() {
                format!("'{bin}' failed to report its version ({})", out.status)
            } else {
                format!("'{bin}' failed to report its version: {detail}")
            })
        }
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
            Err(format!("'{bin}' was not found on your PATH"))
        }
        Err(e) => Err(format!("could not run '{bin}': {e}")),
    }
}

/// Check that the iudex CLI is reachable, returning its version line. The GUI
/// drives iudex the way a git client drives git, so without it nothing works —
/// checked at startup to fail with a clear message instead of opaque errors from
/// every command.
#[tauri::command(async)]
fn check_iudex() -> Result<String, String> {
    let bin = iudex_bin();
    let version = iudex_version(&bin)?;
    // The GUI reads config and resolves agent commands through the CLI, so it
    // requires an iudex new enough to expose those commands. Probe them up front
    // and fail with a clear "update iudex" message rather than letting older
    // binaries surface confusing per-command errors later.
    require_command(&bin, "config")?;
    require_command(&bin, "agent-command")?;
    Ok(version)
}

/// Verify `iudex <name>` exists by probing its help: cobra prints help and exits
/// 0 for a known command, and errors for an unknown one — no workspace needed.
fn require_command(bin: &str, name: &str) -> Result<(), String> {
    match Command::new(bin).args([name, "--help"]).output() {
        Ok(out) if out.status.success() => Ok(()),
        _ => Err(format!(
            "this iudex is too old — it has no `{name}` command. \
             Update iudex (the GUI needs `iudex config --json` and `iudex agent-command`)."
        )),
    }
}

/// What the iudex-CLI settings tab needs to render: the saved override (or ""),
/// the $IUDEX_BIN env value (or null), and the effective resolution string — so
/// the active source is never a mystery.
#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct IudexSettings {
    saved_path: String,
    env_bin: Option<String>,
    /// True when resolution falls through to the CLI bundled with the app
    /// (no saved path, no $IUDEX_BIN, a bundled/managed binary present).
    bundled: bool,
    resolved: Result<String, String>,
}

#[tauri::command(async)]
fn get_iudex_settings(app: AppHandle) -> IudexSettings {
    let saved_path = read_iudex_bin(&app);
    let env_bin = std::env::var("IUDEX_BIN").ok();
    let bundled = saved_path.is_empty()
        && env_bin.is_none()
        && (bundled_cli().is_some() || managed_cli().is_some_and(|p| p.is_file()));
    IudexSettings {
        saved_path,
        env_bin,
        bundled,
        resolved: check_iudex(),
    }
}

/// What the Settings CLI tab's "bundled CLI" section renders. `bundled_version`
/// None means the app is running unbundled — the section hides itself.
#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct CliInstallStatus {
    bundled_version: Option<String>,
    installed_path: Option<String>,
    installed_version: Option<String>,
    bin_dir_on_path: bool,
}

/// ~/.local/bin/iudex — where "Install CLI" links the binary for the user's own
/// terminal (the XDG-conventional per-user bin dir; no sudo needed).
fn local_bin_iudex() -> Option<PathBuf> {
    let home = std::env::var_os("HOME")?;
    Some(PathBuf::from(home).join(".local").join("bin").join("iudex"))
}

/// The user's PATH as their login shell sees it. The GUI's own env is often
/// narrower (Finder launches don't source shell rc files), which would make
/// the "is ~/.local/bin on your PATH" hint cry wolf.
pub(crate) fn login_shell_path() -> String {
    if let Ok(shell) = std::env::var("SHELL") {
        if let Ok(out) = Command::new(&shell)
            .args(["-lc", "printf %s \"$PATH\""])
            .output()
        {
            if out.status.success() {
                let p = String::from_utf8_lossy(&out.stdout).trim().to_string();
                if !p.is_empty() {
                    return p;
                }
            }
        }
    }
    std::env::var("PATH").unwrap_or_default()
}

#[tauri::command]
fn cli_install_status() -> CliInstallStatus {
    let bundled_version = bundled_cli().and_then(|b| iudex_version(b).ok());
    let installed = local_bin_iudex().filter(|p| p.exists());
    let installed_version = installed
        .as_ref()
        .and_then(|p| iudex_version(&p.to_string_lossy()).ok());
    let bin_dir_on_path = local_bin_iudex()
        .and_then(|p| p.parent().map(PathBuf::from))
        .is_some_and(|dir| login_shell_path().split(':').any(|d| Path::new(d) == dir));
    CliInstallStatus {
        bundled_version,
        installed_path: installed.map(|p| p.display().to_string()),
        installed_version,
        bin_dir_on_path,
    }
}

/// Install the CLI for the user's own terminal: symlink ~/.local/bin/iudex →
/// ~/.iudex/bin/iudex. The link targets the managed copy (stable across app
/// updates and moves), never the .app bundle. Replaces an existing symlink;
/// refuses to clobber a real file (that's a user-installed iudex — their call).
#[tauri::command]
fn install_cli() -> Result<String, String> {
    sync_managed_cli();
    let managed = managed_cli().ok_or("cannot resolve your home directory")?;
    if !managed.is_file() {
        return Err("no bundled CLI to install (is the app running unbundled?)".to_string());
    }
    let dest = local_bin_iudex().ok_or("cannot resolve your home directory")?;
    let dir = dest.parent().expect("install path has a parent");
    std::fs::create_dir_all(dir).map_err(|e| format!("create {}: {e}", dir.display()))?;
    match std::fs::symlink_metadata(&dest) {
        Ok(md) if md.file_type().is_symlink() => {
            std::fs::remove_file(&dest).map_err(|e| format!("replace {}: {e}", dest.display()))?;
        }
        Ok(_) => {
            return Err(format!(
                "{} already exists and is not a symlink — remove it first if you want the bundled CLI there",
                dest.display()
            ));
        }
        Err(_) => {}
    }
    std::os::unix::fs::symlink(&managed, &dest)
        .map_err(|e| format!("symlink {}: {e}", dest.display()))?;
    Ok(dest.display().to_string())
}

/// Persist the user's iudex binary path. A non-empty path is validated first and
/// the save is refused (old value kept) if it doesn't resolve, so a typo can't
/// strand the app. An empty path clears the override (fall back to env/PATH).
/// Returns the resolved version line on success.
#[tauri::command]
fn set_iudex_bin(app: AppHandle, path: String) -> Result<String, String> {
    let path = path.trim().to_string();
    let resolved = if path.is_empty() {
        // Cleared: validate whatever the fallback chain (env → bundled →
        // managed → PATH) now resolves to, for feedback.
        iudex_version(&fallback_bin())
    } else {
        iudex_version(&path)
    }?;
    write_iudex_bin(&app, &path)?;
    *iudex_bin_override().lock().unwrap() = if path.is_empty() { None } else { Some(path) };
    Ok(resolved)
}

/// Run an arbitrary `iudex` subcommand in the workspace and return its stdout.
/// This is the GUI's write path: every state mutation (activate, finish, qa,
/// human-qa, retry, remove) shells out to the CLI so the state machine stays
/// single-sourced there. The events.jsonl doorbell then refreshes the read
/// path on its own — callers don't re-read explicitly.
#[tauri::command(async)]
fn run_iudex(root: String, args: Vec<String>) -> Result<String, String> {
    let out = Command::new(iudex_bin())
        .args(&args)
        .current_dir(&root)
        .output()
        .map_err(|e| format!("failed to run {}: {e}", iudex_bin()))?;
    if !out.status.success() {
        return Err(String::from_utf8_lossy(&out.stderr).trim().to_string());
    }
    Ok(String::from_utf8_lossy(&out.stdout).into_owned())
}

/// Walk up from `start` looking for `.iudex/config.yml`, returning the workspace
/// root — the same discovery rule the CLI uses (workspace.Find), so it resolves
/// correctly from inside a ticket worktree too. The home directory is skipped:
/// ~/.iudex/config.yml is the reserved machine-level config, not a workspace, so
/// an empty folder under $HOME must not resolve home as its workspace root.
#[tauri::command]
fn discover_workspace(app: AppHandle, start: String) -> Result<String, String> {
    let home = app
        .path()
        .home_dir()
        .ok()
        .and_then(|h| std::fs::canonicalize(h).ok());
    let mut dir = std::fs::canonicalize(&start)
        .map_err(|e| format!("cannot resolve {start}: {e}"))?;
    loop {
        if Some(&dir) != home.as_ref() && dir.join(".iudex").join("config.yml").is_file() {
            return Ok(dir.to_string_lossy().into_owned());
        }
        match dir.parent() {
            Some(p) => dir = p.to_path_buf(),
            None => {
                return Err(format!(
                    "not inside an iudex workspace (no .iudex/config.yml at or above {start})"
                ))
            }
        }
    }
}

/// Scaffold a non-iudex folder into a workspace by running `iudex init` there
/// (git init + initial commit if it has no history, records the current branch
/// as main_branch, creates `.iudex/`). Offered by the GUI when `discover_workspace`
/// finds no workspace. Returns the canonical root on success.
#[tauri::command(async)]
fn init_workspace(path: String) -> Result<String, String> {
    let canon =
        std::fs::canonicalize(&path).map_err(|e| format!("cannot resolve {path}: {e}"))?;
    if !canon.is_dir() {
        return Err(format!("{} is not a directory", canon.display()));
    }
    let out = Command::new(iudex_bin())
        .arg("init")
        .current_dir(&canon)
        .output()
        .map_err(|e| format!("failed to run {} init: {e}", iudex_bin()))?;
    if !out.status.success() {
        return Err(String::from_utf8_lossy(&out.stderr).trim().to_string());
    }
    Ok(canon.to_string_lossy().into_owned())
}

/// The editable `.iudex/config.yml` fields, surfaced to the Settings view. Read
/// and written directly (not via the CLI — config editing isn't state-machine
/// logic); writes are surgical so the file's comments survive.
#[derive(serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
struct Config {
    main_branch: String,
    max_active: i64,
    qa_reject_limit: i64,
    merge_strategy: String,
    merge_message_template: String,
    branch_prefix: String,
}

fn config_path(root: &str) -> std::path::PathBuf {
    Path::new(root).join(".iudex").join("config.yml")
}

/// The shape of `iudex config --json`. The CLI is the authority for the config
/// schema and the legacy agent_command->pool migration, so the GUI binds to this
/// contract instead of parsing config.yml itself — the read side once duplicated
/// here (a yaml_scalar line-scanner + a RawAgentConfig migration fold) is gone.
#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
struct CliConfig {
    main_branch: String,
    max_active: i64,
    qa_reject_limit: i64,
    merge_strategy: String,
    merge_message_template: String,
    branch_prefix: String,
    #[serde(default)]
    agent_commands: Vec<AgentCmd>,
    #[serde(default)]
    agent_roles: std::collections::BTreeMap<String, String>,
}

/// Read the workspace config via `iudex config --json` — the single source of the
/// schema and the migration. An old iudex without the `config` command surfaces
/// here as an error (the startup capability check guards against that up front).
fn cli_config(root: &str) -> Result<CliConfig, String> {
    let out = Command::new(iudex_bin())
        .args(["config", "--json"])
        .current_dir(root)
        .output()
        .map_err(|e| format!("failed to run {} config: {e}", iudex_bin()))?;
    if !out.status.success() {
        return Err(String::from_utf8_lossy(&out.stderr).trim().to_string());
    }
    serde_json::from_str(&String::from_utf8_lossy(&out.stdout))
        .map_err(|e| format!("parse `iudex config --json`: {e}"))
}

#[tauri::command]
fn read_config(root: String) -> Result<Config, String> {
    let c = cli_config(&root)?;
    Ok(Config {
        main_branch: c.main_branch,
        max_active: c.max_active,
        qa_reject_limit: c.qa_reject_limit,
        merge_strategy: c.merge_strategy,
        merge_message_template: c.merge_message_template,
        branch_prefix: c.branch_prefix,
    })
}

/// Rewrite each known key's value line in place (preserving comments, blank
/// lines, ordering, and any unknown keys); append any key not already present.
/// String values are double-quoted (escaping `"`); numbers/enums are bare.
#[tauri::command]
fn write_config(root: String, config: Config) -> Result<(), String> {
    let path = config_path(&root);
    let text = std::fs::read_to_string(&path).map_err(|e| format!("read config.yml: {e}"))?;

    let q = |v: &str| format!("\"{}\"", v.replace('"', "\\\""));
    // (key, rendered value) for every field we manage.
    let fields: Vec<(&str, String)> = vec![
        ("main_branch", q(&config.main_branch)),
        ("max_active", config.max_active.to_string()),
        ("qa_reject_limit", config.qa_reject_limit.to_string()),
        ("merge_strategy", q(&config.merge_strategy)),
        ("merge_message_template", q(&config.merge_message_template)),
        ("branch_prefix", q(&config.branch_prefix)),
    ];

    let mut lines: Vec<String> = text.lines().map(|l| l.to_string()).collect();
    for (key, val) in &fields {
        let prefix = format!("{key}:");
        let found = lines.iter_mut().find(|l| l.trim_start().starts_with(&prefix));
        match found {
            Some(line) => {
                // Preserve any leading indentation (config is flat, so usually none).
                let indent: String = line.chars().take_while(|c| c.is_whitespace()).collect();
                *line = format!("{indent}{key}: {val}");
            }
            None => lines.push(format!("{key}: {val}")),
        }
    }
    let mut out = lines.join("\n");
    if text.ends_with('\n') {
        out.push('\n');
    }
    std::fs::write(&path, out).map_err(|e| format!("write config.yml: {e}"))?;
    Ok(())
}

// ── Agent command pool + per-role mapping ─────────────────────────────────────
// The pool of named agent commands and the role→name map live in config.yml
// (`agent_commands` + `agent_roles`). Resolution (role→command) is the CLI's:
// impl/qa via `iudex spawn`, and resolve/idea via `iudex agent-command <role>`
// (see resolve_agent_command). The GUI no longer re-derives the rule — it only
// edits the pool. These structs back the editor + the surgical writer.

/// One named entry in the agent-command pool.
#[derive(serde::Serialize, serde::Deserialize, Clone, Default)]
struct AgentCmd {
    name: String,
    command: String,
    #[serde(default)]
    default: bool,
}

/// The agent settings as the GUI edits them.
#[derive(serde::Serialize, serde::Deserialize, Default)]
struct AgentSettings {
    commands: Vec<AgentCmd>,
    roles: std::collections::BTreeMap<String, String>,
}

/// Resolve the agent command for a role via `iudex agent-command <role>` — the
/// CLI is the single source of the role->command rule (incl. the empty-pool
/// error, which the GUI now surfaces instead of silently guessing a binary). Used
/// by the non-ticket spawns (resolve, idea) in tmux.rs.
pub(crate) fn resolve_agent_command(root: &str, role: &str) -> Result<String, String> {
    let out = Command::new(iudex_bin())
        .args(["agent-command", role])
        .current_dir(root)
        .output()
        .map_err(|e| format!("failed to run {} agent-command: {e}", iudex_bin()))?;
    if !out.status.success() {
        return Err(String::from_utf8_lossy(&out.stderr).trim().to_string());
    }
    Ok(String::from_utf8_lossy(&out.stdout).trim().to_string())
}

/// Read the agent pool via `iudex config --json` run from the home dir — so it
/// resolves the global pool with no workspace open (the pool is machine-level).
fn cli_config_global(app: &AppHandle) -> Result<CliConfig, String> {
    let home = app
        .path()
        .home_dir()
        .map_err(|e| format!("cannot resolve home dir: {e}"))?;
    cli_config(&home.to_string_lossy())
}

#[tauri::command]
fn read_agent_config(app: AppHandle) -> AgentSettings {
    match cli_config_global(&app) {
        Ok(c) => AgentSettings {
            commands: c.agent_commands,
            roles: c.agent_roles,
        },
        // An unreadable config yields an empty editor rather than an error — which
        // is also the "not configured yet" first-run state onboarding keys on.
        Err(_) => AgentSettings::default(),
    }
}

/// Double-quote a YAML scalar (commands carry spaces/flags; names are refs).
fn yaml_q(v: &str) -> String {
    format!("\"{}\"", v.replace('\\', "\\\\").replace('"', "\\\""))
}

/// Render the `agent_commands` + `agent_roles` blocks (with their comments).
fn render_agent_section(cfg: &AgentSettings) -> Vec<String> {
    let mut out: Vec<String> = vec![
        "# Pool of named agent commands used to build spawn commands. iudex never".into(),
        "# launches the agent itself — it only prints the command for you to run.".into(),
        "# Exactly one entry is marked `default: true`; it backs any unmapped role.".into(),
    ];
    if cfg.commands.is_empty() {
        out.push("agent_commands: []".into());
    } else {
        out.push("agent_commands:".into());
        for c in &cfg.commands {
            out.push(format!("  - name: {}", yaml_q(&c.name)));
            out.push(format!("    command: {}", yaml_q(&c.command)));
            if c.default {
                out.push("    default: true".into());
            }
        }
    }
    out.push(String::new());
    out.push("# Per-role agent selection (impl, qa, resolve, idea). Maps a role to a".into());
    out.push("# command name from the pool; omitted roles use the default entry.".into());
    if cfg.roles.is_empty() {
        out.push("agent_roles: {}".into());
    } else {
        out.push("agent_roles:".into());
        for (k, v) in &cfg.roles {
            out.push(format!("  {k}: {}", yaml_q(v)));
        }
    }
    out
}

/// Persist the agent pool + role map. Strips the existing agent blocks (and their
/// comments, and the legacy `agent_command:`) and appends freshly-rendered ones,
/// leaving every other key and its comments byte-identical (General's surgical
/// scalar writer is untouched).
/// Strip any existing agent blocks (and their comments, plus the legacy single
/// `agent_command:`) from a config.yml's text and append freshly-rendered ones,
/// leaving every other key + its comments byte-identical. Pure (no I/O) so it's
/// unit-testable and reused for both an existing file and a fresh global config.
fn apply_agent_config(text: &str, config: &AgentSettings) -> String {
    let is_agent_key = |t: &str| {
        t.starts_with("agent_roles:")
            || t.starts_with("agent_commands:")
            || (t.starts_with("agent_command:") && !t.starts_with("agent_commands:"))
    };

    let lines: Vec<&str> = text.lines().collect();
    let mut out: Vec<String> = Vec::with_capacity(lines.len());
    let mut i = 0;
    while i < lines.len() {
        let line = lines[i];
        let top_level = !line.starts_with(char::is_whitespace) && !line.trim().is_empty();
        if top_level && is_agent_key(line.trim_start()) {
            // Drop the comment lines we already emitted for this block.
            while out.last().is_some_and(|l| l.trim_start().starts_with('#')) {
                out.pop();
            }
            // Skip the key line, its indented/list children, and one trailing blank.
            i += 1;
            while i < lines.len() {
                let l = lines[i];
                if l.trim().is_empty() {
                    i += 1;
                    break;
                }
                if l.starts_with(char::is_whitespace) || l.trim_start().starts_with('-') {
                    i += 1;
                    continue;
                }
                break;
            }
            continue;
        }
        out.push(line.to_string());
        i += 1;
    }

    // Trim trailing blank lines, then append the agent section. A separator blank
    // only when there's existing content above it (a fresh global file has none).
    while out.last().is_some_and(|l| l.trim().is_empty()) {
        out.pop();
    }
    if !out.is_empty() {
        out.push(String::new());
    }
    out.extend(render_agent_section(config));

    let mut joined = out.join("\n");
    joined.push('\n');
    joined
}

#[tauri::command]
fn write_agent_config(app: AppHandle, config: AgentSettings) -> Result<(), String> {
    let path = global_config_path(&app)?;
    // The global config may not exist yet (first-run / error-until-configured),
    // so start from its contents when present, else an empty document.
    let text = std::fs::read_to_string(&path).unwrap_or_default();
    let joined = apply_agent_config(&text, &config);
    if let Some(dir) = path.parent() {
        std::fs::create_dir_all(dir).map_err(|e| format!("create {}: {e}", dir.display()))?;
    }
    std::fs::write(&path, joined).map_err(|e| format!("write {}: {e}", path.display()))?;
    Ok(())
}

/// The path for a named prompt template, guarded to the known prompts.
fn prompt_path(root: &str, name: &str) -> Result<std::path::PathBuf, String> {
    let file = match name {
        "impl" => "impl.md",
        "review" => "review.md",
        "resolve" => "resolve.md",
        _ => return Err(format!("unknown prompt {name:?}")),
    };
    Ok(Path::new(root).join(".iudex").join("prompts").join(file))
}

#[tauri::command]
fn read_prompt(root: String, name: String) -> Result<String, String> {
    let path = prompt_path(&root, &name)?;
    match std::fs::read_to_string(&path) {
        Ok(s) => Ok(s),
        // resolve.md may not exist in workspaces created before it did — show the
        // built-in default so it's still editable (saving creates the file).
        Err(e) if e.kind() == std::io::ErrorKind::NotFound && name == "resolve" => {
            Ok(crate::tmux::RESOLVE_PROMPT.to_string())
        }
        Err(e) => Err(format!("read {}: {e}", path.display())),
    }
}

#[tauri::command]
fn write_prompt(root: String, name: String, content: String) -> Result<(), String> {
    let path = prompt_path(&root, &name)?;
    std::fs::write(&path, content).map_err(|e| format!("write {}: {e}", path.display()))
}

/// Read a PRD's raw markdown from `.context/prd/<file>`. The Specifications view
/// parses requirement *structure* from this raw source in the GUI
/// (`gui/src/lib/spec.ts` — a display concern, not state-machine logic); this
/// returns the verbatim source, the same kind of plain file read as
/// `read_prompt`. Only the basename is honored, so a crafted `file` cannot
/// escape the PRD directory.
#[tauri::command]
fn read_prd(root: String, file: String) -> Result<String, String> {
    let name = Path::new(&file)
        .file_name()
        .and_then(|n| n.to_str())
        .ok_or_else(|| format!("invalid prd file {file:?}"))?;
    let path = Path::new(&root).join(".context").join("prd").join(name);
    std::fs::read_to_string(&path).map_err(|e| format!("read {}: {e}", path.display()))
}

/// List the PRD basenames under `.context/prd` (files ending in `.md`, sorted
/// ascending). A missing directory is not an error — it yields an empty list.
/// The Specifications view parses each file's structure in the GUI, so this is
/// just the directory listing the old `iudex spec --json` used to fold in.
#[tauri::command]
fn list_prds(root: String) -> Result<Vec<String>, String> {
    let dir = Path::new(&root).join(".context").join("prd");
    let entries = match std::fs::read_dir(&dir) {
        Ok(entries) => entries,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(vec![]),
        Err(e) => return Err(e.to_string()),
    };
    let mut names = Vec::new();
    for entry in entries {
        let entry = entry.map_err(|e| e.to_string())?;
        if entry.file_type().map_err(|e| e.to_string())?.is_dir() {
            continue;
        }
        let name = entry.file_name().to_string_lossy().into_owned();
        if name.ends_with(".md") {
            names.push(name);
        }
    }
    names.sort();
    Ok(names)
}

/// Run `iudex status --json` in `root` and return the parsed JSON. This is the
/// GUI's sole read path; the state machine stays single-sourced in the CLI.
#[tauri::command(async)]
fn iudex_status(root: String) -> Result<serde_json::Value, String> {
    let out = Command::new(iudex_bin())
        .args(["status", "--json"])
        .current_dir(&root)
        .output()
        .map_err(|e| format!("failed to run {}: {e}", iudex_bin()))?;
    if !out.status.success() {
        return Err(format!(
            "iudex status failed: {}",
            String::from_utf8_lossy(&out.stderr).trim()
        ));
    }
    serde_json::from_slice(&out.stdout).map_err(|e| format!("invalid JSON from iudex: {e}"))
}

/// Compose a new ticket from the GUI: allocate the next id (`iudex
/// next-ticket-id`), write the brief to `.iudex/queue/tN.md`, then register it
/// with `iudex queue [--deps …]`. This is the thin native front-of-funnel for
/// trivial manual tickets; the heavier shaping path spawns a skill agent
/// instead. Returns the new ticket id. The doorbell then refreshes the table.
#[tauri::command(async)]
fn compose_ticket(
    root: String,
    title: String,
    body: String,
    deps: Vec<String>,
) -> Result<String, String> {
    // Allocate the next id (CLI prints a bare number, e.g. "7").
    let out = Command::new(iudex_bin())
        .arg("next-ticket-id")
        .current_dir(&root)
        .output()
        .map_err(|e| format!("iudex next-ticket-id: {e}"))?;
    if !out.status.success() {
        return Err(String::from_utf8_lossy(&out.stderr).trim().to_string());
    }
    let n = String::from_utf8_lossy(&out.stdout).trim().to_string();
    if n.is_empty() {
        return Err("iudex next-ticket-id returned nothing".to_string());
    }
    let ticket = format!("t{n}");

    // Build the brief: an H1 title heading (when given) followed by the body.
    // The title is the bare descriptive text — no `tN:` prefix, since the id is
    // shown separately (matches what the to-issues skill writes). When no title
    // is given, fall back to the id so the brief still has a parsable H1.
    let title = title.trim();
    let body = body.trim();
    let content = match (title.is_empty(), body.is_empty()) {
        (false, false) => format!("# {title}\n\n{body}\n"),
        (false, true) => format!("# {title}\n"),
        (true, false) => format!("{body}\n"),
        (true, true) => format!("# {ticket}\n"),
    };

    let queue_file = Path::new(&root)
        .join(".iudex")
        .join("queue")
        .join(format!("{ticket}.md"));
    std::fs::write(&queue_file, content)
        .map_err(|e| format!("write {}: {e}", queue_file.display()))?;

    // Register it. On failure, remove the orphan brief so it isn't left behind.
    let mut args = vec!["queue".to_string(), ticket.clone()];
    if !deps.is_empty() {
        args.push("--deps".to_string());
        args.push(deps.join(","));
    }
    let out = Command::new(iudex_bin())
        .args(&args)
        .current_dir(&root)
        .output()
        .map_err(|e| format!("iudex queue: {e}"))?;
    if !out.status.success() {
        let _ = std::fs::remove_file(&queue_file);
        return Err(String::from_utf8_lossy(&out.stderr).trim().to_string());
    }
    Ok(ticket)
}

/// A physical git worktree in the repo, as surfaced to the Worktrees view. The
/// main worktree (the repo root) is filtered out; what's left is one entry per
/// `.iudex/worktrees/tN`. The frontend joins these to tickets by `path`, so a
/// worktree shows once even if more than one ticket maps onto it.
#[derive(serde::Serialize)]
struct Worktree {
    path: String,
    branch: String, // short name (e.g. "work/t3"), or "" when detached
    head: String,   // commit sha
}

/// Enumerate the repo's worktrees via `git worktree list --porcelain`, dropping
/// the main worktree (path == root). Read-only git plumbing — not state-machine
/// logic — so it lives in the GUI backend rather than the CLI.
#[tauri::command(async)]
fn list_worktrees(root: String) -> Result<Vec<Worktree>, String> {
    let out = Command::new("git")
        .args(["-C", &root, "worktree", "list", "--porcelain"])
        .output()
        .map_err(|e| format!("git worktree list: {e}"))?;
    if !out.status.success() {
        return Err(String::from_utf8_lossy(&out.stderr).trim().to_string());
    }
    let root_canon = std::fs::canonicalize(&root).ok();
    let text = String::from_utf8_lossy(&out.stdout);

    let mut worktrees = Vec::new();
    let (mut path, mut head, mut branch) = (String::new(), String::new(), String::new());
    let mut flush = |path: &mut String, head: &mut String, branch: &mut String| {
        if path.is_empty() {
            return;
        }
        let is_main = std::fs::canonicalize(&*path).ok() == root_canon;
        if !is_main {
            worktrees.push(Worktree {
                path: std::mem::take(path),
                branch: std::mem::take(branch),
                head: std::mem::take(head),
            });
        } else {
            path.clear();
            head.clear();
            branch.clear();
        }
    };
    // Records are blank-line separated; each is `worktree <p>` / `HEAD <sha>` /
    // `branch refs/heads/<name>` (or `detached`).
    for line in text.lines() {
        if let Some(p) = line.strip_prefix("worktree ") {
            flush(&mut path, &mut head, &mut branch);
            path = p.to_string();
        } else if let Some(h) = line.strip_prefix("HEAD ") {
            head = h.to_string();
        } else if let Some(b) = line.strip_prefix("branch ") {
            branch = b.strip_prefix("refs/heads/").unwrap_or(b).to_string();
        }
    }
    flush(&mut path, &mut head, &mut branch);
    Ok(worktrees)
}

/// One changed file in a worktree, relative to `main_branch`.
#[derive(serde::Serialize)]
struct FileChange {
    path: String,
    status: String, // "A" | "M" | "D" | "R" | "U" (untracked)
    additions: Option<u32>,
    deletions: Option<u32>,
}

/// Files that differ between a worktree's current working tree (committed +
/// uncommitted) and `main_branch`, plus untracked files. `git diff <main>`
/// (two-dot) captures tracked changes including uncommitted ones — agents commit
/// late, so the worktree is usually dirty; `ls-files --others` folds in the rest.
#[tauri::command(async)]
fn worktree_changes(
    worktree: String,
    main_branch: String,
    three_dot: Option<bool>,
) -> Result<Vec<FileChange>, String> {
    use std::collections::BTreeMap;

    let (base, target, include_untracked) = diff_base(&worktree, &main_branch, three_dot);
    // `git diff <base> [target]`: two-dot vs the working tree (Worktrees), or
    // base..HEAD i.e. three-dot vs the merge-base (Review).
    let diff_args = |flag: &str| {
        let mut a = vec![
            "-C".to_string(),
            worktree.clone(),
            "diff".to_string(),
            flag.to_string(),
            base.clone(),
        ];
        if let Some(t) = &target {
            a.push(t.clone());
        }
        a
    };

    // name-status: the change letter per path.
    let out = Command::new("git")
        .args(diff_args("--name-status"))
        .output()
        .map_err(|e| format!("git diff --name-status: {e}"))?;
    if !out.status.success() {
        return Err(String::from_utf8_lossy(&out.stderr).trim().to_string());
    }
    let mut order: Vec<String> = Vec::new();
    let mut status: BTreeMap<String, String> = BTreeMap::new();
    for line in String::from_utf8_lossy(&out.stdout).lines() {
        let mut cols = line.split('\t');
        let Some(code) = cols.next() else { continue };
        // Renames/copies (R100/C100) carry old\tnew; take the new path.
        let path = cols.last().unwrap_or("").to_string();
        if path.is_empty() {
            continue;
        }
        let letter = code.chars().next().unwrap_or('M').to_string();
        order.push(path.clone());
        status.insert(path, letter);
    }

    // numstat: per-path additions/deletions for the same diff.
    let mut counts: BTreeMap<String, (u32, u32)> = BTreeMap::new();
    if let Ok(out) = Command::new("git").args(diff_args("--numstat")).output() {
        for line in String::from_utf8_lossy(&out.stdout).lines() {
            let mut cols = line.split('\t');
            let add = cols.next().unwrap_or("-").parse::<u32>().ok();
            let del = cols.next().unwrap_or("-").parse::<u32>().ok();
            if let Some(path) = cols.last() {
                counts.insert(path.to_string(), (add.unwrap_or(0), del.unwrap_or(0)));
            }
        }
    }

    // Untracked files (respecting .gitignore) — only for the working-tree (two-
    // dot) view; the three-dot authored diff is committed-only.
    if include_untracked {
        if let Ok(out) = Command::new("git")
            .args(["-C", &worktree, "ls-files", "--others", "--exclude-standard"])
            .output()
        {
            for path in String::from_utf8_lossy(&out.stdout).lines() {
                if path.is_empty() || status.contains_key(path) {
                    continue;
                }
                order.push(path.to_string());
                status.insert(path.to_string(), "U".to_string());
            }
        }
    }

    Ok(order
        .into_iter()
        .map(|path| {
            let (add, del) = counts.get(&path).copied().map_or((None, None), |(a, d)| {
                (Some(a), Some(d))
            });
            FileChange {
                status: status.get(&path).cloned().unwrap_or_else(|| "M".into()),
                additions: add,
                deletions: del,
                path,
            }
        })
        .collect())
}

/// Resolve the diff base for a worktree view. Two-dot (Worktrees): base is
/// `main_branch` and the target is the working tree, so uncommitted edits show.
/// Three-dot (Review): base is the merge-base of main and HEAD and the target is
/// HEAD, so it shows only what the ticket *authored* (matching the CLI's
/// `git.Diff` = `base...HEAD`). Returns (base, target, include_untracked).
fn diff_base(
    worktree: &str,
    main_branch: &str,
    three_dot: Option<bool>,
) -> (String, Option<String>, bool) {
    if three_dot.unwrap_or(false) {
        let mb = Command::new("git")
            .args(["-C", worktree, "merge-base", main_branch, "HEAD"])
            .output()
            .ok()
            .filter(|o| o.status.success())
            .map(|o| String::from_utf8_lossy(&o.stdout).trim().to_string())
            .filter(|s| !s.is_empty())
            .unwrap_or_else(|| main_branch.to_string());
        (mb, Some("HEAD".to_string()), false)
    } else {
        (main_branch.to_string(), None, true)
    }
}

/// Base vs head content for one file, fed to the Monaco diff viewer. `original`
/// is the file at the diff base (empty for an added file); `modified` is the
/// head content (empty for a deleted file) — the working tree in two-dot mode,
/// or HEAD in three-dot mode.
#[derive(serde::Serialize)]
struct FileDiff {
    original: String,
    modified: String,
    language: String,
}

#[tauri::command(async)]
fn worktree_file_diff(
    worktree: String,
    path: String,
    main_branch: String,
    three_dot: Option<bool>,
) -> Result<FileDiff, String> {
    let (base, target, _) = diff_base(&worktree, &main_branch, three_dot);

    let show = |rev: &str| {
        Command::new("git")
            .args(["-C", &worktree, "show", &format!("{rev}:{path}")])
            .output()
            .ok()
            .filter(|o| o.status.success())
            .map(|o| String::from_utf8_lossy(&o.stdout).into_owned())
            .unwrap_or_default()
    };

    // Base content at the diff base; absent (added file) → empty, not an error.
    let original = show(&base);
    // Head content: HEAD blob in three-dot mode, else the working-tree file.
    let modified = match &target {
        Some(rev) => show(rev),
        None => std::fs::read_to_string(Path::new(&worktree).join(&path)).unwrap_or_default(),
    };

    Ok(FileDiff {
        original,
        modified,
        language: language_for(&path),
    })
}

/// Map a file extension to a Monaco language id (best-effort; unknown → "").
fn language_for(path: &str) -> String {
    let ext = Path::new(path)
        .extension()
        .and_then(|e| e.to_str())
        .unwrap_or("")
        .to_lowercase();
    let lang = match ext.as_str() {
        "go" => "go",
        "rs" => "rust",
        "ts" | "mts" | "cts" => "typescript",
        "tsx" => "typescript",
        "js" | "mjs" | "cjs" => "javascript",
        "jsx" => "javascript",
        "py" => "python",
        "rb" => "ruby",
        "java" => "java",
        "c" | "h" => "c",
        "cc" | "cpp" | "hpp" | "cxx" => "cpp",
        "cs" => "csharp",
        "json" => "json",
        "yml" | "yaml" => "yaml",
        "toml" => "ini",
        "md" | "markdown" => "markdown",
        "sh" | "bash" | "zsh" => "shell",
        "html" | "htm" => "html",
        "css" => "css",
        "sql" => "sql",
        _ => "",
    };
    lang.to_string()
}

/// A flat, sorted list of the worktree's files as git sees them: tracked +
/// untracked, minus everything gitignored (so `node_modules`/`target`/`.iudex`
/// never appear). Powers the read-only "all files" codebase browser — the
/// frontend builds the tree from these paths. Read-only git plumbing, like the
/// diff commands.
#[tauri::command(async)]
fn list_tree(worktree: String) -> Result<Vec<String>, String> {
    let out = Command::new("git")
        .args([
            "-C",
            &worktree,
            "ls-files",
            "--cached",
            "--others",
            "--exclude-standard",
        ])
        .output()
        .map_err(|e| format!("git ls-files: {e}"))?;
    if !out.status.success() {
        return Err(String::from_utf8_lossy(&out.stderr).trim().to_string());
    }
    let mut paths: Vec<String> = String::from_utf8_lossy(&out.stdout)
        .lines()
        .filter(|l| !l.is_empty())
        .map(str::to_string)
        .collect();
    paths.sort();
    Ok(paths)
}

/// The current on-disk content of one file in a worktree, for the read-only
/// single-file viewer. Reads the working tree (uncommitted edits included);
/// a binary/unreadable file returns a placeholder rather than erroring.
#[derive(serde::Serialize)]
struct FileView {
    content: String,
    language: String,
}

#[tauri::command]
fn read_file(worktree: String, path: String) -> Result<FileView, String> {
    let full = Path::new(&worktree).join(&path);
    let content = std::fs::read_to_string(&full)
        .unwrap_or_else(|_| "(binary or unreadable file)".to_string());
    Ok(FileView {
        content,
        language: language_for(&path),
    })
}

/// The `.task/` docs for a ticket, read straight from its worktree — the same
/// files `iudex review` prints, surfaced structured for the Review workspace.
#[derive(serde::Serialize)]
struct TaskDocs {
    brief: String,
    log: String,
    review: String,
}

#[tauri::command]
fn read_queue_brief(root: String, id: String) -> Result<String, String> {
    let path = Path::new(&root)
        .join(".iudex")
        .join("queue")
        .join(format!("{}.md", id));
    std::fs::read_to_string(&path)
        .map_err(|e| format!("cannot read queue brief for {id}: {e}"))
}

#[tauri::command]
fn write_queue_brief(root: String, id: String, content: String) -> Result<(), String> {
    let path = Path::new(&root)
        .join(".iudex")
        .join("queue")
        .join(format!("{}.md", id));
    std::fs::write(&path, content)
        .map_err(|e| format!("cannot write queue brief for {id}: {e}"))
}

#[tauri::command]
fn worktree_task_docs(worktree: String) -> Result<TaskDocs, String> {
    let read = |name: &str| {
        std::fs::read_to_string(Path::new(&worktree).join(".task").join(name)).unwrap_or_default()
    };
    Ok(TaskDocs {
        brief: read("brief.md"),
        log: read("log.md"),
        review: read("review.md"),
    })
}

/// Count uncommitted changes in a worktree (`git status --porcelain`, excluding
/// the ignored `.task/`). The GUI uses this to warn before a manual `iudex
/// finish`, whose auto-WIP-commit would otherwise ship unready edits to QA. A
/// clean worktree returns 0.
#[tauri::command(async)]
fn worktree_dirty_count(worktree: String) -> Result<usize, String> {
    let out = Command::new("git")
        .args(["-C", &worktree, "status", "--porcelain"])
        .output()
        .map_err(|e| format!("git status: {e}"))?;
    if !out.status.success() {
        return Err(String::from_utf8_lossy(&out.stderr).trim().to_string());
    }
    let n = String::from_utf8_lossy(&out.stdout)
        .lines()
        .filter(|l| {
            // Drop the status code prefix (XY + space) to inspect the path; skip
            // the .task/ scratch dir, which is git-ignored via the shared exclude
            // and never part of the handoff.
            let path = l.get(3..).unwrap_or("").trim();
            !path.is_empty() && !path.starts_with(".task/")
        })
        .count();
    Ok(n)
}

/// Remove an orphaned worktree — the residue of best-effort cleanup that didn't
/// finish (a physical worktree whose ticket is terminal or unknown). Guarded: the
/// path must canonicalize to under `<root>/.iudex/worktrees/`, so a stray call can
/// never remove an arbitrary directory. Runs from the main repo root, like
/// `list_worktrees` (git refuses `worktree remove` from inside the target). The
/// branch is left alone — the archive holds diff.patch, and branch cleanup is out
/// of scope.
#[tauri::command(async)]
fn remove_worktree(root: String, path: String, force: bool) -> Result<(), String> {
    let base = std::fs::canonicalize(Path::new(&root).join(".iudex").join("worktrees"))
        .map_err(|e| format!("canonicalize worktrees dir: {e}"))?;
    let target = std::fs::canonicalize(&path).map_err(|e| format!("canonicalize {path}: {e}"))?;
    if !target.starts_with(&base) {
        return Err("refusing to remove a worktree outside .iudex/worktrees".to_string());
    }
    let mut args = vec!["-C", &root, "worktree", "remove"];
    if force {
        args.push("--force");
    }
    let target_str = target.to_string_lossy();
    args.push(&target_str);
    let out = Command::new("git")
        .args(&args)
        .output()
        .map_err(|e| format!("git worktree remove: {e}"))?;
    if !out.status.success() {
        return Err(String::from_utf8_lossy(&out.stderr).trim().to_string());
    }
    Ok(())
}

/// Discard everything in a ticket's worktree and reset it to the tip of
/// `main_branch` — a hard reset + `clean -fd`, so a fresh agent starts from a
/// pristine tree. Backs the Agents "Restart clean" (destructive) rung. Guarded
/// to `.iudex/worktrees/` (like remove_worktree) so it can never nuke files
/// elsewhere. `.task/` (the brief) survives: it's ignored, and `clean` without
/// `-x` leaves ignored files alone — so the respawned agent still has its brief.
#[tauri::command(async)]
fn reset_worktree(worktree: String, main_branch: String) -> Result<(), String> {
    let target = std::fs::canonicalize(&worktree)
        .map_err(|e| format!("canonicalize {worktree}: {e}"))?;
    // The target must live under a ".iudex/worktrees" dir (consecutive path
    // components), so a hard reset can never escape into the real repo.
    let comps: Vec<_> = target.components().collect();
    if !comps
        .windows(2)
        .any(|w| w[0].as_os_str() == ".iudex" && w[1].as_os_str() == "worktrees")
    {
        return Err("refusing to reset a worktree outside .iudex/worktrees".to_string());
    }
    let target_str = target.to_string_lossy();
    let reset = Command::new("git")
        .args(["-C", &target_str, "reset", "--hard", &main_branch])
        .output()
        .map_err(|e| format!("git reset: {e}"))?;
    if !reset.status.success() {
        return Err(String::from_utf8_lossy(&reset.stderr).trim().to_string());
    }
    let clean = Command::new("git")
        .args(["-C", &target_str, "clean", "-fd"])
        .output()
        .map_err(|e| format!("git clean: {e}"))?;
    if !clean.status.success() {
        return Err(String::from_utf8_lossy(&clean.stderr).trim().to_string());
    }
    Ok(())
}

/// GUI-owned workspace text: the line typed into a stalled agent's REPL by the
/// Agents "Resume" action (send-keys + Enter). Stored as a `gui_*` key the CLI
/// ignores, per the gui_sequential precedent; blank/absent falls back to a
/// generic, harness-neutral nudge.
const DEFAULT_RESUME_NUDGE: &str =
    "Your previous request failed or timed out. Please retry and continue where you left off.";

#[tauri::command]
fn get_resume_nudge(root: String) -> String {
    std::fs::read_to_string(config_path(&root))
        .ok()
        .and_then(|t| yaml_scalar(&t, "gui_resume_nudge"))
        .filter(|s| !s.trim().is_empty())
        .unwrap_or_else(|| DEFAULT_RESUME_NUDGE.to_string())
}

#[tauri::command]
fn set_resume_nudge(root: String, value: String) -> Result<(), String> {
    let path = config_path(&root);
    let text =
        std::fs::read_to_string(&path).map_err(|e| format!("read {}: {e}", path.display()))?;
    // Empty → clear the key (reverts to the built-in default).
    let v = value.trim();
    let out = yaml_upsert_scalar(&text, "gui_resume_nudge", (!v.is_empty()).then_some(v));
    std::fs::write(&path, out).map_err(|e| format!("write {}: {e}", path.display()))
}

/// One archived ticket (.iudex/archive/<id>/) — the list entry for the Archive
/// view. `outcome` is "done" (merged) or "removed" (abandoned); the GUI filters.
#[derive(serde::Serialize)]
struct ArchiveEntry {
    id: String,
    outcome: String,
    title: String,
    #[serde(rename = "archivedAt")]
    archived_at: String,
    #[serde(rename = "mergeCommit")]
    merge_commit: String,
    #[serde(rename = "qaRejects")]
    qa_rejects: i64,
    // Prerequisite ticket ids, recovered from this ticket's `queue` event in the
    // embedded history below (deps live only in the event log, never in markdown).
    deps: Vec<String>,
}

#[derive(serde::Deserialize)]
struct ArchiveMetaRaw {
    #[serde(default)]
    outcome: String,
    #[serde(default)]
    archived_at: String,
    #[serde(default)]
    merge_commit: String,
    #[serde(default)]
    qa_rejects: i64,
    // Full event history archived alongside the ticket; we scan it for the deps.
    #[serde(default)]
    events: Vec<MetaEvent>,
}

#[derive(serde::Deserialize)]
struct MetaEvent {
    #[serde(default)]
    ticket: String,
    #[serde(default)]
    trigger: String,
    #[serde(default)]
    deps: Vec<String>,
}

/// List archived tickets, newest first. Reads each .iudex/archive/<id>/meta.json
/// plus the brief title. Pure file reads — the CLI already wrote the archive on
/// human-qa approve / remove, so this is plumbing, not state-machine logic.
#[tauri::command]
fn list_archives(root: String) -> Result<Vec<ArchiveEntry>, String> {
    let dir = Path::new(&root).join(".iudex").join("archive");
    let mut out = Vec::new();
    let read = match std::fs::read_dir(&dir) {
        Ok(r) => r,
        Err(_) => return Ok(out), // no archive directory yet
    };
    for entry in read.flatten() {
        let path = entry.path();
        if !path.is_dir() {
            continue;
        }
        let meta_txt = match std::fs::read_to_string(path.join("meta.json")) {
            Ok(t) => t,
            Err(_) => continue,
        };
        let meta: ArchiveMetaRaw = match serde_json::from_str(&meta_txt) {
            Ok(m) => m,
            Err(_) => continue,
        };
        let id = entry.file_name().to_string_lossy().to_string();
        // This ticket's prerequisites: the deps on its own `queue` event.
        let deps = meta
            .events
            .iter()
            .find(|e| e.ticket == id && e.trigger == "queue")
            .map(|e| e.deps.clone())
            .unwrap_or_default();
        out.push(ArchiveEntry {
            id,
            outcome: meta.outcome,
            title: archive_title(&path),
            archived_at: meta.archived_at,
            merge_commit: meta.merge_commit,
            qa_rejects: meta.qa_rejects,
            deps,
        });
    }
    // archived_at is RFC3339 → lexical sort is chronological; newest first.
    out.sort_by(|a, b| b.archived_at.cmp(&a.archived_at));
    Ok(out)
}

/// Title from an archived brief.md: first non-empty line, heading marker stripped.
fn archive_title(dir: &Path) -> String {
    let text = std::fs::read_to_string(dir.join("brief.md")).unwrap_or_default();
    for line in text.lines() {
        let l = line.trim();
        if l.is_empty() {
            continue;
        }
        return l.trim_start_matches('#').trim().to_string();
    }
    String::new()
}

/// The archived docs + final diff for one ticket — the Archive detail pane.
#[derive(serde::Serialize)]
struct ArchiveDocs {
    brief: String,
    log: String,
    review: String,
    diff: String,
}

#[tauri::command]
fn read_archive(root: String, id: String) -> Result<ArchiveDocs, String> {
    let dir = Path::new(&root).join(".iudex").join("archive").join(&id);
    let read = |name: &str| std::fs::read_to_string(dir.join(name)).unwrap_or_default();
    Ok(ArchiveDocs {
        brief: read("brief.md"),
        log: read("log.md"),
        review: read("review.md"),
        diff: read("diff.patch"),
    })
}

/// The merge-preflight for Review — predicts, ahead of time, whether
/// `iudex human-qa approve` would succeed, so the merge only ever fires when
/// guaranteed to. Mirrors the CLI's two approve gates (root on main_branch +
/// clean) and adds a zero-side-effect conflict prediction via `git merge-tree`.
#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct Preflight {
    current_branch: String,
    on_main: bool,
    clean: bool,
    dirty_files: Vec<String>,
    would_conflict: bool,
    conflict_files: Vec<String>,
    merge_in_progress: bool,
    ready: bool,
}

#[tauri::command(async)]
fn merge_preflight(
    root: String,
    worktree: String,
    main_branch: String,
) -> Result<Preflight, String> {
    // The ticket's work branch is just whatever its worktree has checked out, so
    // the frontend needn't reconstruct `branch_prefix + id`.
    let work_branch = Command::new("git")
        .args(["-C", &worktree, "rev-parse", "--abbrev-ref", "HEAD"])
        .output()
        .map_err(|e| format!("git rev-parse (worktree): {e}"))?;
    let work_branch = String::from_utf8_lossy(&work_branch.stdout).trim().to_string();

    // Gate 1: is the repo root on main_branch?
    let current_branch = Command::new("git")
        .args(["-C", &root, "rev-parse", "--abbrev-ref", "HEAD"])
        .output()
        .map_err(|e| format!("git rev-parse: {e}"))?;
    let current_branch = String::from_utf8_lossy(&current_branch.stdout).trim().to_string();
    let on_main = current_branch == main_branch;

    // Gate 2: is the root clean?
    let status = Command::new("git")
        .args(["-C", &root, "status", "--porcelain"])
        .output()
        .map_err(|e| format!("git status: {e}"))?;
    let dirty_files: Vec<String> = String::from_utf8_lossy(&status.stdout)
        .lines()
        .filter_map(|l| {
            let l = l.trim_end();
            (l.len() > 3).then(|| l[3..].to_string())
        })
        .collect();
    let clean = dirty_files.is_empty();

    // Gate 3: would the merge conflict? `merge-tree --write-tree` does the whole
    // merge in-memory (no worktree/index touched): exit 0 = clean, exit 1 =
    // conflict with the conflicting paths on stdout (NUL-separated via -z).
    let mt = Command::new("git")
        .args([
            "-C",
            &root,
            "merge-tree",
            "--write-tree",
            "-z",
            "--name-only",
            &main_branch,
            &work_branch,
        ])
        .output()
        .map_err(|e| format!("git merge-tree: {e}"))?;
    let conflict_exit = !mt.status.success();
    let mut conflict_files = Vec::new();
    if conflict_exit {
        // Output is NUL-separated sections: <tree-oid>\0 then the conflicted
        // file names, each NUL-terminated, before an informational-messages
        // section. We take the file-name run that follows the OID.
        let raw = String::from_utf8_lossy(&mt.stdout);
        let mut parts = raw.split('\0');
        let _oid = parts.next(); // first field is the resulting tree OID
        for p in parts {
            // The messages section starts after a blank field; stop there.
            if p.is_empty() {
                break;
            }
            conflict_files.push(p.to_string());
        }
    }

    // A merge already underway in the worktree (after Begin resolution).
    let merge_in_progress = Command::new("git")
        .args(["-C", &worktree, "rev-parse", "-q", "--verify", "MERGE_HEAD"])
        .output()
        .map(|o| o.status.success())
        .unwrap_or(false);

    let ready = on_main && clean && !conflict_exit && !merge_in_progress;
    Ok(Preflight {
        current_branch,
        on_main,
        clean,
        dirty_files,
        would_conflict: conflict_exit,
        conflict_files,
        merge_in_progress,
        ready,
    })
}

/// Begin conflict resolution in a worktree: `git merge <main>` there, which
/// materializes conflict markers for the user to edit. iudex itself never leaves
/// a conflicted tree, so this is the GUI's opt-in convenience. Guarded: refuses
/// if the worktree is dirty or a merge is already underway. Returns whether the
/// merge produced conflicts (false ⇒ it merged cleanly, nothing to resolve).
#[tauri::command(async)]
fn begin_resolution(worktree: String, main_branch: String) -> Result<bool, String> {
    let dirty = Command::new("git")
        .args(["-C", &worktree, "status", "--porcelain"])
        .output()
        .map(|o| !o.stdout.is_empty())
        .unwrap_or(false);
    if dirty {
        return Err("worktree has uncommitted changes — commit or stash them first".into());
    }
    let in_progress = Command::new("git")
        .args(["-C", &worktree, "rev-parse", "-q", "--verify", "MERGE_HEAD"])
        .output()
        .map(|o| o.status.success())
        .unwrap_or(false);
    if in_progress {
        return Err("a merge is already in progress in this worktree".into());
    }
    let out = Command::new("git")
        .args(["-C", &worktree, "merge", &main_branch])
        .output()
        .map_err(|e| format!("git merge: {e}"))?;
    // A non-zero exit here is the expected "merge left conflicts" case, not an
    // error; only a genuinely missing merge (e.g. bad ref) is surfaced.
    if !out.status.success() {
        let combined = format!(
            "{}{}",
            String::from_utf8_lossy(&out.stdout),
            String::from_utf8_lossy(&out.stderr)
        );
        if combined.contains("CONFLICT") || combined.contains("Automatic merge failed") {
            return Ok(true);
        }
        return Err(combined.trim().to_string());
    }
    Ok(false)
}

/// Abort an in-progress resolution merge in a worktree, restoring it.
#[tauri::command(async)]
fn abort_resolution(worktree: String) -> Result<(), String> {
    Command::new("git")
        .args(["-C", &worktree, "merge", "--abort"])
        .status()
        .map_err(|e| format!("git merge --abort: {e}"))?;
    Ok(())
}

/// The agent's structured conflict-triage report, written to
/// `.task/resolution.json`. `resolved` is informational; the authoritative list
/// of what still needs a human is git's unmerged set (see `read_resolution`).
#[derive(serde::Deserialize, serde::Serialize, Clone, Default)]
struct ResolvedItem {
    file: String,
    #[serde(default)]
    note: String,
}
#[derive(serde::Deserialize, serde::Serialize, Clone, Default)]
struct FlaggedItem {
    file: String,
    #[serde(default)]
    reason: String,
}
#[derive(serde::Deserialize, Default)]
struct Report {
    #[serde(default)]
    resolved: Vec<ResolvedItem>,
    #[serde(default)]
    flagged: Vec<FlaggedItem>,
}

/// The state of an in-worktree conflict resolution, for the Conflicts tab. The
/// `flagged` list is built from git's unmerged set (the source of truth for what
/// still needs deciding) joined to the agent's reasons — so an agent that
/// under-reports can't hide an unresolved file. `resolved` echoes the agent's
/// report for display.
#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct Resolution {
    merge_in_progress: bool,
    unmerged: Vec<String>,
    flagged: Vec<FlaggedItem>,
    resolved: Vec<ResolvedItem>,
    has_report: bool,
}

#[tauri::command(async)]
fn read_resolution(worktree: String) -> Result<Resolution, String> {
    let merge_in_progress = Command::new("git")
        .args(["-C", &worktree, "rev-parse", "-q", "--verify", "MERGE_HEAD"])
        .output()
        .map(|o| o.status.success())
        .unwrap_or(false);

    let unmerged: Vec<String> = Command::new("git")
        .args(["-C", &worktree, "diff", "--name-only", "--diff-filter=U"])
        .output()
        .map(|o| {
            String::from_utf8_lossy(&o.stdout)
                .lines()
                .map(|l| l.trim().to_string())
                .filter(|l| !l.is_empty())
                .collect()
        })
        .unwrap_or_default();

    let report: Option<Report> =
        std::fs::read_to_string(Path::new(&worktree).join(".task").join("resolution.json"))
            .ok()
            .and_then(|t| serde_json::from_str(&t).ok());

    // Authoritative flagged list = each still-unmerged file, annotated with the
    // agent's reason when it gave one.
    let flagged: Vec<FlaggedItem> = unmerged
        .iter()
        .map(|f| {
            let reason = report
                .as_ref()
                .and_then(|r| r.flagged.iter().find(|x| &x.file == f))
                .map(|x| x.reason.clone())
                .unwrap_or_default();
            FlaggedItem {
                file: f.clone(),
                reason,
            }
        })
        .collect();
    let resolved = report.as_ref().map(|r| r.resolved.clone()).unwrap_or_default();

    Ok(Resolution {
        merge_in_progress,
        unmerged,
        flagged,
        resolved,
        has_report: report.is_some(),
    })
}

/// A committed conflict resolution, summarized for the ready/Conflicts tab.
/// `resolved` is true only when the worktree HEAD is a merge that pulled main in
/// AND there were manual edits to resolve it; `patch` is those edits as a
/// standard unified diff (the lines kept/removed by the resolution).
#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct ResolutionSummary {
    resolved: bool,
    patch: String,
}

#[tauri::command(async)]
fn resolution_summary(worktree: String, main_branch: String) -> Result<ResolutionSummary, String> {
    // Is HEAD a merge commit (>1 parent) that merged main in? That's the shape of
    // a conflict-resolution merge done in the worktree before approve.
    let parents = Command::new("git")
        .args(["-C", &worktree, "rev-list", "--parents", "-n", "1", "HEAD"])
        .output()
        .map_err(|e| format!("git rev-list: {e}"))?;
    let is_merge = String::from_utf8_lossy(&parents.stdout)
        .split_whitespace()
        .count()
        > 2;
    let main_merged = Command::new("git")
        .args(["-C", &worktree, "merge-base", "--is-ancestor", &main_branch, "HEAD"])
        .status()
        .map(|s| s.success())
        .unwrap_or(false);
    if !is_merge || !main_merged {
        return Ok(ResolutionSummary { resolved: false, patch: String::new() });
    }

    // The resolution edits as a standard unified diff: `--remerge-diff` (result vs
    // the mechanical re-merge) shows exactly what the resolver changed. Fall back
    // to the combined diff on git too old to know it.
    let patch = ["--remerge-diff", "--cc"]
        .into_iter()
        .find_map(|mode| {
            Command::new("git")
                .args(["-C", &worktree, "show", mode, "--format=", "HEAD"])
                .output()
                .ok()
                .filter(|o| o.status.success())
                .map(|o| String::from_utf8_lossy(&o.stdout).into_owned())
                .filter(|s| !s.trim().is_empty())
        })
        .unwrap_or_default();

    Ok(ResolutionSummary { resolved: !patch.trim().is_empty(), patch })
}

/// One conflicted file's three sides, for the editable merge editor: `ours` (the
/// ticket branch, stage 2), `theirs` (main, stage 3), and `merged` (the current
/// working file, still carrying conflict markers — the editor's starting point).
#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct ConflictFile {
    ours: String,
    theirs: String,
    merged: String,
    language: String,
}

#[tauri::command(async)]
fn read_conflict_file(worktree: String, path: String) -> Result<ConflictFile, String> {
    let stage = |n: u8| -> String {
        Command::new("git")
            .args(["-C", &worktree, "show", &format!(":{n}:{path}")])
            .output()
            .map(|o| String::from_utf8_lossy(&o.stdout).into_owned())
            .unwrap_or_default()
    };
    let merged = std::fs::read_to_string(Path::new(&worktree).join(&path)).unwrap_or_default();
    Ok(ConflictFile {
        ours: stage(2),
        theirs: stage(3),
        merged,
        language: language_for(&path),
    })
}

/// Write a human-resolved file back and stage it (`git add`). The bounded write
/// side of the otherwise read-only Review surface — only ever a file that is
/// mid-merge, and the result still passes through `human-qa approve`.
#[tauri::command]
fn write_resolved_file(worktree: String, path: String, content: String) -> Result<(), String> {
    std::fs::write(Path::new(&worktree).join(&path), content)
        .map_err(|e| format!("write {path}: {e}"))?;
    let st = Command::new("git")
        .args(["-C", &worktree, "add", "--", &path])
        .status()
        .map_err(|e| format!("git add: {e}"))?;
    if !st.success() {
        return Err(format!("git add {path} failed"));
    }
    Ok(())
}

/// Complete an in-worktree resolution merge by committing it. Guarded: refuses
/// while any file is still unmerged, or when no merge is underway.
#[tauri::command(async)]
fn commit_resolution(worktree: String) -> Result<(), String> {
    let unmerged = Command::new("git")
        .args(["-C", &worktree, "diff", "--name-only", "--diff-filter=U"])
        .output()
        .map(|o| !o.stdout.is_empty())
        .unwrap_or(false);
    if unmerged {
        return Err("some files are still unresolved — resolve them first".into());
    }
    let merging = Command::new("git")
        .args(["-C", &worktree, "rev-parse", "-q", "--verify", "MERGE_HEAD"])
        .output()
        .map(|o| o.status.success())
        .unwrap_or(false);
    if !merging {
        return Err("no merge in progress in this worktree".into());
    }
    let out = Command::new("git")
        .args(["-C", &worktree, "commit", "--no-edit"])
        .output()
        .map_err(|e| format!("git commit: {e}"))?;
    if !out.status.success() {
        return Err(String::from_utf8_lossy(&out.stderr).trim().to_string());
    }
    Ok(())
}

/// Open a file in the user's GUI editor — an escape hatch out of the read-only
/// viewer. Tries VS Code, then the platform opener. Fire-and-forget.
#[tauri::command(async)]
fn open_in_editor(path: String) -> Result<(), String> {
    // Prefer VS Code (opens source files sensibly); fall back to the OS opener.
    if Command::new("code").arg(&path).spawn().is_ok() {
        return Ok(());
    }
    let opener = if cfg!(target_os = "macos") { "open" } else { "xdg-open" };
    Command::new(opener)
        .arg(&path)
        .spawn()
        .map(|_| ())
        .map_err(|e| format!("cannot open {path}: {e}"))
}

/// Reveal a path in the platform file manager — the Review header escape hatch.
/// On macOS `open -R` selects it in Finder; elsewhere we open the path (a
/// directory opens in the file manager). Fire-and-forget.
#[tauri::command(async)]
fn reveal_in_finder(path: String) -> Result<(), String> {
    let mut cmd = if cfg!(target_os = "macos") {
        let mut c = Command::new("open");
        c.args(["-R", &path]);
        c
    } else {
        let mut c = Command::new("xdg-open");
        c.arg(&path);
        c
    };
    cmd.spawn()
        .map(|_| ())
        .map_err(|e| format!("cannot reveal {path}: {e}"))
}

/// Open a folder via the OS "open with…" application picker — the Review header
/// escape hatch. On macOS this is AppleScript's native `choose application`
/// dialog, then `open -a <chosen>`; on Linux it falls back to `mimeopen --ask`
/// if present, else the default opener. The picker is interactive, so we spawn
/// and return immediately (the script does the open once the user picks).
#[tauri::command(async)]
fn open_folder_with(path: String) -> Result<(), String> {
    if cfg!(target_os = "macos") {
        let esc = path.replace('\\', "\\\\").replace('"', "\\\"");
        let script = format!(
            "set p to \"{esc}\"\n\
             set theApp to choose application with prompt \"Open folder with…\"\n\
             do shell script \"open -a \" & quoted form of (name of theApp as text) & \" \" & quoted form of p"
        );
        return Command::new("osascript")
            .arg("-e")
            .arg(script)
            .spawn()
            .map(|_| ())
            .map_err(|e| format!("open-with: {e}"));
    }
    // Linux: mimeopen's chooser if available, otherwise the default opener.
    if Command::new("mimeopen").args(["--ask", &path]).spawn().is_ok() {
        return Ok(());
    }
    Command::new("xdg-open")
        .arg(&path)
        .spawn()
        .map(|_| ())
        .map_err(|e| format!("open-with: {e}"))
}

/// The Review rail needs, per pending-human-qa ticket, a human title and a
/// coarse merge badge — so the human can sequence the clean merges first and
/// batch the conflicted ones without opening each. `title` is the first content
/// line of the worktree's `.task/brief.md`; `badge` is one of
/// `clean` / `conflicts` / `resolving` / `flagged`.
#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct RailCard {
    worktree: String,
    title: String,
    badge: String,
}

/// A worktree's ticket title (for the Agents rail), keyed by worktree path.
#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct WorktreeTitle {
    worktree: String,
    title: String,
}

/// Batch ticket titles for a set of worktrees — the Agents list needs a title per
/// agent without the merge-badge work that `rail_status` does.
#[tauri::command(async)]
fn brief_titles(worktrees: Vec<String>) -> Vec<WorktreeTitle> {
    worktrees
        .into_iter()
        .map(|worktree| WorktreeTitle {
            title: brief_title(&worktree),
            worktree,
        })
        .collect()
}

/// The ticket title from a worktree's brief — its first `# ` heading.
fn brief_title(worktree: &str) -> String {
    title_from_brief(&Path::new(worktree).join(".task").join("brief.md"))
}

/// The ticket title: text of the brief's first `# ` heading — matching the GUI
/// detail panel's `parseBrief`, so the list rows, Agents cards, and Review rail
/// all show the same title the panel does. Works for both an active ticket's
/// worktree `.task/brief.md` and a queued ticket's `.iudex/queue/tN.md` (same
/// format; the queue file becomes the brief).
fn title_from_brief(path: &Path) -> String {
    let text = std::fs::read_to_string(path).unwrap_or_default();
    for line in text.lines() {
        if let Some(rest) = line.strip_prefix("# ") {
            return rest.trim().to_string();
        }
    }
    String::new()
}

/// A ticket's human title, keyed by ticket id (e.g. `t3`).
#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct TicketTitle {
    id: String,
    title: String,
}

/// Titles for every ticket the workspace can show one for, keyed by id. Active
/// (and later) tickets read their worktree `.task/brief.md`; queued tickets have
/// no worktree yet, so they read `.iudex/queue/tN.md`. The worktree brief wins
/// when both exist. Lets the GUI label queued tickets, which have no worktree.
#[tauri::command(async)]
fn ticket_titles(root: String) -> Vec<TicketTitle> {
    let iudex = Path::new(&root).join(".iudex");
    let mut out: Vec<TicketTitle> = Vec::new();

    // Active+: .iudex/worktrees/tN/.task/brief.md
    if let Ok(entries) = std::fs::read_dir(iudex.join("worktrees")) {
        for e in entries.flatten() {
            let id = e.file_name().to_string_lossy().to_string();
            let title = title_from_brief(&e.path().join(".task").join("brief.md"));
            if !title.is_empty() {
                out.push(TicketTitle { id, title });
            }
        }
    }

    // Queued: .iudex/queue/tN.md (skip ids already resolved from a worktree).
    if let Ok(entries) = std::fs::read_dir(iudex.join("queue")) {
        for e in entries.flatten() {
            let name = e.file_name().to_string_lossy().to_string();
            let Some(id) = name.strip_suffix(".md") else { continue };
            if out.iter().any(|t| t.id == id) {
                continue;
            }
            let title = title_from_brief(&e.path());
            if !title.is_empty() {
                out.push(TicketTitle {
                    id: id.to_string(),
                    title,
                });
            }
        }
    }

    out
}

#[tauri::command(async)]
fn rail_status(
    root: String,
    main_branch: String,
    worktrees: Vec<String>,
) -> Result<Vec<RailCard>, String> {
    let mut out = Vec::with_capacity(worktrees.len());
    for worktree in worktrees {
        let title = brief_title(&worktree);
        // A merge already underway in the worktree wins the badge outright.
        let merging = Command::new("git")
            .args(["-C", &worktree, "rev-parse", "-q", "--verify", "MERGE_HEAD"])
            .output()
            .map(|o| o.status.success())
            .unwrap_or(false);
        let badge = if merging {
            // A merge in progress is "resolving" while an agent works, but flips
            // to "flagged" (your turn) once the resolver has left a file for
            // human judgment — mirroring the frontend's flagged derivation.
            // Requires BOTH still-unmerged files (git's truth) AND a flagged
            // report entry with a reason, so a fully-resolved-but-uncommitted
            // merge reads "resolving", not "flagged". Coarse by design: no tmux
            // here, so a crash-before-report card still reads "resolving".
            let has_unmerged = Command::new("git")
                .args(["-C", &worktree, "diff", "--name-only", "--diff-filter=U"])
                .output()
                .map(|o| !o.stdout.is_empty())
                .unwrap_or(false);
            let flagged_report = std::fs::read_to_string(
                Path::new(&worktree).join(".task").join("resolution.json"),
            )
            .ok()
            .and_then(|t| serde_json::from_str::<Report>(&t).ok())
            .map(|r| r.flagged.iter().any(|f| !f.reason.is_empty()))
            .unwrap_or(false);
            if has_unmerged && flagged_report {
                "flagged"
            } else {
                "resolving"
            }
        } else {
            let work_branch = Command::new("git")
                .args(["-C", &worktree, "rev-parse", "--abbrev-ref", "HEAD"])
                .output()
                .map(|o| String::from_utf8_lossy(&o.stdout).trim().to_string())
                .unwrap_or_default();
            // Same zero-side-effect prediction as merge_preflight's gate 3.
            let conflict = Command::new("git")
                .args([
                    "-C",
                    &root,
                    "merge-tree",
                    "--write-tree",
                    "-z",
                    "--name-only",
                    &main_branch,
                    &work_branch,
                ])
                .output()
                .map(|o| !o.status.success())
                .unwrap_or(false);
            if conflict {
                "conflicts"
            } else {
                "clean"
            }
        }
        .to_string();
        out.push(RailCard {
            worktree,
            title,
            badge,
        });
    }
    Ok(out)
}

/// Watch `<root>/.iudex/` and emit `events-changed` whenever events.jsonl is
/// touched. The frontend treats this purely as a doorbell and re-reads status;
/// it is never the source of data. Watching the directory (not the file) keeps
/// working even when the log is atomically replaced.
#[tauri::command]
fn watch_workspace(
    root: String,
    app: AppHandle,
    state: State<WatcherState>,
) -> Result<(), String> {
    let iudex_dir = Path::new(&root).join(".iudex");
    let app = app.clone();
    let mut watcher =
        notify::recommended_watcher(move |res: notify::Result<notify::Event>| {
            let Ok(ev) = res else { return };
            if !matches!(
                ev.kind,
                EventKind::Modify(_) | EventKind::Create(_) | EventKind::Remove(_)
            ) {
                return;
            }
            let touched_log = ev
                .paths
                .iter()
                .any(|p| p.file_name().is_some_and(|n| n == "events.jsonl"));
            if touched_log {
                let _ = app.emit("events-changed", ());
            }
        })
        .map_err(|e| e.to_string())?;
    watcher
        .watch(&iudex_dir, RecursiveMode::NonRecursive)
        .map_err(|e| format!("cannot watch {}: {e}", iudex_dir.display()))?;
    // Keep the watcher alive for the life of the app.
    *state.0.lock().unwrap() = Some(watcher);
    Ok(())
}

/// Set once the user confirms the quit prompt, so the follow-up `app.exit(0)`
/// (which re-enters ExitRequested) is allowed straight through instead of
/// re-prompting into a loop.
static EXIT_CONFIRMED: std::sync::atomic::AtomicBool = std::sync::atomic::AtomicBool::new(false);

/// Payload for the `quit-requested` event: how many live sessions the quit
/// would tear down, so the frontend modal can name the stakes.
#[derive(Clone, serde::Serialize)]
struct QuitGuard {
    agents: u32,
    shells: u32,
}

/// The quit guard only fires when quitting would actually destroy work: the
/// kill-pool-on-exit pref is on AND the pool has live sessions. Returns the
/// counts to prompt with, or None to let the quit proceed unguarded (already
/// confirmed, pool kept detached, or nothing running).
fn quit_would_kill_sessions(app: &AppHandle) -> Option<QuitGuard> {
    if EXIT_CONFIRMED.load(std::sync::atomic::Ordering::SeqCst) {
        return None;
    }
    if !read_kill_pool_on_exit(app) {
        return None;
    }
    let (agents, shells) = tmux::pool_summary();
    if agents + shells == 0 {
        return None;
    }
    Some(QuitGuard { agents, shells })
}

/// Frontend calls this when the user confirms the quit prompt: mark confirmed
/// and exit for real (which runs the RunEvent::Exit pool teardown).
#[tauri::command]
fn confirm_quit(app: AppHandle) {
    EXIT_CONFIRMED.store(true, std::sync::atomic::Ordering::SeqCst);
    app.exit(0);
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .manage(WatcherState::default())
        .manage(tmux::PtyState::default())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        // Window close button (and Cmd+W): if quitting would tear down live
        // sessions, veto the close and hand off to the frontend confirm modal.
        .on_window_event(|window, event| {
            if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                let app = window.app_handle();
                if let Some(guard) = quit_would_kill_sessions(app) {
                    api.prevent_close();
                    let _ = app.emit("quit-requested", guard);
                }
            }
        })
        .setup(|app| {
            // Load the saved iudex binary path before any command can run.
            load_iudex_override(app.handle());
            // Keep ~/.iudex/bin/iudex current with the bundled CLI (tmux
            // sessions and the Install-CLI symlink resolve through it).
            sync_managed_cli();
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            check_iudex,
            get_iudex_settings,
            set_iudex_bin,
            cli_install_status,
            install_cli,
            get_kill_pool_on_exit,
            set_kill_pool_on_exit,
            get_retire_grace_minutes,
            set_retire_grace_minutes,
            confirm_quit,
            get_sequential,
            set_sequential,
            get_resume_nudge,
            set_resume_nudge,
            reset_worktree,
            discover_workspace,
            init_workspace,
            read_config,
            write_config,
            read_agent_config,
            write_agent_config,
            read_prompt,
            write_prompt,
            read_prd,
            list_prds,
            iudex_status,
            run_iudex,
            recent_events,
            compose_ticket,
            list_worktrees,
            worktree_changes,
            worktree_file_diff,
            list_tree,
            read_file,
            read_queue_brief,
            write_queue_brief,
            worktree_task_docs,
            worktree_dirty_count,
            remove_worktree,
            list_archives,
            read_archive,
            merge_preflight,
            begin_resolution,
            abort_resolution,
            read_resolution,
            resolution_summary,
            read_conflict_file,
            write_resolved_file,
            commit_resolution,
            open_in_editor,
            reveal_in_finder,
            open_folder_with,
            rail_status,
            brief_titles,
            ticket_titles,
            watch_workspace,
            tmux::tmux_available,
            tmux::tmux_setup_status,
            tmux::install_tmux,
            tmux::spawn_agent,
            tmux::spawn_idea,
            tmux::spawn_resolver,
            tmux::clear_finished,
            tmux::session_status,
            tmux::session_statuses,
            tmux::list_sessions,
            tmux::create_shell,
            tmux::kill_session,
            tmux::resume_agent,
            tmux::set_retire_at,
            tmux::clear_retire,
            tmux::capture_pane,
            tmux::open_terminal,
            tmux::write_terminal,
            tmux::resize_terminal,
            tmux::close_terminal,
            tmux::next_terminal_id
        ])
        .build(tauri::generate_context!())
        .expect("error while building tauri application")
        .run(|app, event| match event {
            // Cmd+Q / menu-Quit: same guard as the close button. Veto the exit
            // and prompt via the frontend; confirm_quit re-enters here with
            // EXIT_CONFIRMED set, so the guard returns None and the quit lands.
            tauri::RunEvent::ExitRequested { api, .. } => {
                if let Some(guard) = quit_would_kill_sessions(app) {
                    api.prevent_exit();
                    let _ = app.emit("quit-requested", guard);
                }
            }
            // On full quit, tear down the whole iudex tmux pool unless the user
            // opted to keep agents/shells running detached (gui_kill_pool_on_exit,
            // default on). Workspace switches never reach here, so those sessions
            // keep running and reappear on return regardless. See Decision #2 in
            // .context/prd/gui-ux-fixes.md.
            tauri::RunEvent::Exit => {
                if read_kill_pool_on_exit(app) {
                    tmux::kill_pool();
                }
            }
            _ => {}
        });
}

#[cfg(test)]
mod tests {
    use super::*;

    // apply_agent_config's YAML surgery is the part still owned by the GUI (the
    // read side + role->command resolution now come from the CLI). Assert it
    // renders the new agent blocks, preserves every other key + its comments, and
    // drops the legacy single `agent_command`.
    #[test]
    fn apply_agent_config_preserves_other_keys() {
        let cfg = "# header comment\n\
main_branch: main\n\
max_active: 4\n\
\n\
# agent comment a\n\
# agent comment b\n\
agent_command: pi\n\
\n\
# merge comment\n\
merge_strategy: no-ff\n\
branch_prefix: \"work/\"\n";

        let new = AgentSettings {
            commands: vec![
                AgentCmd { name: "pi".into(), command: "pi".into(), default: true },
                AgentCmd { name: "claude".into(), command: "claude --x".into(), default: false },
            ],
            roles: std::collections::BTreeMap::from([("qa".to_string(), "claude".to_string())]),
        };
        let text = apply_agent_config(cfg, &new);

        // Unrelated keys + comments survive the surgery.
        assert!(text.contains("main_branch: main"));
        assert!(text.contains("# merge comment"));
        assert!(text.contains("merge_strategy: no-ff"));
        assert!(text.contains("branch_prefix:"));
        // The new pool + role blocks are rendered.
        assert!(text.contains("agent_commands:"));
        assert!(text.contains("name: \"claude\""));
        assert!(text.contains("default: true"));
        assert!(text.contains("agent_roles:"));
        assert!(text.contains("qa: \"claude\""));
        // The legacy single key is gone (agent_commands: is a different key).
        assert!(!text.contains("agent_command: pi"));
    }

    // A fresh global config (empty input) renders just the agent section, with no
    // leading blank line.
    #[test]
    fn apply_agent_config_on_empty_starts_clean() {
        let new = AgentSettings {
            commands: vec![AgentCmd {
                name: "claude".into(),
                command: "claude".into(),
                default: true,
            }],
            roles: std::collections::BTreeMap::new(),
        };
        let text = apply_agent_config("", &new);
        assert!(!text.starts_with('\n'), "no leading blank line: {text:?}");
        assert!(text.contains("agent_commands:"));
        assert!(text.contains("name: \"claude\""));
    }

    // The GUI reads/writes its one config.yml key (iudex_bin) line-based; assert
    // round-tripping, quoting, removal, and that it leaves the agent blocks alone.
    #[test]
    fn yaml_scalar_reads_top_level_quoted_and_bare() {
        let text = "iudex_bin: \"/opt/iudex\"\nmax_active: 4\n";
        assert_eq!(yaml_scalar(text, "iudex_bin").as_deref(), Some("/opt/iudex"));
        let bare = "iudex_bin: /usr/bin/iudex\n";
        assert_eq!(yaml_scalar(bare, "iudex_bin").as_deref(), Some("/usr/bin/iudex"));
        assert_eq!(yaml_scalar("max_active: 4\n", "iudex_bin"), None);
        // A nested/indented key must not match the top-level lookup.
        assert_eq!(yaml_scalar("agent_roles:\n  iudex_bin: x\n", "iudex_bin"), None);
    }

    #[test]
    fn yaml_upsert_scalar_sets_replaces_removes_preserving_rest() {
        let base = "agent_commands:\n  - name: \"claude\"\n    command: \"claude\"\n    default: true\n";
        // Insert (append) — agent block preserved.
        let with = yaml_upsert_scalar(base, "iudex_bin", Some("/opt/iudex"));
        assert!(with.contains("agent_commands:"));
        assert_eq!(yaml_scalar(&with, "iudex_bin").as_deref(), Some("/opt/iudex"));
        // Replace in place.
        let repl = yaml_upsert_scalar(&with, "iudex_bin", Some("/usr/bin/iudex"));
        assert_eq!(yaml_scalar(&repl, "iudex_bin").as_deref(), Some("/usr/bin/iudex"));
        assert_eq!(repl.matches("iudex_bin:").count(), 1);
        // Remove — key gone, agent block intact.
        let gone = yaml_upsert_scalar(&repl, "iudex_bin", None);
        assert_eq!(yaml_scalar(&gone, "iudex_bin"), None);
        assert!(gone.contains("agent_commands:"));
    }
}
