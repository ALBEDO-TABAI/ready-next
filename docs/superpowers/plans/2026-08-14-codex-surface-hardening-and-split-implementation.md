---
title: Codex 工作面硬化与手术式拆分
date: 2026-08-14
status: approved-for-planning
review_status: pending
enforce: true
depends_on:
  - docs/architecture/current-runtime-contracts.md
  - docs/superpowers/plans/2026-08-13-codex-capability-relight-index.md
  - docs/superpowers/plans/2026-08-13-codex-workbench-surface-rewire-implementation.md
  - docs/superpowers/plans/2026-08-14-codex-browser-kernel-fit-implementation.md
note: >
  在 08-13 工作面重接线与 08-14 Browser 实施切片已提交之后，审查剩余产品缺口、
  多事件结算漏网和可验证的文件拆分。不复活第二套模型循环，不恢复巨型
  后继页签内核，不为拆分而拆分。
---

# Codex 工作面硬化与手术式拆分

## 0. 本计划何时算完成

本计划只定义实现合同。完成必须同时满足：

1. 任一多事件输入手势（完整按键、点击三连、拖拽、清空焦点、连续滚动）在首个物理事件已发出后，不得再被结算成零执行。
2. 冻结页面身份是显式参数，不是进程级可变全局；并发或嵌套工具不得互相覆盖预期代次。
3. `browser-act-tools.ts` 按动作族拆成可独立验证的叶子，公开入口仍只有 `executeBrowserActTool`。
4. 08-14 计划里仍未做的下载消费者、因果后继页签和真实 BrowserView 门，要么在本计划工单落地，要么写成明确接受项并给出复查条件。不得用“切片未完成”无限期悬空。
5. 命名门覆盖本计划新增反例；`skip` 不算通过。独立对抗审查 P0/P1 清零后，才允许把状态改为 `completed`。

## 1. 审查立场

生产主链不变：

```text
CodexHostOrchestrator
  → Codex ingress / product composition
  → ReadyCodexLifecycleAdapter
  → canonical closeout / projection
```

第一性原理只保留四条：

1. 模型只做语义判断。页面身份、发送许可、部分生效、重试和收口必须由代码承担。
2. 已经发生的物理效果不能被后一次核对改写成“什么都没发生”。否则上层会重试，造成重复提交或重复滚动。
3. 精确目标是「这个物理页签上的这一代主文档」，不是 tab id，也不是“当前活动页”。
4. 拆文件只在职责已分离、变更节奏不同、且能保持单一公开入口时才做。禁止借拆分改行为或加兼容层。

明确不做：

- 不引入第二 Browser Agent、Playwright、`use_browser`、同轮扩权或公开续跑。
- 不在因果后继权威完成前暴露混合 `browser_tabs`。
- 不把 Electron 副作用写进 SQLite 事务。
- 不把 `codex-binding-repository.ts`（7324 行）或整份 production composition 在本轮做大卸八块。
- 不把下载、后继页签和文件拆分捆成一个发布步骤。

## 2. 当前事实

基线提交：`43a79a37` `feat(agent): wire Codex workbench surfaces and bind browser pages`，分支 `codex/cod-ready`。

已成立、本计划不再重做：

- 工作面资源与产品动作桥：日历/RSS/Widget/Tag Forge 走冻结工具面和 `requestModuleToolAction`。
- 执行钉死 `trustedPageRef`；observe 才在返回前核对；mutate 成功换页不得改写成引用失效。
- 观察正文在身份核对通过后才写入 journal。
- 鼠标、文字、独立按键在最终发送前共用 `trustedInputPageDenied`。
- `sendKeyStroke` 与 `collect_scroll` 已按已发送次数结算部分生效。
- 失败关闭走 `commitCodexFailureCoreCloseoutAndReconcileClaims`，可清掉仍活跃的动作。

仍未完成、继承自 08-14：

| 缺口 | 代码事实 | 产品后果 |
| --- | --- | --- |
| 下载消费者 | `codex-tool-surface.ts` 仍整名排除 `browser_download` | 模型不能下文件；当前安全但不完整 |
| 因果后继页签 | 模型 `browser_tabs` 隐藏；`tabs_open` 仍在 act 分派器里 | 自然弹出的新页签同轮无法继续操作 |
| 真实 BrowserView 门 | 没有 `verify:codex-browserview-fixture` | 换页后禁输入、隐藏指针、session 下载只靠替身 |

本轮新发现的漏网：

