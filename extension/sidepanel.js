/**
 * Tab Tree — side panel view.
 *
 * Pure rendering + intent dispatch. All writes go to the service worker over a
 * long-lived port; the panel never mutates the tree itself (except in demo
 * mode, used for screenshots and local UI review).
 */

import { DEFAULT_PREFS, buildSnapshot, getVisibleNodes } from './lib/tree-engine.js';

const ROW_HEIGHT = 32;
const OVERSCAN = 8;
const INDENT = 16;
const PORT_NAME = 'tab-tree';
const isExtension = typeof chrome !== 'undefined' && Boolean(chrome.runtime?.id);

const ICONS = {
  chevron:
    '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="m6 9 6 6 6-6"/></svg>',
  close:
    '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 6l12 12M18 6 6 18"/></svg>',
  pin: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 17v5"/><path d="M9 3h6l-1 6 3 3H7l3-3-1-6Z"/></svg>',
  sound:
    '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M11 5 6 9H3v6h3l5 4V5Z"/><path d="M15 9a4 4 0 0 1 0 6"/></svg>',
  lost: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 8v5M12 17h.01"/><circle cx="12" cy="12" r="9"/></svg>',
  restored:
    '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M3 12a9 9 0 1 0 3-6.7"/><path d="M3 4v5h5"/></svg>',
};

const FALLBACK_STRINGS = {
  extName: 'Tab Tree',
  extDesc: 'Tree-style tab management in Chrome’s side panel.',
  actionTitle: 'Open Tab Tree',
  searchPlaceholder: 'Search tabs',
  collapseAll: 'Collapse all',
  expandAll: 'Expand all',
  sortTabs: 'Sort tabs by tree',
  sortTabsHint: 'Reorder the native tab strip to match this tree',
  settings: 'Settings',
  refresh: 'Refresh',
  settingsTitle: 'Settings',
  closeWithChildren: 'Close child tabs with their parent',
  closeWithChildrenHint: 'Off by default: children are promoted one level.',
  autoSort: 'Keep native tab order in sync',
  autoSortHint: 'After a drag, flatten the tab strip in tree order.',
  noTabs: 'No tabs in this window',
  noMatches: 'No matching tabs',
  dropRoot: 'Drop here to make it top-level',
  activate: 'Activate',
  close: 'Close',
  closeSubtree: 'Close tab and children',
  makeRoot: 'Make top-level',
  collapseSubtree: 'Collapse children',
  expandSubtree: 'Expand children',
  window: 'Window',
  tabs: 'tabs',
  shown: 'shown',
  topLevel: 'top-level',
  linksRestored: 'links restored',
  pinned: 'Pinned',
  audible: 'Playing audio',
  orphanHint: 'The tab that opened this one was closed; promoted to top level.',
  inferredHint: 'Relationship restored from the previous browser session.',
  closeHint: 'Close tab',
  dropHint: 'Drag onto another tab to nest it, or onto the empty area to make it top-level.',
  error: 'Something went wrong',
  notConnected: 'Tab Tree background is starting…',
  confirmClose: 'Close',
};

const state = {
  /** @type {Object|null} */
  snapshot: null,
  /** @type {number|null} */
  windowId: null,
  /** @type {number|null} */
  manualWindowId: null,
  query: '',
  selectedTabId: null,
  rows: [],
  scrollRaf: 0,
  lastRenderKey: '',
  port: null,
  pending: new Map(),
  requestSeq: 0,
  prefs: { ...DEFAULT_PREFS },
  treeHasFocus: false,
  suppressClickUntil: 0,
  drag: null,
  menuTabId: null,
  toastTimer: null,
  demo: false,
};

const el = {
  tree: document.getElementById('tree'),
  inner: null,
  empty: document.getElementById('empty'),
  emptyText: document.getElementById('emptyText'),
  status: document.getElementById('status'),
  restoreInfo: document.getElementById('restoreInfo'),
  count: document.getElementById('count'),
  search: document.getElementById('search'),
  searchClear: document.getElementById('searchClear'),
  windowSelect: document.getElementById('windowSelect'),
  btnCollapse: document.getElementById('btnCollapse'),
  btnSort: document.getElementById('btnSort'),
  btnSettings: document.getElementById('btnSettings'),
  settings: document.getElementById('settings'),
  prefCloseChildren: document.getElementById('prefCloseChildren'),
  prefAutoSort: document.getElementById('prefAutoSort'),
  btnRebuild: document.getElementById('btnRebuild'),
  menu: document.getElementById('menu'),
  toast: document.getElementById('toast'),
  rootDrop: document.getElementById('rootDrop'),
};

/* -------------------------------------------------------------------------- */
/* Small helpers                                                              */
/* -------------------------------------------------------------------------- */

function t(key) {
  if (isExtension && chrome.i18n?.getMessage) {
    const localized = chrome.i18n.getMessage(key);
    if (localized) return localized;
  }
  return FALLBACK_STRINGS[key] || key;
}

