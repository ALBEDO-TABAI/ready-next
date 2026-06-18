---
title: send-im 修复 + Agent 状态架构（分阶段实施计划）
date: 2026-06-17
revised: 2026-06-18 (r8 — G0/G1/G3/G4/G2-error-path 已实现并验证；真实微信送达被 sendmessage ret=-2 阻塞)
branch: agent-evolution/phase1
status: implemented-code-verified-external-wechat-send-blocked
enforce: true
executor: codex
scope_note: G0 是 keystone 且先做（架构级、碰可见收口/判定红线，须配 verify:stability）；G1/G4 为 send-im 主链路；G2 须真机；G3 提示词+策略层。Problem A（⑥）与移动端（Phase 3）仍单独排。
gate_note: 工作树已有 ~44 文件相关改动——**先做 §1.5 现有改动对照归档**，再做 §2.3/§3.3 的 precheck（只复现+定位，不改码）；G0 名实/触发面、G1 授权环、G2 endpoint 未坐定前不得写新实现代码。
source_docs:
  - docs/diagnostics/2026-06-18-adjudication-degraded-shared-root-findings.md
  - docs/diagnostics/2026-06-17-okf-bundle-no-package-and-ui-stuck-findings.md
  - docs/diagnostics/2026-06-17-send-im-codex-round-layered-review.md
  - docs/diagnostics/2026-06-17-ready-agent-and-multiclient-sync-architecture-review.md
review_log:
  - r1: 初版（ready-for-implementation）
  - r2: Codex 复审降级为 needs-revision；按其 6 点修订（见 §0.4）
  - r3: Codex 复审"可进入前置核验"；补 3 处（D3 资源权威 / 多图一等合同 / D1 执行形态落点，见 §0.5）
  - r4: 06-18 扩大化审查发现共同根因（enforce 闸门 × 漏证据管线 × 不透明终态），Codex 交叉复核认同并定 G0→G3 分层。本版据此重排（见 §0.6）：keystone 从 D1 上移到 G0；ret=-2 证伪大小假设升 G2；exposure 升 G1 跨轮持久；新增 G3；原三口径→AC。
  - r5: Codex 复审 r4"方向对、G0 提前必要"，提 3 处收紧并已全部吸收——① G0 堵"accept+caveat"口子（带动作任务证据不足/动作失败必落明确病因码，caveat 仅附加说明、不得把失败变成功；C-G0-2 + §2.3）；② 定唯一执行顺序 G0→G4·D4→G1→G4·D3+D5/D6→G3→G2（§0.0，并同步 §0.1/§4/§7）；③ G1 补 C-G1-Y（重试须继承上一轮文件资源+目标通道、直接进发送路径，不绕搜索/采集/present_file）。
  - r6: Codex 复审 r5"方向稳、剩执行门槛不够硬"，提 3 处并已吸收——① 硬化 G0 测试（C-G0-2 必须断言"落明确病因码 且 verdict≠accept 且 ≠adjudication_degraded"，纯问答 accept 单独测 C-G0-2b，防实现者把失败改 accept 蒙混过测）；② 拆分 precheck(开工前只复现+定位)/postcheck(每步改完验证)，消除"没改码却要验证改后结果"悖论（§2.3/§3.3）；③ 新增 §1.5 现有改动对照归档（工作树已有 ~44 文件/2000+ 行未提交改动，不能从零实现），status→needs-reconcile-then-precheck。低风险清理：frontmatter→r6、§0.1 Problem B 指 §6、§0.2 ret=-2 证伪指 §4.5。
  - r7: §1.5 归档产物已存在并复核通过（`docs/diagnostics/2026-06-18-worktree-vs-plan-reconciliation.md`）；计划状态从"待归档"推进为"待 G0-root precheck + 实现"。下一步不再重复归档，直接补 G0-root + 防假成功测试，再回归已先行落地的 G1/G2/G4。
  - r8: Codex 执行完成：G0 终态如实化、G1/G4 直达 send-im、G3 防 present_file 兜底、G2 `ret=-2` 如实化与频道错误落库均已通过测试；真实文本探活与 Markdown 发送仍被微信 `sendmessage ret=-2` 拒绝，已证明非文件大小/类型、非目标 userId 缺失、非 Ready 工具绕路。
---

# 实施计划：send-im 修复 + Agent 状态架构（r8）

> 执行依据，给 Codex 用。证据见 `source_docs`，本文给"合同 → 触点 → 改向 → 测试 → 验证 → 非目标"。
> **合同先行**（CLAUDE.md §0.5）：每项给机器可验合同；合同写不出来 / 根因未坐实，不得开工。
> 锚点 `file:line` 可能漂移，执行时先 `grep` 符号确认。

---

## 0. 范围、边界、主修复序（先读）

### 0.0 概念分层（G0–G4，按爆炸半径）与唯一执行顺序

06-18 审查的核心结论：**之前"每轮都没根治"不是修错了，而是一个共同根因把多个独立病因塌缩成同一个不透明终态 `adjudication_degraded`**，所以无论底层修没修好、症状都一样。因此 keystone 从"send-im 的 D1"上移到判定闸门本身。

