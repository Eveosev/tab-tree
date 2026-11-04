# Independent acceptance report — Tab Tree

Date: 2026-11-03 · macOS arm64 · Node.js 24.21.0 · npm 11.19.0 ·
Chrome for Testing 156.0.8078.4 (headless CDP; headed CFT reproduced the same
0.1.0 defect earlier).

Scope: verify the user story “a tab opened from a link inside **A** is a child
of **A**, nested to any depth; a tab opened independently (address bar /
Ctrl+T / bookmark) is a sibling root”. This report records the **0.1.0
failure**, the root cause, the **0.1.1 fix**, the **0.1.2 reconcile
release**, and the **0.1.3 restore-state fix**. The 0.2.0 discoverability and
restore-hardening results live in [verification.md](verification.md); this file
remains the 0.1.x acceptance record.

## Verdict

**0.1.0 failed the core user story.** `chrome.tabs.Tab.openerTabId` is cleared
by Chromium whenever a new foreground link tab is inserted
(`ForgetAllOpeners()`), so after A→B, A→C the tree flattened to roots.
The shipped smoke suite was green because it manufactured the deep chain via
the extension’s reparent override.

**0.1.1 passes.** The relation is captured at creation time from
`chrome.webNavigation.onCreatedNavigationTarget` (plus `tabs.onCreated` and a
build-time live-opener probe), stored as `edges: Map<childTabId, parentTabId>`
in `chrome.storage.session`, and resolved ahead of `openerTabId`.

**0.1.2 passes with browser-level coverage.** A real two-process restart test
found and fixed a restore blocker: one incidental live opener suppressed the
snapshot, and `init()` could run before Chrome restored the tabs. Restore is now
retried from tab events for up to 15 s. Drag, multi-window panel binding and
300/500-tab performance are executable suites rather than manual claims.

**0.1.3 passes the worker-wake contract.** An independent review found that
`sessionMarker` was never requested from `chrome.storage.session` (so every
plain worker wake replayed the restore snapshot) and `inferred` was never
persisted (so fixing the marker alone would have dropped restore badges). Both
are fixed in one change; a unit-tested codec now reads/writes marker, edges,
overrides, collapse and inferred together, and the smoke/restart suites prove
that a real idle worker reclaim does not replay the snapshot.

## Commands and results (0.1.3 workspace)

| Command | Result |
| --- | --- |
| `npm run check` | ✔ 21 files, manifest v0.1.3 (`tabs, sidePanel, storage, webNavigation`), 37/37 i18n, no `<all_urls>`, real remote-code scan |
| `npm test` | ✔ **41/41** unit tests (35 engine + 6 session-state codec) |
| `npm run smoke` | ✔ **44/44** checks, including idle worker reclaim + wake regression |
| `npm run test:e2e` | ✔ **8/8** real mouse-link checks |
| `npm run test:panel` | ✔ **11/11** pointer drag + per-window panel checks |
| `npm run test:restart` | ✔ **19/19** across two real Chrome processes, including a post-restore worker wake |
| `npm run bench` | ✔ **8/8** at 300 tabs and 500 tabs |
| `npm run build` | ✔ `dist/tab-tree-v0.1.3.zip`, 18 files, 48.1 KiB, sha256 `ce936b59…4623` |

### `npm run test:e2e` result

```
✔ foreground link A -> B is a depth-1 child of A
✔ side panel renders B at depth 1 with a 16px indent
✔ two foreground link children both remain under A
✔ grandchild D is depth 2 under B under A
✔ background Cmd/Ctrl+click child E stays under A
✔ opener-less tab is a root sibling of A
✔ closing B promotes D to a depth-1 child of A
✔ panel still renders every real-link tab

8/8 checks passed
```

The two checks that failed in 0.1.0 now pass without a debug/override
shortcut:

- `two foreground link children both remain under A` — previously
  `B.parent=- C.parent=/a B.opener=null`.
- `grandchild D is depth 2 under B under A` — previously `D.depth=1`.

## Root cause (unchanged analysis)

From Chromium’s `chrome/browser/ui/tabs/tab_strip_model.cc`:

```cpp
// InsertTabAtImpl
if ((add_types & ADD_INHERIT_OPENER) && active_tab_model) {
  if (active) {
    // Forget any existing relationships, we don't want to make things too
    // confusing by having multiple openers active at the same time.
    ForgetAllOpeners();          // clears opener on *every* tab
  }
  tab->set_opener(active_tab_model);
}
```

