---
enforce: false
archived_at: 2026-09-06
archive_reason: superseded-project-documentation
---

> 已归档（2026-09-06）：本文保留编写当时的设计、状态与证据，不是当前执行入口；归档不表示原计划全部实现。现行说明见 [当前运行时合同](../../../../architecture/current-runtime-contracts.md)，去向见 [文档清单](../../../../documentation-inventory.md)。

# 设计明细 04：主 Agent 与专项 Agent 派生体系

> 系列：docs/agent-evolution/（00 为路线图总览）
> 来源：Matrix 调研系列 02/03 篇（primary-entrypoint / 部门制）+ ready 现状调研（ConversationScope / agent_personalities / 默认四人设 / PersonalityEditor / SubAgent 框架取证）
> 状态：设计稿（未立合同）。这是四个增强点中改动最深的一个，**分三档推进，每档独立可用**。

---

## 1. 概念映射与设计立场

| Matrix | ready 化 | 说明 |
|--------|----------|------|
| Workspace | 应用本身（单用户单工作台） | 不引入多工作区 |
| primary-entrypoint department | **主 Agent**（默认由"管家 butler"升任） | 接需求、路由、维护全局资源，避免成为默认执行者 |
| Department（owner） | **专项 Agent** | 持久身份 + 独立 RULES/知识/偏好/任务积累 |
| canonical lead session | 该 agent 的会话集合（ConversationScope.agent） | 复用现有隔离 |
| Worker / Subagent | 现有 SubAgent 框架 | 不变，仍是执行席位 |
| department message | **不引入**（v1/v2 均不做跨 agent 消息总线） | 单用户场景下，跨 agent 协调由主 agent 在用户可见层完成 |
| crystallize-ceo 涌现候选 | 03 篇 §5 的涌现建议卡 | 派生的"提案引擎" |

**核心立场**：专项 agent 不是新进程、不是新模型实例，而是**一组持久资产的作用域**——RULES.md + knowledge/ + 偏好卡 + 任务历史 + （可选）工具倾向。用户持续使用 → 资产在各自作用域累积 → 每个专项 agent 越来越懂自己的域；主 agent 始终保持薄。这正是"避免单 agent 配置臃肿指向不明"的结构化解法。

## 2. 数据模型

### 2.1 agents 主表（新增，agent 从字符串升级为实体）

```sql
CREATE TABLE agents (
  id TEXT PRIMARY KEY,              -- kebab-case，与 .ready-agent-memory/agents/{id}/ 对应
  display_name TEXT NOT NULL,
  role TEXT NOT NULL,               -- 'primary' | 'specialist'
  status TEXT NOT NULL,             -- 'active' | 'retired' | 'merged'
  charter TEXT,                     -- 一句话职责边界（机器可读 profile 保持最小，学 Matrix）
  parent_agent_id TEXT,             -- 派生自谁（一般是 primary）
  derivation_reason TEXT,           -- 派生依据摘要（指向涌现候选卡 slug）
  merged_into TEXT,                 -- status=merged 时指向目标 agent
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
```

**三层概念的严格区分**（Codex 评审第 4 点采纳，这是本篇最容易踩的坑）：

| 层 | 实体 | 回答的问题 |
|----|------|-----------|
| 组织层 | `agents` 表 | 谁**拥有**这个域的知识/规则/任务积累 |
| 表达层 | `agent_personalities`（现状不动） | 用什么语气/角色感对话——一个 agent 引用一个 persona，persona 可复用 |
| 归属层 | 会话的 `scope.agent` + 任务的 `owner_agent_id` | 这段对话/这个任务**当前由谁负责**——两者可以不同（见 §3 同会话归属切换） |

现状的四个预设 persona 是**表达层资产，不是组织实体**——用户拿它们当"语气选择"用，不能默认升格。迁移保护规则：

1. **不强升**：迁移只创建一行 `role='primary'` 的主 agent（默认名"主助理"，用户可改/可指定由某 persona 担任表达层）；四个预设 persona **保持 persona 身份不动**，在专项 agent 创建向导中作为"候选模板"出现，用户显式确认才实体化为 specialist；
2. **存量会话零感知**：旧会话的 scope.agent 字符串原样有效（指向 persona 的继续按现状渲染），不回填、不迁移、不弹窗；
3. **agents 表为空时系统行为 = 现状**——整个组织层是渐进启用的增量，不是替换。

### 2.2 资产作用域（落地在 01 篇结构上）

```
.ready-agent-memory/agents/{agentId}/
├── RULES.md            # 身份/域策略/操作指令（L0 注入，仅该 agent 会话）
└── knowledge/          # 该域的信念卡（L1.5 注入，仅该 agent 会话）
    └── {slug}.md
```

