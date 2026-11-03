# Verification report — Tab Tree 0.1.2

Date: 2026-11-03
Environment: macOS (arm64), Node.js 24.21.0, npm 11.19.0, Chrome for Testing
156.0.8078.4 (Playwright cache), headless CDP automation.

This report supersedes the 0.1.1 report. 0.1.2 is a **restore-durability +
verification** release: the extension now survives a real browser restart (not
just a unit-tested heuristic), and the previously manual-only criteria (drag,
multi-window panel binding, hundreds of tabs) are covered by executable suites.

## What changed in 0.1.2

The real restart E2E exposed two defects that unit tests could not see:

1. **A single incidental opener blocked the entire restore.** `init()` skipped
   the snapshot whenever *any* live tab had an `openerTabId`. Chrome can restore
   an extra `about:blank` tab with an opener, which suppressed the restore for
   A→B→C. The guard was removed; the session marker is the authoritative
   restart signal.
2. **Restore could race Chrome's asynchronous tab restoration.** The service
   worker may start before the session's tabs exist, so a one-shot match at
   `init()` saw an empty window. Restore now retries from tab events for up to
   15 s, applies the best partial match immediately, and replaces it when a
   better URL/LCS alignment arrives.

No UI or permission changes; `manifest.json` permissions remain `tabs,
sidePanel, storage, webNavigation`.

## Automated results

| Command | Result |
| --- | --- |
| `npm run check` | ✔ 19 files · manifest v0.1.2 (`tabs, sidePanel, storage, webNavigation`) · 37 EN / 37 ZH i18n keys · no `<all_urls>`, no remote scripts |
| `npm test` | ✔ **35/35** engine tests (`node:test`, zero dependencies) |
| `npm run build` | ✔ `dist/tab-tree-v0.1.2.zip` — 17 files, 46.7 KiB, `sha256 90588de9493fec0de474e36d09a190fcbd1015297e123104e273dbf5627aa459` |
| `npm run smoke` | ✔ **29/29** checks against a real Chrome for Testing instance |
| `npm run test:e2e` | ✔ **8/8** real-link acceptance checks (real mouse events) |
| `npm run test:panel` | ✔ **11/11** real pointer-drag + multi-window panel checks |
| `npm run test:restart` | ✔ **10/10** checks across two real Chrome processes |
| `npm run bench` (300 tabs) | ✔ **8/8** checks; rebuild p95 **8.5 ms**, scroll p95 **34.0 ms**, search **27.0 ms** |
| `TABS=500 npm run bench` | ✔ **8/8** checks; rebuild p95 **19.9 ms**, scroll p95 **34.4 ms**, search **32.7 ms** |
| CI | `.github/workflows/ci.yml` runs `check` + `test` + `build` on pushes/PRs (browser suites stay local because they need Chrome for Testing) |

## Real browser restart (`npm run test:restart`)

Two real Chrome processes on the same profile, the second started with
`--restore-last-session`. A, B and C are opened by real link clicks in the first
session; the tree is A→B→C. After the restart Chrome reports no opener on any
of the three tabs, so the relations can only come from the persisted snapshot.

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