and `TabNavigating` clears all openers again when the active tab is navigated
by anything other than a link. Sources:

- https://chromium.googlesource.com/chromium/src/+/main/chrome/browser/ui/tabs/tab_strip_model.cc
  (`ForgetAllOpeners` ~L3935, `InsertTabAtImpl` ~L4157, `TabNavigating` ~L1493)
- https://developer.chrome.com/docs/extensions/reference/api/tabs#property-Tab-openerTabId
  (“only present if the opener tab still exists”)

`openerTabId` is therefore a transient hint, not a durable relation.

## Implemented fix (0.1.1)

1. **Manifest:** permission `webNavigation` added (no host permission added;
   Chrome’s warning remains “Read your browsing history”).
2. **Edge capture** in `extension/background.js`:
   - `webNavigation.onCreatedNavigationTarget` → `captureEdge(child, source)`;
   - `tabs.onCreated` → capture `tab.openerTabId` synchronously;
   - every `buildNow()` → learn edges from live `openerTabId`s whose opener is
     alive (covers `chrome.tabs.create({openerTabId})` and paths where Chrome
     sets the opener after `onCreated`).
   - `captureEdge` writes `storage.session` immediately, so a worker death
     right after a click cannot lose the relation.
3. **Engine precedence** in `extension/lib/tree-engine.js`:
   override → captured edge → live `openerTabId` → root. `pruneEdges()` drops
   dead/foreign-window/self edges; cycle guard unchanged.
4. **Lifecycle:** `tabs.onRemoved` promotes direct children one level
   (`planOrphanPromotion`); subtree close marks ids so promotion is skipped;
   `tabs.onReplaced` migrates edges/overrides/collapse/inferred in both
   directions; `init()` uses a `storage.session` marker + `runtime.onStartup`
   instead of the broken “no live opener” restart heuristic.
5. **Revision hash** now covers title/URL/favicon content and
   pinned/audible/muted/discarded flags, so equal-length title changes repaint.
6. **Debug hook** is only installed when the manifest has no `update_url`
   (i.e. unpacked/dev builds), not in a packaged store install.
7. **Panel window** follows the side panel’s host window via
   `chrome.windows.getCurrent()` before falling back to the focused window.

## Why the old smoke suite missed it

`scripts/smoke.mjs` seeded `/docs`, `/article`, `/comments` with
`chrome.tabs.create({ openerTabId })` and then built the deep chain through
`__TAB_TREE_DEBUG__.setParent(...)`. Only `/other` → `/other-child` used a
genuine click, and that is the most recently opened tab — the one case where
the opener survives. The suite has been changed: it no longer calls
`setParent` for the chain and asserts that captured edges build the three
levels. The new `test:e2e` is the acceptance gate for the foreground-click
regression.

## Residual findings / gaps after 0.1.3

1. Real browser-restart restore is now automated (`scripts/e2e-restart.mjs`,
   19/19): snapshot persisted, session storage wiped, A→B→C rebuilt with
   inferred badges, and a later worker wake keeps them without replaying the
   matcher.
2. Drag reparent is now automated with real pointer events
   (`scripts/e2e-panel.mjs`, 11/11): nest, un-nest and cycle rejection.
3. Performance is measured (`scripts/bench-tabs.mjs`): at 500 tabs a full
   rebuild is 20.6 ms p95, scroll/search ≈ one frame, DOM < 80 rows.
4. The extension remains a sidebar, not a native tab-strip replacement; Chrome
   controls whether the side panel is on the left or right
   (`chrome://settings/appearance`). This is a platform limit, not a bug.
5. `webNavigation` is required for AC1. Without it, only the latest/background
   opener survives and A→B, A→C regresses.
6. Restore remains heuristic for duplicate URLs and extreme reordering; the
   retry loop makes it non-blocking, not omniscient.
7. The worker-termination tests use Chrome’s real idle reclaim (~30–40 s)
   rather than `Target.closeTarget`, because closing the target unloads the
   extension and clears `storage.session`, which would hide the state under
   test.

## Artifacts

- `scripts/e2e-real-links.mjs` — dependency-free CDP E2E with real mouse
  clicks (`npm run test:e2e`).
- `test/tree-engine.test.js` — 35 cases including creation-edge precedence,
  edge pruning, one-level promotion, restart-marker restore, content revision.
- `test/session-state.test.js` — 6 cases proving marker + inferred are part of
  the read/write contract.
- `docs/verification.md` — 0.1.3 results and acceptance table.
