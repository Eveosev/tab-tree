import test from 'node:test';
import assert from 'node:assert/strict';

import {
  DEFAULT_PREFS,
  MAX_DEPTH,
  buildSnapshot,
  canReparent,
  computeNativeOrder,
  getDescendantIds,
  getVisibleNodes,
  hashString,
  lcsPairs,
  matchRestoreSnapshot,
  normalizeUrl,
  planOrphanPromotion,
  pruneEdges,
  pruneOverrides,
  serializeRestoreSnapshot,
} from '../extension/lib/tree-engine.js';

/** @param {Partial<any>} overrides */
function tab(overrides) {
  return {
    id: 1,
    windowId: 1,
    index: 0,
    title: 'tab',
    url: 'https://example.com/',
    active: false,
    pinned: false,
    ...overrides,
  };
}

function byId(snapshot, tabId) {
  return snapshot.nodes.find((node) => node.tabId === tabId);
}

/* -------------------------------------------------------------------------- */
/* Parent inference                                                          */
/* -------------------------------------------------------------------------- */

test('a tab opened from a page becomes its child', () => {
  const snapshot = buildSnapshot({
    tabs: [
      tab({ id: 1, index: 0, title: 'A' }),
      tab({ id: 2, index: 1, openerTabId: 1, title: 'B' }),
    ],
    focusedWindowId: 1,
  });

  assert.equal(byId(snapshot, 2).parentId, 1);
  assert.equal(byId(snapshot, 2).depth, 1);
  assert.deepEqual(byId(snapshot, 1).childIds, [2]);
  assert.deepEqual(snapshot.windows[0].rootIds, [1]);
});

test('a tab opened from the address bar is a root, sibling of A', () => {
  const snapshot = buildSnapshot({
    tabs: [
      tab({ id: 1, index: 0, title: 'A' }),
      tab({ id: 2, index: 1, openerTabId: 1, title: 'B' }),
      tab({ id: 3, index: 2, title: 'C' }),
    ],
    focusedWindowId: 1,
  });

  assert.equal(byId(snapshot, 3).parentId, null);
  assert.equal(byId(snapshot, 3).depth, 0);
  assert.deepEqual(snapshot.windows[0].rootIds, [1, 3]);
});

test('nested links produce A > B > C depths', () => {
  const snapshot = buildSnapshot({
    tabs: [
      tab({ id: 1, index: 0 }),
      tab({ id: 2, index: 1, openerTabId: 1 }),
      tab({ id: 3, index: 2, openerTabId: 2 }),
      tab({ id: 4, index: 3, openerTabId: 3 }),
    ],
    focusedWindowId: 1,
  });

  assert.deepEqual(
    [1, 2, 3, 4].map((id) => byId(snapshot, id).depth),
    [0, 1, 2, 3],
  );
  assert.deepEqual(byId(snapshot, 1).childIds, [2]);
  assert.deepEqual(byId(snapshot, 2).childIds, [3]);
});

test('a dead opener promotes the tab to root and marks it orphan', () => {
  const snapshot = buildSnapshot({
    tabs: [
      tab({ id: 1, index: 0 }),
      tab({ id: 2, index: 1, openerTabId: 999 }),
    ],
    focusedWindowId: 1,
  });

  const node = byId(snapshot, 2);
  assert.equal(node.parentId, null);
  assert.equal(node.orphan, true);
});

test('an opener in another window does not create a cross-window child', () => {
  const snapshot = buildSnapshot({
    tabs: [
      tab({ id: 1, windowId: 1, index: 0 }),
      tab({ id: 2, windowId: 2, index: 0, openerTabId: 1 }),
    ],
    focusedWindowId: 2,
  });

  assert.equal(byId(snapshot, 2).parentId, null);
  assert.deepEqual(snapshot.windows.map((w) => w.id), [1, 2]);
});

test('manual override beats openerTabId and null override forces a root', () => {
  const manual = buildSnapshot({
    tabs: [
      tab({ id: 1, index: 0 }),
      tab({ id: 2, index: 1, openerTabId: 1 }),
      tab({ id: 3, index: 2 }),
    ],
    overrides: new Map([
      [2, 3],
      [3, null],
    ]),
    focusedWindowId: 1,
  });

  assert.equal(byId(manual, 2).parentId, 3);
  assert.equal(byId(manual, 3).parentId, null);
  assert.deepEqual(manual.windows[0].rootIds, [1, 3]);
});

