import { readFileSync, writeFileSync, existsSync, mkdirSync, readdirSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';

const projectRoot = fileURLToPath(new URL('../', import.meta.url));
const ownerName = '.cbw-bridge-owner.json';
class BridgeLaunchError extends Error {}
const safeError = message => new BridgeLaunchError(message);
function readJson(path, message) {
  try { return JSON.parse(readFileSync(path, 'utf8')); }
  catch { throw safeError(message); }
}

export function bridgeLaunchOptions(args, env = process.env, root = projectRoot) {
  const options = {};
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--') continue;
    const key = { '--model': 'model', '--data-dir': 'dataDir', '--port': 'port' }[args[i]];
    if (!key || options[key] !== undefined || !args[i + 1] || args[i + 1].startsWith('--')) {
      throw safeError('Usage: start:bridge -- --model <model> [--data-dir <directory>] [--port <port>]');
    }
    options[key] = args[++i];
  }
  if (!env.LOCALAPPDATA) throw safeError('LOCALAPPDATA is required for the applied desktop bridge profile');
  const library = join(env.LOCALAPPDATA, 'Claude-3p', 'configLibrary');
  const meta = readJson(join(library, '_meta.json'), 'Cannot read the applied bridge profile reference');
  if (typeof meta.appliedId !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(meta.appliedId)) {
    throw safeError('Invalid applied bridge profile reference');
  }
  const profile = readJson(join(library, `${meta.appliedId}.json`), 'Cannot read the applied bridge profile');
  let endpoint;
  try { endpoint = new URL(profile.inferenceGatewayBaseUrl); }
  catch { throw safeError('Invalid bridge endpoint'); }
  if (!['http:', 'https:'].includes(endpoint.protocol) || !['127.0.0.1', 'localhost', '[::1]'].includes(endpoint.hostname) || endpoint.username || endpoint.password || endpoint.search || endpoint.hash) {
    throw safeError('Bridge endpoint must be a loopback HTTP(S) URL without embedded credentials');
  }
  if (typeof profile.inferenceGatewayApiKey !== 'string' || !profile.inferenceGatewayApiKey.trim()) throw safeError('The applied bridge profile has no local credential');
  const models = Array.isArray(profile.inferenceModels) ? profile.inferenceModels.filter(m => m && typeof m.name === 'string' && m.name.trim()).map(m => ({ name: m.name, actualModel: typeof m.labelOverride === 'string' && m.labelOverride.trim() ? m.labelOverride : m.name })) : [];
  const requested = options.model ?? env.CBW_BRIDGE_MODEL;
  const matches = [...new Set(models.filter(m => m.name === requested || m.actualModel === requested).map(m => m.actualModel))];
  if (matches.length !== 1) {
    // Only the explicitly non-sensitive model catalog is eligible for diagnostics.
    const available = [...new Set(models.map(m => m.actualModel))].join(', ');
    throw safeError(`Select one available bridge model with --model or CBW_BRIDGE_MODEL: ${available || '(none)'}`);
  }
  const dataDir = resolve(root, options.dataDir ?? './data/bridge');
  const db = join(dataDir, 'cbw.db');
  const config = join(dataDir, 'claude-config');
  if ((env.CBW_DB !== undefined && resolve(root, env.CBW_DB) !== db) || (env.CLAUDE_CONFIG_DIR !== undefined && resolve(root, env.CLAUDE_CONFIG_DIR) !== config)) {
    throw safeError('CBW_DB and CLAUDE_CONFIG_DIR must match the paired --data-dir paths');
  }
  const port = options.port ?? env.CBW_PORT ?? '15723';
  if (!/^\d+$/.test(String(port)) || Number(port) < 1 || Number(port) > 65535) throw safeError('Port must be an integer from 1 to 65535');
  const childEnv = { ...env, CBW_BASE_URL: endpoint.href, CBW_AUTH_TOKEN: profile.inferenceGatewayApiKey,
    ANTHROPIC_BASE_URL: endpoint.href, ANTHROPIC_AUTH_TOKEN: profile.inferenceGatewayApiKey,
    ANTHROPIC_MODEL: matches[0], CLAUDE_CONFIG_DIR: config, CBW_DB: db, CBW_PORT: String(port), CBW_FAKE_RUNTIME: '0' };
  delete childEnv.ANTHROPIC_API_KEY;
  delete childEnv.CLAUDE_CODE_OAUTH_TOKEN;
  delete childEnv.CLAUDECODE;
  return { dataDir, db, config, model: matches[0], childEnv, entry: join(root, 'apps', 'control-plane', 'dist', 'index.js') };
}

export function prepareBridgeData(options) {
  const { dataDir, db, config, model } = options;
  const marker = join(dataDir, ownerName);
  const settings = join(config, 'settings.json');
  if (existsSync(marker)) {
    const owner = readJson(marker, 'Cannot read bridge data ownership');
    if (owner.version !== 1 || owner.db !== db || owner.config !== config) throw safeError('Bridge data ownership does not match this directory');
    if (!existsSync(settings)) throw safeError('Bridge CLI configuration is missing; refusing to recover existing database mappings');
    const previous = readJson(settings, 'Cannot read bridge CLI configuration');
    if (Object.keys(previous).some(k => !['model', 'env'].includes(k)) || typeof previous.model !== 'string' || !previous.env || Object.keys(previous.env).some(k => !['ANTHROPIC_MODEL', 'ANTHROPIC_BASE_URL'].includes(k))) throw safeError('Refusing to overwrite CLI configuration not owned by this launcher');
  } else if (existsSync(dataDir) && readdirSync(dataDir).length) {
    throw safeError('Bridge data directory is not empty and is not owned by this launcher');
  }
  if (existsSync(db) && !existsSync(settings)) throw safeError('Bridge CLI configuration is missing; refusing to recover existing database mappings');
  mkdirSync(config, { recursive: true });
  writeFileSync(settings, JSON.stringify({ model, env: { ANTHROPIC_MODEL: model, ANTHROPIC_BASE_URL: options.childEnv.CBW_BASE_URL } }, null, 2) + '\n');
  if (!existsSync(marker)) writeFileSync(marker, JSON.stringify({ version: 1, db, config }, null, 2) + '\n', { flag: 'wx' });
}

export function startBridge(args = process.argv.slice(2), env = process.env) {
  const options = bridgeLaunchOptions(args, env);
  if (!existsSync(options.entry)) throw safeError('Control plane is not built; run pnpm build before start:bridge');
  prepareBridgeData(options);
  const child = spawn(process.execPath, [options.entry], { cwd: projectRoot, env: options.childEnv, stdio: 'inherit', shell: false });
  const forward = signal => { try { child.kill(signal); } catch { /* child has exited */ } };
  const onInterrupt = () => forward('SIGINT');
  const onTerminate = () => forward('SIGTERM');
  process.once('SIGINT', onInterrupt);
  process.once('SIGTERM', onTerminate);
  child.once('error', () => { console.error('[cbw bridge] Could not start the control plane'); process.exitCode = 1; });
  child.once('exit', (code, signal) => {
    process.removeListener('SIGINT', onInterrupt);
    process.removeListener('SIGTERM', onTerminate);
    process.exitCode = code ?? (signal ? 1 : 0);
  });
  return child;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { startBridge(); }
  catch (error) {
    // All expected errors above contain only fixed text or model labels.
    console.error(`[cbw bridge] ${error instanceof BridgeLaunchError ? error.message : 'Startup failed'}`);
    process.exitCode = 1;
  }
}
