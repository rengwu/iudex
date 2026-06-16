import type { Ticket, Workspace } from "../types";

// What to show in the trailing "detail" column for a ticket.
function detail(t: Ticket): string {
  if (t.state === "queued") {
    return t.ready ? "ready" : `blocked by ${t.blockedBy.join(", ")}`;
  }
  if (t.hasWorktree && t.worktree) return t.worktree;
  return "";
}

// The reactive tickets table — the read-path spine from step 2, now a view.
// Holds no state of its own; renders whatever the latest status --json gave us.
export default function Tickets({ ws }: { ws: Workspace }) {
  return (
    <table className="tickets">
      <thead>
        <tr>
          <th>id</th>
          <th>state</th>
          <th>qa rejects</th>
          <th>detail</th>
        </tr>
      </thead>
      <tbody>
        {ws.tickets.length === 0 && (
          <tr>
            <td colSpan={4} className="empty">
              no tickets yet
            </td>
          </tr>
        )}
        {ws.tickets.map((t) => (
          <tr key={t.id}>
            <td className="id">{t.id}</td>
            <td>
              <span className={`state state-${t.state}`}>{t.state}</span>
            </td>
            <td className="num">{t.qaRejects || ""}</td>
            <td className="muted">{detail(t)}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}
