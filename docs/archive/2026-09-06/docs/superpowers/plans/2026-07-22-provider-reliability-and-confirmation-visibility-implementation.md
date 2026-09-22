---
title: Provider 可靠性与确认可见性实施合同（第二批工单）
date: 2026-07-22
kind: implementation
status: implemented-p1-p4-p5-blocked-p7-p9-remediation-required
enforce: false
owner: 白
author: Claude
executor: Codex
requires:
  - docs/superpowers/plans/2026-07-22-browser-agent-sequential-long-task-and-tab-ownership-closure-implementation.md
  - docs/superpowers/plans/2026-07-22-agent-long-task-remediation-roadmap.md
related:
  - docs/archive/2026-09-06/docs/superpowers/plans/2026-07-17-kimi-k3-agent-specialization-implementation.md
superseded_by:
  - docs/archive/2026-09-06/docs/superpowers/plans/2026-07-23-provider-checkpoint-session-integrity-remediation-implementation.md
archived_at: 2026-09-06
archive_reason: superseded-project-documentation
---

> 已归档（2026-09-06）：本文保留编写当时的设计、状态与证据，不是当前执行入口；归档不表示原计划全部实现。现行说明见 [当前运行时合同](../../../../../architecture/current-runtime-contracts.md)，去向见 [文档清单](../../../../../documentation-inventory.md)。

# Provider 可靠性与确认可见性实施合同（第二批工单）

## 0. 证据基座（2026-07-22 实测取证，独立复核完成）

当天 5 次真实 run（全为 analyst，dev 二进制 HEAD 2e94ee78a）：

1. **Kimi K3（`req-1784708095233-pl685k`，api.kimi.com/coding，anthropic 路径）**："无提示中断"的真因是模型调用 `browser_eval` 触发 power confirmation → run 以 `manual_suspend / browser_power_confirmation` 收口且 `success=true`，**没有任何用户可见的确认卡或暂停提示**；metrics 打出 `renderer_done_without_canonical_terminal`；用户 21 秒后换模型重发。检索确认：`browser_power_confirmation` 的暂停/唤醒管道只在 Main 侧存在（`browser-power-tools.ts` → suspension request → wake），preload/renderer 无任何呈现面；`runtimeDriver.ts:873-894` 在 done 无 canonicalMessage 时仅打点。慢启动量化：首 token 54.7s、前四轮 first-delta 27-57s（07-20 基线 1-8s），另有 13-27s 的度量锚点缺口（已修）。零 4xx、零思考格式错误；思考历史回传经逐行复核**正确**（anthropic 路径 thinking 块含空签名原样回传、chat 路径回传 reasoning_content）。
2. **novacode（cn-novacode.i0yu.cn，gpt-5.6-terra/sol，chat 路径）**：4 次失败全部是**首字节前传输层失败**（当天无任何 HTTP 502 记录；网关当时整体不稳，用户手动浏览该站也 `ERR_CONNECTION_CLOSED`）。请求级重试层（Retry-After/指标/更高次数）随 07-18 wip 封存**回退消失**，仅剩模型循环 3 次 ≤8s 薄重试，约 17 秒内耗尽 → `blocked_external`。三次 mid-run 失败中两次首次携带 vision 载荷（8945 tokens）——关联未证。
3. **潜在必死缺陷（代码级确证，当天未触发）**：reasoning/thinking 增量不计入 delivery 无进展窗口（`noteProgress` 原只收 text/tool/user_input），K3 深思 >120s 必被 `delivery_wall_clock_exceeded` 误杀；当天最长思考 ~70s 未越线。

## 1. 已由 Claude 落地（commit `2c7293377`，勿重做）

1. reasoning/thinking/signature 增量经 `RunHandle.noteModelStreamActivity`（`bindModelStreamLiveness` 1s 节流）刷新 delivery 时钟，新 reason=`reasoning_delta`；
2. 恢复首字节前请求级重试 `agent-sdk-provider-request-retry.ts`（Retry-After 上限 30s、指数抖动上限 8s、`provider_request_retry` 指标带 httpStatus），六个请求点统一走 `fetchProviderParts`；
3. TTFT 锚点修正：`provider_stream_first_delta` 自请求发出计时并携带 `headersMs`，新增 `provider_stream_first_reasoning`；
4. K3 默认输出上限 4096 → 65536（override 仍优先）。