| 序 | 名称 | 解决什么 | 性质 | 来源 |
|---|---|---|---|---|
| **G0** | 判定闸门终态如实化 + 触发面校准 | "没根治"错觉、可诊断性丧失（病因被塌缩成一个码） | 架构级 keystone，先做 | 06-18 findings §2 + 原 Phase2 ⑦ |
| **G1** | skill 身份跨轮持久 | "再试一次/继续"丢 skill → 本轮不暴露工具 | 主链路 | 06-18 findings §0.1 = 原 D2/exposure + Codex G1 |
| **G2** | 微信发送路由/绑定诊断 | `ret=-2`（**非文件大小**，已证伪） | 须真机 | 06-18 findings §0.1 校正二 = Codex G2 |
| **G3** | 兜底纪律 | Send IM 不可用时改道 `present_file` 冒充发微信 | 提示词+策略层 | Codex G3（mqid6t 实锤） |
| **G4** | send-im 交付管线 | 工具名统一 / 下载图→send-im / 多图 / 测试诚信 | 主链路 | 原 D4/D3/D5-D6（D1 已并入 G0） |

> **标签迁移（避免与旧版混淆）**：旧版"三条硬口径 G1/G2/G3"在 r4 **降级为验收口径 AC-1/2/3**，分别挂到新 G 之下——
> - **AC-1 最终工具可见性**（旧 G1）→ 归 **G1**；
> - **AC-2 直接 skill 成功判定**（旧 G2）→ 归 **G0**（它本就是判定层验收）；
> - **AC-3 下载图→send-im + 多图**（旧 G3）→ 归 **G4**。
> 下文 `G1/G2/G3` 一律指 r4 新义；旧义只以 `AC-n` 出现。

> **唯一执行顺序（r5 定稿，全文以此为准，任何冲突以本行为准）**：
> **G0 → G4·D4 工具名统一 → G1 → G4·D3 + D5/D6 → G3 → G2 离线诊断 → G2 真机验证。**
> 上表是"爆炸半径/概念归属"分组，**与执行序不同**：D4 虽属 G4，但它是 G1 暴露复测的前置，必须紧跟 G0 之后先做；D3/D5/D6 在 G1 之后。

### 0.1 本轮做什么 / 不做什么
- **本轮执行（顺序以 §0.0 唯一执行顺序为准）**：G0 → G4·D4 → G1 → G4·D3+D5/D6 → G3 → G2 离线诊断；G2 真机送达验证人工补。
- **D1 已由 Codex 上轮实现并验证有效**（`skillExecutionForm==='direct'` → s1 `markNotApplicable`，见 §2.1）；r4 不重做 D1，而是用 G0 根治其所属的整类问题（停止 s1→c1→c2 打地鼠）。
- **Problem B（B1 可做，B2 排在主链路之后）**：见 §6。
- **Problem A（⑥）/ 移动端（Phase 3）**：见 §5 / §6，本轮不动代码。

### 0.2 本轮明确不做（违反即返工）
1. **不**沿"主进程返回 `killed:false`"修停止键。停止失效走投影对账 + 事件回灌（⑥，§5），不在本轮。
2. **不**把 direct skill 伪装成非 skill 事件（禁用丢 `module='skill'` 的 option a）。保住技能审计链。
3. **不**为了 CI 跑绿而削弱/跳过测试（§1 baseline 纪律）。
4. **不**把移动端/iPad 同步、client registry 拉进本轮（Phase 3）。
5. **不**沿用 r1"`@[Send IM]` 在 envelope 阶段被剥掉"根因判断——已被实测证伪。
6. **不**把 `ret=-2` 当文件大小问题处理——已被代码证伪（证据见 §4.5 / §0.6）。**不**先动微信图片 `image_item` 加密协议（L4，真机另议）。
7. **不**用"放宽判定器"作为 G0 的实现（会漏判真失败）——G0 是"如实化 + 校准触发面"，不是"全部放过"。

### 0.3 验收口径（每条都要行为测试坐实，不能只看现象）

**G0 验收**
- **C-G0-1 终态如实化**：底层动作真失败（工具返回 `send_failed`/`errorKind`/`ok:false`）的 run，finalize 后 `terminalReason` 必须是**病因码**（如 `delivery_failed` / `tool_unavailable` / `no_artifact`），**不得**塌缩成 `adjudication_degraded`。
- **C-G0-2 触发面校准（带动作任务禁止"accept 兜底"）**：把 `done` 改写为 `degraded` 仅在"取证管线对该 `taskType×module×executionForm` 结构上可满足"时才允许。准则因真实原因结构性不可满足时——**只要任务带动作（工具调用 / 交付 / 产物意图），证据不足或动作失败就必须落明确病因码**（`delivery_failed` / `tool_unavailable` / `no_artifact` / `proof_gap`），**既不得** accept、**也不得**塌缩成 `adjudication_degraded`；`caveat` 只能作**附加说明**，**绝不能把失败变成功**。仅"无动作纯问答"（direct_answer 的 response-digest）可正常 accept。
- **C-G0-3 名实一致**：`recordShadowAdjudication`/metric `adjudicator_shadow_divergence` 的"shadow"语义与实际行为必须一致——要么改名/注释为 enforce 并硬化取证，要么退回真 shadow（只记录不改写）。当前名实不符本身是 bug。
- **AC-2（旧 G2，归 G0）直接 skill 成功判定**：direct skill 成功 → 不产生 `criteria_unsatisfied:s1`、终态非 `adjudication_degraded`，且仍由基线 `tool_or_artifact_proof` 正向满足（不是凭空放过）。

