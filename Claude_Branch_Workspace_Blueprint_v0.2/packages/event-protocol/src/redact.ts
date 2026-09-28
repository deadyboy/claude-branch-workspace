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
  // Secret-shaped run ANYWHERE in the string (whole-string replacement): a
  // `sk-` + 16+ body chars bounded by non-secret-characters. The boundary class
  // is [^A-Za-z0-9_-] on both sides so a bare key, a URL (`…/key/sk-…?q=1`), a
  // path segment (`key/sk-…/seg`) or an `export FOO=sk-…` command all untrust
  // the ENTIRE string — never leaks as a prefix/substring of a longer value.
  if (/(?:^|[^A-Za-z0-9_-])sk-[A-Za-z0-9_-]{16,}(?:$|[^A-Za-z0-9_-])/.test(s)) return true;
  // GitHub credentials: classic PAT (ghp_), fine-grained (github_pat_), and the
  // OAuth/user/SSH/app tokens (gho_/ghu_/ghs_/ghr_). Same boundary rule.
  if (/\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{20,}/.test(s)) return true;
  if (/\bgithub_pat_[A-Za-z0-9_]{40,}/.test(s)) return true;
  // Bearer tokens / JWT-ish blobs. An explicit `Bearer <blob>` of letter/digit
  // length ≥ 20, or a free-standing `eyJ…` JWT (three dot-separated b64url
  // segments, each ≥ 4 chars, header/footer bounded by non-token chars).
  if (/\bBearer\s+[A-Za-z0-9._~+/=-]{20,}/i.test(s)) return true;
  if (/eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/.test(s)) return true;
  // Other vendors' opaque token formats. These are "known format" rules: a
  // distinctive prefix + a long opaque body, bounded like the `sk-`/GitHub
  // cases so a bare token or one inside a command/URL/path is untrusted whole.
  if (/\b(?:AKIA|ASIA)[A-Z0-9]{16}/.test(s)) return true; // AWS access key / session key
  if (/\bAIza[A-Za-z0-9_\-]{35}/.test(s)) return true; // Google API key
  if (/\bhf_[A-Za-z0-9]{20,}/.test(s)) return true; // Hugging Face (user/org tokens)
  if (/\bxox[bapso]-[A-Za-z0-9\-]{20,}/.test(s)) return true; // Slack bot/app/etc tokens
  if (/\bBasic\s+[A-Za-z0-9+/=]{16,}/i.test(s)) return true; // Authorization: Basic base64
  // Basic-auth userinfo in a URL (`https://user:pass@host/…`) — the `:`+`@`
  // between two opaque fields is a strong signal even when the password is not
  // secret-prefixed.
  if (/(?:^|[^A-Za-z0-9])[A-Za-z0-9._~-]+:[^@\/\s]{8,}@/.test(s)) return true;
  // `curl -u user:pass` / `--user user:pass` — the classic inline passthrough.
  // Password side must be ≥ 8 non-space chars so `-u user` alone or `-u a:b`
  // (tiny) is left alone. Explicit non-word preceding bound (NOT `\b` — a
  // leading space→`-` is non-word→non-word, which `\b` does not count).
  if (/(?:^|[^A-Za-z0-9_-])-u(?:\s+|=)[A-Za-z0-9_.-]+:[A-Za-z0-9!@#$%^&*_~\-=+./]{8,}/.test(s)) return true;
  if (/(?:^|[^A-Za-z0-9_-])--user(?:\s+|=)[A-Za-z0-9_.-]+:[A-Za-z0-9!@#$%^&*_~\-=+./]{8,}/.test(s)) return true;
  // PEM/DER private-key blocks (any algorithm; the run is bounded by header and
  // footer). Only when a full block is present — a bare `PRIVATE KEY` word alone
  // is not enough.
  if (/-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----[\s\S]{10,}-----END [A-Z0-9 ]*PRIVATE KEY-----/.test(s)) return true;
  // `export NAME=…` / `set NAME=…` where NAME smells like a secret AND the
  // assigned value looks like one (an opaque long value). Variable-name alone
  // (e.g. NOT_A_KEY=…) is not enough — the value side must confirm.
  if (/\b(?:export|set)\s+\w*(?:token|key|secret|passwd|password|auth|credential)\w*\s*=\s*["']?(\S+)/i.exec(s)) {
    const val = RegExp.$1;
    if (/^sk-|^ANTHROPIC_|^gh[pousr]_|^github_pat_|^eyJ|^[A-Za-z0-9_-]{24,}$/.test(val)) return true;
  }
  // Inline credential passthroughs that do not rely on a variable name:
  //   --password <opaque> / password: <opaque> / password=<opaque> / -u u:pass
  // The value must be opaque (≥ 8 chars, no spaces) AND not a common benign
  // placeholder (e.g. `--password 123456`, `password: default`). `password`
  // must be preceded by a boundary (line start or non-letter) so a benign word
  // like `notAPassword` is not matched.
  if (/(?:^|[\s'"\-=;:,])password(?:[=:]|[ \t]+)\s*["']?([A-Za-z0-9!@#$%^&*_~\-=+./]{8,})/i.exec(s)) {
    const val = RegExp.$1;
    if (!/^(?:default|changeme|12345678?|password|passw0rd|admin|secret|none|test)$/i.test(val)) return true;
  }
  // Cookie headers: `Cookie: name=opaque-value` / `Set-Cookie: ...` pasted from
  // a network dump. The value must be ≥ 16 chars of non-space — a short value
  // (`Cookie: foo=bar`) or the word `Cookie` without a header form is benign.
  if (/\b(?:Set-)?Cookie:\s*["']?\w+\s*=\s*["']?[A-Za-z0-9._~+/=\-]{16,}/i.test(s)) return true;
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
  Bash: ["command", "output"], // output is surface-bearing (docs/04 §6) — scrubbed, not dropped
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
    case "attention.required":
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
