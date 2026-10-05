import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { startProxy, routerClassifier } from './router_proxy.mjs';
import { menuBarExecutable, startMenuBarSupervisor } from './menu_bar_supervisor.mjs';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const argv = process.argv.slice(2);
const value = flag => { const index = argv.indexOf(flag); return index >= 0 ? argv[index + 1] : undefined; };
const upstream = value('--upstream') ?? process.env.ROUTE2_UPSTREAM_URL;
if (!upstream) throw new Error('--upstream is required');
const port = Number(value('--port') ?? 10509);
if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('invalid port');
if (process.platform !== 'darwin') { console.error('Route2 supports macOS and Codex only.'); process.exit(2); }
const executable = value('--router') ?? join(root, 'target', 'debug', 'route2');
const log = (label, event) => process.stderr.write(`[Route2 ${label}] ${JSON.stringify({ timestamp: new Date().toISOString(), ...event })}\n`);
const classify = routerClassifier(executable, root, {
  onStatus: event => log('startup', event),
  onDiagnostic: line => process.stderr.write(`${line}\n`),
});
const eventDirectory = value('--hook-events') ?? process.env.ROUTE2_HOOK_EVENT_DIR;
const policyPath = value('--routing-policy');
const policy = policyPath ? JSON.parse(readFileSync(policyPath, 'utf8')) : {};
const proxy = await startProxy({ upstream, port, classify, eventDirectory, policy, hookIntegration: eventDirectory ? 'configured' : 'unconfigured',
  instanceId: process.env.ROUTE2_INSTANCE_ID,
  onRequest: event => process.stderr.write(`[Route2 request] ${JSON.stringify(event)}\n`),
  onDecision: event => process.stderr.write(`[Route2] ${JSON.stringify(event)}\n`),
  onTransport: event => log('transport', event) });
process.stdout.write(`Route2 listening at http://127.0.0.1:${proxy.port}\n`);
process.stdout.write(`Classifier loading status: http://127.0.0.1:${proxy.port}/status\n`);
const warmup = () => classify.warmup().catch(() => {});
warmup();
const retry = setInterval(() => { if (classify.status().state === 'error') warmup(); }, 60000);
retry.unref();
const menuBar = argv.includes('--no-menu-bar') ? { stop: () => {} }
  : startMenuBarSupervisor({ executable: menuBarExecutable(), log: event => log('menu-bar', event) });
const stop = async () => { clearInterval(retry); menuBar.stop(); await proxy.close(); await classify.close(); };
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
