# Tab Tree — research notes

Status: research updated for v0.2.0 · Scope: Chrome MV3 side panel · Date: 2026-11-03

## 1. Problem

The native Chrome tab strip is a flat row. Users who research in branches (docs → API reference → examples → issue) lose the mental model as soon as the strip overflows. The request:

> Open page A → every tab opened from a link inside A is a child of A (indented one level in a left sidebar). A page B opened independently is a sibling of A.

**One clarification applied throughout this repo:** the literal request said “B 则与 B 平级”, but A is the referent; the implementation treats an independently opened B as a **sibling of A** (both roots). That is the only interpretation consistent with “opens a new page” and with the tree screenshots.

## 2. Hard constraints discovered

| Constraint | Evidence | Consequence |
| --- | --- | --- |
| Chrome extensions cannot restyle or replace the native tab strip | There is no `chrome.*` API for tab-strip rendering; `tabGroups` can color/group, not restructure. | The tree must live in an extension-owned surface. |
| `chrome.sidePanel` is the closest native surface | [Side Panel API](https://developer.chrome.com/docs/extensions/reference/api/sidePanel), Chrome 114+. | Primary UI = side panel; `minimum_chrome_version: 114`. |
| A side panel is per-window and only visible while open | Side-panel docs | Must degrade gracefully when closed; state is owned by the service worker. |
| Parent signal must be automatic | [chrome.tabs `openerTabId`](https://developer.chrome.com/docs/extensions/reference/api/tabs#property-Tab-openerTabId) is populated when a tab is opened from another tab, but Chromium **clears it** (`ForgetAllOpeners()` in `tab_strip_model.cc`) when a foreground link tab is inserted. [chrome.webNavigation `onCreatedNavigationTarget`](https://developer.chrome.com/docs/extensions/reference/api/webNavigation#event-onCreatedNavigationTarget) reports the source tab at creation time. | Capture `(childTabId, sourceTabId)` from `webNavigation`/`tabs.onCreated`/live-opener probe into a session-persisted edge map; use it ahead of the transient `openerTabId`. Address-bar/Ctrl+T tabs get no edge → roots. |
| The captured edge must be durable | `chrome.storage.session` survives MV3 worker termination but is cleared on browser restart. | Persist every captured edge immediately; after restart fall back to the URL/LCS restore heuristic. |
| `openerTabId` is not preserved across browser restarts | Chrome issue tracker / observed in testing; tab ids change. | Need a fingerprint snapshot + matching heuristic (see design doc). |
| MV3 service workers are terminated at will | [SW lifecycle](https://developer.chrome.com/docs/extensions/develop/concepts/service-workers/lifecycle) | Rebuild idempotently from `chrome.tabs` on every wake; persist only small deltas. |
| Browser restart restores tabs with new ids | Standard Chrome behaviour | Snapshot restore matches by URL/order, not by id. |

## 3. Competitive landscape

| Product | Platform | Tree model | Strengths | Gaps we address |
| --- | --- | --- | --- | --- |
| [Tree Style Tab](https://addons.mozilla.org/firefox/addon/tree-style-tab/) | Firefox | Vertical native sidebar, deep nesting, tabs collapsed with parent | Mature UX, session restore, many options | Firefox-only; no Chrome side panel. |
| [Sidebery](https://github.com/mbnuqw/sidebery) | Firefox | Sidebar + containers + snapshots | Excellent power-user features | Firefox-only; heavier than a focused v1. |
| [Tab Tree](https://chromewebstore.google.com/detail/tab-tree/fkpiebfdeocdoofjfhmaidhhbkmbfgjl) | Chrome | Extension surface tree from opener relations | Proves demand on Chrome | Closed source; UI/restore quality varies. |
| [Tabs Outliner](https://chromewebstore.google.com/detail/tabs-outliner/eggkanocgddhmamlbiijnphhppkpkmkl) | Chrome | Separate window “tree of everything” | Powerful session notebook | Separate window, not in-flow; dated UX. |
| [Workona](https://workona.com/) | Chrome | Workspaces / tab collections | Team/workspace workflows | Workspace-oriented, not per-link tree; cloud account. |
| [Arc](https://arc.net/) | Proprietary browser | Sidebar with pinned / today / archives | Beautiful spatial model | Not Chrome; replaces the whole browser. |
| Chrome tab groups | Chrome | Flat groups with color/name | Native, synced | One level only; no parent/child links. |

**Takeaways**

1. Opener-based nesting is the established model (Tree Style Tab, Tab Tree). Users expect link-opened tabs to nest automatically.
2. The hardest correctness problem is **session restore**: tab ids change and `openerTabId` disappears. Products that get this right (Tree Style Tab) invest heavily in session stores.
3. Chrome’s side panel is the only in-flow surface. A separate window is a fallback, not the primary UX.
4. Drag-to-reparent and keyboard navigation are table stakes; drag should not use HTML5 DnD inside a narrow panel.

## 4. Design decisions (ADR summary)

| # | Decision | Alternatives | Why |
| --- | --- | --- | --- |
| D1 | Side panel as primary UI, `minimum_chrome_version` 114 | Popup window; injected floating panel | Native, per-window, no host permissions needed; popup steals focus. |
| D2 | Parent = captured creation edge (override > edge > `openerTabId` > root) | Content-script `document.referrer`; URL heuristics | The edge is automatic and exact, and unlike raw `openerTabId` it survives `ForgetAllOpeners()`. Content scripts would require `<all_urls>`, a much larger review/permission surface. |
| D3 | One forest per window; no cross-window parent edges | Global tree | Chrome moves tabs between windows; cross-window edges are unstable and confusing. |
| D4 | Siblings ordered by `tab.index`; explicit “sort tab strip by tree” | Separate tree order | Keeps the panel consistent with the native strip, avoids dual sources of truth. |
| D5 | Closing a parent promotes children one level (default); opt-in “close subtree” | Always close subtree | Data-loss-safe default, matches Chrome behaviour when an opener dies. |
| D6 | Restore by URL/order matching, only after a real restart | Do nothing; id-based mapping | Tab ids are not stable; user expectation is that a restart keeps the shape. Mismatches are marked and can be re-hung manually. |
| D7 | Zero-build plain ES modules (no bundler, no npm deps) | Vite + React + @crxjs | Loads unpacked in one step, no supply-chain surface, trivially auditable service worker. React would add ~140 KB and a build step for a 500-row list we virtualize ourselves. |
| D8 | `tabs` + `sidePanel` + `storage` + `webNavigation`, no host permissions | `<all_urls>`, content scripts | `webNavigation` is needed for `onCreatedNavigationTarget` (the only reliable link-creation signal); it adds no host permission and no new install warning beyond “Read your browsing history”. |
| D9 | Pointer-event drag, not HTML5 DnD | `dragstart` / `dragover` | HTML5 DnD is unreliable in narrow side panels and needs extra drag images; pointer events give precise hit testing and auto-scroll. |
| D10 | No cloud sync in v1 | `storage.sync` | 8 KB/item quota and write-rate limits cannot hold a large forest; local only, no telemetry. |

## 5. What ships in v0.2.0

- Tree built from creation edges captured via `webNavigation` (persisted per session), one root per independently opened tab.
- Fixed 16 px indentation per level; collapse/expand with persisted state.
- Drag onto a row → child; drag onto the root zone → top-level.
- Keyboard navigation (`↑/↓/Home/End/←/→/Enter/Delete`), context menu, search with ancestor preservation.
- Virtualized list for large windows (32 px fixed rows, overscan 8).
- Session restore via fingerprint snapshot; uncertain links are marked. Restore
  retries across Chrome’s asynchronous tab restoration for up to 60 s and resumes the pending restore after an MV3 worker reclaim. Marker,
  edges, overrides, collapse and restored flags are persisted together, so a
  plain worker wake never replays the snapshot.
- “Sort native tabs by tree” + optional automatic sync after a drag.
- Multi-window selector; per-window forests; the panel follows its host window.
- English + Simplified Chinese UI (`_locales`), automatic light/dark theme.
- Unit tests (35), dependency-free project checks, packaged zip, CDP smoke test.
- Executable browser suites: real-link acceptance, pointer-drag + multi-window,
  real two-process restart, and 300/500-tab performance benchmark.

**Explicit non-goals for v0.1.x:** cloud sync, tab-group editing (we read `groupId` only), vertical native tab strip (impossible), container-like profiles, mobile Chrome, Firefox port.

## 6. Permission justification

| Permission | Why | What we do not do |
| --- | --- | --- |
| `tabs` | Read `id`, `openerTabId`, `windowId`, `index`, `title`, `url`, `favIconUrl`; activate/close/move tabs on explicit user action. | No history API, no reading page content, no network requests. |
| `webNavigation` | Only `onCreatedNavigationTarget` (child tab id + source tab id) is consumed. | No URL history, frame tree, or page content is read; the event only tells us which tab opened the new tab. |
| `sidePanel` | Register `sidepanel.html` and open it from the toolbar action. | — |
| `storage` | `session` for hot state (creation edges, overrides, collapsed, restart marker), `local` for prefs and the restore snapshot. | No `sync`, no external storage, no telemetry. |

No content scripts, no host permissions, no remote code, no `<all_urls>`. The panel loads only same-origin ES modules and local icons; favicons come from Chrome’s own `favIconUrl`.

## 7. References

- Chrome Side Panel API — https://developer.chrome.com/docs/extensions/reference/api/sidePanel
- `chrome.tabs` (including `openerTabId`, `move`, `onReplaced`) — https://developer.chrome.com/docs/extensions/reference/api/tabs
- `chrome.storage` (session/local quotas) — https://developer.chrome.com/docs/extensions/reference/api/storage
- Extension service worker lifecycle — https://developer.chrome.com/docs/extensions/develop/concepts/service-workers/lifecycle
- Chrome tab groups — https://developer.chrome.com/docs/extensions/reference/api/tabGroups
- Tree Style Tab — https://addons.mozilla.org/firefox/addon/tree-style-tab/
- Sidebery — https://github.com/mbnuqw/sidebery
- Tab Tree (Chrome Web Store) — https://chromewebstore.google.com/detail/tab-tree/fkpiebfdeocdoofjfhmaidhhbkmbfgjl
- Tabs Outliner — https://chromewebstore.google.com/detail/tabs-outliner/eggkanocgddhmamlbiijnphhppkpkmkl
- Workona — https://workona.com/
- Arc — https://arc.net/