test('an invalid override falls back to the opener heuristic', () => {
  const snapshot = buildSnapshot({
    tabs: [
      tab({ id: 1, index: 0 }),
      tab({ id: 2, index: 1, openerTabId: 1 }),
    ],
    overrides: new Map([[2, 999]]),
    focusedWindowId: 1,
  });

  assert.equal(byId(snapshot, 2).parentId, 1);
});

test('a persisted creation edge survives Chrome clearing openerTabId', () => {
  // Chrome wipes openerTabId when a second foreground tab opens, but the edge
  // captured at creation time still says "B was opened from A".
  const snapshot = buildSnapshot({
    tabs: [
      tab({ id: 1, index: 0, title: 'A' }),
      tab({ id: 2, index: 1, title: 'B' }), // openerTabId already cleared
      tab({ id: 3, index: 2, title: 'C' }),
    ],
    edges: new Map([
      [2, 1],
      [3, 1],
    ]),
    focusedWindowId: 1,
  });

  assert.equal(byId(snapshot, 2).parentId, 1);
  assert.equal(byId(snapshot, 2).relation, 'edge');
  assert.equal(byId(snapshot, 3).parentId, 1);
  assert.equal(byId(snapshot, 1).childIds.length, 2);
});

test('manual override beats a creation edge', () => {
  const snapshot = buildSnapshot({
    tabs: [tab({ id: 1 }), tab({ id: 2, index: 1 }), tab({ id: 3, index: 2 })],
    overrides: new Map([[2, 3], [3, null]]),
    edges: new Map([[2, 1]]),
    focusedWindowId: 1,
  });

  assert.equal(byId(snapshot, 2).parentId, 3);
  assert.equal(byId(snapshot, 2).relation, 'manual');
});

test('a creation edge to a closed/foreign tab is ignored', () => {
  const crossWindow = buildSnapshot({
    tabs: [
      tab({ id: 1, windowId: 1, index: 0 }),
      tab({ id: 2, windowId: 2, index: 0 }),
    ],
    edges: new Map([[2, 1]]),
    focusedWindowId: 1,
  });
  assert.equal(byId(crossWindow, 2).parentId, null);

  const deadParent = buildSnapshot({
    tabs: [tab({ id: 2, index: 0 })],
    edges: new Map([[2, 999]]),
    focusedWindowId: 1,
  });
  assert.equal(byId(deadParent, 2).parentId, null);
});

test('pruneEdges drops dead, foreign-window and self edges', () => {
  const edges = new Map([
    [2, 1],
    [3, 999],
    [4, 4],
    [5, 6],
  ]);
  const tabs = [
    tab({ id: 1, windowId: 1 }),
    tab({ id: 2, windowId: 1 }),
    tab({ id: 3, windowId: 1 }),
    tab({ id: 4, windowId: 1 }),
    tab({ id: 5, windowId: 1 }),
    tab({ id: 6, windowId: 2 }),
  ];
  pruneEdges(edges, tabs);
  assert.deepEqual([...edges.entries()], [[2, 1]]);
});

test('closing a parent promotes its children one level', () => {
  const snapshot = buildSnapshot({
    tabs: [
      tab({ id: 1, index: 0 }),
      tab({ id: 2, index: 1, openerTabId: 1 }),
      tab({ id: 3, index: 2, openerTabId: 2 }),
      tab({ id: 4, index: 3, openerTabId: 2 }),
    ],
    focusedWindowId: 1,
  });
  const plan = planOrphanPromotion(snapshot.nodes, 2);
  assert.equal(plan.grandparentId, 1);
  assert.deepEqual(plan.children, [3, 4]);

  // Simulate the worker applying the plan: children keep depth 1 under A.
  const edges = new Map();
  for (const childId of plan.children) edges.set(childId, plan.grandparentId);
  const next = buildSnapshot({
    tabs: [
      tab({ id: 1, index: 0 }),
      tab({ id: 3, index: 1, openerTabId: 2 }),
      tab({ id: 4, index: 2, openerTabId: 2 }),
    ],
    edges,
    focusedWindowId: 1,
  });
  assert.equal(byId(next, 3).parentId, 1);
  assert.equal(byId(next, 4).parentId, 1);
  assert.equal(byId(next, 3).depth, 1);
  assert.equal(byId(next, 4).depth, 1);
});

