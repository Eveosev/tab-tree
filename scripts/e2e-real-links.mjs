#!/usr/bin/env node
/**
 * Independent end-to-end regression test for the core Tab Tree user story:
 *
 *   A page opens a link in a foreground tab  -> child of A
 *   a second foreground link from A          -> another child of A
 *   a link opened from a child               -> grandchild (A > B > D)
 *   Cmd/Ctrl+click (background)              -> child of A
 *   chrome.tabs.create without opener         -> root, sibling of A
 *   closing the middle parent                -> grandchild promoted one level
 *
 * It only uses public Chrome APIs plus the extension's own debug hook, and it
 * drives *real* mouse events through CDP (Input.dispatchMouseEvent), not
 * `chrome.tabs.create({ openerTabId })`, so the browser's own opener
 * bookkeeping is exercised.
 *
 * This is deliberately separate from scripts/smoke.mjs: smoke builds a deep
 * chain through the reparent override path, which cannot detect the browser
 * clearing `openerTabId` on foreground tab creation.
 *
 * Usage: node scripts/e2e-real-links.mjs   (set CHROME_PATH if auto-detect fails)
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const extension = path.join(root, 'extension');

function findChrome() {
  if (process.env.CHROME_PATH) return process.env.CHROME_PATH;
  const playwrightCache = path.join(os.homedir(), 'Library/Caches/ms-playwright');
  const candidates = [];
  if (fs.existsSync(playwrightCache)) {
    for (const entry of fs.readdirSync(playwrightCache).filter((name) => name.startsWith('chromium-')).sort().reverse()) {
      candidates.push(
        path.join(playwrightCache, entry, 'chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing'),
        path.join(playwrightCache, entry, 'chrome-mac/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing'),
        path.join(playwrightCache, entry, 'chrome-linux64/chrome'),
        path.join(playwrightCache, entry, 'chrome-linux/chrome'),
      );
    }
  }
  candidates.push(
    '/Applications/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing',
    '/Applications/Chromium.app/Contents/MacOS/Chromium',
    '/usr/bin/chromium',
    '/usr/bin/google-chrome',
  );
  return candidates.find((candidate) => fs.existsSync(candidate)) || null;
}

const chromePath = findChrome();
if (!chromePath) {
  console.error('Chrome/Chromium not found. Set CHROME_PATH to Chrome for Testing or Chromium.');
  process.exit(1);
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function waitFor(fn, { timeout = 20_000, interval = 100, label = 'condition' } = {}) {
  const deadline = Date.now() + timeout;
  let lastError = null;
  while (Date.now() < deadline) {
    try {
      const value = await fn();
      if (value) return value;
    } catch (error) {
      lastError = error;
    }
    await sleep(interval);
  }
  throw new Error(`Timed out waiting for ${label}${lastError ? `: ${lastError.message}` : ''}`);
}

class CDP {
  constructor(url) {
    this.url = url;
    this.nextId = 1;
    this.pending = new Map();
  }

  async connect() {
    this.socket = new WebSocket(this.url);
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('WebSocket open timeout')), 8000);
      this.socket.addEventListener('open', () => {
        clearTimeout(timer);
        resolve();
      });
      this.socket.addEventListener('error', (event) => {
        clearTimeout(timer);
        reject(new Error(`WebSocket error: ${event.message || 'unknown'}`));
      });
    });
    this.socket.addEventListener('message', (event) => {
      const message = JSON.parse(event.data);
      if (message.id && this.pending.has(message.id)) {
        const { resolve, reject } = this.pending.get(message.id);
        this.pending.delete(message.id);
        if (message.error) reject(new Error(message.error.message));
        else resolve(message.result);
      }
    });
    return this;
  }

  send(method, params = {}) {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.socket.send(JSON.stringify({ id, method, params }));
    });
  }

  async evaluate(expression) {
    const result = await this.send('Runtime.evaluate', {
      expression,
      awaitPromise: true,
      returnByValue: true,
      userGesture: true,
    });
    if (result.exceptionDetails) {
      throw new Error(result.exceptionDetails.exception?.description || result.exceptionDetails.text);
    }
    return result.result?.value;
  }

  close() {
    try {
      this.socket?.close();
    } catch {
      /* noop */
    }
  }
}

const pages = {
  '/a': {
    title: 'A root',
    body: `<a id="b" href="/b" target="_blank">B</a>
      <a id="c" href="/c" target="_blank">C</a>
      <a id="e" href="/e" target="_blank">E</a>`,
  },
  '/b': { title: 'B child', body: '<a id="d" href="/d" target="_blank">D</a>' },
  '/c': { title: 'C child', body: '<p>C</p>' },
  '/d': { title: 'D grandchild', body: '<p>D</p>' },
  '/e': { title: 'E background child', body: '<p>E</p>' },
};

