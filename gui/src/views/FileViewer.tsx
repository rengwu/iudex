import { type ReactNode } from "react";
import { Editor } from "@monaco-editor/react";
import "../lib/monacoSetup";
import s from "./DiffViewer.module.scss";

// The read-only single-file surface for the "all files" browser — the sibling
// of DiffViewer (reuses its head/body chrome and the shared iudex-light theme).
// One Monaco editor, readOnly, no diff. `title` and `actions` are header slots.
export default function FileViewer({
  content,
  language,
  title,
  actions,
}: {
  content: string;
  language?: string;
  title?: ReactNode;
  actions?: ReactNode;
}) {
  return (
    <div className={s.diff}>
      <div className={s.head}>
        <span className={s.title}>{title}</span>
        <div className={s.headActions}>{actions}</div>
      </div>
      <div className={s.body}>
        <Editor
          value={content}
          language={language || "plaintext"}
          theme="iudex-light"
          options={{
            readOnly: true,
            automaticLayout: true,
            minimap: { enabled: false },
            scrollBeyondLastLine: false,
            fontSize: 11,
            overviewRulerLanes: 0,
            stickyScroll: { enabled: false },
            wordWrap: "off",
          }}
        />
      </div>
    </div>
  );
}