test('cyclic overrides are broken without losing tabs', () => {
  const snapshot = buildSnapshot({
    tabs: [
      tab({ id: 1, index: 0 }),
      tab({ id: 2, index: 1 }),
    ],
    overrides: new Map([
      [1, 2],
      [2, 1],
    ]),
    focusedWindowId: 1,
  });

  assert.equal(snapshot.nodes.length, 2);
  const roots = snapshot.windows[0].rootIds;
  assert.ok(roots.length >= 1);
  assert.equal(byId(snapshot, 1).depth, 0);
});

test('siblings and roots follow native tab index order', () => {
  const snapshot = buildSnapshot({
    tabs: [
      tab({ id: 10, index: 4 }),
      tab({ id: 11, index: 0 }),
      tab({ id: 12, index: 3, openerTabId: 11 }),
      tab({ id: 13, index: 1, openerTabId: 11 }),
      tab({ id: 14, index: 2, openerTabId: 11 }),
    ],
    focusedWindowId: 1,
  });

  assert.deepEqual(snapshot.windows[0].rootIds, [11, 10]);
  assert.deepEqual(byId(snapshot, 11).childIds, [13, 14, 12]);
  assert.deepEqual(
    snapshot.nodes.map((node) => node.tabId),
    [11, 13, 14, 12, 10],
  );
});

test('descendant counts are computed for every subtree', () => {
  const snapshot = buildSnapshot({
    tabs: [
      tab({ id: 1, index: 0 }),
      tab({ id: 2, index: 1, openerTabId: 1 }),
      tab({ id: 3, index: 2, openerTabId: 2 }),
      tab({ id: 4, index: 3, openerTabId: 1 }),
    ],
    focusedWindowId: 1,
  });

  assert.equal(byId(snapshot, 1).descendantCount, 3);
  assert.equal(byId(snapshot, 2).descendantCount, 1);
  assert.equal(byId(snapshot, 4).descendantCount, 0);
});

/* -------------------------------------------------------------------------- */
/* Collapse + visibility + search                                            */
/* -------------------------------------------------------------------------- */

test('collapsed parents hide children from the visible rows', () => {
  const snapshot = buildSnapshot({
    tabs: [
      tab({ id: 1, index: 0 }),
      tab({ id: 2, index: 1, openerTabId: 1 }),
      tab({ id: 3, index: 2, openerTabId: 2 }),
      tab({ id: 4, index: 3 }),
    ],
    collapsed: new Set([1]),
    focusedWindowId: 1,
  });

  assert.equal(byId(snapshot, 1).collapsed, true);
  const visible = getVisibleNodes(snapshot, 1);
  assert.deepEqual(visible.map((node) => node.tabId), [1, 4]);
});

test('search keeps ancestors of deep matches visible despite collapse', () => {
  const snapshot = buildSnapshot({
    tabs: [
      tab({ id: 1, index: 0, title: 'Docs home' }),
      tab({ id: 2, index: 1, openerTabId: 1, title: 'API reference' }),
      tab({ id: 3, index: 2, openerTabId: 2, title: 'sidePanel options' }),
      tab({ id: 4, index: 3, title: 'Unrelated' }),
    ],
    collapsed: new Set([1, 2]),
    focusedWindowId: 1,
  });

  const visible = getVisibleNodes(snapshot, 1, { query: 'sidepanel' });
  assert.deepEqual(visible.map((node) => node.tabId), [1, 2, 3]);
  assert.deepEqual(visible.map((node) => node.depth), [0, 1, 2]);
});

test('empty search query returns all expanded rows', () => {
  const snapshot = buildSnapshot({
    tabs: [
      tab({ id: 1, index: 0 }),
      tab({ id: 2, index: 1, openerTabId: 1 }),
    ],
    focusedWindowId: 1,
  });
  assert.equal(getVisibleNodes(snapshot, 1).length, 2);
  assert.equal(getVisibleNodes(snapshot, 1, { query: 'zzz' }).length, 0);
});

test('getDescendantIds returns the whole subtree only', () => {
  const snapshot = buildSnapshot({
    tabs: [
      tab({ id: 1, index: 0 }),
      tab({ id: 2, index: 1, openerTabId: 1 }),
      tab({ id: 3, index: 2, openerTabId: 2 }),
      tab({ id: 4, index: 3 }),
    ],
    focusedWindowId: 1,
  });
  assert.deepEqual(getDescendantIds(snapshot.nodes, 1).sort(), [2, 3]);
  assert.deepEqual(getDescendantIds(snapshot.nodes, 3), []);
});

/* -------------------------------------------------------------------------- */
/* Reparent validation                                                        */
/* -------------------------------------------------------------------------- */

