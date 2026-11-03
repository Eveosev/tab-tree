#!/usr/bin/env node
/**
 * Side-panel interaction E2E (dependency-free, real pointer input).
 *
 * Covers the two acceptance criteria that were previously only unit-tested:
 *
 *  AC7  drag-and-drop reparenting through real `Input.dispatchMouseEvent`
 *       pointer events: root -> child, child -> top-level, and cycle rejection;
 *  AC5  the panel is bound to the window that hosts it: a second window gets
 *       its own panel, its own rows, and the window picker selects that window
 *       even while another window has focus.
 *
 * Usage: node scripts/e2e-panel.mjs   (set CHROME_PATH if auto-detect fails)
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
  jsonTargets,
  launchChrome,
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
  '/a': { title: 'A root', body: '<p>Root A.</p>' },
  '/b': { title: 'B child', body: '<p>Child B.</p>' },
  '/f': { title: 'F floating root', body: '<p>Independent root F.</p>' },
  '/w2': { title: 'Window two root', body: '<p>Lives in the second window.</p>' },
  '/w2-child': { title: 'Window two child', body: '<p>Child in the second window.</p>' },
};

const recorder = createChecker('Tab Tree panel interaction E2E');
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

/** Row rectangles and metadata as rendered by the panel. */
async function panelRows(panel) {
  const raw = await panel.evaluate(
    'JSON.stringify([...document.querySelectorAll(".row")].map((row) => {' +
      'const box = row.getBoundingClientRect();' +
      'return { tabId: Number(row.dataset.tabId), parentId: row.dataset.parentId, depth: Number(row.dataset.depth),' +
      'title: row.querySelector(".title")?.textContent || "", indent: row.querySelector(".indent")?.style.width || "",' +
      'x: box.x + box.width / 2, y: box.y + box.height / 2, height: box.height };' +
      '}))',
  );
  return JSON.parse(raw || '[]');
}

async function waitForRows(panel, predicate, label, timeout = 12_000) {
  return waitFor(
    async () => {
      const rows = await panelRows(panel);
      return predicate(rows) ? rows : null;
    },
    { timeout, label },
  );
}

async function mouse(panel, type, x, y, { buttons = 0, button = 'left', clickCount = 1 } = {}) {
  await panel.send('Input.dispatchMouseEvent', {
    type,
    x,
    y,
    button,
    buttons,
    clickCount,
    modifiers: 0,
  });
}

/** Drag one row onto another row with stepped pointer movement. */
async function dragRowToRow(panel, sourceTitle, targetTitle) {
  const rows = await waitForRows(
    panel,
    (items) => items.some((row) => row.title.includes(sourceTitle)) && items.some((row) => row.title.includes(targetTitle)),
    `rows ${sourceTitle} and ${targetTitle}`,
  );
  const source = rows.find((row) => row.title.includes(sourceTitle));
  const target = rows.find((row) => row.title.includes(targetTitle));
  await mouse(panel, 'mousePressed', source.x, source.y, { buttons: 1, clickCount: 1 });
  const steps = 8;
  for (let step = 1; step <= steps; step += 1) {
    const x = source.x + ((target.x - source.x) * step) / steps;
    const y = source.y + ((target.y - source.y) * step) / steps;
    await mouse(panel, 'mouseMoved', x, y, { buttons: 1 });
    await sleep(20);
  }
  await sleep(80);
  await mouse(panel, 'mouseReleased', target.x, target.y, { buttons: 0, clickCount: 1 });
}

/** Drag a row onto the floating "make top-level" drop zone. */
async function dragRowToRootZone(panel, sourceTitle) {
  const rows = await waitForRows(
    panel,
    (items) => items.some((row) => row.title.includes(sourceTitle)),
    `row ${sourceTitle}`,
  );
  const source = rows.find((row) => row.title.includes(sourceTitle));
  await mouse(panel, 'mousePressed', source.x, source.y, { buttons: 1, clickCount: 1 });
  await mouse(panel, 'mouseMoved', source.x + 16, source.y + 6, { buttons: 1 });
  await sleep(120);
  const zone = JSON.parse(
    await panel.evaluate(`(() => {
      const node = document.getElementById('rootDrop');
      if (!node || node.hidden) return 'null';
      const box = node.getBoundingClientRect();
      return JSON.stringify({ x: box.x + box.width / 2, y: box.y + box.height / 2 });
    })()`),
  );
  if (!zone) throw new Error('root drop zone did not appear');
  for (let step = 1; step <= 6; step += 1) {
    const x = source.x + 16 + ((zone.x - source.x - 16) * step) / 6;
    const y = source.y + 6 + ((zone.y - source.y - 6) * step) / 6;
    await mouse(panel, 'mouseMoved', x, y, { buttons: 1 });
    await sleep(20);
  }
  await sleep(80);
  await mouse(panel, 'mouseReleased', zone.x, zone.y, { buttons: 0, clickCount: 1 });
}

