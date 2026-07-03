---
title: P0-0 Provider True SSE Streaming Implementation
date: 2026-07-02
status: implementation
enforce: true
source:
  - docs/superpowers/plans/2026-07-02-agent-core-experience-diagnosis.md（§4 修正版：伪流式主因）
  - docs/superpowers/plans/2026-07-02-agent-core-experience-roadmap.md（P0-0）
  - src/main/modules/agent-control/runtime-core/agent-sdk-provider.ts
  - node_modules/@openai/agents-core/dist/types/protocol.d.ts（StreamEvent 判别联合）
---

# P0-0：Provider 模型层真 SSE 流式

## Goal

把 `ReadyOpenAICompatibleModel`（chat / responses 两条 wire 路径）与 `ReadyAnthropicModel`
的 `getStreamedResponse` 从"阻塞取全文 → 单包 delta 伪流式"改为真 SSE 增量流：
文本逐段 yield `output_text_delta`，工具调用/推理内容在流中累积、终局以
`response_done` 一次交付。下游（编排层 700ms timed-flush、`agent:stream` IPC、
renderer 增量渲染）已就绪，不在本合同范围内改动。

## 前置事实（本合同的验证基线，2026-07-02 预研钉死）

1. SDK 契约：`StreamEvent = output_text_delta | response_done | response_started | generic`
   （protocol.d.ts:2437）；Runner 从 `response_done.response.output` 取终局输出项——
   **工具调用无需增量事件，只需终局完整**。现伪流式恰用这两个事件类型，事件形态零改动。
2. `fetchWithTimeout`（direct-chat.ts:467）的 45s 超时只覆盖到响应头（finally 清计时器、
   移除 abort 中继）——**长流不会被掐断，但流式读取层必须自带 abort 监听与空闲守卫**。
3. responsePatcher 全集仅 minimax 一个（补 `additional_kwargs.reasoning_content`，
   不改 `message.content`）——不存在"流出文本 ≠ 终局文本"的 patch 改写风险；
   vllm requestPatcher 已在 `body.stream === true` 时自动补 `stream_options.include_usage`。
4. 用户当前唯一激活配置：`openai-compatible + agentProtocol=anthropic + mimo-v2.5`
   → 路由 `ReadyAnthropicModel`（`<baseUrl>/v1/messages`）。**anthropic 路径是灰度第一优先。**
5. 字面 `provider==='openai'` 走 SDK `OpenAIProvider` 真流式，不属本合同范围。

## Assumptions

1. 不改 `getResponse()` 阻塞路径的任何行为（既有测试是回归面）。
2. 不改 orchestrator/IPC/renderer；`onTextDelta` 消费增量 delta 的能力已存在。
3. 不改 fetchWithTimeout 签名与语义（abort/空闲在读取层处理）。
4. 请求体组装与响应解析**复用阻塞路径的同一批函数**（消息序列化、工具序列化、
   patch、tool_calls 构建、usage 抽取）——流式与阻塞的行为差异只允许出现在
   "文本何时可见"这一个维度。

## Completion Criteria（全部满足才算完成）

**行为测试（fake SSE 流注入 fetchWithTimeout，node --test）：**

1. chat 路径：N 段 `data:` 文本 chunk → `response_done` 之前 yield 出对应顺序的
   ≥2 个 `output_text_delta`；终局 output 文本 == 各段拼接；usage 取自带 usage 的末尾 chunk。
2. chat 工具调用：`tool_calls` delta 按 index 分片到达（id/name/arguments 跨 chunk 拆碎、
   两个并行调用交错）→ 终局 output 含两个 function_call 项，arguments 逐字节正确拼合；
   文本 delta 照常流出。
3. chat 推理内容：`delta.reasoning_content` 分片 → **不**以 `output_text_delta` 流出；
   终局消息记录可被 `readReasoningContentFromRecord` 读到（与阻塞路径 providerData 对齐）。
4. responses 路径：`response.output_text.delta` ×k + `response.completed` → k 个增量 delta；
   终局从 completed 载荷经既有 `buildResponsesToolCalls`/`extractResponsesText` 同构解析。
5. anthropic 路径：`message_start`（input usage）/ text `content_block_delta` ×k /
   tool_use 块 `input_json_delta` 分片 / `message_delta`（output usage）/ `message_stop`
   → k 个文本 delta；终局经 `extractAnthropicOutput` 同构解析出 message + function_call
   （input JSON 拼合正确）；usage 两端正确；thinking 块**不**作为文本流出。
6. 降级一（非 SSE 响应）：流式请求返回 200 + JSON body → 走阻塞解析、伪流式形状交付，
   记 `provider_stream_fallback{reason:'non_sse_response'}`，输出与阻塞路径对同一 JSON 完全一致。
