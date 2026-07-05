---
title: Phase I P0 — 远程确认链路（微信侧 ask/confirm 卡往返）实施合同
date: 2026-07-05
status: implemented
enforce: true
---

> 实施记录（2026-07-05 当日）：A-G 七件全部落地。codec 7✓ + service 行为网 5✓
> （提交/指引/取消/未命中/转投双向）+ 守卫 skip；typecheck 0；verify:stability 0；
> build 绿。frozen-call-release 的 login-fill 超时一例经 HEAD 隔离 worktree 复验
> 为既有红（同点同错），非本实施引入。渠道模块的 electron 值导入改为
> createRequire 惰性解析（database.ts 先例），模块自此可被纯 Node 行为测试导入。
> 待真机（真微信）验收往返，观测点见文末清单。

# Phase I P0：远程确认链路实施合同

> 调研锚：`2026-07-05-phase-I-wechat-remote-parity-survey.md` 切面 2（P0，硬阻断）。
> 现状：ask/confirm 卡机制完备（store/emitter/persistor/renderer 齐全，frozen-call 复用同一
> 卡机制），但唯一出口是本地 renderer push（`claude-bridge/ipc-handler.ts` 注册的
> `agent:askUserQuestions:push`），答案唯一入口是本地 IPC submit。远程 run 命中 M2/M3 或模型
> 反问时：卡只到本地、微信用户看不到也答不了，run 挂到 TTL 作废。

## 合同条款（可机器验证）

1. **卡→渠道转投**：`AskUserQuestionsCardEvent`（自带 scopeId/sessionId）经
   `agent_channel_threads` 反查（新增 `DatabaseManager.getAgentChannelThreadBySession`）命中
   远程线程时，必须把卡序列化为纯文本经 `sendChannelReply` 投递到 (channelId, remoteThread)。
   本地 renderer push 原样保留（双出口，本地卡仍是真值 UI）。非渠道 scope 零行为变化。
2. **文本编解码是纯函数**：`remote-confirmation-codec.ts` 只做 string ↔ AskUserAnswer[]
   变换，无 IO、无 LLM。选项以编号呈现；解析接受编号/选项原文/唯一前缀，多选空格分隔，
   多题按行分隔；`取消/跳过/skip/cancel` 整词 = 取消卡。解析失败返回结构化错误提示文案，
   绝不猜测。
3. **入站答案拦截**：`flushInboundChannel` 在 slash 命令之后、新 run 派发之前查
   `AskUserQuestionsStore.findPendingForScope(scope.id)`（新增，按 scopeId||sessionId 匹配）。
   命中 pending 卡时本条入站消息**必须**走答案路径（提交/取消/格式指引三选一，全部回
   渠道回执），**不得**派发新 run——scope 内 run 正被该卡阻塞，"当新任务跑"是伪并发。
   无 pending 卡时行为与现状逐字节一致。
4. **提交复用唯一决策机**：答案落地必须经 `submitAskUserQuestionsAnswersCore` /
   `cancelAskUserQuestionsCardCore`（与本地 IPC、frozen-call respond 同一 core），DB 先行、
   store.resolve 在后的既有顺序不变；不新增第二条答案写路径。提交成功后与本地路径同构地
   调 `refreshActiveRunProgress`。
5. **失败要响亮**：转投失败（无线程映射/发送失败）记 metric 不阻塞卡本身（本地仍可答）；
   提交失败（过期/行丢失）必须回渠道说明，不静默吞消息。
6. **最小传话铁律不受影响**：拦截路径只消费用户原话做解析，原话仍逐字落
   conversation message（meta.source=channel 既有形状）。

## 边界（本合同不做）

- 进度投影/续跑（P1）、ret=-3 在线语义（P2）、附件双向（P3）、remote_channel profile
  接线（P4）。
- browser_ask_user_takeover / waiting_human 的渠道触发面（依赖 P1 的事件桥渠道 sink）。
- 微信真机往返验收（用户回来后做；本合同交付桩测全绿 + 真机观测点清单）。

## 实施件

| 件 | 文件 | 内容 |
|---|---|---|
| A | `database.ts` | `getAgentChannelThreadBySession(sessionId)` 反查 |
| B | `ask-user-questions-store.ts` | `findPendingForScope(scopeKey)`（scopeId||sessionId） |
| C | `runtime-core/remote-confirmation-codec.ts`（新） | 纯编解码 + 取消词 + 错误提示 |
| D | `runtime-core/remote-channel-service.ts` | `maybeForwardAskCardToChannel` + flush 拦截段 + deps 扩展 |
| E | `runtime-core/runtime.ts` | 公开转投口 + refreshActiveRunProgress dep 接线 |
| F | `claude-bridge/ipc-handler.ts` | emitter 注册点双出口（本地 push + 渠道转投） |
| G | 测试 | codec 全分支 + store scope 匹配 + service 拦截/转投行为（假 sidecar/db 录音机） |

## 真机观测点（第 1 轮微信复测用）

- 触发 M2（如让远程 agent 覆盖移动文件）：微信应收到「需要你确认…1. 确认执行 2. 取消」；
  回「1」应收到回执且任务继续；回「乱文本」应收到格式指引；回「取消」任务按拒绝续跑。
- 日志：`remote_ask_card_forwarded` / `remote_ask_card_answered` / `remote_ask_card_reply_unparsed` metric 行。
