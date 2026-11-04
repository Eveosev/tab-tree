/**
 * Tab Tree — pure tree engine.
 *
 * No `chrome.*` access in this file on purpose: the service worker feeds it raw
 * `Tab` objects and the unit tests feed it fixtures. Everything here is
 * deterministic and synchronous.
 *
 * Model
 * -----
 * - One forest per browser window.
 * - A tab's parent is, in priority order:
 *     1. an explicit user/restore override (only if the parent is alive, in the
 *        same window, and cannot create a cycle),
 *     2. a captured creation edge: the tab that was the navigation source when
 *        this tab was created. Chrome clears `openerTabId` as soon as a second
 *        foreground tab is opened, so the edge is captured from
 *        `webNavigation.onCreatedNavigationTarget` / `tabs.onCreated` and
 *        persisted for the lifetime of the browser session,
 *     3. `tab.openerTabId` (still useful for background tabs and `window.open`),
 *     4. none -> the tab is a root (address bar, Ctrl+T, bookmark, restart).
 * - Siblings are ordered by Chrome's `tab.index` so the tree tracks the native
 *   tab strip. Collapsed state only hides descendants; it never changes order.
 */

export const SNAPSHOT_VERSION = 1;
export const MAX_DEPTH = 64;

/** @typedef {'light'|'dark'|'auto'} Theme */

export const DEFAULT_PREFS = Object.freeze({
  /** Close the whole subtree when the user closes a parent from the panel. */
  closeChildrenWithParent: false,
  /** Reorder the native tab strip to match the tree after a drag-reparent. */
  autoSortNative: true,
  /** Show the URL under the title in the panel. */
  showUrls: false,
});

/**
 * @typedef {Object} TabLike
 * @property {number} id
 * @property {number} windowId
 * @property {number} index
 * @property {number} [openerTabId]
 * @property {string} [title]
 * @property {string} [url]
 * @property {string} [favIconUrl]
 * @property {boolean} [active]
 * @property {boolean} [pinned]
 * @property {boolean} [audible]
 * @property {boolean} [mutedInfo]
 * @property {boolean} [discarded]
 * @property {number} [groupId]
 */

/**
 * @typedef {Object} TreeNode
 * @property {number} tabId
 * @property {number} windowId
 * @property {number|null} parentId
 * @property {number[]} childIds
 * @property {number} depth
 * @property {number} order     DFS position inside the window
 * @property {number} index     native tab index
 * @property {string} title
 * @property {string} url
 * @property {string} domain
 * @property {string} favIconUrl
 * @property {boolean} active
 * @property {boolean} pinned
 * @property {boolean} audible
 * @property {boolean} muted
 * @property {boolean} discarded
 * @property {boolean} collapsed
 * @property {boolean} hasChildren
 * @property {number} descendantCount
 * @property {number|null} openerTabId
 * @property {'manual'|'restore'|'edge'|'opener'|'orphan'|'cycle-broken'|'root'} relation
 * @property {boolean} orphan     opener was closed / not found
 * @property {boolean} inferred   parent rebuilt from a saved session
 * @property {number} groupId
 */

