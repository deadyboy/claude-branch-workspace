// S3 / E4a baseline (docs/14 §4.2) at the domain layer: the v4 migration adds
// branches.base_ref, the once-only write preserves the "before work began"
// value, and an existing DB stays readable across reopens.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDb, Repository, DomainService, SCHEMA_VERSION, DomainError } from "../dist/index.js";

function fresh(path) {
  const db = openDb(path);
  return { db, repo: new Repository(db), svc: new DomainService(new Repository(db)) };
}

test("schema version matches SCHEMA_VERSION and branches.base_ref exists", () => {
  const { db } = fresh(null);
  // Reference the constant, not a hard-coded number: this test pins that
  // user_version tracks SCHEMA_VERSION, not a particular value. (Hard-coding 5
  // here is what made a later migration look like a test failure.)
  assert.equal(db.pragma("user_version", { simple: true }), SCHEMA_VERSION);
  const cols = db.pragma("table_info(branches)").map((c) => c.name);
  assert.ok(cols.includes("base_ref"), "base_ref column added by v4");
  db.close();
});

test("new branches start with baseRef null (recorded later on first bind)", () => {
  const { svc, db } = fresh(null);
  const p = svc.createProject({ name: "p" });
  const b = svc.createRootConversation({ projectId: p.id });
  assert.equal(b.baseRef, null);
  assert.equal(svc.getBranch(b.id).baseRef, null);
  db.close();
});

test("recordBaseRef writes once; later calls never overwrite", () => {
  const { svc, db } = fresh(null);
  const p = svc.createProject({ name: "p" });
  const b = svc.createRootConversation({ projectId: p.id });

  const first = svc.recordBaseRef(b.id, "aaaaaaa");
  assert.equal(first.baseRef, "aaaaaaa");
  const second = svc.recordBaseRef(b.id, "bbbbbbb"); // re-bind / restart attempt
  assert.equal(second.baseRef, "aaaaaaa"); // preserved
  db.close();
});

test("recordBaseRef on an unknown branch throws DomainError", () => {
  const { svc, db } = fresh(null);
  assert.throws(() => svc.recordBaseRef("missing", "abc"), DomainError);
  db.close();
});

test("existing DB: reopen is migration-idempotent and old rows stay readable", () => {
  const dir = mkdtempSync(join(tmpdir(), "cbw-baseref-"));
  const path = join(dir, "cbw.db");
  try {
    const first = fresh(path);
    const p = first.svc.createProject({ name: "persist", rootPath: "/tmp/x" });
    const main = first.svc.createRootConversation({ projectId: p.id, rootBranchName: "Main" });
    const node = first.svc.appendCompletedTurn({ branchId: main.id, userContent: "t", assistantContent: "a" });
    first.svc.recordBaseRef(main.id, "deadbeef");
    first.db.close();

    // Reopen: migrate() sees user_version up to date and must not clobber rows.
    const again = fresh(path);
    assert.equal(again.db.pragma("user_version", { simple: true }), SCHEMA_VERSION);
    const reread = again.svc.getBranch(main.id);
    assert.equal(reread.baseRef, "deadbeef"); // baseline survived
    assert.equal(reread.projectId, p.id);
    assert.equal(again.svc.getNode(node.id).branchId, main.id); // graph intact
    again.db.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
