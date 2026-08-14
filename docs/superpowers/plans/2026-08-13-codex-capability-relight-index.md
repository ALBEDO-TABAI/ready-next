---
title: Codex 内核下专项能力与工作面重接线总判断
date: 2026-08-13
status: approved-for-planning
enforce: false
kind: index
pairs_with:
  - docs/superpowers/plans/2026-08-13-codex-domain-skill-and-library-implementation.md
  - docs/superpowers/plans/2026-08-13-codex-workbench-surface-rewire-implementation.md
  - docs/superpowers/plans/2026-08-14-codex-browser-kernel-fit-implementation.md
  - docs/architecture/current-runtime-contracts.md
  - docs/superpowers/plans/2026-08-11-ready-codex-matrix-wiring-closure-implementation.md
note: >
  本文只做第一性原理裁决与范围切分。可执行合同分别在两份子计划里。
  在子计划落地前，current-runtime-contracts.md 的退役边界仍全部生效。
---

# Codex 内核下专项能力与工作面重接线总判断

## 假设

1. 用户要的不是“再造一套多 Agent 运行时”，而是：Ready 在不同日常工作里能积累领域方法、知识和习惯，并让 Agent 真正帮上文档、RSS、日程、文件涌现等模块。
2. 生产主链已经换成 `CodexHostOrchestrator -> Codex ingress/product composition -> ReadyCodexLifecycleAdapter`。旧 SDK / turn-engine / DirectChat 不得复活。
3. 本机对照物是 `/Applications/ChatGPT Matrix Runtime.app` 与随包固定内核 `rust-v0.146.1`。只借鉴两边共同需求下的稳定原则；不抄 0.147 差集、远程主机、终端、工作树或未白名单 RPC。
4. 旧专项设计的产品意图仍有效；旧实现形态（预路由、handoff、人格注入、独立模型循环）与现行身份/权限/收口合同冲突。

## 完成标准

1. 本文给出可否重新落地的明确裁决，以及保留/放弃的能力边界。
2. 专项能力与工作面重接线分别有一份带机器合同的实施计划。
3. 不在本轮改生产代码。落地必须以子计划工单为准，不得按 2026-06 的 evolution 旧文恢复入口。

## 1. 应用事实

### 1.1 Codex / Matrix 里“自定义 Agent”实际是什么

固定内核与 stable/experimental schema 能证明的，是 thread/turn 协议上的宿主旋钮，不是 Ready 那种带知识库和预路由的专项人格：

| 协议能力 | 实际含义 | Ready 当前用法 |
| --- | --- | --- |
| `personality` | 仅 `none \| friendly \| pragmatic` 三值语气 | 省略；turn 禁止覆盖 |
| `developerInstructions` | 宿主叠加指令 | 固定一句 overlay，不嵌技能/记忆/人格 |
| `baseInstructions` | 覆盖内核 base | 刻意省略，保留内核自己的 base |
| 原生 `skill` input | 本轮方法论文件 | 已接：选中技能走 pinned skill |
| `additionalContext` | keyed 碎片 | 只放资源版本引用，不放正文/记忆 |
| `thread_spawn` / `spawnAgent` / `parentThreadId` | 子线程执行席位 | 显式拒绝；只认 `source=vscode` 的单 root thread |
| `multiAgentMode` | 已废弃 | 不发 |
| `externalAgentConfig` | 从 Claude/Cursor 迁配置 | 只作合法 passive 通知，不是产品 Agent |
| 项目 `.codex/` / `AGENTS.md` | cwd 配置层 | sidecar 用隔离空 HOME/CODEX_HOME，不会读用户家目录 |

ChatGPT 云端 Custom GPT / Project 不在本地 app-server schema 里。本机 `~/.codex/AGENTS.md` 与 `memories/` 是 Codex CLI 自己的习惯资产；Ready sidecar `inheritProcessEnv: false`，两边互不串。

