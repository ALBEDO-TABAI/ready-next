---
title: Codex 工作面硬化与手术式拆分
date: 2026-08-14
status: implemented
review_status: passed
reviewed_at: 2026-08-14
enforce: false
depends_on:
  - docs/architecture/current-runtime-contracts.md
  - docs/archive/2026-09-06/docs/superpowers/plans/2026-08-13-codex-capability-relight-index.md
  - docs/superpowers/plans/2026-08-13-codex-workbench-surface-rewire-implementation.md
  - docs/archive/2026-09-06/docs/superpowers/plans/2026-08-14-codex-browser-kernel-fit-implementation.md
note: >
  本文是在 Grok 对 GPT 修订稿反向审查后，再按完整生产包装链复核形成的实施合同，不代表生产代码已经实现。
  审查只保留真实可达的点击/拖拽结算缺口、上传持久回执缺口，以及拆分会造成的检查覆盖缺口。
  无生产调用方、当前串行模型不可触发、或已由既有 stub 合同证明过的问题，不升成新工单或新命名门。
  下载与因果后继页签继续安全隐藏。不新开 `verify:codex-browserview-fixture`：08-14 §10 已明确删掉这道过重的巨门。
archived_at: 2026-09-06
archive_reason: superseded-project-documentation
---

> 已归档（2026-09-06）：本文保留编写当时的设计、状态与证据，不是当前执行入口；归档不表示原计划全部实现。现行说明见 [当前运行时合同](../../../../../architecture/current-runtime-contracts.md)，去向见 [文档清单](../../../../../documentation-inventory.md)。

# Codex 工作面硬化与手术式拆分

## 0. 本计划何时算完成

本文只批准实施，不把“计划通过”写成“功能完成”。生产实施只有同时满足以下条件才算完成：

1. 点击和拖拽以 `mousePressed` 阶段为效果边界：能证明在 press 前拒绝的不得冒充已执行；press 已成功或已进入但结果未知后，不得冒充零执行，也不得把 release/move 补发给后继文档。公开工具结果、`BrowserActionOutcome` 与 journal 必须一致。
2. 上传只有精确文件名回读成功才记录 `delivered + target_value`；已把 `DOM.setFileInputFiles` 交给 Chromium 但无法确认时收口为 `unknown + mayHaveCommitted`。三种定位路径在赋值前都核同一冻结文档。
3. `browser-act-tools.ts` 拆分后仍是唯一生产公开入口；现有嵌套动作、表单测试入口和源码安全扫描均未失效。
4. 第 7 节所有命名门通过，无 `skip`、无只看源码代替行为验证；受影响权威合同和大文件健康记录同步。
5. 下载和通用后继页签继续隐藏；文档写明这是安全限制及其重开条件，不以未完成实现冒充缺陷修复。

真 Electron BrowserView 不是本轮完成条件。换页结算与上传回执复用既有 `press_key` / executor stub 合同，并从现有完整工具包装入口验证。

## 1. 对抗性审查结论

**结论：按本节修改后通过，可进入实施；GPT 修订稿不通过，Grok 二次稿方向正确但仍需收紧完整链验收。** GPT 修订稿已正确删掉 clear / adapter / 虚构并发三类不可达工单，但仍把“真实产品缺口”和“新开 Electron 命名门”绑在一起，并把上传收口写成一套新的三阶段持久模型。Grok 正确删除了这两项；再次沿 `BrowserActionExecutor + browserMutationController + executeBrowserActTool` 复核后，还必须把 click 的 press 阶段贯通到最终回执，并把 selector 的冻结文档核对放到真正赋值前的定位步骤。

