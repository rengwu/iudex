import { useEffect, useMemo, useState } from "react";
import * as api from "../lib/api";
import { listen } from "@tauri-apps/api/event";
import type { ArchiveDocs, ArchiveEntry } from "../types";
import { VIEWS } from "../types";
import { stateDot } from "../lib/badges";
import Badge from "../components/Badge";
import Dot from "../components/Dot";
import TabSwitcher from "../components/TabSwitcher";
import DiffPatch from "../components/DiffPatch";
import s from "./Archive.module.scss";

type Tab = "tickets" | "review";

// The archive list with live refresh: re-fetch list_archives whenever
// events.jsonl changes (the same doorbell the rest of the app watches), so a
// ticket merged or removed elsewhere shows up here without leaving the view.
function useArchives(root: string): {
  entries: ArchiveEntry[];
  error: string | null;
} {
  const [entries, setEntries] = useState<ArchiveEntry[]>([]);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    const fetchIt = () =>
      api
        .listArchives(root)
        .then((all) => {
          if (!alive) return;
          setEntries(all);
          setError(null);
        })
        .catch((e) => alive && setError(String(e)));
    fetchIt();
    const un = listen("events-changed", fetchIt);
    return () => {
      alive = false;
      un.then((f) => f());
    };
  }, [root]);

  return { entries, error };
}

// A record of completed work the live views drop once it leaves the pipeline.
// Two tabs: Tickets (the dense archive table, read-only) and Review (merged
// reviews, read from .iudex/archive/<id>/ via list_archives/read_archive).
export default function Archive({ root }: { root: string }) {
  const [tab, setTab] = useState<Tab>("tickets");

  return (
    <div className={s.view}>
      <header className={s.header}>
        <Dot color={VIEWS.archive.dot} size={8} />
        <span className={s.headerTitle}>Archive</span>
        <TabSwitcher
          tabs={[
            { label: "Tickets", value: "tickets" },
            { label: "Review", value: "review" },
          ]}
          value={tab}
          onChange={setTab}
          style={{ marginLeft: 4 }}
        />
      </header>
      {tab === "review" ? (
        <ArchiveReview root={root} />
      ) : (
        <ArchiveTickets root={root} />
      )}
    </div>
  );
}

// Every ticket that left the pipeline — merged ("done") and abandoned
// ("removed") — in the same dense table as the live Tickets view, but read-only
// (no action column, no detail panel). The full record lives in the Review tab.
function ArchiveTickets({ root }: { root: string }) {
  const { entries, error } = useArchives(root);
  const [selId, setSelId] = useState<string | null>(null);

  const sel = selId ? (entries.find((e) => e.id === selId) ?? null) : null;

  if (error) return <div className="error">{error}</div>;
  if (entries.length === 0)
    return <div className={s.empty}>No archived tickets yet.</div>;

  return (
    <div className={s.ticketsBody}>
      <div className={s.ticketsScroll}>
        <div className={s.thead}>
          <div />
          <div>ID</div>
          <div>TITLE</div>
          <div>OUTCOME</div>
          <div className={s.thCenter}>QA</div>
          <div>MERGE</div>
          <div>ARCHIVED</div>
        </div>
        {entries.map((e, i) => {
          const on = e.id === selId;
          return (
            <div
              key={e.id}
              className={s.row}
              onClick={() => setSelId(on ? null : e.id)}
              style={{
                background: on ? "#1f2e90" : i % 2 ? "#969696" : "#9c9c9c",
                color: on ? "#fff" : undefined,
              }}
            >
              <div className={s.rowDot}>
                <Dot color={stateDot(e.outcome)} />
              </div>
              <div
                className={s.cellId}
                style={on ? { color: "#fff" } : undefined}
              >
                {e.id}
              </div>
              <div
                className={s.cellTitle}
                style={on ? { color: "#fff" } : undefined}
              >
                {e.title || "—"}
              </div>
              <div>
                <Badge kind="state" value={e.outcome} />
              </div>
              <div
                className={`${s.cellQa} ${e.qaRejects > 0 ? s.cellQaHot : ""}`}
                style={on ? { color: "#fff" } : undefined}
              >
                {e.qaRejects || ""}
              </div>
              <div
                className={s.cellMerge}
                style={on ? { color: "#cdd2ff" } : undefined}
              >
                {e.mergeCommit ? e.mergeCommit.slice(0, 7) : "—"}
              </div>
              <div
                className={s.cellDate}
                style={on ? { color: "#cdd2ff" } : undefined}
              >
                {fmtDate(e.archivedAt)}
              </div>
            </div>
          );
        })}
      </div>

      {sel && (
        <div className={s.detailPane}>
          <ArchiveTicketDetail
            root={root}
            entry={sel}
            onClose={() => setSelId(null)}
          />
        </div>
      )}
    </div>
  );
}