### 1.2 旧专项 Agent 实际是什么

`docs/agent-evolution/04` 把“专项”做成了一组持久资产作用域：独立 RULES、知识卡、偏好、任务归属、预路由和 handoff。它把五件不同的事捆进同一个对象：

1. 身份 / 语气（SOUL、persona）
2. 领域方法（RULES）
3. 领域知识积累（belief cards）
4. 任务归属与路由（preroute / handoff / ownerAgentId）
5. 每轮自动注入（PromptAssembly L0/L1/L1.5）

这套在 Phase 4 曾 live。2026-08-12 起，E1 把它从 Codex 生产链卸掉。现行合同：`USER.md`、画像、记忆、人格、路由卡不得进入 thread instructions、turn input、`additionalContext` 或工具面；公开创建/改名/派生/预路由/handoff 已退役。`ownerAgentId` 只是中性审计身份。

历史资产仍在：`agents` 表、`.ready-agent-memory/agents/{id}/`、信念卡、USER.md、人格档案、blueprint list。`verify:evolution-p1/p3/p4` 现在证明的是“旧资产没丢、旧入口回不来、整理不烧模型”，不是“越用越准已经接到 Codex”。

### 1.3 工作面现在接到哪

产品模块大多自己还能用。Agent 侧并没有整面接通：

- **Browser / 当前文档 / 显式本地文件 / `@[日程]` / 原生 skill**：已按域 12 接到 Codex 资源信封。
- **文档模式**会把本轮 allow-set **整面换成**文档窄集，RSS/日程/Tag Forge 同时消失。
- **RSS / 日程写操作**工具还在注册表，但执行依赖 `requestModuleToolAction`；Codex 目前只在有当前文档时挂这条桥，且只放行文档动作。没有桥时返回“已排队执行”，产品状态不变。
- **RSS 当前条目、Widget 目标、当前日历窗口**没有 typed resource。
- **文件涌现**是独立产品调度，没有、也不该有模型工具。
- **Tag Forge** 执行器活着，但 `@[文件夹]` 会把 file 域收到 `file_inventory`，文档模式整面替换也会剥掉 `tag_forge_*`。
- **记忆工具**按合同不该进 Codex 工具面，但 `memory` / `session_recall` 组仍默认可见。这是实现相对合同的漂移。

`DomainAdapter.prepare/dispatch` 不在 Codex 生产图。`CodexHostOrchestrator` 只借用 DomainAdapterHost 做技能授权、Browser URL 和 reset 清理。

文档/RSS/日程/Widget/Tag Forge 的产品动作桥已按 `2026-08-13-codex-workbench-surface-rewire-implementation.md` 落地。Browser 与 Codex 内核的剩余接线见 `2026-08-14-codex-browser-kernel-fit-implementation.md`：保持单循环，不启用内核 `browserUse`，不抄 Matrix 内层 Browser Agent。

## 2. 第一性原理

Ready 换 Codex 内核之后，权威边界变成：

```text
模型      只负责语义判断和选工具
Codex     只负责 thread/turn/item 生命周期
Ready     只负责身份、权限、资源、产品动作、持久账本和界面投影
```

因此任何“专项”或“模块接线”都必须同时满足：

1. **身份只解析一次。** 一轮只有一个 `readyRunId + thread + turn`。不能靠换人格、换 owner、开子线程来改身份。
2. **权限由冻结工具面决定。** 资料不能扩权。原生 thread 不得自行加工具。
3. **产品终态由 Ready 原子收口。** 不能为专项或模块再造 successor / 第二套循环。
4. **跨边界状态显式建模。** Renderer 只传稳定 ID；Main 读真值；没有裸 fire-and-forget。
5. **模型只做语义。** 路由、授权、预算、完成判定必须由代码承担。

旧专项飞轮违反了 1、2、3、5：预路由是不可验证路由，人格/USER.md 改身份，handoff 造非用户后继，知识注入改权限感知。

