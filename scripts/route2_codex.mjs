// Historical benchmark launcher; user setup is route2 install-codex --install.
import { spawn } from 'node:child_process';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { homedir } from 'node:os';
import { hookCommand, hookOverrides } from './hook_config.mjs';
import { codexCommand } from './codex_command.mjs';
import { startProxy, routerClassifier, addRouterModel, SENTINEL } from './router_proxy.mjs';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const args = process.argv.slice(2);
const take = name => {
  const index = args.indexOf(name);
  if (index < 0) return null;
  if (!args[index + 1]) throw new Error(`${name} requires a value`);
  return args.splice(index, 2)[1];
};
const upstream = take('--upstream') ?? process.env.ROUTE2_UPSTREAM_URL;
if (!upstream) throw new Error('Provide --upstream with the existing Codex provider base URL.');
const router = resolve(take('--router') ?? join(ROOT, 'target', 'debug', 'route2'));
const codex = codexCommand(take('--codex') ?? 'codex');
const eventDirectory = take('--hook-events') ?? process.env.ROUTE2_HOOK_EVENT_DIR;
const policyPath = take('--routing-policy');
const policy = policyPath ? JSON.parse(readFileSync(policyPath, 'utf8')) : {};
const classify = routerClassifier(router, ROOT);
const proxy = await startProxy({ upstream, classify, eventDirectory, policy, hookIntegration: eventDirectory ? 'configured' : 'unconfigured',
  onRequest: event => process.stderr.write(`[Route2 request] ${JSON.stringify(event)}\n`),
  onDecision: event => process.stderr.write(`[Route2] ${JSON.stringify(event)}\n`) });
const base = `http://127.0.0.1:${proxy.port}`;
const options = ['-c', 'model_provider="route2"', '-c', 'model_providers.route2.name="Route2"',
  '-c', `model_providers.route2.base_url="${base}"`, '-c', 'model_providers.route2.wire_api="responses"',
  '-c', 'model_providers.route2.requires_openai_auth=true', '-c', 'model_providers.route2.supports_websockets=false',
  '-c', 'mcp_servers.route2.command="route2"', '-c', 'mcp_servers.route2.args=["--mcp"]',
  '-c', 'mcp_servers.route2.enabled=false'];
if (eventDirectory) {
  options.push(...hookOverrides(hookCommand(process.execPath, join(ROOT, 'scripts', 'route2_hook.mjs'), eventDirectory)));
  process.stderr.write('[Route2] Outcome hooks configured; review their definitions in Codex /hooks. Untrusted or unsupported hooks are skipped by Codex.\n');
} else process.stderr.write('[Route2] Prompt-only mode: PostToolUse hook integration is unconfigured.\n');
try {
  const cache = JSON.parse(readFileSync(join(homedir(), '.codex', 'models_cache.json'), 'utf8'));
  const catalog = addRouterModel(cache);
  if (catalog.models?.some(m => m.slug === SENTINEL)) {
    const directory = join(ROOT, 'target', 'route2-codex');
    mkdirSync(directory, { recursive: true });
    const path = join(directory, 'models.json');
    writeFileSync(path, JSON.stringify({ models: catalog.models }), { mode: 0o600 });
    options.push('-c', `model_catalog_json=${JSON.stringify(path)}`);
  }
} catch {
  process.stderr.write('[Route2] Account catalog unavailable; explicit routing selection remains available.\n');
}
if (!args.some(x => x === '-m' || (x.startsWith('-m') && !x.startsWith('--')) || x === '--model' || x.startsWith('--model='))) options.push('-m', SENTINEL);
const child = spawn(codex.executable, [...codex.args, ...options, ...args], {
  stdio: [args.includes('exec') && !process.stdin.isTTY ? 'ignore' : 'inherit', 'inherit', 'inherit'],
});
child.on('error', async () => { await proxy.close(); await classify.close(); process.exitCode = 1; });
child.on('exit', async code => { await proxy.close(); await classify.close(); process.exitCode = code ?? 1; });
process.on('SIGINT', () => child.kill('SIGINT'));
process.on('SIGTERM', () => child.kill('SIGTERM'));
