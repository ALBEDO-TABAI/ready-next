---
title: UI 巨文件拆分施工计划 — documentActions / FileTree / AgentSystemStudio / CalendarMode（交 Codex 执行）
date: 2026-07-06
status: ready-to-execute
executor: codex
source:
  - docs/superpowers/plans/2026-07-03-agent-mainline-p3-route.md Phase B（UI 巨文件审查报告，2026-07-06）
  - 先例：Settings.tsx 3486→878 / useAgent.ts 2983→2091 的拆分方法与教训（route §5.1.x）
---

# 0. 总纲（先读完再动手）

## 0.1 唯一目标与硬边界

**纯移动，零行为变化。** 每一刀只做「把代码搬到新文件 + 原文件保门面 re-export」，不顺手改逻辑、不重命名、不改注释、不调整参数、不「优化」。发现真 bug 记下来单独报，不在拆分提交里修。

## 0.2 四项全程纪律

1. **每缝一提交**：一个函数族/一个组件 = 一次 pathspec 提交（`git add -- <明确路径>`），提交信息写清搬了什么、从哪到哪、验证结果。
2. **真实退出码**：所有验证命令用 `<cmd> > /tmp/x.log 2>&1; echo EXIT=$?` 取真实退出码。**禁止** `cmd | tail && echo ok`（管道退出码恒 0，本仓有血泪记忆）。
3. **每步验收**（每次提交前全绿）：
   ```bash
   npm run typecheck > /tmp/tc.log 2>&1; echo EXIT=$?
   node scripts/check-silent-catch.cjs > /tmp/sc.log 2>&1; echo EXIT=$?
   npx tsx --test <本缝盯防测试文件列表> > /tmp/t.log 2>&1; echo EXIT=$?
   ```
4. **收官验收**：全部缝完成后跑 `npm run test`（全量，当前基线 **0 fail**，任何新增失败=本次拆分引入，必须归零才算完）+ `npx electron-vite build` EXIT=0。

## 0.3 两个必踩的 gate 暗雷（提前拆弹）

### 雷 A：silent-catch baseline 是 `file:snippetHash` 键
`scripts/check-silent-catch.cjs` 扫 `src/renderer`（含本次全部目标文件）。**把含 catch 的代码搬到新文件，baseline 条目立即失锚**（旧 file 变 stale、新 file 无覆盖，一次搬迁双报红）。已知受影响条目：

- `src/renderer/modules/agent/documentActions.ts` — **8 条**（行 181/224/421/1172/1323/1401/1525/1556）
- `src/renderer/pages/modes/CalendarMode.tsx` — 2 条（行 114/746）
- FileTree/AgentSystemStudio — baseline 0 条，但源码内有 `// silent-catch: …` 注释（随代码搬走即可，无需处理）

**重锚方法（禁止 `--update` 整表重录）**——搬迁提交内同步执行：
```bash
node -e '
const { checkSilentCatch } = require("./scripts/check-silent-catch.cjs");
const fs = require("fs");
const p = "scripts/snapshots/silent-catch-baseline.json";
const b = JSON.parse(fs.readFileSync(p, "utf8"));
const hashes = new Set(b.entries.map(e => e.snippetHash));
const { violations } = checkSilentCatch({ root: process.cwd() });
// 只接受 relocated（hash 已在 baseline=内容未变仅换文件）；novel 一律人工看
const novel = violations.filter(v => !hashes.has(v.snippetHash));
if (novel.length) { console.error("存在 novel 违规，禁止自动重锚：", novel); process.exit(1); }
const curKeys = new Set(checkSilentCatch({root:process.cwd()}).baselineEntries.map(e=>`${e.file}:${e.snippetHash}`));
const live = b.entries.filter(e => {
  const scan = require("./scripts/check-silent-catch.cjs").scanSilentCatches({root:process.cwd()});
  return scan.some(s => s.file===e.file && s.snippetHash===e.snippetHash);
});
const added = new Map();
for (const v of violations) { const k=`${v.file}:${v.snippetHash}`; if(!added.has(k)) added.set(k,{file:v.file,line:v.line,snippetHash:v.snippetHash}); }
b.entries = [...live, ...added.values()];
fs.writeFileSync(p, JSON.stringify(b, null, 2) + "\n");
console.log("re-anchored:", added.size, "stale removed:", 0);
' 
node scripts/check-silent-catch.cjs; echo EXIT=$?
```
判据：重锚后 gate EXIT=0，且 baseline 条目数**不增**（搬迁是 1:1 换 file 字段；若增了说明搬迁中改了 catch 内容——回去检查是不是手滑改了代码）。

