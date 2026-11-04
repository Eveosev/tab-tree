/**
 * Pure session-state codec used by the MV3 service worker.
 *
 * `chrome.storage.session` survives a worker wake but is wiped by a browser
 * restart. The marker, creation edges, drag overrides, collapse set and the
 * `inferred` (restored-relation) set must be read and written together: if any
 * of them is omitted from the read list, the worker silently starts with a
 * partial tree. Keeping the codec here lets `node --test` exercise the
 * round-trip without a browser.
 *
 * Maps are stored as `[key, value]` entries because storage values are JSON.
 */

/** Every key the worker must request from `chrome.storage.session`. */
export const SESSION_KEYS = Object.freeze([
  'overrides',
  'edges',
  'collapsed',
  'inferred',
  'sessionMarker',
  'restorePending',
]);

/**
 * Persist only the serialisable progress of a restart reconciliation. Timers
 * and the matcher result stay in memory; if the MV3 worker is reclaimed mid
 * restore, this tiny record lets the next worker resume where it stopped
 * instead of treating the wake as a normal session and abandoning the tree.
 *
 * @param {Object|null|undefined} pending
 */
export function encodeRestorePending(pending) {
  if (!pending || typeof pending !== 'object') return null;
  const stats = pending.best?.stats || {};
  return {
    savedAt: Number.isFinite(pending.savedAt) ? pending.savedAt : null,
    startedAt: Number.isFinite(pending.startedAt) ? pending.startedAt : null,
    matchedTabs: Number.isInteger(stats.matchedTabs) ? stats.matchedTabs : 0,
    oldNodes: Number.isInteger(stats.oldNodes)
      ? stats.oldNodes
      : Number.isInteger(pending.total)
        ? pending.total
        : 0,
    relations: Number.isInteger(stats.relations) ? stats.relations : 0,
  };
}

/**
 * @param {Object} raw
 * @returns {null|{savedAt: number|null, startedAt: number|null, matchedTabs: number, oldNodes: number, relations: number}}
 */
export function decodeRestorePending(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const savedAt = Number.isFinite(raw.savedAt) ? raw.savedAt : null;
  const startedAt = Number.isFinite(raw.startedAt) ? raw.startedAt : null;
  const matchedTabs = Number.isInteger(raw.matchedTabs) && raw.matchedTabs >= 0 ? raw.matchedTabs : 0;
  const oldNodes = Number.isInteger(raw.oldNodes) && raw.oldNodes >= 0 ? raw.oldNodes : 0;
  const relations = Number.isInteger(raw.relations) && raw.relations >= 0 ? raw.relations : 0;
  return { savedAt, startedAt, matchedTabs, oldNodes, relations };
}

/**
 * @param {{overrides?: Map<number, number|null>, edges?: Map<number, number>, collapsed?: Set<number>, inferred?: Set<number>, pendingRestore?: Object|null}} state
 */
export function encodeSessionState(state = {}) {
  return {
    overrides: [...(state.overrides || new Map()).entries()],
    edges: [...(state.edges || new Map()).entries()],
    collapsed: [...(state.collapsed || new Set())],
    inferred: [...(state.inferred || new Set())],
    restorePending: encodeRestorePending(state.pendingRestore),
  };
}

/**
 * @param {Object} raw value returned by `chrome.storage.session.get(SESSION_KEYS)`
 * @returns {{overrides: Map<number, number|null>, edges: Map<number, number>, collapsed: Set<number>, inferred: Set<number>, sessionMarker: number|null, restorePending: Object|null}}
 */
export function decodeSessionState(raw = {}) {
  const overrides = new Map();
  const edges = new Map();
  const collapsed = new Set();
  const inferred = new Set();

  if (Array.isArray(raw.overrides)) {
    for (const entry of raw.overrides) {
      if (!Array.isArray(entry) || !Number.isInteger(entry[0])) continue;
      overrides.set(entry[0], entry[1] === null ? null : Number(entry[1]));
    }
  }
  if (Array.isArray(raw.edges)) {
    for (const entry of raw.edges) {
      if (Array.isArray(entry) && Number.isInteger(entry[0]) && Number.isInteger(entry[1])) {
        edges.set(entry[0], entry[1]);
      }
    }
  }
  if (Array.isArray(raw.collapsed)) {
    for (const tabId of raw.collapsed) {
      if (Number.isInteger(tabId)) collapsed.add(tabId);
    }
  }
  if (Array.isArray(raw.inferred)) {
    for (const tabId of raw.inferred) {
      if (Number.isInteger(tabId)) inferred.add(tabId);
    }
  }

  return {
    overrides,
    edges,
    collapsed,
    inferred,
    sessionMarker: Number.isInteger(raw.sessionMarker) ? raw.sessionMarker : null,
    restorePending: decodeRestorePending(raw.restorePending),
  };
}

/**
 * Read and decode session state from a storage area (normally
 * `chrome.storage.session`, or a fake in unit tests).
 */
export async function readSessionState(storage) {
  const raw = await storage.get(SESSION_KEYS);
  return decodeSessionState(raw);
}

/** Encode and write session state to a storage area. */
export async function writeSessionState(storage, state) {
  await storage.set(encodeSessionState(state));
}
