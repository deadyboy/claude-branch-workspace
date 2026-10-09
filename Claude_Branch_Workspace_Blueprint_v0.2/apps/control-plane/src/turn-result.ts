// TurnResult is the chat truth of one turn's execution (hard gate 4).
// CanonicalEvents are observability only; the structured result carries the
// verbatim assistant text captured from the raw runtime stream (before any
// scrub), the terminal decision, and the exit code / stop reason.

export interface TurnResult {
  status: "completed" | "failed" | "cancelled";
  stopReason: string | null;
  // Verbatim raw assistant text accumulated from parsed RuntimeEvents, before
  // any redaction. This is what completeTurn persists as chat truth (gate 4).
  assistantContent: string | null;
  // Last main assistant transcript UUID; separate from API messageId dedup.
  runtimeAssistantMessageId?: string | null;
  exitCode: number | null;
  eventCount: number;
}