| 审查项 | 定性 | 当前证据 | 处理结论 |
| --- | --- | --- | --- |
| 点击在 `mousePressed` 后导航，release 身份核对失败 | **实际可达缺口** | `dispatchTrustedPointer` 已拦住后继页 release；但 `dispatchClickAt` 把 release 的 stale 回执原样放进 `blockedOutput`，facade 再把它作为普通失败返回。完整生产包装实测：公开结果、durable outcome 与 journal 都是 `rejected / not_delivered / mayHaveCommitted=false` | 本轮只把本地 press 阶段写进既有 typed 回执；不重做发送闸、不改 executor 通用错误语义 |
| 拖拽中途换页，以及 blanket catch 抹平阶段 | **实际可达缺口** | press 后 `if (moved) return moved` 会把已按下收成零执行；外层 catch 又把所有异常一律写成 `mayHaveCommitted=true`，没有区分初始 move、press transport 和 press 后续事件 | 用局部阶段修正 typed block；能证明 press 前失败才记零，press 已进入但 transport 结果未知仍保守记 unknown |
| 上传把未确认赋值记成 durable `delivered` | **实际可达缺口** | 叶子已做精确文件名比对；`browserMutationController` 却只看 `ok !== false` 就记 `delivered + target_value`。生产入口会包这层 controller，journal 与工具正文会打架，模型可能对已赋值 input 再传一次 | 本轮修同一条事实链，不新造上传状态机 |
| selector / backend 赋值前不核冻结文档 | **实际可达缺口，但范围很窄** | target token 路径已在页面内拒 stale document；selector 的 marker 只在有 target token 时看 snapshot map，纯 selector 换页后会 `querySelector` 到后继页同选择器。backend 换页后通常是旧 node 失效并 throw | selector-only 也必须传入 `trustedPageRef` 的文档代次；marker 在定位前按 `documentIdentity` 同源规则比对当前文档代次。禁止把“没有 `__readyBrowserTargetIdentityV3` snapshot map”当成 stale。backend 只复用调用前的外层核对 |
| `clearFocusedInput` 四次按键部分生效 | **理论风险** | 只有 `browser-trusted-input.test.ts` 调用，没有生产调用方 | 不改 |
| `BrowserAgentRuntimeAdapter` 从 observe 旁路写入 | **理论风险** | 唯一生产构造在 `browser-observe-tools.ts`，只供 `BrowserPageStateService` 观察；没有 `dispatchMouse` / `dispatchKey` / `typeTextDirectly` 写调用 | 不加第二道输入闸 |
| `boundTrustedPointerExpected` 并发覆盖 | **当前不可触发** | Codex inbound 走单一 `inboundChain`；产品预算 `maxParallelToolGroups: 1`；现有嵌套 search/fill 复用同一 ctx/ref | 不实施虚构并发修复 |
| 下载与通用后继页签不可用 | **安全限制，不是错误行为** | `browser_download`、模型 `browser_tabs` 均明确隐藏 | 继续隐藏，写死重开条件 |
| 拆分 `browser-act-tools.ts` | **真实维护问题** | 文件 2592 行，健康台账多次标危险并写“待独立拆分合同”。`check-browser-tool-no-json-failure.cjs` 与 `check-browser-script-no-freeform-passthrough.cjs` 写死该路径 | 本轮拆分，同时迁移检查覆盖并保留 facade/re-export |
| 真实 BrowserView 门缺失 | **不是本轮缺口** | 08-14 §10 已明确把新的 `verify:codex-browserview-fixture` 巨报告门作为过度防御删除，并改走现有 browser orchestration/native 门。Enter 换页也是同类 stub 证明 | 本轮不新开命名门，也不把已删除的巨门写成“待移交剩余项” |

因此再删除修订稿里的两个过度方案：

- 不新增 `verify:codex-browserview-fixture`，不把它串进 `verify:browser-orchestration`，也不在 H4 里把 08-14 的 BrowserView 剩余项“移交”到本计划。
- 不把上传收口升级成独立持久字段 `assignmentAttempted` / `pageStillCurrent`。结算仍是现有 `delivered | not_delivered | unknown`；叶子本地能区分“没交命令”和“交了但没对上文件名”即可。

同时修正 Grok 二次稿的两处不精确表述：

