/**
 * Tab Tree — first-run / setup guide.
 *
 * This page exists because Chrome's own vertical-tab strip and the extension
 * side panel are easy to confuse. It shows the live tree immediately, opens
 * the real panel from a user gesture, and reports whether link capture is
 * actually working (tracked relationships) instead of only describing it.
 */

const PORT_NAME = 'tab-tree';
const INDENT = 16;

const FALLBACK = {
  welcomeTitle: 'Tab Tree is installed',
  welcomeLead:
    "Tabs you open from a link become children of the page that opened them. The tree lives in Chrome's side panel.",
  welcomeNativeTitle: "Chrome's built-in vertical tabs are not Tab Tree",
  welcomeNativeBody:
    "Chrome's own left-hand tab strip (the one with tab groups) cannot be restyled or indented by any extension. Tab Tree is a separate side panel. Look for the blue Tab Tree header and the search box.",
  welcomeOpenPanel: 'Open the Tab Tree side panel',
  welcomeOpenFull: 'Open the full-page tree',
  welcomeTreeTitle: 'Your current tabs',
  welcomeNoTabs: 'No tabs in this window yet.',
  welcomePreviewHint:
    'This is the same tree the side panel shows. Rows indented to the right were opened from the row above them.',
  welcomeCheckTitle: 'Setup check',
  welcomeCheckVersion: 'Extension version',
  welcomeCheckTabs: 'Tabs in this window',
  welcomeCheckLinks: 'Tracked link relationships',
  welcomeCheckRestore: 'Links restored after restart',
  welcomeCheckPanel: 'Side panel support',
  welcomeNoLinksHint:
    'No link relationships yet. Open a page, then click a link inside it (or Cmd/Ctrl-click): the new tab will appear indented under that page here.',
  welcomeLinksHint:
    'Link capture is working. Click a link inside a page and the new tab will nest under that page here.',
  welcomeStepsTitle: 'Try it in 30 seconds',
  welcomeStep1: 'Open any page (call it A).',
  welcomeStep2: 'Click a normal link inside A. The new tab becomes a child of A in the Tab Tree panel.',
  welcomeStep3: 'Open a tab with Cmd/Ctrl+T or the address bar: it stays top-level, next to A.',
  welcomeRestoreHint:
    'Restarting Chrome? Tab Tree rebuilds the tree from a local snapshot. Tabs that were already open before installation have no known opener and start as top-level rows; drag them onto a parent to fix that in one gesture.',
  welcomeReopen: 'How to reopen this guide',
  welcomeReopenTip:
    'Click the ? button in the Tab Tree panel, or open chrome://extensions → Tab Tree → Details → Extension options.',
  welcomeClose: 'Close this tab',
  welcomeFooter: 'Local-only · no account · no telemetry',
  welcomePanelOpened: 'The side panel is opening. Look for the blue Tab Tree header and the Search tabs box.',
  welcomePanelFailed:
    "Chrome would not open the panel automatically. Use the full-page tree below, or pin Tab Tree in the toolbar and click its icon.",
  welcomeMore: '+ more tabs',
  welcomeRestoredBadge: 'restored',
  welcomeRestoring: 'restoring',
  welcomeNone: 'none',
  welcomeUnavailable: 'not available',
  welcomeYes: 'available',
  welcomeNo: 'not available',
};

function t(key) {
  if (chrome.i18n?.getMessage) {
    const localized = chrome.i18n.getMessage(key);
    if (localized) return localized;
  }
  return FALLBACK[key] || key;
}

const el = {
  version: document.getElementById('version'),
  preview: document.getElementById('preview'),
  previewEmpty: document.getElementById('previewEmpty'),
  previewCount: document.getElementById('previewCount'),
  checkVersion: document.getElementById('checkVersion'),
  checkTabs: document.getElementById('checkTabs'),
  checkLinks: document.getElementById('checkLinks'),
  checkRestore: document.getElementById('checkRestore'),
  checkPanel: document.getElementById('checkPanel'),
  dotTabs: document.getElementById('dotTabs'),
  dotLinks: document.getElementById('dotLinks'),
  dotRestore: document.getElementById('dotRestore'),
  dotPanel: document.getElementById('dotPanel'),
  setupHint: document.getElementById('setupHint'),
  panelNote: document.getElementById('panelNote'),
  openPanel: document.getElementById('openPanel'),
  openFull: document.getElementById('openFull'),
  reopen: document.getElementById('reopen'),
  closeTab: document.getElementById('closeTab'),
};

let snapshot = null;
let port = null;
let activeWindowId = null;
let currentWindowId = null;