/** FNV-1a, good enough for a change revision and cheap on 500 tabs. */
export function hashString(input) {
  let hash = 0x811c9dc5;
  for (let i = 0; i < input.length; i += 1) {
    hash ^= input.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(36);
}

export function domainOf(url) {
  if (!url) return '';
  try {
    const parsed = new URL(url);
    if (parsed.protocol === 'chrome:' || parsed.protocol === 'chrome-extension:') {
      const parts = parsed.pathname.split('/').filter(Boolean);
      return parts[0] ? `chrome://${parts[0]}` : 'chrome://';
    }
    if (parsed.protocol === 'file:') return 'file://';
    return parsed.hostname.replace(/^www\./, '');
  } catch {
    return '';
  }
}

export function normalizeUrl(url) {
  if (!url) return '';
  const hashIndex = url.indexOf('#');
  return hashIndex === -1 ? url : url.slice(0, hashIndex);
}

/**
 * Stable identity used only for session restore matching.
 * @param {TabLike} tab
 */
export function tabFingerprint(tab) {
  return `${normalizeUrl(tab.url || '')}\u0000${tab.pinned ? '1' : '0'}`;
}

/**
 * @param {TabLike} tab
 * @returns {TreeNode}
 */
function baseNode(tab) {
  return {
    tabId: tab.id,
    windowId: tab.windowId,
    parentId: null,
    childIds: [],
    depth: 0,
    order: 0,
    index: tab.index ?? 0,
    title: tab.title || tab.url || '(untitled)',
    url: tab.url || '',
    domain: domainOf(tab.url),
    favIconUrl: tab.favIconUrl || '',
    active: Boolean(tab.active),
    pinned: Boolean(tab.pinned),
    audible: Boolean(tab.audible),
    muted: Boolean(tab.mutedInfo?.muted),
    discarded: Boolean(tab.discarded),
    collapsed: false,
    hasChildren: false,
    descendantCount: 0,
    openerTabId: Number.isInteger(tab.openerTabId) ? tab.openerTabId : null,
    relation: 'root',
    orphan: false,
    inferred: false,
    groupId: typeof tab.groupId === 'number' ? tab.groupId : -1,
  };
}

/**
 * Build a full snapshot from live tabs.
 *
 * @param {Object} input
 * @param {TabLike[]} input.tabs
 * @param {Map<number, number|null>} [input.overrides]  tabId -> parentId (null = force root)
 * @param {Map<number, number>} [input.edges]  childTabId -> parentTabId captured when created
 * @param {Set<number>} [input.collapsed]
 * @param {Set<number>} [input.inferred]  tabIds whose parent came from restore
 * @param {Object} [input.prefs]
 * @param {number|null} [input.focusedWindowId]
 * @param {number} [input.now]
 * @returns {Object} snapshot
 */
export function buildSnapshot({
  tabs,
  overrides = new Map(),
  edges = new Map(),
  collapsed = new Set(),
  inferred = new Set(),
  prefs = DEFAULT_PREFS,
  focusedWindowId = null,
  now = Date.now(),
}) {
  const validTabs = new Map();
  const windowTabs = new Map();

  for (const tab of tabs) {
    if (!tab || !Number.isInteger(tab.id) || !Number.isInteger(tab.windowId)) continue;
    validTabs.set(tab.id, tab);
    let list = windowTabs.get(tab.windowId);
    if (!list) {
      list = [];
      windowTabs.set(tab.windowId, list);
    }
    list.push(tab);
  }

  for (const list of windowTabs.values()) {
    list.sort((a, b) => (a.index ?? 0) - (b.index ?? 0) || a.id - b.id);
  }

  /** @type {Map<number, number|null>} */
  const parentById = new Map();
  /** @type {Map<number, string>} */
  const relationSource = new Map();

  const resolveParent = (tab) => {
    const override = overrides.get(tab.id);
    const hasOverride = overrides.has(tab.id);
    if (hasOverride) {
      if (override === null) return { parentId: null, source: 'root' };
      const candidate = validTabs.get(override);
      if (candidate && candidate.windowId === tab.windowId && candidate.id !== tab.id) {
        return { parentId: override, source: inferred.has(tab.id) ? 'restore' : 'manual' };
      }
      // An override to a dead/foreign tab degrades to the captured edge/opener.
    }
    const captured = edges.get(tab.id);
    if (Number.isInteger(captured) && captured !== tab.id) {
      const source = validTabs.get(captured);
      if (source && source.windowId === tab.windowId) {
        return { parentId: captured, source: 'edge' };
      }
    }
    if (Number.isInteger(tab.openerTabId)) {
      const opener = validTabs.get(tab.openerTabId);
      if (opener && opener.windowId === tab.windowId && opener.id !== tab.id) {
        return { parentId: opener.id, source: 'opener' };
      }
      return { parentId: null, source: 'orphan' };
    }
    return { parentId: null, source: 'root' };
  };

  for (const tab of validTabs.values()) {
    const { parentId, source } = resolveParent(tab);
    parentById.set(tab.id, parentId);
    relationSource.set(tab.id, source);
  }

  // Cycle guard: a malicious/stale override chain must never hang the worker.
  for (const tab of validTabs.values()) {
    const seen = new Set([tab.id]);
    let cursor = parentById.get(tab.id) ?? null;
    let steps = 0;
    while (cursor !== null) {
      if (seen.has(cursor) || steps >= MAX_DEPTH) {
        parentById.set(tab.id, null);
        relationSource.set(tab.id, 'cycle-broken');
        break;
      }
      seen.add(cursor);
      cursor = parentById.get(cursor) ?? null;
      steps += 1;
    }
  }

  /** @type {Map<number, TreeNode>} */
  const nodeById = new Map();
  for (const tab of validTabs.values()) {
    const node = baseNode(tab);
    node.parentId = parentById.get(tab.id) ?? null;
    const source = relationSource.get(tab.id);
    node.relation = source;
    node.orphan = source === 'orphan';
    node.inferred = source === 'restore';
    nodeById.set(tab.id, node);
  }

  for (const node of nodeById.values()) {
    if (node.parentId === null) continue;
    const parent = nodeById.get(node.parentId);
    if (parent) parent.childIds.push(node.tabId);
    else node.parentId = null;
  }

  for (const node of nodeById.values()) {
    node.childIds.sort((a, b) => (nodeById.get(a)?.index ?? 0) - (nodeById.get(b)?.index ?? 0));
    node.hasChildren = node.childIds.length > 0;
    node.collapsed = node.hasChildren && collapsed.has(node.tabId);
  }

  const nodes = [];
  const windows = [];
  const windowIds = [...windowTabs.keys()].sort((a, b) => a - b);

  for (const windowId of windowIds) {
    const list = windowTabs.get(windowId);
    const rootIds = list
      .filter((tab) => (nodeById.get(tab.id)?.parentId ?? null) === null)
      .map((tab) => tab.id)
      .sort((a, b) => (nodeById.get(a)?.index ?? 0) - (nodeById.get(b)?.index ?? 0));

    let order = 0;
    const stack = [...rootIds].reverse();
    const seen = new Set();
    while (stack.length > 0) {
      const tabId = stack.pop();
      if (seen.has(tabId)) continue;
      seen.add(tabId);
      const node = nodeById.get(tabId);
      if (!node) continue;
      node.depth = node.parentId === null ? 0 : (nodeById.get(node.parentId)?.depth ?? -1) + 1;
      node.order = order;
      order += 1;
      nodes.push(node);
      for (let i = node.childIds.length - 1; i >= 0; i -= 1) {
        if (!seen.has(node.childIds[i])) stack.push(node.childIds[i]);
      }
    }

    // Any node unreachable through roots (should not happen after cycle guard)
    // is appended as a root so the panel never silently loses a tab.
    for (const tab of list) {
      const node = nodeById.get(tab.id);
      if (!node || seen.has(node.tabId)) continue;
      node.parentId = null;
      node.depth = 0;
      node.order = order;
      order += 1;
      node.inferred = false;
      rootIds.push(node.tabId);
      nodes.push(node);
    }

    const activeTab = list.find((tab) => tab.active);
    windows.push({
      id: windowId,
      focused: windowId === focusedWindowId,
      tabCount: list.length,
      activeTabId: activeTab ? activeTab.id : null,
      rootIds,
      collapsedCount: list.filter((tab) => nodeById.get(tab.id)?.collapsed).length,
    });
  }

  // Descendant counts, bottom-up over DFS order (children always follow parents).
  for (let i = nodes.length - 1; i >= 0; i -= 1) {
    const node = nodes[i];
    if (node.parentId === null) continue;
    const parent = nodeById.get(node.parentId);
    if (parent) parent.descendantCount += node.descendantCount + 1;
  }

  const activeWindow = windows.find((w) => w.focused) || windows[0] || null;
  const activeTabId = activeWindow ? activeWindow.activeTabId : null;

  // Small, UI-facing counters. The side panel uses them to distinguish "this
  // browser has no link relationships yet" (show onboarding) from a real empty
  // or restored tree. Overrides on live tabs are counted separately so a
  // restore-inferred link is never presented as a manually captured one.
  const parented = nodes.filter((node) => node.parentId !== null).length;
  const manualLinks = [...overrides.entries()].filter(([tabId]) => !inferred.has(tabId)).length;
  const linkStats = {
    captured: edges.size,
    manual: manualLinks,
    restored: inferred.size,
    parented,
    roots: nodes.length - parented,
  };

  const normalizedPrefs = { ...DEFAULT_PREFS, ...(prefs || {}) };
  // Hash the displayed content, not just its length: two tabs with equal-length
  // titles must still trigger a panel update when their text changes.
  const revision = hashString(
    nodes
      .map(
        (node) =>
          `${node.tabId}:${node.parentId ?? '-'}:${node.depth}:${node.index}:${node.collapsed ? 1 : 0}:${
            node.active ? 1 : 0
          }:${node.inferred ? 1 : 0}:${node.orphan ? 1 : 0}:${node.pinned ? 1 : 0}:${
            node.audible ? 1 : 0
          }:${node.muted ? 1 : 0}:${node.discarded ? 1 : 0}:${node.relation}:${hashString(node.title)}:${
            hashString(node.url)
          }:${hashString(node.favIconUrl)}`,
      )
      .join('|') +
      `|${focusedWindowId ?? '-'}|${windows.map((w) => `${w.id}:${w.tabCount}`).join(',')}`,
  );

  return {
    version: SNAPSHOT_VERSION,
    revision,
    updatedAt: now,
    focusedWindowId: activeWindow ? activeWindow.id : null,
    activeTabId,
    prefs: normalizedPrefs,
    windows,
    nodes,
    linkStats,
    restoring: null,
    restore: null,
  };
}

/**
 * Descendant tab ids (excluding the tab itself).
 * @param {TreeNode[]} nodes
 * @param {number} tabId
 * @returns {number[]}
 */
export function getDescendantIds(nodes, tabId) {
  const children = new Map();
  for (const node of nodes) {
    if (node.parentId === null) continue;
    let list = children.get(node.parentId);
    if (!list) {
      list = [];
      children.set(node.parentId, list);
    }
    list.push(node.tabId);
  }
  const out = [];
  const queue = [...(children.get(tabId) || [])];
  const seen = new Set();
  while (queue.length > 0) {
    const id = queue.shift();
    if (seen.has(id)) continue;
    seen.add(id);
    out.push(id);
    const next = children.get(id);
    if (next) queue.push(...next);
  }
  return out;
}

/**
 * @param {TreeNode[]} nodes
 * @param {number} tabId
 * @param {number|null} parentId
 * @returns {{ok: boolean, reason?: string}}
 */
export function canReparent(nodes, tabId, parentId) {
  const byId = new Map(nodes.map((node) => [node.tabId, node]));
  const self = byId.get(tabId);
  if (!self) return { ok: false, reason: 'missing-tab' };
  if (parentId === null) return { ok: true };
  if (parentId === tabId) return { ok: false, reason: 'self' };
  const parent = byId.get(parentId);
  if (!parent) return { ok: false, reason: 'missing-parent' };
  if (parent.windowId !== self.windowId) return { ok: false, reason: 'cross-window' };
  let cursor = parent;
  const seen = new Set([parent.tabId]);
  while (cursor.parentId !== null) {
    if (cursor.parentId === tabId) return { ok: false, reason: 'cycle' };
    if (seen.has(cursor.parentId)) return { ok: false, reason: 'cycle' };
    seen.add(cursor.parentId);
    const next = byId.get(cursor.parentId);
    if (!next) break;
    cursor = next;
  }
  return { ok: true };
}

/**
 * Native tab order that matches the tree: pinned tabs first (Chrome pins them
 * to the strip start), then DFS order of the remaining tabs in the window.
 *
 * @param {Object} snapshot
 * @param {number} windowId
 * @returns {{pinned: number[], unpinned: number[]}}
 */
export function computeNativeOrder(snapshot, windowId) {
  const windowNodes = snapshot.nodes.filter((node) => node.windowId === windowId);
  const pinned = windowNodes
    .filter((node) => node.pinned)
    .sort((a, b) => a.index - b.index)
    .map((node) => node.tabId);
  const pinnedSet = new Set(pinned);
  const unpinned = windowNodes
    .filter((node) => !pinnedSet.has(node.tabId))
    .sort((a, b) => a.order - b.order)
    .map((node) => node.tabId);
  return { pinned, unpinned };
}

/**
 * Compact snapshot persisted in `chrome.storage.local` for the next browser
 * session (tab ids are not stable across restarts).
 * @param {Object} snapshot
 */
export function serializeRestoreSnapshot(snapshot) {
  return {
    version: SNAPSHOT_VERSION,
    savedAt: snapshot.updatedAt,
    focusedWindowId: snapshot.focusedWindowId,
    windows: snapshot.windows.map((w) => ({ id: w.id, rootIds: w.rootIds })),
    nodes: snapshot.nodes.map((node) => ({
      tabId: node.tabId,
      parentId: node.parentId,
      windowId: node.windowId,
      index: node.index,
      pinned: node.pinned,
      title: node.title,
      url: node.url,
    })),
  };
}

/**
 * Longest common subsequence of two arrays; returns index pairs.
 * Used to align a saved window with the new window after restart, preserving
 * order even with duplicate URLs and a few closed/reordered tabs.
 */
export function lcsPairs(a, b) {
  const n = a.length;
  const m = b.length;
  const width = m + 1;
  const table = new Int32Array((n + 1) * width);
  for (let i = n - 1; i >= 0; i -= 1) {
    for (let j = m - 1; j >= 0; j -= 1) {
      table[i * width + j] =
        a[i] === b[j]
          ? table[(i + 1) * width + (j + 1)] + 1
          : Math.max(table[(i + 1) * width + j], table[i * width + (j + 1)]);
    }
  }
  const pairs = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      pairs.push([i, j]);
      i += 1;
      j += 1;
    } else if (table[(i + 1) * width + j] >= table[i * width + (j + 1)]) {
      i += 1;
    } else {
      j += 1;
    }
  }
  return pairs;
}

