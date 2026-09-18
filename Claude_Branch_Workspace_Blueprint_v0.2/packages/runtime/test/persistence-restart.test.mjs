import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ClaudeCliAdapter } from "../dist/index.js";
import { openDb, Repository, DomainService } from "@cbw/domain";
import { SessionManager } from "../../../apps/control-plane/dist/session-manager.js";
import { randomUUID } from "node:crypto";

// Fake `claude` that echoes a minimal stream-json transcript so no live gateway
// is needed. Emits init/assistant/result on every invocation.
function writeFakeClaude(dir) {
  const bin = join(dir, "fake-claude.mjs");
  const script = `import { stdout } from 'node:process';
if (process.argv.includes('--version')) { stdout.write('2.1.226-fake\\n'); process.exit(0); }
// reuse whatever --session-id / --resume the adapter passed
const sidArg = process.argv.indexOf('--session-id');
const sid = sidArg >= 0 ? process.argv[sidArg + 1] : 'FAKE-EXT';
stdout.write(JSON.stringify({ type:'system', subtype:'init', session_id: sid, runtime_version:'2.1.226-fake' }) + '\\n');
stdout.write(JSON.stringify({ type:'assistant', message:{ id:'m1', role:'assistant', content:[{ type:'text', text:'PERSISTED_OK' }] } }) + '\\n');
stdout.write(JSON.stringify({ type:'result', is_error:false, stop_reason:'end_turn', session_id: sid }) + '\\n');
`;
  writeFileSync(bin, script);
  return ["node", bin];
}

function newRepo(dir) {
  const dbPath = join(dir, "test.db");
  const db = openDb(dbPath);
  return { repo: new Repository(db), close: () => db.close() };
}

// The duck-typed persistence hook the adapter needs. Wraps the domain Repository.
function wirePersistence(repo) {
  return {
    getRuntimeSessionByExternalId(extId) {
      const rec = repo.getRuntimeSessionByExternalId(extId);
      if (!rec) return null;
      return { id: rec.id, branchId: rec.branchId, externalSessionId: rec.externalSessionId };
    },
  };
}

test("BLOCKER: external-id mapping persists in domain DB and survives adapter restart", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "cbw-persist-"));
  const { repo, close } = newRepo(dir);
  t.after(() => { close(); rmSync(dir, { recursive: true, force: true }); });
  const [fakeBin, fakeScript] = writeFakeClaude(dir);
  const svc = new DomainService(repo);

  // A real persisted branch: the mapping must anchor to an existing branch row
  // (FK to branches.id), exactly as the control plane will do.
  const project = svc.createProject({ name: "restart-demo" });
  const branch = svc.createRootConversation({ projectId: project.id, rootBranchName: "Main" });
  // Production ownership: the manager writes, the adapter only looks up rows.
  const adapter1 = new ClaudeCliAdapter(fakeBin, [fakeScript], wirePersistence(repo));
  const manager1 = new SessionManager(svc, adapter1);
  const first = await manager1.resolveSession({ branchId: branch.id, cwd: dir });
  const mainKey = first.sessionKey;
  assert.notEqual(mainKey, branch.id, "session key must not masquerade as branch id");

  // The mapping is now in runtime_sessions (the domain fact source).
  const mapped = repo.getRuntimeSessionByExternalId(mainKey);
  assert.ok(mapped, "mapping persisted into domain runtime_sessions");
  assert.equal(mapped.id, mainKey, "sessionKey transaction id is the control-plane UUID");
  assert.equal(mapped.branchId, branch.id);

  // Reproduce the production fork path with different session and branch IDs.
  // The former adapter upsert used newSessionId as branchId and failed the FK.
  const forkPoint = svc.openTurn({ branchId: branch.id, userContent: "fork here" });
  svc.completeTurn(forkPoint.id, { assistantContent: "answer", status: "completed" });
  const childBranch = svc.createBranchFromNode({projectId:project.id, forkFromNodeId:forkPoint.id, displayName:"Child", originStrategy:"native_head_fork", workspaceMode:"shared"});
  const child = await adapter1.forkFromHead(mainKey, {newSessionId:randomUUID(),cwd:dir});
  assert.equal(repo.getRuntimeSessionByExternalId(child.externalSessionId), null, "adapter did not write the child mapping");
  manager1.adoptSession(childBranch.id, child);
  assert.equal(repo.getRuntimeSessionByExternalId(child.externalSessionId).branchId, childBranch.id);

  // Simulate a full control-plane restart: brand-new adapter, same repo,
  // no in-memory carry. It must recover the SAME sessionKey from the DB.
  const adapter2 = new ClaudeCliAdapter(fakeBin, [fakeScript], wirePersistence(repo));
  const manager2 = new SessionManager(svc, adapter2);
  const resumed = await manager2.resolveSession({ branchId: branch.id, cwd: dir });
  assert.equal(resumed.sessionKey, mainKey, "restart recovers original control-plane UUID, not a fresh key");

  // Continuing on the recovered branch works (menu: EVASIVE resume -> send).
  const events = [];
  for await (const ev of adapter2.sendMessage(mainKey, { text: "continue" })) events.push(ev);
  const text = events.filter((e) => e.kind === "assistant").map((e) => e.text).join("");
  assert.match(text, /PERSISTED_OK/, "recovered branch continues");

  await Promise.all([adapter1.terminate(mainKey), adapter2.terminate(mainKey)]);
});
