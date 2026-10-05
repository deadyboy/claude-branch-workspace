// Attention/permission card (hard gate 7). Renders a pending request the
// runtime surfaced (currently only the Playwright fake emits
// permission.requested / attention.required — reviewer R2; the live adapter
// runs acceptEdits + interactivePermissions:false so nothing stalls). The card
// responds allow/deny via POST /api/attention/:id/respond.

import { useStore } from "../store/useStore";
import type { AttentionCard as Card } from "../types";

export function AttentionCard({ card }: { card: Card }) {
  const respond = useStore((s) => s.respondAttention);
  return (
    <div className={`attn-card ${card.status}`}>
      <div className="attn-hd">
        <span className="badge attn">{card.kind === "permission" ? "permission" : "attention"}</span>
        <span className="attn-title">{card.title}</span>
        {card.branchId && <span className="tree-id">{card.branchId.slice(0, 4)}</span>}
      </div>
      {card.detail && <div className="attn-detail">{card.detail}</div>}
      {card.status === "pending" ? (
        <div className="attn-actions">
          <button onClick={() => respond(card.id, "allow")}>Allow</button>
          <button className="danger" onClick={() => respond(card.id, "deny")}>
            Deny
          </button>
        </div>
      ) : (
        <div className="attn-answered">Answered: {card.answer ?? "—"}</div>
      )}
    </div>
  );
}