function applyI18n() {
  for (const node of document.querySelectorAll('[data-i18n]')) {
    const key = node.dataset.i18n;
    if (key) node.textContent = t(key);
  }
  for (const node of document.querySelectorAll('[data-i18n-placeholder]')) {
    const key = node.dataset.i18nPlaceholder;
    if (key) node.placeholder = t(key);
  }
  el.btnCollapse.title = t('collapseAll');
  el.btnCollapse.setAttribute('aria-label', t('collapseAll'));
  el.btnSort.title = t('sortTabsHint');
  el.btnSort.setAttribute('aria-label', t('sortTabs'));
  el.btnSettings.title = t('settings');
  el.btnSettings.setAttribute('aria-label', t('settings'));
  el.searchClear.setAttribute('aria-label', t('close'));
  el.windowSelect.setAttribute('aria-label', t('window'));
}

function showToast(message, duration = 3200) {
  clearTimeout(state.toastTimer);
  el.toast.textContent = message;
  el.toast.hidden = false;
  state.toastTimer = setTimeout(() => {
    el.toast.hidden = true;
  }, duration);
}

function fail(error) {
  const message = error?.message || String(error || t('error'));
  showToast(message);
}

function isWindowAlive(windowId) {
  return Boolean(state.snapshot?.windows.some((item) => item.id === windowId));
}

/* -------------------------------------------------------------------------- */
/* Connection                                                                 */
/* -------------------------------------------------------------------------- */

function connect() {
  if (!isExtension) return;
  try {
    const port = chrome.runtime.connect({ name: PORT_NAME });
    state.port = port;
    port.onMessage.addListener(onPortMessage);
    port.onDisconnect.addListener(() => {
      state.port = null;
      for (const [, pending] of state.pending) {
        clearTimeout(pending.timer);
        pending.reject(new Error(t('notConnected')));
      }
      state.pending.clear();
      setTimeout(connect, 450);
    });
    send('tree.getSnapshot').catch(() => {});
  } catch {
    setTimeout(connect, 900);
  }
}

function onPortMessage(message) {
  if (message?.type === 'tree.changed') {
    setSnapshot(message.snapshot);
    return;
  }
  if (message?.type === 'action.result' || message?.type === 'action.error') {
    const pending = state.pending.get(message.requestId);
    if (!pending) return;
    state.pending.delete(message.requestId);
    clearTimeout(pending.timer);
    if (message.type === 'action.result') pending.resolve(message);
    else pending.reject(new Error(message.error || t('error')));
  }
}

function send(type, payload = {}, timeout = 6000) {
  if (!isExtension) return mockAction(type, payload);
  if (!state.port) connect();
  const port = state.port;
  if (!port) return Promise.reject(new Error(t('notConnected')));
  const requestId = ++state.requestSeq;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      state.pending.delete(requestId);
      reject(new Error(`${type} timed out`));
    }, timeout);
    state.pending.set(requestId, { resolve, reject, timer });
    try {
      port.postMessage({ type, ...payload, requestId });
    } catch (error) {
      state.pending.delete(requestId);
      clearTimeout(timer);
      reject(error);
    }
  });
}

/* -------------------------------------------------------------------------- */
/* Snapshot → render                                                          */
/* -------------------------------------------------------------------------- */

function setSnapshot(snapshot) {
  if (!snapshot) return;
  state.snapshot = snapshot;
  state.prefs = { ...DEFAULT_PREFS, ...(snapshot.prefs || {}) };

  const windows = snapshot.windows || [];
  const preferred = state.manualWindowId && windows.some((w) => w.id === state.manualWindowId)
    ? state.manualWindowId
    : windows.find((w) => w.focused)?.id ?? windows[0]?.id ?? null;
  state.windowId = preferred;

  if (!state.selectedTabId || !snapshot.nodes.some((n) => n.tabId === state.selectedTabId)) {
    const active = snapshot.nodes.find((n) => n.tabId === snapshot.activeTabId);
    state.selectedTabId = active?.tabId ?? null;
  }

  updateWindowSelect();
  updatePrefControls();
  render();
}

function updateWindowSelect() {
  const windows = state.snapshot?.windows || [];
  if (windows.length <= 1) {
    el.windowSelect.hidden = true;
    return;
  }
  el.windowSelect.hidden = false;
  const current = state.windowId;
  el.windowSelect.replaceChildren(
    ...windows.map((window, index) => {
      const option = document.createElement('option');
      option.value = String(window.id);
      option.textContent = `${t('window')} ${index + 1} · ${window.tabCount}`;
      option.selected = window.id === current;
      return option;
    }),
  );
}

function updatePrefControls() {
  if (document.activeElement !== el.prefCloseChildren) {
    el.prefCloseChildren.checked = Boolean(state.prefs.closeChildrenWithParent);
  }
  if (document.activeElement !== el.prefAutoSort) {
    el.prefAutoSort.checked = Boolean(state.prefs.autoSortNative);
  }
}

function currentWindow() {
  return state.snapshot?.windows.find((w) => w.id === state.windowId) || null;
}

