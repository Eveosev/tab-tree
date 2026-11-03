import test from 'node:test';
import assert from 'node:assert/strict';

import {
  SESSION_KEYS,
  decodeSessionState,
  encodeSessionState,
  readSessionState,
  writeSessionState,
} from '../extension/lib/session-state.js';

/** Minimal fake of `chrome.storage.session` that only returns requested keys. */
function fakeStorage(initial = {}) {
  const data = { ...initial };
  const requested = [];
  return {
    data,
    requested,
    async get(keys) {
      requested.push(...keys);
      return Object.fromEntries(keys.map((key) => [key, data[key]]));
    },
    async set(patch) {
      Object.assign(data, structuredClone(patch));
    },
  };
}

test('session keys include everything the worker must survive a wake', () => {
  // Regression guard for the 0.1.2 defect: `sessionMarker` was read from an
  // object that never requested it, so every plain worker wake looked like a
  // browser restart and replayed the restore snapshot.
  assert.deepEqual([...SESSION_KEYS].sort(), ['collapsed', 'edges', 'inferred', 'overrides', 'sessionMarker']);
});

test('session state round-trips through storage including the marker', async () => {
  const storage = fakeStorage();
  const state = {
    overrides: new Map([
      [10, null],
      [11, 10],
    ]),
    edges: new Map([[11, 10]]),
    collapsed: new Set([10]),
    inferred: new Set([11]),
  };

  await writeSessionState(storage, state);
  storage.data.sessionMarker = 1793000000000;

  const decoded = await readSessionState(storage);
  assert.deepEqual([...decoded.overrides], [
    [10, null],
    [11, 10],
  ]);
  assert.deepEqual([...decoded.edges], [[11, 10]]);
  assert.deepEqual([...decoded.collapsed], [10]);
  assert.deepEqual([...decoded.inferred], [11]);
  assert.equal(decoded.sessionMarker, 1793000000000);
  assert.deepEqual(storage.requested, [...SESSION_KEYS]);
});

test('a missing marker decodes as null (new browser session)', () => {
  assert.equal(decodeSessionState({}).sessionMarker, null);
  assert.equal(decodeSessionState({ sessionMarker: 'yesterday' }).sessionMarker, null);
});

test('malformed session entries are ignored instead of poisoning the tree', () => {
  const decoded = decodeSessionState({
    overrides: [null, [], ['x', 1], [1, '2'], [3, null]],
    edges: [[4], ['5', 6], [7, 8]],
    collapsed: [1, 'two', 3],
    inferred: [2, null, 4],
    sessionMarker: 12,
  });

  assert.deepEqual([...decoded.overrides], [
    [1, 2],
    [3, null],
  ]);
  assert.deepEqual([...decoded.edges], [[7, 8]]);
  assert.deepEqual([...decoded.collapsed], [1, 3]);
  assert.deepEqual([...decoded.inferred], [2, 4]);
  assert.equal(decoded.sessionMarker, 12);
});

test('encoding copies collections instead of leaking mutable references', () => {
  const overrides = new Map([[1, null]]);
  const encoded = encodeSessionState({ overrides });
  overrides.set(2, 1);

  assert.deepEqual(encoded.overrides, [[1, null]]);
});

test('readSessionState requests exactly the declared key list', async () => {
  const storage = fakeStorage({ sessionMarker: 7, inferred: [1] });
  const decoded = await readSessionState(storage);
  assert.deepEqual(storage.requested, [...SESSION_KEYS]);
  assert.deepEqual([...decoded.inferred], [1]);
});