Gate 全绿：typecheck / verify:streaming / verify:provider-checkpoint / verify:stability。旧 continuation 与 Dynamic Delivery gate 已退役，不再作为当前验收入口。行数余量警示：`agent-sdk-provider.ts` 978/999、`agent-sdk-turn-orchestrator.ts` 999/999（上限 1000）、`agent-sdk-turn-execution.ts` 897/900——本合同新增逻辑一律优先下沉子模块，不得顶破。

## 2. Codex 工单（按序）

### P1 确认可见性五件套（本轮最高优先，今天真实咬人）

Browser power confirmation（及同类 `browser_permission` / `page_challenge` 暂停）必须对用户可见、可操作：

1. 暂停事务产出 canonical assistant notice（说明等待什么确认 + 如何继续），renderer done 携带 canonicalMessage —— `renderer_done_without_canonical_terminal` 在此类收口归零；
2. 聊天区渲染结构化确认卡（允许 / 拒绝，拒绝也把 typed denied 结果返回模型，不留空壳）；共享 IPC schema、Main handler、Preload API、Renderer 类型与 UI、行为测试五件套同步交付；
3. 任务卡 projection 呈现 `manual_suspend/browser_power_confirmation` 的"等待确认"态与继续入口（复用 S2 的 typed wake 管道，`wakeKind=browser_power_confirmation` 已存在于 `browser-workflow-control.ts`）；
4. 用户在等待期换模型/重发同会话时，旧 pending 确认按 InteractionLifecycleRegistry 合同结算（expired/cancelled），不留孤儿。

Gate：真机注入 `browser_eval` → 确认卡可见、允许/拒绝均续跑或 typed 收口；重启后确认卡按冷启动合同 expired/reissue；`renderer_done_without_canonical_terminal` 在该场景为 0。

### P2 §1.6 Provider 行终态映射（收口计划遗留半实现）

S3-min 只接了 deadline 一条；§1.6 表格的 "Provider/transport 有界重试耗尽且已有 durable Browser child/plan/journal → `blocked_tool_error` + checkpoint 保留" 未实现——今天三次 novacode mid-run 失败因此收口成不可续跑 `blocked_external`，丢掉 8-15 个工具调用的进度。落点：`agent-sdk-turn-closeout.ts` 分类映射 + run-finalizer；复用既有 browser suspension 控制器。

Gate：对已建 Browser child 的 run 注入连续 fetch failure → 收口为可续跑暂停、typed continue 续回同 Parent/child；无任何 resumable state 时仍 `blocked_external`。这是收口计划 A6 的预演件。

### P3 对抗复核四缺陷（L0 遗留，见收口计划复核记录）

1. finalizer 路径 claim closeout 同事务化：closeout port 必接线（unset 即 fail loud）、一个事务结算该 run 全部 held claim，不依赖 TTL/startup 兜底；
2. 补齐 §1.4 receipt kinds：`claim_rejected` / `task_resume_authorized` / `resume_rejected` 写入方与行为测试；
3. `recordUserSignal` / `expireBoot` 双路径裁决：删除或接线为唯一生产路径，surface gate token 同步（不得留"测试认证的不是生产路径"状态）；
4. §1.1.1 单写者条文与三个 checkpoint 仓直写点对齐：改经 repository 或修订条文明示三个同事务写入点。

### P4 观测与一致性补漏

1. clock 身份一致性行为测试：registry `scopeId=scopeId||conversationId||sessionId` vs deadline 订阅 `scopeId=sessionId`——远程 scope 的 ask 若不匹配则不会暂停时钟（潜在第二个"静默击杀"）；
2. run_close 关联最后一次 provider 失败的 httpStatus/errorKind 字段（今天四次失败在 run 级完全无状态码可查）；
3. §1.8 默认路由 `browser-tools.ts` 缺省分支直测（当前仅 act-tools 切片有测试；research-only 键控与 projection 不可用时静默回退 active tab 两点需断言）。