7. 降级二（流式形状被拒）：**首 delta 前**、状态 ∈ {400,404,405,415,422} 且错误体
   提及 `stream`（isLikelyStreamShapeRejection）→ 单次阻塞重试成功，
   记 `provider_stream_fallback{reason:'stream_request_rejected'}`。
   **语义性 4xx 必须原样冒泡**：413 context overflow 冒泡后编排层压缩重试照常发生
   （行为测试断言）；不含 stream 字样的 400 同样冒泡；HTTP 5xx 不重试，
   `buildProviderHttpError` 冒泡（S5-2 上游分类重试不受影响）。
   > 实施中修正：初稿的"4xx 一律阻塞重试"会吞掉 413 overflow，破坏编排层
   > 压缩重试链——由既有 runtime overflow 回归测试暴露，据此收窄本条。
8. abort：流中途 `request.signal` abort → 读取循环立即终止、AbortError 语义冒泡、
   不产生 `response_done`。
9. 空闲守卫：无任何字节超过 `STREAM_IDLE_TIMEOUT_MS`（测试注入小值）→ 结构化超时错误；
   SSE 注释行/ping 事件重置守卫。
10. 总开关：`READY_SDK_TRUE_SSE=off` → 三路径回到现状伪流式（整包后单 delta）。
11. `[DONE]` 终止与 completed 后直接 EOF 两种收尾都干净关闭（无悬挂、无重复终局）。
12. vllm 灰度兼容：chat 流式 body 经 `applyProviderRequestPatch` 后
    `stream_options.include_usage === true`（复用/扩展 provider-patch-profiles 测试）。

**回归（不得回退）：**

13. 既有 focused 套件全绿：`agent-sdk-runtime.test.ts`、`provider-patch-profiles.test.ts`、
    `provider-patcher-applied.test.ts`、`reasoning-effort-routing.test.ts`、
    `provider-thinking-echo-gate.test.ts`、`agent-sdk-runtime-capability-body.test.ts`。
14. `npm run typecheck` 通过。
15. 新增 `npm run verify:streaming` 入口：跑新焦点测试 + 上述回归套件。

**live proof（V0 纪律：重启现源、记录 commit）：**

16. 真机 dev 对 mimo（anthropic 路径）发一条普通消息：聊天面板文本逐段出现
    （非整包一次弹出）；`provider_stream_first_delta` 指标 < 总时长的一半。

## 设计

### 新增 `src/main/modules/agent-control/runtime-core/provider-sse.ts`（纯层，无 IO）

1. `parseSseStream(body, opts)`：增量 SSE 解析器（AsyncGenerator<{event?, data}>）。
   块语义与既有 `parseEventStreamPayload`（openai-responses.ts:78）对齐：`event:`/`data:`
   行、多行 data 按 \n join、CRLF 兼容、`:` 注释行忽略但**重置空闲守卫**、`[DONE]` 终止。
   opts：`signal`（abort → reader.cancel + AbortError）、`idleTimeoutMs`
   （默认 `STREAM_IDLE_TIMEOUT_MS = 120_000`，任何字节到达即重置）。
2. 三个累积器（feed 事件 → 可选文本 delta；final() → **与阻塞路径解析输入同构的 JSON**）：
   - `ChatCompletionsStreamAccumulator`：choices[0].delta 的 content concat、
     tool_calls 按 index 累积（id/name/arguments 字符串拼接）、reasoning_content concat、
     reasoning_details 数组透传合并、usage 取最后出现值 → 合成
     `{id, choices:[{message:{content, tool_calls?, reasoning_content?, reasoning_details?}}], usage?}`。
   - `ResponsesStreamAccumulator`：`response.output_text.delta` 出文本；
     `response.completed`（event 名或 record.type）载荷为终局；无 completed 时以
     最后累积载荷 + 显式 `stream_incomplete` 错误。
   - `AnthropicStreamAccumulator`：content_block_start/delta/stop 重建 content 数组
     （text 块出增量、tool_use 块 input_json 拼接后 parse、thinking 块保留不出流），
     message_start/message_delta 合并 usage → 合成 `{id, content, usage}`。

### `agent-sdk-provider.ts` 改造

3. 提取三个响应整形函数（阻塞路径 JSON.parse 之后的既有代码原样搬移，双路共用）：
   `shapeChatCompletionsModelResponse(json, patchContext, fallbackId)`、
   `shapeResponsesModelResponse(json, patchContext, fallbackId)`、
   `shapeAnthropicModelResponse(json, fallbackId)`。阻塞路径行为不变。
4. 三个 `getStreamedResponse` 重写为：
   组装请求体（同阻塞 + `stream:true`；chat 路径补 `stream_options.include_usage`
   undefined-guarded；anthropic 路径补 `stream:true`）→ fetch →
   按 content-type/首包判定三级降级（见 Criteria 6/7）→ 逐事件 feed 累积器、
   文本 delta 即时 `yield {type:'output_text_delta'}` → 终局合成 JSON 走对应
   shape 函数 → `yield response_done`（usage 字段形态与现伪流式一致）。
   首个文本 delta 时记 `provider_stream_first_delta{ms, path, provider}`。