/**
 * Align a saved restore snapshot with the live tabs after a browser restart.
 * Chrome does not preserve `openerTabId` across restarts, so this is the only
 * way to bring the forest back. Windows are paired by URL overlap, tabs by
 * order-preserving URL alignment, and relations are transferred only when both
 * endpoints matched.
 *
 * @param {Object|null} saved
 * @param {TabLike[]} tabs
 * @param {{now?: number, restart?: boolean, minAgeMs?: number}} [options]
 *   `restart` is supplied by the service worker when `chrome.storage.session`
 *   proves this is a fresh browser session (session storage is wiped on
 *   restart). It is the authoritative signal; the age check only protects
 *   against applying a snapshot captured moments ago during an extension
 *   reload/update in the same browser session.
 * @returns {{
 *   applicable: boolean,
 *   overrides: Map<number, number|null>,
 *   inferred: Set<number>,
 *   stats: {oldNodes: number, newTabs: number, matchedTabs: number, relations: number, windows: number, savedAt: number|null}
 * }}
 */
export function matchRestoreSnapshot(saved, tabs, options = {}) {
  const empty = {
    applicable: false,
    overrides: new Map(),
    inferred: new Set(),
    stats: { oldNodes: 0, newTabs: 0, matchedTabs: 0, relations: 0, windows: 0, savedAt: null },
  };
  if (!saved || !Array.isArray(saved.nodes) || !Array.isArray(tabs)) return empty;
  const oldNodes = saved.nodes.filter(
    (node) => node && Number.isInteger(node.tabId) && Number.isInteger(node.windowId),
  );
  const liveTabs = tabs.filter((tab) => tab && Number.isInteger(tab.id) && Number.isInteger(tab.windowId));
  if (oldNodes.length === 0 || liveTabs.length === 0) return empty;

  const ageMs = options.now && saved.savedAt ? options.now - saved.savedAt : Infinity;
  const minAgeMs = Number.isFinite(options.minAgeMs) ? options.minAgeMs : 15_000;
  const applicable = options.restart === true || ageMs > minAgeMs;
  if (!applicable) return { ...empty, stats: { ...empty.stats, oldNodes: oldNodes.length, newTabs: liveTabs.length, savedAt: saved.savedAt ?? null } };

  const oldByWindow = new Map();
  for (const node of oldNodes) {
    let list = oldByWindow.get(node.windowId);
    if (!list) {
      list = [];
      oldByWindow.set(node.windowId, list);
    }
    list.push(node);
  }
  for (const list of oldByWindow.values()) {
    list.sort((a, b) => (a.index ?? 0) - (b.index ?? 0) || a.tabId - b.tabId);
  }

  const newByWindow = new Map();
  for (const tab of liveTabs) {
    let list = newByWindow.get(tab.windowId);
    if (!list) {
      list = [];
      newByWindow.set(tab.windowId, list);
    }
    list.push(tab);
  }
  for (const list of newByWindow.values()) {
    list.sort((a, b) => (a.index ?? 0) - (b.index ?? 0) || a.id - b.id);
  }

  const urlCount = (list) => {
    const map = new Map();
    for (const item of list) {
      const key = tabFingerprint(item);
      map.set(key, (map.get(key) || 0) + 1);
    }
    return map;
  };
  const overlap = (a, b) => {
    const counts = urlCount(a);
    let score = 0;
    for (const item of b) {
      const key = tabFingerprint(item);
      const left = counts.get(key) || 0;
      if (left > 0) {
        score += 1;
        counts.set(key, left - 1);
      }
    }
    return score;
  };

  const oldWindowIds = [...oldByWindow.keys()];
  const newWindowIds = [...newByWindow.keys()];
  const candidates = [];
  for (const oldId of oldWindowIds) {
    for (const newId of newWindowIds) {
      const score = overlap(oldByWindow.get(oldId), newByWindow.get(newId));
      if (score > 0) candidates.push({ oldId, newId, score });
    }
  }
  candidates.sort((a, b) => b.score - a.score || a.newId - b.newId);

  const usedOld = new Set();
  const usedNew = new Set();
  const windowPairs = [];
  for (const candidate of candidates) {
    if (usedOld.has(candidate.oldId) || usedNew.has(candidate.newId)) continue;
    usedOld.add(candidate.oldId);
    usedNew.add(candidate.newId);
    windowPairs.push(candidate);
  }

  /** @type {Map<number, number>} old tabId -> new tabId */
  const idMap = new Map();
  for (const pair of windowPairs) {
    const oldList = oldByWindow.get(pair.oldId);
    const newList = newByWindow.get(pair.newId);
    const pairs = lcsPairs(oldList.map(tabFingerprint), newList.map(tabFingerprint));
    for (const [oldIndex, newIndex] of pairs) {
      idMap.set(oldList[oldIndex].tabId, newList[newIndex].id);
    }
  }

  const overrides = new Map();
  const inferred = new Set();
  let relations = 0;
  for (const node of oldNodes) {
    const newTabId = idMap.get(node.tabId);
    if (!newTabId) continue;
    inferred.add(newTabId);
    if (node.parentId === null) {
      overrides.set(newTabId, null);
      continue;
    }
    const newParentId = idMap.get(node.parentId);
    if (newParentId && newParentId !== newTabId) {
      overrides.set(newTabId, newParentId);
      relations += 1;
    } else {
      overrides.set(newTabId, null);
    }
  }

  return {
    applicable: true,
    overrides,
    inferred,
    stats: {
      oldNodes: oldNodes.length,
      newTabs: liveTabs.length,
      matchedTabs: idMap.size,
      relations,
      windows: windowPairs.length,
      savedAt: saved.savedAt ?? null,
    },
  };
}

