import { Suspense, lazy, useCallback, useEffect, useMemo, useState } from "react";
import * as api from "../lib/api";
import { loadSpec, lintPrd, type LintWarning } from "../lib/spec";
import { VIEWS, type PRD, type Requirement, type SpecDoc } from "../types";
import Badge from "../components/Badge";
import Button from "../components/Button";
import ViewHeader from "../components/ViewHeader";
import s from "./Specifications.module.scss";

// Monaco is heavy; pull it in only when a PRD's raw source is first shown.
const MdViewer = lazy(() => import("./MdViewer"));

// Requirement status → chip colors. Status is intent state, not ticket state, so
// it has its own light-surface palette (active is neutral — the default; parked
// is a muted amber hold; out-of-scope reads dim/struck).
const STATUS_STYLE: Record<string, { bg: string; fg: string; label: string }> = {
  active: { bg: "#bdbdbd", fg: "#2a2a2a", label: "active" },
  parked: { bg: "#e3cf9b", fg: "#5a4a1f", label: "parked" },
  "out-of-scope": { bg: "#c4c4c4", fg: "#7a7a7a", label: "out of scope" },
};

function statusStyle(status: string) {
  return STATUS_STYLE[status] ?? { bg: "#404040", fg: "#cfcfcf", label: status };
}

// Read-only browser for the PRD spec: pick a PRD (left), read its raw markdown in
// Monaco (center), and see the requirements parsed from it (right). Structure is
// parsed in the GUI from the raw markdown (lib/spec.ts — a display concern); the
// raw pane is a plain file read. v1 is structure only — no coverage yet.
export default function Specifications({ root }: { root: string }) {
  const [spec, setSpec] = useState<SpecDoc | null>(null);
  const [selFile, setSelFile] = useState<string | null>(null);
  const [raw, setRaw] = useState<string>("");
  const [err, setErr] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  const load = useCallback(() => {
    setLoading(true);
    loadSpec(root)
      .then((doc) => {
        setSpec(doc);
        setErr(null);
      })
      .catch((e) => setErr(String(e)))
      .finally(() => setLoading(false));
  }, [root]);

  useEffect(() => {
    load();
  }, [load]);

  const prds = useMemo(() => spec?.prds ?? [], [spec]);

  // Default-select the first PRD; keep the selection valid as the list changes.
  useEffect(() => {
    if (prds.length === 0) {
      setSelFile(null);
    } else if (!prds.some((p) => p.file === selFile)) {
      setSelFile(prds[0].file);
    }
  }, [prds, selFile]);

  // Load raw markdown for the selected PRD (the ground-truth source pane).
  useEffect(() => {
    if (!selFile) {
      setRaw("");
      return;
    }
    let alive = true;
    api
      .readPrd(root, selFile)
      .then((c) => alive && setRaw(c))
      .catch((e) => {
        if (alive) {
          setRaw("");
          setErr(String(e));
        }
      });
    return () => {
      alive = false;
    };
  }, [root, selFile]);

  const selected = prds.find((p) => p.file === selFile) ?? null;
  const total = prds.reduce((n, p) => n + p.requirements.length, 0);
  // Lint the ground-truth raw markdown (the same source the parser reads), so
  // format problems surface next to the requirements they'd otherwise mangle.
  const warnings = useMemo(() => (raw ? lintPrd(raw) : []), [raw]);

  return (
    <div className={s.wrap}>
      <ViewHeader
        dot={VIEWS.specifications.dot}
        title="Specifications"
        subtitle={`${prds.length} PRD${prds.length === 1 ? "" : "s"} · ${total} requirement${total === 1 ? "" : "s"}`}
      >
        <Button variant="quiet" onClick={load} disabled={loading} title="Re-read .context/prd">
          {loading ? "Loading…" : "Refresh"}
        </Button>
      </ViewHeader>

      {err && <div className="error">{err}</div>}

      {prds.length === 0 ? (
        // No empty-state hint when errored — the banner above already explains
        // it; don't also imply the dir is just empty.
        !err && (
          <div className={s.empty}>
            No PRDs in <code>.context/prd</code>. Author one with the{" "}
            <code>to-prd</code> skill, then it appears here.
          </div>
        )
      ) : (
        <div className={s.root}>
          <PrdRail
            prds={prds}
            selFile={selFile}
            onSelect={setSelFile}
          />

          <div className={s.source}>
            <div className={s.sourceHead}>
              <span className={s.sourceFile}>{selFile ?? ""}</span>
              <span className={s.sourceMeta}>raw markdown · read-only</span>
            </div>
            <div className={s.sourceBody}>
              {selFile && (
                <Suspense fallback={<div className={s.pending}>Loading editor…</div>}>
                  <MdViewer value={raw} />
                </Suspense>
              )}
            </div>
          </div>

          <RequirementList prd={selected} warnings={warnings} />
        </div>
      )}
    </div>
  );
}

