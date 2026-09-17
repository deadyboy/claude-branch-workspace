// Bottom pane: Event Timeline. Toolbar: type filter, pause-autoscroll, collapse
// repeated tools, error focus, permission focus. Attention cards pinned on top.
// Only redacted event payloads ever render (gate 8/§11).

import { useEffect, useRef } from "react";
import { useStore, filteredTimeline } from "../store/useStore";
import type { TimelineEntry } from "../store/useStore";
import { AttentionCard } from "./AttentionCard";

type Filter = "all" | "errors" | "permission" | "tools";

export function Timeline() {
  const st = useStore();
  const list = filteredTimeline(st);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!st.pauseAutoscroll) {
      const el = ref.current;
      if (el) el.scrollTop = el.scrollHeight;
    }
  }, [list.length, st.pauseAutoscroll]);

  // Pinned cards: pending first (awaiting an allow/deny), answered after — the
  // .attn-card.answered + .attn-answered styles show the outcome of the reply.
  const pendingAttn = [
    ...st.attention.filter((c) => c.status === "pending"),
    ...st.attention.filter((c) => c.status === "answered"),
  ];
  const collapsed = st.collapseRepeatedTools;

  const counts: Record<Filter, number> = {
    all: st.timeline.length,
    errors: filteredTimeline({ ...st, timelineFilter: "errors" }).length,
    permission: filteredTimeline({ ...st, timelineFilter: "permission" }).length,
    tools: filteredTimeline({ ...st, timelineFilter: "tools" }).length,
  };

  const rendered = collapsed && st.timelineFilter === "tools" ? collapseRuns(list) : list;

  return (
    <section className="pane timeline">
      <div className="pane-hd">
        <span>Event Timeline <span className="tree-id">seq {st.latestSeqRel}</span></span>
        <div className="timeline-toolbar">
          {(["all", "errors", "permission", "tools"] as Filter[]).map((f) => (
            <button
              key={f}
              className={st.timelineFilter === f ? "active" : ""}
              onClick={() => st.setTimelineFilter(f)}
            >
              {f} ({counts[f]})
            </button>
          ))}
          <button onClick={() => st.setPauseAutoscroll(!st.pauseAutoscroll)}>
            {st.pauseAutoscroll ? "Resume autoscroll" : "Pause"}
          </button>
          <button onClick={() => st.setCollapseRepeatedTools(!st.collapseRepeatedTools)}>
            {st.collapseRepeatedTools ? "Expand tools" : "Collapse tools"}
          </button>
        </div>
      </div>
      {pendingAttn.length > 0 && (
        <div className="attn-pinned">
          {pendingAttn.map((c) => (
            <AttentionCard key={c.id} card={c} />
          ))}
        </div>
      )}
      <div className="timeline-list" ref={ref}>
        {rendered.map((t) => (
          <TimelineRow key={t.eventId} entry={t} />
        ))}
        {rendered.length === 0 && <div className="empty">No events yet.</div>}
      </div>
    </section>
  );
}

function TimelineRow({ entry }: { entry: TimelineEntry }) {
  const cls = entry.status === "failed" || entry.status === "cancelled" ? "error" : entry.type.includes("permission") ? "attn" : entry.type.startsWith("tool.") ? "tool" : "default";
  return (
    <div className={`tl-row ${cls}`}>
      <span className="tl-seq">{entry.seqRel}</span>
      <span className="tl-type">{entry.type}</span>
      {entry.nodeId && <span className="tl-meta">{`node ${entry.nodeId.slice(0, 4)}`}</span>}
      <span className="tl-status">{entry.status ?? ""}</span>
      <code className="tl-payload">{JSON.stringify(entry.payload ?? {})}</code>
    </div>
  );
}

function collapseRuns(list: TimelineEntry[]): TimelineEntry[] {
  // Collapse consecutive same-type tool events into one row (count preserved).
  const out: TimelineEntry[] = [];
  for (const t of list) {
    const last = out[out.length - 1];
    if (last && last.type === t.type) {
      out[out.length - 1] = { ...last, seqRel: t.seqRel, occurredAt: t.occurredAt };
      continue;
    }
    out.push(t);
  }
  return out;
}
