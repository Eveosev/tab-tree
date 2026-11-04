#!/usr/bin/env node
/**
 * End-to-end smoke test against a real Chrome (headless) using CDP only:
 *
 *   1. load extension/ unpacked
 *   2. open a local page, click links to generate real openerTabId relations
 *   3. verify the service worker's snapshot is nested A > B > C (3 levels)
 *   4. open sidepanel.html as a page, verify rows/indentation
 *   5. collapse/expand through the real UI, close a tab, kill the worker
 *   6. save light/dark screenshots to docs/
 *
 * No npm dependencies: Node's global fetch/WebSocket + Chrome DevTools Protocol.
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import {
  terminateExtensionWorker,
  wakeExtensionWorker,
} from './lib/harness.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const extension = path.join(root, 'extension');
const docs = path.join(root, 'docs');

/**
 * Branded Chrome 137+ ignores --load-extension (malware mitigation), so the
 * smoke test prefers Chrome for Testing / Chromium, which keep the flag.
 */
function findChrome() {
  if (process.env.CHROME_PATH) return process.env.CHROME_PATH;
  const candidates = [];
  const playwrightCache = path.join(os.homedir(), 'Library/Caches/ms-playwright');
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
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  );
  return candidates.find((candidate) => fs.existsSync(candidate)) || null;
}

const chromePath = findChrome();
if (!chromePath) {
  console.error('Chrome/Chromium not found. Set CHROME_PATH to run the smoke test.');
  process.exit(1);
}
const isBrandedChrome = chromePath.includes('Google Chrome.app') || chromePath.endsWith('google-chrome');
if (isBrandedChrome && !chromePath.includes('for Testing')) {
  console.warn(
    '! Branded Chrome 137+ ignores --load-extension; if the worker cannot be found,\n' +
      '  set CHROME_PATH to Chrome for Testing or Chromium.',
  );
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function waitFor(fn, { timeout = 15_000, interval = 100, label = 'condition' } = {}) {
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
    this.socket = null;
    this.nextId = 1;
    this.pending = new Map();
    this.listeners = new Map();
    this.closed = false;
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
      let message;
      try {
        message = JSON.parse(event.data);
      } catch {
        return;
      }
      if (message.id && this.pending.has(message.id)) {
        const { resolve, reject } = this.pending.get(message.id);
        this.pending.delete(message.id);
        if (message.error) reject(new Error(`${message.error.message} (${message.error.code})`));
        else resolve(message.result);
        return;
      }
      if (message.method) {
        for (const listener of this.listeners.get(message.method) || []) listener(message.params);
      }
    });
    this.socket.addEventListener('close', () => {
      this.closed = true;
      for (const { reject } of this.pending.values()) reject(new Error('CDP closed'));
      this.pending.clear();
    });
    return this;
  }

  on(method, listener) {
    if (!this.listeners.has(method)) this.listeners.set(method, new Set());
    this.listeners.get(method).add(listener);
    return () => this.listeners.get(method)?.delete(listener);
  }

  send(method, params = {}) {
    if (!this.socket || this.closed) return Promise.reject(new Error('CDP not connected'));
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.socket.send(JSON.stringify({ id, method, params }));
      setTimeout(() => {
        if (this.pending.has(id)) {
          this.pending.delete(id);
          reject(new Error(`${method} timed out`));
        }
      }, 15_000);
    });
  }

  async evaluate(expression, { awaitPromise = true } = {}) {
    const result = await this.send('Runtime.evaluate', {
      expression,
      awaitPromise,
      returnByValue: true,
      userGesture: true,
    });
    if (result.exceptionDetails) {
      const detail = result.exceptionDetails.exception?.description || result.exceptionDetails.text;
      throw new Error(`Evaluation failed: ${detail}`);
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
  '/': {
    title: 'Tree Demo — Root',
    body: `<p>Root page. Links below open tabs whose <code>openerTabId</code> points here.</p>
      <a id="next" href="/article" target="_blank">Open article</a>
      <a href="/docs" target="_blank">Open docs</a>`,
  },
  '/article': {
    title: 'Tree Demo — Article',
    body: `<p>Second level. This link creates a third-level tab.</p>
      <a id="next" href="/comments" target="_blank">Open comments</a>`,
  },
  '/comments': { title: 'Tree Demo — Comments', body: '<p>Third level.</p>' },
  '/docs': { title: 'Tree Demo — Docs', body: '<p>Child of root.</p>' },
  '/other': {
    title: 'Tree Demo — Another Root',
    body: '<p>Opened from the address bar, so it is a sibling of Root.</p><a id="next" href="/other-child" target="_blank">Open child</a>',
  },
  '/other-child': { title: 'Tree Demo — Other Child', body: '<p>Child of another root.</p>' },
};

function startServer() {
  const server = http.createServer((request, response) => {
    const pathname = new URL(request.url, 'http://127.0.0.1').pathname;
    const page = pages[pathname] || pages['/'];
    response.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
    response.end(`<!doctype html><html><head><meta charset="utf-8"><title>${page.title}</title>
      <style>body{font:15px system-ui;padding:32px;max-width:640px;line-height:1.6}a{display:inline-block;margin-right:12px}</style>
      </head><body><h1>${page.title}</h1>${page.body}</body></html>`);
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      resolve({ server, port: server.address().port });
    });
  });
}

