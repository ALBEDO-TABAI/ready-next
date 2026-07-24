---
title: ChatGPT OAuth 本机实验 Provider 实施计划
date: 2026-07-24
kind: implementation
status: completed
enforce: true
owner: 白
author: Codex
requires:
  - docs/architecture/current-runtime-contracts.md
  - docs/superpowers/testing-conventions.md
scope: OpenAI 设置中的显式实验入口、Ready 隔离凭证、loopback 代理生命周期与 Provider 行为验收
---

# ChatGPT OAuth 本机实验 Provider 实施计划

## 1. 证据与边界

- `openai-oauth@2.0.0` 使用 Codex OAuth client、`https://auth.openai.com/oauth/token` 和 `https://chatgpt.com/backend-api/codex`，不是 OpenAI 面向第三方通用模型应用发布的 OAuth API。
- 2026-07-24 本机临时凭证副本验收已证明：loopback `/v1/models` 可读，`/v1/responses` 的响应体返回真实 SSE 事件但响应头错误标为 `application/json`，`gpt-5.6-terra` 正确返回 `READY_OAUTH_OK`；临时代理与凭证副本已清除。
- OpenAI 官方文档只把 ChatGPT 订阅登录列为 ChatGPT desktop、Codex CLI、IDE extension 和 Codex cloud 的认证方式；Codex SDK 面向 coding-focused Codex threads。普通 OpenAI API 仍单独计费。
- 因此本功能只能是用户主动选择的本机实验入口。官方 API Key 继续是 OpenAI 内置预设的默认认证方式，不得静默迁移既有配置。

## 2. 机器可验证合同

### C1. 授权语义

- UI 必须同时显示“非官方”“实验性”“授权主体为 Codex”与“凭证等同密码”。
- 未经用户点击连接，不启动登录、不创建凭证、不改变活跃 Provider。
- OAuth 成功后创建或更新独立的 `ChatGPT OAuth（实验）` 预设，不覆盖内置 OpenAI API Key 预设。

### C2. 凭证与网络边界

- OAuth callback 只监听 loopback；模型代理只绑定 `127.0.0.1`。
- Ready 使用独立于 `~/.codex/auth.json` 的 userData 凭证文件，权限为 `0600`；不得读取或覆盖 Codex CLI 的默认凭证。
- Renderer 永远拿不到 access token、refresh token、id token、账号 id 或凭证路径。
- 模型代理的每个请求都必须校验 Ready 为该预设生成的随机访问口令；第三方包默认的无鉴权 loopback server 不得直接暴露。
- 断开连接只删除 Ready 自己的 OAuth 凭证，并关闭 Ready 自己的 loopback server。

### C3. Provider 合同

- OAuth 预设固定使用 OpenAI Responses、原生工具调用、`127.0.0.1` loopback base URL 与至少 256 bit 的随机代理访问口令；设置页不得展示该口令。
- 可选模型只来自账号返回的 Codex model catalog；冷启动可使用上次已保存的模型列表快速恢复代理。
- 该入口不宣称普通 OpenAI API、ChatGPT 全部模型、视频能力或稳定 SLA。

### C4. 生命周期合同

- 同一进程最多一个启动 promise 和一个 loopback server。
- 登录、冷启动恢复、测试连接与激活 OAuth 预设都复用同一服务。
- loopback server 启动后随 Ready 进程保持，不因切换活跃预设而关闭；重新激活时复用现有凭证，不得重新进入浏览器授权。稳定性回补合同见 `2026-07-24-chatgpt-oauth-stability-and-reasoning-implementation.md`。
- 端口冲突、凭证缺失、刷新失败和上游错误必须返回可见失败，不能回落到 API Key 或其他账号。

## 3. 完成标准

1. Main、Preload、Renderer 类型与 UI 的连接、状态、断开闭环存在。
2. 独立 OAuth 预设不会覆盖内置 OpenAI API Key 预设，且激活后 Ready 配置解析为 Responses + 原生工具。
3. 单元测试覆盖单实例启动、并发 join、断开清理、错误状态、OAuth profile upsert 与旧 OpenAI 配置保留。
4. `npm run typecheck`、OAuth 专项测试、`npm run verify:streaming` 和 `npm run build` 通过。
5. 真实 Electron 中完成一次登录或复用 Ready 独立凭证、模型列表、真 SSE 文本与一次工具调用验收；若登录授权或账号限制阻塞，必须明确标记为外部验收未完成。

## 4. 非目标

- 不把非官方 OAuth 设为 OpenAI 默认认证。
- 不复用或导入 `~/.codex/auth.json`。
- 不把 Codex SDK 嵌套为 Ready 的第二套 Agent。
- 不承诺该上游接口长期稳定，也不为未来变更预埋兼容分支。

## 5. 验收结果

- OAuth 与 workspace 专项测试 24 项通过；`npm run typecheck`、`npm run verify:native`、`npm run verify:streaming`、`npm run build` 通过。
- 独立 Electron userData 冷启动后，OAuth 服务由真实 Electron Main 持有，目录权限为 `0700`、凭证权限为 `0600`；无代理口令的请求返回 `401`。
- 同一 Electron 服务已完成真实流式文字与 function call 验收；Ready 会对该 OAuth 预设纠正错误的响应头并把文字增量补回终局回答；聊天切换区显示独立的 `ChatGPT OAuth（实验）` 预设，设置页未展示代理口令。
- 验收使用的临时凭证副本、数据库、userData 与进程均已删除，未修改 Codex CLI 凭证或日常 Ready 数据。
- `npm run verify:ipc-contract` 能配对本次新增的 3 个 settings 通道；总 gate 仍被当前分支既有的 `app:browserLiveProofHandshake` 和 Browser 非字面 push allowlist 漂移阻塞，本实现未修改这些 Browser 路径。