| 漏网 | 证据 | 为何会错 |
| --- | --- | --- |
| 点击三连不是一个结算单位 | `dispatchClickAt` 连续 `mouseMoved/Pressed/Released`，每下独立核对 | 链接在 mousedown 就导航时，已按下却可能被报成零执行 |
| 拖拽中途换页 | `browser-act-tools.ts` 拖拽循环逐次 `dispatchTrustedPointer`；最后一次 `mouseReleased` 未显式传入 expected | 依赖模块全局 bind；中途跳转没有 dispatched 计数 |
| 清空焦点是四次按键 | `clearFocusedInput` 直接连发 select-all / Backspace | 与修复前的 Enter 同类：第一下已发出，后续拒绝会像没发生 |
| 预期身份是进程全局 | `boundTrustedPointerExpected` 在 `browser-input-actions.ts` | 嵌套或并发工具会覆盖别人的冻结代次 |
| 上传走控制器直写 | `setFileInputFiles` 不经过 `trustedInputPageDenied` | 换页后仍可能把文件赋给新文档的 input |
| `BrowserAgentRuntimeAdapter` | observe 路径可绕过工具层发送前核对 | 只要有人从 adapter 发键/鼠标，身份闸失效 |

危险大体量（拆分候选，不是本轮必须改行为）：

| 文件 | 行数 | 真实混杂 |
| --- | --- | --- |
| `browser-act-tools.ts` | 2592 | 一个 switch 同时装导航、搜索、点击、输入、上传、滚动 |
| `browser-input-actions.ts` | 1505 | 坐标解析、可信发送、按键合成、打字后回读 |
| `tool-executor.ts` | 1365 | 全产品域分派 |
| `codex-runtime-production-composition.ts` | 3224 | 已迁出 ingress/授权/closeout，仍是单一 factory 闭包 |
| `useAgent.ts` | 1999 | 发送已迁出，监听与生命周期仍在 |
| `codex-binding-repository.ts` | 7324 | 本计划不拆 |

## 3. 工单

### H1 — 多事件手势的统一部分结算

把 `sendKeyStroke` 里“计数 + 首发后改写为 mayHaveCommitted”抽成单一 helper，例如 `runTrustedInputSequence`。所有多事件手势必须经过它：

- `dispatchClickAt` 的三次鼠标
- 拖拽的 press / move / release
- `clearFocusedInput` 的四次按键
- 已有的 `sendKeyStroke` 与 `collect_scroll` 改为调用同一 helper

合同：

1. 序列开始前核冻结文档。未发出任何事件就换页 → `dispatch=rejected`、`delivery=not_delivered`、`mayHaveCommitted=false`。
2. 至少一个事件已发出后被拦住 → `dispatch=accepted`、`delivery=unknown`、`effect=unknown`、`mayHaveCommitted=true`、`needsObservation=true`，并带已发送次数。
3. 已发出后不得再向新文档补发后续事件。
4. 拖拽最后一次 `mouseReleased` 必须显式携带同一 expected，不得只靠全局 bind。

测试（接入 `verify:codex-workbench-surface`）：

- 点击：`mousePressed` 后文档变 v2，`mouseReleased` 不发；结果 `dispatchedPointers=2` 且 `mayHaveCommitted=true`。
- 拖拽：第一次 move 后换页，后续事件为 0，结算同上。
- 清空焦点：select-all 已发、Backspace 被拦，不得报零执行。
- 回归：发送前已是 v2 的 click/type/press_key/collect 仍是 0 次发送。

### H2 — 去掉进程全局预期身份

`bindTrustedPointerExpected` 只是为了给不能接收 ctx 的底层函数传代次。它现在是模块级变量，嵌套 `executeBrowserActTool`（如 `fill_form` → 再次进入）会覆盖外层 expected。

合同：

1. `TrustedPointerExpectedIdentity` 随调用栈显式传递：`dispatchClickAt` / `runGuardedCoordinateClick` / `runGuardedCoordinateType` / `clearFocusedInput` / `sendKeyStroke` 增加 optional expected 参数。
2. `executeBrowserActTool` 把 `trustedPageRef` 传进去，不再依赖 finally 里恢复的全局槽。
3. 删除或降为测试专用的模块全局 bind；生产路径零读写该槽。
4. 行为测试：外层 hover 绑定 v1 时，内层 fill 绑定 v2 不得把外层后续事件改到 v2；反之亦然。

### H3 — 上传与 adapter 的同一发送闸

1. `setFileInputFiles` 前调用 `trustedInputPageDenied`；换页则拒绝且 `mayHaveCommitted=false`（文件尚未赋上）。
2. 若底层赋值已发生、随后 readback 发现文档代次变了，记 `mayHaveCommitted=true`，不得报成未赋值。
3. `BrowserAgentRuntimeAdapter.dispatchMouse/dispatchKey/typeTextDirectly` 若仍被 observe 以外的生产路径调用，必须改走 `dispatchTrusted*`。若已无生产调用方，测试锁定 adapter 不得作为写入口。

