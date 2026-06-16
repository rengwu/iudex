// iudex GUI backend — the read-path spine.
//
// The GUI holds no authoritative state. It discovers a workspace, reads derived
// truth by shelling out to `iudex status --json`, and watches the workspace's
// events.jsonl as a doorbell: on any change it tells the frontend to re-read.
// All mutations (later) likewise go through the iudex CLI, never reimplemented
// here — the GUI drives iudex the way a git client drives git.

use std::path::Path;
use std::process::Command;
use std::sync::Mutex;

use notify::{EventKind, RecommendedWatcher, RecursiveMode, Watcher};
use tauri::{AppHandle, Emitter, State};

/// Holds the live file watcher so it is not dropped (dropping stops watching).
#[derive(Default)]
struct WatcherState(Mutex<Option<RecommendedWatcher>>);

/// The iudex binary to invoke: $IUDEX_BIN if set, else `iudex` from PATH.
fn iudex_bin() -> String {
    std::env::var("IUDEX_BIN").unwrap_or_else(|_| "iudex".to_string())
}

/// Walk up from `start` looking for `.iudex/config.yml`, returning the workspace
/// root — the same discovery rule the CLI uses (workspace.Find), so it resolves
/// correctly from inside a ticket worktree too.
#[tauri::command]
fn discover_workspace(start: String) -> Result<String, String> {
    let mut dir = std::fs::canonicalize(&start)
        .map_err(|e| format!("cannot resolve {start}: {e}"))?;
    loop {
        if dir.join(".iudex").join("config.yml").is_file() {
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

/// Run `iudex status --json` in `root` and return the parsed JSON. This is the
/// GUI's sole read path; the state machine stays single-sourced in the CLI.
#[tauri::command]
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

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .manage(WatcherState::default())
        .plugin(tauri_plugin_opener::init())
        .invoke_handler(tauri::generate_handler![
            discover_workspace,
            iudex_status,
            watch_workspace
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