- click 不能只说“叶子结算错”。完整生产包装也会接收该零执行回执；H0 必须同时看公开输出和 durable outcome，修复才算贯通。
- Electron 巨门不是“仍归 08-14 的未完成项”，而是 08-14 §10 已明确删除的过重方案；本计划既不接管，也不保留悬空债务。

继续拒绝：

- 不把 click、drag、clear、按键和滚动塞进一个 `runTrustedInputSequence`。
- 不单独拆除全局 expected，不写当前串行生产不可能发生的并发测试。
- 不给无写调用方的 adapter 增加第二道输入闸。

## 2. 应用事实与边界

生产代码基线：`43a79a37` `feat(agent): wire Codex workbench surfaces and bind browser pages` 及其后已合入的换页核对 / Enter 部分按键结算。审查时分支为 `codex/cod-ready`，当前 HEAD 还包含本计划文档提交。

生产主链不变：

```text
CodexHostOrchestrator
  → Codex ingress / product composition
  → ReadyCodexLifecycleAdapter
  → canonical closeout / projection
```

浏览器动作的相关事实：

- 公开 mutate 入口是 `browser-tools.ts` → `BrowserActionExecutor` → `browserMutationController` → `executeBrowserActTool`。只测 `executeBrowserActTool` 看得到叶子正文，看不到 journal 回执。
- `trustedPageRef` 表示物理 tab 与冻结主文档代次。facade 入口已 `bindTrustedPointerExpected`；`dispatchTrustedPointer` 在每次 `dispatchMouse` 前核身份，所以后继文档已经收不到 press 之后的 release/move。当前丢失的是 `dispatchClickAt` 内部的 press 阶段：facade 只看到 stale 的零执行 `blockedOutput`，完整 executor 因而也结算为零。
- `sendKeyStroke` 和 `collect_scroll` 已按已发送次数结算部分生效。本计划只给它们跑回归，不重写。
- `dispatchClickAt` 的 move 只是定位指针；`mousePressed` 才是 click/drag 的效果边界。当前缺口是：press 之后的身份失败仍返回 `trustedInputPageDenied` 的零执行回执。
- `setFileInputFiles` 的 CDP 命令与精确文件名回读是两件事。叶子已经按 NFC + 排序比对附件名；持久层不能只看 transport `ok`。
- 失败收口继续走 canonical closeout。本轮不改变任务、预算、准入或 provider 生命周期。
- `browser-input-actions.ts` 已有 1505 行，台账评为一般。H1 只允许在这里加 press 状态，不顺手拆它。

当前已确认的安全限制：

| 项 | 本轮裁决 | 允许重开的条件 |
| --- | --- | --- |
| 下载消费者 | `browser_download` 继续整名隐藏 | 独立产品需求批准，且先有绑定 run/tab/path/hash 的持久回执与文件 readback |
| 因果后继页签 | 模型 `browser_tabs` 继续隐藏；不得只暴露 `postActionTabId` 半成品 | 明确要求同轮继续 popup/new tab，且 lineage、handoff、取消与错页验收一起获批 |
| 全局 expected 并发风险 | 不实施 | Codex 工具并行度大于 1，或生产出现不同 `trustedPageRef` 的嵌套动作 |
| adapter 写旁路 | 不实施 | 出现真实生产写调用方；届时必须直接接入同一发送闸，不能再造一套 |
| 真 Electron BrowserView 命名门 | 不实施 | 08-14 §10 已明确删除该过重巨门；只有未来出现现有 orchestration/native gate 无法证明的新物理路径时，才另写窄合同重开 |

## 3. 机器可验证合同

### C1 — 点击与拖拽的效果边界

每个手势只维护本次调用内的 `pressAttempted / pressed` 阶段，不新增持久状态。不用“任意事件数大于零”代替产品语义：