**G1 验收**
- **AC-1（旧 G1，归 G1）最终工具可见性**：从原始用户文本 `@[Send IM] 把这四张图发到我微信` 出发，断言最终对模型可见的工具列表里真有 `skill_send_im_file`。不准只测"技能名被匹配"。
- **C-G1-X 跨轮持久**：上一轮以 `@[Send IM]` 授权过 send-im，下一轮用户只说"再试一次/继续"（无字面 `@[skill]`）时，send-im **仍被授权且工具仍可见**；任务**不被重分类**成 research/file_search。
- **C-G1-Y 重试继承交付上下文**：重试轮不只识别为 send-im，还必须**继承上一轮要发的文件资源 + 目标通道**并**直接进入发送路径**——**不得**再 `file_search`/采集/`present_file`。测试：轮1 选定 4 图 + 目标"我微信" → 轮2"再试一次" → 断言复用**同 4 文件资源 + 同通道 + 直接调 send**，全程无搜索/采集/present_file。

**G2 验收**
- **C-G2-1 错误如实**：`ret=-2` 必须被如实归类为后端业务错误（非大小），并在 endpoint 维度可定位（`getuploadurl` vs `sendmessage`），错误信息含 `routeTag/botAgent` 配置态。
- **C-G2-2（人工/真机）**：配置正确后真实微信送达。

**G3 验收**
- **C-G3-1**：Send IM 不可用时，模型**不得**用 `present_file` 等本地展示工具冒充"发到微信"；应如实报"发送通道不可用"并停在该病因。

**G4 验收**（=旧 AC-3 + 交付管线）
- **C-G4-1 名字统一**：一个 skill action 全链单一名（`buildToolName` == manifest `allowed_tools` == dispatch 解析 == SKILL.md == 测试 == 暴露名）。定名 = `skill_send_im_file`。
- **C-G4-2 确定性入口（=AC-3 主合同）**：存在确定性入口把"本会话最近下载/选中的媒体"变成 send-im 直接可读的文件列表；给 4 张下载图，**无需用户显式路径**即可解析出 4 个文件。
- **C-G4-3 多图一等公民**：manifest 参数 / schema / 工具执行 / sidecar payload 四处都支持多文件；测试断言最终 sidecar payload 含 4 个附件。

### 0.4 r2 修订点（对应 Codex 6 条，保留备查）
1. D1 合同硬化（criteria/proof 层验收，非"send-im 成功"即可）。2. D3 确定性入口为主合同。3. D2 根因改下游、删 envelope 剥离说。4. Problem B 拆 B1/B2 排主链路后。5. 锚点路径修正到 `agent-control/quality/`。6. 状态前置三口径。

### 0.5 r3 补充（对应 Codex 3 点，保留备查）
1. D3 资源权威源 = 投影产物层 `recentArtifacts`（持久 `task_projections.recent_artifacts_json`），下载工具主动登记；禁止解析上一轮文本/扫目录；注意 `slice(-4)` 上限按 kind 过滤媒体视图。2. 多图升一等合同（四处支持，测试断言 4 附件）。3. `skillExecutionForm` 显式字段走 `projectionPatch` 真值通道；禁止判定层临时读 manifest/靠 module 猜。

### 0.6 r4 重排说明（对应 06-18 审查 + Codex 交叉复核）
- **keystone 上移**：D1 只治了判定闸门的一个症状（s1）。审查证明闸门是 enforce 模式架在漏证据管线上、用不透明终态遮病因——这是"没根治"的共同根因。故新增 **G0** 根治闸门本身，D1 并入 G0（其 s1 窄修已由 Codex 实现且有效，作为 G0 的一个已完成分支保留）。
- **ret=-2 证伪大小假设**：代码层证据——大小门是独立的 100MB 门且报另一句话（`wechat_openclaw_adapter.py:508-509`），`ret=-2` 来自 `_raise_for_business_error`（`:178-187`）对后端业务码判负。故 G2 围绕路由/绑定/`context_token`，**不做**大文件分片。
- **exposure 不是 flaky 是确定性**：w0jcej 用户轮有 `@[Send IM]` → 暴露；mqid6t 是"再试一次"无 `@[Send IM]` → 不授权。合并为 **G1 跨轮持久**（原 D2 的"不引入跨轮持久授权"非目标**作废**）。
- **新增 G3**：mqid6t 模型确实改道 `present_file` 冒充发微信，须策略层堵。

---

## 1. 执行前置 — baseline 纪律（必做）

> 本分支 base 自带已知红：~8 测试失败 + 20 ipc-contract 违规 + `check-silent-catch` 已红。先固定 baseline，区分"既有红"与"本轮新红"。

