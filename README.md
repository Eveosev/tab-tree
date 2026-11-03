# Tab Tree

**Tree-style tab management for Chrome’s side panel.** Tabs you open from a link become children of the page that opened them; tabs you open independently stay top-level. No account, no network, no build step.

![Tab Tree side panel (light)](docs/screenshot-light.png#gh-light-mode-only)
![Tab Tree side panel (dark)](docs/screenshot-dark.png#gh-dark-mode-only)

## Why

Chrome’s tab strip is flat. Research branches (docs → API → example → issue) turn into an unreadable row of lookalike tabs. Chrome exposes no API to restyle the native strip, but it does expose the signal that matters: **`chrome.tabs.Tab.openerTabId`**.

- Open a link from **A** → Chrome sets `openerTabId = A` → the new tab renders indented under **A**.
- Press **Ctrl/Cmd+T**, type a URL, open a bookmark → no opener → the tab is a **root**, a sibling of A.
- A→B→C nesting is supported to any practical depth.

The tree lives in the native **side panel** (Chrome 114+), next to the page you are browsing. The toolbar button opens it.

## Features

| | |
| --- | --- |
| 🌳 **Automatic tree** | Built from `openerTabId`; dead openers are promoted to roots and marked. |
| 📏 **Indentation** | Exactly 16 px per level, with vertical guide lines. |
| ↔️ **Drag to reparent** | Drop on a row to make it a child, drop on the bottom zone to make it top-level. Cycles and cross-window parents are rejected. |
| ⌨️ **Keyboard-first** | `↑/↓` move, `←` collapse/parent, `→` expand/child, `Enter` activate, `Delete` close, `/` search. |
| 🔍 **Search** | Filters title/URL, keeps ancestors visible, auto-expands matches. |
| 🧭 **Multi-window** | One forest per window; a window picker appears when more than one exists. |
| 🗂️ **Collapse / expand all** | Bulk toggle, state persisted for the browser session. |
| 💾 **Session restore** | Fingerprint snapshot + order-preserving URL matching after a browser restart; restored links carry a badge. |
| ⚡ **Fast with hundreds of tabs** | Fixed-height virtual list, 60 ms event coalescing, pure rebuild-on-demand engine. |
| 🎨 **Native feel** | Automatic light/dark, compact rows, favicons, pinned/audio indicators. |
| 🌍 **i18n** | English and Simplified Chinese (`_locales`). |
| 🔒 **Local-only** | No host permissions, no content scripts, no telemetry, no remote code. |

## Install (unpacked, Chrome 114+)

1. Clone this repo.
2. Open `chrome://extensions`, enable **Developer mode**.
3. **Load unpacked** → select the `extension/` directory.
4. Click the Tab Tree toolbar icon (or the side-panel button) to open the panel.

A packaged build is also available: `npm run build` creates `dist/tab-tree-v0.1.0.zip`.

> Chrome 137+ ignores `--load-extension` on branded builds; use Chrome for Testing/Chromium for automated runs (see *Development*).

## Usage

- **Tree** – rows with a twisty have children. Click the twisty (or `←`/`→`) to collapse/expand.
- **Open** – click a row or press `Enter`; middle-click or `Delete` closes the tab.
- **Rearrange** – drag a row onto another row to nest it; drag to the floating “make top-level” zone to un-nest it. Reparenting is an explicit override and survives worker restarts; it is released when the tab closes.
- **Filter** – type in the search box; ancestors of matches remain visible. `Esc` clears.
- **Sort the native strip** – the toolbar sort button (or automatic after a drag, configurable) reorders Chrome’s tab strip into tree (DFS) order. Pinned tabs stay pinned at the front.
- **Settings** – choose whether closing a parent also closes its children (off by default: children are promoted one level), and whether drag-reparent should auto-sort the native strip.

### Keyboard map

| Key | Action |
| --- | --- |
| `↑` / `↓` | Move selection |
| `Home` / `End` | First / last visible tab |
| `→` | Expand collapsed node, otherwise move to first child |
| `←` | Collapse expanded node, otherwise move to parent |
| `Enter` / `Space` | Activate selected tab |
| `Delete` / `Backspace` | Close selected tab |
| `/` | Focus search |
| `Esc` | Clear search / close popover |
| Right-click | Context menu (activate, collapse, make top-level, close, close subtree) |
| Middle-click | Close tab |

## How it works

```mermaid
flowchart LR
  T["chrome.tabs\nopenerTabId · index · windowId"] --> SW["Service worker\nsingle source of truth"]
  W["chrome.windows"] --> SW
  SW --> S1["storage.session\noverrides · collapsed"]
  SW --> S2["storage.local\nprefs · restore snapshot"]
  SW -- "tree.changed (snapshot)" --> P["Side panel\nvirtualized tree"]
  P -- "intents: activate · close\nreparent · collapse · reorder" --> SW
```

- **Parent inference:** explicit override → live `openerTabId` (same window) → root. A dead opener is marked `orphan`; an override chain that would cycle is broken defensively.
- **Rebuild on wake:** MV3 workers are disposable. Every wake re-queries tabs and recomputes the forest, so no event can be permanently lost.
- **Restore:** a compact `{url, index, parentId}` snapshot is written to `storage.local`; after a restart, windows are paired by URL overlap and tabs are aligned with LCS over normalized URLs, then parent links are transferred. Uncertain links are marked and can be re-hung by dragging.
- **Ordering:** siblings follow `tab.index`; DFS flattening defines native order after an explicit sort.

More detail: [design](docs/design.md) · [research notes](docs/research.md) · [verification report](docs/verification.md).

## Permissions

| Permission | Purpose |
| --- | --- |
| `tabs` | Read tab metadata (`openerTabId`, title, URL, favicon), activate/close/move tabs on user action. |
| `sidePanel` | Host the tree in Chrome’s side panel. |
| `storage` | Persist preferences, collapse state and the restore snapshot locally. |

No `<all_urls>`, no content scripts, no network requests, no remote code, no telemetry. Everything stays on your machine.

## Development

Requirements: Node.js ≥ 20, Chrome/Chromium 114+, `zip`/`unzip` for packaging.

```bash
npm test          # 29 engine unit tests (node:test, zero dependencies)
npm run check     # syntax, JSON, manifest refs, i18n parity, permission guard
npm run build     # dist/tab-tree-v0.1.0.zip (+ sha256)
npm run smoke     # real Chrome via CDP: nesting, panel DOM, collapse, close, worker restart, screenshots
npm run verify    # check + test + build
```

No `npm install` is needed — the extension has **zero runtime and build dependencies**. Everything in `extension/` is plain ES modules loaded directly by Chrome.

### Smoke test note

Branded Chrome 137+ ignores `--load-extension` (a malware mitigation). `npm run smoke` automatically prefers a Playwright-cached **Chrome for Testing** or a Chromium binary; set `CHROME_PATH` to point at one explicitly. The smoke test drives a real browser, creates real link-opened tabs, inspects the generated tree, exercises the side-panel DOM, kills the service worker, and captures the screenshots in `docs/`.

### Project layout

```
extension/
  manifest.json            MV3 manifest (114+, tabs/sidePanel/storage)
  background.js            service worker: events, build loop, intents, persistence
  sidepanel.html/.css/.js  virtualized tree UI
  lib/tree-engine.js       pure tree algorithms (tested in Node)
  _locales/{en,zh_CN}       UI strings
  icons/                   16/32/48/128 PNGs
test/tree-engine.test.js   engine unit tests
scripts/{check,build,smoke}.mjs
docs/research.md           product research, competitors, ADRs
docs/design.md             architecture, algorithms, protocol, risks
```

## Known limitations

- Chrome provides no way to restyle the native tab strip, so the tree is a side panel, not a replacement strip.
- `openerTabId` can be absent (some extension-initiated opens, restored sessions); those tabs become roots until you drag them.
- Session restore is heuristic: duplicate URLs and heavy reordering can produce an occasional wrong link. Restored links are badged and can be fixed in one drag.
- Collapse state is session-scoped (tab ids do not survive a browser restart).
- Drag currently changes parent/child, not sibling order.
- Side panel requires Chrome 114+; a popup fallback is on the roadmap.

## Roadmap

- v0.2: sibling drag reorder, undo close, popup fallback for Chrome < 114, group filters.
- v0.3: saved workspaces/snapshots, JSON export/import, cross-window search, fuzzy matching.

## License

MIT © Eveosev
