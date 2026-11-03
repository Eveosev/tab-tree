# Tab Tree — 设计说明（中文）

版本 0.1.3 · Chrome 114+ · Manifest V3 · 零构建（原生 ES Modules）

## 1. 需求与目标

- 从网页 **A** 里点击链接打开的新标签页，必须成为 **A 的子节点**，在左侧/侧边面板中缩进一级。
- 从地址栏、Ctrl/Cmd+T、书签独立打开的标签页，与 A **平级**（根节点）。
- 支持任意层级：A → B → C → …
- 在 MV3 Service Worker 被终止、浏览器重启后尽力恢复树结构。
- 权限最小化、纯本地、无远程代码。

**非目标：** 改造 Chrome 原生标签栏（Chrome 不提供能力）、云同步、多人协作、Firefox 移植。

## 2. 关键难点：`openerTabId` 是瞬时值

Chrome 的 `chrome.tabs.Tab.openerTabId` 看起来正是“谁打开了我”，但 Chromium 在
`tab_strip_model.cc` 的 `InsertTabAtImpl()` 中，只要有一个新的**前台**标签页插入，就会调用
`ForgetAllOpeners()` 清空**所有**标签页的 opener 关系。因此：

```
A 打开 B（前台）→ B.opener = A，树 A > B
A 再打开 C（前台）→ B.opener = null，C.opener = A
                  → 只依赖 openerTabId 会得到 A、B、C 三个根
```

0.1.0 正是因此失败（真实鼠标点击 E2E 只有 5/7 通过）。0.1.1 的修复是：
**在标签页创建的那一刻抓住关系，并持久化**。

## 3. 数据模型与父子判定优先级

```ts
type Edge = Map<number, number>;   // childTabId -> parentTabId（创建边）

resolve(tab):
  1. overrides 有值（用户拖拽 / 恢复快照）→ 用它（父必须存活、同窗口、非自身）
  2. edges 有值（创建时捕获）             → 用它（父必须存活、同窗口）
  3. tab.openerTabId（仍然存活）          → 用它
  4. 否则                                  → 根节点
```

- `edges` 存在 `chrome.storage.session`：Service Worker 重启后仍在，浏览器退出后清空。
- 关闭父节点时，直接把子节点提升一级（A > B > C 关闭 B ⇒ A > C），并写成新的 edge。
- `tabs.onReplaced`（预渲染替换）会把两个方向的 edge/override 迁移到新 tabId。
- 循环、跨窗口、自引用由纯函数引擎兜底。

## 4. 关系捕获的三个入口

| 入口 | 覆盖场景 |
| --- | --- |
| `webNavigation.onCreatedNavigationTarget` | 真实链接点击、Ctrl/Cmd+点击、中键、`window.open`，拿到 `{tabId, sourceTabId}` |
| `tabs.onCreated` | 创建事件里仍带 `openerTabId` 的情况，同步捕获 |
| 每次 `buildNow()` 的存活 opener 探测 | `chrome.tabs.create({openerTabId})` 等 onCreated 时尚未写入 opener 的路径 |

捕获后立即写 `storage.session`（不做 120 ms 防抖），避免“点完链接 worker 立刻被杀”丢关系。

## 5. 会话恢复

`tabId` 在浏览器重启后不稳定，Chrome 也不会保留 opener，所以用快照 + 匹配：

1. 每次结构变化 900 ms 防抖后，把 `{url, index, parentId, pinned}` 写入 `storage.local.restoreSnapshot`。
2. `storage.session` 里写 `sessionMarker`：它在浏览器重启时被清空，Worker 重启时保留。marker、`overrides`、`edges`、`collapsed`、`inferred` 必须通过 `lib/session-state.js` 一起读写；v0.1.2 漏读了 marker、漏存了 `inferred`，导致普通 Worker 唤醒被误判为浏览器重启并重放快照，产生假的 `restored` 徽标和页脚。
3. `init()` 只有在 **marker 缺失**（或 `runtime.onStartup` 触发）时才尝试恢复；普通 Worker 唤醒不会用旧快照覆盖当前树。
4. v0.1.2 去掉了“只要存在存活 opener 就跳过恢复”的判断：真实重启后 Chrome 可能额外恢复一个带 opener 的 `about:blank`，旧逻辑会导致整棵树无法恢复。v0.1.3 进一步规定：普通唤醒只从 `storage.local.restoreStats` 读取已有统计，绝不重新运行匹配；新浏览器会话开始时清除旧统计，避免页脚“说谎”。
5. 由于 Chrome **异步恢复标签页**，Service Worker 可能在标签出现之前就启动，因此恢复改为重试循环：`init()` 立即匹配并应用最佳的部分结果；标签创建/更新/关闭等事件触发 250 ms 防抖重试；每次用更优的匹配替换上一次结果；全部匹配或 15 秒窗口结束后落定并持久化统计。
6. 窗口按 URL 重叠度配对，窗口内标签按 `normalizedUrl + pinned` 做 LCS 对齐；两端都匹配才迁移父子关系，恢复出的关系打 `restored` 徽标。`inferred` 与 overrides 一起持久化，`init()`/`buildNow()` 会清理失效或已被拖拽覆盖的标记，避免陈旧徽标。
7. 仍有局限：重复 URL、关闭窗口、极端重排可能匹配错误；可以拖拽修正。

