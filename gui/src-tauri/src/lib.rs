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

/// Scaffold a non-iudex folder into a workspace by running `iudex init` there
/// (git init + initial commit if it has no history, records the current branch
/// as main_branch, creates `.iudex/`). Offered by the GUI when `discover_workspace`
/// finds no workspace. Returns the canonical root on success.
#[tauri::command]
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
    agent_command: String,
    merge_strategy: String,
    merge_message_template: String,
    branch_prefix: String,
}

fn config_path(root: &str) -> std::path::PathBuf {
    Path::new(root).join(".iudex").join("config.yml")
}

/// Pull a top-level `key: value` scalar from raw YAML, ignoring comment lines and
/// trimming surrounding quotes. Good enough for iudex's flat, scalar config.
fn yaml_scalar<'a>(text: &'a str, key: &str) -> Option<&'a str> {
    for line in text.lines() {
        let t = line.trim_start();
        if t.starts_with('#') {
            continue;
        }
        if let Some(rest) = t.strip_prefix(&format!("{key}:")) {
            return Some(rest.trim().trim_matches('"').trim_matches('\''));
        }
    }
    None
}

#[tauri::command]
fn read_config(root: String) -> Result<Config, String> {
    let text = std::fs::read_to_string(config_path(&root))
        .map_err(|e| format!("read config.yml: {e}"))?;
    let s = |k: &str| yaml_scalar(&text, k).unwrap_or("").to_string();
    let n = |k: &str| yaml_scalar(&text, k).and_then(|v| v.parse::<i64>().ok()).unwrap_or(0);
    Ok(Config {
        main_branch: s("main_branch"),
        max_active: n("max_active"),
        qa_reject_limit: n("qa_reject_limit"),
        agent_command: s("agent_command"),
        merge_strategy: s("merge_strategy"),
        merge_message_template: s("merge_message_template"),
        branch_prefix: s("branch_prefix"),
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
        ("agent_command", q(&config.agent_command)),
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

/// The path for a named prompt template, guarded to the two known prompts.
fn prompt_path(root: &str, name: &str) -> Result<std::path::PathBuf, String> {
    let file = match name {
        "impl" => "impl.md",
        "review" => "review.md",
        _ => return Err(format!("unknown prompt {name:?}")),
    };
    Ok(Path::new(root).join(".iudex").join("prompts").join(file))
}

#[tauri::command]
fn read_prompt(root: String, name: String) -> Result<String, String> {
    let path = prompt_path(&root, &name)?;
    std::fs::read_to_string(&path).map_err(|e| format!("read {}: {e}", path.display()))
}

#[tauri::command]
fn write_prompt(root: String, name: String, content: String) -> Result<(), String> {
    let path = prompt_path(&root, &name)?;
    std::fs::write(&path, content).map_err(|e| format!("write {}: {e}", path.display()))
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

#[tauri::command]
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

#[tauri::command]
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
#[tauri::command]
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
#[tauri::command]
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

#[tauri::command]
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

#[tauri::command]
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
#[tauri::command]
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

/// Reveal a path in the platform file manager — the Review header escape hatch.
/// On macOS `open -R` selects it in Finder; elsewhere we open the path (a
/// directory opens in the file manager). Fire-and-forget.
#[tauri::command]
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
#[tauri::command]
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
/// `clean` / `conflicts` / `resolving`.
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
#[tauri::command]
fn brief_titles(worktrees: Vec<String>) -> Vec<WorktreeTitle> {
    worktrees
        .into_iter()
        .map(|worktree| WorktreeTitle {
            title: brief_title(&worktree),
            worktree,
        })
        .collect()
}

/// First non-empty, non-heading line of a worktree's brief — the ticket title.
fn brief_title(worktree: &str) -> String {
    let text = std::fs::read_to_string(Path::new(worktree).join(".task").join("brief.md"))
        .unwrap_or_default();
    for line in text.lines() {
        let l = line.trim();
        if l.is_empty() || l.starts_with('#') {
            continue;
        }
        return l.to_string();
    }
    String::new()
}

#[tauri::command]
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
            "resolving"
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

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .manage(WatcherState::default())
        .manage(tmux::PtyState::default())
        .plugin(tauri_plugin_opener::init())
        .invoke_handler(tauri::generate_handler![
            discover_workspace,
            init_workspace,
            read_config,
            write_config,
            read_prompt,
            write_prompt,
            iudex_status,
            run_iudex,
            compose_ticket,
            list_worktrees,
            worktree_changes,
            worktree_file_diff,
            read_queue_brief,
            write_queue_brief,
            worktree_task_docs,
            merge_preflight,
            begin_resolution,
            abort_resolution,
            read_resolution,
            read_conflict_file,
            write_resolved_file,
            commit_resolution,
            open_in_editor,
            reveal_in_finder,
            open_folder_with,
            rail_status,
            brief_titles,
            watch_workspace,
            tmux::tmux_available,
            tmux::spawn_agent,
            tmux::spawn_idea,
            tmux::spawn_resolver,
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
