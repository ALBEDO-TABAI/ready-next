# CLI 授权桥接实现合同

> 日期：2026-07-13
> enforce: true

## 目标

让 Agent 代跑一次性 CLI 时，授权和高风险确认能够在 Ready 内完成；同时保持非交互进程边界，不引入终端模拟层。

## 可验证合同

1. `run_setup_command` 阶段 1 只生成预览，绝不执行，也不触发行动确认。
2. `run_setup_command` 只要携带 `confirmAck: true`，代码侧行动确认策略就必须冻结完整调用并显示确认卡；模型写入的 `confirmAck` 只表示进入执行阶段，不是用户授权凭证。
3. CLI 返回包含 `verification_url` / `verification_uri` / `verification_uri_complete` 与可选 `device_code` 的 JSON 时，工具结果必须保留并显式标记授权链接和设备码，供 Agent 原样展示及后续续接。
4. CLI 以退出码 10 返回 `confirmation_required` JSON 时，工具不得自动加 `--yes`；必须返回结构化重试参数，下一次执行仍经过第 2 条确认卡。
5. Agent 消息中的 `http://`、`https://` 链接必须可点击并交给系统浏览器打开；代码片段中的网址保持代码文本，不得变成链接。
6. 依赖键盘输入、密码输入或 TTY 的传统交互命令仍立即收到 EOF 并明确失败，不伪装成已支持，也不让进程无限等待。

## 非目标

- 不在聊天区实现完整终端、PTY 或密码输入。
- 不改变 MCP 自身的 OAuth 合同。
- 不允许 CLI 输出直接绕过 Ready 的行动确认策略。

## 验收

- 行动确认策略测试覆盖预览放行、执行冻结、确认后仅执行一次。
- 命令工具测试覆盖授权 JSON、高风险确认 JSON、交互式 EOF、超时和中断。
- Markdown 渲染测试覆盖裸链接、Markdown 链接、查询参数和代码片段。
- `npm run typecheck`、相关专项 gate 与构建通过。