test('canReparent rejects self, descendants and cross-window parents', () => {
  const snapshot = buildSnapshot({
    tabs: [
      tab({ id: 1, index: 0 }),
      tab({ id: 2, index: 1, openerTabId: 1 }),
      tab({ id: 3, index: 2, openerTabId: 2 }),
      tab({ id: 4, windowId: 2, index: 0 }),
    ],
    focusedWindowId: 1,
  });
  const nodes = snapshot.nodes;

  assert.equal(canReparent(nodes, 3, 1).ok, true);
  assert.equal(canReparent(nodes, 1, 2).ok, false);
  assert.equal(canReparent(nodes, 1, 2).reason, 'cycle');
  assert.equal(canReparent(nodes, 2, 2).ok, false);
  assert.equal(canReparent(nodes, 1, 4).ok, false);
  assert.equal(canReparent(nodes, 1, 4).reason, 'cross-window');
  assert.equal(canReparent(nodes, 3, null).ok, true);
});

/* -------------------------------------------------------------------------- */
/* Native ordering                                                             */
/* -------------------------------------------------------------------------- */

test('native order keeps pinned tabs first then DFS order', () => {
  const snapshot = buildSnapshot({
    tabs: [
      tab({ id: 1, index: 0, pinned: true }),
      tab({ id: 2, index: 1, openerTabId: 1 }),
      tab({ id: 3, index: 2 }),
      tab({ id: 4, index: 3, openerTabId: 3 }),
    ],
    focusedWindowId: 1,
  });

  const { pinned, unpinned } = computeNativeOrder(snapshot, 1);
  assert.deepEqual(pinned, [1]);
  assert.deepEqual(unpinned, [2, 3, 4]);
});

/* -------------------------------------------------------------------------- */
/* Session restore                                                             */
/* -------------------------------------------------------------------------- */

function savedSnapshot() {
  const snapshot = buildSnapshot({
    tabs: [
      tab({ id: 1, index: 0, title: 'A', url: 'https://a.test/' }),
      tab({ id: 2, index: 1, openerTabId: 1, title: 'B', url: 'https://b.test/' }),
      tab({ id: 3, index: 2, openerTabId: 2, title: 'C', url: 'https://c.test/' }),
      tab({ id: 4, index: 3, title: 'D', url: 'https://d.test/' }),
    ],
    focusedWindowId: 1,
    now: 1000,
  });
  return serializeRestoreSnapshot(snapshot);
}

test('restore matches tabs by URL and rebuilds parent links after restart', () => {
  const saved = savedSnapshot();
  const live = [
    tab({ id: 101, index: 0, url: 'https://a.test/' }),
    tab({ id: 102, index: 1, url: 'https://b.test/' }),
    tab({ id: 103, index: 2, url: 'https://c.test/' }),
    tab({ id: 104, index: 3, url: 'https://d.test/' }),
  ];

  const result = matchRestoreSnapshot(saved, live, { now: 1000 + 60_000, restart: true });
  assert.equal(result.applicable, true);
  assert.equal(result.stats.matchedTabs, 4);
  assert.equal(result.stats.relations, 2);
  assert.equal(result.overrides.get(102), 101);
  assert.equal(result.overrides.get(103), 102);

  const snapshot = buildSnapshot({
    tabs: live,
    overrides: result.overrides,
    inferred: result.inferred,
    focusedWindowId: 1,
  });
  assert.equal(byId(snapshot, 103).parentId, 102);
  assert.equal(byId(snapshot, 103).depth, 2);
  assert.equal(byId(snapshot, 103).inferred, true);
  assert.equal(byId(snapshot, 104).parentId, null);
});

test('restore only runs for a marked browser restart, not a fresh snapshot', () => {
  const saved = savedSnapshot();
  const live = [
    tab({ id: 101, index: 0, url: 'https://a.test/' }),
    tab({ id: 102, index: 1, url: 'https://b.test/' }),
  ];
  // Same-session worker wake: the snapshot is a few seconds old -> never apply.
  assert.equal(matchRestoreSnapshot(saved, live, { now: 5000 }).applicable, false);
  // Browser restart: the session marker is gone, so the snapshot applies even
  // when some tab still carries a live openerTabId.
  const withOpener = [
    tab({ id: 101, index: 0, url: 'https://a.test/' }),
    tab({ id: 102, index: 1, url: 'https://b.test/', openerTabId: 101 }),
  ];
  assert.equal(
    matchRestoreSnapshot(saved, withOpener, { now: 1000 + 60_000, restart: true }).applicable,
    true,
  );
});

