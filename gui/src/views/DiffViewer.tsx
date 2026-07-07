import { type ReactNode } from "react";
import { DiffEditor } from "@monaco-editor/react";
import "../lib/monacoSetup";
import { useDiffSideBySide } from "../lib/diffView";
import TabSwitcher from "../components/TabSwitcher";
import s from "./DiffViewer.module.scss";

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
  // Persisted globally so the inline/split choice is shared across all diffs.
  const [sideBySide, setSideBySide] = useDiffSideBySide();

  return (
    <div className={s.diff}>
      <div className={s.head}>
        <span className={s.title}>{title}</span>
        <div className={s.headActions}>
          {actions}
          <TabSwitcher
            tabs={[
              { label: "inline", value: false },
              { label: "split", value: true },
            ]}
            value={sideBySide}
            onChange={setSideBySide}
          />
        </div>
      </div>
      <div className={s.body}>
        <DiffEditor
          original={original}
          modified={modified}
          language={language || "plaintext"}
          theme="iudex-light"
          options={{
            readOnly: true,
            renderSideBySide: sideBySide,
            // Monaco auto-collapses split→inline below this width (default 900px);
            // our diff pane is narrower, so disable the fallback to honor the toggle.
            useInlineViewWhenSpaceIsLimited: false,
            renderSideBySideInlineBreakpoint: 0,
            automaticLayout: true,
            minimap: { enabled: false },
            scrollBeyondLastLine: false,
            fontSize: 11,
            renderOverviewRuler: false,
            stickyScroll: { enabled: false },
          }}
        />
      </div>
    </div>
  );
}
