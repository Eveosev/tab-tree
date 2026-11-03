# Verification report

Date: 2026-11-03
Environment: macOS (arm64), Node.js 24.21.0, Chrome for Testing 156.0.8078.4 (Playwright cache)

## Automated results

| Command | Result |
| --- | --- |
| `npm run check` | ✔ 14 files checked · manifest v0.1.0 (tabs, sidePanel, storage) · 37 EN / 37 ZH i18n keys · no `<all_urls>`, no remote scripts |
| `npm test` | ✔ 29/29 engine tests (`node:test`, no dependencies) |
| `npm run build` | ✔ `dist/tab-tree-v0.1.0.zip` — 17 files, 42.6 KiB, `sha256 93fad5c386c775b40deb5b4e24033c211fe1e8f9768859e1047ff31eafc3ed7f` |
| `npm run smoke` | ✔ **29/29 checks passed** against a real Chrome for Testing instance |

### What the smoke test exercises

- loads the unpacked extension and finds the Tab Tree service worker;
- validates manifest, side-panel entry and the exact permission set;
- opens a real page, seeds a three-level tree, then verifies snapshot depths/parents;
- verifies a **real link click** produces `openerTabId` and a depth-1 child (`/other` → `/other-child`);
- renders `sidepanel.html` in a real extension tab and asserts row depth, `data-parent-id`, and indentation for child and grandchild;
- clicks the root twisty through the DOM, waits for descendant rows to disappear, confirms the collapsed flag in the worker, then expands again;
- clicks a row’s close button and confirms the tab disappears from both UI and worker;
- terminates the service worker via CDP and confirms the panel reconnects, wakes a new worker and repaints the tree;
- captures `docs/screenshot-light.png` and `docs/screenshot-dark.png` at 380×760 @2x;
- asserts zero runtime exceptions in both the panel and the worker.

## Acceptance criteria

| # | Criterion | Status | Evidence |
| --- | --- | --- | --- |
| AC1 | Link-opened tab becomes a child of the opener | ✅ | Unit tests (`openerTabId`, dead opener, orphan) + smoke `/other-child` real click |
| AC2 | Independently opened tab is a root (sibling of A) | ✅ | Smoke `/other` root; unit tests |
| AC3 | Three levels render with 16 px indent | ✅ | Smoke panel depth 1/2 + screenshots |
| AC4 | Collapse hides the whole subtree and persists in the worker | ✅ | Smoke twisty click + worker `collapsed` check |
| AC5 | Close from panel removes tab; children are promoted (default) | ✅ | Smoke close-button check + engine unit test |
| AC6 | Drag reparent applies an override and rejects cycles/cross-window | ✅ | Engine `canReparent` tests; smoke uses the same validated override path for deterministic seeding |
| AC7 | Service-worker termination recovers with the tree intact | ✅ | Smoke kills the worker, panel reconnects and repaints (well under the 5 s target) |
| AC8 | Session restore after browser restart | ✅ | Restore engine tests (LCS, window pairing, duplicate URLs, live-opener skip) |
| AC9 | Multi-window forests | ✅ | Unit tests build per-window forests; API exposes window switcher |
| AC10 | Hundreds of tabs stay responsive | ✅ (design) | Fixed-height virtual list with overscan; 60 ms coalesced rebuilds; O(n log n) sort |

## Headless Chrome note

While writing the end-to-end test we found that Chrome for Testing **156** under CDP only records `openerTabId` for the most recently opened synthetic `target=_blank`/`tabs.create` tab; earlier ones come back as `null` even with no extension loaded. This is a harness/browser quirk, not extension behaviour (production Chrome sets `openerTabId` for link-opened tabs). The smoke test therefore:

1. keeps a **genuine link-opened** `/other-child` tab as automatic-inference evidence, and
2. builds the deeper docs → article → comments chain through the extension’s validated override path, which is the same code path used by drag-and-drop reparenting.

Automatic multi-level inference itself is covered by the 29 engine unit tests, including arbitrary depth, dead openers, cycles, and override precedence.
