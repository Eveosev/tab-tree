# Verification report — Tab Tree 0.1.3

Date: 2026-11-03
Environment: macOS (arm64), Node.js 24.21.0, npm 11.19.0, Chrome for Testing
156.0.8078.4 (Playwright cache), headless CDP automation.

This report supersedes the 0.1.2 report. 0.1.3 is a **restore-state correctness**
release: a plain MV3 worker wake no longer replays the browser-restart snapshot,
and the restored (`inferred`) flags now survive that wake. No UI or permission
changes.

## What changed in 0.1.3

Two defects were reported by an independent review and reproduced before the
fix:

1. **`sessionMarker` was never read.** `loadState()` asked
   `chrome.storage.session` for `overrides/edges/collapsed` only, but `init()`
   read `sessionMarker` from the result. It was always `null`, so every worker
   wake looked like a browser restart and replayed the restore snapshot.
2. **`inferred` was never persisted.** `persistSession()` wrote only three
   collections. Fixing the marker alone would have made restore badges vanish
   after the next wake (and the footer would still claim links were restored).

The repair keeps both in one change:

- `extension/lib/session-state.js` is the single read/write codec for
  `overrides`, `edges`, `collapsed`, `inferred` and `sessionMarker`, with six
  `node:test` cases (including a real round-trip through a fake storage area).
- `init()` prunes inferred ids whose tab or override disappeared; `buildNow()`
  does the same on every rebuild, so a drag or close cannot leave a stale badge.
- A new browser session clears `storage.local.restoreStats`; only a real restore
  writes it again. A worker wake reuses the stored stats without re-running the
  matcher.
- Session writes are held until the asynchronous load/merge completes. Without
  that guard, a `tabs.onCreated` event fired during startup could overwrite the
  previous worker's edges with a nearly empty map.
- `scripts/check.mjs` now actually scans `extension/` for remote
  `<script src>`, `eval`, `new Function`, `fetch` and `XMLHttpRequest` instead of
  only printing that no remote code exists.

## Automated results

| Command | Result |
| --- | --- |
| `npm run check` | ✔ 21 files · manifest v0.1.3 (`tabs, sidePanel, storage, webNavigation`) · 37 EN / 37 ZH i18n keys · no `<all_urls>` · real remote-code scan |
| `npm test` | ✔ **41/41** unit tests (35 tree-engine + 6 session-state codec) |
| `npm run build` | ✔ `dist/tab-tree-v0.1.3.zip` — 18 files, 48.1 KiB, `sha256 ce936b59eb36b9b19e5dc68bf50f75504448ff68e50dee8ec8c8f92883b14623` |
| `npm run smoke` | ✔ **44/44** checks against a real Chrome for Testing instance |
| `npm run test:e2e` | ✔ **8/8** real-link acceptance checks (real mouse events) |
| `npm run test:panel` | ✔ **11/11** real pointer-drag + multi-window panel checks |
| `npm run test:restart` | ✔ **19/19** checks across two real Chrome processes and a post-restore worker wake |
| `npm run bench` (300 tabs) | ✔ **8/8** checks; rebuild p95 **14.4 ms**, scroll p95 **34.2 ms**, search **31.4 ms** |
| `TABS=500 npm run bench` | ✔ **8/8** checks; rebuild p95 **20.6 ms**, scroll p95 **34.3 ms**, search **32.5 ms** |
| `npm run verify:all` | ✔ exit 0 — check → 41/41 tests → build → smoke 44/44 → e2e 8/8 → panel 11/11 → restart 19/19 |
| CI | `.github/workflows/ci.yml` runs `check` + `test` + `build` on pushes/PRs (browser suites stay local because they need Chrome for Testing) |

## Red → green evidence for the wake defect

The new smoke checks were first run against the **unfixed 0.1.2
`background.js`** (same test code, old extension). The suite failed 8 checks,
exactly reproducing the review:

```text
✖ worker wake does not replay the restore snapshot — {"appliedAt":…,"stats":{"matchedTabs":6,"relations":2,…}}
✖ worker wake leaves no inferred/restore nodes behind — [{"url":"/article","relation":"restore","inferred":true}, …]
✖ worker wake preserves the captured creation edges — {"article":"restore","comments":"restore"}
✖ session marker is unchanged across the worker wake — 1793705829632 -> 1793705864859
✖ overrides and edges are identical across the worker wake — …
✖ worker wake does not write restore statistics
✖ panel shows no restored badges after a plain worker wake — 2 badge(s)
✖ panel shows no restored-links footer after a plain worker wake — "2 links restored"

36/44 checks passed
```