```bash
npm run typecheck
npm test 2>&1 | tee /tmp/baseline-test.txt
node scripts/check-silent-catch.cjs 2>&1 | tee /tmp/baseline-silentcatch.txt
npm run verify:stability 2>&1 | tee /tmp/baseline-stability.txt
```
- 结束后**不得新增**任何 red；既有红保持原样，不顺手修无关项、不削弱。
- 每个新行为测试必须 **red→green**（未改代码时先 red，证明能抓 bug）。
- 不得 source-grep 冒充行为验证；不得 skip 当通过（CLAUDE.md §6）。

---

## 1.5 现有改动对照归档（必做，先于所有 G 实现、先于 precheck）

> **关键现状**：工作树**已有** Codex 上轮 ~44 文件 / 2000+ 行相关改动且**未提交**（含 `tools/send-im-skill-tool.ts`、`runtime-core/channel-delivery-result.ts`、`channels/wechat_openclaw_adapter.py`、`quality/criteria-templates.ts` 的 D1、`task-projection/run-projection.ts`、多个 `__tests__/*` 等）。因此本计划**不是"干净树从零实现"**——必须先把现存改动对照归档，否则 §7 的逐项提交顺序失真、会重复造轮子或漏测。

- **步骤**：`git diff --stat` + 逐文件过一遍，把**每个**改动归到 `G0 / G4(D4/D3/D5-D6) / G1 / G3 / G2 / 不在计划内`；产出对照表写进 `docs/diagnostics/2026-06-18-worktree-vs-plan-reconciliation.md`（或 PR 描述）。**【已产出，见该文件】结论：G1/G2/G4 已实质落地，但 keystone G0-root 未做（仅 D1 子分支），属顺序倒置——见下 §2 注。**
- **逐条判定**：① 归属哪个 G；② 是否有对应行为测试（无 = 缺测试，记入待补）；③ 是否越序（如 G2/G1 代码先于 G0 落地）；④ 是否偏离本计划合同（偏离 = 要么回退、要么把计划改对，二选一并写明）。
- **D1**：已确认完成（§2.1），直接标"G0-已完成分支"。
- **归档产出后再决定**：每个 G 是"补缺/补测试/对齐"还是"全新实现"；**precheck（§2.3/§3.3）在归档之后**做，因为要先知道现状才能只复现+定位。
- **非目标**：本步**不写新功能代码**，只归类、列缺测试、标偏离/越序；真正改代码仍按 §0.0 唯一顺序、过 precheck 后逐项 red→green。

---

## 2. G0（keystone）— 判定闸门终态如实化 + 触发面校准

> **先做。** 不修 G0，G1/G2/G4 修好了用户也看不出来（症状仍塌缩成 `adjudication_degraded`），且无法判断后续修复是否真生效。架构级、碰判定红线，须配 `verify:stability`。
>
> **⚠️ 工作树现状（§1.5 归档实锤）：G0-root 尚未实现——病因码 `delivery_failed/...` 全代码不存在、`run-finalizer` 改写块逐字未动、`runtime.ts` 只在 IM 回复层 cosmetic 翻译 `adjudication_degraded`。下面 §2.1 的"D1 已完成"仅指 s1 窄分支，勿误读为 G0 整体已做。首个 commit = 在既有树上补 G0-root + §2.5 防假成功测试，而非从零写。**

### 2.0 根因（06-18 审查，已确证）
- **enforce 改写**：`run-finalizer.ts:204-229 writeTerminalOutcome` 拿 `recordShadowAdjudication` 返回的 verdict，`done && verdict!=='accept'` → 改 `error/adjudication_degraded`（或可续则 `checkpoint`）。但 `recordShadowAdjudication`/`task-adjudicator.ts` 注释与 metric 名仍写 "shadow … NEVER mutates terminal state"。**名实不符。** 促成于提交 `923dddfe`（2026-06-17 00:50），其前身 `b3442011` 是真 shadow。
- **漏证据**：`proof-collector.ts:129-131 collectToolOutputProofs` 对失败工具 `return []`（`isFailedToolOutput` :78-86）。失败动作→0 proof→准则不满足→degraded。
- **proof-kind 过粗**：`task-adjudicator.ts:64-90` 仅按 proof-kind 在场判 satisfied；short_task c1（要 `tool_result`）分不清"做了失败"与"没做"；research c1/c2（要 `artifact`）`file_search`/`document_*` 未必登记成 artifact。
- **塌缩**：三种真实病因（没暴露 / ret=-2 / 没产物）都写成 `adjudication_degraded`，用户侧统一显示"完成判定未通过"（`task-projection-sync.ts:453`）。

### 2.1 D1 现状（已完成分支，保留备查）
Codex 上轮已实现：`criteria-templates.ts:104-125` `skillExecutionForm==='direct'` → `markNotApplicable(s1)`；`run-finalizer.ts` 串 `skillExecutionForm`（走 `projectionPatch` 真值通道，生产端在标 `module='skill'` 处写、消费端 finalizer/criteria 读，禁止临时读 manifest）。**验证有效**：w0jcej 的 blocker 已从 `s1` 迁到 `c1`。**保留此实现**；G0 在其之上根治"迁到 c1/c2 仍被塌缩"的整类问题。