## 6. 侧边栏与交互

- Chrome 114+ 的 `chrome.sidePanel`，面板跟随**自己所在的窗口**（`chrome.windows.getCurrent()`），而不是跟随当前焦点窗口。
- 16 px/级缩进 + 垂直引导线；折叠/展开整棵子树；搜索保留匹配项祖先并自动展开。
- 键盘：↑/↓、Home/End、← 折叠或跳到父、→ 展开或跳到第一个子、Enter 激活、Delete 关闭、`/` 搜索。
- 拖拽：拖到某一行成为其子节点，拖到空白区域成为根；拖拽结果作为 `override` 优先于自动关系。
- 工具栏“按树排序”可以把原生标签栏按 DFS 顺序重排；置顶标签仍在最前。

## 7. 权限

| 权限 | 用途 |
| --- | --- |
| `tabs` | 读取标题/URL/opener/index，激活、关闭、移动标签 |
| `sidePanel` | 承载侧边栏 |
| `storage` | 本地保存偏好、创建边、折叠状态、恢复快照 |
| `webNavigation` | 只使用 `onCreatedNavigationTarget` 捕获“谁打开了谁”，不读取页面内容或历史 |

没有 `<all_urls>`、没有内容脚本、没有扩展发起的网络请求；favicon 由 Chrome 自己加载。
安装时 Chrome 显示的仍然是正常的“读取您的浏览记录”提示。

## 8. 验证结果（0.1.3）

| 命令 | 结果 |
| --- | --- |
| `npm run check` | 21 个文件、manifest 0.1.3、37/37 i18n、无 `<all_urls>`、真实远程代码扫描 |
| `npm test` | **41/41**：35 个引擎用例 + 6 个 session-state 编解码用例 |
| `npm run smoke` | **44/44**（真实 Chrome for Testing；含空闲回收 Worker 后“唤醒不重放恢复”回归） |
| `npm run test:e2e` | **8/8** 真实鼠标点击：A→B、A→C、B→D、Cmd/Ctrl+点击子级、无 opener 根、关闭中间父节点提升子级、面板缩进 |
| `npm run test:panel` | **11/11** 真实指针拖拽：根→子、子→顶层、循环拒绝 toast；第二个窗口的面板绑定自己的窗口 |
| `npm run test:restart` | **19/19** 两个真实 Chrome 进程：快照落盘、会话存储清空、A→B→C 以 `restored` 徽标恢复；恢复后再空闲回收 Worker，徽标/页脚保持且匹配器不重跑 |
| `npm run bench` | **8/8**：300 标签重建 p95 14.4 ms、滚动 34.2 ms、搜索 31.4 ms；500 标签 p95 20.6 ms（见 verification.md） |
| `npm run build` | `dist/tab-tree-v0.1.3.zip`，17 文件（含新增 `lib/session-state.js`），sha256 见 verification.md |
| CI | GitHub Actions 跑 check/test/build |

**已知限制：** 侧边栏在左还是在右由 Chrome 设置决定（`chrome://settings/appearance`），扩展无法强制；恢复仍是启发式，重复 URL 可能匹配错，可拖拽修正。

## 9. 关键文件

| 文件 | 作用 |
| --- | --- |
| `extension/manifest.json` | MV3 清单与权限 |
| `extension/background.js` | 事件、edge 捕获、构建循环、持久化、消息协议 |
| `extension/lib/tree-engine.js` | 纯树算法（父子判定、DFS、恢复匹配、升降级） |
| `extension/sidepanel.js` | 虚拟列表、拖拽、键盘、搜索、设置 |
| `test/tree-engine.test.js` | 35 个引擎单测 |
| `scripts/e2e-real-links.mjs` | 真实点击验收测试 |
| `scripts/e2e-panel.mjs` | 真实指针拖拽 + 多窗口面板绑定 |
| `scripts/e2e-restart.mjs` | 真实浏览器重启恢复 |
| `scripts/bench-tabs.mjs` | 300/500 标签性能基准 |
| `scripts/smoke.mjs` | 真实浏览器冒烟测试（面板 DOM、折叠、关闭、Worker 重启） |
| `docs/design.md` | 完整英文技术设计 |
| `docs/research.md` | 竞品与决策调研 |
