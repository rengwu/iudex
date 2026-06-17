import { useState, type ReactNode } from "react";
import { DiffEditor, loader } from "@monaco-editor/react";
import * as monaco from "monaco-editor";
import editorWorker from "monaco-editor/esm/vs/editor/editor.worker?worker";

// Bundle Monaco locally instead of fetching it from a CDN — this is a desktop
// app that must work offline and under Tauri's CSP. The base editor worker also
// drives the diff computation; we skip the per-language workers (IntelliSense)
// since everything here is read-only. Syntax highlighting is main-thread, so
// colors still work without those workers.
self.MonacoEnvironment = { getWorker: () => new editorWorker() };
loader.config({ monaco });

// The shared read-only diff surface (Worktrees now, Review later). Shows a base
// vs head pair in a Monaco DiffEditor; owns the inline/split toggle. `title` and
// `actions` are optional header slots (e.g. the changed file path + escape-hatch
// buttons).
export default function DiffViewer({
  original,
  modified,
  language,
  title,
  actions,
}: {
  original: string;
  modified: string;
  language?: string;
  title?: ReactNode;
  actions?: ReactNode;
}) {
  const [sideBySide, setSideBySide] = useState(false); // inline by default

  return (
    <div className="diff">
      <div className="diff-head">
        <span className="diff-title">{title}</span>
        <div className="diff-head-actions">
          {actions}
          <div className="seg">
            <button
              className={sideBySide ? "" : "on"}
              onClick={() => setSideBySide(false)}
            >
              inline
            </button>
            <button
              className={sideBySide ? "on" : ""}
              onClick={() => setSideBySide(true)}
            >
              split
            </button>
          </div>
        </div>
      </div>
      <div className="diff-body">
        <DiffEditor
          original={original}
          modified={modified}
          language={language || "plaintext"}
          theme="vs-dark"
          options={{
            readOnly: true,
            renderSideBySide: sideBySide,
            automaticLayout: true,
            minimap: { enabled: false },
            scrollBeyondLastLine: false,
            fontSize: 12,
            renderOverviewRuler: false,
            stickyScroll: { enabled: false },
          }}
        />
      </div>
    </div>
  );
}
