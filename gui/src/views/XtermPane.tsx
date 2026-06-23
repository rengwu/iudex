import { useEffect, useRef } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import "@xterm/xterm/css/xterm.css";
import s from "./XtermPane.module.scss";

// One live, interactive terminal bound to a tmux session through a backend PTY.
// The bridge: backend streams `pty-{id}` events (base64) → xterm.write; xterm
// onData → `write_terminal`. We generate the id up front so we can subscribe
// before any output flows. Unmounting only detaches (close_terminal kills the
// attach client) — the tmux session, and its scrollback, persist.
export default function XtermPane({
  session,
  active,
}: {
  session: string;
  active: boolean;
}) {
  const hostRef = useRef<HTMLDivElement>(null);
  const termRef = useRef<Terminal | null>(null);
  const fitRef = useRef<FitAddon | null>(null);
  const idRef = useRef<string>(crypto.randomUUID());
  const floorFitRef = useRef<() => void>(() => {});

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    const id = idRef.current;

    const term = new Terminal({
      fontFamily: '"IBM Plex Mono", ui-monospace, SFMono-Regular, Menlo, monospace',
      fontSize: 13,
      theme: { background: "#1d1d1d", foreground: "#c9ccd1" },
      cursorBlink: true,
    });
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.open(host);
    fit.fit();
    termRef.current = term;
    fitRef.current = fit;

    const b64ToBytes = (b64: string) =>
      Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));

    let disposed = false;
    const unlisteners: Array<() => void> = [];

    // Size the host to a WHOLE number of rows so the last line never clips.
    // xterm derives its row count from the measured cell height; if the host
    // isn't an exact multiple of that (sub-pixel cell heights, or the IBM Plex
    // Mono webfont loading after the first fit), the bottom row overflows the
    // box. Fit once, read the real cell height, then floor the host to
    // rows*cellHeight (+ padding). The leftover sub-row gap shows the pane's
    // dark background — same color as the terminal, so it's invisible.
    const floorFit = () => {
      if (disposed) return;
      const parent = host.parentElement;
      const avail = parent ? parent.clientHeight : host.clientHeight;
      if (avail <= 0) return; // hidden tab — refloored when it becomes active
      const padY = 12; // host padding: 6px top + 6px bottom
      host.style.height = `${avail}px`;
      try {
        fit.fit();
      } catch {
        return;
      }
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const cell = (term as any)._core?._renderService?.dimensions?.css?.cell?.height;
      if (cell > 0) {
        const rows = Math.max(1, Math.floor((avail - padY) / cell));
        host.style.height = `${Math.round(rows * cell + padY)}px`;
        try {
          fit.fit();
        } catch {
          /* ignore */
        }
      }
      invoke("resize_terminal", { id, cols: term.cols, rows: term.rows }).catch(() => {});
    };
    floorFitRef.current = floorFit;
    // Refloor once the webfont is measured (metrics change after first paint).
    document.fonts?.ready.then(() => requestAnimationFrame(floorFit));

    (async () => {
      // Subscribe first, then start the attach, so the initial screen dump
      // (tmux replays the pane on attach) is never dropped.
      unlisteners.push(
        await listen<string>(`pty-${id}`, (e) =>
          term.write(b64ToBytes(e.payload))
        )
      );
      unlisteners.push(
        await listen(`pty-${id}-exit`, () =>
          term.write("\r\n\x1b[90m[detached]\x1b[0m\r\n")
        )
      );
      if (disposed) return;
      await invoke("open_terminal", {
        id,
        name: session,
        readonly: false,
        cols: term.cols,
        rows: term.rows,
      });
      term.onData((data) => {
        invoke("write_terminal", { id, data }).catch(() => {});
      });
    })();

    // Keep the PTY sized to the pane. Observe the PARENT, not the host —
    // floorFit mutates host.style.height, which would otherwise feed back in.
    const ro = new ResizeObserver(() => floorFit());
    ro.observe(host.parentElement ?? host);

    return () => {
      disposed = true;
      ro.disconnect();
      unlisteners.forEach((u) => u());
      invoke("close_terminal", { id }).catch(() => {});
      term.dispose();
    };
    // Bind once per session; `active` is read live via the ref-held term.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [session]);

  // Refit when this pane becomes the visible tab (fit on a hidden element is a
  // no-op, so a tab that was background needs a nudge on show).
  useEffect(() => {
    if (!active) return;
    const term = termRef.current;
    if (!term) return;
    requestAnimationFrame(() => {
      floorFitRef.current();
      term.focus();
    });
  }, [active]);

  return <div className={s.host} ref={hostRef} />;
}