test('restore survives a tab closed while Chrome was off', () => {
  const saved = savedSnapshot();
  const live = [
    tab({ id: 101, index: 0, url: 'https://a.test/' }),
    tab({ id: 103, index: 1, url: 'https://c.test/' }),
    tab({ id: 104, index: 2, url: 'https://d.test/' }),
  ];
  const result = matchRestoreSnapshot(saved, live, { now: 1000 + 60_000, restart: true });

  assert.equal(result.stats.matchedTabs, 3);
  assert.equal(result.overrides.get(103), null);
  const snapshot = buildSnapshot({
    tabs: live,
    overrides: result.overrides,
    inferred: result.inferred,
    focusedWindowId: 1,
  });
  assert.equal(byId(snapshot, 103).parentId, null);
});

test('restore pairs windows by URL overlap', () => {
  const saved = buildSnapshot({
    tabs: [
      tab({ id: 1, windowId: 1, index: 0, url: 'https://a.test/' }),
      tab({ id: 2, windowId: 1, index: 1, url: 'https://b.test/', openerTabId: 1 }),
      tab({ id: 3, windowId: 2, index: 0, url: 'https://c.test/' }),
      tab({ id: 4, windowId: 2, index: 1, url: 'https://d.test/', openerTabId: 3 }),
    ],
    focusedWindowId: 2,
    now: 1000,
  });
  const live = [
    tab({ id: 30, windowId: 7, index: 0, url: 'https://c.test/' }),
    tab({ id: 31, windowId: 7, index: 1, url: 'https://d.test/' }),
    tab({ id: 10, windowId: 5, index: 0, url: 'https://a.test/' }),
    tab({ id: 11, windowId: 5, index: 1, url: 'https://b.test/' }),
  ];

  const result = matchRestoreSnapshot(serializeRestoreSnapshot(saved), live, {
    now: 1000 + 60_000,
    restart: true,
  });
  assert.equal(result.stats.relations, 2);
  assert.equal(result.overrides.get(11), 10);
  assert.equal(result.overrides.get(31), 30);
  assert.equal(result.stats.windows, 2);
});

test('duplicate URLs map in order', () => {
  const saved = buildSnapshot({
    tabs: [
      tab({ id: 1, index: 0, url: 'https://dup.test/' }),
      tab({ id: 2, index: 1, openerTabId: 1, url: 'https://dup.test/' }),
      tab({ id: 3, index: 2, openerTabId: 2, url: 'https://dup.test/' }),
    ],
    focusedWindowId: 1,
    now: 1000,
  });
  const live = [
    tab({ id: 11, index: 0, url: 'https://dup.test/' }),
    tab({ id: 12, index: 1, url: 'https://dup.test/' }),
    tab({ id: 13, index: 2, url: 'https://dup.test/' }),
  ];
  const result = matchRestoreSnapshot(serializeRestoreSnapshot(saved), live, {
    now: 62_000,
    restart: true,
  });
  assert.equal(result.overrides.get(12), 11);
  assert.equal(result.overrides.get(13), 12);
});

test('serializeRestoreSnapshot keeps only compact fields', () => {
  const saved = savedSnapshot();
  assert.equal(saved.version, 1);
  assert.equal(saved.nodes.length, 4);
  for (const node of saved.nodes) {
    assert.deepEqual(Object.keys(node).sort(), [
      'index',
      'parentId',
      'pinned',
      'tabId',
      'title',
      'url',
      'windowId',
    ]);
  }
});

test('pruneOverrides drops closed tabs and dead parents', () => {
  const overrides = new Map([
    [1, null],
    [2, 1],
    [3, 99],
    [99, 1],
  ]);
  pruneOverrides(overrides, new Set([1, 2, 3]));
  // Stale entries are dropped entirely; the engine then falls back to the
  // opener heuristic (or root) on the next build.
  assert.deepEqual([...overrides.entries()], [
    [1, null],
    [2, 1],
  ]);
});

/* -------------------------------------------------------------------------- */
/* Misc / utils                                                                */
/* -------------------------------------------------------------------------- */

test('lcsPairs aligns order-preserving matches', () => {
  assert.deepEqual(lcsPairs(['a', 'b', 'c'], ['a', 'c']), [
    [0, 0],
    [2, 1],
  ]);
  const crossed = lcsPairs(['a', 'b'], ['b', 'a']);
  assert.equal(crossed.length, 1);
  assert.ok(
    crossed[0][0] === 1 || crossed[0][1] === 1,
    'a single order-preserving match is expected',
  );
});