1. `mousePressed` 前的 typed 身份/可见性拒绝，或可证明尚未进入 press transport 的失败：`dispatch=rejected`、`delivery=not_delivered`、`mayHaveCommitted=false`。move 已成功但尚未 press，仍按当前 click/drag 产品效果边界结算为零。
2. `mousePressed` 已成功发出，后续 move/release 因换页被 typed block：`dispatch=accepted`、`delivery=unknown`、`effect=unknown`、`mayHaveCommitted=true`、`needsObservation=true`。
3. 已进入 press transport 但抛错、无法确认 Chromium 是否收到：记 `dispatch=accepted`、`delivery=unknown`、`mayHaveCommitted=true`。这是叶子 typed 回执，不是第二套状态；不得为了满足 press 成功计数而伪装成 not_delivered。
4. 一旦发现 frozen document 已失效，后续事件为零。当前 `dispatchTrustedPointer` 已满足这一条；H1 不得再包一层发送闸，也不得为了“补完手势”把 `mouseReleased` 发给 successor。
5. typed block 的阶段结果必须经现有 facade 返回，令公开工具结果、`BrowserActionOutcome` 与 journal 三者一致；通用 executor 不新增 click/drag 特判。
6. 成功路径的事件顺序和现有工具输出保持不变；不修改坐标解析、可见性检查或交互目标选择。
7. 继续使用现有 `bindTrustedPointerExpected`。不必给 `dispatchClickAt` 新增 expected 参数作为完成条件。

### C2 — 上传的身份与精确回读

上传继续使用现有 outcome 三值，不新增持久字段：

1. 有 `trustedPageRef` 时，upload 叶子在调用 controller 前先走现有 `trustedInputPageDenied`，并且 selector-only 也要把 `mainFrameDocumentToken` 传入 `setFileInputFiles`（今天只有 resolve 出 targetId 才会带 token）。没有 page ref 时不新造拒绝，与指针路径一致。
2. `automation-service.ts` 的 selector marker 在 `querySelector` 前比对当前文档代次：token 算法必须与 `documentIdentity` 同源（没有 map 就创建，再比传入的非空 token）。空 token 不新增拒绝。不得把 `__readyBrowserTargetIdentityV3` 缺席或没有 target token 写成 stale——那会误杀从未 snapshot 过的合法 selector 上传。错页赋值发生在 marker 选中后继页 input 的那一步，所以核对必须在定位前，而不是只在叶子入口。
3. backend 路径没有 marker；调用前的外层核对加上旧 node 失效即可，不另建状态。
4. `browserMutationController` 不得再因 `setFileInputFiles` 的 `ok !== false` 自动记 `delivered + target_value`。
5. 叶子沿用现有精确文件名比对（NFC + 排序），并在既有 mutation boundary 上记录机械事实。比对成功：`delivered + effect=target_value`。
6. 赋值命令已交给 Chromium，但回读缺失、文件名不一致或文档已换代：`delivery=unknown + effect=unknown + mayHaveCommitted=true + needsObservation=true`。现有 executor 对 unknown 本就不自动重试；不要为此新写重试抑制器。
7. 赋值前的 transport/解析失败：保持 rejected/not_delivered。
8. 工具正文、`BrowserActionOutcome` 和 journal 必须是同一事实。H0 必须经过 `browserMutationController + BrowserActionExecutor`，只断言叶子 `ok:false` 不算通过。

### C3 — 手术式模块边界

`src/main/modules/tools/browser-act-tools.ts` 保持唯一生产 facade，只做：参数/ctx 组装、动作族路由、canonical outcome 交接。拆分边界以现有 case 族为准：

| 叶子 | 迁移范围 |
| --- | --- |
| `browser-act-navigation.ts` | `navigate_*`、`tabs_*` |
| `browser-act-form.ts` | `search`、`fill_form`、`select`、`type_*`、`press_key`；保留它们现有嵌套关系 |
| `browser-act-target.ts` | `click_target`、`type_target` 的精确目标解析与执行 |
| `browser-act-pointer.ts` | `hover`、`drag`、其余 `click_*`、`scroll` |
| `browser-act-upload.ts` | attachment 选择、目标定位与 upload |
| `browser-act-shared.ts` | 只收纳至少被两个叶子使用的 ctx/type/回执 helper，不放动作分支 |

