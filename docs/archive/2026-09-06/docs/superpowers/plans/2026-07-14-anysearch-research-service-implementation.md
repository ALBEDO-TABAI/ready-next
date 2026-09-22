---
date: 2026-07-14
enforce: false
status: completed
external_sources:
  - https://github.com/anysearch-ai/anysearch-skill/tree/main
  - https://www.anysearch.com/docs
archived_at: 2026-09-06
archive_reason: superseded-project-documentation
---

> 已归档（2026-09-06）：本文保留编写当时的设计、状态与证据，不是当前执行入口；归档不表示原计划全部实现。现行说明见 [当前运行时合同](../../../../../architecture/current-runtime-contracts.md)，去向见 [文档清单](../../../../../documentation-inventory.md)。

# AnySearch 搜索与调研能力接入合同

## 目标与边界

- AnySearch 作为受统一外部服务设置管理的搜索与全文读取后端，不通过 skill 脚本绕过 Ready 的工具授权、超时、重试和日志链路。
- 保留 Tavily、DuckDuckGo 和 Jina；AnySearch 启用后参与有来源标识的优先级与回退，不静默改变垂直搜索语义。
- API Key 只进入现有加密设置库；不写入源码、skill 目录、运行时配置或测试 fixture。AnySearch 无 Key 时仍可在用户显式启用后以匿名低额度运行。
- 不引入官方跨平台 CLI 作为第二套生产执行器；官方 skill 的领域选择方法改写为 Ready 原生 reference skill。

## 机器可验证合同

1. 默认外部服务列表包含唯一 `anysearch-default`；它默认关闭、地址为 `https://api.anysearch.com/mcp`、Key 可选，公开读回只显示是否已配置与脱敏尾号。
2. `web_search` 在 AnySearch 启用时可返回统一的 title/url/snippet/source 结构；普通搜索失败可继续走已启用的 Tavily/DuckDuckGo，每条结果保留真实来源。
3. `web_search_domains` 只读 AnySearch 的领域能力；输入限定为官方支持领域，输出保留子领域与必填参数说明。
4. 垂直 `web_search` 必须传递 `domain / subDomain / subDomainParams`，包括值为空字符串的必填参数。AnySearch 未启用或调用失败时不得丢掉这些条件改做普通搜索。
5. `web_fetch` 在 AnySearch 启用时可使用 `extract`；仍遵守 4096 字符上限，并与 Jina/Tavily 共用明确优先级与回退。
6. 已选 skill 的 `searchService / fetchService` 绑定以声明式方式决定首选服务，不再只识别 `deep-research` 这一个硬编码 id。
7. 内置 `anysearch` reference skill 能被启动扫描发现，只指导 Ready 原生 `web_search_domains / web_search / web_fetch`；`deep-research` 的搜索和全文绑定也接受 AnySearch。
8. 外部服务页的 AnySearch、Tavily、Jina、DuckDuckGo 配置卡显示简短用途；需 Key 或可选 Key 的卡片提供官方申请入口和文档入口，DuckDuckGo 明确无需 Key。
9. AnySearch 配置的草稿测试使用当前表单中的地址与 Key，执行一次真实 JSON-RPC 搜索，不提前持久化。

## 验收入口

- AnySearch 工具、外部服务、skill 与设置页专项行为测试全部通过。
- `npm run verify:r`、`npm run typecheck`、`npm run verify:native`、`npm run build` 以及 CSS reset gate 通过，不以 ABI skip 代替原生持久化验证。
- 真实 Electron 中完成 Key 安全保存、连接测试、引导链接可见与一次真实 Agent 搜索验收。

## 完成记录（2026-07-14）

- AnySearch 专项 22 项通过；1 项普通 Node ABI 覆盖按约定由 `npm run verify:native` 的 Electron ABI 146 实测补齐。
- Research 专项 41 项、终态判定相关 69 项、类型检查、原生模块检查、生产构建、IPC 合同、CSS reset、AnySearch skill lint 与差异格式检查均通过。
- 真实开发版中，已配置密钥保持脱敏，连接测试返回正常（1591ms）；明确指定 AnySearch 的 Agent 依次调用 `web_search_domains -> web_search`，最终 run 为 `research / done / done`，回复包含来源链接与查询时间。
- 外部服务页已显示 AnySearch 用途、Key 可选说明、官方 Key 入口和文档入口；Tavily、Jina、DuckDuckGo 也各自显示对应获取或无需 Key 的说明。
- 总门禁 `npm run verify:r` 仍被本任务外的未跟踪 `Pack-source/` 副本 lint 错误、`agent-status-glyph.ts` 既有 fallthrough，以及当前 VEA 脚本/测试漂移阻断；未改动这些并行工作。与本任务直接对应的 `test:r:focus` 和 `test:anysearch` 已单独全绿。
