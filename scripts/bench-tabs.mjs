#!/usr/bin/env node
/**
 * Hundreds-of-tabs benchmark (AC8).
 *
 * Seeds a wide forest (default 300 tabs, override with TABS=500), then measures
 * the work the extension actually does on every event:
 *
 *   - full service-worker rebuild: chrome.tabs.query + tree engine + snapshot
 *   - side-panel scroll repaint (the virtual list only renders ~1 viewport)
 *   - side-panel search filtering
 *
 * Prints raw samples and enforces generous responsiveness ceilings so a
 * regression (e.g. accidentally rendering every row) fails loudly.
 *
 * Usage: node scripts/bench-tabs.mjs [TABS=500]
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
const TAB_COUNT = Math.max(50, Number(process.env.TABS) || 300);
const ROOTS = 6;

const THRESHOLDS = {
  rebuildMs: 500,
  scrollMs: 100,
  searchMs: 250,
};

const page = {
  title: 'Bench tab',
  body: '<p>Benchmark fixture. One of many tabs.</p>',
};

const recorder = createChecker(`Tab Tree benchmark — ${TAB_COUNT} tabs`);
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

function percentiles(samples) {
  const sorted = [...samples].sort((a, b) => a - b);
  const at = (ratio) => sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * ratio))];
  return {
    min: Number(sorted[0].toFixed(1)),
    median: Number(at(0.5).toFixed(1)),
    p95: Number(at(0.95).toFixed(1)),
    max: Number(sorted[sorted.length - 1].toFixed(1)),
  };
}

try {
  const local = await startServer({ '/bench': page, '/': page });
  server = local.server;
  const appUrl = local.url;
  profile = fs.mkdtempSync(path.join(os.tmpdir(), 'tab-tree-bench-'));
  const launched = await launchChrome({ chromePath, profile, extension });
  chrome = launched.chrome;
  base = launched.base;

  const worker = await waitForWorker(base);
  const sw = track(worker.client);
  const extensionId = worker.extensionId;
  console.log(`Tab Tree benchmark — ${TAB_COUNT} tabs`);
  console.log(`  chrome: ${chromePath}`);
  console.log(`  extension: ${extensionId}`);

  // ---- Seed the forest --------------------------------------------------
  const seedStart = Date.now();
  const firstTab = JSON.parse(
    await sw.evaluate(
      `chrome.tabs.create({ url: ${JSON.stringify(appUrl + '/bench?i=0')}, active: true }).then((tab) => JSON.stringify({ id: tab.id }))`,
    ),
  );
  await sleep(400);
  // Create in chunks: one giant Runtime.evaluate can outlive the CDP request
  // timeout once the browser is under load from hundreds of tabs.
  const ids = [firstTab.id];
  const CHUNK = 40;
  for (let start = 1; start < TAB_COUNT; start += CHUNK) {
    const end = Math.min(start + CHUNK, TAB_COUNT);
    const chunk = JSON.parse(
      await sw.evaluate(`(async () => {
        const roots = ${ROOTS};
        const ids = ${JSON.stringify(ids)};
        const created = [];
        for (let index = ${start}; index < ${end}; index += 1) {
          const parent = ids[index % roots];
          const tab = await chrome.tabs.create({
            url: ${JSON.stringify(appUrl + '/bench?i=')} + index,
            openerTabId: parent,
            active: false,
          });
          created.push(tab.id);
        }
        return JSON.stringify(created);
      })()`),
    );
    ids.push(...chunk);
  }
  const seedMs = Date.now() - seedStart;
  console.log(`  seeded: ${ids.length} tabs in ${seedMs} ms`);
  check('all benchmark tabs were created', ids.length === TAB_COUNT, `${ids.length}/${TAB_COUNT}`);

  const snapshot = await waitFor(
    async () => {
      const raw = await sw.evaluate('JSON.stringify(globalThis.__TAB_TREE_DEBUG__?.snapshot?.() || null)');
      const value = JSON.parse(raw || 'null');
      return value && value.nodes.length >= TAB_COUNT ? value : null;
    },
    { timeout: 120_000, label: `${TAB_COUNT} tabs in the engine` },
  );
  check('all benchmark tabs are in the tree snapshot', snapshot.nodes.length >= TAB_COUNT, `${snapshot.nodes.length} nodes`);
  const snapshotBytes = Buffer.byteLength(JSON.stringify(snapshot));
  console.log(`  snapshot: ${snapshot.nodes.length} nodes, ${(snapshotBytes / 1024).toFixed(1)} KiB JSON`);

  // ---- Service-worker rebuild ------------------------------------------
  await sleep(1200);
  const rebuildSamples = JSON.parse(
    await sw.evaluate(`(async () => {
      const samples = [];
      for (let attempt = 0; attempt < 6; attempt += 1) {
        await new Promise((resolve) => setTimeout(resolve, 300));
        const started = performance.now();
        await globalThis.__TAB_TREE_DEBUG__.rebuild();
        samples.push(performance.now() - started);
      }
      return JSON.stringify(samples);
    })()`),
  );
  const rebuild = percentiles(rebuildSamples);
  console.log(`  rebuild ms: ${JSON.stringify(rebuild)} samples=${rebuildSamples.map((n) => n.toFixed(1)).join(',')}`);
  check(
    `full rebuild stays under ${THRESHOLDS.rebuildMs} ms`,
    rebuild.p95 < THRESHOLDS.rebuildMs,
    `p95=${rebuild.p95} max=${rebuild.max}`,
  );

  // ---- Side panel -------------------------------------------------------
  const beforePanel = new Set((await jsonTargets(base)).map((target) => target.id));
  await sw.evaluate(
    `chrome.tabs.create({ url: ${JSON.stringify(`chrome-extension://${extensionId}/sidepanel.html`)}, active: true })`,
  );
  const target = await waitFor(
    async () => {
      const targets = await jsonTargets(base);
      return (
        targets.find(
          (item) => !beforePanel.has(item.id) && item.type === 'page' && item.url.endsWith('/sidepanel.html'),
        ) || null
      );
    },
    { label: 'benchmark panel' },
  );
  const panel = new CDP(target.webSocketDebuggerUrl);
  await panel.connect();
  await panel.send('Runtime.enable');
  await panel.send('Page.enable');
  track(panel);
  await panel.send('Emulation.setDeviceMetricsOverride', {
    width: 380,
    height: 760,
    deviceScaleFactor: 1,
    mobile: false,
  });

  const panelStats = await waitFor(
    async () => {
      const raw = await panel.evaluate(`(() => {
        const rows = document.querySelectorAll('.row').length;
        const total = Number(document.getElementById('count')?.textContent || 0);
        return total >= ${TAB_COUNT - 2} ? JSON.stringify({ total, rows, innerHeight: document.querySelector('.tree-inner')?.style.height || '' }) : 'null';
      })()`);
      return raw && raw !== 'null' ? JSON.parse(raw) : null;
    },
    { timeout: 30_000, label: 'panel rows' },
  );
  check(
    'virtual list keeps the DOM small for hundreds of tabs',
    panelStats.rows < 80 && panelStats.total >= TAB_COUNT - 2,
    `domRows=${panelStats.rows} total=${panelStats.total}`,
  );
  check(
    'panel scroll height covers every row',
    panelStats.innerHeight === `${panelStats.total * 32}px`,
    panelStats.innerHeight,
  );

  const scrollSamples = JSON.parse(
    await panel.evaluate(`(async () => {
      const tree = document.getElementById('tree');
      const samples = [];
      for (let index = 0; index < 10; index += 1) {
        await new Promise((resolve) => requestAnimationFrame(resolve));
        const started = performance.now();
        tree.scrollTop = (tree.scrollHeight - tree.clientHeight) * (index / 9);
        await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
        samples.push(performance.now() - started);
      }
      return JSON.stringify(samples);
    })()`),
  );
  const scroll = percentiles(scrollSamples);
  console.log(`  scroll ms: ${JSON.stringify(scroll)} samples=${scrollSamples.map((n) => n.toFixed(1)).join(',')}`);
  check(
    `scroll repaint stays under ${THRESHOLDS.scrollMs} ms`,
    scroll.p95 < THRESHOLDS.scrollMs,
    `p95=${scroll.p95} max=${scroll.max}`,
  );

  const searchResult = JSON.parse(
    await panel.evaluate(`(async () => {
      const input = document.getElementById('search');
      const started = performance.now();
      input.value = 'i=1';
      input.dispatchEvent(new Event('input', { bubbles: true }));
      await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
      return JSON.stringify({
        ms: performance.now() - started,
        rows: document.querySelectorAll('.row').length,
        count: document.getElementById('count')?.textContent || '',
      });
    })()`),
  );
  console.log(`  search ms: ${searchResult.ms.toFixed(1)} (${searchResult.count} matched)`);
  check(
    `search filtering stays under ${THRESHOLDS.searchMs} ms`,
    searchResult.ms < THRESHOLDS.searchMs,
    `${searchResult.ms.toFixed(1)} ms`,
  );
  check('search actually narrows the tree', searchResult.rows < panelStats.rows || searchResult.count.includes('/'), searchResult.count);

  recorder.finish();
} catch (error) {
  console.error(`\nBenchmark crashed: ${error.stack || error.message}`);
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
  cleanupProfile(profile, 'tab-tree-bench');
}
