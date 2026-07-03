import { useEffect, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import * as api from "../lib/api";
import Modal from "./Modal";
import Button from "./Button";

// Exit guard. The backend vetoes a quit/close that would tear down live tmux
// sessions (kill-pool-on-exit on + a non-empty pool) and emits `quit-requested`
// with the counts; we confirm here. Mounted once at the root (a sibling of
// <App/>), so it works from every screen — the pool is machine-global. Idle
// quits are never vetoed, so this modal only appears when work is at stake.
type Guard = { agents: number; shells: number };

// "2 agents and 1 shell" — only the non-zero parts, pluralized.
function phrase({ agents, shells }: Guard): string {
  const parts: string[] = [];
  if (agents) parts.push(`${agents} agent${agents === 1 ? "" : "s"}`);
  if (shells) parts.push(`${shells} shell${shells === 1 ? "" : "s"}`);
  return parts.join(" and ");
}

export default function QuitGuard() {
  const [guard, setGuard] = useState<Guard | null>(null);

  useEffect(() => {
    const un = listen<Guard>("quit-requested", (e) => setGuard(e.payload));
    return () => {
      un.then((f) => f());
    };
  }, []);

  if (!guard) return null;

  const running = guard.agents + guard.shells;
  const isAre = running === 1 ? "is" : "are";
  const theyIt = running === 1 ? "It" : "They";

  return (
    <Modal
      title="Quit iudex?"
      onClose={() => setGuard(null)}
      actions={
        <>
          <Button variant="quiet" size="md" onClick={() => setGuard(null)}>
            Cancel
          </Button>
          <Button variant="danger" size="md" onClick={() => api.confirmQuit()}>
            Quit
          </Button>
        </>
      }
    >
      <p>
        {phrase(guard)} {isAre} running. {theyIt} will be terminated when iudex
        quits.
      </p>
    </Modal>
  );
}