### 2.2 机器可验合同（G0）
- **C-G0-1 终态如实化** / **C-G0-2 触发面校准** / **C-G0-3 名实一致** / **AC-2 直接 skill 成功判定**：见 §0.3。
- **C-G0-4 回归保护**：① 真正成功且有合规 proof 的 run 仍 `accept`；② child-loop/python 长任务缺 run_state 仍判失败（不被 G0 放过）；③ direct skill 成功仍正向满足基线 proof（承接 AC-2/原 C-D1-2）。

### 2.3 改向（先定机制，三选一组合，precheck 坐定后再写）
G0 的本质是让"终态"与"取证能力"对齐，给判定器一条**如实通道**：
1. **失败因→终态**：底层动作的结构化失败（工具 `send_failed`/`errorKind`，或新 `channel-delivery-result.ts` 的交付结果）必须经**与 `skillExecutionForm` 同一条** `projectionPatch`/facts 通道到达 finalizer，落成病因码 `terminalReason`。这样"动作真失败"不再走 verdict-degraded 通道。
2. **触发面门控**：`writeTerminalOutcome` 仅在"该 run 的准则集结构上可由现有取证满足"时才允许 done→degraded。结构性不可满足时**不得**改写为 `adjudication_degraded`，但**带动作任务必须改落明确病因码**（见 C-G0-2）——门控只是把"无意义码"换成"如实病因码"，**不是**把失败放成功（caveat 不得逆转失败）。
3. **名实归一**：要么把 metric/注释改成 enforce 并补全取证（让 enforce 安全），要么退回真 shadow（只记 divergence、不改终态，把"是否失败"交给病因码通道）。**推荐 1+2+3 组合**：病因码通道承接真失败、触发面门控防止误杀、名实归一消除认知盲点。
- **precheck（开工前，只复现+定位，不改码）**：复现 w0jcej（ret=-2）、mqid6t（未暴露）两条真 run，确认它们**当前都塌缩成 `adjudication_degraded`**；沿"工具结果 → facts/projectionPatch → finalizer"定位失败因**在哪一步还在手里、在哪一步被丢/被盖**。结论写进 PR。
- **postcheck（改完验证，不属 precheck）**：改后这两条 run 落**不同的**明确病因码（如 `delivery_failed` vs `tool_unavailable`）、均 ≠ `adjudication_degraded`、均 verdict ≠ accept。

### 2.4 触点
`runtime-core/run-finalizer.ts:204-229`（改写处 + facts 通道）、`quality/task-adjudicator.ts:64-106`（verdict/blocker）、`quality/proof-collector.ts:78-143`（失败工具取证策略）、`quality/criteria-templates.ts`（触发面/不适用标注）、`runtime-core/channel-delivery-result.ts`（交付失败结构化，G0×G2 共用）、`task-projection/task-projection-sync.ts:453`（病因码→用户文案）。

### 2.5 测试（每条都要把"假成功"也堵死）
- **C-G0-1**：喂"失败 send tool_result + status=done"→ finalize → 断言 `terminalReason` ∈ 明确病因码集合（`delivery_failed`/`tool_unavailable`/`no_artifact`/`proof_gap`）、**且 ≠ `adjudication_degraded`、且 verdict ≠ accept**。
- **C-G0-2（带动作任务禁止假成功，三条全断、缺一不可）**：构造"带动作但取证结构性不可满足"的 run（send 失败 / 工具不可用）→ 同时断言：① 终态落到**明确病因码**；② **verdict ≠ accept**（堵"把失败改成 accept 也能过测"）；③ ≠ `adjudication_degraded`。**只断第③条不合格。**
- **C-G0-2b（纯问答可 accept，单独测）**：无动作 direct_answer + response-digest proof → 断言**正常 accept**，不被本门控误伤。
- **AC-2**：direct skill 成功 → 终态非 degraded、无 `s1` blocker、基线 proof 满足。
- **C-G0-4**：成功有 proof 仍 accept；child-loop 缺 run_state 仍 degraded（回归）。
- **验证**：`npm run verify:stability`（判定矩阵焦点）+ 全部 red→green。

### 2.6 非目标
不在本步重做 send-im 暴露/交付（G1/G4）；不放宽判定整体严格度（只校准触发面 + 如实化）。

---

## 3. G1 — skill 身份 + 交付上下文跨轮持久（含 AC-1 最终工具可见性）

### 3.1 根因（06-18 审查，已确证）
skill 授权只认**当前轮字面** `@[skill]`（`findExplicitlyRequestedSkills` 命中才授权）。w0jcej 轮内有 `@[Send IM]` → 授权 → 暴露 → 调用；mqid6t 是"再试一次"无 `@[Send IM]` → 不授权 → final_tools 0 个 skill 工具（toolCount=63 实证）→ 任务被分类成 research、退化 file_search。**"暴露时有时无"是确定性的，不是 flaky。** 与 D4 名字统一也强耦合（名不一致会让 allowlist 交集为空）。

### 3.2 机器可验合同
- **AC-1 最终工具可见性**：见 §0.3。
- **C-G1-X 跨轮持久**：见 §0.3——"再试一次/继续"轮 send-im 仍授权、工具仍可见、任务不被重分类。
- **C-G1-Y 重试继承交付上下文**：见 §0.3——重试继承上一轮文件资源 + 目标通道，直接进发送路径，不绕搜索/采集/present_file。
- **C-G1-2**：显式 `@[skill]` 附着（任意 runtime，含 direct）→ 本轮 `mode:'selected'`，工具名进 `allowedTypedActions` 且过 `filterToolsByAuthorization`。