After the fix the same command is **44/44**. The test terminates the worker by
closing its extension pages and waiting for Chrome's real idle reclaim
(~30–40 s); the old target id must disappear, and the revived worker must have
a different target id. `Target.closeTarget` is deliberately not used: closing
an extension worker target unloads the extension and clears
`chrome.storage.session`, which would hide the very state under test.

## Real browser restart + post-restore wake (`npm run test:restart`)

Two real Chrome processes on the same profile, the second started with
`--restore-last-session`. A, B and C are opened by real link clicks in the first
session; the tree is A→B→C. After the restart Chrome reports no opener on any
of the three tabs, so the relations can only come from the persisted snapshot.
The worker is then idle-reclaimed and woken once more.

```
✔ tree is A > B > C before the restart
✔ captured creation edges (not live openers) built the tree
✔ snapshot with parent links is persisted in storage.local
✔ service worker boots after the restart
✔ Chrome restored the three tabs without opener relations
✔ A > B > C is rebuilt from the snapshot after restart
✔ restored relations carry the inferred badge and reason
✔ restore stats report the matched relations
✔ panel renders the restored grandchild two levels deep
✔ panel shows the restored-links summary
✔ restored rows carry two inferred badges before the worker wake
✔ session marker is present after the restart
✔ service worker target disappears after the post-restore termination
✔ service worker wakes with a different target id after the restore
✔ restored relations survive a plain worker wake
✔ the post-restore worker wake does not re-run the snapshot matcher
✔ panel keeps the restored grandchild two levels deep after the wake
✔ panel keeps the restored-links summary after the wake
✔ panel keeps two inferred badges after the wake

19/19 checks passed
```

The panel renders the grandchild at `depth=2` / `indent=32px`, shows
`2 links restored`, and both restored rows carry `relation = restore` /
`inferred = true` both before and after the wake. `appliedAt` is unchanged,
proving the matcher did not run again.

## Smoke coverage (`npm run smoke`, 44/44)

- loads the unpacked extension and finds the Tab Tree service worker;
- validates manifest, side-panel entry and the exact permission set;
- seeds a three-level tree through captured creation edges (no debug override);
- verifies a genuine link-opened tab is a depth-1 child;
- renders `sidepanel.html`, asserts row depth, `data-parent-id`, indentation;
- collapses/expands through the real twisty and checks worker state;
- closes a tab and confirms it leaves UI and worker;
- asserts a restore snapshot with parent links is persisted before termination;
- records marker, overrides, edges and inferred state, then closes the panel;
- idle-reclaims the worker, proves the old target id disappeared, wakes a new
  worker and proves the new target id differs;
- asserts no snapshot replay, no `restore` relations, no inferred badges, no
  “N links restored” footer, an unchanged marker, identical overrides/edges and
  no new restore statistics;
- captures `docs/screenshot-light.png` and `docs/screenshot-dark.png`;
- asserts zero runtime exceptions in panel and worker.

## Pointer drag + panel window binding (`npm run test:panel`, 11/11)

Driver: `Input.dispatchMouseEvent` (real browser pointer events) on the actual
side-panel document. It first drags an independent root F onto A, then drags F
onto the floating “make top-level” zone, then attempts an illegal cycle drag
(A onto its descendant B).

```
✔ panel renders seeded rows
✔ seeded child is indented one level
✔ independent tab starts as a root
✔ pointer drag nests F under A
✔ panel re-renders the dragged row one level deep
✔ drop on the top-level zone un-nests F
✔ cycle drag is rejected and the tree is unchanged
✔ cycle rejection surfaces a toast to the user
✔ second-window panel shows the second-window tree
✔ panel selects its host window in the window picker
✔ first-window panel stays bound to the first window after focus moves

11/11 checks passed
```

## Performance (`npm run bench`)

A wide forest (6 roots, all other tabs as children) is created with Chrome’s own
APIs, then measured after the tree is fully built. Rebuild timing wraps a full
`chrome.tabs.query` + engine rebuild + snapshot broadcast on the service worker;
scroll and search timings are measured in the panel document.