function render() {
  const snapshot = state.snapshot;
  if (!snapshot || !state.windowId) {
    if (el.inner) el.inner.remove();
    el.inner = null;
    el.empty.hidden = false;
    el.emptyText.textContent = t('noTabs');
    el.count.textContent = '';
    el.status.textContent = '';
    return;
  }

  const window = currentWindow();
  const rows = getVisibleNodes(snapshot, state.windowId, { query: state.query });
  state.rows = rows;

  if (!el.inner) {
    el.inner = document.createElement('div');
    el.inner.className = 'tree-inner';
    el.tree.append(el.inner);
  }
  el.inner.style.height = `${rows.length * ROW_HEIGHT}px`;

  if (rows.length === 0) {
    el.empty.hidden = false;
    el.emptyText.textContent = state.query ? t('noMatches') : t('noTabs');
  } else {
    el.empty.hidden = true;
  }

  const visibleCount = rows.length;
  const total = window?.tabCount ?? 0;
  el.count.textContent = state.query ? `${visibleCount}/${total}` : String(total);

  const rootCount = window?.rootIds?.length ?? 0;
  const prefix = state.query
    ? `${visibleCount} ${t('shown')} · ${total} ${t('tabs')}`
    : `${total} ${t('tabs')} · ${rootCount} ${t('topLevel')}`;
  const collapsed = snapshot.nodes.filter(
    (node) => node.windowId === state.windowId && node.collapsed,
  ).length;
  el.status.textContent = collapsed ? `${prefix} · ${collapsed} ▸` : prefix;

  const restore = snapshot.restore?.stats;
  if (restore && restore.relations > 0) {
    el.restoreInfo.textContent = `${restore.relations} ${t('linksRestored')}`;
    el.restoreInfo.title = `${restore.matchedTabs}/${restore.oldNodes} tabs matched across ${restore.windows} window(s)`;
  } else {
    el.restoreInfo.textContent = '';
    el.restoreInfo.title = '';
  }

  updateCollapseButton();
  renderSlice(true);
}

function updateCollapseButton() {
  const hasExpanded = state.snapshot?.nodes.some(
    (node) => node.windowId === state.windowId && node.hasChildren && !node.collapsed,
  );
  const label = hasExpanded ? t('collapseAll') : t('expandAll');
  el.btnCollapse.title = label;
  el.btnCollapse.setAttribute('aria-label', label);
  el.btnCollapse.dataset.mode = hasExpanded ? 'collapse' : 'expand';
}

function renderSlice(force = false) {
  if (!el.inner) return;
  const rows = state.rows;
  const scrollTop = el.tree.scrollTop;
  const height = el.tree.clientHeight || 600;
  const start = Math.max(0, Math.floor(scrollTop / ROW_HEIGHT) - OVERSCAN);
  const end = Math.min(rows.length, Math.ceil((scrollTop + height) / ROW_HEIGHT) + OVERSCAN);
  const key = `${state.snapshot?.revision || ''}:${state.windowId}:${state.query}:${start}:${end}:${state.selectedTabId}`;
  if (!force && key === state.lastRenderKey) return;
  state.lastRenderKey = key;

  const fragment = document.createDocumentFragment();
  for (let index = start; index < end; index += 1) {
    fragment.append(createRow(rows[index], index));
  }
  el.inner.replaceChildren(fragment);

  if (state.treeHasFocus) {
    const selector = state.selectedTabId ? `[data-tab-id="${state.selectedTabId}"]` : null;
    const target = selector ? el.inner.querySelector(selector) : null;
    if (target) target.focus({ preventScroll: true });
  }
}

function createRow(node, index) {
  const row = document.createElement('div');
  row.className = 'row';
  if (node.active) row.classList.add('is-active');
  if (node.collapsed) row.classList.add('is-collapsed');
  if (node.tabId === state.selectedTabId) row.classList.add('is-selected');
  row.style.top = `${index * ROW_HEIGHT}px`;
  row.dataset.tabId = String(node.tabId);
  row.dataset.parentId = node.parentId === null ? '' : String(node.parentId);
  row.dataset.depth = String(node.depth);
  row.setAttribute('role', 'treeitem');
  row.setAttribute('aria-level', String(node.depth + 1));
  row.setAttribute('aria-selected', node.tabId === state.selectedTabId ? 'true' : 'false');
  if (node.hasChildren) row.setAttribute('aria-expanded', String(!node.collapsed));
  row.tabIndex = node.tabId === state.selectedTabId ? 0 : -1;
  row.title = node.url || node.title;

  const indent = document.createElement('span');
  indent.className = 'indent';
  indent.style.width = `${node.depth * INDENT}px`;
  indent.style.backgroundSize = `${INDENT}px 100%`;
  row.append(indent);

  if (node.hasChildren) {
    const twisty = document.createElement('button');
    twisty.type = 'button';
    twisty.className = 'twisty';
    twisty.dataset.action = 'toggle';
    twisty.title = node.collapsed ? t('expandSubtree') : t('collapseSubtree');
    twisty.innerHTML = ICONS.chevron;
    row.append(twisty);
  } else {
    const spacer = document.createElement('span');
    spacer.className = 'twisty-spacer';
    row.append(spacer);
  }

  if (node.favIconUrl) {
    const icon = document.createElement('img');
    icon.className = 'favicon';
    icon.alt = '';
    icon.loading = 'lazy';
    icon.src = node.favIconUrl;
    icon.addEventListener('error', () => {
      icon.replaceWith(fallbackIcon(node));
    });
    row.append(icon);
  } else {
    row.append(fallbackIcon(node));
  }

  const title = document.createElement('span');
  title.className = 'title';
  title.textContent = node.title || node.url || '(untitled)';
  if (!node.title) title.classList.add('dim');
  row.append(title);

  const badges = document.createElement('span');
  badges.className = 'badges';
  if (node.pinned) {
    const pin = document.createElement('span');
    pin.className = 'badge';
    pin.title = t('pinned');
    pin.innerHTML = ICONS.pin;
    badges.append(pin);
  }
  if (node.audible) {
    const sound = document.createElement('span');
    sound.className = 'badge is-audible';
    sound.title = t('audible');
    sound.innerHTML = ICONS.sound;
    badges.append(sound);
  }
  if (node.inferred) {
    const inferred = document.createElement('span');
    inferred.className = 'badge is-inferred';
    inferred.title = t('inferredHint');
    inferred.innerHTML = ICONS.restored;
    badges.append(inferred);
  }
  if (node.orphan) {
    const orphan = document.createElement('span');
    orphan.className = 'badge is-orphan';
    orphan.title = t('orphanHint');
    orphan.innerHTML = ICONS.lost;
    badges.append(orphan);
  }
  if (node.hasChildren && node.collapsed) {
    const count = document.createElement('span');
    count.className = 'child-count';
    count.textContent = String(node.descendantCount);
    badges.append(count);
  }
  if (badges.childElementCount > 0) row.append(badges);

  const close = document.createElement('button');
  close.type = 'button';
  close.className = 'close-btn';
  close.dataset.action = 'close';
  close.title = t('closeHint');
  close.innerHTML = ICONS.close;
  row.append(close);

  return row;
}