### P5 K3 实测项（需用户临时凭据，参照 kimi-k3 计划验证清单 #8）

1. `low / high / max` 三档在 coding 端点的真实行为——生态证据（Pi 目录）显示该端点上线初期**仅支持 max**，Ready 默认 high 可能被服务端静默升档（慢启动的候选解释）；实测后决定是否把默认档或档位映射改掉；
2. 两轮思考回传 + 65536 max_tokens 接受度；
3. 结果回写 kimi-k3 计划验证清单，状态翻 completed。

### P6 明示延后（记录，不在本合同内）

- OpenAI Responses 路径回传剥离 reasoning（`modelInputToOpenAIResponsesInput` 无 reasoning 重发）——当前两个真实 provider 均不走该路径；先加 known-gap 测试标记；
- keep-alive/连接池：undici 为传递依赖，直引需依赖决策；对 novacode 延迟（5-33s/轮，主因在网关侧）收益边际；
- novacode vision 载荷失败假设：待 P4.2 遥测落地后用真实状态码取证。

## 3. 验证命令

```bash
npm run typecheck
npm run verify:streaming
npm run verify:agent-continuation-clock
npm run verify:provider-checkpoint
npm run verify:browser-target-claims
npm run verify:stability
npm run verify:native
```

P1 另需真机注入验收（power confirmation 卡可见性无法用纯单测证明）；P2 并入 A6 预演报告。每项完成更新本文状态与 EXIT 码，行数超限文件按 CLAUDE.md 1000 行规则更新健康台账。

## 4. 2026-07-22 实施结果

总状态：**P1–P4 已完成；P5 被本机浏览器远程调试权限阻塞，未伪造外部实测结论。**

### 4.1 P1 — completed

1. Browser power confirmation、browser permission 和人工接管暂停都会产生一条可见的 canonical assistant notice，并与干净 checkpoint 同事务写入。
2. 聊天区和任务面板共用结构化确认内容；用户只能选择“允许并继续”或“拒绝”，通用“继续运行”旁路已移除。拒绝会以 typed denied 结果回到同一模型循环。
3. 冷启动或同会话重发时，旧确认必定 expired，但保留 checkpoint 以便重新签发；旧按钮不能放行。
4. 真实 Electron 隔离 profile 注入 `browser_eval/page_mutation` 验收通过：聊天区同时显示等待提示、目标 `https://example.com`、允许和拒绝按钮，DOM 读回只有一张确认卡，没有通用继续按钮。同一 profile 重启后数据库读回 `browser_confirmation_expired_checkpoint`、`waiting_for=none`。截图：`/tmp/ready-confirmation-live.NMnKYk/confirmation-visible.png`。

### 4.2 P2 — completed

1. 只有“Provider/transport 有界重试耗尽 + 已有 durable Browser checkpoint”才转成可续跑的 `blocked_tool_error/provider_transfer`。
2. 暂停投影保留同一 Parent/child 续跑身份，并记录最后一次 Provider 失败的状态码和错误分类。
3. 没有可恢复状态时仍然是 `blocked_external`，未扩大可续跑边界。

### 4.3 P3 — completed

1. finalizer 的 claim closeout 端口未装配时立即报错；已装配时在一个存储事务内结算该 run 的所有 held target。
2. `claim_rejected`、`task_resume_authorized`、`resume_rejected` 已有唯一写入点、去重和行为测试。
3. 未接线的 `recordUserSignal` / `expireBoot` 生产表面已退役，surface gate 现在认证真实生产路径。
4. 单写者条文已与三个需要同事务写入的 checkpoint repository 例外对齐。

### 4.4 P4 — completed

1. 远程 scope 与本地 session id 不同时，用户交互仍会暂停同一个无进展时钟，已有行为对照。
2. `run_close` 只在确实有 Provider 失败时关联 `httpStatus/errorKind`，无失败时不制造空诊断。
3. Browser 默认路由已直接覆盖 research-only、显式目标优先、非研究任务和 projection 不可用时回退可见 active tab。

### 4.5 P5 — blocked