test('hashString is stable and revision changes with structure', () => {
  assert.equal(hashString('tab-tree'), hashString('tab-tree'));
  assert.notEqual(hashString('tab-tree'), hashString('tab-treE'));

  const base = buildSnapshot({
    tabs: [
      tab({ id: 1, index: 0 }),
      tab({ id: 2, index: 1, openerTabId: 1 }),
    ],
    focusedWindowId: 1,
  });
  const collapsed = buildSnapshot({
    tabs: [
      tab({ id: 1, index: 0 }),
      tab({ id: 2, index: 1, openerTabId: 1 }),
    ],
    collapsed: new Set([1]),
    focusedWindowId: 1,
  });
  assert.notEqual(base.revision, collapsed.revision);
});

test('revision changes when equal-length content changes', () => {
  const before = buildSnapshot({
    tabs: [
      tab({ id: 1, index: 0, title: 'AAAA', url: 'https://a.test/one' }),
    ],
    focusedWindowId: 1,
  });
  const afterTitle = buildSnapshot({
    tabs: [
      tab({ id: 1, index: 0, title: 'BBBB', url: 'https://a.test/one' }),
    ],
    focusedWindowId: 1,
  });
  const afterUrl = buildSnapshot({
    tabs: [
      tab({ id: 1, index: 0, title: 'AAAA', url: 'https://a.test/two' }),
    ],
    focusedWindowId: 1,
  });
  const afterFlag = buildSnapshot({
    tabs: [
      tab({ id: 1, index: 0, title: 'AAAA', url: 'https://a.test/one', audible: true }),
    ],
    focusedWindowId: 1,
  });
  assert.notEqual(before.revision, afterTitle.revision);
  assert.notEqual(before.revision, afterUrl.revision);
  assert.notEqual(before.revision, afterFlag.revision);
});

test('normalizeUrl drops fragments and tolerates empty input', () => {
  assert.equal(normalizeUrl('https://a.test/x#frag'), 'https://a.test/x');
  assert.equal(normalizeUrl(''), '');
  assert.equal(normalizeUrl(undefined), '');
});

test('empty input yields an empty snapshot, not a crash', () => {
  const snapshot = buildSnapshot({ tabs: [], focusedWindowId: null });
  assert.deepEqual(snapshot.nodes, []);
  assert.deepEqual(snapshot.windows, []);
  assert.equal(snapshot.activeTabId, null);
  assert.deepEqual(snapshot.prefs, DEFAULT_PREFS);
});

test('depth is capped defensively for absurd chains', () => {
  const tabs = [tab({ id: 0, index: 0 })];
  for (let i = 1; i <= MAX_DEPTH + 5; i += 1) {
    tabs.push(tab({ id: i, index: i, openerTabId: i - 1 }));
  }
  const snapshot = buildSnapshot({ tabs, focusedWindowId: 1 });
  assert.equal(snapshot.nodes.length, tabs.length);
  assert.ok(Math.max(...snapshot.nodes.map((node) => node.depth)) <= MAX_DEPTH);
});

test('prefs are merged with defaults into the snapshot', () => {
  const snapshot = buildSnapshot({
    tabs: [tab({ id: 1 })],
    prefs: { closeChildrenWithParent: true },
    focusedWindowId: 1,
  });
  assert.equal(snapshot.prefs.closeChildrenWithParent, true);
  assert.equal(snapshot.prefs.autoSortNative, DEFAULT_PREFS.autoSortNative);
});

test('snapshot exposes link stats used by the onboarding hint', () => {
  const tabs = [
    tab({ id: 1, index: 0 }),
    tab({ id: 2, index: 1, openerTabId: 1 }),
    tab({ id: 3, index: 2, openerTabId: 4 }),
    tab({ id: 4, index: 3 }),
  ];
  const snapshot = buildSnapshot({
    tabs,
    edges: new Map([[2, 1]]),
    overrides: new Map([[3, 4]]),
    inferred: new Set(),
  });
  assert.deepEqual(snapshot.linkStats, {
    captured: 1,
    manual: 1,
    restored: 0,
    parented: 2,
    roots: 2,
  });

  const restored = buildSnapshot({
    tabs,
    overrides: new Map([[2, 1]]),
    inferred: new Set([2]),
  });
  assert.equal(restored.linkStats.restored, 1);
  assert.equal(restored.linkStats.manual, 0);
  assert.equal(restored.nodes.find((node) => node.tabId === 2).relation, 'restore');
});