// Cache the host window so `sidePanel.open()` can be called synchronously from
// the click handler; Chrome requires a user gesture and an `await` before the
// call is a common way to lose it.
chrome.windows
  ?.getCurrent()
  .then((window) => {
    if (Number.isInteger(window?.id)) currentWindowId = window.id;
  })
  .catch(() => {});
chrome.windows?.onFocusChanged?.addListener((windowId) => {
  if (windowId === chrome.windows.WINDOW_ID_NONE) return;
  activeWindowId = windowId;
  currentWindowId = windowId;
});

function applyI18n() {
  for (const node of document.querySelectorAll('[data-i18n]')) {
    const key = node.dataset.i18n;
    if (key) node.textContent = t(key);
  }
}

function setNote(text) {
  if (!text) {
    el.panelNote.hidden = true;
    el.panelNote.textContent = '';
    return;
  }
  el.panelNote.textContent = text;
  el.panelNote.hidden = false;
}

function setDot(dot, stateName) {
  if (!dot) return;
  dot.classList.remove('ok', 'warn');
  if (stateName) dot.classList.add(stateName);
}

/* -------------------------------------------------------------------------- */
/* Live tree                                                                  */
/* -------------------------------------------------------------------------- */

function connect() {
  try {
    port = chrome.runtime.connect({ name: PORT_NAME });
    port.onMessage.addListener((message) => {
      if (message?.type === 'tree.changed') setSnapshot(message.snapshot);
    });
    port.onDisconnect.addListener(() => {
      port = null;
      setTimeout(connect, 600);
    });
    refresh();
  } catch {
    setTimeout(connect, 900);
  }
}

function refresh() {
  if (!port) return;
  try {
    port.postMessage({ type: 'tree.getSnapshot' });
  } catch {
    /* reconnect path will retry */
  }
}

function pickWindow(snap) {
  const windows = snap.windows || [];
  if (activeWindowId && windows.some((window) => window.id === activeWindowId)) {
    return activeWindowId;
  }
  return (windows.find((window) => window.focused) || windows[0])?.id ?? null;
}

function setSnapshot(next) {
  if (!next) return;
  snapshot = next;
  const windowId = pickWindow(snapshot);
  if (windowId !== null) activeWindowId = windowId;
  renderPreview(windowId);
  renderChecks(windowId);
}

function faviconFor(node) {
  if (!node.favIconUrl) return null;
  // Extension pages allow chrome:// and https favicons; the <img> error path
  // falls back to a letter tile when the URL is stale or blocked.
  const img = document.createElement('img');
  img.alt = '';
  img.referrerPolicy = 'no-referrer';
  img.src = node.favIconUrl;
  img.addEventListener('error', () => {
    const fallback = document.createElement('span');
    fallback.className = 'favicon-fallback';
    fallback.textContent = (node.domain || node.title || '?').slice(0, 1).toUpperCase();
    img.replaceWith(fallback);
  });
  return img;
}

function renderPreview(windowId) {
  const nodes = windowId === null ? [] : (snapshot.nodes || []).filter((node) => node.windowId === windowId);
  el.preview.replaceChildren();
  el.previewEmpty.hidden = nodes.length > 0;
  el.previewCount.textContent = nodes.length ? String(nodes.length) : '';

  const visible = nodes.slice(0, 14);
  for (const node of visible) {
    const row = document.createElement('div');
    row.className = 'preview-row';
    row.title = node.url;
    row.addEventListener('click', () => activate(node));

    const indent = document.createElement('span');
    indent.className = 'indent';
    indent.style.width = `${(node.depth || 0) * INDENT}px`;
    row.append(indent);

    const icon = faviconFor(node);
    if (icon) row.append(icon);
    else {
      const fallback = document.createElement('span');
      fallback.className = 'favicon-fallback';
      fallback.textContent = (node.domain || node.title || '?').slice(0, 1).toUpperCase();
      row.append(fallback);
    }

    const title = document.createElement('span');
    title.className = 'title';
    title.textContent = node.title || node.url || '(untitled)';
    row.append(title);

    if (node.depth > 0) {
      const depth = document.createElement('span');
      depth.className = 'depth-badge';
      depth.textContent = `L${node.depth + 1}`;
      row.append(depth);
    }
    if (node.inferred) {
      const restored = document.createElement('span');
      restored.className = 'restored';
      restored.textContent = t('welcomeRestoredBadge');
      row.append(restored);
    }
    el.preview.append(row);
  }

  if (nodes.length > visible.length) {
    const more = document.createElement('div');
    more.className = 'preview-row';
    more.textContent = `${t('welcomeMore')} · ${nodes.length - visible.length}`;
    more.style.paddingLeft = '12px';
    more.style.color = 'var(--text-3)';
    more.style.cursor = 'default';
    el.preview.append(more);
  }
}

