import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import type { ArchiveDocs, ArchiveEntry } from "../types";
import TabSwitcher from "../components/TabSwitcher";
import DiffPatch from "../components/DiffPatch";
import s from "./Archive.module.scss";

type Tab = "tickets" | "review";

// A record of completed work the live views drop once it leaves the pipeline.
// Two tabs: Tickets (placeholder for now) and Review (merged reviews, read from
// .iudex/archive/<id>/ via list_archives/read_archive). Read-only.
export default function Archive({ root }: { root: string }) {
  const [tab, setTab] = useState<Tab>("review");

  return (
    <div className={s.view}>
      <header className={s.header}>
        <span className={s.headerDot} />
        <span className={s.headerTitle}>Archive</span>
        <TabSwitcher
          tabs={["Tickets", "Review"]}
          value={tab === "tickets" ? "Tickets" : "Review"}
          onChange={(v) => setTab(v === "Tickets" ? "tickets" : "review")}
          style={{ marginLeft: 4 }}
        />
      </header>
      {tab === "review" ? (
        <ArchiveReview root={root} />
      ) : (
        <div className={s.blank}>Archived tickets — coming soon.</div>
      )}
    </div>
  );
}

type DocTab = "brief" | "log" | "review" | "diff";

function ArchiveReview({ root }: { root: string }) {
  const [entries, setEntries] = useState<ArchiveEntry[]>([]);
  const [selId, setSelId] = useState<string | null>(null);
  const [docs, setDocs] = useState<ArchiveDocs | null>(null);
  const [docTab, setDocTab] = useState<DocTab>("diff");
  const [error, setError] = useState<string | null>(null);

  // Merged reviews only (outcome "done"); "removed" tickets are a later tab.
  useEffect(() => {
    let alive = true;
    invoke<ArchiveEntry[]>("list_archives", { root })
      .then((all) => alive && setEntries(all.filter((e) => e.outcome === "done")))
      .catch((e) => alive && setError(String(e)));
    return () => {
      alive = false;
    };
  }, [root]);

  // Default-select the most recent (list is newest-first).
  useEffect(() => {
    if (entries.length === 0) {
      setSelId(null);
      return;
    }
    setSelId((prev) => (entries.some((e) => e.id === prev) ? prev : entries[0].id));
  }, [entries]);

  useEffect(() => {
    if (!selId) {
      setDocs(null);
      return;
    }
    let alive = true;
    invoke<ArchiveDocs>("read_archive", { root, id: selId })
      .then((d) => alive && setDocs(d))
      .catch((e) => alive && setError(String(e)));
    return () => {
      alive = false;
    };
  }, [selId, root]);

  const sel = entries.find((e) => e.id === selId) ?? null;

  if (error) return <div className="error">{error}</div>;
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
            <span className={s.merge}>merged {sel.mergeCommit.slice(0, 7)}</span>
          )}
        </div>

        <nav className={s.doctabs}>
          {(["brief", "log", "review", "diff"] as DocTab[]).map((d) => (
            <button
              key={d}
              className={`${s.doctab} ${docTab === d ? s.active : ""}`}
              onClick={() => setDocTab(d)}
            >
              {d === "review" ? "qa review" : d}
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