### 3.3 precheck / postcheck（拆开，消除"没改码却要验证改后"悖论）
- **precheck（开工前，只复现+定位）**：复现 mqid6t（"再试一次"→ final_tools 0 个 skill 工具），在**未改码**状态下 pin 出是哪一环（授权 mode / preferred 名 / allowlist 交集 / 最终过滤）把工具滤掉。结论写进 PR。
- **postcheck（D4 后、G1 后各一次）**：D4 完成后复测——量化有多少"技能选中却无工具"已被名字统一修掉（D4 是执行序里 G1 的前置，见 §0.0）；G1 完成后复测——AC-1 / C-G1-X / C-G1-Y 全绿。

### 3.4 改向
- 以 pin 出的环为准修；若确为"附着未转本轮授权"，把显式 `@[skill]` 落成 per-turn 授权，优先于文本推断。
- **跨轮持久（r4 新，r5 扩到交付上下文）**：为"上一轮已授权的 skill"建立**有界的 sticky active-skill-context**，使"再试一次/继续"类后续轮沿用上一轮 skill 授权与身份，不重新分类成 research。**该 context 必须携带上一轮的交付意图——文件资源 refs + 目标通道**，让重试直接进发送路径（C-G1-Y），不重新搜索/采集/改道 present_file。边界：仅同 scope、仅最近一次、continue 类意图；用户显式切换或新 `@[skill]` 即覆盖。（与⑥的"continue 类回原 agent"语义一致。）

### 3.5 触点
`skills/skill-tool-authorization.ts:201-238`、`skills/skill-context-orchestrator.ts:98-143,462-465`、`runtime-core/agent-sdk-runtime.ts`（`resolveSkillAuthorizationForTurn`）、`tools/skills-tools.ts`（preferredSkillToolNames/buildToolName）、意图分类/重分类处（"再试一次"被判 research 的入口）、manifest `allowed_tools`。

### 3.6 测试 / 非目标
- 测试：AC-1 断言 final visible tools 含 `skill_send_im_file`（不准只断前段匹配）；C-G1-X/Y 两轮场景（轮1 `@[Send IM]` 授权 + 选定 4 图 + 目标"我微信" → 轮2"再试一次" → 断言仍可见、未重分类、**复用同 4 文件 + 同通道直接 send**、无搜索/采集/present_file）。
- 非目标：不做无界/跨 scope 持久；不改 reference-hint TTL。

---

## 4. G4 — send-im 交付管线（D4 名字统一 / D3 下载图→send-im / 多图 / D5-D6 测试）

> **G4 在执行序里被拆开**（见 §0.0 唯一执行顺序）：**D4 紧跟 G0 之后先做**（G1 暴露复测的前置）；**D3 + D5/D6 在 G1 之后**做。

### 4.1 D4 工具名统一（C-G4-1）
- **根因**：`buildToolName` 读 `STATIC_TOOL_NAMES`（无 send-im → 回退 `skill_send_im_send_file`）；`skill_send_im_file` 在另一张表 `STATIC_SKILL_TOOL_NAMES_BY_ACTION`；manifest/SKILL.md 写 `skill_send_im_file`。三处不一致。
- **触点**：`tools/skills-tools.ts:128-151`、`tools/skills-tools-static.ts:36`、`assets/embedded-skills/send-im/ready-skill.json`、`.../SKILL.md`。
- **改向**：首选**合并两张表为单一真源** + boot 断言；或把 `'send-im:send_file'→'skill_send_im_file'` 补进 `STATIC_TOOL_NAMES` + 两表一致断言。定名 `skill_send_im_file`。
- **测试**：`buildToolName('send-im','send_file')==='skill_send_im_file'` + 两表一致。

### 4.2 D3 下载图→send-im 确定性入口 + 多图（C-G4-2 / C-G4-3 = 旧 AC-3）
- **根因**：`resolveFile`（`send-im-skill-tool.ts:80-94,144-188`）只认 `requestEnvelope.resources` + `@[]` 提及；下载产物不进资源池，模型才绕去搜索/猜路径。
- **权威源（r3 钉死）**：投影产物层 `recentArtifacts`（持久 `task_projections.recent_artifacts_json`；`run-projection.ts:77` 装配）。**下载工具成功时主动登记** artifact（写 `projectionPatch.recentArtifacts`，带 `kind`=image/download + 绝对路径）。禁止解析上一轮文本/扫目录。**注意 `slice(-4)` 上限**：send-im 查"按 kind 过滤的媒体视图"，别让 4 图被通用 artifact 挤掉。
- **多图一等（r3）**：manifest 参数 / schema / 工具执行 / sidecar payload 四处支持多文件。sidecar `/channels/send` 的 `attachments` **已是列表**（`main.py:307-309`）→ **最小闭环 = 一次塞 N 个附件**（顺序发 N 次为备选，须显式选定并写进 SKILL.md）。
- **触点**：`tools/browser-tools.ts`（下载分支 + 登记）、`task-projection/run-projection.ts:77`、`contracts/request-envelope.ts:255-392`（仅作显式补充）、`tools/send-im-skill-tool.ts`（`selectResource`/`resolveFile` + 多附件）、`assets/embedded-skills/send-im/ready-skill.json`（加 `filePaths[]`）、`src/python/ready_sidecar/main.py:307-309` + 适配器、`src/shared/remote-im-file-intent.ts`。
- **测试**：4 张下载图经下载工具登记 → send 意图 → 断言无显式路径解析出 4 文件 → 断言最终 sidecar payload 含 4 附件；歧义场景断言结构化 disambiguation（不得 flat `file_not_found`）。