### 雷 B：源码 grep 合同按文件路径读目标文件
以下测试用正则断言目标文件的**源码内容**。纯移动会把被断言的代码搬走 → 合同红。处理方式二选一（优先 ①）：
① 断言的代码块**留在门面文件**不搬（如断言的是主组件体内的 wiring）；
② 搬走后把合同的 `readWorkspaceFile('…FileTree.tsx')` 改读新文件，断言正则**原样保留**（禁止改弱），并在改动行上注一行出处（"2026-07-06 拆分随迁"）。

| 目标文件 | 盯防合同 |
|---|---|
| FileTree.tsx | `file-tree-browser-tab-drop-contract` / `file-tree-delete-menu-contract` / `browser-tab-drag-reference-contract` / `hover-scrollbar-contract` / `settings-liquid-glass-contract` / `floating-submenu-style-contract` / `workbench-hot-path-transition-contract` |
| documentActions.ts | `document-active-snapshot` / `document-actions-precise-edit` / `document-widget-authoring-openui` / `module-executor-doc-action-payload` / `document-update-widget-patch` / `ui-contracts/document-widget-patch-target-resolution` / `ui-contracts/document-widget-authoring`（多为行为测试，纯移动+门面 re-export 应天然绿；先跑再说） |
| CalendarMode.tsx | `ui-fail-fast-contract` / `ui-mode-split-contract` / `ui-contracts/workbench-keep-alive-contract` / `panel-fusion-contract` / `ui-contracts/workbench-shell-alignment-contract` |
| AgentSystemStudio.tsx | （无直接 grep 合同） |

## 0.4 其他已踩过的坑（本仓实录）

- 本机 shell 是 zsh：**未加引号的变量不分词**，批量传参用 `xargs`。
- 测试是 tsx ESM：**没有 `__dirname`**，路径用 `resolve(process.cwd(), …)`。
- 脚本化改测试文件时，import 插入点要避开**多行 import 语句中间**（插在最后一个完整 import 之后）。
- 新样式规则落 `src/renderer/styles/` 对应领域文件，**不要回填 index.css**（2026-07-06 已拆成 @import 清单，导入顺序=级联合同，不许调序）。
- push 前显式 `git push origin main`（本地 main 上游错配 origin/codex/readyguy，裸 push 会推错）。
- 提交信息结尾带 Codex 自己的署名 trailer；不要伪造他人署名。

---

# 1. P1 — documentActions.ts（2344 行，无人值守可做，先做这个）

**位置**：`src/renderer/modules/agent/documentActions.ts`。纯逻辑模块（无 JSX），唯一 renderer 消费方 `src/renderer/stores/useAgent.ts`；另有 main 侧经工具链间接依赖其行为（不 import 文件本身）。行为测试密集（见 0.3 表），是最安全也最先做的一刀。

**落位**：新目录 `src/renderer/modules/agent/document-actions/`，原文件保门面：`documentActions.ts` 只剩 `export * from './document-actions/…'`（**导出面零增减**，用 `git diff` 前后对比 `grep -c "^export"` 核对）。

**六个函数族缝（按行号，依赖少的先搬）**：

