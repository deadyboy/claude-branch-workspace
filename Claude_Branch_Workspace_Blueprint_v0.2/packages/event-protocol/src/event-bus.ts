// In-process realtime event bus. Control plane publishes normalized, redacted
// CanonicalEvents; UI / Agent Monitor subscribe per branch or globally. The bus
// is an append log with lazy GC of the retained replay buffer.

import type { CanonicalEvent } from "./types.js";

export type BusSubscriber = (ev: CanonicalEvent) => void;
export type Unsubscribe = () => void;

const REPLAY_LIMIT = 2000; // retained per-subscription replay window

export class EventBus {
  private subscribers = new Set<BusSubscriber>();
  private byBranch = new Map<string, Set<BusSubscriber>>();
  private replay: CanonicalEvent[] = [];

  /** Publish one normalized event. Never throws on a subscriber error. */
  publish(ev: CanonicalEvent): void {
    this.replay.push(ev);
    if (this.replay.length > REPLAY_LIMIT) this.replay.splice(0, this.replay.length - REPLAY_LIMIT);
    for (const s of this.subscribers) {
      try { s(ev); } catch { /* isolate subscriber failures */ }
    }
    const branchSet = this.byBranch.get(ev.branchId);
    if (branchSet) {
      for (const s of branchSet) {
        try { s(ev); } catch { /* isolate subscriber failures */ }
      }
    }
  }

  /** Subscribe globally; optionally replays recent buffer. */
  subscribe(fn: BusSubscriber, opts?: { replay?: boolean }): Unsubscribe {
    if (opts?.replay) for (const ev of this.replay) fn(ev);
    this.subscribers.add(fn);
    return () => this.subscribers.delete(fn);
  }

  /** Subscribe to one branch's events; optionally replays that branch's buffer. */
  subscribeBranch(branchId: string, fn: BusSubscriber, opts?: { replay?: boolean }): Unsubscribe {
    if (opts?.replay) for (const ev of this.replay) if (ev.branchId === branchId) fn(ev);
    let set = this.byBranch.get(branchId);
    if (!set) {
      set = new Set();
      this.byBranch.set(branchId, set);
    }
    set.add(fn);
    return () => set?.delete(fn);
  }

  get replayBuffer(): readonly CanonicalEvent[] {
    return this.replay;
  }
}
