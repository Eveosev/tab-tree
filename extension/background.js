/**
 * Tab Tree — MV3 service worker.
 *
 * Single source of truth for the forest. The side panel is a pure view that
 * sends intents over a long-lived port; the worker owns tabs, ordering,
 * collapse state and persistence.
 *
 * Service workers are killed aggressively. Every build is therefore cheap and
 * idempotent: it re-queries `chrome.tabs` and recomputes the tree from
 * `openerTabId` + overrides. Session-only state survives worker restarts in
 * `chrome.storage.session`; the restore snapshot lives in
 * `chrome.storage.local`.
 */

import {
  DEFAULT_PREFS,
  SNAPSHOT_VERSION,
  buildSnapshot,
  canReparent,
  computeNativeOrder,
  getDescendantIds,
  matchRestoreSnapshot,
  pruneOverrides,
  serializeRestoreSnapshot,
} from './lib/tree-engine.js';

const PORT_NAME = 'tab-tree';
const STORAGE = {
  prefs: 'prefs',
  overrides: 'overrides',
  collapsed: 'collapsed',
  restoreSnapshot: 'restoreSnapshot',
  restoreStats: 'restoreStats',
};

const state = {
  /** @type {Object|null} */
  snapshot: null,
  /** @type {Map<number, number|null>} */
  overrides: new Map(),
  /** @type {Set<number>} */
  collapsed: new Set(),
  /** @type {Set<number>} */
  inferred: new Set(),
  prefs: { ...DEFAULT_PREFS },
  /** @type {null|{stats: Object, appliedAt: number}} */
  restore: null,
  focusedWindowId: null,
  reorderUntil: 0,
  ready: null,
};

/** @type {Set<chrome.runtime.Port>} */
const ports = new Set();
let buildTimer = null;
let persistTimer = null;
let sessionTimer = null;
let building = false;
let buildAgain = false;

/* -------------------------------------------------------------------------- */
/* Persistence                                                                */
/* -------------------------------------------------------------------------- */

async function loadState() {
  const [local, session] = await Promise.all([
    chrome.storage.local.get([STORAGE.prefs, STORAGE.restoreSnapshot, STORAGE.restoreStats]),
    chrome.storage.session.get([STORAGE.overrides, STORAGE.collapsed]),
  ]);
  state.prefs = { ...DEFAULT_PREFS, ...(local[STORAGE.prefs] || {}) };
  if (Array.isArray(session[STORAGE.overrides])) {
    for (const entry of session[STORAGE.overrides]) {
      if (Array.isArray(entry) && Number.isInteger(entry[0])) {
        state.overrides.set(entry[0], entry[1] === null ? null : Number(entry[1]));
      }
    }
  }
  if (Array.isArray(session[STORAGE.collapsed])) {
    for (const tabId of session[STORAGE.collapsed]) {
      if (Number.isInteger(tabId)) state.collapsed.add(tabId);
    }
  }
  return {
    restoreSnapshot: local[STORAGE.restoreSnapshot] || null,
    restoreStats: local[STORAGE.restoreStats] || null,
  };
}

function saveSessionState() {
  clearTimeout(sessionTimer);
  sessionTimer = setTimeout(() => {
    chrome.storage.session
      .set({
        [STORAGE.overrides]: [...state.overrides.entries()],
        [STORAGE.collapsed]: [...state.collapsed],
      })
      .catch((error) => console.warn('[tab-tree] session persist failed', error));
  }, 120);
}

function schedulePersistSnapshot(snapshot) {
  clearTimeout(persistTimer);
  persistTimer = setTimeout(() => {
    persistSnapshot(snapshot);
  }, 900);
}

function persistSnapshot(snapshot = state.snapshot) {
  if (!snapshot) return;
  chrome.storage.local
    .set({ [STORAGE.restoreSnapshot]: serializeRestoreSnapshot(snapshot) })
    .catch((error) => console.warn('[tab-tree] snapshot persist failed', error));
}

/* -------------------------------------------------------------------------- */
/* Build + broadcast                                                          */
/* -------------------------------------------------------------------------- */

