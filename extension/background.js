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
  planOrphanPromotion,
  pruneEdges,
  pruneOverrides,
  serializeRestoreSnapshot,
} from './lib/tree-engine.js';

const PORT_NAME = 'tab-tree';
const STORAGE = {
  prefs: 'prefs',
  overrides: 'overrides',
  edges: 'edges',
  collapsed: 'collapsed',
  restoreSnapshot: 'restoreSnapshot',
  restoreStats: 'restoreStats',
  sessionMarker: 'sessionMarker',
};

const state = {
  /** @type {Object|null} */
  snapshot: null,
  /** @type {Map<number, number|null>} */
  overrides: new Map(),
  /**
   * childTabId -> parentTabId captured when the tab was created from a link /
   * `window.open`. Chrome's `openerTabId` is transient (it is wiped when a
   * second foreground tab opens), so this session-persisted map is the source
   * of truth for "which page opened this tab".
   * @type {Map<number, number>}
   */
  edges: new Map(),
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
  /** True when this worker was woken by chrome.runtime.onStartup. */
  startupSignal: false,
  /** Tabs that are being closed as a subtree; do not promote their children. */
  closing: new Set(),
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
    chrome.storage.session.get([STORAGE.overrides, STORAGE.edges, STORAGE.collapsed]),
  ]);
  state.prefs = { ...DEFAULT_PREFS, ...(local[STORAGE.prefs] || {}) };
  if (Array.isArray(session[STORAGE.overrides])) {
    for (const entry of session[STORAGE.overrides]) {
      if (Array.isArray(entry) && Number.isInteger(entry[0])) {
        state.overrides.set(entry[0], entry[1] === null ? null : Number(entry[1]));
      }
    }
  }
  if (Array.isArray(session[STORAGE.edges])) {
    for (const entry of session[STORAGE.edges]) {
      // A creation edge captured by an event that fired while this worker was
      // starting is newer than the persisted one; never clobber it.
      if (Array.isArray(entry) && Number.isInteger(entry[0]) && Number.isInteger(entry[1])) {
        if (!state.edges.has(entry[0])) state.edges.set(entry[0], entry[1]);
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
    sessionMarker: session[STORAGE.sessionMarker] ?? null,
  };
}

function persistSession() {
  return chrome.storage.session
    .set({
      [STORAGE.overrides]: [...state.overrides.entries()],
      [STORAGE.edges]: [...state.edges.entries()],
      [STORAGE.collapsed]: [...state.collapsed],
    })
    .catch((error) => console.warn('[tab-tree] session persist failed', error));
}

function saveSessionState({ immediate = false } = {}) {
  clearTimeout(sessionTimer);
  if (immediate) {
    persistSession();
    return;
  }
  sessionTimer = setTimeout(persistSession, 120);
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
/* Creation edges                                                             */
/* -------------------------------------------------------------------------- */

/**
 * Remember "parent opened child" for the lifetime of this browser session.
 *
 * This must happen synchronously in the event listener: Chrome's
 * `Tab.openerTabId` is cleared by the browser as soon as another tab is
 * inserted in the foreground, so reading it later (or relying on it in a
 * debounced rebuild) loses the relation. `webNavigation.onCreatedNavigationTarget`
 * and `tabs.onCreated` both fire early; the first one wins for a given child.
 *
 * @param {number} childTabId
 * @param {number} parentTabId
 * @param {string} source
 */
function captureEdge(childTabId, parentTabId, source) {
  if (!Number.isInteger(childTabId) || !Number.isInteger(parentTabId)) return;
  if (childTabId === parentTabId) return;
  if (state.closing.has(childTabId)) return;
  if (state.edges.get(childTabId) === parentTabId) return;
  state.edges.set(childTabId, parentTabId);
  saveSessionState({ immediate: true });
  scheduleBuild(`edge-${source}`, 40);
}

/**
 * Handle a tab closing outside the panel's subtree-close path: promote its
 * direct children one level (A > B > C becomes A > C) instead of losing them.
 * The snapshot still reflects the pre-close tree when this listener runs.
 */
function handleExternalTabRemoved(tabId) {
  if (state.closing.has(tabId)) {
    state.closing.delete(tabId);
  } else if (state.snapshot) {
    const { grandparentId, children } = planOrphanPromotion(state.snapshot.nodes, tabId);
    for (const childId of children) {
      if (state.overrides.get(childId) === tabId) {
        if (grandparentId === null) state.overrides.delete(childId);
        else state.overrides.set(childId, grandparentId);
        continue;
      }
      // The child may only have an opener relation. Persist the promotion as a
      // creation edge now, because Chrome's openerTabId dies with the parent.
      if (grandparentId === null) state.edges.delete(childId);
      else state.edges.set(childId, grandparentId);
    }
  }
  state.edges.delete(tabId);
  state.overrides.delete(tabId);
  state.collapsed.delete(tabId);
  state.inferred.delete(tabId);
  state.closing.delete(tabId);
  saveSessionState({ immediate: true });
}

/** Move every relation pointing at `removedTabId` over to `addedTabId`. */
function migrateTabId(removedTabId, addedTabId) {
  for (const [childId, parentId] of [...state.edges.entries()]) {
    if (childId === removedTabId) {
      state.edges.delete(childId);
      if (parentId !== addedTabId) state.edges.set(addedTabId, parentId);
    } else if (parentId === removedTabId) {
      state.edges.set(childId, addedTabId);
    }
  }
  for (const [childId, parentId] of [...state.overrides.entries()]) {
    if (childId === removedTabId) {
      state.overrides.delete(childId);
      state.overrides.set(addedTabId, parentId);
    } else if (parentId === removedTabId) {
      state.overrides.set(childId, addedTabId);
    }
  }
  if (state.collapsed.has(removedTabId)) {
    state.collapsed.delete(removedTabId);
    state.collapsed.add(addedTabId);
  }
  if (state.inferred.has(removedTabId)) {
    state.inferred.delete(removedTabId);
    state.inferred.add(addedTabId);
  }
  saveSessionState({ immediate: true });
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
    pruneEdges(state.edges, tabs);
    // Safety net for tabs Chrome created with `openerTabId` outside a
    // navigation target (e.g. chrome.tabs.create, some window.open paths):
    // persist the live opener before a later foreground insertion wipes it.
    let learnedEdges = 0;
    for (const tab of tabs) {
      if (
        Number.isInteger(tab.openerTabId) &&
        tab.openerTabId !== tab.id &&
        liveIds.has(tab.openerTabId) &&
        !state.edges.has(tab.id)
      ) {
        state.edges.set(tab.id, tab.openerTabId);
        learnedEdges += 1;
      }
    }
    if (learnedEdges > 0) saveSessionState({ immediate: true });
    for (const tabId of [...state.collapsed]) {
      if (!liveIds.has(tabId)) state.collapsed.delete(tabId);
    }
    for (const tabId of [...state.inferred]) {
      if (!liveIds.has(tabId)) state.inferred.delete(tabId);
    }
    for (const tabId of [...state.closing]) {
      if (!liveIds.has(tabId)) state.closing.delete(tabId);
    }

    const snapshot = buildSnapshot({
      tabs,
      overrides: state.overrides,
      edges: state.edges,
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
  const newBrowserSession = local.sessionMarker === null;
  if (newBrowserSession) {
    await chrome.storage.session.set({ [STORAGE.sessionMarker]: Date.now() });
  }

  const tabs = await chrome.tabs.query({});
  pruneOverrides(state.overrides, new Set(tabs.map((tab) => tab.id)));
  pruneEdges(state.edges, tabs);

  // `storage.session` survives service-worker restarts but is wiped when the
  // browser restarts. A missing marker (or an onStartup wake) is therefore the
  // restart signal; a plain worker wake must never re-apply the timestamped
  // snapshot over the live tree. A live openerTabId means Chrome still knows
  // relations for this session (e.g. extension reload), so there is nothing to
  // reconstruct and applying a stale snapshot would only add noise.
  const liveOpeners = tabs.some((tab) => Number.isInteger(tab.openerTabId));
  const isRestart = newBrowserSession || state.startupSignal;
  if (isRestart && !liveOpeners && local.restoreSnapshot) {
    const matched = matchRestoreSnapshot(local.restoreSnapshot, tabs, {
      now: Date.now(),
      restart: true,
    });
    if (matched.applicable && matched.stats.matchedTabs > 0) {
      state.overrides = new Map(matched.overrides);
      state.inferred = new Set(matched.inferred);
      state.restore = { appliedAt: Date.now(), stats: matched.stats };
      await chrome.storage.local.set({
        [STORAGE.restoreStats]: { appliedAt: Date.now(), stats: matched.stats },
      });
      saveSessionState({ immediate: true });
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

  if (shouldCloseSubtree) {
    // Mark the whole set as "going away" so `tabs.onRemoved` does not promote
    // children of a parent that is itself being closed in the same operation.
    for (const id of ids) {
      state.closing.add(id);
      state.overrides.delete(id);
      state.edges.delete(id);
      state.collapsed.delete(id);
      state.inferred.delete(id);
    }
  } else {
    // Children of this tab must be promoted one level by the onRemoved handler,
    // so keep the snapshot/edges until then and only drop the tab's own state.
    state.overrides.delete(tabId);
    state.edges.delete(tabId);
    state.collapsed.delete(tabId);
    state.inferred.delete(tabId);
  }
  saveSessionState({ immediate: true });

  await chrome.tabs.remove(ids);
  for (const id of ids) {
    state.closing.delete(id);
    state.overrides.delete(id);
    state.collapsed.delete(id);
    state.inferred.delete(id);
  }
  saveSessionState({ immediate: true });
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

chrome.tabs.onCreated.addListener((tab) => {
  // Capture the browser-provided opener immediately: Chrome clears it as soon
  // as the next foreground tab is inserted.
  if (Number.isInteger(tab.openerTabId)) captureEdge(tab.id, tab.openerTabId, 'onCreated');
  scheduleBuild('tabs-created');
});
chrome.tabs.onRemoved.addListener((tabId) => {
  handleExternalTabRemoved(tabId);
  scheduleBuild('tabs-removed');
});
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
  migrateTabId(removedTabId, addedTabId);
  scheduleBuild('tab-replaced');
});
if (chrome.webNavigation?.onCreatedNavigationTarget) {
  // Fires for foreground links, Cmd/Ctrl+click, middle-click and window.open,
  // before Chrome forgets the opener. This is the primary relation signal.
  chrome.webNavigation.onCreatedNavigationTarget.addListener((details) => {
    captureEdge(details.tabId, details.sourceTabId, 'webNavigation');
  });
}
chrome.windows.onFocusChanged.addListener((windowId) => {
  if (windowId === chrome.windows.WINDOW_ID_NONE) return;
  state.focusedWindowId = windowId;
  scheduleBuild('window-focus');
});
chrome.windows.onRemoved.addListener(rebuild);

chrome.runtime.onStartup.addListener(() => {
  state.startupSignal = true;
  scheduleBuild('startup');
});
chrome.runtime.onInstalled.addListener((details) => {
  scheduleBuild('installed');
  if (details.reason === 'install') console.info('[tab-tree] installed');
});
chrome.runtime.onSuspend.addListener(() => {
  if (state.snapshot) persistSnapshot(state.snapshot);
  saveSessionState({ immediate: true });
});

// Make the toolbar action open the side panel (Chrome 114+). If the API is
// unavailable the extension still works by pinning the panel manually.
if (chrome.sidePanel?.setPanelBehavior) {
  chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch((error) => {
    console.warn('[tab-tree] sidePanel behavior failed', error);
  });
}

// Diagnostics hook for automated smoke tests. Store installs have an
// `update_url` in the manifest; unpacked/dev builds do not, so the hook is not
// exposed in a production package. It only exposes state plus the same
// validated override path the drag UI uses.
if (!chrome.runtime.getManifest().update_url) {
  globalThis.__TAB_TREE_DEBUG__ = {
    snapshot: () => state.snapshot,
    overrides: () => [...state.overrides.entries()],
    edges: () => [...state.edges.entries()],
    rebuild: () => buildNow('debug'),
    setParent: async (tabId, parentId) => {
      await buildNow('debug-prebuild');
      const check = canReparent(state.snapshot?.nodes || [], tabId, parentId ?? null);
      if (!check.ok) throw new Error(`Cannot reparent: ${check.reason}`);
      state.overrides.set(tabId, parentId ?? null);
      state.inferred.delete(tabId);
      saveSessionState({ immediate: true });
      await buildNow('debug-reparent');
      return true;
    },
  };
}
