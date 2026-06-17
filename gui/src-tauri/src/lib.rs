// iudex GUI backend — the read-path spine.
//
// The GUI holds no authoritative state. It discovers a workspace, reads derived
// truth by shelling out to `iudex status --json`, and watches the workspace's
// events.jsonl as a doorbell: on any change it tells the frontend to re-read.
// All mutations (later) likewise go through the iudex CLI, never reimplemented
// here — the GUI drives iudex the way a git client drives git.

mod tmux;

use std::path::Path;
use std::process::Command;
use std::sync::Mutex;

use notify::{EventKind, RecommendedWatcher, RecursiveMode, Watcher};
use tauri::{AppHandle, Emitter, State};

/// Holds the live file watcher so it is not dropped (dropping stops watching).
#[derive(Default)]
struct WatcherState(Mutex<Option<RecommendedWatcher>>);

/// The iudex binary to invoke: $IUDEX_BIN if set, else `iudex` from PATH.
pub(crate) fn iudex_bin() -> String {
    std::env::var("IUDEX_BIN").unwrap_or_else(|_| "iudex".to_string())
}

/// Run an arbitrary `iudex` subcommand in the workspace and return its stdout.
/// This is the GUI's write path: every state mutation (activate, finish, qa,
/// human-qa, retry, remove) shells out to the CLI so the state machine stays
/// single-sourced there. The events.jsonl doorbell then refreshes the read
/// path on its own — callers don't re-read explicitly.
#[tauri::command]
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

/// Compose a new ticket from the GUI: allocate the next id (`iudex
/// next-ticket-id`), write the brief to `.iudex/queue/tN.md`, then register it
/// with `iudex queue [--deps …]`. This is the thin native front-of-funnel for
/// trivial manual tickets; the heavier shaping path spawns a skill agent
/// instead. Returns the new ticket id. The doorbell then refreshes the table.
#[tauri::command]
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

    // Build the brief: a title heading (when given) followed by the body.
    let title = title.trim();
    let body = body.trim();
    let content = match (title.is_empty(), body.is_empty()) {
        (false, false) => format!("# {ticket}: {title}\n\n{body}\n"),
        (false, true) => format!("# {ticket}: {title}\n"),
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
#[tauri::command]
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
#[tauri::command]
fn worktree_changes(worktree: String, main_branch: String) -> Result<Vec<FileChange>, String> {
    use std::collections::BTreeMap;

    // name-status: the change letter per path.
    let out = Command::new("git")
        .args(["-C", &worktree, "diff", "--name-status", &main_branch])
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
    if let Ok(out) = Command::new("git")
        .args(["-C", &worktree, "diff", "--numstat", &main_branch])
        .output()
    {
        for line in String::from_utf8_lossy(&out.stdout).lines() {
            let mut cols = line.split('\t');
            let add = cols.next().unwrap_or("-").parse::<u32>().ok();
            let del = cols.next().unwrap_or("-").parse::<u32>().ok();
            if let Some(path) = cols.last() {
                counts.insert(path.to_string(), (add.unwrap_or(0), del.unwrap_or(0)));
            }
        }
    }

    // Untracked files (respecting .gitignore).
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

/// Base vs head content for one file, fed to the Monaco diff viewer. `original`
/// is the file at `main_branch` (empty for an added file); `modified` is the
/// worktree's current working-tree content (empty for a deleted file).
#[derive(serde::Serialize)]
struct FileDiff {
    original: String,
    modified: String,
    language: String,
}

#[tauri::command]
fn worktree_file_diff(
    worktree: String,
    path: String,
    main_branch: String,
) -> Result<FileDiff, String> {
    // Base content from main; absent (added file) → empty, not an error.
    let original = Command::new("git")
        .args(["-C", &worktree, "show", &format!("{main_branch}:{path}")])
        .output()
        .ok()
        .filter(|o| o.status.success())
        .map(|o| String::from_utf8_lossy(&o.stdout).into_owned())
        .unwrap_or_default();

    // Head content from the working tree; absent (deleted file) → empty.
    let modified = std::fs::read_to_string(Path::new(&worktree).join(&path)).unwrap_or_default();

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

/// Open a file in the user's GUI editor — an escape hatch out of the read-only
/// viewer. Tries VS Code, then the platform opener. Fire-and-forget.
#[tauri::command]
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
        .manage(tmux::PtyState::default())
        .plugin(tauri_plugin_opener::init())
        .invoke_handler(tauri::generate_handler![
            discover_workspace,
            iudex_status,
            run_iudex,
            compose_ticket,
            list_worktrees,
            worktree_changes,
            worktree_file_diff,
            open_in_editor,
            watch_workspace,
            tmux::tmux_available,
            tmux::spawn_agent,
            tmux::spawn_idea,
            tmux::clear_finished,
            tmux::session_status,
            tmux::list_sessions,
            tmux::create_shell,
            tmux::kill_session,
            tmux::capture_pane,
            tmux::open_terminal,
            tmux::write_terminal,
            tmux::resize_terminal,
            tmux::close_terminal,
            tmux::next_terminal_id
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
