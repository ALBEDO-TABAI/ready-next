# ChatGPT OAuth 稳定性与推理强度回补

日期：2026-07-24
状态：已完成
enforce: true

## 1. 现场证据

- `ready-settings.log` 显示 OAuth 预设切出后本机服务被停止；再次点击连接进入了完整浏览器授权，并在 5 分钟后报 `OpenAI OAuth login timed out`。
- Ready 的独立 `auth.json` 仍然存在且权限为 `0600`，因此这次超时不是登录凭证过期。
- `openai-oauth` 会在读取凭证时用 refresh token 自动刷新 access token。
- OAuth 预设已经持久化 `reasoningEffort=high`，SDK Responses 请求也会发送 `reasoning.effort`；缺口是设置入口藏在“能力”页，用户难以发现。
- 真实 Electron 的简单 `hi` 现场中，旧运行时在 55 秒内连续发出 15 次相同上下文请求，每次都有文字增量却无法形成最终回答。根因是 OAuth 预设沿用了官方 OpenAI 的连续响应客户端，而 `openai-oauth` 的 `/responses` 明确是完整历史回放的无状态接口。
- 切换为无状态适配器后的第二次现场在 86 秒内仍重复约 30 次。代理把 SSE 事件体错误标为 `application/json`，Ready 因而按普通 JSON 解析并得到空结果。
- 修正响应头识别后的第三次现场仍重复 24 次：每次都能收到文字增量，但终局载荷没有重复携带完整文字；Responses 累加器没有把已收到的文字补入终局结果，SDK 因而继续判定“没有回答”。

## 2. 机器可验证合同

1. 切换到其他模型只改变当前预设，不停止已运行的 OAuth 本机服务，也不删除凭证。
2. 从其他模型切回 OAuth 时只用现有凭证和已保存模型恢复服务；不得调用浏览器登录。
3. 重新授权必须是独立、明确的用户动作；“服务未运行”不得显示为“重新登录”。
4. 重复授权若已有模型缓存，授权回调完成后不得再同步等待模型目录。
5. OAuth 基础设置页必须直接显示推理强度，并把所选值持久化到预设。
6. OAuth Responses 请求必须把所选推理强度发送为 `reasoning.effort`。
7. 只有“断开并删除凭证”会删除 Ready 保存的 OAuth 凭证。
8. OAuth 预设必须使用 Ready 的无状态 Responses 适配器，不得进入官方 OpenAI 的连续响应客户端；没有工具调用的普通回答只能产生一次模型请求。
9. OAuth 的 `application/json` 响应头允许承载其实际 SSE 事件体；该例外只适用于显式 OAuth 预设。
10. 已收到文字增量但终局载荷缺少文字时，终局结果必须从本轮增量恢复完整回答，不能再次请求模型。

## 3. 验证

- 服务单测：停止/恢复不登录、重复授权复用模型缓存、断开才删除凭证。
- 配置单测：推理强度在 OAuth 预设重建后保留。
- 请求单测：OAuth Responses 请求分别携带用户选择的推理强度。
- 工程门禁：`typecheck`、OAuth 专项测试、`verify:native`、`verify:streaming`、`build`。
- 真实 Electron：切出 OAuth 后服务仍在；切回不打开授权页；修改推理强度后数据库回读一致。
- 真实 Electron 简单文本：一轮模型请求结束，首段输出可见，最终回复正常落库。

## 4. 验收结果

- 独立 Electron profile 冷启动恢复凭证耗时 8ms；切出 OAuth 和切回均约 1ms，服务状态始终为 ready，没有打开浏览器授权。
- 同一真实账号、`gpt-5.6-terra`、`reasoningEffort=low`、简单 `hi` 在 3.95 秒内完成；只有 1 次模型请求，终态为 done，正式回答已落库。
- 行为测试覆盖错误响应头、增量文字补回终局以及 Agents SDK 单请求结束；OAuth 专项、原生持久化、流式门禁、类型检查和构建均通过。
