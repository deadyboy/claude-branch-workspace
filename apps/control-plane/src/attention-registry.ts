// In-memory attention/permission-request registry (hard gate 7).
//
// The UI can respond to runtime permission/attention requests WHEN the runtime
// exposes them. The live ClaudeCliAdapter today CANNOT emit
// `permission.requested`/`attention.required` (parseEvent drops them), so the
// registry is real but FAKE-driven in Phase 4: the E2E fake runtime seeds it.
// Gate 7 is satisfied by its OR-clause anyway: the adapter runs acceptEdits +
// `interactivePermissions:false` (no-interactive-permission mode proven), so
// the loop never stalls. If a future profile enables interactive permissions,
// the same registry serves live requests.
//
// Honesty (reviewer R2): CAPABILITIES reports `interactivePermissions:false`;
// docs note the attention UI path is real but seeded only by the fake.

import { randomUUID } from "node:crypto";

export interface AttentionCard {
  attentionId: string;
  branchId: string | null;
  projectId: string | null;
  type: "permission" | "question" | "task";
  requestText: string;
  status: "pending" | "answered";
  answer: "allow" | "deny" | null;
  createdAt: string;
  answeredAt: string | null;
}

export type AttentionPhase = "pending" | "answered";

export class AttentionRegistry {
  private cards = new Map<string, AttentionCard>();

  add(input: {
    branchId?: string | null;
    projectId?: string | null;
    type?: AttentionCard["type"];
    requestText: string;
  }): AttentionCard {
    const card: AttentionCard = {
      attentionId: `atn-${randomUUID()}`,
      branchId: input.branchId ?? null,
      projectId: input.projectId ?? null,
      type: input.type ?? "permission",
      requestText: input.requestText,
      status: "pending",
      answer: null,
      createdAt: new Date().toISOString(),
      answeredAt: null,
    };
    this.cards.set(card.attentionId, card);
    return card;
  }

  list(status?: "pending" | "answered"): AttentionCard[] {
    const all = [...this.cards.values()].sort((a, b) => a.createdAt.localeCompare(b.createdAt));
    return status ? all.filter((c) => c.status === status) : all;
  }

  get(attentionId: string): AttentionCard | null {
    return this.cards.get(attentionId) ?? null;
  }

  respond(attentionId: string, answer: "allow" | "deny"): AttentionCard | null {
    const c = this.cards.get(attentionId);
    if (!c) return null;
    if (c.status === "answered") return c; // idempotent
    c.status = "answered";
    c.answer = answer;
    c.answeredAt = new Date().toISOString();
    return c;
  }

  /**
   * Subscribe to an EventBus once so every runner's streamed canonical event
   * seeds a card here (the TurnObserver stamps projectId/branchId before
   * publish). This is the exact production wiring — index.ts calls it; giving
   * tests the same entry keeps the seed path honest (bus → registry → REST).
   */
  subscribeToBus(bus: { subscribe: (fn: (ev: { type: string; payload?: Record<string, unknown>; branchId?: string | null; projectId?: string | null }) => void) => void }): void {
    bus.subscribe((ev) => {
      if (ev.type === "permission.requested" || ev.type === "attention.required") {
        this.seedFromEvent(ev as Parameters<typeof this.seedFromEvent>[0]);
      }
    });
  }

  /**
   * Seed a card from a streamed canonical event (permission.requested or
   * attention.required). Returns the card, or null if the event type isn't one
   * that opens a card. (Only redacted payloads reach here — never raw secrets.)
   */
  seedFromEvent(ev: {
    type: string;
    payload: { attentionId?: unknown; branchId?: unknown; text?: unknown; requestText?: unknown; permission?: unknown; summary?: unknown; message?: unknown };
    branchId?: string | null;
    projectId?: string | null;
  }): AttentionCard | null {
    if (ev.type !== "permission.requested" && ev.type !== "attention.required") return null;
    const textRaw =
      ev.payload.requestText ??
      ev.payload.text ??
      ev.payload.permission ??
      ev.payload.summary ??
      ev.payload.message ??
      null;
    const requestText = typeof textRaw === "string" ? textRaw : "Permission requested";
    return this.add({
      branchId: ev.branchId ?? null,
      projectId: ev.projectId ?? null,
      type: ev.type === "attention.required" ? "question" : "permission",
      requestText,
    });
  }
}