| Tabs | Snapshot | Rebuild p95 / max | Scroll p95 / max | Search | DOM rows |
| --- | --- | --- | --- | --- | --- |
| 300 | 301 nodes, 131.3 KiB JSON | 14.4 / 14.4 ms | 34.2 / 34.2 ms | 31.4 ms | < 80 |
| 500 | 501 nodes, 216.4 KiB JSON | 20.6 / 20.6 ms | 34.3 / 34.3 ms | 32.5 ms | < 80 |

The scroll/search figures are effectively two `requestAnimationFrame` ticks
(~33 ms at 60 Hz), i.e. one frame of work; the virtual list keeps fewer than 80
row elements in the DOM regardless of tab count. Ceilings enforced by the suite:
rebuild < 500 ms, scroll < 100 ms, search < 250 ms.

## Real-link acceptance (`npm run test:e2e`)

Unchanged from 0.1.1 and still green on 0.1.3:

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

## Acceptance criteria

| # | Criterion | Status | Evidence |
| --- | --- | --- | --- |
| AC1 | A link opened from **A** is a child of **A**, and stays a child after further foreground opens | ✅ | `test:e2e` checks 1, 3, 5 (real clicks); unit tests for edge priority |
| AC2 | Independently opened tab is a root sibling of A | ✅ | `test:e2e` check 6; smoke `/other`; unit tests |
| AC3 | Three levels render with 16 px indent | ✅ | `test:e2e` checks 2, 4; smoke panel assertions; screenshots |
| AC4 | Collapse hides the subtree and persists in the worker | ✅ | smoke twisty click + worker `collapsed` check |
| AC5 | Close from panel removes the tab; direct children are promoted one level | ✅ | `planOrphanPromotion` unit test; `test:e2e` closes B and asserts D becomes a depth-1 child of A; smoke close check |
| AC6 | Drag reparent applies an override and rejects cycles/cross-window | ✅ | `test:panel` real pointer drag (nest, un-nest, cycle toast); `canReparent` unit tests |
| AC7 | Worker termination keeps the live tree and does **not** fake a restore | ✅ | smoke 44/44: idle reclaim, new target id, no replay/inferred/footer, unchanged marker/edges/overrides; red on unfixed 0.1.2 |
| AC8 | Session restore after a real browser restart, and after a later worker wake | ✅ | `test:restart` 19/19 across two Chrome processes and a post-restore wake |
| AC9 | Multi-window forests; panel follows its host window | ✅ | `test:panel` window-picker/rows assertions; unit tests |
| AC10 | Hundreds of tabs stay responsive | ✅ | `bench`: 300/500 tabs, rebuild ≤20.6 ms p95, scroll/search ≈1 frame, DOM < 80 rows |
| AC11 | `tabs.onReplaced` keeps child/parent relations | ✅ | `migrateTabId` migrates edges/overrides/collapse/inferred; unit-level design |
| AC12 | Equal-length title/URL change still updates the panel | ✅ | unit test `revision changes when equal-length content changes` |
| AC13 | Restored flags survive a worker wake but disappear on drag/close | ✅ | session-state unit tests; smoke wake keeps edges; `inferred` pruned when override is replaced/removed |

## Known limits (not defects)

- **Side-panel side is owned by Chrome.** The user asked for a left sidebar, but
  the extension cannot force it; Chrome decides left/right in
  `chrome://settings/appearance` → side panel position. This is documented in
  the README and surfaced to users.
- **Restore is a heuristic.** Identical URLs and extreme reordering can still
  cross-pair; every restored row is badged and can be corrected with one drag.
  Chrome restores tabs asynchronously, hence the 15 s retry window.
- **Worker-kill tests need ~30–40 s.** Chrome's idle reclaim is the only
  termination path that preserves `storage.session`; the backstop is 75 s and a
  timeout fails the suite instead of skipping it.
- **Cross-window drag is rejected by design.** A panel shows one window at a
  time, so the UI cannot present a cross-window drop target; the engine still
  rejects it defensively.
- **Branded Chrome 137+ ignores `--load-extension`.** Automated suites use
  Chrome for Testing / Chromium via `CHROME_PATH`.