### 4.3 D5/D6 测试诚信 + hygiene
- **C-D5-1**：一条 send-im **真实路径**行为测试，从原始用户文本经真实 dispatch/授权/解析/判定，覆盖 AC-1+AC-2+AC-3+C-G1-X；不得靠 stub 抛错走 fallback、或 hardcode `resolveSkillToolByAction` pin 名。
- **C-D6-1**：`check-silent-catch.cjs` 对 `send-im-skill-tool.ts:297` 不新增违规（补注释/metric）。
- **触点**：`src/__tests__/tool-registry-skills-dynamic-resolution.test.ts`、`skill-context-orchestrator.test.ts`、`send-im-skill-tool.test.ts`、`remote-im-attachment-contract.test.ts`、`tools/send-im-skill-tool.ts:297`。

---

## 4.5 G2 — 微信发送路由/绑定诊断（ret=-2，须真机）

- **根因（已证伪大小假设）**：`ret=-2` 来自 `_raise_for_business_error`（`wechat_openclaw_adapter.py:178-187`）对后端业务码判负；大小门是独立 100MB 门（`:508-509`，3.2MB 不触发且报另一句话）。送达链：`_send_attachment`（:501）→ `_upload_attachment_to_cdn`（`getuploadurl` :560 + CDN `_post_bytes` :584）→ `_send_message_items`（`sendmessage` :479）。路由层：`routeTag/SKRouteTag`（:315）、`botAgent`（:319）、`binded_redirect`（:720）、`context_token`（:480）。
- **机器可验合同**：C-G2-1 错误如实归类（endpoint 维度可定位 + 含路由配置态）；C-G2-2 真机送达（人工）。
- **前置核验**：抓 w0jcej 的**原始** endpoint 与响应（确认 -2 出自 `getuploadurl` 还是 `sendmessage`），看是否 `context_token` 缺失/过期或 `routeTag/botAgent` 未配。
- **改向**：先把 -2 如实化（不再让模型臆测大小）；按 pin 出的环修配置/路由/绑定刷新；图片 `image_item` 加密协议正确性属 L4，真机另议。
- **触点**：`src/python/ready_sidecar/channels/wechat_openclaw_adapter.py`（路由/错误归类）、`runtime-core/channel-delivery-result.ts`（交付结果如实回灌，G0×G2 共用）、`tools/send-im-skill-tool.ts`（把交付失败结构化传回）。
- **非目标**：不做大文件分片/转码；不改图片加密协议本身。

---

## 4.6 G3 — 兜底纪律（present_file 不得冒充发微信）

- **根因**：mqid6t Send IM 不可用时，模型尝试 `present_file` 代替"发到微信"（两者非同一交付方式）。
- **机器可验合同 C-G3-1**：发送通道不可用时，模型应如实报"发送通道不可用"并停在该病因，**不得**改道本地展示/打开类工具冒充送达。
- **改向**：在 send-im 域 system-reminder / skill 描述里写明"present_file ≠ 发送到 IM"；若有策略层（action-confirmation 或工具策略）可加一条"IM 交付意图下禁用展示类工具顶替"的裁决。
- **触点**：send-im 域提醒注册处、`assets/embedded-skills/send-im/SKILL.md`、（如走策略）`agent-control/safety` 或工具策略层。
- **测试**：行为测试——Send IM 不授权/不可用 + 用户"发到微信"意图 → 断言模型路径不落到 `present_file` 充当送达（或策略层拦截）。

---

## 4.7 主链路总验收（全满足才算完成）
- [x] **G0**：C-G0-1/2/3/4 + AC-2 各有行为测试且 green。
- [x] **G1**：AC-1 + C-G1-X + C-G1-Y + C-G1-2 green。
- [x] **G4**：C-G4-1/2/3（D4/D3）+ C-D5-1/C-D6-1 green。
- [x] **G3**：C-G3-1 green。
- [x] **G2 错误如实化**：`ret=-2` 已定位到 `sendmessage` 并写回频道错误；非大小/类型。
- [ ] **G2 真机送达**：当前仍被微信 `sendmessage ret=-2` 拒绝；需要微信侧刷新出站会话或重新绑定后再跑全量送达矩阵。
- [x] `npm run typecheck` 无新增错误；`npm run verify:stability` 不回归；`verify:send-im-l1` green。
- [x] 未触碰 ⑥/Phase 3（无 killed:false 改动、无 client registry、无移动端代码）。

### 4.8 2026-06-18 真实运行验证记录