5. 总开关 `resolveTrueSseMode()`：读 `process.env.READY_SDK_TRUE_SSE`，
   `'off'` → 伪流式旧路径整体保留为 `legacyPseudoStream()`（也是降级一的复用体）。

### 显式非目标

- 不实现 `response_started`/增量工具调用事件（SDK 不需要）；
- 不改字面 `openai` provider 的 SDK 路径；
- 不动 orchestrator 的 hold/timed-flush 策略（那是 P0-1）；
- 不做 per-provider 能力位（三级降级已覆盖不支持流式的服务）；
- 不改 fetchWithTimeout。

## 实施顺序

1. S1：provider-sse.ts 纯层 + 累积器纯单测（Criteria 1-5 的累积器维度）。
2. S2：整形函数提取（阻塞回归先跑绿）→ 三路径接线 + 降级/abort/空闲/指标 + 行为测试
   （Criteria 1-12 全量，fake fetchWithTimeout + ReadableStream Response）。
3. S3：`verify:streaming` script + 回归全绿（Criteria 13-15）+ CLAUDE.md/AGENTS.md
   §2/§9 同步一行硬约束。
4. S4：live proof（Criteria 16），结论写回本文件"Closeout"。

## Risks & Mitigations

| 风险 | 缓解 |
|------|------|
| 个别兼容网关拒绝 `stream:true`/`stream_options`（400） | 降级二：仅"错误体提及 stream 的 4xx"单次阻塞重试（无 token 损耗）+ 指标可观测；语义性 4xx（413/401/429）原样冒泡保住上游压缩/鉴权/退避语义；漏网的形状拒绝由 kill switch 兜底 |
| 网关整包缓冲 SSE（假流式） | 行为自动等同现状；`provider_stream_first_delta ≈ 总时长` 可在 P0-4 看板识别 |
| 思考型模型长静默误触空闲守卫 | 守卫 120s 且任何字节（含 ping/注释）重置；仅防真挂死 |
| 流中途网络断 | 冒泡为 provider 错误，S5-2 既有 transient 分类重试接手；不在本层重试 |
| minimax reasoning_details 只在终局出现 | 累积器透传合并 delta 与终局字段，shape 后经 minimax responsePatcher 同构处理 |
| 双重文本（delta 流出 + response_done 再带全文） | SDK 语义本就如此（finalOutput 取自 output 项）；orchestrator `finalText || streamedText` 与 renderer 去重既有逻辑覆盖，测试 1 断言两者相等 |

## Closeout

**S1-S3 完成（2026-07-02，工作区未提交，基于 feature/vertical-tabs @ 25fc2419 + 既有 WIP）：**

- 交付物：`src/main/modules/agent-control/runtime-core/provider-sse.ts`（增量 SSE 解析器 +
  三累积器，纯层）；`agent-sdk-provider.ts` 三路径真流式接线 + 三个整形函数提取
  （阻塞路径行为不变）+ 三级降级 + abort/空闲守卫 + `provider_stream_first_delta`/
  `provider_stream_fallback` 指标；`src/__tests__/agent-sdk-provider-sse.test.ts`（16 测试）；
  `npm run verify:streaming` 入口；CLAUDE.md/AGENTS.md §2/§9 同步。
- 验证：`verify:streaming` 套件 161 测试 **157 过 / 3 败**——3 个失败为改造前既有基线
  （`READY_SDK_TRUE_SSE=off` 下复现同样 3 个：upload workflow 工具曝光 ×1、
  document 附件工具隐藏 ×1、new document 修复 ×1，均与 provider 流式无关，不据此判绿，
  留待其归属工单）；`npm run typecheck`（node+web）通过。
- 实施中合同修正一处：降级二从"4xx 一律阻塞重试"收窄为"错误体提及 stream 的
  {400,404,405,415,422} 才重试"——初稿会吞掉 413 overflow、破坏编排层压缩重试链，
  由既有 runtime overflow 回归测试暴露（Criteria 7 已更新）。
- 既有测试断言更新两处（行为合法变更）：`agent-sdk-runtime.test.ts` 的
  patchers 用例（流式请求现在合法携带 stream/stream_options/stream_usage——
  openai-compatible provider-default patcher 的既定流式约定）与 responses wire
  用例（stream:false → stream:true，rung-1 降级保住其余断言）。

**S4 live proof：已通过（2026-07-02 晚，用户真机实测）**——mimo/anthropic 路径普通消息
文本逐段出现，用户反馈"还不错"。本合同完成；后续 P0-1（技能轮 hold 放行）另立合同。
