import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { claimDatabase } from '../dist/database-owner.js';

test('second owner cannot reconcile live database; ownership releases with process handle', async () => {
  const path = join(mkdtempSync(join(tmpdir(), 'cbw-owner-')), 'db.sqlite');
  const owner = await claimDatabase(path);
  try { await assert.rejects(claimDatabase(path), /ownership unavailable/); }
  finally { await new Promise(r => owner.close(r)); }
  const reopened = await claimDatabase(path);
  await new Promise(r => reopened.close(r));
});
