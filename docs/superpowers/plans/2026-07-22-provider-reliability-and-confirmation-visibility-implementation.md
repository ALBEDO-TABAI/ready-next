---
title: Provider 可靠性与确认可见性实施合同（第二批工单）
date: 2026-07-22
kind: implementation
status: implemented-p1-p4-p5-blocked
enforce: true
owner: 白
author: Claude
executor: Codex
requires:
  - docs/superpowers/plans/2026-07-22-browser-agent-sequential-long-task-and-tab-ownership-closure-implementation.md
  - docs/superpowers/plans/2026-07-22-agent-long-task-remediation-roadmap.md
related:
  - docs/superpowers/plans/2026-07-17-kimi-k3-agent-specialization-implementation.md
---

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

Gate 全绿：typecheck / verify:streaming / verify:agent-continuation-clock / verify:dynamic-delivery / verify:stability，触及套件 31/31。行数余量警示：`agent-sdk-provider.ts` 978/999、`agent-sdk-turn-orchestrator.ts` 999/999（上限 1000）、`agent-sdk-turn-execution.ts` 897/900——本合同新增逻辑一律优先下沉子模块，不得顶破。

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
npm run verify:dynamic-delivery
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
| `npm run verify:dynamic-delivery` | EXIT 0，含 agent foundation、真实 native ABI、类型和单写者现有库存检查 |
| `npm run verify:browser-target-claims` | EXIT 0，行为 14/14 pass，native 10/10 pass |
| `npm run verify:stability` | EXIT 0，主套件与 Send IM 套件均 0 fail |
| `npm run verify:native` | EXIT 0，Electron 42.3 / ABI 146 |
| `npm run build:dir` | EXIT 0，产物 `exports/mac-arm64/Ready.app` 完成 ad-hoc 签名 |
| 确认卡行为测试 | 15/15 pass；含底部任务区真实渲染与旁路按钮缺席断言 |
| 隔离 Electron profile 真机验收 | 确认卡可见，允许/拒绝可见，无通用继续按钮；重启后旧确认 expired |
| `git diff --check` / Agent SDK 模块边界 / Browser surface gate | 全部 EXIT 0 |

超过 1000 行且本轮净增的文件已全部记入 `docs/code-health/large-file-health-log.md`。其中 checkpoint resume、runtime 和 run-finalizer 仍评为“危险”，本轮未在可靠性工单内顺手大拆。
