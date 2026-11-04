#!/usr/bin/env node
/**
 * First-run onboarding E2E.
 *
 * Regression guard for the "I installed the extension, restarted Chrome and
 * still see a flat left bar" report: the setup guide must open automatically,
 * explain that Chrome's native vertical tabs are a different UI, render the
 * live tree, and update when a real link (A -> B) is opened. The side panel's
 * first-run hint must also disappear as soon as a link relationship exists.
 *
 * Usage: node scripts/e2e-onboarding.mjs   (set CHROME_PATH if auto-detect fails)
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
  '/a': {
    title: 'A onboarding root',
    body: '<p>Root page.</p><a id="to-b" href="/b" target="_blank">Open B</a>',
  },
  '/b': { title: 'B onboarding child', body: '<p>Child page opened from A.</p>' },
};

const recorder = createChecker('Tab Tree first-run onboarding E2E');
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

async function connectTarget(baseUrl, predicate, label) {
  const target = await waitFor(
    async () => (await jsonTargets(baseUrl)).find(predicate) || null,
    { label },
  );
  const client = new CDP(target.webSocketDebuggerUrl);
  await client.connect();
  await client.send('Runtime.enable');
  await client.send('Page.enable');
  track(client);
  return client;
}

async function realClick(baseUrl, urlPart, selector) {
  const { client } = await connectPage(baseUrl, urlPart);
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

function previewRows(client) {
  return client
    .evaluate(
      `JSON.stringify([...document.querySelectorAll('.preview-row')].map((row) => ({
        title: row.querySelector('.title')?.textContent || '',
        indent: row.querySelector('.indent')?.style.width || '',
      })))`,
    )
    .then((raw) => JSON.parse(raw || '[]'));
}

function panelRows(client) {
  return client
    .evaluate(
      `JSON.stringify([...document.querySelectorAll('.row')].map((row) => ({
        title: row.querySelector('.title')?.textContent || '',
        depth: Number(row.dataset.depth),
        indent: row.querySelector('.indent')?.style.width || '',
      })))`,
    )
    .then((raw) => JSON.parse(raw || '[]'));
}

try {
  const local = await startServer(pages);
  server = local.server;
  const appUrl = local.url;
  profile = fs.mkdtempSync(path.join(os.tmpdir(), 'tab-tree-onboarding-e2e-'));

  const launched = await launchChrome({ chromePath, profile, extension });
  chrome = launched.chrome;
  base = launched.base;
  const worker = await waitForWorker(base);
  const sw = track(worker.client);
  const extensionId = worker.extensionId;
  console.log('Tab Tree first-run onboarding E2E');
  console.log(`  chrome: ${chromePath}`);
  console.log(`  extension: ${extensionId}`);

  // ---- 1. The guide opens by itself ------------------------------------
  const welcome = await connectTarget(
    base,
    (target) => target.type === 'page' && target.url.endsWith('/welcome.html'),
    'auto-opened welcome page',
  );
  const welcomeTitle = await welcome.evaluate('document.querySelector("h1")?.textContent || ""');
  check('welcome page opens automatically on install', /installed|已安装/i.test(welcomeTitle), welcomeTitle);

  const nativeText = await welcome.evaluate(
    'document.querySelector(".callout.warning")?.textContent || ""',
  );
  check(
    'guide explains that Chrome native vertical tabs are separate',
    /vertical tabs|垂直标签/i.test(nativeText),
    nativeText.slice(0, 80),
  );

  const openPanelLabel = await welcome.evaluate(
    'document.getElementById("openPanel")?.textContent || ""',
  );
  check('guide offers a one-click side-panel launch', /side panel|侧边栏/i.test(openPanelLabel), openPanelLabel);

  const guideVersion = await welcome.evaluate('document.getElementById("version")?.textContent || ""');
  check('guide shows the installed version', guideVersion.includes('0.2.0'), guideVersion);

  await waitFor(
    async () => (await welcome.evaluate('document.getElementById("checkTabs")?.textContent || ""')) !== '—',
    { label: 'guide diagnostics', timeout: 15_000 },
  );
  const guideLinks = await welcome.evaluate(
    'document.getElementById("checkLinks")?.textContent || ""',
  );
  check('setup check reports zero tracked links on a fresh profile', guideLinks === '0', guideLinks);
  const guidePreview = await previewRows(welcome);
  check('guide renders a live tree preview', guidePreview.length >= 1, String(guidePreview.length));

  const storedVersion = await sw.evaluate(
    `chrome.storage.local.get('welcomeVersion').then((value) => value.welcomeVersion || '')`,
  );
  check('welcomeVersion is recorded so the guide is not reopened per tab', storedVersion === '0.2.0', storedVersion);

  // ---- 2. The panel's first-run hint is visible before any link --------
  const sidepanelBefore = new Set((await jsonTargets(base)).map((target) => target.id));
  await sw.evaluate(
    `chrome.tabs.create({ url: ${JSON.stringify(`chrome-extension://${extensionId}/sidepanel.html`)}, active: true })`,
  );
  const panel = await connectTarget(
    base,
    (target) =>
      target.type === 'page' &&
      target.url.endsWith('/sidepanel.html') &&
      !sidepanelBefore.has(target.id),
    'side panel page',
  );
  await waitFor(async () => (await panelRows(panel)).length >= 1, { label: 'panel rows' });
  const hintVisible = await panel.evaluate('document.getElementById("hint")?.hidden === false');
  check('panel shows the first-run link hint when no relationships exist', hintVisible === true, String(hintVisible));
  const helpButton = await panel.evaluate('Boolean(document.getElementById("btnHelp"))');
  check('panel exposes a help/setup button', helpButton === true);

  // ---- 3. Real link A -> B nests everywhere ----------------------------
  const tabA = JSON.parse(
    await sw.evaluate(
      `chrome.tabs.create({ url: ${JSON.stringify(appUrl + '/a')}, active: true }).then((tab) => JSON.stringify({ id: tab.id }))`,
    ),
  );
  await waitFor(
    async () => (await jsonTargets(base)).some((target) => target.url === appUrl + '/a'),
    { label: 'A page' },
  );
  await sleep(500);
  await realClick(base, '/a', '#to-b');
  await waitFor(
    async () => (await jsonTargets(base)).some((target) => target.url === appUrl + '/b'),
    { label: 'B page' },
  );

  const panelAfter = await waitFor(
    async () => {
      const rows = await panelRows(panel);
      const rowB = rows.find((row) => row.title.includes('B onboarding child'));
      return rowB && rowB.depth === 1 && rowB.indent === '16px' ? rows : null;
    },
    { label: 'panel nests B under A', timeout: 15_000 },
  );
  const rowA = panelAfter.find((row) => row.title.includes('A onboarding root'));
  check(
    'real link A -> B is a 16px-indented child in the panel',
    Boolean(rowA),
    JSON.stringify(panelAfter),
  );
  const hintAfter = await panel.evaluate('document.getElementById("hint")?.hidden === true');
  check('first-run hint disappears once a link relationship is captured', hintAfter === true);

  const guideAfter = await waitFor(
    async () => {
      const rows = await previewRows(welcome);
      const rowB = rows.find((row) => row.title.includes('B onboarding child'));
      return rowB && rowB.indent === '16px' ? rows : null;
    },
    { label: 'welcome preview nests B', timeout: 15_000 },
  );
  check(
    'guide live preview shows B indented under A',
    guideAfter.some((row) => row.title.includes('A onboarding root')),
    JSON.stringify(guideAfter),
  );
  const linksAfter = await welcome.evaluate(
    'document.getElementById("checkLinks")?.textContent || ""',
  );
  check('setup check updates to a non-zero tracked-link count', Number(linksAfter) > 0, linksAfter);

  const panelRowA = panelAfter.find((row) => row.title.includes('A onboarding root'));
  check('A remains top-level (sibling of the guide/panel tabs)', Boolean(panelRowA) && panelRowA.depth === 0);

  // ---- 4. Guide does not duplicate itself ------------------------------
  const beforeSecond = (await jsonTargets(base)).filter((target) =>
    target.url.endsWith('/welcome.html'),
  ).length;
  await sw.evaluate(
    `chrome.tabs.query({ url: chrome.runtime.getURL('welcome.html') }).then((tabs) => tabs[0]?.id ?? null)`,
  );
  const afterSecond = (await jsonTargets(base)).filter((target) =>
    target.url.endsWith('/welcome.html'),
  ).length;
  check('only one welcome tab exists', beforeSecond === 1 && afterSecond === 1, `${beforeSecond} -> ${afterSecond}`);

  recorder.finish();
} catch (error) {
  console.error(`\nOnboarding e2e crashed: ${error.stack || error.message}`);
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
  cleanupProfile(profile, 'tab-tree-onboarding-e2e');
}
