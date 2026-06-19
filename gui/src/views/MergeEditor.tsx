import { useEffect, useState } from "react";
import { DiffEditor, Editor } from "@monaco-editor/react";
import { invoke } from "@tauri-apps/api/core";
import type { ConflictFile } from "../types";
import "../lib/monacoSetup";
import s from "./MergeEditor.module.scss";

const REF_OPTS = {
  readOnly: true,
  renderSideBySide: true,
  automaticLayout: true,
  minimap: { enabled: false },
  scrollBeyondLastLine: false,
  fontSize: 12,
  renderOverviewRuler: false,
  stickyScroll: { enabled: false },
} as const;

const EDIT_OPTS = {
  automaticLayout: true,
  minimap: { enabled: false },
  scrollBeyondLastLine: false,
  fontSize: 12,
  renderOverviewRuler: false,
  stickyScroll: { enabled: false },
} as const;

// A merge marker line: <<<<<<<, |||||||, =======, or >>>>>>>.
const MARKER = /^(<{7}|\|{7}|={7}|>{7})/m;

// One conflict block: <<<<<<< … OURS … (||||||| … BASE …)? ======= … THEIRS … >>>>>>>.
// Captures the ours/theirs hunks so a quick-pick can rewrite just the block,
// leaving the surrounding (non-conflicting) lines untouched.
const CONFLICT = /<{7}[^\n]*\n([\s\S]*?)(?:\n\|{7}[^\n]*\n[\s\S]*?)?\n={7}\n([\s\S]*?)\n>{7}[^\n]*/g;

// Resolve every remaining conflict block in `text` by keeping one side (or both,
// ours-then-theirs). Operates on the current result, so manual edits to other
// hunks are preserved.
function pickHunks(text: string, side: "ours" | "theirs" | "both"): string {
  return text.replace(CONFLICT, (_m, ours: string, theirs: string) =>
    side === "ours" ? ours : side === "theirs" ? theirs : `${ours}\n${theirs}`,
  );
}

// The one bounded editable surface in the otherwise read-only Review: resolve a
// single conflicted file. The top pane is a read-only reference diff (main vs
// this ticket); the bottom pane is the editable result, seeded with the working
// file's conflict markers. Quick-pick buttons replace the result wholesale; the
// user can also edit freely. "Mark resolved" writes + stages the file (it refuses
// while markers remain, so a half-merged file can't be staged).
export default function MergeEditor({
  worktree,
  path,
  busy,
  onResolved,
  onCancel,
}: {
  worktree: string;
  path: string;
  busy: boolean;
  onResolved: () => void;
  onCancel: () => void;
}) {
  const [cf, setCf] = useState<ConflictFile | null>(null);
  const [result, setResult] = useState("");
  const [err, setErr] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    let alive = true;
    setCf(null);
    setErr(null);
    invoke<ConflictFile>("read_conflict_file", { worktree, path })
      .then((c) => {
        if (!alive) return;
        setCf(c);
        setResult(c.merged);
      })
      .catch((e) => alive && setErr(String(e)));
    return () => {
      alive = false;
    };
  }, [worktree, path]);

  const markResolved = async () => {
    setSaving(true);
    setErr(null);
    try {
      await invoke("write_resolved_file", { worktree, path, content: result });
      onResolved();
    } catch (e) {
      setErr(String(e));
    } finally {
      setSaving(false);
    }
  };

  const markersLeft = MARKER.test(result);

  return (
    <div className={s.merge}>
      <div className={s.head}>
        <span className={s.path}>{path}</span>
        <div className={s.actions}>
          <button
            className="esc"
            disabled={!cf}
            onClick={() => setResult((r) => pickHunks(r, "theirs"))}
          >
            Use main
          </button>
          <button
            className="esc"
            disabled={!cf}
            onClick={() => setResult((r) => pickHunks(r, "ours"))}
          >
            Use this ticket
          </button>
          <button
            className="esc"
            disabled={!cf}
            onClick={() => setResult((r) => pickHunks(r, "both"))}
          >
            Use both
          </button>
          <button className="esc" onClick={onCancel}>
            Cancel
          </button>
          <button
            className="go"
            disabled={saving || busy || !cf || markersLeft}
            title={markersLeft ? "remove the conflict markers first" : "stage this resolution"}
            onClick={markResolved}
          >
            {saving ? "…" : "Mark resolved"}
          </button>
        </div>
      </div>
      {err && <div className="error">{err}</div>}
      {markersLeft && (
        <div className={s.warn}>
          ⚠ Conflict markers still present — finish editing the result before marking
          resolved.
        </div>
      )}
      <div className={s.body}>
        <div className={s.pane}>
          <div className={s.label}>reference · main (incoming) ↔ this ticket</div>
          <div className={s.editor}>
            {cf && (
              <DiffEditor
                original={cf.theirs}
                modified={cf.ours}
                language={cf.language}
                theme="vs-dark"
                options={REF_OPTS}
              />
            )}
          </div>
        </div>
        <div className={s.pane}>
          <div className={s.label}>result · editable</div>
          <div className={s.editor}>
            <Editor
              value={result}
              onChange={(v) => setResult(v ?? "")}
              language={cf?.language}
              theme="vs-dark"
              options={EDIT_OPTS}
            />
          </div>
        </div>
      </div>
    </div>
  );
}