async function buildNow(reason = 'event') {
  if (building) {
    buildAgain = true;
    return;
  }
  building = true;
  try {
    const [tabs, windows] = await Promise.all([
      chrome.tabs.query({}),
      chrome.windows.getAll({ windowTypes: ['normal'] }).catch(() => []),
    ]);
    const focused = windows.find((w) => w.focused)?.id ?? state.focusedWindowId;
    state.focusedWindowId = focused;

    const liveIds = new Set(tabs.map((tab) => tab.id));
    pruneOverrides(state.overrides, liveIds);
    for (const tabId of [...state.collapsed]) {
      if (!liveIds.has(tabId)) state.collapsed.delete(tabId);
    }
    for (const tabId of [...state.inferred]) {
      if (!liveIds.has(tabId)) state.inferred.delete(tabId);
    }

    const snapshot = buildSnapshot({
      tabs,
      overrides: state.overrides,
      collapsed: state.collapsed,
      inferred: state.inferred,
      prefs: state.prefs,
      focusedWindowId: focused,
    });
    snapshot.version = SNAPSHOT_VERSION;
    snapshot.restore = state.restore;
    snapshot.reason = reason;

    const changed = !state.snapshot || state.snapshot.revision !== snapshot.revision;
    state.snapshot = snapshot;
    if (changed) broadcast({ type: 'tree.changed', snapshot });
    schedulePersistSnapshot(snapshot);
    if (changed) saveSessionState();
  } catch (error) {
    console.error('[tab-tree] build failed', error);
  } finally {
    building = false;
    if (buildAgain) {
      buildAgain = false;
      scheduleBuild('coalesced');
    }
  }
}

function scheduleBuild(reason = 'event', delay = 60) {
  clearTimeout(buildTimer);
  buildTimer = setTimeout(() => {
    buildNow(reason);
  }, delay);
}

function broadcast(message) {
  for (const port of [...ports]) {
    try {
      port.postMessage(message);
    } catch {
      ports.delete(port);
    }
  }
}

function post(port, message) {
  try {
    port.postMessage(message);
  } catch {
    ports.delete(port);
  }
}

/* -------------------------------------------------------------------------- */
/* Init (also used as the post-restore reconciliation)                        */
/* -------------------------------------------------------------------------- */

async function init() {
  const local = await loadState();

  const tabs = await chrome.tabs.query({});
  pruneOverrides(state.overrides, new Set(tabs.map((tab) => tab.id)));

  // Restore only when this looks like a browser restart and the worker has no
  // live session state. On a mere worker wake, `openerTabId` is still present
  // and is strictly better than fingerprint matching.
  const liveOpeners = tabs.some((tab) => Number.isInteger(tab.openerTabId));
  if (state.overrides.size === 0 && !liveOpeners && local.restoreSnapshot) {
    const matched = matchRestoreSnapshot(local.restoreSnapshot, tabs, { now: Date.now() });
    if (matched.applicable && matched.stats.matchedTabs > 0) {
      state.overrides = new Map(matched.overrides);
      state.inferred = new Set(matched.inferred);
      state.restore = { appliedAt: Date.now(), stats: matched.stats };
      await chrome.storage.local.set({
        [STORAGE.restoreStats]: { appliedAt: Date.now(), stats: matched.stats },
      });
      console.info('[tab-tree] restored session', matched.stats);
    }
  } else if (local.restoreStats) {
    state.restore = local.restoreStats;
  }

  await buildNow('init');
}

/* -------------------------------------------------------------------------- */
/* Actions                                                                    */
/* -------------------------------------------------------------------------- */

async function activateTab(tabId) {
  const tab = await chrome.tabs.get(tabId);
  await chrome.tabs.update(tabId, { active: true });
  await chrome.windows.update(tab.windowId, { focused: true }).catch(() => {});
  return { tabId, windowId: tab.windowId };
}

async function closeTab(tabId, { subtree = false } = {}) {
  const snapshot = state.snapshot;
  const node = snapshot?.nodes.find((item) => item.tabId === tabId);
  const shouldCloseSubtree = subtree || (state.prefs.closeChildrenWithParent && node?.hasChildren);
  const ids = shouldCloseSubtree ? [tabId, ...getDescendantIds(snapshot?.nodes || [], tabId)] : [tabId];
  await chrome.tabs.remove(ids);
  for (const id of ids) {
    state.overrides.delete(id);
    state.collapsed.delete(id);
    state.inferred.delete(id);
  }
  saveSessionState();
  return { closed: ids };
}