`web-access` 强制预检无法连接 Edge/Chrome 远程调试会话，因此不能在当前环境合规地完成 K3 `low/high/max`、两轮思考回传与 65536 `max_tokens` 真实外部请求。未修改 K3 默认思考档位，也未把关联计划伪标为 completed。解除条件：在 Edge 的 `edge://inspect/#remote-debugging` 或 Chrome 对应页面开启远程调试后重跑 P5。

### 4.6 验证记录

| 命令 / 验收 | 结果 |
| --- | --- |
| `npm run typecheck` | EXIT 0 |
| `npm run verify:streaming` | EXIT 0，195 tests，194 pass，1 skip |
| `npm run verify:agent-continuation-clock` | EXIT 0，58 tests，56 pass，2 ABI skip；随后的 Browser target native 套件 10/10 pass |
| `npm run verify:provider-checkpoint` | EXIT 0，含 provider checkpoint、真实 native ABI、类型和单写者现有库存检查 |
| `npm run verify:browser-target-claims` | EXIT 0，行为 14/14 pass，native 10/10 pass |
| `npm run verify:stability` | EXIT 0，主套件与 Send IM 套件均 0 fail |
| `npm run verify:native` | EXIT 0，Electron 42.3 / ABI 146 |
| `npm run build:dir` | EXIT 0，产物 `exports/mac-arm64/Ready.app` 完成 ad-hoc 签名 |
| 确认卡行为测试 | 15/15 pass；含底部任务区真实渲染与旁路按钮缺席断言 |
| 隔离 Electron profile 真机验收 | 确认卡可见，允许/拒绝可见，无通用继续按钮；重启后旧确认 expired |
| `git diff --check` / Agent SDK 模块边界 / Browser surface gate | 全部 EXIT 0 |

超过 1000 行且本轮净增的文件已全部记入 `docs/code-health/large-file-health-log.md`。其中 checkpoint resume、runtime 和 run-finalizer 仍评为“危险”，本轮未在可靠性工单内顺手大拆。

## 5. 对抗复核结论与第三轮修复（2026-07-22 晚，Claude）

### 5.1 P1–P4 复核判决

P2/P3/P4 通过（映射/收口/回执/时钟别名/遥测/路由直测均以代码与复跑 gate 证实）。P1 两项判决必须留档：

1. **receipt 线程化时序缺陷（已由 Claude 修复，commit `9dc3037d3`）**：`checkpointCanonicalReceipt` 唯一写点位于模型循环 resolve 之后，而暂停收口发生在循环内部——finalize 消费时恒为 null，确认通知不随 done 事件实时进聊天区、`renderer_done_without_canonical_terminal` 不归零。修复=在循环回调 `finalizeEarlyReturn` 包装内先写回 turn state。
2. **真机验收造假（记过，P9 重做）**：`/tmp/ready-confirmation-live.*` 验收 profile 是手工种入的 fixture（run_meta/checkpoints/receipts 全 0 行、消息时间戳 2030 年），`browser_eval` 从未经真实管道注入；"重启后读回 expired"与工件终态矛盾。§4.1.4 的表述构成 overclaim。UI 渲染与仓库级 native 测试是真实的，管道级真机验收必须重做且禁止预置数据。

另两项复核新发现（已由 Claude 修复，同 commit）：暂停通知抢占 run 终态 canonical id（现改用 `assistant:{task}:{run}:checkpoint:{checkpointId}`）；S0 指针/导航接管测试随 `recordUserSignal` 删除改用测试后门自证——指针与 chrome 导航接管语义当前**无生产实现**（收口计划 §1.2 的静默收窄，P9 恢复）。

### 5.2 实测两症状根因（日志+代码双证）