root `knowledge/index.md` 只收 global 卡；agent 卡不生成 per-agent index 文件，只参与本作用域 backlink、镜像、衰减和维护信号。路由卡仍落在 root `knowledge/routing-*.md`，只给主 agent 的路由索引读取。

DB 侧：agent 作用域卡镜像为 `scope_id = 'agent:{agentId}'`；任务归属由 `task_projections.owner_agent_id` 表达。

### 2.3 任务归属

`task_projections` 已有 `scope_id`，经 ConversationScope 可回溯会话 agent；任务级归属使用 `owner_agent_id`。该字段只在用户采纳转办或派生/生命周期确认流中改变，后续轮 prompt-assembly 按 owner 查对应 RULES/知识作用域。

## 3. 路由设计（三档递进）

### 档位一【提案制，v1 推荐】：主 agent 建议，用户一键采纳

⚠️ 路由的默认形态修正（Codex 评审第 8 点采纳）：**转办 ≠ 新开会话**。对单用户桌面应用，强制切会话会割裂体验。归属切换有两种形态，**同会话切换是默认**：

- **同会话任务归属切换（默认）**：任务卡的 `owner_agent_id` 改为目标专项 agent，聊天线程不断；该任务相关的后续轮次，prompt-assembly 按任务 owner 注入对应的 RULES/知识索引（turn 级 agent 资产覆盖，scope.agent 不变）。用户感知 = 任务卡上多了个"由 {剪辑} 负责"的标记，对话连续；
- **新开会话（可选）**：仅当用户主动选择"单独开个会话聊这事"，或域差异大到当前会话上下文成为干扰时由提案给出该选项。

**焦点任务解析规则（多任务多 owner 时"继续"续哪个）**——同会话切换引入的新问题，解析顺序定死在代码层：

1. **显式引用赢**：用户点了任务卡 / 消息中引用了任务（@任务名或卡片回复）→ 该任务即焦点；
2. **最近交互次之**：无显式引用 → 取本会话 `last_interacted_at` 最新的非终态任务为焦点（每次工具执行/裁决/用户点击都刷新该时间戳）；
3. **歧义必问**：两个非终态任务的最近交互间隔 < 阈值（如 2 轮）且话语未指明 → 一次性澄清（列出候选任务卡，单选），不猜；
4. **焦点可见可撤回**：会话输入框上方常驻"当前焦点：{任务} · 由 {agent} 负责"chip，点击可切换；归属切换后 chip 提供单次撤回（undo 把 owner_agent_id 与注入切回）。

焦点任务的 owner 决定该轮的 turn 级资产注入（A2）；05 篇 I1 的状态优先决策序消费的"候选 task ref"即按此排序。

不改 turn-engine 的执行路径，零风险起步：

1. 主 agent 的 RULES.md 写入路由纪律（Matrix Decision Order 的裁剪版）：
   - 读意图（字面 + 重复性暗示 + 期望结果；持续性词汇 → 倾向持续拥有）；
   - 一个问题定归属："这件事落在某个专项 agent 的 charter 内吗？"；
   - 落在 → 回复中**提议**"这看起来是 {剪辑} 的活，要我让它接手吗？"+ UI 渲染采纳按钮（默认 = 同会话任务归属切换；可选 = 新会话，携带用户原话 + 必要文件引用——**最小传话原则**，不传全程上下文）；
   - 不落在任何 charter 且涌现卡未成熟 → 主 agent 自己做（inbox 性质），同时为涌现累积证据。
2. 路由依据注入：主 agent 会话的 L1.5 注入 `routing-*.md` 索引行 + agents 表的 charter 列表（一行一个："{id}: {charter}"，预算 ~500 字符）。
3. 新工具 `agent_propose_handoff { targetAgentId, userRequest, contextRefs[] }`：产出一张结构化"转办建议"投影到 UI；用户点击 → 创建目标 agent 会话并预填。

### 档位二【确认制自动路由，v2】：会话创建时预路由

新本地会话创建时（用户未显式选 agent），轻量路由器先行：

- **状态优先**：上一轮活跃/待裁决任务属于某 agent → 默认续用该 agent（与 C4.1 跟进意图四分类协同：continue_task/status_query 永远回原 agent）；
- **先例次之**：routing-*.md 卡命中 → 直接建到目标 agent，会话头部显示"已按惯例转给{剪辑}，点此改回"；
- **兜底**：进主 agent，走档位一提案。

设置项 `agent_auto_routing: off | suggest | auto`（默认 suggest），对齐 ready 既有的 C2.4 自动续跑开关模式（跨进程设置 + UI 可见）。

### 档位三【派生制，v2 后期】：从涌现候选到新专项 agent

完整闭环（03 篇 §5 → 本篇）：