function startServer() {
  const server = http.createServer((request, response) => {
    const pathname = new URL(request.url, 'http://127.0.0.1').pathname;
    const page = pages[pathname] || pages['/a'];
    response.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
    response.end(`<!doctype html><html><head><meta charset="utf-8"><title>${page.title}</title></head><body>${page.body}</body></html>`);
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve({ server, port: server.address().port }));
  });
}

async function jsonTargets(port) {
  return (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
}

async function connectPage(port, urlPart) {
  const target = await waitFor(
    async () => (await jsonTargets(port)).find((item) => item.type === 'page' && item.url.includes(urlPart)),
    { label: `page ${urlPart}` },
  );
  const client = new CDP(target.webSocketDebuggerUrl);
  await client.connect();
  await client.send('Runtime.enable');
  await client.send('Page.enable');
  return { client, target };
}

/** Real user click at the center of a selector, with optional modifier bits. */
async function realClick(port, urlPart, selector, modifiers = 0) {
  const { client } = await connectPage(port, urlPart);
  const rect = JSON.parse(
    await client.evaluate(`(() => {
      const element = document.querySelector(${JSON.stringify(selector)});
      if (!element) return 'null';
      const box = element.getBoundingClientRect();
      return JSON.stringify({ x: box.x + box.width / 2, y: box.y + box.height / 2 });
    })()`),
  );
  if (!rect) throw new Error(`no ${selector} on ${urlPart}`);
  const params = { x: rect.x, y: rect.y, button: 'left', clickCount: 1, modifiers };
  await client.send('Input.dispatchMouseEvent', { type: 'mousePressed', ...params });
  await client.send('Input.dispatchMouseEvent', { type: 'mouseReleased', ...params });
  client.close();
}

const results = [];
const failures = [];
function check(name, condition, detail = '') {
  if (condition) {
    results.push(`  ✔ ${name}`);
  } else {
    failures.push(`${name}${detail ? ` — ${detail}` : ''}`);
    results.push(`  ✖ ${name}${detail ? ` — ${detail}` : ''}`);
  }
}

let chrome = null;
let server = null;
let profile = null;
const clients = [];

try {
  const local = await startServer();
  server = local.server;
  const appUrl = `http://127.0.0.1:${local.port}`;

  profile = fs.mkdtempSync(path.join(os.tmpdir(), 'tab-tree-e2e-'));
  const logFile = path.join(profile, 'chrome.log');
  const out = fs.openSync(logFile, 'w');
  chrome = spawn(
    chromePath,
    [
      '--headless=new',
      '--disable-gpu',
      '--no-first-run',
      '--no-default-browser-check',
      '--disable-background-networking',
      '--disable-component-update',
      '--disable-default-apps',
      '--disable-sync',
      '--metrics-recording-only',
      '--no-service-autorun',
      '--password-store=basic',
      '--use-mock-keychain',
      `--user-data-dir=${profile}`,
      `--load-extension=${extension}`,
      `--disable-extensions-except=${extension}`,
      '--remote-debugging-port=0',
      'about:blank',
    ],
    { stdio: ['ignore', out, out] },
  );

  const port = await waitFor(
    () => {
      const file = path.join(profile, 'DevToolsActivePort');
      if (!fs.existsSync(file)) return null;
      return Number(fs.readFileSync(file, 'utf8').split('\n')[0]) || null;
    },
    { label: 'DevToolsActivePort' },
  );
  await sleep(500);

  const worker = await waitFor(
    async () => {
      for (const target of await jsonTargets(port)) {
        if (target.type !== 'service_worker' || !target.url.startsWith('chrome-extension://')) continue;
        const client = new CDP(target.webSocketDebuggerUrl);
        try {
          await client.connect();
          await client.send('Runtime.enable');
          if ((await client.evaluate('chrome.runtime.getManifest?.().name || ""')) === 'Tab Tree') {
            return { client, target };
          }
        } catch {
          /* not our worker */
        }
        client.close();
      }
      return null;
    },
    { label: 'Tab Tree service worker' },
  );
  const sw = worker.client;
  clients.push(sw);
  const extensionId = new URL(worker.target.url).host;
  console.log('Tab Tree real-link e2e');
  console.log(`  chrome: ${chromePath}`);
  console.log(`  extension: ${extensionId}`);

  const rawTabs = () =>
    sw.evaluate(
      'chrome.tabs.query({}).then((tabs) => JSON.stringify(tabs.map((tab) => ({ id: tab.id, opener: tab.openerTabId ?? null, url: tab.url, active: tab.active }))))',
    ).then(JSON.parse);
  const snapshot = () =>
    sw.evaluate('JSON.stringify(globalThis.__TAB_TREE_DEBUG__?.snapshot?.() || null)').then((raw) => JSON.parse(raw || 'null'));

  const tabA = JSON.parse(
    await sw.evaluate(`chrome.tabs.create({ url: ${JSON.stringify(appUrl + '/a')}, active: true }).then((tab) => JSON.stringify({ id: tab.id }))`),
  );
  await waitFor(async () => (await rawTabs()).some((tab) => tab.url === appUrl + '/a'), { label: 'A tab' });
  await sleep(700);

  const byPath = (snap, pathname) => snap?.nodes.find((node) => node.url === appUrl + pathname);
  const nodeName = (snap, tabId) => {
    const node = snap?.nodes.find((item) => item.tabId === tabId);
    return node ? new URL(node.url).pathname : '-';
  };

  // 1. A real foreground link click: A -> B.
  await realClick(port, '/a', '#b');
  await waitFor(async () => (await rawTabs()).some((tab) => tab.url === appUrl + '/b'), { label: 'B tab' });
  await sleep(900);
  let snap = await snapshot();
  let nodeA = byPath(snap, '/a');
  let nodeB = byPath(snap, '/b');
  check(
    'foreground link A -> B is a depth-1 child of A',
    nodeB?.parentId === nodeA?.tabId && nodeB?.depth === 1,
    `B.parent=${nodeName(snap, nodeB?.parentId)} depth=${nodeB?.depth}`,
  );

  // 2. Side panel must render that real link-opened child indented exactly one level.
  const panelTarget = await fetch(`http://127.0.0.1:${port}/json/new?${encodeURIComponent(`chrome-extension://${extensionId}/sidepanel.html`)}`, { method: 'PUT' }).then((response) => response.json());
  const panel = new CDP(panelTarget.webSocketDebuggerUrl);
  await panel.connect();
  await panel.send('Runtime.enable');
  await panel.send('Page.enable');
  clients.push(panel);
  const panelRows = (requiredTitle = 'B child') =>
    waitFor(
      async () => {
        const raw = await panel.evaluate(
          'JSON.stringify([...document.querySelectorAll(".row")].map((row) => ({ depth: Number(row.dataset.depth), parentId: row.dataset.parentId, tabId: Number(row.dataset.tabId), title: row.querySelector(".title")?.textContent || "", indent: row.querySelector(".indent")?.style.width || "" })))',
        );
        const rows = JSON.parse(raw || '[]');
        return rows.some((row) => row.title.includes(requiredTitle)) ? rows : null;
      },
      { label: `panel rows containing ${requiredTitle}` },
    );
  let rows = await panelRows();
  const rowB = rows.find((row) => row.title.includes('B child'));
  const rowA = rows.find((row) => row.title.includes('A root'));
  check(
    'side panel renders B at depth 1 with a 16px indent',
    rowB?.depth === 1 && rowB?.indent === '16px' && String(rowB?.parentId) === String(rowA?.tabId),
    `depth=${rowB?.depth} indent=${rowB?.indent} parent=${rowB?.parentId} A=${rowA?.tabId}`,
  );

  // 3. A second real foreground link from A: both B and C must stay children of A.
  await sw.evaluate(`chrome.tabs.update(${tabA.id}, { active: true })`);
  await sleep(300);
  await realClick(port, '/a', '#c');
  await waitFor(async () => (await rawTabs()).some((tab) => tab.url === appUrl + '/c'), { label: 'C tab' });
  await sleep(900);
  snap = await snapshot();
  nodeA = byPath(snap, '/a');
  nodeB = byPath(snap, '/b');
  const nodeC = byPath(snap, '/c');
  const rawAfterC = await rawTabs();
  const rawB = rawAfterC.find((tab) => tab.url === appUrl + '/b');
  check(
    'two foreground link children both remain under A',
    nodeB?.parentId === nodeA?.tabId && nodeC?.parentId === nodeA?.tabId,
    `B.parent=${nodeName(snap, nodeB?.parentId)} C.parent=${nodeName(snap, nodeC?.parentId)} B.opener=${rawB?.opener ?? 'null'}`,
  );

  // 4. A real foreground link from B: D must be depth 2 (A > B > D).
  await rawTabs().then((tabs) => {
    const tabB = tabs.find((tab) => tab.url === appUrl + '/b');
    return sw.evaluate(`chrome.tabs.update(${tabB.id}, { active: true })`);
  });
  await sleep(300);
  await realClick(port, '/b', '#d');
  await waitFor(async () => (await rawTabs()).some((tab) => tab.url === appUrl + '/d'), { label: 'D tab' });
  await sleep(900);
  snap = await snapshot();
  nodeA = byPath(snap, '/a');
  nodeB = byPath(snap, '/b');
  const nodeD = byPath(snap, '/d');
  check(
    'grandchild D is depth 2 under B under A',
    nodeD?.parentId === nodeB?.tabId && nodeD?.depth === 2 && nodeB?.parentId === nodeA?.tabId,
    `D.depth=${nodeD?.depth} D.parent=${nodeName(snap, nodeD?.parentId)} B.parent=${nodeName(snap, nodeB?.parentId)}`,
  );

  // 5. Background (Cmd on macOS / Ctrl elsewhere) link click from A -> E stays a child.
  await sw.evaluate(`chrome.tabs.update(${tabA.id}, { active: true })`);
  await sleep(300);
  await realClick(port, '/a', '#e', process.platform === 'darwin' ? 4 : 2);
  await waitFor(async () => (await rawTabs()).some((tab) => tab.url === appUrl + '/e'), { label: 'E tab' });
  await sleep(900);
  snap = await snapshot();
  nodeA = byPath(snap, '/a');
  const nodeE = byPath(snap, '/e');
  check(
    'background Cmd/Ctrl+click child E stays under A',
    nodeE?.parentId === nodeA?.tabId && nodeE?.depth === 1,
    `E.parent=${nodeName(snap, nodeE?.parentId)} depth=${nodeE?.depth}`,
  );

  // 6. A tab with no opener is a root sibling of A.
  const tabF = JSON.parse(
    await sw.evaluate(`chrome.tabs.create({ url: ${JSON.stringify(appUrl + '/c?address-bar')}, active: true }).then((tab) => JSON.stringify({ id: tab.id }))`),
  );
  await waitFor(async () => (await rawTabs()).some((tab) => tab.url === appUrl + '/c?address-bar'), { label: 'F tab' });
  await sleep(700);
  snap = await snapshot();
  const nodeF = byPath(snap, '/c?address-bar');
  check('opener-less tab is a root sibling of A', nodeF?.parentId === null && nodeF?.depth === 0, `F.parent=${nodeName(snap, nodeF?.parentId)} depth=${nodeF?.depth}`);
  await sw.evaluate(`chrome.tabs.remove(${tabF.id})`).catch(() => {});

  // 7. Closing the middle parent promotes its child one level: A > D.
  const tabB = (await rawTabs()).find((tab) => tab.url === appUrl + '/b');
  await sw.evaluate(`chrome.tabs.remove(${tabB.id})`);
  await waitFor(async () => !(await rawTabs()).some((tab) => tab.url === appUrl + '/b'), {
    label: 'B closed',
  });
  await sleep(900);
  snap = await snapshot();
  nodeA = byPath(snap, '/a');
  const nodeDAfterClose = byPath(snap, '/d');
  check(
    'closing B promotes D to a depth-1 child of A',
    nodeDAfterClose?.parentId === nodeA?.tabId && nodeDAfterClose?.depth === 1,
    `D.parent=${nodeName(snap, nodeDAfterClose?.parentId)} depth=${nodeDAfterClose?.depth}`,
  );

  // 8. Panel reflects the final tree without losing tabs.
  rows = await panelRows('D grandchild');
  check('panel still renders every real-link tab', rows.length >= 5, `${rows.length} rows`);

  console.log(results.join('\n'));
  console.log(`\n${results.length - failures.length}/${results.length} checks passed`);
  if (failures.length > 0) {
    console.error(`\n${failures.length} failure(s):`);
    for (const failure of failures) console.error(`  - ${failure}`);
    process.exitCode = 1;
  }
} catch (error) {
  console.error(`\nReal-link e2e crashed: ${error.stack || error.message}`);
  if (results.length > 0) console.error(results.join('\n'));
  process.exitCode = 1;
} finally {
  for (const client of clients) client.close();
  try {
    chrome?.kill('SIGTERM');
  } catch {
    /* noop */
  }
  await sleep(300);
  if (server) server.close();
  if (profile && fs.existsSync(profile) && profile.startsWith(path.join(os.tmpdir(), 'tab-tree-e2e-'))) {
    fs.rmSync(profile, { recursive: true, force: true });
  }
}
