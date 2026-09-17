// Center pane: effective conversation (gate 3 — inherited/local origin badge
// shown on forked branches), composer (send disabled while branch busy), and
// an Interrupt button (gate 6 — interrupt the ACTIVE branch only).

import { useState } from "react";
import { useStore, branchBusy, branchLastNode } from "../store/useStore";
import { api } from "../api/client";
import type { EffectiveConversationItem } from "../types";

export function ChatPane() {
  const st = useStore();
  const branchId = st.activeBranchId;
  const branch = st.branches.find((b) => b.id === branchId);
  const items = branchId ? (st.conversationByBranch[branchId] ?? []) : [];
  const busy = branchId ? branchBusy(st, branchId) : false;
  const last = branchId ? branchLastNode(st, branchId) : null;

  const [composer, setComposer] = useState("");
  const [sending, setSending] = useState(false);
  const [interrupting, setInterrupting] = useState(false);

  if (!branchId || !branch) {
    return (
      <main className="pane chat">
        <div className="pane-hd"><span>Chat</span></div>
        <div className="empty">Select a branch to start chatting.</div>
      </main>
    );
  }

  const short = branch.id.slice(0, 4);

  const send = async () => {
    const text = composer.trim();
    if (!text || sending || busy) return;
    setSending(true);
    setComposer("");
    try {
      const { nodeId } = await api.sendMessage(branch.id, text);
      // Optimistic: mark the turn pending locally so the composer disables
      // immediately; WS frames will carry the real node completion.
      const nodes = st.nodesByBranch[branch.id] ?? [];
      const optimistic = {
        id: "pending-" + nodeId,
        projectId: branch.projectId,
        branchId: branch.id,
        parentNodeId: last?.id ?? null,
        localTurnIndex: nodes.length,
        userMessageRef: "",
        assistantMessageRef: null,
        runtimeUserMessageId: null,
        runtimeAssistantMessageId: null,
        status: "pending" as const,
        createdAt: new Date().toISOString(),
        completedAt: null,
      };
      st.setNodes(branch.id, [...nodes, optimistic]);
      const items2 = [
        ...(st.conversationByBranch[branch.id] ?? []),
        { role: "user" as const, content: text, nodeId, origin: "local" as const, seq: (st.conversationByBranch[branch.id]?.length ?? 0) + 1 },
      ];
      st.setConversation(branch.id, items2);
    } catch (e) {
      setComposer(text);
      alert(String(e instanceof Error ? e.message : e));
    } finally {
      setSending(false);
    }
  };

  const interrupt = async () => {
    if (!branchId || interrupting) return;
    setInterrupting(true);
    try {
      // 202 accepted, or 409 if idle — both are fine (idle simply nothing).
      await api.interrupt(branchId);
    } catch (e) {
      if (!String(e).includes("409")) {
        alert(String(e instanceof Error ? e.message : e));
      }
    } finally {
      setInterrupting(false);
    }
  };

  return (
    <main className="pane chat">
      <div className="pane-hd">
        <span>Chat — {branch.displayName ?? branch.id} <span className="tree-id">[{short}]</span></span>
        {busy ? <span className="badge busy">running</span> : <span className="badge subtle">idle</span>}
        <div className="hd-actions">
          <button onClick={interrupt} disabled={!busy || interrupting} className="danger" title="Interrupt the active turn only">
            {interrupting ? "Interrupting…" : "Interrupt"}
          </button>
        </div>
      </div>
      <div className="messages">
        {items.map((m) => (
          <MessageRow key={`${m.nodeId}-${m.seq}-${m.role}`} m={m} />
        ))}
        {items.length === 0 && <div className="empty">No messages yet — say hello.</div>}
      </div>
      <div className="composer">
        <textarea
          value={composer}
          placeholder="Send a message to this branch…"
          onChange={(e) => setComposer(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) send();
          }}
          disabled={busy}
        />
        <div className="composer-row">
          <span className="hint">{busy ? "Branch running — disabled" : "Ctrl+Enter to send"}</span>
          <button onClick={send} disabled={!composer.trim() || sending || busy}>
            {sending ? "Sending…" : "Send"}
          </button>
        </div>
      </div>
    </main>
  );
}

function MessageRow({ m }: { m: EffectiveConversationItem }) {
  const [open, setOpen] = useState(false);
  const isUser = m.role === "user";
  return (
    <div className={`msg ${m.role}`}>
      <div className="msg-hd">
        <span className="msg-role">{isUser ? "You" : "Assistant"}</span>
        {m.origin === "inherited" ? (
          <span className="badge inherited">[inherited]</span>
        ) : (
          <span className="badge local">[local]</span>
        )}
      </div>
      {!isUser && m.content.length > 240 && (
        <button className="link" onClick={() => setOpen((v) => !v)}>
          {open ? "Collapse" : "Expand"}
        </button>
      )}
      <div className="msg-body">{open ? m.content : m.content}</div>
    </div>
  );
}