边界约束：

1. 叶子不得导入 facade，避免环；需要递归执行动作时由 facade 注入现有授权范围内的窄 `invokeNested`。`search` / `fill_form` / `select` 今天已经回呼 `executeBrowserActTool`，这是迁移要接住的真实耦合，不是新抽象。
2. `runBrowserFillFormSequence` 继续由原 facade re-export，`browser-semantic-tool-behavior.test.ts` 不改导入路径。
3. 不改工具名、schema、授权、错误文案和回执形状；H1/H2 行为修复必须在迁文件前独立通过。
4. `check-browser-tool-no-json-failure.cjs`、`check-browser-script-no-freeform-passthrough.cjs` 必须覆盖所有 `browser-act-*.ts`，并检查现行统一入口 `resolveBrowserToolInvocation`（剥掉 `custom_script`）与只读模板注册表。用脚本测试或临时动作叶子证明漏扫会失败；不要在生产树里留一个永久“违规叶子”，也不要恢复已删除的 highControl/verdict/lease 旧入口。
5. 新增结构门锁定：生产调用方只导入 facade、叶子不反向导入 facade、facade 不承载动作实现。结构门不能代替行为测试。
6. facade 目标不超过 400 行；每个新叶子必须低于项目 1000 行危险线。若实际依赖证明该边界会制造重复逻辑，先修改本文并重新审查，不可机械切文件。
7. 拆分不得借机合并 click 后处理、shadow 取证或 search 填交分段。

## 4. 实施工单

### H0 — 先把真实反例写红

在不改生产代码前，新增并确认以下反例会失败：

- click：move 后换页、press 后换页两种结算必须不同。两例都走 `BrowserActionExecutor → browserMutationController → executeBrowserActTool`；同时断言公开输出与 durable outcome。控制器在对应事件后把文档代次翻到 successor，后继文档的后续 mouse 事件必须为 0。
- drag：press 前 typed denial 或可证明未进入 press transport 的失败不得 `mayHaveCommitted`；press 已进入但 transport 结果未知、或 press 成功后换页，必须 `mayHaveCommitted` 且不再 release。两例同样断言最终 durable outcome。
- upload：selector 在后继文档上不得发 `setFileInputFiles`，且同文档、无 snapshot map 的 selector 上传仍须成功。已返回 `ok:true` 但文件名对不上时，经 `browserMutationController + BrowserActionExecutor` 的 durable outcome 不得为 `delivered`。
- scanner：扫描范围漏掉 `browser-act-*.ts` 时，现有安全门必须失败。

这些反例用现有 flipping-document / fake controller 即可，与 `press_key` Enter 换页同一手法，但必须经过现有完整包装；不要为了写红去加 Electron 或 sleep。

若任一反例在当前代码已经通过，先记录真实原因并删除相应生产改动，不为了符合计划而改代码。

### H1 — 修正 click/drag 结算

只在 `browser-input-actions.ts` 的 `dispatchClickAt`、drag 所在动作实现与现有 facade typed-block 收口中增加 C1 所需的局部 press 阶段：

- 不抽取覆盖键盘、滚动、clear 的统一序列框架。
- 保留 `sendKeyStroke`、`collect_scroll` 现有计数逻辑，只跑回归。
- 身份失败已经由 `dispatchTrustedPointer` 拦截；这里只让现有 `blockedOutput` 带上正确阶段，并沿 facade 现有 catch 返回，不给 executor 加第二套判断。
- drag 删除“一律 mayHaveCommitted”的 blanket catch，按初始 move / press transport / press 后续事件区分；未知 transport 继续 unknown，不伪造 not_delivered。

完成门：H0 输入反例转绿，正常 click/drag 顺序与回执不变。

### H2 — 修正 upload 事实链

按 C2 从赋值前身份到持久结果一次贯通：

