import { useCallback, useEffect, useRef, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import * as api from "./api";
import type { Workspace } from "../types";

// The workspace data layer: open/init a folder, read derived state via
// `iudex status --json`, and re-read on the events.jsonl doorbell. Holds no
// authoritative state of its own — `ws` is always whatever the CLI last reported.
export function useWorkspace() {
  // The last folder picked — retained for initHere even when it's not a
  // workspace yet.
  const [pickedPath, setPickedPath] = useState<string | null>(null);
  const [root, setRoot] = useState<string | null>(null);
  const [ws, setWs] = useState<Workspace | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [offerInit, setOfferInit] = useState(false);
  const [initing, setIniting] = useState(false);
  const [lastSync, setLastSync] = useState<string>("");
  // Serialized form of the last snapshot, so a re-read that changed nothing
  // keeps the same `ws` identity. Everything downstream keys effects on `ws`
  // (agent-status bursts, rail preflights, title refetches…), so replacing it
  // on every steady-cadence poll would refire all of them for no reason.
  const lastJsonRef = useRef<string>("");

  const load = useCallback(async (r: string) => {
    try {
      const data = await api.iudexStatus(r);
      const json = JSON.stringify(data);
      if (json !== lastJsonRef.current) {
        lastJsonRef.current = json;
        setWs(data);
      }
      setError(null);
      setLastSync(new Date().toLocaleTimeString());
    } catch (e) {
      setError(String(e));
    }
  }, []);

  const enter = useCallback(
    async (r: string) => {
      setRoot(r);
      setError(null);
      setOfferInit(false);
      lastJsonRef.current = ""; // new workspace → always publish its snapshot
      await load(r);
      await api.watchWorkspace(r);
    },
    [load],
  );

  const pickAndOpen = useCallback(async () => {
    const selected = await openDialog({ directory: true, multiple: false });
    if (!selected) return;
    const picked = Array.isArray(selected) ? selected[0] : selected;
    setPickedPath(picked);
    setError(null);
    setOfferInit(false);
    try {
      const r = await api.discoverWorkspace(picked);
      await enter(r);
    } catch (e) {
      const msg = String(e);
      setRoot(null);
      setWs(null);
      if (msg.includes("not inside an iudex workspace")) {
        setOfferInit(true);
      } else {
        setError(msg);
      }
    }
  }, [enter]);

  const initHere = useCallback(async () => {
    if (!pickedPath) return;
    setIniting(true);
    try {
      const r = await api.initWorkspace(pickedPath);
      await enter(r);
    } catch (e) {
      setError(String(e));
    } finally {
      setIniting(false);
    }
  }, [pickedPath, enter]);

  // The events.jsonl doorbell: any change → re-read derived state. Trailing
  // debounce: a busy pipeline (agents appending events back-to-back) rings the
  // bell in bursts, and each re-read shells `iudex status --json` — coalesce a
  // burst into one read after it settles.
  useEffect(() => {
    if (!root) return;
    let t: ReturnType<typeof setTimeout> | null = null;
    const un = listen("events-changed", () => {
      if (t !== null) clearTimeout(t);
      t = setTimeout(() => load(root), 250);
    });
    return () => {
      if (t !== null) clearTimeout(t);
      un.then((f) => f());
    };
  }, [root, load]);

  return {
    root,
    ws,
    error,
    setError,
    offerInit,
    initing,
    lastSync,
    pickAndOpen,
    initHere,
    load,
  };
}
