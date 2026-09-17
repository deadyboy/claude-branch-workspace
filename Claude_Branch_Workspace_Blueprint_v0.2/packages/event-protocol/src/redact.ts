// Redaction (docs/04 §7, constitution §11): event payloads must never contain
// tokens/API keys/cookies/raw secrets. Defense in depth:
//   1. allowlist per canonical type — only known safe fields are carried;
//   2. deep scrub of any value that slips through (string or key match).
// Raw events are never persisted by the control plane; UI consumes `payload`
// only after this filter.

import type { CanonicalEvent, CanonicalType } from "./types.js";

const KEY_PATTERNS: RegExp[] = [
  /token/i,
  /auth/i,
  /secret/i,
  /api[_-]?key/i,
  /passwd/i,
  /password/i,
  /cookie/i,
  /bearer/i,
  /credential/i,
  /access[_-]?key/i,
];

function looksSecretKey(k: string): boolean {
  return KEY_PATTERNS.some((r) => r.test(k));
}

function looksSecretValue(v: unknown): boolean {
  if (typeof v !== "string") return false;
  const s = v;
  if (s.length < 8) return false;
  // Whole-string markers: an exposed env secret, or a copy-pasted key.
  if (/^ANTHROPIC_\S+/.test(s)) return true;
  if (/^sk-[A-Za-z0-9_-]{16,}$/.test(s)) return true;
  // Secret-shaped value anywhere in the string: bash `export FOO=sk-…`, `echo <key>`,
  // `<key>` inside a longer command or summary. Ensure the pattern needs an
  // interior terminator or trail so a benign word like "notification" is not a hit.
  if (/(?:=|\s|["'`(])sk-[A-Za-z0-9_-]{16,}(?:[\s"'`)]|$)/.test(s)) return true;
  // `export NAME=…` / `set NAME=…` where NAME smells like a secret AND the
  // assigned value looks like one (an opaque long value). Variable-name alone
  // (e.g. NOT_A_KEY=…) is not enough — the value side must confirm.
  if (/\b(?:export|set)\s+\w*(?:token|key|secret|passwd|password|auth|credential)\w*\s*=\s*["']?(\S+)/i.exec(s)) {
    const val = RegExp.$1;
    if (/^sk-|^ANTHROPIC_|^[A-Za-z0-9_-]{24,}$/.test(val)) return true;
  }
  return false;
}

/** Deep-redact one value by traversing objects/arrays. Returns a pruned copy. */
export function scrub(value: unknown): unknown {
  if (Array.isArray(value)) return value.map((v) => scrub(v));
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      if (looksSecretKey(k)) {
        out[k] = "[REDACTED]";
        continue;
      }
      out[k] = looksSecretValue(v) ? "[REDACTED]" : scrub(v);
    }
    return out;
  }
  return looksSecretValue(value) ? "[REDACTED]" : value;
}

type Allowlist = Record<string, readonly string[]>;

// Only these keys may be carried to the UI from a tool input; everything else
// in a tool argument is dropped at the envelope (docs/04 §6 "safe tool input
// summary"). Status/name already live on the event envelope.
const TOOL_ALLOW: Allowlist = {
  Read: ["file_path"],
  Glob: ["pattern"],
  Grep: ["pattern"],
  Bash: ["command"],
  Write: ["file_path"],
  Edit: ["file_path"],
};

function safeToolPayload(name: string, input: unknown): Record<string, unknown> {
  const allowed = TOOL_ALLOW[name];
  if (!allowed) return {};
  const out: Record<string, unknown> = {};
  const raw = scrub(input);
  if (raw && typeof raw === "object") {
    const r = raw as Record<string, unknown>;
    for (const key of allowed) {
      let val = r[key];
      // Value passed through scrub so a secret inside an allowlisted field
      // (e.g. a token in a Bash command) is still redacted before persistence.
      val = typeof val === "string" ? scrub(val) : val;
      if (typeof val === "string" || typeof val === "number" || typeof val === "boolean") {
        out[key] = val;
      }
    }
  }
  return out;
}

interface NormalizeInput {
  eventId: string;
  type: CanonicalType;
  occurredAt: string;
  receivedAt: string;
  projectId: string;
  branchId: string;
  nodeId: string | null;
  agentRunId: string | null;
  runtimeSessionId: string | null;
  sequence: number | null;
  // structured, normalized fields from the adapter/observer
  toolName?: string;
  toolInput?: unknown; // only allowlisted keys survive
  text?: string;
  summary?: string | null;
  idRef?: string | null; // runtime id (tool_use_id, runtime_agent_id), non-secret
}

/**
 * Build a fully redacted CanonicalEvent payload for `type`. Only allowlisted
 * extraction + scrub is applied; no raw event body ever enters `payload`.
 */
export function buildRedactedPayload(input: NormalizeInput): Record<string, unknown> {
  const p: Record<string, unknown> = {};
  switch (input.type) {
    case "tool.started":
    case "tool.completed":
    case "tool.failed":
      if (input.toolName) p["tool"] = input.toolName;
      if (input.toolInput !== undefined) Object.assign(p, safeToolPayload(input.toolName ?? "", input.toolInput));
      if (input.idRef) p["toolUseId"] = input.idRef;
      break;
    case "agent.started":
    case "agent.completed":
    case "agent.failed":
      if (input.summary) p["task"] = scrub(input.summary);
      if (input.idRef) p["runtimeAgentId"] = input.idRef;
      break;
    case "message.assistant.delta":
    case "message.assistant.completed":
      if (input.text) p["text"] = scrub(input.text);
      break;
    case "message.user":
      if (input.text) p["text"] = scrub(input.text);
      break;
    case "task.created":
    case "task.completed":
      if (input.summary) p["summary"] = scrub(input.summary);
      break;
    case "session.started":
    case "session.resumed":
      break; // envelope carries the id; nothing secret to add
    default:
      break; // no free-form payload from unknown canonical types
  }
  return p;
}