1. 有 `trustedPageRef` 时，叶子先走现有页面核对，并在 selector-only 路径把 document token 传入 `setFileInputFiles`。
2. selector marker 按 C2 比对当前文档代次后再 `querySelector`；target token 查找仍用现有 snapshot map；backend 不改查找，只吃调用前核对。
3. 从 `browserMutationController` 的 direct-delivery 集合移除 `setFileInputFiles`，不再因 transport `ok` 自动 delivered。它仍留在 transport 集合里，以保留 beginAction / 写栅栏。
4. upload 叶子按已有精确文件名回读记录现有 mechanical fact；只用调用内局部阶段，不新增 repository/schema 字段。
5. 上层 executor 继续消费该事实，不猜测成功，不新增重试器。

完成门：H0 上传反例转绿，稳定 target/backend/selector 上传仍成功。

### H3 — 最后做纯迁移拆分

H1–H2 全绿后再按 C3 迁文件。一次只迁一个动作族，每次运行该动作族测试与结构门。禁止借迁移改参数、消息、授权或回执，也禁止顺手拆 `browser-input-actions.ts`、`tool-executor.ts`、`codex-runtime-production-composition.ts`、`useAgent.ts`、`codex-binding-repository.ts`。

### H4 — 合同与健康记录收口

只更新受影响的权威入口：

- `current-runtime-contracts.md`：点击/拖拽的 press 边界、upload 精确回读才 delivered、下载/页签接受项。
- `2026-08-14-codex-browser-kernel-fit-implementation.md`：只补 upload/input 结算的实际状态。不要把已放弃的 BrowserView 巨门改写成“已移交本计划”。
- `large-file-health-log.md`：记录 `browser-act-tools.ts` 拆分后的真实行数和新叶子健康状态；H1 若净增 `browser-input-actions.ts`，按一般项更新复查日期。

## 5. 实施顺序与停线条件

```text
H0 红测
  → H1 click/drag 结算
  → H2 upload 事实链
  → H3 move-only split
  → H4 contracts/health closeout
```

以下任一情况必须停线并回到本文重新审查：

1. 需要增加新的模型工具、权限、重试器或第二个生产入口才能完成。
2. 无法用 `mousePressed` 区分 effect-before/effect-after，只能用“发过任意事件”猜测。
3. upload 无法区分赋值未尝试与已尝试但未确认。
4. 叶子之间出现循环，或必须复制目标解析/回执逻辑才能满足文件表格。
5. 为了让换页或上传回执变绿，必须加固定 sleep、测试专用生产分支或新的 Electron 命名门。

## 6. 行为验收矩阵

| 场景 | 实际发送 | 预期收口 |
| --- | --- | --- |
| click 在首次发送前已 stale | 0 | rejected / not_delivered / false |
| click move 后、press 前 stale | move；0 press/release | rejected / not_delivered / false |
| click press 后 stale | move + press；0 release to successor | accepted / unknown / true |
| drag press 前 typed denial / 已知未进入 press transport | 0 press | rejected / not_delivered / false |
| drag 已进入 press transport 但结果未知 | press unknown | accepted / unknown / true |
| drag press 后中途 stale | press + 已完成 moves；0 remaining/release | accepted / unknown / true |
| upload 赋值前 stale | 0 assignment | rejected / not_delivered / false |
| upload assignment + exact readback | 1 assignment | accepted / delivered / target_value |
| upload assignment 后 readback 不确定 | 1 attempted assignment | accepted / unknown / true |
| `sendKeyStroke` / `collect_scroll` 既有部分生效 | 保持现有计数 | 既有结果不变 |
| 正常 search/fill/select 嵌套 | 保持现有调用顺序 | 结果、授权与 journal 不变 |

表中最后一个布尔值为 `mayHaveCommitted`。

## 7. 必跑验证

```bash
npm run typecheck
npm run verify:codex-workbench-surface
npm run verify:browser-orchestration
```

`verify:codex-workbench-surface` 已包含 `browser-input-readiness.test.ts` 与 `browser-action-executor.test.ts`，新反例应进入这两处或同门已列测试，不要另起孤立脚本。