10/10 checks passed
```

The panel renders the grandchild at `depth=2` / `indent=32px` and shows
`2 links restored`; both restored rows carry `relation = restore` and
`inferred = true`.

## Pointer drag + panel window binding (`npm run test:panel`)

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

The second window’s panel shows only its own tabs and preselects that window even
though the first window was focused previously.

## Performance (`npm run bench`)

A wide forest (6 roots, all other tabs as children) is created with Chrome’s own
APIs, then measured after the tree is fully built. Rebuild timing wraps a full
`chrome.tabs.query` + engine rebuild + snapshot broadcast on the service worker;
scroll and search timings are measured in the panel document.

| Tabs | Snapshot | Rebuild p95 / max | Scroll p95 / max | Search | DOM rows |
| --- | --- | --- | --- | --- | --- |
| 300 | 301 nodes, 129.9 KiB JSON | 8.5 / 8.5 ms | 34.0 / 34.0 ms | 27.0 ms | < 80 |
| 500 | 501 nodes, 214.0 KiB JSON | 19.9 / 19.9 ms | 34.4 / 34.4 ms | 32.7 ms | < 80 |

The scroll/search figures are effectively two `requestAnimationFrame` ticks
(~33 ms at 60 Hz), i.e. one frame of work; the virtual list keeps fewer than 80
row elements in the DOM regardless of tab count. Ceilings enforced by the suite:
rebuild < 500 ms, scroll < 100 ms, search < 250 ms.

## Real-link acceptance (`npm run test:e2e`)

Unchanged from 0.1.1 and still green on 0.1.2:

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

## Smoke coverage (`npm run smoke`, 29/29)

- loads the unpacked extension and finds the Tab Tree service worker;
- validates manifest, side-panel entry and the exact permission set;
- seeds a three-level tree through captured creation edges (no debug override);
- verifies a genuine link-opened tab is a depth-1 child;
- renders `sidepanel.html`, asserts row depth, `data-parent-id`, indentation;
- collapses/expands through the real twisty and checks worker state;
- closes a tab and confirms it leaves UI and worker;
- terminates the service worker via CDP, confirms the panel reconnects, wakes a
  new worker and repaints the tree;
- captures `docs/screenshot-light.png` and `docs/screenshot-dark.png`;
- asserts zero runtime exceptions in panel and worker.

## Acceptance criteria

| # | Criterion | Status | Evidence |
| --- | --- | --- | --- |
| AC1 | A link opened from **A** is a child of **A**, and stays a child after further foreground opens | ✅ | `test:e2e` checks 1, 3, 5 (real clicks); unit tests for edge priority |
| AC2 | Independently opened tab is a root sibling of A | ✅ | `test:e2e` check 6; smoke `/other`; unit tests |
| AC3 | Three levels render with 16 px indent | ✅ | `test:e2e` checks 2, 4; smoke panel assertions; screenshots |
| AC4 | Collapse hides the subtree and persists in the worker | ✅ | smoke twisty click + worker `collapsed` check |
| AC5 | Close from panel removes the tab; direct children are promoted one level | ✅ | `planOrphanPromotion` unit test; `test:e2e` closes B and asserts D becomes a depth-1 child of A; smoke close check |
| AC6 | Drag reparent applies an override and rejects cycles/cross-window | ✅ | `test:panel` real pointer drag (nest, un-nest, cycle toast); `canReparent` unit tests |
| AC7 | Service-worker termination recovers with the tree intact | ✅ | smoke kills the worker; panel reconnects and repaints; edges persist in `storage.session` |
| AC8 | Session restore after a real browser restart | ✅ | `test:restart` 10/10 across two Chrome processes; A→B→C restored with badges |
| AC9 | Multi-window forests; panel follows its host window | ✅ | `test:panel` window-picker/rows assertions; unit tests |
| AC10 | Hundreds of tabs stay responsive | ✅ | `bench`: 300/500 tabs, rebuild ≈20 ms p95, scroll/search ≈1 frame, DOM < 80 rows |
| AC11 | `tabs.onReplaced` keeps child/parent relations | ✅ | `migrateTabId` migrates edges/overrides/collapse/inferred; unit-level design |
| AC12 | Equal-length title/URL change still updates the panel | ✅ | unit test `revision changes when equal-length content changes` |

## Known limits (not defects)

- **Side-panel side is owned by Chrome.** The user asked for a left sidebar, but
  the extension cannot force it; Chrome decides left/right in
  `chrome://settings/appearance` → side panel position. This is documented in
  the README and surfaced to users.
- **Restore is a heuristic.** Identical URLs and extreme reordering can still
  cross-pair; every restored row is badged and can be corrected with one drag.
  Chrome restores tabs asynchronously, hence the 15 s retry window.
- **Cross-window drag is rejected by design.** A panel shows one window at a
  time, so the UI cannot present a cross-window drop target; the engine still
  rejects it defensively.
- **Branded Chrome 137+ ignores `--load-extension`.** Automated suites use
  Chrome for Testing / Chromium via `CHROME_PATH`.