/**
 * Remove overrides/references to tabs that no longer exist.
 * @param {Map<number, number|null>} overrides
 * @param {Set<number>} liveIds
 */
export function pruneOverrides(overrides, liveIds) {
  for (const key of [...overrides.keys()]) {
    if (!liveIds.has(key)) {
      overrides.delete(key);
      continue;
    }
    const parent = overrides.get(key);
    if (parent !== null && parent !== undefined && !liveIds.has(parent)) overrides.delete(key);
  }
  return overrides;
}

/**
 * Drop captured creation edges whose endpoints were closed, moved to another
 * window, or point at themselves. Mutates and returns the map.
 *
 * @param {Map<number, number>} edges
 * @param {TabLike[]} tabs
 */
export function pruneEdges(edges, tabs) {
  const live = new Map();
  for (const tab of tabs) {
    if (tab && Number.isInteger(tab.id) && Number.isInteger(tab.windowId)) live.set(tab.id, tab);
  }
  for (const [childId, parentId] of [...edges.entries()]) {
    const child = live.get(childId);
    const parent = live.get(parentId);
    if (
      !child ||
      !parent ||
      childId === parentId ||
      child.windowId !== parent.windowId ||
      !Number.isInteger(parentId)
    ) {
      edges.delete(childId);
    }
  }
  return edges;
}

