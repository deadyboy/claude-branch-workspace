// Migration robustness (S0 baseline / S3+S4 concurrency fallout).
//
// `user_version` is a single scalar and cannot express a GAP, so a database
// that reached v5 without v4 being applied would be treated as fully migrated
// and v4 would be skipped FOREVER — a column silently missing, no error
// anywhere. These tests lock in the per-version ledger that repairs such a gap,
// and assert migrations stay replay-safe.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDb, migrate, SCHEMA_VERSION } from "../dist/db.js";

const tmp = () => mkdtempSync(join(tmpdir(), "cbw-mig-"));

const hasColumn = (db, table, column) =>
  db.prepare(`PRAGMA table_info(${table})`).all().some((c) => c.name === column);

const countNewTables = (db) =>
  db
    .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name IN ('tasks','task_attempts','artifacts')")
    .all().length;

test("fresh database migrates to SCHEMA_VERSION", () => {
  const db = openDb(join(tmp(), "fresh.db"));
  assert.equal(db.pragma("user_version", { simple: true }), SCHEMA_VERSION);
  assert.ok(hasColumn(db, "branches", "base_ref"), "v4 effect present");
  assert.equal(countNewTables(db), 3, "v5 effect present");
  db.close();
});

test("reopening an up-to-date database is a no-op", () => {
  const path = join(tmp(), "idem.db");
  const a = openDb(path);
  a.close();
  for (let i = 0; i < 3; i++) {
    const db = openDb(path);
    assert.equal(db.pragma("user_version", { simple: true }), SCHEMA_VERSION);
    db.close();
  }
});

test("a version GAP is repaired, not skipped forever", () => {
  // The exact incident: the DB believes it is at v5, but v4's effect is absent.
  // Under a scalar-only check this is unrecoverable.
  const path = join(tmp(), "gap.db");
  const a = openDb(path);
  migrate(a);
  a.exec("ALTER TABLE branches DROP COLUMN base_ref");
  a.exec("DELETE FROM schema_migrations WHERE version = 4");
  a.pragma("user_version = 5");
  assert.equal(hasColumn(a, "branches", "base_ref"), false, "precondition: gap exists");
  a.close();

  const b = openDb(path);
  assert.ok(hasColumn(b, "branches", "base_ref"), "the gap must be healed on next open");
  b.close();
});

test("a pre-ledger database is upgraded without losing data", () => {
  // Installs created before the ledger existed have no schema_migrations rows;
  // they must still upgrade, and their existing rows must survive.
  const path = join(tmp(), "legacy.db");
  const a = openDb(path);
  migrate(a);
  a.exec("INSERT INTO projects (id, name, root_path, created_at, updated_at) VALUES ('p1','Keep','F:/x','2026-01-01T00:00:00.000Z','2026-01-01T00:00:00.000Z')");
  a.exec("DROP TABLE schema_migrations");
  a.pragma("user_version = 3");
  a.exec("ALTER TABLE branches DROP COLUMN base_ref");
  a.close();

  const b = openDb(path);
  assert.equal(b.pragma("user_version", { simple: true }), SCHEMA_VERSION);
  assert.ok(hasColumn(b, "branches", "base_ref"), "v4 re-applied");
  assert.equal(countNewTables(b), 3, "v5 re-applied");
  assert.equal(b.prepare("SELECT name FROM projects WHERE id='p1'").get()?.name, "Keep", "existing data preserved");
  b.close();
});

test("a gap in a checkable version replays without colliding", () => {
  // The repair path may replay a version whose objects partly exist. This is
  // the realistic repair shape and the one that must be safe.
  const path = join(tmp(), "replay.db");
  const a = openDb(path);
  migrate(a);
  // Pretend v5 half-applied: tables exist but the ledger lost the row.
  a.exec("DELETE FROM schema_migrations WHERE version = 5");
  a.close();

  const b = openDb(path);
  assert.equal(b.pragma("user_version", { simple: true }), SCHEMA_VERSION);
  assert.equal(countNewTables(b), 3, "replayed v5 must not collide with its own tables");
  assert.ok(hasColumn(b, "branches", "base_ref"));
  b.close();
});

// SCOPE, stated explicitly: replay-safety is guaranteed for versions that have
// an effect check registered in migrate() (currently v4/v5 — the migrations
// added in this work). Versions 1-3 are pre-existing and deployed; the ledger
// backfills them from `user_version` and never replays them, so they are not
// required to be replay-safe, and rewriting deployed foundational migrations to
// gain that property would risk far more than it buys. The guard that matters
// is: a version is only replayed when its effect is DETECTED missing.