### H4 — `browser-act-tools.ts` 手术式拆分

保持 `executeBrowserActTool` 为唯一公开分派器。按动作族下沉实现，不改工具名、参数和回执形状：

| 新文件 | 迁出 case |
| --- | --- |
| `browser-act-navigate.ts` | `navigate_*`、`tabs_*` |
| `browser-act-search.ts` | `search`、`fill_form`、`select` |
| `browser-act-pointer.ts` | `hover`、`drag`、`click_*`、`scroll` |
| `browser-act-type.ts` | `type_*`、`press_key` |
| `browser-act-upload.ts` | `upload` |

验收：

- 拆分前后 `verify:codex-workbench-surface` 与既有 browser 输入/surface 测试集合不变。
- `browser-act-tools.ts` 降到分派 + 共享 ctx 类型，原则上低于 400 行。
- 禁止顺手重排参数、改文案或加新 abstraction factory。

`browser-input-actions.ts` 只在 H1/H2 需要时抽出 `trusted-input-delivery.ts`（发送闸 + 序列结算）。坐标探测和打字回读先不动。

`tool-executor.ts`、`codex-runtime-production-composition.ts`、`useAgent.ts`、`codex-binding-repository.ts` 不在本计划拆分范围。

### H5 — 08-14 未完成项的去留裁决

本计划开工前必须先写死下面三选一，不得边做边改口径：

| 项 | 允许的裁决 |
| --- | --- |
| 下载消费者 | **做**：最小持久回执 + hash readback，再从 Codex 面打开 `browser_download`。**或接受**：继续隐藏，并在 contracts 写明“无消费者故不可见”，复查条件是独立回执消费者落地。 |
| 因果后继页签 | **不做整套 lineage**。若产品需要“点击弹出的页签同轮可读”，单独立项：只允许当前动作的 `postActionTabId` 被同一 run 的下一次 observe 精确采用；仍禁止通用 `browser_tabs`。**或接受**：同轮不能操作新页签。 |
| 真实 BrowserView 门 | **做最小门**：隔离 userData + loopback fixture，覆盖「可见时指针可发；点击导致同 tab 换页后，后续 type/press_key 零发送或部分结算」。不恢复 08-14 §5.3 的巨型 fixture 矩阵。 |

默认建议：下载与后继页签先接受并写进 contracts；BrowserView 最小门做掉，因为它是唯一能证明“点击换页后禁止继续输入”的真实面。

## 4. 实施顺序

1. 先写 H5 裁决进 `current-runtime-contracts.md`（机器可核对的接受项或工单）。
2. H1 序列结算 + 红测。
3. H2 去掉全局 bind。
4. H3 上传与 adapter。
5. H4 只迁文件，不改行为。
6. 若 H5 选择做 BrowserView 最小门，放在 H1 之后、H4 之前，避免拆文件与实机门同时变。
7. 跑第 5 节门；更新 08-14 计划 note，说明哪些仍接受、哪些已移交本计划。

任一阶段出现“无法区分零执行与部分生效”或“拆分后公开入口变成两个”立即停下。

## 5. 验证

| 门 | 必须新增/保住 |
| --- | --- |
| `npm run verify:codex-workbench-surface` | H1–H3 全部新反例；H4 后原用例仍绿 |
| `npm run typecheck` | 拆分后类型仍过 |
| `npm run verify:browser-orchestration` | 不因本计划回退 |
| 可选 `verify:codex-browserview-fixture` | 仅当 H5 选择做最小实机门 |

现有 179/2 skip + Electron 8/8 只证明提交基线，不覆盖 H1 新反例。

## 6. 明确不做

1. 不为了“文档齐全”复制 08-14 的 B3–B7 长矩阵。
2. 不把 `tabs_open` 重新暴露给模型，除非 H5 选择了精确 `postActionTabId` 采用。
3. 不在 canonical 事务里调用 `closeoutRun` 或发 BrowserView 副作用。
4. 不把 memory / session_recall / 人格资料接回 Codex 工具面。
5. 不发明第二套发送前核对。

## 7. 审查记录

| 轮次 | 结论 | 主要处理 |
| --- | --- | --- |
| 1 | 计划草案 | 提交 `43a79a37` 后的第一性原理审查：多事件手势未统一结算、全局 bind、上传/adapter 旁路、act-tools 可拆、08-14 三大缺口需去留裁决 |