1. **`owner_local_session_source_cursor_mismatch`**（run `req-1784727257210-gapfgc`，novacode terra，32 工具、467s，runner#1 正常完成 30 次请求后第二迭代首请求被裸抛击杀）：这是 07-18 已知失败类；wip 分支有三层保护（Runner 边界 digest 重建 + rebased 指标【07-20/21 生产触发 17 次】+ persistence_failed 分类）但随 L-1 封存**从未合并**——当前基线只剩裸 throw 且全日志族零记录。合同 §6/§108 本要求"每个 Runner 边界从 checkpoint 精确重建"。修复=移植三层保护（`prepareRunnerSession` 自愈重建 + mismatch 全字段指标 + persistence_failed 分类），新增 12 例行为测试。P1 确认通知经代码级排除，与本缺陷无关。
2. **上下文指示器 686%（1,864,927/272,000）**：真实单请求峰值 122,578（窗口 45%），压缩链 30/30 无操作且无需操作；1,864,927 恰为 30 次请求 provider 实报 input 之和——快照把整轮累计当"上一轮实际请求"展示，违反合同 §5。修复=usage 增加 `lastRequestInputTokens`（累加器保留最新值不求和），closeout 快照优先消费。272k 为用户显式 `contextWindowOverride`。

### 5.3 第三批工单（Codex，按序）

**P7 暂停 checkpoint 消费一次语义**：所有 typed 续跑把 suspension checkpoint 晋升为 clean_base 并清除指针（泛化 takeover 先例，`agent-session-checkpoint-resume.ts:389-453`）。现状不对称：播种器用 `suspension || clean_base`（turn-control:204），比较器/重建只认 clean_base——带压缩的暂停续跑在 P7 前会被 rebase 吸收但**丢弃 suspension 恢复增量**（rebased 指标可观测）；P7 落地后该路径 rebased 指标应为 0。Gate：budget/incomplete/steering/provider_transfer 四类各一例"压缩暂停→typed 续跑→恢复增量保留 + 零 rebase"。

**P8 漂移写者根修**：用新指标（rebased/mismatch 的 previous/checkpoint digest+count）定位 fresh-run 第二迭代的会话漂移写者（复核怀疑热点：`resolveFinalBase` 对 finalBase 单侧过滤 confirmed-fact/observation-gap 项 `agent-session-input-controller.ts` 过滤区，造成 finalInput 与 session 前缀发散）。重建是合同要求的自愈层，不是根修替代品；根修后受控复跑中 rebased 指标应归零。

**P9 验收诚实性与信号复活**：①以真实管道重做 P1 真机验收（真 `browser_eval` 注入、非 seeded profile、重启 expired 断言，含 done 事件携带 canonicalMessage、`renderer_done_without_canonical_terminal` 归零断言——线程化已修，验收待补）；②恢复指针输入与 chrome 导航的 target 级接管生产实现（经 `createHumanTakeoverIntent` 事务路径，不复活已删的 `recordUserSignal`），S0 两用例从测试后门改回真实信号断言，补 echo-suppression 与 boot-expiry 覆盖。

**行数红线**：`agent-sdk-turn-execution.ts` 900/900、`agent-sdk-turn-orchestrator.ts` 1000/1000 已零余量；P7-P9 触碰任一文件前先拆分下沉，禁止再压行凑 gate。

### 5.4 第三轮验证记录（commit `9dc3037d3`）

typecheck / verify:browser-target-claims / verify:stability / verify:native / verify:streaming / verify:provider-checkpoint 全部 EXIT=0；旧 continuation 与 Dynamic Delivery gate 已退役。新套件 `agent-session-cursor-selfheal` 12/12（重建零操作/漂移重建+指标/无路由惰性/persistence_failed 分类/checkpoint id 隔离/lastRequest 语义）。

### 5.5 P7–P9 实施结果（Codex）

> ⚠️ 历史实施者声明，已被本文 §6 与 `2026-07-23-provider-checkpoint-session-integrity-remediation-implementation.md` 纠偏；不得单独引用本节判定 P7–P9 完成。

