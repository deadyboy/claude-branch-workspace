import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { bridgeLaunchOptions, prepareBridgeData } from '../start-bridge.mjs';

function fixture(t, changes = {}) {
  const root = mkdtempSync(join(tmpdir(), 'cbw-bridge-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const library = join(root, 'Claude-3p', 'configLibrary');
  mkdirSync(library, { recursive: true });
  const id = '00000000-0000-4000-8000-00000015722b';
  writeFileSync(join(library, '_meta.json'), JSON.stringify({ appliedId: id }));
  writeFileSync(join(library, `${id}.json`), JSON.stringify({ inferenceGatewayBaseUrl: 'http://127.0.0.1:15722/desktop', inferenceGatewayApiKey: 'LOCAL_FAKE_SECRET', inferenceModels: [{ name: 'claude-fable-5', labelOverride: 'qwen3.8-chat' }, { name: 'claude-haiku-4-5', labelOverride: 'deepseek-flash' }], ...changes }));
  return { root, library, env: { LOCALAPPDATA: root }, id };
}

test('model alias resolves to direct label; explicit values win and credentials stay only in env', t => {
  const f = fixture(t);
  const options = bridgeLaunchOptions(['--model', 'claude-fable-5', '--port', '15990'], { ...f.env, CBW_BRIDGE_MODEL: 'deepseek-flash', CBW_PORT: '15991', ANTHROPIC_MODEL: 'OLD', ANTHROPIC_API_KEY: 'OLD_SECRET', CLAUDE_CODE_OAUTH_TOKEN: 'OLD_OAUTH' }, f.root);
  assert.equal(options.model, 'qwen3.8-chat');
  assert.equal(options.childEnv.CBW_PORT, '15990');
  assert.equal(options.childEnv.CBW_AUTH_TOKEN, 'LOCAL_FAKE_SECRET');
  assert.equal(options.childEnv.ANTHROPIC_API_KEY, undefined);
  assert.equal(options.childEnv.CLAUDE_CODE_OAUTH_TOKEN, undefined);
  assert.equal(options.childEnv.ANTHROPIC_MODEL, 'qwen3.8-chat');
  prepareBridgeData(options);
  const settings = readFileSync(join(options.config, 'settings.json'), 'utf8');
  assert.deepEqual(JSON.parse(settings), { model: 'qwen3.8-chat', env: { ANTHROPIC_MODEL: 'qwen3.8-chat', ANTHROPIC_BASE_URL: 'http://127.0.0.1:15722/desktop' } });
  assert.ok(!settings.includes('LOCAL_FAKE_SECRET'));
  assert.ok(!readFileSync(join(options.dataDir, '.cbw-bridge-owner.json'), 'utf8').includes('LOCAL_FAKE_SECRET'));
  assert.equal(options.db, join(options.dataDir, 'cbw.db'));
  assert.equal(options.config, join(options.dataDir, 'claude-config'));
  prepareBridgeData(options);
});

test('env model works; missing or unknown model lists catalog without echoing supplied secret', t => {
  const f = fixture(t);
  assert.equal(bridgeLaunchOptions([], { ...f.env, CBW_BRIDGE_MODEL: 'deepseek-flash' }, f.root).model, 'deepseek-flash');
  for (const args of [[], ['--model', 'SUPPLIED_SECRET']]) {
    assert.throws(() => bridgeLaunchOptions(args, f.env, f.root), e => e.message.includes('qwen3.8-chat') && !e.message.includes('SUPPLIED_SECRET') && !e.message.includes('LOCAL_FAKE_SECRET'));
  }
});

test('rejects non-loopback endpoints and credential-bearing URLs', t => {
  for (const endpoint of ['https://example.com/desktop', 'http://127.0.0.1.evil.test', 'file:///desktop', 'http://user:URL_SECRET@localhost/desktop']) {
    const f = fixture(t, { inferenceGatewayBaseUrl: endpoint });
    assert.throws(() => bridgeLaunchOptions(['--model', 'qwen3.8-chat'], f.env, f.root), e => !e.message.includes('URL_SECRET') && /loopback/.test(e.message));
  }
});

test('rejects profile traversal and malformed JSON without exposing raw contents', t => {
  const f = fixture(t);
  writeFileSync(join(f.library, '_meta.json'), JSON.stringify({ appliedId: '../../PRIVATE' }));
  assert.throws(() => bridgeLaunchOptions([], f.env, f.root), /Invalid applied/);
  writeFileSync(join(f.library, '_meta.json'), '{MALFORMED_SECRET');
  assert.throws(() => bridgeLaunchOptions([], f.env, f.root), e => !e.message.includes('MALFORMED_SECRET') && /Cannot read/.test(e.message));
});

test('data/config overrides must match; unowned existing data is preserved', t => {
  const f = fixture(t);
  for (const env of [{ CBW_DB: join(f.root, 'old.db') }, { CLAUDE_CONFIG_DIR: join(f.root, 'old-config') }, { CBW_DB: '' }, { CLAUDE_CONFIG_DIR: '' }]) {
    assert.throws(() => bridgeLaunchOptions(['--model', 'qwen3.8-chat'], { ...f.env, ...env }, f.root), /paired/);
  }
  const options = bridgeLaunchOptions(['--model', 'qwen3.8-chat'], f.env, f.root);
  mkdirSync(options.dataDir, { recursive: true });
  writeFileSync(options.db, 'existing');
  assert.throws(() => prepareBridgeData(options), /not owned/);
  assert.equal(readFileSync(options.db, 'utf8'), 'existing');
  assert.deepEqual(readdirSync(options.dataDir), ['cbw.db']);
});

test('catalog supports direct models and duplicate aliases for the same actual model', t => {
  const f = fixture(t, { inferenceModels: [{ name: 'alias-a', labelOverride: 'direct-model' }, { name: 'alias-b', labelOverride: 'direct-model' }, { name: 'plain-model' }] });
  assert.equal(bridgeLaunchOptions(['--model', 'direct-model'], f.env, f.root).model, 'direct-model');
  assert.equal(bridgeLaunchOptions(['--model', 'plain-model'], f.env, f.root).model, 'plain-model');
});

test('refuses missing paired config and foreign settings without overwriting', t => {
  const f = fixture(t);
  const options = bridgeLaunchOptions(['--model', 'qwen3.8-chat'], f.env, f.root);
  prepareBridgeData(options);
  const settingsPath = join(options.config, 'settings.json');
  const foreign = JSON.stringify({ model: 'qwen3.8-chat', env: { ANTHROPIC_AUTH_TOKEN: 'FOREIGN_SECRET' } });
  writeFileSync(settingsPath, foreign);
  assert.throws(() => prepareBridgeData(options), /not owned/);
  assert.equal(readFileSync(settingsPath, 'utf8'), foreign);
  rmSync(options.config, { recursive: true });
  writeFileSync(options.db, 'existing');
  assert.throws(() => prepareBridgeData(options), /refusing to recover/);
});
