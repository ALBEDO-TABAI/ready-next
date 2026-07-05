---
title: Phase M 第一阶段 — stdio transport 实装 + 治理接线（server-filesystem 先行）
date: 2026-07-05
status: implemented
enforce: true
---

# Phase M 第一阶段实施合同（stdio 先行）

> 调研锚：`2026-07-05-phase-M-mcp-ecosystem-survey.md`。本阶段实施其无人值守块
> 1/2/3/4 + 块 7 最小版；OAuth（块 6）、consent UI（块 5）、设置页管理面（块 8）、
> websocket/streamable-http 留第二阶段（需真机/在场）。

## 已落地条款

1. **stdio transport 实装**（`mcp/client.ts`）：换行分隔 JSON-RPC 2.0，惰性 spawn，
   initialize 握手 + initialized 通知，tools/list / tools/call，per-request 超时与
   AbortSignal，close() SIGTERM→SIGKILL 兜底并拒绝在途请求。**websocket 不再返回
   stub ok 假成功**——诚实 `transport_not_implemented` 失败。OAuth fence 顺序不变
   （`ensureAuthorized` 先于任何 call，gate 钉死）。
2. **tools/list discovery 实装**（`mcp/tool-discovery.ts`）：canonical
   `mcp_<server>_<action>` 命名（`canonicalMcpToolName` 消毒），目录携带
   remoteName/description/inputSchema/annotations 进 registry
   （`toolCatalog`）；tools/call 用 remoteName（映射链：连接内 map → registry
   目录 → 裸名兜底）。
3. **启动装配点**（`mcp/bootstrap.ts` + `claude-bridge/ipc-handler.ts` 一次性闸）：
   settings 键 `mcp_servers_json`（JSON 数组，见模块头注释示例）→ 校验
   （坏条目逐条留原因跳过）→ 逐 server 连接+发现+注册，单 server 失败不炸启动。
   stdio 本地 server 默认 `requiresAuthorization:false`（server-filesystem 路径，
   `isAuthorized` 直通分支），显式 true 才走 OAuth+consent。
4. **确认闸动态映射**（`action-confirmation-policy.ts`，调研切面 2 关键治理缺口）：
   `mcp_*` 工具此前一律落 default-M4 无条件放行；现在 server 声明
   `readOnlyHint:true` 才 M4 放行（ruleId `mcp-readonly-declared`），其余一律 M2
   保守确认（`mcp-external-write-default`，destructiveHint 只改文案不改档位），
   注册表查无此名同样 M2（防御纵深）。
5. **工具面预算最小版**（块 7）：每 server 硬上限 `MAX_TOOLS_PER_SERVER=24`，
   超限裁剪必须可观测（discovery `dropped` 名单 + bootstrap 日志，no silent caps）。
6. **model-visible schema 升级**（`tool-registry.ts` mcp provider）：目录内真实
   inputSchema/description 直出给模型，无目录回退静态空壳；isAuthorized 三参
   调用点与 gate 钉形完全未动。

## 验证

- 新行为网 `mcp-stdio-transport.test.ts`（7✓ + 声明 skip）：**真 spawn** 仓内
  fixture server（`scripts/test-fixtures/mcp-stdio-fixture-server.cjs`，零网络）
  e2e 握手→list→call→close；discovery+registry+`executeMcpTool` 全链 dispatch；
  确认闸四分支（只读放行/写确认/破坏性文案/未知保守）；预算裁剪可观测；
  bootstrap 配置解析与逐 server 容错。
- 既有 MCP/确认闸家族回归 85✓（authorization/error-kinds/deferred-promotion/
  policy/live-target/envelope-mapping）；四 MCP gate
  （authorization/deferred/group/oauth-flow）单跑全绿。
- typecheck 0。verify:t 链首的 verify:s lint 31 error 为分支既有 ipc-contract
  违规债（路线文档债务包在册，非本实施引入；本实施触碰文件仅剩既有 warning）。

## 真机验收路径（用户回来后）

1. 设置 settings 键 `mcp_servers_json`：
   `[{"id":"filesystem","transport":"stdio","command":"npx","args":["-y","@modelcontextprotocol/server-filesystem","<允许目录>"]}]`
2. 重启 dev → 启动日志应有 `mcp bootstrap: server filesystem registered with N tool(s)`。
3. 会话里让 agent 列目录/读文件（readOnly 工具直行）；写文件应弹 M2 确认卡
   （远程 scope 时经 Phase I P0 链路到微信）。
4. 第二个第三方只读 stdio server（fetch/time 类）同法接入，凑"≥2 server"出口判据。

## 登记（第二阶段）

- OAuth 实装（loopback + token 持久化）、consent 记录/deferred 驱动接线、
  设置页真管理面（`McpSettingsPanel` 占位标签"暂未发布 MCP transport"已与
  stdio 现状不符，随管理面一起重写并重锚 labeling 测试）、websocket/
  streamable-http、健康检查与"已连接≠在线"。