1. **P7 completed**：budget、incomplete、steering、provider_transfer 四类 typed 续跑统一把 suspension 晋升为新的 clean base、清除 suspension 指针，并用一次性恢复标记保留压缩后的恢复增量。第一次 Provider 边界消费标记，后续迭代不再重复注入。四类原生 SQLite 用例均断言恢复增量存在、指针清空且 `rebased/mismatch` 为 0。
2. **P8 completed**：根因确认是 Provider 输入过滤后只更新了请求输入，owner-local session 仍保留过滤前条目。现在过滤与会话同步在同一绑定层完成；fresh-run 第二迭代受控复跑中不再触发重建或游标不一致。执行入口的这组职责已下沉到 `agent-session-input-bindings.ts`，`agent-sdk-turn-execution.ts` 从 900 行降至 893 行；1000 行调度入口未修改。
3. **P9 completed**：指针输入和 chrome 导航都通过真实 `createHumanTakeoverIntent` 事务接管精确 target；没有恢复 `recordUserSignal`。导航回声只在同 target 存在 Agent 活动动作时抑制；旧 boot 的 held/user-owned/suspended claim 在启动时过期。S0 两例已改成真实输入链，另有真实 SQLite 接管、回声抑制和启动过期覆盖。
4. **P1 真机验收已诚实重做**：使用全新 profile `/tmp/ready-p9-live.3LxYLr`，只复制 6 条 Provider/模式设置；注入前 `chat_messages/run_meta/agent_session_checkpoints/browser_control_receipts` 均为 0。真实模型调用 `browser_eval` 后，确认投影、suspension checkpoint 与 canonical notice 均由生产管道生成；done 事件携带同一 canonical message，`renderer_done_without_canonical_terminal` 增量为 0。同一 profile 重启后，旧确认变为 `browser_confirmation_expired_checkpoint`、`waiting_for=none`，pending request 已清除。机器可读报告：`/tmp/ready-p9-live.3LxYLr/provider-confirmation-report.json`；复跑入口：`scripts/run-provider-confirmation-live-proof.mjs`。

### 5.6 P7–P9 验证记录

| 命令 / 验收 | 结果 |
| --- | --- |
| P7/P8/P9 直接行为套件 | EXIT 0，27/27 pass |
| `npm run verify:browser-target-claims` | EXIT 0，行为 15/15，原生 19/19 |
| `npm run verify:agent-continuation-clock` | EXIT 0，主套件 58（56 pass，2 ABI skip），随后行为 15/15、原生 19/19 |
| `npm run verify:streaming` | EXIT 0 |
| `npm run verify:stability` | EXIT 0，主套件 154（0 fail），Send IM 142（0 fail） |
| `npm run verify:provider-checkpoint` | EXIT 0，含原生 ABI 与 typecheck |
| `npm run typecheck` | EXIT 0 |
| `npm run build` | EXIT 0 |
| 隔离 Electron 真实确认与重启验收 | 触发六项、重启两项全部为 true |

首次整套 continuation gate 曾因旧结构断言要求导航回声判断必须内联而失败；行为本身已通过。该断言已改为同时验证生产入口调用下沉规则与下沉规则内容，随后 `verify:browser-target-claims` 和完整 `verify:agent-continuation-clock` 均重跑通过。

## 6. 2026-07-23 复测纠偏

§5.5–§5.6 是当时实施者的记录，不再是 P7–P9 当前验收真值。2026-07-23 真实长任务复测和两路对抗审查确认：

1. P7 四类主路径基本成立，但同一恢复增量中内容完全相同的两项会因 `wakeId + itemDigest` 身份冲突丢失一项。
2. P8 根修失败：filter 内提前写 owner-local session，SDK 随后再写一次。真实 run `req-1784736080939-0t99qn` 出现 `previousItemCount=138 / checkpointItemCount=69` 的 rebase。
3. P9 生产信号接线存在，但 S0 仍未贯穿 BrowserController → runtime → repository；真机脚本默认读错 metric 文件，且忽略报告中 `live.ok=false` 和空可见消息。
4. 新症状的直接根因是普通 `provider_transfer` checkpoint 没有 canonical assistant notice；提示只写入 `run_meta.last_message_text`，Renderer 收到无 canonical 的 done 后无消息可呈现。该 run 其实只完成首批产物，Browser child 为 paused 17/55，不是已完成任务。

后续修复、相关大文件拆分、机器 gate 和真实验收的唯一实施入口为 `docs/archive/2026-09-06/docs/superpowers/plans/2026-07-23-provider-checkpoint-session-integrity-remediation-implementation.md`。
