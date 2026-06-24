import s from "./DiffPatch.module.scss";

// Render a unified diff/patch with per-line coloring (not a Monaco diff — the
// source is a patch string, e.g. an archived diff.patch or a merge-resolution
// `git show` patch). Shared by the Archive view and Review's ready summary.
export default function DiffPatch({ text }: { text: string }) {
  if (!text.trim()) return <div className={s.empty}>(no diff)</div>;
  return (
    <div className={s.patch}>
      {text.split("\n").map((line, i) => {
        const cls =
          line.startsWith("+") && !line.startsWith("+++")
            ? s.add
            : line.startsWith("-") && !line.startsWith("---")
              ? s.del
              : line.startsWith("@@")
                ? s.hunk
                : line.startsWith("diff ") ||
                    line.startsWith("index ") ||
                    line.startsWith("+++") ||
                    line.startsWith("---")
                  ? s.meta
                  : undefined;
        return (
          <div key={i} className={cls}>
            {line || " "}
          </div>
        );
      })}
    </div>
  );
}