| 缝 | 内容（锚点行号，动手前重新 grep 校准） | 新文件 |
|---|---|---|
| S1 | 纯工具族：`raceWithTimeout`(66) / `normalizeContentForCompare`(147) / `hashContent`(154) / `findAllReplacementRanges`(279) / `joinPath` 类纯函数 | `document-actions/text-utils.ts` |
| S2 | Mermaid/视觉校验族：`collectMermaidBlocks`(222) / `mermaidSvgContainsSourceLeak`(233) / `validateMermaidPreviewRender`(237) / `buildVisualSyntaxRejection`(267) | `document-actions/visual-validation.ts` |
| S3 | widget 写锁与 pending 记忆族：`widgetWriteLocks`(76) / `pendingToolDocumentWrites`(78) / `remember/get/clearPendingToolDocumentWrite`(88-104) / `rememberToolTargetTab`(109) / `widgetWriteEpoch`(122) / `cancelPendingWidgetWritesForTab`(124) / `cancelAllPendingWidgetWrites`(128) / `emitWidgetCommitted`(134)。**注意**：这些是模块级单例状态（Map），**必须整族同文件搬**，不可拆散，否则出现双 Map 实例=真回归 | `document-actions/write-locks.ts` |
| S4 | 变更结果分类族：`classifyDocActionMutationOutcome`(301) / `describeWidgetSkip`(167) / `logWidgetSkip`(214) / `buildWidgetBoundaryRejection*`(275/292) / `classifyDocActionFailureReason`(2030) | `document-actions/mutation-classify.ts` |
| S5 | 文档目标解析族：`getActiveDocTab`(462) / `resolveDocTab`(467) / `getFreshRecentToolTargetTab`(482) / `buildActiveDocumentContext`(1519) / `getActiveDocumentSnapshot`(1557) / `extractDeclaredWidgetAspect`(361) / `assertAspectPreserved`(387) | `document-actions/target-resolve.ts` |
| S6 | 执行主体（剩余）：`replaceExactTextInDocument`(1296) / `mapToolActionToDocAction`(2042) / 各 action 执行器与 `DocActionPayload` 等共享类型 | `document-actions/execute.ts` + `document-actions/types.ts` |

**顺序**：S1→S2→S4（无状态，最安全）→S3（单例状态，整族）→S5→S6。每缝提交前跑 0.3 表 documentActions 行的 7 个测试 + 雷 A 重锚（本文件 8 条 baseline 会随搬迁失锚）。

**S3 特别断言**：搬完后 `grep -rn "widgetWriteLocks\|pendingToolDocumentWrites" src/renderer --include='*.ts'` 只允许出现在 `write-locks.ts` 一个实现文件里（其余都是 import）——防双实例。

---

# 2. P2 — FileTree.tsx（3738 行，叶组件逐抽）

**位置**：`src/renderer/components/layout/FileTree.tsx`。消费方：`FilesPanel.tsx`、`fileEmergenceViewModel.ts`（named exports：`isFileAllowed`/`DEFAULT_FILE_FILTERS`/类型）。默认导出 `FileTree` 主组件（1334 行起）。

**落位**：新目录 `src/renderer/components/layout/file-tree/`；`FileTree.tsx` 保留主组件 + re-export 全部既有 named exports（消费方 import 路径**不变**）。

**抽取顺序（叶→枝，每步一提交）**：

