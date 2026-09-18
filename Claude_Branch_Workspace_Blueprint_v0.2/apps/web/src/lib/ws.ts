// WS client (hard gate 8: durable reconnect cursor). Reconnects to the project
// event stream, dedupes the connect-race window with a bounded Set<eventId>,
// watches a monotonic seqRel cursor, and after a reconnect gap-fills via
// POST-less hello + REST catch-up of branches/conversation/agent-runs.
//
// The server NEVER persists an unbounded Set — dedupe is client-side and the
// cursor is project-scoped. Gap-fill recomputes whatever was missed since the
// last acknowledged seqRel, so re-serving the same window across two
// reconnects is idempotent.

import { normalizeEventFrame } from "../api/client";
import type { EventFrame } from "../types";

export interface WsEvents {
  frame: (f: EventFrame) => void;
  status: (s: "connecting" | "open" | "closed") => void;
}

// Max buffered frames of dedupe window; beyond this we assume the client
// refetches (REST catch-up covers full state anyway).
const DEDUPE_LIMIT = 2048;

export class WsStream {
  private ws: WebSocket | null = null;
  private lastSeqRel = 0;
  private seen = new Set<string>();
  private stopped = false;
  private reconnectDelay = 250;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private reconnectInFlight = false;
  private manualReconnecting = false;

  constructor(
    private projectId: string,
    private onFrame: (f: EventFrame) => void,
    private onStatus: (s: "connecting" | "open" | "closed") => void,
    private onReconnectCatchUp: () => void
  ) {}

  start(initialSeqRel = 0): void {
    this.lastSeqRel = initialSeqRel;
    this.seen.clear();
    this.stopped = false;
    this.manualReconnecting = false;
    this.connect();
  }

  stop(): void {
    this.stopped = true;
    this.manualReconnecting = false;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    const w = this.ws;
    if (w) {
      w.onclose = null;
      w.onerror = null;
      w.onmessage = null;
      w.close();
    }
    this.ws = null;
  }

  get cursor(): number {
    return this.lastSeqRel;
  }

  /** After a full REST refetch, re-arm the socket from the fresh cursor. */
  reconnect(): void {
    if (this.stopped) return;
    this.manualReconnecting = true;
    this.cleanupSocket();
    this.connect();
  }

  private connect(): void {
    if (this.stopped) return;
    this.onStatus("connecting");
    const proto = location.protocol === "https:" ? "wss:" : "ws:";
    const url = `${proto}//${location.host}/ws/projects/${this.projectId}/events`;
    const ws = new WebSocket(url);
    this.ws = ws;

    ws.onopen = () => {
      this.reconnectDelay = 250;
      this.onStatus("open");
      // Tell the server our cursor so it gap-fills what we missed.
      ws.send(JSON.stringify({ hello: { lastSeqRel: this.lastSeqRel } }));
      // After a reconnect the local state may be stale → full REST catch-up.
      if (this.manualReconnecting) this.onReconnectCatchUp();
    };

    ws.onmessage = (e) => {
      let raw: unknown;
      try {
        raw = JSON.parse(String(e.data));
      } catch {
        return;
      }
      const f = normalizeEventFrame(raw);
      if (!f) return;
      // Bounded dedupe (gate 8): drop frames already applied via gap-fill or
      // a prior reconnect race.
      if (this.seen.has(f.eventId)) return;
      this.seen.add(f.eventId);
      if (this.seen.size > DEDUPE_LIMIT) {
        const oldest = this.seen.values().next().value;
        if (oldest !== undefined) this.seen.delete(oldest);
      }
      if (typeof f.seqRel === "number" && f.seqRel > this.lastSeqRel) {
        this.lastSeqRel = f.seqRel;
      }
      this.onFrame(f);
    };

    ws.onclose = () => {
      if (this.stopped) return;
      if (this.ws !== ws) return; // superseded by a newer connection
      this.onStatus("closed");
      this.scheduleReconnect();
    };

    ws.onerror = () => {
      // 'close' follows; let the close handler schedule the retry.
    };
  }

  private cleanupSocket(): void {
    const w = this.ws;
    if (!w) return;
    w.onclose = null;
    w.onerror = null;
    w.onmessage = null;
    try {
      w.close();
    } catch {
      /* already closed */
    }
    this.ws = null;
  }

  private scheduleReconnect(): void {
    if (this.stopped || this.reconnectInFlight) return;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.connect();
    }, this.reconnectDelay);
    this.reconnectDelay = Math.min(this.reconnectDelay * 2, 8000);
  }
}