function fallbackIcon(node) {
  const span = document.createElement('span');
  span.className = 'favicon-fallback';
  const letter = (node.domain || node.title || '?').replace(/^www\./, '').charAt(0) || '?';
  span.textContent = letter;
  return span;
}

/* -------------------------------------------------------------------------- */
/* Selection / activation                                                     */
/* -------------------------------------------------------------------------- */

function rowFor(tabId) {
  return el.inner?.querySelector(`[data-tab-id="${tabId}"]`) || null;
}

function selectTab(tabId, { focus = false, scroll = false } = {}) {
  state.selectedTabId = tabId;
  for (const row of el.inner?.children || []) {
    const isSelected = Number(row.dataset.tabId) === tabId;
    row.classList.toggle('is-selected', isSelected);
    row.tabIndex = isSelected ? 0 : -1;
    row.setAttribute('aria-selected', isSelected ? 'true' : 'false');
    if (isSelected) row.classList.add('is-keyboard');
    else row.classList.remove('is-keyboard');
  }
  if (scroll) scrollToTab(tabId);
  if (focus) rowFor(tabId)?.focus({ preventScroll: true });
}

function scrollToTab(tabId) {
  const index = state.rows.findIndex((node) => node.tabId === tabId);
  if (index === -1) return;
  const top = index * ROW_HEIGHT;
  const bottom = top + ROW_HEIGHT;
  const viewTop = el.tree.scrollTop;
  const viewBottom = viewTop + el.tree.clientHeight;
  if (top < viewTop) el.tree.scrollTop = top;
  else if (bottom > viewBottom) el.tree.scrollTop = bottom - el.tree.clientHeight;
  renderSlice(true);
}

function moveSelection(delta) {
  if (state.rows.length === 0) return;
  let index = state.rows.findIndex((node) => node.tabId === state.selectedTabId);
  if (index === -1) index = 0;
  else index = Math.max(0, Math.min(state.rows.length - 1, index + delta));
  const node = state.rows[index];
  selectTab(node.tabId, { focus: true, scroll: true });
}

function toggleNode(node, collapsed) {
  if (!node.hasChildren) return;
  send('node.setCollapsed', { tabId: node.tabId, collapsed })
    .catch(fail);
}

async function activateNode(node) {
  state.selectedTabId = node.tabId;
  if (isExtension) {
    await send('tab.activate', { tabId: node.tabId }).catch(fail);
  } else {
    await mockAction('tab.activate', { tabId: node.tabId });
    render();
  }
}

async function closeNode(node, { subtree = false } = {}) {
  try {
    if (isExtension) await send('tab.close', { tabId: node.tabId, subtree });
    else await mockAction('tab.close', { tabId: node.tabId, subtree });
    if (state.selectedTabId === node.tabId) {
      const index = state.rows.findIndex((item) => item.tabId === node.tabId);
      const next = state.rows[index + 1] || state.rows[index - 1] || null;
      state.selectedTabId = next?.tabId ?? null;
    }
    if (!isExtension) render();
  } catch (error) {
    fail(error);
  }
}

function nodeOf(tabId) {
  return state.snapshot?.nodes.find((node) => node.tabId === tabId) || null;
}

/* -------------------------------------------------------------------------- */
/* Tree interactions                                                          */
/* -------------------------------------------------------------------------- */