// Left rail: one row per PRD, with its title, file, and a requirement-count
// summary (total, plus any parked / out-of-scope, so gaps in intent show up
// without opening the doc).
function PrdRail({
  prds,
  selFile,
  onSelect,
}: {
  prds: PRD[];
  selFile: string | null;
  onSelect: (file: string) => void;
}) {
  return (
    <div className={s.rail}>
      <div className={s.railHead}>PRDS</div>
      {prds.map((p) => {
        const n = p.requirements.length;
        const parked = p.requirements.filter((r) => r.status === "parked").length;
        const oos = p.requirements.filter((r) => r.status === "out-of-scope").length;
        const extra = [
          parked ? `${parked} parked` : "",
          oos ? `${oos} out` : "",
        ]
          .filter(Boolean)
          .join(" · ");
        return (
          <button
            key={p.file}
            className={`${s.item} ${selFile === p.file ? s.active : ""}`}
            onClick={() => onSelect(p.file)}
          >
            <span className={s.itemTitle}>{p.title || p.file}</span>
            <span className={s.itemFile}>{p.file}</span>
            <span className={s.itemMeta}>
              {n} req{n === 1 ? "" : "s"}
              {extra && <span className={s.itemExtra}> · {extra}</span>}
            </span>
          </button>
        );
      })}
    </div>
  );
}

// Right pane: the requirements parsed from the selected PRD, with any lint
// warnings for its raw source pinned above them. A PRD with no REQ-N headings
// (e.g. a legacy doc) degrades to a note — the raw pane stays the ground truth,
// never blank.
function RequirementList({
  prd,
  warnings,
}: {
  prd: PRD | null;
  warnings: LintWarning[];
}) {
  if (!prd) return <div className={s.reqs} />;
  const lint = warnings.length > 0 && (
    <div className={s.lint}>
      {warnings.map((w, i) => (
        <div key={i} className={s.lintWarn}>
          <b>line {w.line}</b>: {w.message}
        </div>
      ))}
    </div>
  );
  if (prd.requirements.length === 0) {
    return (
      <div className={s.reqs}>
        <div className={s.reqsHead}>REQUIREMENTS</div>
        {lint}
        <div className={s.reqsEmpty}>
          No <code>REQ-N</code> requirements found — raw markdown only.
        </div>
      </div>
    );
  }
  return (
    <div className={s.reqs}>
      <div className={s.reqsHead}>REQUIREMENTS</div>
      {lint}
      <div className={s.reqsList}>
        {prd.requirements.map((r) => (
          <RequirementCard key={r.id} req={r} />
        ))}
      </div>
    </div>
  );
}

function RequirementCard({ req }: { req: Requirement }) {
  const st = statusStyle(req.status);
  const dim = req.status === "out-of-scope";
  return (
    <div className={`${s.req} ${dim ? s.reqDim : ""}`}>
      <div className={s.reqTop}>
        <span className={s.reqId}>{req.id}</span>
        <Badge bg={st.bg} fg={st.fg}>
          {st.label}
        </Badge>
      </div>
      <div className={s.reqTitle}>{req.title}</div>
      {req.body && <div className={s.reqBody}>{req.body}</div>}
    </div>
  );
}