```
crystallize 发现重复模式（≥2 次相似请求 + 稳定输入/过程/输出）
   → aspire 卡 `status: staged` + `stage: candidate`（带日期证据）
   → UI 涌现建议卡："你最近 5 次让我整理周报，要不要成立一个「周报助理」？"
   → 用户确认（命名可改）
   → AgentFactory 执行派生：
       1. agents 表插 specialist 行（derivation_reason 指向候选卡）
       2. 建 .ready-agent-memory/agents/{id}/ 骨架
       3. 种子 RULES.md：从候选卡证据 + 相关历史 CheckIn 提炼（LLM 一次性生成，用户可改）
       4. 把主 agent 作用域中属于该域的信念卡/偏好卡迁移到新 agent 作用域（列清单，用户确认）
       5. 写 routing-*.md 路由卡（条件/目标/主 agent 保留什么/转办要带什么）
       6. 候选卡 `stage` → `emerged`（`status` 生命周期不变）
   → 后续同类请求按档位二自动路由
```

**最小化创建**纪律照抄 Matrix：只种入证据支持的内容，禁止占位 KR/流程文本；命名按用户工作流（"周报助理"）而非工具（"飞书 bot"）。

### 生命周期收尾

退休/合并由 03 篇维护写建议卡 → UI 提示 → 用户确认 → `status='retired'|'merged'`（资产目录保留，知识卡可选择性并入目标 agent）。**Retirement 不是创建新 agent 的前置条件**。

## 4. 防臃肿机制（本设计的存在理由，须显式落地）

1. **主 agent 保持薄**：其 RULES.md 固定包含"避免成为默认专业执行者"；维护回合（03 §5）监控"主 agent 反复做的专业执行"并产出涌现/路由建议——主 agent 变臃肿会被系统性发现；
2. **知识归属裁决**（01 §6 第 3 条）：域知识进专项作用域，主 agent 只留路由卡与全局事实；
3. **修剪回路**：无流量 specialist 被建议退休；重叠 charter 被建议合并——组织会生长也会收缩；
4. **per-agent 注入预算不变**：每个会话仍是 L0 6000/L1.5 1500 字符预算，agent 多了不增加单会话上下文，只改变"注入哪一份"。

## 5. 显式不做清单

- 跨 agent 消息总线 / agent 间互相调用（单用户桌面场景，协调走用户可见层）；
- per-agent 工具白名单（工具可见性继续由 intent + domain + capability 决定；专项 agent 的"专"体现在知识与策略，不体现在工具剥夺——避免与 run-capability-controller 四层门控再叠一层）；
- agent 级模型路由（全部同一 provider 配置）；
- 自动派生（无用户确认的 agent 创建，永不做）。

## 6. 工作包拆分与验收

| WP | 内容 | 依赖 | 验收 |
|----|------|------|------|
| A1 | agents 表迁移（仅建主 agent 行）+ persona 模板候选机制 + 存量零感知校验 | 无 | 迁移测试；旧会话零行为变化；agents 表为空时系统 = 现状 |
| A2 | per-agent RULES/knowledge 注入（按任务 owner 的 turn 级覆盖 + scope.agent 回退） | 01 篇 K3 | 快照测试：同会话内不同 owner 任务的轮次注入不同 |
| A3 | charter 列表 + routing 索引注入主 agent 会话 | A1/A2 | 注入预算测试 |
| A4 | `agent_propose_handoff` 工具 + 转办建议 UI 卡 + 同会话归属切换（默认）/新会话（可选） | A3 | 端到端：提议 → 采纳 → 任务卡 owner 变更、聊天连续、后续轮注入切换；新会话路径预填原话 |
| A5 | 会话创建预路由（状态优先/先例次之/兜底主 agent）+ 设置项 | A4、C4.1 落地 | 行为测试：continue 类回原 agent；routing 卡命中走先例 |
| A6 | AgentFactory 派生流程 + 涌现建议确认 UI + 知识迁移清单 | A5、03 篇 C5 | 端到端：候选卡 → 确认 → 新 agent 可用且路由卡生效 |
| A7 | 退休/合并流程 + agent 列表管理 UI（扩展 PersonalityEditor） | A6 | 生命周期状态机测试 |

档位映射：v1 = A1~A4；v2 = A5；v2 后期 = A6~A7。每档结束都是完整可用形态。

风险与对策：
- **用户被切换打扰** → 默认 suggest 不 auto；同会话内永不静默换 agent；
- **知识错迁** → 派生时的迁移清单必须用户确认，且卡片可随时移回（文件级操作）；
- **路由错误** → 错了只是"多走一站"（主 agent 仍能做），且 03 篇维护会修 routing 卡——继承 Matrix"误判代价 = 多一跳而非被挡"的哲学；
- **与 PersonalityEditor 现有 UI 冲突** → A7 做整合设计，agents 实体与 persona 编辑同屏不同区。
