# Verification report — Tab Tree 0.1.1

Date: 2026-11-03
Environment: macOS (arm64), Node.js 24.21.0, npm 11.19.0, Chrome for Testing
156.0.8078.4 (Playwright cache), headless CDP automation.

This report supersedes the 0.1.0 report. The 0.1.0 release **failed the core
user story** in real Chrome: `openerTabId` is cleared by `ForgetAllOpeners()`
whenever a new foreground link tab is inserted, so A→B and A→C flattened the
tree. The fix (0.1.1) captures the creation relation from
`webNavigation.onCreatedNavigationTarget` / `tabs.onCreated` / a build-time
probe, persists it for the browser session, and uses it ahead of
`openerTabId`. See [test-report.md](test-report.md) for the original failure
evidence and root-cause analysis.

## Automated results (0.1.1)

| Command | Result |
| --- | --- |
| `npm run check` | ✔ 15 files · manifest v0.1.1 (`tabs, sidePanel, storage, webNavigation`) · 37 EN / 37 ZH i18n keys · no `<all_urls>`, no remote scripts |
| `npm test` | ✔ **35/35** engine tests (`node:test`, zero dependencies) |
| `npm run build` | ✔ `dist/tab-tree-v0.1.1.zip` — 17 files, 45.7 KiB, `sha256 ee6e851a01e3b1aae607d7146f8b3f0abf3b52fae110bf4c57346664c160c3e4` |
| `npm run smoke` | ✔ **29/29** checks against a real Chrome for Testing instance |
| `npm run test:e2e` | ✔ **8/8** real-link acceptance checks (real mouse events, not synthetic openers) |
| CI | `.github/workflows/ci.yml` runs `check` + `test` + `build` on pushes/PRs (browser suites stay local because they need Chrome for Testing) |

## Real-link acceptance (`npm run test:e2e`)

The script drives a real Chrome for Testing instance, serves local pages, opens
a page from the address bar (A), and clicks links with
`Input.dispatchMouseEvent` — no `chrome.tabs.create({openerTabId})` shortcuts.

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

Observed after the fix: B and C keep `parentId = A` even though Chrome sets
B's live `openerTabId` back to `null`; D is depth 2 under B. The relation now
comes from the persisted edge, not the transient tab property.

## What the smoke suite exercises

- loads the unpacked extension and finds the Tab Tree service worker;
- validates manifest, side-panel entry and the exact permission set
  (`tabs, sidePanel, storage, webNavigation`);
- seeds a three-level tree with `chrome.tabs.create({openerTabId})` **without**
  calling the debug reparent hook — the tree must come from captured creation
  edges / live-opener capture;
- verifies a genuine link-opened `/other-child` tab is a depth-1 child;
- renders `sidepanel.html` and asserts row depth, `data-parent-id`, indentation;
- clicks the root twisty, confirms descendants disappear and the collapsed
  flag reaches the worker, then expands again;
- clicks a row’s close button and confirms the tab leaves UI and worker;
- terminates the service worker via CDP, confirms the panel reconnects, wakes
  a new worker and repaints the tree (edges survive because they are persisted
  immediately);
- captures `docs/screenshot-light.png` and `docs/screenshot-dark.png`;
- asserts zero runtime exceptions in the panel and the worker.

## Acceptance criteria

| # | Criterion | Status | Evidence |
| --- | --- | --- | --- |
| AC1 | A link opened from **A** is a child of **A**, and stays a child after further foreground opens | ✅ | `npm run test:e2e` checks 1, 3, 5 (real clicks); unit tests for edge priority |
| AC2 | Independently opened tab is a root sibling of A | ✅ | e2e check 6; smoke `/other`; unit tests |
| AC3 | Three levels render with 16 px indent | ✅ | e2e checks 2, 4; smoke panel depth/parent/indent assertions; screenshots |
| AC4 | Collapse hides the subtree and persists in the worker | ✅ | smoke twisty click + worker `collapsed` check |
| AC5 | Close from panel removes the tab; direct children are promoted one level by default | ✅ | `planOrphanPromotion` unit test; e2e closes B and asserts D becomes a depth-1 child of A; smoke close check |
| AC6 | Drag reparent applies an override and rejects cycles/cross-window | ✅ (engine + validation), ⚠️ drag gesture not automated | `canReparent` unit tests; smoke uses the same validated override path for the panel tab normalisation |
| AC7 | Service-worker termination recovers with the tree intact | ✅ | smoke kills the worker; panel reconnects and repaints; creation edges persist in `storage.session` |
| AC8 | Session restore after browser restart uses a real restart marker | ✅ (unit) / ⚠️ no automated real restart | `matchRestoreSnapshot` restart tests; `init()` uses `storage.session` marker + `onStartup`; manual checklist pending |
| AC9 | Multi-window forests, panel follows its host window | ✅ (unit) / ⚠️ panel window binding not automated | unit tests build per-window forests; `detectHostWindow()` in `sidepanel.js`; manual checklist pending |
| AC10 | Hundreds of tabs stay responsive | ⚠️ design only | fixed-height virtual list, 60 ms coalescing, O(n log n) rebuild; no 500-tab measurement in this pass |
| AC11 | `tabs.onReplaced` keeps child/parent relations | ✅ (unit-level design) | `migrateTabId` migrates both directions; not covered by a browser E2E |
| AC12 | Equal-length title/URL change still updates the panel | ✅ | unit test `revision changes when equal-length content changes` |

## Known verification gaps

- Browser restart restore and the side panel’s host-window binding are covered
  by unit tests / code inspection, not by an automated browser restart.
- Drag-and-drop reparent is validated at the engine/validation layer; no
  synthetic pointer-drag E2E exists.
- The 500-tab performance target is a design claim, not a measured result.
- `webNavigation` is required for the primary fix; without it the extension
  falls back to live `openerTabId`/`tabs.onCreated` and the A→B, A→C case
  regresses. Do not remove the permission.