type ArchiveLogTab = "impl" | "qa";

// Compact, read-only detail for one archived ticket — brief, info, and logs,
// mirroring the live Tickets panel (TicketDetail). The full diff stays in the
// Review tab, so it's deliberately not shown here.
function ArchiveTicketDetail({
  root,
  entry,
  onClose,
}: {
  root: string;
  entry: ArchiveEntry;
  onClose: () => void;
}) {
  const [docs, setDocs] = useState<ArchiveDocs | null>(null);
  const [logTab, setLogTab] = useState<ArchiveLogTab>("impl");
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    setDocs(null);
    api
      .readArchive(root, entry.id)
      .then((d) => alive && setDocs(d))
      .catch((e) => alive && setError(String(e)));
    return () => {
      alive = false;
    };
  }, [entry.id, root]);

  const log = logTab === "impl" ? docs?.log : docs?.review;

  return (
    <div className={s.detail}>
      <div className={s.detailHead}>
        <span className={s.detailId}>{entry.id}</span>
        <Badge kind="state" value={entry.outcome} />
        <span className={s.spacer} />
        <button className={s.detailClose} onClick={onClose} title="close">
          ✕
        </button>
      </div>

      <div className={s.detailTitle}>
        {entry.title || <span className={s.muted}>(no title)</span>}
      </div>

      {error && <div className="error">{error}</div>}

      <div className={s.detailBody}>
        <section className={s.section}>
          <span className={s.sectionLabel}>brief</span>
          {docs == null ? (
            <span className={s.muted}>loading…</span>
          ) : docs.brief.trim() ? (
            <pre className={s.pre}>{docs.brief}</pre>
          ) : (
            <span className={s.muted}>(no brief)</span>
          )}
        </section>

        <section className={s.section}>
          <span className={s.sectionLabel}>info</span>
          <div className={s.kvRows}>
            {entry.deps.length > 0 && (
              <div className={s.kv}>
                <span className={s.kvKey}>deps</span>
                <span className={s.kvVal}>{entry.deps.join(", ")}</span>
              </div>
            )}
            {entry.mergeCommit && (
              <div className={s.kv}>
                <span className={s.kvKey}>merge</span>
                <span className={s.kvVal}>{entry.mergeCommit.slice(0, 7)}</span>
              </div>
            )}
            <div className={s.kv}>
              <span className={s.kvKey}>qa rejects</span>
              <span className={s.kvVal}>{entry.qaRejects}</span>
            </div>
            <div className={s.kv}>
              <span className={s.kvKey}>archived</span>
              <span className={s.kvVal}>{fmtDate(entry.archivedAt)}</span>
            </div>
          </div>
        </section>

        <section className={s.section}>
          <span className={s.sectionLabel}>log</span>
          <TabSwitcher
            tabs={[
              { label: "Implement", value: "impl" },
              { label: "QA", value: "qa" },
            ]}
            value={logTab}
            onChange={(v) => setLogTab(v as ArchiveLogTab)}
            fontSize="11px"
            style={{ alignSelf: "flex-start" }}
          />
          {docs == null ? (
            <span className={s.muted}>loading…</span>
          ) : log?.trim() ? (
            <pre className={s.pre}>{log}</pre>
          ) : (
            <span className={s.muted}>
              {logTab === "impl" ? "(no implementation log)" : "(no qa review)"}
            </span>
          )}
        </section>
      </div>
    </div>
  );
}