| 步 | 内容（行号锚） | 新文件 |
|---|---|---|
| T1 | 纯常量与判定：`ALLOWED_EXTENSIONS`(111) / 各 `*_EXTS`(129-134) / `FileKind/FileViewMode/FileFilterMap`(136-138) / `DEFAULT_FILE_FILTERS`(151) / `isFileAllowed`(174) / `getFileExt`(181) / `getParentDir`(186) / `getFileKind`(193) / `passesFilter`(206) / `formatSize`(210) | `file-tree/file-kinds.ts` |
| T2 | 图标族：`FileAppearanceColorDot`(217) / `CustomFileIcon`(245) / `fileIcon`(265) | `file-tree/file-icons.tsx` |
| T3 | 拖拽工具族：`hasNativeFileDrop`(303) / `putDragData`(307) / `readWorkspaceDragPayloads`(321) / `buildSelectedDragItemsByPath`(338) / `fileTreeDropTargetsEqual`(354) / `joinPath`(326) / `splitNameForCopy`(332)。**雷 B 高危区**：`browser-tab-drag-reference-contract` 与 `file-tree-browser-tab-drop-contract` 断言这些代码，随迁改读 `file-tree/drag-utils.ts` | `file-tree/drag-utils.ts` |
| T4 | 行内编辑组件：`InlineInput`(410) / `InlineCreateRow`(653) | `file-tree/inline-inputs.tsx` |
| T5 | pending 占位族：`PendingPlaceholderKind/Status`(845-853) / `isAnalysisPlaceholderKind`(854) / `isActiveAnalysisStatus`(858) / `clampProgress`(862) / `pendingPlaceholderLabel`(867) / `PendingClipRow`(908) / `PendingClipPlaceholder`(1086) / `FileTreeRSSAnalysisJob`(1106) / `mapAnalysisJobToPlaceholderPatch`(1116) / `isTrackedAnalysisPlaceholder`(1128) / `analysisPlaceholderTerminalDelay`(1132) / `buildAnalysisJobKey`(1138) | `file-tree/pending-placeholders.tsx` |
| T6 | 大件组件：`GridItemCard`(691)、`FileTreeItem`(447)、`FileTreeRecursive`(1147) | `file-tree/GridItemCard.tsx` / `file-tree/FileTreeItem.tsx` / `file-tree/FileTreeRecursive.tsx` |
| T7 | 浮层组件：`FileTreeExternalDropMenu`(3097) / `FileColorPalette`(3257) / `ContextMenuBridge`(3396) + 两个 MenuState interface(286/293) | `file-tree/floating-menus.tsx` |

主组件 `FileTree`（1334-3096）留原文件不动。**每步后跑** 0.3 表 FileTree 行的 7 个合同 + typecheck。T3/T6 若合同红，按雷 B ② 随迁读新文件、正则不改。

**收尾真机项（留用户）**：文件树增删拖拽/右键菜单/网格视图/剪藏占位行各走一遍——写进回测清单，Codex 不自验视觉。

---

# 3. P3 — AgentSystemStudio.tsx（1706 行，低风险）

**位置**：`src/renderer/components/agent-system/AgentSystemStudio.tsx`。唯一消费方 `AgentSettingsHub.tsx`。无 grep 合同盯防，最省心。

**落位**：`src/renderer/components/agent-system/studio/`。

| 步 | 内容 | 新文件 |
|---|---|---|
| A1 | 原子展示件：`Chip`(222) / `StatusBadge`(256) / `RouteStateText`(268) / `EmptyLine`(283) / `Section`(287) / `Field`(314) | `studio/primitives.tsx` |
| A2 | 列表/路由件：`RoutingActionChoice`(360) / `AgentListItem`(380) 及同型兄弟 | `studio/agent-list.tsx` |
| A3 | 主组件留守 + re-export | — |

验收：typecheck + `npx tsx --test $(ls src/__tests__/ | grep -i 'agent-system\|specialist' | sed 's|^|src/__tests__/|' | tr '\n' ' ')`（specialist/agent-system 族行为测试）。

---

# 4. P4 — CalendarMode.tsx（1394 行）：**本轮禁止盲切，只做探察**

单体组件、零现成顶层缝（除 default export 外无独立函数）。盲拆必碰 hook 依赖与闭包状态，白屏高危。Codex 本轮只做**探察产出**，不改代码：

1. 列出组件内全部 `useState/useRef/useEffect/useMemo/useCallback` 及相互依赖（哪些状态被哪些回调闭包捕获）。
2. 识别候选缝：日历网格渲染 / 助手抽屉（`calendar-assistant-*` 合同盯防区）/ 事件编辑浮层，各自依赖多少共享状态。
3. 产出 `docs/superpowers/plans/2026-07-06-calendar-mode-split-survey.md`：缝图 + 每缝需要提升为 props/context 的状态清单 + 风险评级。**拆分实施等下一轮人在场会话**。

