---
enforce: false
archived_at: 2026-09-06
archive_reason: superseded-project-documentation
---

> 已归档（2026-09-06）：本文保留编写当时的设计、状态与证据，不是当前执行入口；归档不表示原计划全部实现。现行说明见 [当前运行时合同](../../../../../architecture/current-runtime-contracts.md)，去向见 [文档清单](../../../../../documentation-inventory.md)。

# Hermes-Inspired Agent Upgrade Roadmap

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 基于 Hermes Agent 已验证过的强项，分阶段升级 Ready 的 agent 主控、内置浏览器结合、跨会话回看、能力拆层、记忆体系和自学习能力，同时保留 Ready 现有的产品内体验优势。

**Architecture:** 不直接替换 Ready 现有主控，而是先做对照研究和目标结构定形，再把值得吸收的运行时能力逐步并入。浏览器与主控循环优先，随后补跨会话回看、能力分组、记忆可插拔和自学习闭环，最后做统一验收和灰度收口。

**Tech Stack:** Electron 34、React 19、TypeScript 5、better-sqlite3、现有 `agent-control / direct-chat / browser-engine / skills-runtime` 主链

---

## Plan Rules

- 这是一份“路线大纲”，不是一次性全做完的施工单。
- 每个 Chunk 先产出单独的深挖结论或小规格说明，再决定是否进入实现。
- 默认优先保留 Ready 已有产品内体验约束：BrowserView、scope 隔离、附件资源层、workflow blocker、前台任务卡片、保守记忆确认。
- 外部参考对象以 Hermes Agent 的真实做法为准，但所有落地都要经过 Ready 本地场景重写，不做整块照搬。

## Chunk 1: Browser + Agent Joint Architecture

### Task 1: 拆清 Hermes 浏览器思路，重做 Ready 的“浏览器即 agent 身体”路线

**Files:**
- Inspect: `src/main/modules/claude-bridge/direct-chat.ts`
- Inspect: `src/main/modules/tools/browser-agent-runner.ts`
- Inspect: `src/main/modules/tools/browser-tools.ts`
- Inspect: `src/main/modules/browser-engine/ipc-handler.ts`
- Inspect: `src/renderer/modules/browser/*`
- Reference: Hermes `tools/browser_tool.py`、browser docs、agent-loop docs

- [ ] **Step 1: 画清 Hermes 的浏览器调用链**
- [ ] **Step 2: 画清 Ready 当前“模型 -> 浏览器决策 -> BrowserView -> 任务摘要”的真实调用链**
- [ ] **Step 3: 标出两边真正可融合的层**
  重点看：导航、页面状态抽象、动作执行、验证、失败恢复、会话续跑。
- [ ] **Step 4: 写出 Ready 的目标结构草图**
  目标不是外接浏览器，而是让内置浏览器成为更高耦合、更强验证、更可恢复的 agent 运行体。
- [ ] **Step 5: 定义第一轮改造范围**
  只允许处理最值钱的几个点，例如：浏览器状态抽象统一、页面动作验证统一、浏览器任务续跑统一。

## Chunk 2: Core Loop And Runtime Host

### Task 2: 吃透 Hermes 核心循环，再反推 Ready 主控应该怎么拆

**Files:**
- Inspect: `src/main/modules/claude-bridge/direct-chat.ts`
- Inspect: `src/main/modules/agent-control/orchestrator.ts`
- Inspect: `src/main/modules/agent-control/runtime.ts`
- Inspect: `src/main/modules/agent-control/tool-gateway.ts`
- Inspect: `src/main/modules/agent-control/session-continuity.ts`
- Reference: Hermes `run_agent.py`、`agent/prompt_builder.py`、agent-loop / tools-runtime / provider-runtime docs

- [ ] **Step 1: 提炼 Hermes 核心循环的关键优点**
  重点看：提示组装、工具调用循环、中断、回退、并发工具、子代理、上下文压缩。
- [ ] **Step 2: 对照 Ready 当前主控的职责拥挤点**
  重点看：`direct-chat.ts`、`runtime.ts`、`useAgent.ts`、browser runner 之间的边界混杂。
- [ ] **Step 3: 给出 Ready 主控的新分层草案**
  至少拆出：prompt assembly、provider/runtime、tool dispatch、browser orchestration、scope run summarization。
- [ ] **Step 4: 标出哪些要先重构，哪些先不要动**
  防止为了“更像 Hermes”而打断当前可用链路。
- [ ] **Step 5: 形成一份主控拆层的局部实施顺序**
  优先处理对浏览器和跨会话能力最有价值的层。

## Chunk 3: Cross-Session Search And Recall

### Task 3: 为 Ready 补上跨会话搜索、回看和再利用

**Files:**
- Inspect: `src/main/modules/database.ts`
- Inspect: `src/main/modules/repositories/agent-repository.ts`
- Inspect: `src/main/modules/agent-control/runtime.ts`
- Inspect: `src/main/modules/agent-control/prompt-assembly.ts`
- Inspect: `src/preload/index.ts`
- Inspect: `src/renderer/components/agent/ChatPanel.tsx`
- Reference: Hermes session storage / memory / session search docs

- [ ] **Step 1: 盘点 Ready 现在保存了什么、没法回看的是什么**
- [ ] **Step 2: 设计 Ready 版本的跨会话搜索能力**
  至少要覆盖：按 scope 搜、按频道搜、按附件搜、按任务摘要搜。