type DocTab = "brief" | "log" | "review" | "diff";

function ArchiveReview({ root }: { root: string }) {
  const { entries: all, error } = useArchives(root);
  // Merged reviews only (outcome "done"); removed tickets live in the Tickets tab.
  const entries = useMemo(() => all.filter((e) => e.outcome === "done"), [all]);
  const [selId, setSelId] = useState<string | null>(null);
  const [docs, setDocs] = useState<ArchiveDocs | null>(null);
  const [docTab, setDocTab] = useState<DocTab>("diff");
  const [docErr, setDocErr] = useState<string | null>(null);

  // Default-select the most recent (list is newest-first).
  useEffect(() => {
    if (entries.length === 0) {
      setSelId(null);
      return;
    }
    setSelId((prev) =>
      entries.some((e) => e.id === prev) ? prev : entries[0].id,
    );
  }, [entries]);

  useEffect(() => {
    if (!selId) {
      setDocs(null);
      return;
    }
    let alive = true;
    api
      .readArchive(root, selId)
      .then((d) => alive && setDocs(d))
      .catch((e) => alive && setDocErr(String(e)));
    return () => {
      alive = false;
    };
  }, [selId, root]);

  const sel = entries.find((e) => e.id === selId) ?? null;

  if (error || docErr) return <div className="error">{error || docErr}</div>;
  if (entries.length === 0)
    return <div className={s.empty}>No merged reviews yet.</div>;

  const docText =
    docTab === "brief"
      ? docs?.brief
      : docTab === "log"
        ? docs?.log
        : docTab === "review"
          ? docs?.review
          : "";

  return (
    <div className={s.root}>
      <aside className={s.rail}>
        <div className={s.railHead}>MERGED · {entries.length}</div>
        {entries.map((e) => (
          <button
            key={e.id}
            className={`${s.item} ${e.id === selId ? s.active : ""}`}
            onClick={() => setSelId(e.id)}
          >
            <span className={s.itemTop}>
              <span className={s.itemId}>{e.id}</span>
              <span className={s.itemDate}>{fmtDate(e.archivedAt)}</span>
            </span>
            <span className={s.itemTitle}>{e.title || "—"}</span>
          </button>
        ))}
      </aside>

      <div className={s.main}>
        <div className={s.head}>
          <span className={s.headId}>{sel?.id}</span>
          <span className={s.headName}>{sel?.title}</span>
          <span className={s.spacer} />
          {sel?.mergeCommit && (
            <span className={s.merge}>
              merged {sel.mergeCommit.slice(0, 7)}
            </span>
          )}
        </div>

        <nav className={s.doctabs}>
          {(["brief", "log", "review", "diff"] as DocTab[]).map((d) => (
            <button
              key={d}
              className={`${s.doctab} ${docTab === d ? s.active : ""}`}
              onClick={() => setDocTab(d)}
            >
              {
                {
                  brief: "Ticket Brief",
                  log: "Implementation Log",
                  review: "Agent Review",
                  diff: "Changes",
                }[d]
              }
            </button>
          ))}
        </nav>

        <div className={s.content}>
          {docTab === "diff" ? (
            <DiffPatch text={docs?.diff ?? ""} />
          ) : (
            <pre className={s.doc}>
              {docText?.trim() ? docText : `(no ${docTab})`}
            </pre>
          )}
        </div>
      </div>
    </div>
  );
}

function fmtDate(s: string): string {
  if (!s) return "";
  const d = new Date(s);
  return isNaN(d.getTime()) ? "" : d.toLocaleDateString();
}