async function jsonTargets(base) {
  const response = await fetch(`${base}/json/list`);
  if (!response.ok) throw new Error(`/json/list ${response.status}`);
  return response.json();
}

async function waitForTarget(base, predicate, label) {
  return waitFor(
    async () => {
      const targets = await jsonTargets(base);
      return targets.find((target) => target.type !== 'browser_ui' && predicate(target));
    },
    { timeout: 20_000, label },
  );
}

async function newTab(base, url) {
  const response = await fetch(`${base}/json/new?${encodeURIComponent(url)}`, { method: 'PUT' });
  if (!response.ok) throw new Error(`/json/new ${response.status} for ${url}`);
  return response.json();
}

async function connectTarget(target) {
  const client = new CDP(target.webSocketDebuggerUrl);
  await client.connect();
  await client.send('Runtime.enable');
  return client;
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

  profile = fs.mkdtempSync(path.join(os.tmpdir(), 'tab-tree-smoke-'));
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

  const activePort = await waitFor(
    () => {
      const file = path.join(profile, 'DevToolsActivePort');
      if (!fs.existsSync(file)) return null;
      const [port] = fs.readFileSync(file, 'utf8').trim().split('\n');
      return Number(port) || null;
    },
    { timeout: 20_000, label: 'DevToolsActivePort' },
  );
  const base = `http://127.0.0.1:${activePort}`;

  console.log('Tab Tree smoke test');
  console.log(`  chrome: ${chromePath}`);
  console.log(`  profile: ${profile}`);

  // Several built-in extensions expose `background.js` workers too, so pick the
  // one that answers with our manifest name / debug hook.
  const worker = await waitFor(
    async () => {
      const targets = await jsonTargets(base);
      for (const candidate of targets) {
        if (candidate.type !== 'service_worker' || !candidate.url.startsWith('chrome-extension://')) continue;
        const client = new CDP(candidate.webSocketDebuggerUrl);
        try {
          await client.connect();
          await client.send('Runtime.enable');
          const name = await Promise.race([
            client.evaluate('chrome.runtime.getManifest?.().name || ""'),
            sleep(2000).then(() => null),
          ]);
          if (name === 'Tab Tree') return { target: candidate, client };
        } catch {
          /* not our worker */
        }
        client.close();
      }
      return null;
    },
    { timeout: 20_000, label: 'Tab Tree service worker' },
  );
  const swTarget = worker.target;
  const sw = worker.client;
  clients.push(sw);
  const extensionId = new URL(swTarget.url).host;
  // v0.2.0 opens the setup guide once per profile. Close it so this suite
  // measures the demo tree (and its screenshots) without an onboarding tab.
  for (let attempt = 0; attempt < 3; attempt += 1) {
    await sw
      .evaluate(`chrome.tabs.query({}).then((tabs) => Promise.all(
        tabs.filter((tab) => String(tab.url || '').endsWith('/welcome.html')).map((tab) => chrome.tabs.remove(tab.id))
      ))`)
      .catch(() => {});
    // `onInstalled` creates the guide asynchronously; give it a beat so the
    // second pass can close a tab that was created after the first pass.
    await sleep(300);
  }
  const swErrors = [];
  sw.on('Runtime.exceptionThrown', (params) => swErrors.push(params.exceptionDetails?.text || 'worker exception'));
  if (process.env.DEBUG_SW) {
    sw.on('Runtime.consoleAPICalled', (params) => {
      const text = (params.args || []).map((arg) => arg.value ?? arg.description ?? '').join(' ');
      console.log('  [sw]', text);
    });
  }

  const rootTarget = await newTab(base, `${appUrl}/`);
  const rootClient = await connectTarget(rootTarget);
  clients.push(rootClient);
  await sleep(600);
  check(
    'root page loaded for seeding',
    (await rootClient.evaluate('document.title')) === 'Tree Demo — Root',
    'unexpected title',
  );

  // Deterministic seeding: Chrome/CfT under CDP sometimes opens synthetic
  // target=_blank clicks with `noopener` (no openerTabId), depending on user
  // activation. `chrome.tabs.create({ openerTabId })` exercises the exact same
  // field the engine consumes and keeps the multi-level chain deterministic.
  // A genuine link click is still covered below by the /other-child chain.
  const seeded = JSON.parse(
    await sw.evaluate(`(async () => {
      const all = await chrome.tabs.query({});
      const root = all.find((tab) => String(tab.url).startsWith(${JSON.stringify(appUrl + '/')}) && !tab.url.includes('/docs') && !tab.url.includes('/article') && !tab.url.includes('/comments'));
      if (!root) return JSON.stringify(null);
      await chrome.tabs.update(root.id, { active: true });
      await new Promise((resolve) => setTimeout(resolve, 150));
      const docs = await chrome.tabs.create({ url: ${JSON.stringify(appUrl + '/docs')}, openerTabId: root.id, active: false });
      const article = await chrome.tabs.create({ url: ${JSON.stringify(appUrl + '/article')}, openerTabId: root.id, active: false });
      const comments = await chrome.tabs.create({ url: ${JSON.stringify(appUrl + '/comments')}, openerTabId: article.id, active: false });
      return JSON.stringify({ root: root.id, docs: docs.id, article: article.id, comments: comments.id });
    })()`),
  );
  check('seeded root/docs/article/comments tabs', Boolean(seeded?.root), JSON.stringify(seeded));
  if (!seeded?.root) throw new Error('could not seed the tab chain');

  // No debug/override seeding here: `tabs.onCreated` must capture the
  // `openerTabId` of each created tab before Chrome clears it. The real
  // foreground-click case (two children, grandchild depth 2) lives in
  // scripts/e2e-real-links.mjs.
  const reparented = JSON.parse(
    await sw.evaluate(`(async () => {
      await new Promise((resolve) => setTimeout(resolve, 300));
      return JSON.stringify(
        globalThis.__TAB_TREE_DEBUG__.snapshot().nodes.map((node) => ({
          id: node.tabId,
          parent: node.parentId,
          depth: node.depth,
        })),
      );
    })()`),
  );
  const reparentedById = new Map(reparented.map((node) => [node.id, node]));
  check(
    'captured creation edges build a three-level chain',
    reparentedById.get(seeded.article)?.parent === seeded.root &&
      reparentedById.get(seeded.article)?.depth === 1 &&
      reparentedById.get(seeded.comments)?.parent === seeded.article &&
      reparentedById.get(seeded.comments)?.depth === 2,
    JSON.stringify(reparented),
  );

  const otherTarget = await newTab(base, `${appUrl}/other`);
  const otherClient = await connectTarget(otherTarget);
  clients.push(otherClient);
  await waitFor(async () => (await otherClient.evaluate('document.readyState')) === 'complete', { label: 'other load' });
  await otherClient.evaluate('document.querySelector("#next")?.click()');

  const snapshot = await waitFor(
    async () => {
      const raw = await sw.evaluate('JSON.stringify(globalThis.__TAB_TREE_DEBUG__?.snapshot?.() || null)');
      const value = JSON.parse(raw || 'null');
      if (!value) return null;
      const paths = new Set(value.nodes.map((node) => new URL(node.url).pathname));
      const byId = new Map(value.nodes.map((node) => [node.tabId, node]));
      const complete = ['/article', '/comments', '/docs', '/other', '/other-child'].every((p) => paths.has(p));
      const nested =
        byId.get(seeded.article)?.parentId === seeded.root &&
        byId.get(seeded.comments)?.parentId === seeded.article;
      return complete && nested ? value : null;
    },
    { timeout: 20_000, label: 'opener tree' },
  ).catch(async (error) => {
    const dump = await sw.evaluate(
      'JSON.stringify(globalThis.__TAB_TREE_DEBUG__?.snapshot?.() || null)',
    ).catch(() => '{}');
    console.error('opener-tree timeout snapshot:', dump);
    const tabs = await sw.evaluate(
      'chrome.tabs.query({}).then((ts) => JSON.stringify(ts.map((t) => ({ id: t.id, url: t.url, opener: t.openerTabId ?? null }))))',
    ).catch(() => '[]');
    console.error('opener-tree timeout raw tabs:', tabs);
    throw error;
  });

  if (process.env.DEBUG_TREE) {
    console.log('seeded:', seeded);
    console.log(
      'raw tabs:',
      await sw.evaluate(
        'chrome.tabs.query({}).then((ts) => JSON.stringify(ts.map((t) => ({ id: t.id, url: t.url, opener: t.openerTabId, windowId: t.windowId }))))',
      ),
    );
    console.log(
      'nodes:',
      snapshot.nodes.map((node) => ({
        url: node.url,
        id: node.tabId,
        opener: node.openerTabId,
        parent: node.parentId,
        depth: node.depth,
      })),
    );
  }

  await waitFor(
    async () => (await sw.evaluate('Boolean(globalThis.__TAB_TREE_DEBUG__)')) === true,
    { label: 'debug hook' },
  );
  const manifest = JSON.parse(await sw.evaluate('JSON.stringify(chrome.runtime.getManifest())'));
  check('extension service worker is running', Boolean(extensionId), extensionId);
  check('manifest v3 + side panel', manifest.manifest_version === 3 && Boolean(manifest.side_panel), manifest.side_panel?.default_path);
  check(
    'permissions are minimal (tabs, sidePanel, storage, webNavigation)',
    JSON.stringify(manifest.permissions) === '["tabs","sidePanel","storage","webNavigation"]',
    JSON.stringify(manifest.permissions),
  );

  const byPath = (pathname) =>
    snapshot.nodes.find((node) => {
      try {
        return new URL(node.url).pathname === pathname;
      } catch {
        return false;
      }
    });
  const rootNode = byPath('/');
  const articleNode = byPath('/article');
  const commentsNode = byPath('/comments');
  const docsNode = byPath('/docs');
  const otherNode = byPath('/other');
  const otherChildNode = byPath('/other-child');

  check('root page is depth 0', rootNode?.depth === 0 && rootNode?.parentId === null);
  check('child tab is depth 1', docsNode?.parentId === rootNode?.tabId && docsNode?.depth === 1);
  check('second child is a sibling', articleNode?.parentId === rootNode?.tabId && articleNode?.depth === 1);
  check('grandchild is depth 2', commentsNode?.parentId === articleNode?.tabId && commentsNode?.depth === 2);
  check('address-bar tab is a root', otherNode?.parentId === null && otherNode?.depth === 0);
  check(
    'real link click produced openerTabId and a depth-1 child',
    otherChildNode?.parentId === otherNode?.tabId &&
      otherChildNode?.depth === 1 &&
      otherChildNode?.openerTabId === otherNode?.tabId,
    `opener=${otherChildNode?.openerTabId} parent=${otherChildNode?.parentId}`,
  );
  check(
    'native strip order matches DFS',
    snapshot.nodes
      .filter((node) => node.windowId === rootNode?.windowId)
      .map((node) => node.order)
      .join(',') ===
      snapshot.nodes
        .filter((node) => node.windowId === rootNode?.windowId)
        .map((node) => node.order)
        .sort((a, b) => a - b)
        .join(','),
  );

  // ---------------------------------------------------------------------
  // Side panel as a normal tab (sidePanel API itself is not drivable in
  // headless, but this is the exact same document the panel renders).
  // ---------------------------------------------------------------------
  const panelTarget = await newTab(base, `chrome-extension://${extensionId}/sidepanel.html`);
  const panel = await connectTarget(panelTarget);
  clients.push(panel);
  const panelErrors = [];
  panel.on('Runtime.exceptionThrown', (params) =>
    panelErrors.push(params.exceptionDetails?.exception?.description || params.exceptionDetails?.text || 'panel exception'),
  );
  await panel.send('Page.enable');

  const waitForRows = async (minimum) =>
    waitFor(
      async () => {
        const rows = await panel.evaluate(
          'JSON.stringify([...document.querySelectorAll(".row")].map((row) => ({ depth: Number(row.dataset.depth), parentId: row.dataset.parentId, tabId: Number(row.dataset.tabId), title: row.querySelector(".title")?.textContent || "" })))',
        );
        const parsed = JSON.parse(rows || '[]');
        return parsed.length >= minimum ? parsed : null;
      },
      { timeout: 10_000, label: `${minimum} panel rows` },
    );

  let rows = await waitForRows(6);
  // `/json/new` attaches the new page to the currently active tab as its opener;
  // normalize the panel's own tab to a root so the screenshot shows the tree,
  // not test harness noise.
  const panelTabRow = rows.find((row) => row.title.trim() === 'Tab Tree');
  if (panelTabRow) {
    await sw.evaluate(`globalThis.__TAB_TREE_DEBUG__.setParent(${panelTabRow.tabId}, null)`).catch(() => {});
    await sleep(200);
    rows = await waitForRows(6);
  }
  const panelRoot = rows.find((row) => row.title.includes('Tree Demo — Root'));
  const panelArticle = rows.find((row) => row.title.includes('Tree Demo — Article'));
  const panelComments = rows.find((row) => row.title.includes('Tree Demo — Comments'));
  check('side panel renders every tab', rows.length >= 6, `${rows.length} rows`);
  check('side panel indents the child one level', panelArticle?.depth === 1 && panelRoot?.depth === 0);
  check(
    'side panel carries data-parent-id for the child',
    String(panelArticle?.parentId) === String(panelRoot?.tabId),
    `${panelArticle?.parentId} vs ${panelRoot?.tabId}`,
  );
  check('side panel indents the grandchild two levels', panelComments?.depth === 2);

  // Screenshots: light + dark at a realistic side-panel size.
  fs.mkdirSync(docs, { recursive: true });
  await panel.send('Emulation.setDeviceMetricsOverride', {
    width: 380,
    height: 760,
    deviceScaleFactor: 2,
    mobile: false,
  });
  for (const theme of ['light', 'dark']) {
    await panel.send('Emulation.setEmulatedMedia', {
      features: [{ name: 'prefers-color-scheme', value: theme }],
    });
    await sleep(250);
    const shot = await panel.send('Page.captureScreenshot', { format: 'png' });
    const file = path.join(docs, `screenshot-${theme}.png`);
    fs.writeFileSync(file, Buffer.from(shot.data, 'base64'));
    results.push(`  ✔ screenshot: ${path.relative(root, file)}`);
  }

  // Collapse the root through the actual twisty button, then expand it back.
  // Assert by tab title, not by total row count: Chrome's onboarding tab and
  // the panel tab itself are real tabs, so the absolute count is not stable.
  const clickedCollapse = await panel.evaluate(`(() => {
    const row = [...document.querySelectorAll('.row')].find((item) => {
      const title = item.querySelector('.title')?.textContent || '';
      return Number(item.dataset.depth) === 0 && title.includes('Tree Demo — Root');
    });
    if (!row) return false;
    row.querySelector('.twisty')?.click();
    return true;
  })()`);
  check('root twisty is clickable', clickedCollapse === true);
  const collapseTitles = async () =>
    JSON.parse(
      await panel.evaluate(
        'JSON.stringify([...document.querySelectorAll(".row .title")].map((title) => title.textContent || ""))',
      ),
    );
  await waitFor(
    async () => {
      const titles = await collapseTitles();
      return (
        titles.some((title) => title.includes('Tree Demo — Root')) &&
        !titles.some(
          (title) =>
            title.includes('Tree Demo — Docs') ||
            title.includes('Tree Demo — Article') ||
            title.includes('Tree Demo — Comments'),
        )
      );
    },
    { timeout: 8000, label: 'collapsed rows' },
  );
  const collapsedTitles = await collapseTitles();
  check(
    'collapse hides descendants',
    !collapsedTitles.some(
      (title) => title.includes('Tree Demo — Docs') || title.includes('Tree Demo — Article'),
    ),
    `${collapsedTitles.length} rows visible`,
  );
  const collapsedInWorker = await waitFor(
    async () => {
      const raw = await sw.evaluate('JSON.stringify(globalThis.__TAB_TREE_DEBUG__?.snapshot?.() || null)');
      const value = JSON.parse(raw || 'null');
      const rootNode = value?.nodes.find((node) => {
        try {
          return new URL(node.url).pathname === '/';
        } catch {
          return false;
        }
      });
      return rootNode?.collapsed ? value : null;
    },
    { timeout: 8000, label: 'worker collapse state' },
  ).catch(() => null);
  check('collapse is persisted in the worker', Boolean(collapsedInWorker));

  await panel.evaluate(`(() => {
    const row = [...document.querySelectorAll('.row')].find((item) => Number(item.dataset.depth) === 0 && (item.querySelector('.title')?.textContent || '').includes('Tree Demo — Root'));
    row?.querySelector('.twisty')?.click();
  })()`);
  await waitFor(
    async () => {
      const titles = await collapseTitles();
      return titles.some((title) => title.includes('Tree Demo — Comments'));
    },
    { timeout: 8000, label: 'expanded rows' },
  );
  rows = await waitForRows(6);
  check('expand restores the full subtree', rows.some((row) => row.title.includes('Tree Demo — Comments')));

  // Close a tab from the panel and verify it leaves both UI and worker.
  const closed = await panel.evaluate(`(() => {
    const row = [...document.querySelectorAll('.row')].find((item) => (item.querySelector('.title')?.textContent || '').includes('Tree Demo — Other Child'));
    if (!row) return false;
    row.querySelector('.close-btn')?.click();
    return true;
  })()`);
  check('close button is available', closed === true);
  await waitFor(
    async () => {
      const raw = await sw.evaluate('JSON.stringify(globalThis.__TAB_TREE_DEBUG__?.snapshot?.() || null)');
      const value = JSON.parse(raw || 'null');
      return value && !value.nodes.some((node) => node.url.endsWith('/other-child')) ? value : null;
    },
    { timeout: 8000, label: 'tab close' },
  );
  check('closing a tab updates the worker tree', true);

  // The restore snapshot is debounced by 900 ms. Give it time to settle so the
  // wake below has a snapshot that the unfixed code would incorrectly replay.
  await sleep(1200);
  const persistedBeforeKill = JSON.parse(
    await sw.evaluate(`chrome.storage.local.get('restoreSnapshot').then((value) => {
      const saved = value.restoreSnapshot;
      return JSON.stringify(saved ? { nodes: saved.nodes.length, withParent: saved.nodes.filter((node) => node.parentId !== null).length } : null);
    })`),
  );
  check(
    'restore snapshot with parent links is persisted before termination',
    persistedBeforeKill && persistedBeforeKill.nodes >= 5 && persistedBeforeKill.withParent >= 1,
    JSON.stringify(persistedBeforeKill),
  );

  // A manual reparent right before the kill: a plain worker wake must not
  // replay an older snapshot relation over it.
  await sw.evaluate(`globalThis.__TAB_TREE_DEBUG__.setParent(${docsNode.tabId}, null)`);
  await sleep(300);

  const nodeUrls = (snapshot) => new Map(snapshot.nodes.map((node) => [node.tabId, node.url || '']));
  const scopedRelations = (entries, urls) =>
    [...entries]
      .filter(([child, parent]) => {
        const childUrl = urls.get(child) || '';
        if (childUrl.startsWith('chrome-extension://')) return false;
        if (parent === null) return true;
        return !(urls.get(parent) || '').startsWith('chrome-extension://');
      })
      .sort((a, b) => a[0] - b[0]);

  const killedState = JSON.parse(
    await sw.evaluate(`(async () => {
      const session = await chrome.storage.session.get(['sessionMarker', 'overrides', 'edges', 'inferred']);
      const local = await chrome.storage.local.get('restoreStats');
      const snapshot = globalThis.__TAB_TREE_DEBUG__.snapshot();
      return JSON.stringify({
        marker: session.sessionMarker ?? null,
        overrides: session.overrides ?? [],
        edges: session.edges ?? [],
        inferred: session.inferred ?? [],
        restoreStats: local.restoreStats ?? null,
        nodes: snapshot.nodes.map((node) => ({
          id: node.tabId,
          url: node.url,
          parentId: node.parentId,
          depth: node.depth,
          relation: node.relation,
          inferred: node.inferred,
        })),
      });
    })()`),
  );
  const killedById = new Map(killedState.nodes.map((node) => [node.id, node]));
  check(
    'session marker exists before the worker is terminated',
    Number.isInteger(killedState.marker),
    String(killedState.marker),
  );
  check(
    'creation relations are edge-derived (not inferred) before termination',
    killedById.get(seeded.article)?.relation === 'edge' &&
      killedById.get(seeded.comments)?.relation === 'edge' &&
      killedById.get(seeded.article)?.inferred === false &&
      killedById.get(seeded.comments)?.inferred === false,
    JSON.stringify({
      article: killedById.get(seeded.article)?.relation,
      comments: killedById.get(seeded.comments)?.relation,
    }),
  );
  check('no restore statistics exist before the worker is terminated', killedState.restoreStats === null);
  const killedUrls = nodeUrls({ nodes: killedState.nodes });
  const killedRelations = {
    overrides: scopedRelations(killedState.overrides, killedUrls),
    edges: scopedRelations(killedState.edges, killedUrls),
  };
  check(
    'manual override is persisted before termination',
    killedState.overrides.some(([child, parent]) => child === docsNode.tabId && parent === null),
    JSON.stringify(killedRelations.overrides),
  );

  // Kill the service worker for real: close the panel target first so its port
  // cannot keep the worker alive, then prove the old target id disappears.
  sw.close();
  const terminated = await terminateExtensionWorker(base, {
    extensionId,
    targetId: swTarget.id,
  }).catch((error) => ({ error: error.message }));
  if (terminated?.error) throw new Error(`could not terminate the service worker: ${terminated.error}`);
  check(
    'service worker target actually disappears after termination',
    terminated.method === 'idle-reclaim' && terminated.elapsed < 75_000,
    `${terminated.method} in ${terminated.elapsed} ms`,
  );

  // Wake it through a new panel document and prove Chrome created a new worker.
  const revivedWorker = await wakeExtensionWorker(base, {
    extensionId,
    oldTargetId: swTarget.id,
  });
  const revivedSw = revivedWorker.client;
  clients.push(revivedSw);
  revivedSw.on('Runtime.exceptionThrown', (params) =>
    swErrors.push(params.exceptionDetails?.text || 'worker exception'),
  );
  check(
    'service worker restarts with a different target id',
    revivedWorker.target.id !== swTarget.id,
    `${swTarget.id} -> ${revivedWorker.target.id}`,
  );

  const revivedSnapshot = await waitFor(
    async () => {
      const raw = await revivedSw.evaluate('JSON.stringify(globalThis.__TAB_TREE_DEBUG__?.snapshot?.() || null)');
      const value = JSON.parse(raw || 'null');
      return value && value.nodes.some((node) => String(node.url).endsWith('/comments')) ? value : null;
    },
    { timeout: 15_000, label: 'snapshot after worker wake' },
  );
  const revivedById = new Map(revivedSnapshot.nodes.map((node) => [node.tabId, node]));
  check(
    'worker wake does not replay the restore snapshot',
    revivedSnapshot.restore === null,
    JSON.stringify(revivedSnapshot.restore),
  );
  check(
    'worker wake leaves no inferred/restore nodes behind',
    revivedSnapshot.nodes.every((node) => node.inferred !== true && node.relation !== 'restore'),
    JSON.stringify(
      revivedSnapshot.nodes
        .filter((node) => node.inferred === true || node.relation === 'restore')
        .map((node) => ({ url: node.url, relation: node.relation, inferred: node.inferred })),
    ),
  );
  check(
    'worker wake preserves the captured creation edges',
    revivedById.get(seeded.article)?.parentId === seeded.root &&
      revivedById.get(seeded.comments)?.parentId === seeded.article &&
      revivedById.get(seeded.article)?.relation === 'edge' &&
      revivedById.get(seeded.comments)?.relation === 'edge',
    JSON.stringify({
      article: revivedById.get(seeded.article)?.relation,
      comments: revivedById.get(seeded.comments)?.relation,
    }),
  );
  check(
    'worker wake keeps the manual override',
    revivedById.get(docsNode.tabId)?.parentId === null &&
      revivedById.get(docsNode.tabId)?.relation === 'root',
    JSON.stringify({
      parent: revivedById.get(docsNode.tabId)?.parentId,
      relation: revivedById.get(docsNode.tabId)?.relation,
    }),
  );

  // The worker writes the merged session state right after load; give that
  // write a moment to land before comparing it with the pre-kill snapshot.
  await sleep(500);
  const revivedSession = JSON.parse(
    await revivedSw.evaluate(`(async () => {
      const session = await chrome.storage.session.get(['sessionMarker', 'overrides', 'edges', 'inferred']);
      const local = await chrome.storage.local.get('restoreStats');
      return JSON.stringify({
        marker: session.sessionMarker ?? null,
        overrides: session.overrides ?? [],
        edges: session.edges ?? [],
        inferred: session.inferred ?? [],
        restoreStats: local.restoreStats ?? null,
      });
    })()`),
  );
  const revivedUrls = nodeUrls(revivedSnapshot);
  check(
    'session marker is unchanged across the worker wake',
    revivedSession.marker === killedState.marker,
    `${killedState.marker} -> ${revivedSession.marker}`,
  );
  check(
    'overrides and edges are identical across the worker wake',
    JSON.stringify(scopedRelations(revivedSession.overrides, revivedUrls)) ===
      JSON.stringify(killedRelations.overrides) &&
      JSON.stringify(scopedRelations(revivedSession.edges, revivedUrls)) ===
        JSON.stringify(killedRelations.edges),
    JSON.stringify({
      overrides: scopedRelations(revivedSession.overrides, revivedUrls),
      edges: scopedRelations(revivedSession.edges, revivedUrls),
    }),
  );
  check('worker wake does not write restore statistics', revivedSession.restoreStats === null);

  // The panel reopened by the wake helper must render the live tree with no
  // restored badges and no "N links restored" footer.
  const revivedPanelTarget = await waitForTarget(
    base,
    (target) => target.type === 'page' && target.url.endsWith('/sidepanel.html'),
    'revived panel',
  );
  const revivedPanel = await connectTarget(revivedPanelTarget);
  clients.push(revivedPanel);
  revivedPanel.on('Runtime.exceptionThrown', (params) =>
    panelErrors.push(params.exceptionDetails?.exception?.description || params.exceptionDetails?.text || 'panel exception'),
  );
  const revivedPanelState = await waitFor(
    async () => {
      const raw = await revivedPanel.evaluate(`JSON.stringify({
        rows: [...document.querySelectorAll('.row')].map((row) => row.querySelector('.title')?.textContent || ''),
        inferredBadges: document.querySelectorAll('.badge.is-inferred').length,
        footer: document.getElementById('restoreInfo')?.textContent || ''
      })`);
      const value = JSON.parse(raw || '{}');
      return value.rows?.some((title) => title.includes('Tree Demo — Root')) ? value : null;
    },
    { timeout: 15_000, label: 'panel recovery after worker kill' },
  );
  check('panel recovers after worker termination', revivedPanelState.rows.length >= 5, `${revivedPanelState.rows.length} rows`);
  check(
    'panel shows no restored badges after a plain worker wake',
    revivedPanelState.inferredBadges === 0,
    `${revivedPanelState.inferredBadges} badge(s)`,
  );
  check(
    'panel shows no restored-links footer after a plain worker wake',
    revivedPanelState.footer.trim() === '',
    JSON.stringify(revivedPanelState.footer),
  );

  await sleep(300);
  check('no panel runtime exceptions', panelErrors.length === 0, panelErrors.join('; '));
  check('no service worker runtime exceptions', swErrors.length === 0, swErrors.join('; '));

  console.log(results.join('\n'));
  console.log(`\n${results.length - failures.length}/${results.length} checks passed`);
  if (failures.length > 0) {
    console.error(`\n${failures.length} failure(s):`);
    for (const failure of failures) console.error(`  - ${failure}`);
    process.exitCode = 1;
  }
} catch (error) {
  console.error(`\nSmoke test crashed: ${error.stack || error.message}`);
  if (results.length > 0) console.error(results.join('\n'));
  process.exitCode = 1;
} finally {
  for (const client of clients) client.close();
  try {
    chrome?.kill('SIGTERM');
  } catch {
    /* noop */
  }
  await sleep(400);
  if (server) server.close();
  if (profile && fs.existsSync(profile) && profile.startsWith(path.join(os.tmpdir(), 'tab-tree-smoke-'))) {
    fs.rmSync(profile, { recursive: true, force: true });
  }
}