Codex 的 `personality` / `spawnAgent` / 项目 `AGENTS.md` 看起来像“自定义 Agent”，但需求形态不一致：

- `personality` 是语气旋钮，不是领域资产作用域。
- `spawnAgent` 是编码子线程，Ready 的 closeout/Browser child/epoch CAS 只认单 root。
- 项目 `AGENTS.md` 依赖 cwd；Ready 必须隔离空 cwd，否则用户仓库指令会污染产品 Agent。

## 3. 裁决

### 3.1 旧专项 Agent 不能按原设计重新落地

不能复活的具体对象：

- 公开创建 / 改名 / 派生专项 Agent
- 新会话预路由、自动 handoff、同会话热切换人格
- 把 USER.md / SOUL / RULES / 路由卡 / 记忆自动注入 instructions
- `AgentFactory`、blueprint confirm、`agent_propose_handoff` 作为 live 漏斗
- 用 `parentThreadId` / `spawnAgent` / `multiAgentMode` 冒充专项
- 把 DomainAdapter id 或 `ownerAgentId` 当成人格权威
- 设置里的知识总开关 / 自动路由 / 自动加载记忆

理由不是“功能过时”，而是它会重新引入第二套身份权威，并拆掉 Codex 接线已经钉死的 CAS / closeout。

### 3.2 用户想要的三种能力可以留下，但必须拆开

| 用户目标 | 旧捆法 | 可落地形态 |
| --- | --- | --- |
| 领域能力 / 方法越来越强 | 专项 RULES + 派生人格 | **技能。** 选中后走原生 skill input；工具面由授权层出 |
| 领域知识 / 经验越积越准 | 信念卡自动注入 | **可检索资料库。** 用户点名或本轮 pin；读出来当数据，不当系统指令 |
| 越用越契合个人习惯 | USER.md + persona 常驻 L0 | **用户确认的短偏好资源**，或用户自己把习惯写进 skill。禁止静默改身份 |

用户界面仍可以说“剪辑专项 / 周报专项”。实现上它是：**中性 Codex 宿主 + 选中技能 + 可选资料夹 + 会话标签**。不是第二条模型主链。

### 3.3 工作面可以尽快接回，但不要复活 DomainAdapter 调度

最佳接线是 Matrix 已经证明、Ready 域 12 已经对文档/浏览器用过的那条：

```text
Renderer 只交稳定 ID
  → Main 读产品真值
  → 本轮冻结工具 + typed resource
  → 通用产品动作桥按 exact run 执行
  → 独立产品调度继续自己跑（刷新、涌现、入库、确认卡）
```

不要把 RSS/日程/地图再写回 adapter prefix 收窄，也不要让文档模式整面替换吃掉其他域。

## 4. 两份子计划怎么切

1. [`2026-08-13-codex-domain-skill-and-library-implementation.md`](2026-08-13-codex-domain-skill-and-library-implementation.md)  
   专项能力重映射：关记忆泄漏、资料按需读、领域方法走技能、习惯另立短合同。
2. [`2026-08-13-codex-workbench-surface-rewire-implementation.md`](2026-08-13-codex-workbench-surface-rewire-implementation.md)  
   工作面重接线：产品动作桥、allow-set 并集、RSS/日程/Widget/Tag Forge typed surface。

施工顺序：先 2 的动作桥与 allow-set（立刻恢复“Agent 能改产品状态”），再 2 的 typed surface 与 Tag Forge，再 1 的记忆闸门与资料库。专项技能迁移不阻塞工作面恢复。

## 5. 明确不在本轮

- Codex 原生子线程 / 并行 specialist runner
- 公开续跑、non-user successor
- 定时后台 Agent 任务（已退役；Skills Runtime 自有定时除外）
- 把本机 `~/.codex` 记忆同步进 Ready
- 抄 Matrix 部门制或 0.147 远程环境
