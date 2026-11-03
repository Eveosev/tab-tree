#!/usr/bin/env node
/**
 * Real browser-restart restore E2E (AC6).
 *
 * Unlike the unit tests, this closes a real Chrome process and starts it again
 * on the same profile with `--restore-last-session`, so it exercises the whole
 * chain: session-scoped edges -> storage.local snapshot -> restart marker ->
 * URL/order matching -> rebuilt tree in a fresh service worker.
 *
 * Tree: A (root) -> B (link child) -> C (link grandchild). After the restart
 * Chrome no longer knows any opener, so the relations can only come from the
 * restore snapshot.
 *
 * Usage: node scripts/e2e-restart.mjs   (set CHROME_PATH if auto-detect fails)
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import {
  CDP,
  cleanupProfile,
  closeChrome,
  connectPage,
  createChecker,
  launchChrome,
  jsonTargets,
  requireChrome,
  sleep,
  startServer,
  waitFor,
  waitForWorker,
} from './lib/harness.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const extension = path.join(root, 'extension');
const chromePath = requireChrome();

const pages = {
  '/a': {
    title: 'A restore root',
    body: '<p>Root page.</p><a id="to-b" href="/b" target="_blank">Open B</a>',
  },
  '/b': {
    title: 'B restore child',
    body: '<p>Child page.</p><a id="to-c" href="/c" target="_blank">Open C</a>',
  },
  '/c': { title: 'C restore grandchild', body: '<p>Grandchild page.</p>' },
};

const recorder = createChecker('Tab Tree browser-restart restore E2E');
const { check } = recorder;
const clients = [];
let chrome = null;
let base = null;
let server = null;
let profile = null;

function track(client) {
  clients.push(client);
  return client;
}

async function snapshot(sw) {
  return JSON.parse(
    await sw.evaluate('JSON.stringify(globalThis.__TAB_TREE_DEBUG__?.snapshot?.() || null)'),
  );
}

async function clickLink(base, urlPart, selector) {
  const { client } = await connectPage(base, urlPart);
  track(client);
  const rect = JSON.parse(
    await client.evaluate(`(() => {
      const node = document.querySelector(${JSON.stringify(selector)});
      if (!node) return 'null';
      const box = node.getBoundingClientRect();
      return JSON.stringify({ x: box.x + box.width / 2, y: box.y + box.height / 2 });
    })()`),
  );
  if (!rect) throw new Error(`no ${selector} on ${urlPart}`);
  const params = { x: rect.x, y: rect.y, button: 'left', clickCount: 1, modifiers: 0 };
  await client.send('Input.dispatchMouseEvent', { type: 'mousePressed', ...params });
  await client.send('Input.dispatchMouseEvent', { type: 'mouseReleased', ...params });
  client.close();
}

async function launch() {
  const launched = await launchChrome({ chromePath, profile, extension, extraArgs: ['--restore-last-session'] });
  chrome = launched.chrome;
  base = launched.base;
  const worker = await waitForWorker(base);
  return worker;
}

function nodeByPath(snap, appUrl, pathname) {
  return snap?.nodes.find((node) => node.url === appUrl + pathname);
}

try {
  const local = await startServer(pages);
  server = local.server;
  const appUrl = local.url;
  profile = fs.mkdtempSync(path.join(os.tmpdir(), 'tab-tree-restart-e2e-'));

  // ---- First browser session -------------------------------------------
  let worker = await launch();
  let sw = track(worker.client);
  const extensionId = worker.extensionId;
  console.log('Tab Tree browser-restart restore E2E');
  console.log(`  chrome: ${chromePath}`);
  console.log(`  extension: ${extensionId}`);

  const tabA = JSON.parse(
    await sw.evaluate(
      `chrome.tabs.create({ url: ${JSON.stringify(appUrl + '/a')}, active: true }).then((tab) => JSON.stringify({ id: tab.id }))`,
    ),
  );
  await waitFor(async () => (await jsonTargets(base)).some((target) => target.url === appUrl + '/a'), {
    label: 'A page',
  });
  await sleep(700);

  await clickLink(base, '/a', '#to-b');
  await waitFor(async () => (await jsonTargets(base)).some((target) => target.url === appUrl + '/b'), {
    label: 'B page',
  });
  await sleep(900);
  await clickLink(base, '/b', '#to-c');
  await waitFor(async () => (await jsonTargets(base)).some((target) => target.url === appUrl + '/c'), {
    label: 'C page',
  });
  await sleep(900);

  const before = await waitFor(
    async () => {
      const snap = await snapshot(sw);
      const a = nodeByPath(snap, appUrl, '/a');
      const b = nodeByPath(snap, appUrl, '/b');
      const c = nodeByPath(snap, appUrl, '/c');
      return b?.parentId === a?.tabId && c?.parentId === b?.tabId && c?.depth === 2 ? snap : null;
    },
    { label: 'nested tree before restart' },
  );
  check(
    'tree is A > B > C before the restart',
    nodeByPath(before, appUrl, '/b')?.parentId === nodeByPath(before, appUrl, '/a')?.tabId &&
      nodeByPath(before, appUrl, '/c')?.parentId === nodeByPath(before, appUrl, '/b')?.tabId,
  );
  const bBefore = nodeByPath(before, appUrl, '/b');
  const cBefore = nodeByPath(before, appUrl, '/c');
  check(
    'captured creation edges (not live openers) built the tree',
    bBefore?.relation === 'edge' && cBefore?.relation === 'edge',
    `B.relation=${bBefore?.relation} C.relation=${cBefore?.relation}`,
  );

  // Let the debounced storage.local snapshot (900 ms) and session flush settle.
  await sleep(1800);
  const persisted = JSON.parse(
    await sw.evaluate(
      `chrome.storage.local.get('restoreSnapshot').then((value) => {
        const saved = value.restoreSnapshot;
        return JSON.stringify(saved ? { savedAt: saved.savedAt, nodes: saved.nodes.map((node) => ({ url: node.url, parentId: node.parentId })) } : null);
      })`,
    ),
  );
  check(
    'snapshot with parent links is persisted in storage.local',
    Array.isArray(persisted?.nodes) && persisted.nodes.length >= 3 && persisted.nodes.some((node) => node.parentId !== null),
    JSON.stringify(persisted?.nodes),
  );

  // ---- Close the browser completely ------------------------------------
  sw.close();
  await closeChrome(base, chrome);
  chrome = null;
  base = null;
  fs.rmSync(path.join(profile, 'DevToolsActivePort'), { force: true });
  await sleep(1500);

  // ---- Second browser session (real restart) ---------------------------
  worker = await launch();
  sw = track(worker.client);
  check('service worker boots after the restart', Boolean(worker.extensionId));

  // Chrome restores the tabs asynchronously; wait for all three pages.
  await waitFor(
    async () => {
      const urls = (await jsonTargets(base)).map((target) => target.url);
      return ['/a', '/b', '/c'].every((pathname) => urls.includes(appUrl + pathname));
    },
    { timeout: 25_000, label: 'restored pages' },
  );

  const restoredOpeners = JSON.parse(
    await sw.evaluate(
      `chrome.tabs.query({}).then((tabs) => JSON.stringify(tabs
        .filter((tab) => [${JSON.stringify(appUrl + '/a')}, ${JSON.stringify(appUrl + '/b')}, ${JSON.stringify(appUrl + '/c')}].includes(tab.url))
        .map((tab) => ({ url: tab.url, opener: tab.openerTabId ?? null }))))`,
    ),
  );
  check(
    'Chrome restored the three tabs without opener relations',
    restoredOpeners.length === 3 && restoredOpeners.every((tab) => tab.opener === null),
    JSON.stringify(restoredOpeners),
  );

  const after = await waitFor(
    async () => {
      const snap = await snapshot(sw);
      const a = nodeByPath(snap, appUrl, '/a');
      const b = nodeByPath(snap, appUrl, '/b');
      const c = nodeByPath(snap, appUrl, '/c');
      if (!a || !b || !c) return null;
      return b.parentId === a.tabId && c.parentId === b.tabId && c.depth === 2 ? snap : null;
    },
    { timeout: 25_000, label: 'restored tree' },
  ).catch(async () => {
    const snap = await snapshot(sw);
    console.error(
      'restored snapshot:',
      JSON.stringify(snap?.nodes?.map((node) => ({ url: node.url, parent: node.parentId, depth: node.depth }))),
    );
    return null;
  });

  const aAfter = nodeByPath(after, appUrl, '/a');
  const bAfter = nodeByPath(after, appUrl, '/b');
  const cAfter = nodeByPath(after, appUrl, '/c');
  check(
    'A > B > C is rebuilt from the snapshot after restart',
    bAfter?.parentId === aAfter?.tabId && cAfter?.parentId === bAfter?.tabId && cAfter?.depth === 2,
    `B.parent=${bAfter?.parentId} C.parent=${cAfter?.parentId} C.depth=${cAfter?.depth}`,
  );
  check(
    'restored relations carry the inferred badge and reason',
    bAfter?.inferred === true && cAfter?.inferred === true && cAfter?.relation === 'restore',
    `B.inferred=${bAfter?.inferred} C.inferred=${cAfter?.inferred} C.relation=${cAfter?.relation}`,
  );
  const restoreStats = after?.restore?.stats;
  check(
    'restore stats report the matched relations',
    restoreStats?.relations >= 2 && restoreStats?.matchedTabs >= 3,
    JSON.stringify(restoreStats),
  );

  // The panel should show the restored tree with indentation and a summary.
  const panelBefore = new Set((await jsonTargets(base)).map((target) => target.id));
  await sw.evaluate(
    `chrome.tabs.create({ url: ${JSON.stringify(`chrome-extension://${extensionId}/sidepanel.html`)}, active: true })`,
  );
  const target = await waitFor(
    async () => {
      const targets = await jsonTargets(base);
      return (
        targets.find(
          (item) =>
            !panelBefore.has(item.id) &&
            item.type === 'page' &&
            item.url.endsWith('/sidepanel.html'),
        ) || null
      );
    },
    { label: 'restored panel' },
  );
  const panel = new CDP(target.webSocketDebuggerUrl);
  await panel.connect();
  await panel.send('Runtime.enable');
  await panel.send('Page.enable');
  track(panel);
  const rows = await waitFor(
    async () => {
      const raw = await panel.evaluate(
        'JSON.stringify([...document.querySelectorAll(".row")].map((row) => ({ title: row.querySelector(".title")?.textContent || "", depth: Number(row.dataset.depth), indent: row.querySelector(".indent")?.style.width || "" })))',
      );
      const parsed = JSON.parse(raw || '[]');
      return parsed.some((row) => row.title.includes('C restore grandchild')) ? parsed : null;
    },
    { timeout: 15_000, label: 'restored panel rows' },
  );
  const rowA = rows.find((row) => row.title.includes('A restore root'));
  const rowC = rows.find((row) => row.title.includes('C restore grandchild'));
  check(
    'panel renders the restored grandchild two levels deep',
    rowC?.depth === 2 && rowC?.indent === '32px',
    `depth=${rowC?.depth} indent=${rowC?.indent}`,
  );
  const restoreLabel = await panel.evaluate('document.getElementById("restoreInfo")?.textContent || ""');
  check('panel shows the restored-links summary', /2\s+links restored/i.test(restoreLabel), `"${restoreLabel}"`);

  recorder.finish();
} catch (error) {
  console.error(`\nRestart e2e crashed: ${error.stack || error.message}`);
  if (recorder.results.length > 0) console.error(recorder.results.join('\n'));
  process.exitCode = 1;
} finally {
  for (const client of clients) client.close();
  if (chrome) {
    try {
      if (base) await closeChrome(base, chrome);
      else chrome.kill('SIGTERM');
    } catch {
      /* noop */
    }
  }
  await sleep(300);
  if (server) server.close();
  cleanupProfile(profile, 'tab-tree-restart-e2e');
}