el.tree.addEventListener('click', (event) => {
  if (Date.now() < state.suppressClickUntil) return;
  const row = event.target.closest('.row');
  if (!row) return;
  const node = nodeOf(Number(row.dataset.tabId));
  if (!node) return;
  const action = event.target.closest('[data-action]')?.dataset.action;
  if (action === 'toggle') {
    toggleNode(node, !node.collapsed);
    return;
  }
  if (action === 'close') {
    closeNode(node);
    return;
  }
  selectTab(node.tabId, { focus: true });
  activateNode(node);
});

el.tree.addEventListener('auxclick', (event) => {
  if (event.button !== 1) return;
  const row = event.target.closest('.row');
  if (!row) return;
  event.preventDefault();
  const node = nodeOf(Number(row.dataset.tabId));
  if (node) closeNode(node);
});

el.tree.addEventListener('contextmenu', (event) => {
  const row = event.target.closest('.row');
  if (!row) return;
  event.preventDefault();
  const node = nodeOf(Number(row.dataset.tabId));
  if (!node) return;
  selectTab(node.tabId, { focus: false });
  openMenu(node, event.clientX, event.clientY);
});

el.tree.addEventListener('focusin', () => {
  state.treeHasFocus = true;
});
el.tree.addEventListener('focusout', (event) => {
  if (!el.tree.contains(event.relatedTarget)) state.treeHasFocus = false;
});