- 短文本探活：`agent.sendChannelProbe('channel-wechat-openclaw-default', ...)` 返回 `微信出站发送会话已失效：ret=-2 (sendmessage)`；随后 `runtimeStatus.channels.errors` 从 0 变 1，`agent_channels.last_error` 写入同一病因。
- 历史提示词变体：`@[Send IM]把 /Users/user/实验田/ready-cowork/outputs/send-im-live-20260618-135029/ready-send-im-live.md 发到我微信` 通过真实 Electron `agent.sendScoped` 执行；日志显示 `localSendIm=true`、浏览器采集 `exposure=false`、最终工具列表含 `skill_send_im_file`、实际工具调用为 `skill_send_im_file`。
- 终态：该 run `terminalReason=delivery_failed`、`toolCallsUsed=1`，没有再塌缩成 `adjudication_degraded`，也没有绕到 `present_file`。
- adapter 核验：本地账号有 `userId` 与 context token；真实短文本也失败，所以不是附件大小、PDF/视频类型、目标 userId 缺失，剩余阻塞在微信/OpenClaw 出站发送会话或绑定态。

---

## 5. Problem A（⑥）— renderer 改为"对账式 client"（单独排，本轮不动代码）
- 合同：终态账本写入与所有 client 可见收口必须可对账；任一 client 丢终态事件后能从权威投影自愈。
- 方向：client registry 逐 client 派发（替代裸 `mainWindow.webContents.send`，带已确认序号）；renderer `isStreaming/scopeRunState` 从 `task_projections`+终态对账派生；mount/focus/重连拉权威快照对齐。
- **停止键**：点击触发权威投影对账，后台无活动 run 则按投影强制清 streaming；**禁止**沿 `killed:false`。
- 触点：`runtimeDriver.ts:1467-1485`、`ipc-handler.ts:1557-1568`、`agent-lifecycle-group.ts:254`、`runtime.ts`（scopeRunEvent 发射）。
- 移动端预留（架构审查 §5.3，**非零成本**）：对账读写成 `getScopeRuntimeSnapshot` + `onScopeRuntimeChanged`（client-agnostic、带序号）；投递经 client registry；active scope/草稿 per-client 化。

> 注：⑥ 与 G0 共享"跨边界状态显式建模 + 可对账"哲学，但 G0 治**主进程内**终态如实化、⑥ 治**主↔renderer**可见收口，两者独立可分别落地。

---

## 6. Problem B / Phase 3（本轮不动代码或仅 B1）
- **B1（提示词层，可先做）**：okf-bundle/okf-library 的 `SKILL.md` 显式指示用 `skill_write_artifact`（写 .md/index.md/log.md 到输出目录）+ `skill_run_shell`（跑 `okf_tools.py validate/index`）。验收：dogfood 能产多文件 bundle 且 validate CONFORMANT。
- **B2（工具化，后做，需测试）**：B1 不足则 `okf_tools.py` 增 `scaffold/init` 子命令建骨架 + 行为测试；或升为 python typed action skill（对照 video-expert）。不动 fence 机制本身。
- **Phase 3 移动端/iPad**：本轮仅"预留方向"，随 ⑥ 落 client-agnostic seam。分阶段：阶段0 状态权威化（随⑥）→阶段1 只读镜像 MVP →阶段2 双向（复用 IM inbound）→阶段3 协同编辑（op-log/CRDT）。鉴权复用 sidecar `X-Ready-Token` + 仿微信扫码 pairing，不裸开端口。

---

## 7. 提交与回滚纪律
- **先按 §1.5 归档现有工作树改动**，再据此拆/补 commit——现存改动按 G 归类后纳入对应 commit、缺的部分新写；**不是**从零造（工作树已有 ~44 文件改动）。
- 逐项独立 commit，**顺序 = §0.0 唯一执行顺序**：G0 / G4·D4 / G1 / G4·D3 / D5-D6 / G3 / G2-如实化 / B1 各一，commit message 写清对应合同编号（C-G0-n / AC-n / C-G1-X/Y / C-G4-n …）与归档/precheck 结论。
- 不扩面：单 commit 只碰该项触点；顺手能改的无关项记 TODO。
- 任一步 `verify:stability` 回归或新增 gate 红 → 停下定位，不靠削弱测试过关。

## 8. 风险登记
- **R0（G0，最高）**：触发面校准/如实化做不好会两头翻车——放太松漏判真失败，收太紧把成功判失败。C-G0-4 三条回归（成功仍 accept / 长任务缺 run_state 仍失败 / 基线 proof 仍须满足）+ precheck 用真 run 双码区分守住。
- **R1（G1）**：跨轮 sticky 授权写太宽会越权暴露 skill → 边界（同 scope + 最近一次 + continue 类 + 显式覆盖）+ 行为测试守。
- **R2（G2）**：根因未 pin（endpoint/绑定）就改 → 强制前置核验抓原始响应；真机另验。
- **R3（G4-D3）**：产物登记 + 多附件跨多文件改面 → 权威源钉死 `projectionPatch.recentArtifacts`（单一写入口）；多图走 sidecar 已支持的 `attachments` 列表；`slice(-4)` 按 kind 过滤媒体视图。
- **R4（顺序）**：G0 不先做则 G1/G2/G4 修好也被症状塌缩掩盖、无法验真 → 严格 G0 优先。
- **R5（⑥）**：碰可见收口红线，独立 plan + `verify:stability`，不并进本轮。
