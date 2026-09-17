import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ClaudeCliAdapter } from "../dist/index.js";
import { openDb, Repository, DomainService } from "@cbw/domain";

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
    upsertRuntimeSession(s) {
      repo.upsertRuntimeSession({
        id: s.id,
        branchId: s.branchId,
        adapterType: s.adapterType,
        externalSessionId: s.externalSessionId,
        runtimeVersion: s.runtimeVersion,
        status: s.status,
        lastSeenAt: s.lastSeenAt,
        metadataJson: s.metadataJson,
      });
    },
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
  const mainKey = branch.id;

  // First "control plane lifetime": adapter that writes to the domain repo.
  const adapter1 = new ClaudeCliAdapter(fakeBin, [fakeScript], wirePersistence(repo));
  await adapter1.startSession({
    sessionId: mainKey,
    cwd: dir,
    workspaceMode: "shared",
    branchId: mainKey,
  });

  // The mapping is now in runtime_sessions (the domain fact source).
  const mapped = repo.getRuntimeSessionByExternalId(mainKey);
  assert.ok(mapped, "mapping persisted into domain runtime_sessions");
  assert.equal(mapped.id, mainKey, "sessionKey transaction id is the control-plane UUID");

  // Simulate a full control-plane restart: brand-new adapter, same repo,
  // no in-memory carry. It must recover the SAME sessionKey from the DB.
  const adapter2 = new ClaudeCliAdapter(fakeBin, [fakeScript], wirePersistence(repo));
  const resumed = await adapter2.resumeSession(mapped.externalSessionId, dir);
  assert.equal(resumed.sessionKey, mainKey, "restart recovers original control-plane UUID, not a fresh key");
  assert.equal(resumed.externalSessionId, mapped.externalSessionId);

  // Continuing on the recovered branch works (menu: EVASIVE resume -> send).
  const events = [];
  for await (const ev of adapter2.sendMessage(mainKey, { text: "continue" })) events.push(ev);
  const text = events.filter((e) => e.kind === "assistant").map((e) => e.text).join("");
  assert.match(text, /PERSISTED_OK/, "recovered branch continues");

  await Promise.all([adapter1.terminate(mainKey), adapter2.terminate(mainKey)]);
});