el.tree.addEventListener('keydown', (event) => {
  const node = nodeOf(state.selectedTabId);
  if (!node && !['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return;
  switch (event.key) {
    case 'ArrowDown':
      event.preventDefault();
      moveSelection(1);
      break;
    case 'ArrowUp':
      event.preventDefault();
      moveSelection(-1);
      break;
    case 'Home':
      event.preventDefault();
      if (state.rows[0]) selectTab(state.rows[0].tabId, { focus: true, scroll: true });
      break;
    case 'End':
      event.preventDefault();
      if (state.rows.length) {
        selectTab(state.rows[state.rows.length - 1].tabId, { focus: true, scroll: true });
      }
      break;
    case 'ArrowRight': {
      event.preventDefault();
      if (!node) break;
      if (node.hasChildren && node.collapsed) {
        toggleNode(node, false);
      } else {
        const childId = node.childIds[0];
        if (childId) selectTab(childId, { focus: true, scroll: true });
      }
      break;
    }
    case 'ArrowLeft': {
      event.preventDefault();
      if (!node) break;
      if (node.hasChildren && !node.collapsed) {
        toggleNode(node, true);
      } else if (node.parentId !== null) {
        selectTab(node.parentId, { focus: true, scroll: true });
      }
      break;
    }
    case 'Enter':
    case ' ':
      event.preventDefault();
      if (node) activateNode(node);
      break;
    case 'Delete':
    case 'Backspace':
      event.preventDefault();
      if (node) closeNode(node);
      break;
    case 'Escape':
      if (state.query) {
        clearSearch();
      }
      break;
    case '/':
      event.preventDefault();
      el.search.focus();
      break;
    default:
      break;
  }
});

el.tree.addEventListener('scroll', () => {
  if (state.scrollRaf) return;
  state.scrollRaf = requestAnimationFrame(() => {
    state.scrollRaf = 0;
    renderSlice();
  });
});

/* -------------------------------------------------------------------------- */
/* Drag to reparent (pointer events, not HTML5 DnD)                           */
/* -------------------------------------------------------------------------- */

el.tree.addEventListener('pointerdown', (event) => {
  if (event.button !== 0) return;
  if (event.target.closest('button')) return;
  const row = event.target.closest('.row');
  if (!row) return;
  const tabId = Number(row.dataset.tabId);
  const node = nodeOf(tabId);
  if (!node) return;
  state.drag = {
    tabId,
    node,
    startX: event.clientX,
    startY: event.clientY,
    x: event.clientX,
    y: event.clientY,
    started: false,
    ghost: null,
    targetTabId: null,
    overRoot: false,
    pointerId: event.pointerId,
  };
  document.addEventListener('pointermove', onPointerMove, { passive: false });
  document.addEventListener('pointerup', onPointerUp, { once: true });
  document.addEventListener('pointercancel', onPointerUp, { once: true });
});

function onPointerMove(event) {
  const drag = state.drag;
  if (!drag) return;
  drag.x = event.clientX;
  drag.y = event.clientY;
  if (!drag.started) {
    if (Math.hypot(event.clientX - drag.startX, event.clientY - drag.startY) < 6) return;
    drag.started = true;
    drag.ghost = document.createElement('div');
    drag.ghost.className = 'drag-ghost';
    drag.ghost.textContent = drag.node.title;
    document.body.append(drag.ghost);
    rowFor(drag.tabId)?.classList.add('is-dragging');
    el.rootDrop.hidden = false;
    el.tree.style.cursor = 'grabbing';
  }

  drag.ghost.style.left = `${event.clientX + 12}px`;
  drag.ghost.style.top = `${event.clientY + 10}px`;

  const under = document.elementFromPoint(event.clientX, event.clientY);
  const row = under?.closest?.('.row') || null;
  const targetTabId = row && Number(row.dataset.tabId) !== drag.tabId ? Number(row.dataset.tabId) : null;

  const dropRect = el.rootDrop.getBoundingClientRect();
  const overRoot =
    (event.clientX >= dropRect.left &&
      event.clientX <= dropRect.right &&
      event.clientY >= dropRect.top &&
      event.clientY <= dropRect.bottom) ||
    (!row && Boolean(under && (under === el.tree || under === el.inner || under === el.empty)));

  if (drag.targetTabId !== targetTabId) {
    if (drag.targetTabId) rowFor(drag.targetTabId)?.classList.remove('drop-target');
    drag.targetTabId = targetTabId;
    if (targetTabId) rowFor(targetTabId)?.classList.add('drop-target');
  }
  drag.overRoot = overRoot;
  el.rootDrop.classList.toggle('is-over', overRoot);

  // Auto-scroll while dragging near the edges.
  const rect = el.tree.getBoundingClientRect();
  if (event.clientY < rect.top + 30) el.tree.scrollTop -= 10;
  else if (event.clientY > rect.bottom - 30) el.tree.scrollTop += 10;

  event.preventDefault();
}

async function onPointerUp() {
  document.removeEventListener('pointermove', onPointerMove);
  const drag = state.drag;
  state.drag = null;
  if (!drag) return;
  el.rootDrop.hidden = true;
  el.rootDrop.classList.remove('is-over');
  el.tree.style.cursor = '';
  drag.ghost?.remove();
  rowFor(drag.tabId)?.classList.remove('is-dragging');
  if (drag.targetTabId) rowFor(drag.targetTabId)?.classList.remove('drop-target');
  if (!drag.started) return;

  state.suppressClickUntil = Date.now() + 300;
  if (drag.targetTabId !== null) {
    await reparentTo(drag.tabId, drag.targetTabId);
  } else if (drag.overRoot) {
    await reparentTo(drag.tabId, null);
  }
}

async function reparentTo(tabId, parentTabId) {
  if (parentTabId === tabId) return;
  try {
    if (isExtension) await send('node.reparent', { tabId, parentTabId });
    else await mockAction('node.reparent', { tabId, parentTabId });
    state.selectedTabId = tabId;
    if (!isExtension) render();
  } catch (error) {
    fail(error);
  }
}

/* -------------------------------------------------------------------------- */
/* Context menu                                                               */
/* -------------------------------------------------------------------------- */

function menuItem(label, { danger = false, shortcut = '', onClick, disabled = false }) {
  const button = document.createElement('button');
  button.type = 'button';
  button.className = `menu-item${danger ? ' danger' : ''}`;
  button.disabled = disabled;
  const text = document.createElement('span');
  text.textContent = label;
  button.append(text);
  if (shortcut) {
    const hint = document.createElement('span');
    hint.className = 'shortcut';
    hint.textContent = shortcut;
    button.append(hint);
  }
  button.addEventListener('click', () => {
    hideMenu();
    onClick();
  });
  return button;
}

function openMenu(node, x, y) {
  const items = [];
  items.push(menuItem(t('activate'), { shortcut: '↵', onClick: () => activateNode(node) }));
  if (node.hasChildren) {
    items.push(
      menuItem(node.collapsed ? t('expandSubtree') : t('collapseSubtree'), {
        shortcut: node.collapsed ? '→' : '←',
        onClick: () => toggleNode(node, !node.collapsed),
      }),
    );
  }
  if (node.parentId !== null) {
    items.push(
      menuItem(t('makeRoot'), {
        onClick: () => reparentTo(node.tabId, null),
      }),
    );
  }
  const sep = document.createElement('div');
  sep.className = 'menu-sep';
  items.push(sep);
  items.push(
    menuItem(t('close'), {
      danger: true,
      shortcut: 'Del',
      onClick: () => closeNode(node),
    }),
  );
  if (node.hasChildren) {
    items.push(
      menuItem(t('closeSubtree'), {
        danger: true,
        onClick: () => closeNode(node, { subtree: true }),
      }),
    );
  }
  el.menu.replaceChildren(...items);
  el.menu.hidden = false;
  const rect = el.menu.getBoundingClientRect();
  const left = Math.min(x, window.innerWidth - rect.width - 8);
  const top = Math.min(y, window.innerHeight - rect.height - 8);
  el.menu.style.left = `${Math.max(8, left)}px`;
  el.menu.style.top = `${Math.max(8, top)}px`;
  state.menuTabId = node.tabId;
}

function hideMenu() {
  el.menu.hidden = true;
  state.menuTabId = null;
}

document.addEventListener('pointerdown', (event) => {
  if (!el.menu.hidden && !el.menu.contains(event.target)) hideMenu();
  if (
    !el.settings.hidden &&
    !el.settings.contains(event.target) &&
    !el.btnSettings.contains(event.target)
  ) {
    toggleSettings(false);
  }
});

document.addEventListener('keydown', (event) => {
  if (event.key === 'Escape') {
    if (!el.menu.hidden) hideMenu();
    else if (!el.settings.hidden) toggleSettings(false);
    else if (document.activeElement === el.search) {
      clearSearch();
      el.tree.focus();
    }
  }
});

/* -------------------------------------------------------------------------- */
/* Toolbar                                                                    */
/* -------------------------------------------------------------------------- */

el.search.addEventListener('input', () => {
  state.query = el.search.value;
  el.searchClear.hidden = state.query.length === 0;
  state.lastRenderKey = '';
  render();
  if (state.rows[0]) {
    state.selectedTabId = state.rows[0].tabId;
  }
});

el.search.addEventListener('keydown', (event) => {
  if (event.key === 'Escape') {
    clearSearch();
    el.tree.focus();
  } else if (event.key === 'ArrowDown') {
    event.preventDefault();
    if (state.rows[0]) {
      selectTab(state.rows[0].tabId, { focus: true, scroll: true });
    }
  } else if (event.key === 'Enter') {
    const first = state.rows[0];
    if (first) activateNode(first);
  }
});

el.searchClear.addEventListener('click', () => {
  clearSearch();
  el.search.focus();
});

function clearSearch() {
  state.query = '';
  el.search.value = '';
  el.searchClear.hidden = true;
  state.lastRenderKey = '';
  render();
}

document.addEventListener('keydown', (event) => {
  if (event.key === '/' && document.activeElement !== el.search) {
    event.preventDefault();
    el.search.focus();
  }
});

el.btnCollapse.addEventListener('click', async () => {
  const collapse = el.btnCollapse.dataset.mode !== 'expand';
  try {
    if (isExtension) await send('tree.setAllCollapsed', { collapsed: collapse });
    else await mockAction('tree.setAllCollapsed', { collapsed: collapse });
  } catch (error) {
    fail(error);
  }
});

el.btnSort.addEventListener('click', async () => {
  try {
    if (isExtension) {
      const result = await send('tree.reorderNative', { windowId: state.windowId });
      showToast(`${t('sortTabs')} · ${result.moved ?? 0}`);
    } else {
      showToast(`${t('sortTabs')} · demo`);
    }
  } catch (error) {
    fail(error);
  }
});

el.btnRebuild.addEventListener('click', () => {
  if (isExtension) send('tree.rebuild').catch(fail);
  else showToast('Demo mode');
  toggleSettings(false);
});

el.windowSelect.addEventListener('change', () => {
  state.manualWindowId = Number(el.windowSelect.value);
  state.windowId = state.manualWindowId;
  state.lastRenderKey = '';
  render();
});

function toggleSettings(open) {
  const next = typeof open === 'boolean' ? open : el.settings.hidden;
  el.settings.hidden = !next;
  el.btnSettings.setAttribute('aria-expanded', String(next));
  if (next) {
    const rect = el.btnSettings.getBoundingClientRect();
    const width = 262;
    el.settings.style.top = `${rect.bottom + 6}px`;
    el.settings.style.left = `${Math.max(8, Math.min(rect.right - width, window.innerWidth - width - 8))}px`;
  }
}

el.btnSettings.addEventListener('click', () => toggleSettings());

el.prefCloseChildren.addEventListener('change', () => {
  const next = { ...state.prefs, closeChildrenWithParent: el.prefCloseChildren.checked };
  state.prefs = next;
  if (isExtension) send('prefs.set', { prefs: { closeChildrenWithParent: next.closeChildrenWithParent } }).catch(fail);
  else {
    state.demo.prefs = next;
    mockAction('prefs.set', { prefs: next });
  }
});

el.prefAutoSort.addEventListener('change', () => {
  const next = { ...state.prefs, autoSortNative: el.prefAutoSort.checked };
  state.prefs = next;
  if (isExtension) send('prefs.set', { prefs: { autoSortNative: next.autoSortNative } }).catch(fail);
  else {
    state.demo.prefs = next;
    mockAction('prefs.set', { prefs: next });
  }
});

/* -------------------------------------------------------------------------- */
/* Demo mode (no chrome.*): used by screenshots and design review             */
/* -------------------------------------------------------------------------- */

function initDemo() {
  state.demo = true;
  const tabs = [
    { id: 101, windowId: 1, index: 0, title: 'chrome.sidePanel API — Chrome for Developers', url: 'https://developer.chrome.com/docs/extensions/reference/api/sidePanel', active: false, pinned: false },
    { id: 102, windowId: 1, index: 1, openerTabId: 101, title: 'Designing a side panel experience', url: 'https://developer.chrome.com/docs/extensions/develop/ui/side-panel', active: false },
    { id: 103, windowId: 1, index: 2, openerTabId: 102, title: 'SidePanelOptions reference', url: 'https://developer.chrome.com/docs/extensions/reference/api/sidePanel#type-SidePanelOptions', active: false },
    { id: 104, windowId: 1, index: 3, openerTabId: 101, title: 'chrome.tabs API — Tab.openerTabId', url: 'https://developer.chrome.com/docs/extensions/reference/api/tabs', active: true },
    { id: 105, windowId: 1, index: 4, title: 'Tree Style Tab — Firefox Add-ons', url: 'https://addons.mozilla.org/firefox/addon/tree-style-tab/', active: false, pinned: true },
    { id: 106, windowId: 1, index: 5, openerTabId: 105, title: 'piroor/treestyletab: Tabs as a tree in Firefox', url: 'https://github.com/piroor/treestyletab', active: false },
    { id: 107, windowId: 1, index: 6, openerTabId: 106, title: 'Tree Style Tab wiki — Session restore', url: 'https://github.com/piroor/treestyletab/wiki', active: false },
    { id: 108, windowId: 1, index: 7, title: 'Arc browser — Tabs, spaces and profiles', url: 'https://arc.net/', active: false },
    { id: 201, windowId: 2, index: 0, title: 'MDN — WebExtensions sidebar_action', url: 'https://developer.mozilla.org/en-US/docs/Mozilla/Add-ons/WebExtensions/manifest.json/sidebar_action', active: true },
    { id: 202, windowId: 2, index: 1, openerTabId: 201, title: 'Sidebery — Firefox extension', url: 'https://github.com/mbnuqw/sidebery', active: false },
  ];
  state.demo = {
    tabs,
    overrides: new Map(),
    collapsed: new Set([105]),
    inferred: new Set([107]),
    prefs: { ...DEFAULT_PREFS },
    focusedWindowId: 1,
  };
  const snapshot = buildSnapshot({
    tabs,
    collapsed: state.demo.collapsed,
    inferred: state.demo.inferred,
    prefs: state.demo.prefs,
    focusedWindowId: 1,
  });
  snapshot.restore = {
    appliedAt: Date.now() - 120000,
    stats: { oldNodes: 10, newTabs: 10, matchedTabs: 9, relations: 6, windows: 2, savedAt: Date.now() - 86400000 },
  };
  state.demo.snapshot = snapshot;
  setSnapshot(snapshot);
  setInterval(() => {
    // Keep the relative "restored" label stable in screenshots.
  }, 60000);
}

function rebuildDemoSnapshot() {
  const demo = state.demo;
  const activeTabId = demo.tabs.find((tab) => tab.active)?.id ?? demo.tabs[0]?.id ?? null;
  const snapshot = buildSnapshot({
    tabs: demo.tabs,
    overrides: demo.overrides,
    collapsed: demo.collapsed,
    inferred: demo.inferred,
    prefs: demo.prefs,
    focusedWindowId: demo.focusedWindowId,
  });
  snapshot.restore = demo.snapshot?.restore || null;
  demo.snapshot = snapshot;
  setSnapshot(snapshot);
  el.prefCloseChildren.checked = Boolean(demo.prefs.closeChildrenWithParent);
  el.prefAutoSort.checked = Boolean(demo.prefs.autoSortNative);
  return activeTabId;
}

async function mockAction(type, payload = {}) {
  const demo = state.demo;
  if (!demo) return {};
  const nodes = demo.snapshot?.nodes || [];
  switch (type) {
    case 'tree.getSnapshot':
      setSnapshot(demo.snapshot);
      return {};
    case 'tab.activate': {
      for (const tab of demo.tabs) tab.active = tab.id === payload.tabId;
      const target = demo.tabs.find((tab) => tab.id === payload.tabId);
      if (target) {
        demo.focusedWindowId = target.windowId;
      }
      rebuildDemoSnapshot();
      return {};
    }
    case 'tab.close': {
      const node = nodes.find((item) => item.tabId === payload.tabId);
      const ids = new Set([payload.tabId]);
      if (payload.subtree && node) {
        const collect = (tabId) => {
          for (const child of nodes.filter((item) => item.parentId === tabId)) {
            ids.add(child.tabId);
            collect(child.tabId);
          }
        };
        collect(payload.tabId);
      }
      demo.tabs = demo.tabs.filter((tab) => !ids.has(tab.id));
      for (const id of ids) {
        demo.overrides.delete(id);
        demo.collapsed.delete(id);
        demo.inferred.delete(id);
      }
      if (demo.tabs.every((tab) => !tab.active)) {
        const first = demo.tabs.find((tab) => tab.windowId === demo.focusedWindowId) || demo.tabs[0];
        if (first) first.active = true;
      }
      rebuildDemoSnapshot();
      return {};
    }
    case 'node.setCollapsed': {
      if (payload.collapsed) demo.collapsed.add(payload.tabId);
      else demo.collapsed.delete(payload.tabId);
      rebuildDemoSnapshot();
      return {};
    }
    case 'tree.setAllCollapsed': {
      if (payload.collapsed) {
        for (const node of nodes) if (node.hasChildren) demo.collapsed.add(node.tabId);
      } else {
        demo.collapsed.clear();
      }
      rebuildDemoSnapshot();
      return {};
    }
    case 'node.reparent': {
      demo.overrides.set(payload.tabId, payload.parentTabId ?? null);
      demo.inferred.delete(payload.tabId);
      rebuildDemoSnapshot();
      return {};
    }
    case 'prefs.set': {
      demo.prefs = { ...demo.prefs, ...payload.prefs };
      rebuildDemoSnapshot();
      return { prefs: demo.prefs };
    }
    case 'tree.reorderNative':
      return { moved: 0 };
    case 'tree.rebuild':
      rebuildDemoSnapshot();
      return {};
    default:
      return {};
  }
}

/* -------------------------------------------------------------------------- */
/* Boot                                                                       */
/* -------------------------------------------------------------------------- */

applyI18n();
updatePrefControls();
if (isExtension) {
  connect();
  el.tree.focus();
} else {
  initDemo();
}