/**
 * Children that become orphans when `removedTabId` closes.
 *
 * Product policy (when the user is not explicitly closing the subtree) is to
 * promote the direct children one level, i.e. to the removed tab's parent, so
 * A > B > C becomes A > C instead of A > C > D losing a level.
 *
 * @param {TreeNode[]} nodes
 * @param {number} removedTabId
 * @returns {{grandparentId: number|null, children: number[]}}
 */
export function planOrphanPromotion(nodes, removedTabId) {
  const node = nodes.find((item) => item.tabId === removedTabId);
  return {
    grandparentId: node ? node.parentId : null,
    children: nodes.filter((item) => item.parentId === removedTabId).map((item) => item.tabId),
  };
}

/**
 * Visible rows for the panel: applies search and collapsed state while keeping
 * ancestors of search matches visible. Pure so it is covered by unit tests.
 *
 * @param {Object} snapshot
 * @param {number} windowId
 * @param {{query?: string, collapsed?: Set<number>, forceExpand?: boolean}} [options]
 * @returns {TreeNode[]}
 */
export function getVisibleNodes(snapshot, windowId, options = {}) {
  const query = (options.query || '').trim().toLowerCase();
  const collapsed = options.collapsed;
  const forceExpand = Boolean(options.forceExpand);
  const byId = new Map(snapshot.nodes.map((node) => [node.tabId, node]));
  const roots = snapshot.windows.find((w) => w.id === windowId)?.rootIds || [];

  const matches = new Set();
  if (query) {
    for (const node of snapshot.nodes) {
      if (node.windowId !== windowId) continue;
      const haystack = `${node.title}\n${node.url}`.toLowerCase();
      if (haystack.includes(query)) matches.add(node.tabId);
    }
  }
  const keep = new Set(matches);
  if (query) {
    for (const tabId of matches) {
      let cursor = byId.get(tabId);
      while (cursor && cursor.parentId !== null) {
        keep.add(cursor.parentId);
        cursor = byId.get(cursor.parentId);
      }
    }
  }

  const out = [];
  const walk = (tabId, depth) => {
    const node = byId.get(tabId);
    if (!node) return;
    if (query && !keep.has(tabId)) return;
    const effectiveCollapsed =
      !forceExpand &&
      !query &&
      ((collapsed && collapsed.has(tabId)) || node.collapsed);
    out.push({ ...node, depth });
    if (effectiveCollapsed) return;
    for (const childId of node.childIds) walk(childId, depth + 1);
  };
  for (const rootId of roots) walk(rootId, 0);
  return out;
}
