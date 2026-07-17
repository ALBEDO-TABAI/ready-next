---
date: 2026-07-17
enforce: true
status: in_progress
scope: kimi-k3-agent-specialization
---

# Kimi K3 Agent 特化实施合同

## 1. 目标与假设

目标是在现有 `AgentSdkRuntime -> AgentSdkTurnOrchestrator` 主链中支持 Kimi Coding 的 `k3`，不新建第二套 Agent 路径。

本实施基于以下已核实事实：

- 目标地址为 `https://api.kimi.com/coding`，模型 ID 为 `k3`。
- K3 支持且只向 Ready 暴露 `low / high / max` 三档思考强度，默认 `high`。
- K3 多轮质量依赖完整回传历史思考块；普通文字回复与工具调用回复都不能丢失思考块。
- 从其他模型的既有会话切入 K3 不安全，必须在发出请求前拒绝并提示新建会话。
- 本机官方 Kimi Code 0.26.0 的实现使用 Anthropic 请求时发送思考强度与 `keep: all` 等价的上下文保留合同。

不在本次范围内：改造其他 Kimi/Moonshot 模型、增加自定义强度、保留旧的不完整 K3 会话、重构通用设置页。

## 2. 机器可验证合同

### K3-1 识别与能力

仅当地址是 Kimi Coding 且模型 ID 精确为 `k3` 时启用特化：

- 协议继续使用 Anthropic `/v1/messages`。
- `supportsThinking = true`。
- `multiTurnThinkingPolicy = echo_required`。
- 未设置或设置了 K3 不支持的强度时归一为 `high`。
- 非 K3 配置的能力与请求不变。

### K3-2 请求

K3 的阻塞请求与流式请求必须发送同一合同：

- `thinking.type = enabled`。
- `output_config.effort` 只允许 `low / high / max`。
- `context_management.edits` 包含 `clear_thinking_20251015` 且 `keep = all`。
- 请求头包含对应的 context-management beta；不得覆盖既有 beta。

设置页的连接测试也必须使用同一请求合同，避免“测试成功、真实 Agent 失败”的分叉。

### K3-3 历史闭环

- Anthropic 响应中的思考块必须同时附着到普通文字输出和工具调用输出。
- 下一轮序列化必须把思考文本及签名原样放回同一个 assistant 消息。
- 流式与非流式路径最终形成相同的历史结构。
- 会话快照和压缩不得剥离保留下来的 K3 身份或思考块。
- Dynamic Delivery 候选在 verifier 接受前仍不得进入共享会话；接受后重建的最终 assistant 消息必须继承最后一条已接受 K3 回复的完整 providerData，不能用无身份纯文本替换。

### K3-4 模型切换保护

- K3 产出的每个 assistant 输出携带稳定的 K3 会话身份。
- K3 请求若看到其他模型、旧版无身份 assistant 输出，或来源不明的压缩摘要，必须在联网前停止。
- 错误信息必须明确提示用户新建会话；不得静默清空历史或只把旧界面留着却丢弃上下文。

### K3-5 设置体验

- K3 配置显示“思考强度”。
- 选项精确为 `low / high / max`，默认显示 `high`。
- 其他 OpenAI Responses 模型继续显示既有选项，不受 K3 特化影响。

## 3. 验证清单

1. 行为测试：K3 能力、三档归一、非 K3 不变。
2. 行为测试：真实 `ReadyAnthropicModel` 捕获的阻塞/流式请求体与请求头符合 K3-2。
3. 行为测试：普通文字和工具调用的思考块均能跨轮原样回传。
4. 行为测试：空白会话与纯 K3 会话放行；其他模型、旧版无身份历史与来源不明压缩摘要拒绝，且拒绝发生在 fetch 前。
5. 行为测试：压缩后的纯 K3 摘要保留身份；混合或无身份历史不伪装成 K3。
6. 行为测试：Dynamic Delivery 拒绝候选不泄漏思考历史；接受候选把 K3 providerData 附到最终共享消息，下一轮仍通过 K3 历史检查。
7. 运行 `npm run verify:streaming`、`npm run typecheck`，再检查改动范围与密钥痕迹。
8. 使用用户临时提供的凭据对 `low / high / max` 以及两轮历史回传做隔离实测；凭据只进进程环境，不写文件、不进日志。联网前置不可用时不得把该项宣告通过。

## 4. 完成标准

只有上述合同和验证清单全部通过，且无用户密钥落盘、无无关文件被改动，才可标记完成。