- [ ] **Step 3: 决定是直接补到现有 SQLite，还是新建独立索引层**
- [ ] **Step 4: 设计“回看结果如何重新进入当前会话”**
  不只是搜索到，还要能变成当前轮的上下文资源。
- [ ] **Step 5: 明确第一版 UI 入口**
  聊天里触发、搜索面板、任务卡片跳转，这三者先做哪个。

## Chunk 4: Capability Grouping And Runtime Switches

### Task 4: 学 Hermes 的能力分组和开关方式，继续把 Ready 主控拆薄

**Files:**
- Inspect: `src/shared/ai-providers.ts`
- Inspect: `src/main/modules/agent-control/tool-gateway.ts`
- Inspect: `src/main/modules/tools/*`
- Inspect: `src/main/modules/skills-runtime/*`
- Inspect: `src/renderer/components/settings/RemoteIMSettingsPanel.tsx`
- Reference: Hermes `tools/registry.py`、`toolsets.py`、tools docs

- [ ] **Step 1: 把 Ready 当前能力分组重新列清**
  例如：browser、document、rss、calendar、skill、memory、channel、system。
- [ ] **Step 2: 判断哪些能力应该变成显式开关，哪些继续保持宿主内控**
- [ ] **Step 3: 给出新的分层边界**
  让工具注册、能力暴露、前台可见性、模型可见性分开。
- [ ] **Step 4: 设计更清楚的“模型看见什么、宿主接管什么”规则**
- [ ] **Step 5: 形成后续拆分清单**
  目标是继续削弱“大而全”的主文件，不引入新的混杂。

## Chunk 5: Pluggable Memory With Visible Control

### Task 5: 借鉴 Hermes 的可插拔记忆，但保留 Ready 的可见确认体验

**Files:**
- Inspect: `src/main/modules/agent-control/prompt-assembly.ts`
- Inspect: `src/main/modules/agent-control/reflection-service.ts`
- Inspect: `src/main/modules/memory-management/*`
- Inspect: `src/main/modules/repositories/memory-repository.ts`
- Inspect: `src/renderer/components/memory/*`
- Inspect: `src/renderer/components/agent/ChatPanel.tsx`
- Reference: Hermes `agent/memory_manager.py`、memory docs、memory provider docs

- [ ] **Step 1: 盘点 Ready 当前记忆链路**
  自动沉淀、用户确认、展示位置、撤销路径，各自现状要先说清。
- [ ] **Step 2: 设计 Ready 的记忆插件接口**
  内建记忆、外部向量记忆、用户画像、任务归档要怎么并存。
- [ ] **Step 3: 设计“注入到 prompt 的记忆”和“只在检索时召回的记忆”分层**
- [ ] **Step 4: 保留保守确认，但允许更积极的自动沉淀策略**
  把“自动写”和“用户可见、可撤回”同时成立。
- [ ] **Step 5: 明确第一批可插拔目标**
  先做接口，还是先接一个外部记忆源，先后顺序要定。

## Chunk 6: Autonomous Skill And Long-Memory Evolution

### Task 6: 放开自动自学改技能、自动写长期记忆，但要在 Ready 里做成可控体验

**Files:**
- Inspect: `src/main/modules/skills-runtime/*`
- Inspect: `src/main/modules/tools/skills-tools.ts`
- Inspect: `src/shared/skill-execution-types.ts`
- Inspect: `src/renderer/components/layout/SkillsCenterPanel.tsx`
- Inspect: `src/renderer/components/agent/ChatPanel.tsx`
- Reference: Hermes skills docs、skill manager 思路、memory docs

- [ ] **Step 1: 定义“什么情况下允许自动写 skill / 自动改 skill”**
- [ ] **Step 2: 定义“什么情况下允许自动写长期记忆”**
- [ ] **Step 3: 设计 Ready 的可见反馈**
  用户至少要能看到：写了什么、为什么写、怎么撤回、怎么固定。
- [ ] **Step 4: 设计风险闸门**
  防止低质量技能污染、错误记忆扩散、循环自修正失控。
- [ ] **Step 5: 决定第一版是默认开启、受控开启，还是按 agent / skill 分类开启**

## Chunk 7: Rollout Order And Verification

### Task 7: 先后顺序、回归范围和签收标准

**Files:**
- Modify: `docs/superpowers/specs/`（后续逐 Chunk 产出细化规格）
- Modify: `PROGRESS.md`
- Modify: `CHANGELOG.md`
- Modify: `DOCUMENTATION.md`

- [ ] **Step 1: 确定正式推进顺序**
  建议优先级：浏览器结合与主控拆层 -> 跨会话回看 -> 能力分组 -> 记忆可插拔 -> 自学习。
- [ ] **Step 2: 为每个 Chunk 设签收标准**
  要求同时覆盖：可用性、可恢复性、前台体验、回归风险。
- [ ] **Step 3: 为每个 Chunk 设验证方式**
  单测、主链路回归、BrowserView 行为、聊天任务卡片展示、记忆撤销链路都要有。
- [ ] **Step 4: 规定文档同步要求**
  只要触碰 agent / browser / scope / skill / memory 主链，就同步更新根目录协作文档。

## Suggested Order For Deep Dives

1. 浏览器能力与 agent 结合方式
2. 核心循环与主控拆层
3. 跨会话搜索和回看
4. 能力分组与开关
5. 记忆可插拔
6. 自动自学改技能与自动写长期记忆

## Expected Output Per Deep Dive

- 一份单独的细化规格说明
- 一张“当前结构 vs 目标结构”对照表
- 一份“先做 / 后做 / 不做”的范围结论
- 一组可验证的签收标准
