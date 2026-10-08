import { readFile, open } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { ensureConfig } from '../src/settings.js';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

async function main() {
  if (Number(process.versions.node.split('.')[0]) < 18) throw new Error('Node.js 18 or newer is required.');
  await ensureConfig(path.join(root, 'config.json'));
  const config = JSON.parse(await readFile(path.join(root, 'config.json'), 'utf8'));
  const host = config.server?.host || '127.0.0.1';
  // --mock launches the demo dashboard (generated data) on its own port and store.
  const mock = process.argv.includes('--mock');
  const port = mock ? 4318 : config.server?.port || 4317;
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Invalid server port in config.json.');
  const browserHost = host === '0.0.0.0' ? '127.0.0.1' : host === '::' ? '::1' : host;
  const address = browserHost.includes(':') && !browserHost.startsWith('[') ? `[${browserHost}]` : browserHost;
  const url = `http://${address}:${port}`;
  const expectedStore = mock
    ? path.join(root, 'data', 'mock-store.json')
    : path.resolve(root, config.storePath || 'data/store.json');

  async function ready() {
    let response;
    try { response = await fetch(`${url}/api/meta`, { signal: AbortSignal.timeout(1500) }); }
    catch { return false; }
    let meta;
    try { meta = await response.json(); } catch {}
    if (!response.ok || meta?.storePath !== expectedStore || !meta?.facets) {
      throw new Error(`Port ${port} is occupied by a different service. Stop it or change the port in config.json.`);
    }
    return true;
  }

  if (await ready()) {
    console.log('The dashboard is already running. Opening your browser...');
  } else {
    console.log(mock ? 'Starting JH AI Observatory (mock data)...' : 'Starting JH AI Observatory...');
    const stdout = await open(path.join(root, 'server.stdout.log'), 'a');
    const stderr = await open(path.join(root, 'server.stderr.log'), 'a');
    let child;
    let launchError = null;
    let exited = false;
    try {
      child = spawn(process.execPath, ['observatory.js', 'serve', ...(mock ? ['--mock'] : [])], {
        cwd: root, detached: true, stdio: ['ignore', stdout.fd, stderr.fd],
      });
      child.on('error', (error) => { launchError = error; });
      child.on('exit', () => { exited = true; });
      child.unref();
    } finally { await stdout.close(); await stderr.close(); }
    const deadline = Date.now() + 60000;
    let running = false;
    while (Date.now() < deadline) {
      if (await ready()) { running = true; break; }
      if (launchError) throw launchError;
      if (exited) throw new Error('The server failed to start. Check server.stderr.log in the project directory.');
      await delay(400);
    }
    if (!running) throw new Error('The server is not ready yet. Check server.stdout.log and server.stderr.log. The first collection may take longer.');
  }
  await new Promise((resolve, reject) => {
    const browser = spawn('/usr/bin/open', [url], { stdio: 'ignore' });
    browser.on('error', reject);
    browser.on('exit', (code) => code === 0 ? resolve() : reject(new Error(`Could not open your browser automatically. Visit ${url}`)));
  });
  console.log(`Dashboard: ${url}`);
  console.log('The server is running in the background. You can close this Terminal window.');
}

main().catch((error) => { console.error(`Launch failed: ${error.message}`); process.exitCode = 1; });