async function activate(node) {
  await chrome.tabs.update(node.tabId, { active: true }).catch(() => {});
  await chrome.windows.update(node.windowId, { focused: true }).catch(() => {});
}

function renderChecks(windowId) {
  el.version.textContent = chrome.runtime.getManifest().version;
  el.checkVersion.textContent = `v${chrome.runtime.getManifest().version}`;

  const window = snapshot.windows?.find((item) => item.id === windowId);
  const tabCount = window?.tabCount ?? 0;
  el.checkTabs.textContent = String(tabCount);
  setDot(el.dotTabs, tabCount > 0 ? 'ok' : 'warn');

  const stats = snapshot.linkStats || { parented: 0, captured: 0, manual: 0, restored: 0 };
  const links = stats.parented;
  el.checkLinks.textContent = String(links);
  setDot(el.dotLinks, links > 0 ? 'ok' : 'warn');

  const restore = snapshot.restore?.stats;
  if (snapshot.restoring) {
    el.checkRestore.textContent = `${snapshot.restoring.matchedTabs}/${snapshot.restoring.total} ${t('welcomeRestoring')}`;
    setDot(el.dotRestore, 'warn');
  } else if (restore && restore.relations > 0) {
    const suffix = restore.partial ? ` (${restore.matchedTabs}/${restore.oldNodes})` : '';
    el.checkRestore.textContent = `${restore.relations}${suffix}`;
    setDot(el.dotRestore, 'ok');
  } else {
    el.checkRestore.textContent = t('welcomeNone');
    setDot(el.dotRestore, null);
  }

  const panelAvailable = Boolean(chrome.sidePanel?.open);
  el.checkPanel.textContent = panelAvailable ? t('welcomeYes') : t('welcomeUnavailable');
  setDot(el.dotPanel, panelAvailable ? 'ok' : 'warn');

  el.setupHint.textContent = links > 0 ? t('welcomeLinksHint') : t('welcomeNoLinksHint');
}

/* -------------------------------------------------------------------------- */
/* Actions                                                                    */
/* -------------------------------------------------------------------------- */

async function openPanel() {
  setNote('');
  const panel = chrome.sidePanel;
  if (!panel?.open) {
    setNote(t('welcomePanelFailed'));
    return;
  }
  try {
    let windowId = currentWindowId;
    if (!Number.isInteger(windowId)) {
      // Fallback only when the cached id is unavailable: the gesture may still
      // be honoured because this happens in the same click task.
      const win = await chrome.windows.getCurrent();
      windowId = win.id;
      currentWindowId = windowId;
    }
    await panel.open({ windowId });
    setNote(t('welcomePanelOpened'));
  } catch (error) {
    console.warn('[tab-tree] welcome could not open panel', error);
    setNote(t('welcomePanelFailed'));
  }
}

async function openFullPage() {
  const url = chrome.runtime.getURL('sidepanel.html');
  const existing = await chrome.tabs.query({ url }).catch(() => []);
  if (existing.length > 0) {
    await chrome.tabs.update(existing[0].id, { active: true }).catch(() => {});
    await chrome.windows.update(existing[0].windowId, { focused: true }).catch(() => {});
    return;
  }
  await chrome.tabs.create({ url, active: true });
}

async function closeThisTab() {
  try {
    const tab = await chrome.tabs.getCurrent();
    if (tab?.id) await chrome.tabs.remove(tab.id);
    else window.close();
  } catch {
    window.close();
  }
}

function showReopenTip() {
  setNote(t('welcomeReopenTip'));
}

/* -------------------------------------------------------------------------- */
/* Wiring                                                                     */
/* -------------------------------------------------------------------------- */

applyI18n();
el.checkVersion.textContent = `v${chrome.runtime.getManifest().version}`;
el.version.textContent = `v${chrome.runtime.getManifest().version}`;

el.openPanel.addEventListener('click', openPanel);
el.openFull.addEventListener('click', () => openFullPage().catch(() => {}));
el.closeTab.addEventListener('click', () => closeThisTab());
el.reopen.addEventListener('click', showReopenTip);

for (const event of ['onCreated', 'onRemoved', 'onUpdated', 'onActivated', 'onMoved']) {
  chrome.tabs?.[event]?.addListener(() => refresh());
}
chrome.windows?.onFocusChanged?.addListener((windowId) => {
  if (windowId !== chrome.windows.WINDOW_ID_NONE) activeWindowId = windowId;
  refresh();
});

connect();
// A slow browser restore can finish after the first snapshot; poll once every
// few seconds while the restore window is open, then stop.
const poll = setInterval(() => {
  if (snapshot?.restoring) refresh();
}, 2500);
window.addEventListener('pagehide', () => clearInterval(poll), { once: true });