async function setCollapsed(tabId, collapsed) {
  if (collapsed) state.collapsed.add(tabId);
  else state.collapsed.delete(tabId);
  saveSessionState();
  await buildNow('collapse');
  return { tabId, collapsed };
}

async function setAllCollapsed(collapsed) {
  if (collapsed) {
    for (const node of state.snapshot?.nodes || []) {
      if (node.hasChildren) state.collapsed.add(node.tabId);
    }
  } else {
    state.collapsed.clear();
  }
  saveSessionState();
  await buildNow('collapse-all');
  return { collapsed };
}

async function reparent(tabId, parentTabId) {
  const snapshot = state.snapshot;
  const check = canReparent(snapshot?.nodes || [], tabId, parentTabId);
  if (!check.ok) throw new Error(`Cannot reparent: ${check.reason}`);
  state.overrides.set(tabId, parentTabId);
  state.inferred.delete(tabId);
  saveSessionState();
  await buildNow('reparent');
  if (state.prefs.autoSortNative) {
    const node = state.snapshot?.nodes.find((item) => item.tabId === tabId);
    if (node) await reorderNative(node.windowId).catch((error) => console.warn('[tab-tree] reorder failed', error));
  }
  return { tabId, parentTabId };
}

async function reorderNative(windowId) {
  if (!state.snapshot) return { moved: 0, skipped: true };
  if (Date.now() < state.reorderUntil) return { moved: 0, skipped: true };
  const { pinned, unpinned } = computeNativeOrder(state.snapshot, windowId);
  if (unpinned.length === 0) return { moved: 0 };

  state.reorderUntil = Date.now() + 1500;
  let index = pinned.length;
  let moved = 0;
  for (const tabId of unpinned) {
    const tab = await chrome.tabs.get(tabId).catch(() => null);
    if (!tab || tab.windowId !== windowId) {
      index += 1;
      continue;
    }
    if (tab.index !== index) {
      await chrome.tabs.move(tabId, { index });
      moved += 1;
    }
    index += 1;
  }
  await buildNow('reorder');
  return { moved };
}

async function setPrefs(patch) {
  const next = { ...state.prefs };
  for (const key of Object.keys(DEFAULT_PREFS)) {
    if (typeof patch?.[key] !== 'undefined') next[key] = Boolean(patch[key]);
  }
  state.prefs = next;
  await chrome.storage.local.set({ [STORAGE.prefs]: next });
  await buildNow('prefs');
  return { prefs: next };
}

/* -------------------------------------------------------------------------- */
/* Message handling                                                           */
/* -------------------------------------------------------------------------- */

function sendResult(port, requestId, ok, payload) {
  if (!port || !requestId) return;
  post(port, { type: ok ? 'action.result' : 'action.error', requestId, ...payload });
}

async function handleMessage(message, port) {
  const requestId = message?.requestId;
  try {
    switch (message?.type) {
      case 'tree.getSnapshot': {
        if (!state.snapshot) await buildNow('get-snapshot');
        post(port, { type: 'tree.changed', snapshot: state.snapshot });
        sendResult(port, requestId, true, {});
        break;
      }
      case 'tab.activate':
        await activateTab(message.tabId);
        sendResult(port, requestId, true, {});
        break;
      case 'tab.close':
        sendResult(port, requestId, true, await closeTab(message.tabId, { subtree: Boolean(message.subtree) }));
        break;
      case 'node.setCollapsed':
        sendResult(port, requestId, true, await setCollapsed(message.tabId, Boolean(message.collapsed)));
        break;
      case 'tree.setAllCollapsed':
        sendResult(port, requestId, true, await setAllCollapsed(Boolean(message.collapsed)));
        break;
      case 'node.reparent':
        sendResult(port, requestId, true, await reparent(message.tabId, message.parentTabId ?? null));
        break;
      case 'tree.reorderNative': {
        const windowId = Number.isInteger(message.windowId)
          ? message.windowId
          : state.snapshot?.focusedWindowId;
        sendResult(port, requestId, true, await reorderNative(windowId));
        break;
      }
      case 'prefs.set':
        sendResult(port, requestId, true, await setPrefs(message.prefs || {}));
        break;
      case 'window.focus':
        await chrome.windows.update(message.windowId, { focused: true }).catch(() => {});
        sendResult(port, requestId, true, {});
        break;
      case 'tree.rebuild':
        await buildNow('manual');
        sendResult(port, requestId, true, {});
        break;
      default:
        sendResult(port, requestId, false, { error: `Unknown message: ${message?.type}` });
    }
  } catch (error) {
    console.warn('[tab-tree] action failed', message?.type, error);
    sendResult(port, requestId, false, { error: error?.message || String(error) });
  }
}