async function workerSnapshot(sw) {
  return JSON.parse(
    await sw.evaluate('JSON.stringify(globalThis.__TAB_TREE_DEBUG__?.snapshot?.() || null)'),
  );
}

function nodeByPath(snapshot, appUrl, pathname) {
  return snapshot?.nodes.find((node) => node.url === appUrl + pathname);
}

/** Open the panel document as a normal tab in a given window. */
async function openPanel(sw, base, extensionId, windowId) {
  const before = new Set((await jsonTargets(base)).map((target) => target.id));
  const tab = JSON.parse(
    await sw.evaluate(
      `chrome.tabs.create({ url: ${JSON.stringify(
        `chrome-extension://${extensionId}/sidepanel.html?auto=1`,
      )}, active: true, windowId: ${windowId} }).then((tab) => JSON.stringify({ id: tab.id, windowId: tab.windowId }))`,
    ),
  );
  const target = await waitFor(
    async () => {
      const targets = await jsonTargets(base);
      return (
        targets.find(
          (item) =>
            !before.has(item.id) &&
            item.type === 'page' &&
            item.url.includes('/sidepanel.html') &&
            item.url.startsWith('chrome-extension://'),
        ) || null
      );
    },
    { label: 'panel target' },
  );
  const panel = new CDP(target.webSocketDebuggerUrl);
  await panel.connect();
  await panel.send('Runtime.enable');
  await panel.send('Page.enable');
  track(panel);
  return { panel, tab, target };
}

try {
  const local = await startServer(pages);
  server = local.server;
  const appUrl = local.url;

  profile = fs.mkdtempSync(path.join(os.tmpdir(), 'tab-tree-panel-e2e-'));
  const launched = await launchChrome({ chromePath, profile, extension });
  chrome = launched.chrome;
  base = launched.base;

  const worker = await waitForWorker(base);
  const sw = track(worker.client);
  const extensionId = worker.extensionId;
  console.log('Tab Tree panel interaction E2E');
  console.log(`  chrome: ${chromePath}`);
  console.log(`  extension: ${extensionId}`);

  // Deterministic fixture: A root, B child, F independent root in window one.
  const seeded = JSON.parse(
    await sw.evaluate(`(async () => {
      const a = await chrome.tabs.create({ url: ${JSON.stringify(appUrl + '/a')}, active: true });
      await new Promise((resolve) => setTimeout(resolve, 200));
      const b = await chrome.tabs.create({ url: ${JSON.stringify(appUrl + '/b')}, openerTabId: a.id, active: false });
      const f = await chrome.tabs.create({ url: ${JSON.stringify(appUrl + '/f')}, active: false });
      return JSON.stringify({ a: a.id, b: b.id, f: f.id, windowId: a.windowId });
    })()`),
  );
  await waitFor(
    async () => {
      const snapshot = await workerSnapshot(sw);
      const nodeB = nodeByPath(snapshot, appUrl, '/b');
      return nodeB && nodeB.parentId === seeded.a ? snapshot : null;
    },
    { label: 'seeded tree' },
  );

  // Panel bound to window one.
  const panelOne = await openPanel(sw, base, extensionId, seeded.windowId);
  let rows = await waitForRows(
    panelOne.panel,
    (items) =>
      items.some((row) => row.tabId === seeded.f) && items.some((row) => row.tabId === seeded.a),
    'seeded rows in panel one',
  );
  check('panel renders seeded rows', rows.length >= 3, `${rows.length} rows`);
  const rowB = rows.find((row) => row.tabId === seeded.b);
  check('seeded child is indented one level', rowB?.depth === 1 && rowB?.indent === '16px', `depth=${rowB?.depth} indent=${rowB?.indent}`);
  const rowFBefore = rows.find((row) => row.tabId === seeded.f);
  check('independent tab starts as a root', rowFBefore?.depth === 0 && rowFBefore?.parentId === '', `depth=${rowFBefore?.depth} parent=${rowFBefore?.parentId}`);

  // AC7a: drag the root F onto A -> F becomes a child of A.
  await dragRowToRow(panelOne.panel, 'F floating root', 'A root');
  const afterDrag = await waitFor(
    async () => {
      const snapshot = await workerSnapshot(sw);
      const nodeF = nodeByPath(snapshot, appUrl, '/f');
      return nodeF?.parentId === seeded.a && nodeF?.relation === 'manual' ? snapshot : null;
    },
    { timeout: 10_000, label: 'drag reparent to A' },
  ).catch(async () => {
    const snapshot = await workerSnapshot(sw);
    console.error('drag snapshot:', JSON.stringify(snapshot?.nodes?.map((node) => ({ id: node.tabId, parent: node.parentId, depth: node.depth }))));
    return null;
  });
  const draggedF = afterDrag ? nodeByPath(afterDrag, appUrl, '/f') : null;
  check(
    'pointer drag nests F under A',
    draggedF?.parentId === seeded.a && draggedF?.depth === 1 && draggedF?.relation === 'manual',
    `parent=${draggedF?.parentId} depth=${draggedF?.depth} relation=${draggedF?.relation}`,
  );
  rows = await waitForRows(
    panelOne.panel,
    (items) => items.find((row) => row.tabId === seeded.f)?.depth === 1,
    'panel indent after drag',
  );
  check('panel re-renders the dragged row one level deep', rows.find((row) => row.tabId === seeded.f)?.indent === '16px');

  // AC7b: drag F onto the floating top-level zone -> F is a root again.
  await dragRowToRootZone(panelOne.panel, 'F floating root');
  const afterRootDrop = await waitFor(
    async () => {
      const snapshot = await workerSnapshot(sw);
      const nodeF = nodeByPath(snapshot, appUrl, '/f');
      return nodeF?.parentId === null && nodeF?.depth === 0 ? snapshot : null;
    },
    { timeout: 10_000, label: 'drag reparent to root' },
  ).catch(() => null);
  const rootedF = afterRootDrop ? nodeByPath(afterRootDrop, appUrl, '/f') : null;
  check('drop on the top-level zone un-nests F', rootedF?.parentId === null && rootedF?.depth === 0, `parent=${rootedF?.parentId} depth=${rootedF?.depth}`);

  // AC7c: dragging A onto its descendant B must be rejected (cycle) with a toast.
  await dragRowToRow(panelOne.panel, 'A root', 'B child');
  const toastText = await waitFor(
    async () => {
      const visible = await panelOne.panel.evaluate(`(() => {
        const node = document.getElementById('toast');
        return node && !node.hidden ? node.textContent : '';
      })()`);
      return visible || null;
    },
    { timeout: 6000, label: 'cycle rejection toast' },
  ).catch(() => '');
  const afterCycle = await workerSnapshot(sw);
  const nodeA = nodeByPath(afterCycle, appUrl, '/a');
  const nodeB = nodeByPath(afterCycle, appUrl, '/b');
  check(
    'cycle drag is rejected and the tree is unchanged',
    nodeA?.parentId === null && nodeB?.parentId === seeded.a,
    `A.parent=${nodeA?.parentId} B.parent=${nodeB?.parentId}`,
  );
  check('cycle rejection surfaces a toast to the user', /cycle/i.test(toastText), `toast="${toastText}"`);

  // AC5: a second window gets a panel bound to that window.
  const windowTwo = JSON.parse(
    await sw.evaluate(`(async () => {
      const win = await chrome.windows.create({ url: ${JSON.stringify(appUrl + '/w2')}, focused: true });
      await new Promise((resolve) => setTimeout(resolve, 500));
      const rootTab = (await chrome.tabs.query({ windowId: win.id })).find((tab) => tab.url === ${JSON.stringify(appUrl + '/w2')});
      const child = await chrome.tabs.create({ url: ${JSON.stringify(appUrl + '/w2-child')}, openerTabId: rootTab.id, windowId: win.id, active: false });
      return JSON.stringify({ windowId: win.id, rootTabId: rootTab.id, childTabId: child.id });
    })()`),
  );
  await waitFor(
    async () => {
      const snapshot = await workerSnapshot(sw);
      const child = nodeByPath(snapshot, appUrl, '/w2-child');
      return child?.parentId === windowTwo.rootTabId ? snapshot : null;
    },
    { label: 'second window tree' },
  );

  const panelTwo = await openPanel(sw, base, extensionId, windowTwo.windowId);
  const rowsTwo = await waitForRows(
    panelTwo.panel,
    (items) =>
      items.some((row) => row.tabId === windowTwo.rootTabId) &&
      items.some((row) => row.tabId === windowTwo.childTabId),
    'rows in panel two',
  );
  const rowW2Child = rowsTwo.find((row) => row.tabId === windowTwo.childTabId);
  check(
    'second-window panel shows the second-window tree',
    rowW2Child?.depth === 1 && rowW2Child?.indent === '16px',
    `depth=${rowW2Child?.depth} indent=${rowW2Child?.indent}`,
  );
  const windowSelection = JSON.parse(
    await panelTwo.panel.evaluate(`(() => {
      const select = document.getElementById('windowSelect');
      return JSON.stringify({ hidden: select.hidden, value: select.value, options: [...select.options].map((option) => option.value) });
    })()`),
  );
  check(
    'panel selects its host window in the window picker',
    windowSelection.hidden === false && windowSelection.value === String(windowTwo.windowId),
    JSON.stringify(windowSelection),
  );
  const panelOneSelection = JSON.parse(
    await panelOne.panel.evaluate(`(() => {
      const select = document.getElementById('windowSelect');
      return JSON.stringify({ value: select.value, options: [...select.options].map((option) => option.value) });
    })()`),
  );
  check(
    'first-window panel stays bound to the first window after focus moves',
    panelOneSelection.value === String(seeded.windowId),
    JSON.stringify(panelOneSelection),
  );

  recorder.finish();
} catch (error) {
  console.error(`\nPanel interaction e2e crashed: ${error.stack || error.message}`);
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
  cleanupProfile(profile, 'tab-tree-panel-e2e');
}