---

# 5. 收官清单

- [ ] P1 六缝 + P2 七步 + P3 两步各自独立提交，全部通过 0.2/0.3 验收；
- [ ] `npm run test` 全量 0 fail（基线就是 0，见 2026-07-05 关账）；`npx electron-vite build` EXIT=0；
- [ ] silent-catch baseline 条目数与拆分前一致（只换 file 字段）；
- [ ] 原三个文件行数：documentActions ≤300（门面）/ FileTree ≤1900（主组件+门面）/ AgentSystemStudio ≤1100；
- [ ] P4 探察文档产出；
- [ ] 在本文档末尾追加「施工记录」段：每缝的提交 hash + 验证 EXIT 值；
- [ ] 真机走查项（文件树交互全套 / 文档 widget 写入链 / agent studio 面板）追加进 `2026-07-05-user-retest-checklist.md` C 段，留用户执行。

## 6. 施工记录（Codex，2026-07-06）

### P1 documentActions

- 提交：`58f1331d refactor(ui): split document actions module`
- 落地：`documentActions.ts` 改为 30 行门面；实现拆到 `document-actions/types.ts` / `text-utils.ts` / `visual-validation.ts` / `mutation-classify.ts` / `write-locks.ts` / `target-resolve.ts` / `execute.ts`。
- silent-catch：8 条旧 hash 迁移到新文件，baseline 条目数 `355 -> 355`。
- 验证：`npm run typecheck` EXIT=0；`node scripts/check-silent-catch.cjs` EXIT=0；documentActions 7 个盯防测试 EXIT=0。

### P2 FileTree

- 提交：`2cebd56a refactor(ui): split file tree components`
- 补提交：`c3dc93bb refactor(ui): trim file tree facade imports`
- 落地：`FileTree.tsx` 保留主状态/调度和公开门面；叶组件与 helper 拆到 `file-tree/`。
- grep 合同：`file-tree-browser-tab-drop-contract` / `file-tree-delete-menu-contract` / `floating-submenu-style-contract` 按 2026-07-06 拆分随迁到新实现文件，断言正则未放松。
- 验证：`npm run typecheck` EXIT=0；`node scripts/check-silent-catch.cjs` EXIT=0；FileTree 7 个盯防合同 EXIT=0。

### P3 AgentSystemStudio

- 提交：`92a71706 refactor(ui): split agent system studio`
- 落地：`AgentSystemStudio.tsx` 改为 1 行门面；主实现移到 `studio/AgentSystemStudioView.tsx`，展示小件拆到 `studio/primitives.tsx`，列表/路由选择拆到 `studio/agent-list.tsx`。
- gate 同步：`check-specialist-studio-readonly.cjs` 改读 Settings -> AgentSettingsHub -> AgentSystemStudioView 的当前真实链路。
- 验证：`npm run typecheck` EXIT=0；agent-system/specialist 测试族 EXIT=0；`node scripts/check-specialist-studio-readonly.cjs` EXIT=0；对应 gate 单测 EXIT=0；`node scripts/check-silent-catch.cjs` EXIT=0。

### P4 CalendarMode

- 提交：`38c48a03 docs(ui): survey calendar mode split seams`
- 落地：未拆 `CalendarMode.tsx`；新增 `docs/superpowers/plans/2026-07-06-calendar-mode-split-survey.md`，列出 hook 依赖、候选缝、需要提升的状态和风险评级。
- 回测清单：`docs/superpowers/plans/2026-07-05-user-retest-checklist.md` C 段新增文件树 / 文档 widget / Agent 系统面板真机走查项。

### 最终收官

- `npm run test` EXIT=0。
- `npx electron-vite build` EXIT=0。
- `node scripts/check-silent-catch.cjs` EXIT=0，baseline 条目数 `355`。
- 入口行数：`documentActions.ts` 30；`FileTree.tsx` 1860；`AgentSystemStudio.tsx` 1；`CalendarMode.tsx` 1394（本轮按计划只探察不拆）。