/* -------------------------------------------------------------------------- */
/* Wiring                                                                     */
/* -------------------------------------------------------------------------- */

state.ready = init().catch((error) => {
  console.error('[tab-tree] init failed', error);
});

chrome.runtime.onConnect.addListener((port) => {
  if (port.name !== PORT_NAME) return;
  ports.add(port);
  port.onDisconnect.addListener(() => ports.delete(port));
  port.onMessage.addListener((message) => {
    handleMessage(message, port);
  });
  state.ready
    .then(() => {
      if (state.snapshot) post(port, { type: 'tree.changed', snapshot: state.snapshot });
    })
    .catch(() => {});
});

const rebuild = () => scheduleBuild('tabs-event');

chrome.tabs.onCreated.addListener(rebuild);
chrome.tabs.onRemoved.addListener(rebuild);
chrome.tabs.onMoved.addListener(rebuild);
chrome.tabs.onActivated.addListener(rebuild);
chrome.tabs.onAttached.addListener(rebuild);
chrome.tabs.onDetached.addListener(rebuild);
chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
  if (
    changeInfo.title ||
    changeInfo.url ||
    changeInfo.favIconUrl ||
    changeInfo.status === 'complete' ||
    changeInfo.pinned !== undefined ||
    changeInfo.audible !== undefined ||
    changeInfo.discarded !== undefined ||
    changeInfo.groupId !== undefined
  ) {
    scheduleBuild('tab-updated', 120);
  }
});
chrome.tabs.onReplaced.addListener((addedTabId, removedTabId) => {
  if (state.overrides.has(removedTabId)) {
    state.overrides.set(addedTabId, state.overrides.get(removedTabId));
    state.overrides.delete(removedTabId);
  }
  if (state.collapsed.has(removedTabId)) {
    state.collapsed.delete(removedTabId);
    state.collapsed.add(addedTabId);
  }
  scheduleBuild('tab-replaced');
});
chrome.windows.onFocusChanged.addListener((windowId) => {
  if (windowId === chrome.windows.WINDOW_ID_NONE) return;
  state.focusedWindowId = windowId;
  scheduleBuild('window-focus');
});
chrome.windows.onRemoved.addListener(rebuild);

chrome.runtime.onStartup.addListener(() => scheduleBuild('startup'));
chrome.runtime.onInstalled.addListener((details) => {
  scheduleBuild('installed');
  if (details.reason === 'install') console.info('[tab-tree] installed');
});
chrome.runtime.onSuspend.addListener(() => {
  if (state.snapshot) persistSnapshot(state.snapshot);
});

// Make the toolbar action open the side panel (Chrome 114+). If the API is
// unavailable the extension still works by pinning the panel manually.
if (chrome.sidePanel?.setPanelBehavior) {
  chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch((error) => {
    console.warn('[tab-tree] sidePanel behavior failed', error);
  });
}

// Diagnostics hook for automated smoke tests. Only reachable from a DevTools
// session attached to this worker (not from pages), and only exposes state plus
// the same validated override path the drag UI uses.
globalThis.__TAB_TREE_DEBUG__ = {
  snapshot: () => state.snapshot,
  overrides: () => [...state.overrides.entries()],
  rebuild: () => buildNow('debug'),
  setParent: async (tabId, parentId) => {
    await buildNow('debug-prebuild');
    const check = canReparent(state.snapshot?.nodes || [], tabId, parentId ?? null);
    if (!check.ok) throw new Error(`Cannot reparent: ${check.reason}`);
    state.overrides.set(tabId, parentId ?? null);
    state.inferred.delete(tabId);
    saveSessionState();
    await buildNow('debug-reparent');
    return true;
  },
};