另外必须有以下可见证明：

- 新输入与上传行为测试覆盖第 6 节全部分支。
- click/drag 的零执行与部分执行、上传的 unknown/delivered 都经过 mutation controller 与 executor，并同时断言公开结果和 durable outcome。
- 新结构门证明所有 `browser-act-*.ts` 都在安全扫描范围内。
- `git diff --check` 通过；目标文档、脚本名和 npm 命令均可解析。
- 实施结束后再次统计所有净增代码文件；超过 1000 行按项目规则记录，不用“已经拆分”替代健康检查。
- 只有实现实际修改 SQLite、设置或其他本地持久层时才额外运行 `npm run verify:native`；本计划不为未发生的改动强制重编 native 模块。

## 8. 明确非目标

1. 不实现下载消费者、通用 tab lineage、`browser_tabs` 或 post-action 自动接管。
2. 不移除全局 expected 作为独立目标，不写当前串行生产不可能发生的并发测试。
3. 不改没有生产写调用方的 `BrowserAgentRuntimeAdapter`，不为 `clearFocusedInput` 建新框架。
4. 不引入第二 Browser Agent、Playwright、`use_browser`、同轮扩权或公开续跑。
5. 不把 Electron 副作用写进 SQLite/canonical closeout 事务。
6. 不拆本计划未点名的大文件。
7. 不新开 `verify:codex-browserview-fixture`，不恢复 08-14 §5.3 的 B3–B7 巨型矩阵，也不把该门的最小子集改头换面塞进本轮完成条件。
8. 不新增上传专用持久字段或第二套重试策略。

## 9. 审查记录

| 轮次 | 结论 | 主要处理 |
| --- | --- | --- |
| 1 | **不通过** | 草案把首个物理事件一律视为生效，导致 mouse move 被当成 click；把 clear、adapter、全局并发等理论风险列为生产工单 |
| 2 | **不通过** | 沿真实调用方复核后删除不可达工单；新发现 upload 的 `filesAssigned` 未进入 durable outcome，以及拆分后两个安全扫描器会漏掉叶子 |
| 3 | **不通过** | GPT 修订稿仍把真 Electron 命名门写成必须项，并给上传加上新的三阶段持久模型。08-14 实施切片已放弃同名巨门；press 后换页与 Enter 换页是同一类 stub 可证问题。发送闸已存在，缺的是结算 |
| 4 | **Grok 复审通过** | 删除新 Electron 命名门和上传三阶段持久模型；计划收敛为 click/drag 的 press 结算、upload 精确回读与赋值前身份、保持 facade/扫描覆盖的纯迁移 |
| 5 | **复核后原则成立** | 完整生产包装实测确认 click press 后仍被持久化为零、upload 正文失败仍被持久化为 delivered；补齐公开结果与 durable outcome 双断言、selector 定位前核对，并纠正“BrowserView 巨门仍属未完成项”的表述 |
| 6 | **通过** | 沿代码复核第 5 轮两处收紧均为实际缺口，不是新抽象。唯一必须改的是 selector 核对写法：不得复用 target-token 的 snapshot map 缺席判定，否则会误杀未 snapshot 的合法 selector 上传。已写明 token 传入、`documentIdentity` 同源比对、空 token 不新拒绝 |
| 7 | **实现复审暂不通过** | 核心行为已落地，但 freeform 扫描仍查三个已删除入口，且未纳入 `verify:browser-orchestration`，导致“全绿”漏掉稳定失败 |
| 8 | **实现复审通过** | 扫描改为对准 `resolveBrowserToolInvocation` + `custom_script` 剥离 + 只读模板注册表；新增 `browser-act-*` 叶子反例；脚本纳入浏览器验收门。拖拽 press transport 未知的合同口径与实现统一为 `accepted / unknown / true`，不另造状态 |

最终审查判定：**PASS — 生产实现已按第 0、6、7 节完成；freeform 扫描已对准现行入口并纳入浏览器验收门。**
