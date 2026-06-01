---
title: 设置三模块收口（记忆 / Agent 人格 / 用户档案）——接通活跃 Agent
date: 2026-06-01
status: ready-for-construction
owner: 白
executor: Codex（调度 subagents 施工），Claude 复审
enforce: true
related:
  - project_agent-live-path（记忆：活跃路径 = AgentSdkRuntime + OpenAI Agents SDK）
  - docs/superpowers/plans/2026-05-31-context-budget-first-class-implementation.md
references_external:
  - Hermes Agent（~/.hermes/hermes-agent）：persona/profile/memory 成熟参考
---

# 设置三模块收口：记忆系统 / Agent 人格 / 用户档案

> 本文是给 **Codex 调度 subagents 施工** 用的详细计划。Claude 已完成独立审查与 Hermes 调研，施工完成后由 Claude 复审结果。
> 阅读顺序：先读 §1 前因后果建立心智 → §2 已核实事实（带 file:line）→ §3 目标设计 → §4 工作包（每个 = 一个 subagent 任务）→ §6 验收。

---

## 0. 一句话

设置页的「记忆 / 人格 / 用户档案」三块底层仓库与测试都真实存在（31 项底层测试通过），但**顶层从未接到活跃模型**：人格、用户档案对 LIVE agent 零影响，记忆的设置页 UI 把未完成的内部机制（scopeId / L0-L2 / contentKey / 正则触发器 / Child Runs 调试区）直接暴露给普通用户，且若干按钮不查后端返回值、筛选与统计不刷新。本计划按 **轻量覆盖层** 把人格与单用户档案真正接进活跃系统提示，并把记忆 UI 拆成「普通视图 + 高级区」、修掉所有按钮闭环。

---

## 1. 前因后果（背景，务必先读）

### 1.1 三个模块是什么
设置页（`src/renderer/pages/Settings.tsx`）有三块相邻功能：
- **记忆系统**：`MemoryStatsCard` + `MemoryCreator` + `MemoryListPanel` + `TriggerManager`，外加一个 `ActiveChildRunsDebug` 调试区。
- **Agent 人格**：`PersonalityEditor`，编辑「人格正文 / 语气 / 展示名」，写入 `agent_personalities` 表。
- **用户档案**：`UserProfileEditor`，多用户 CRUD，写入 `user_profiles` 表。

### 1.2 用户反馈的症状
1. 「创建记忆」要求填 **Scope ID**（普通用户不懂），且选「常驻记忆」也要先找到一个真实会话。
2. 筛选下拉能选，但选完**列表不刷新**。
3. 「运行维护」前端**读错结果字段**，完成提示里出现 `undefined`。
4. 创建成功后列表不刷新；维护后统计不刷新。
5. 记忆页混入 **Child Runs 调试区**，与「记忆系统」心智不符。
6. **L0/L1/L2、contentKey、正则触发器** 等内部词太晦涩。
7. 人格「新建 Agent」只是新增一条人格配置，**不会**在聊天面板出现可切换 Agent；聊天面板实际只有 butler/copywriter/video-editor/analyst 四个固定项。
8. 「展示名称 / 推荐语气」基本只是配置页展示，**真正影响模型的只有人格正文**——而实际上连人格正文也没进模型（见 §1.4）。
9. 用户档案「新建用户」点保存走的是「更新已有用户」，新用户**存不进去**；普通本地会话没带用户身份，默认档案进不了上下文；页面说「切换用户上下文会调整」但没有切换入口。
10. 人格 / 档案保存 / 删除**不检查后端是否成功**，失败也显示成功。

### 1.3 根因
三块功能都是「自底向上建好、顶层没接通」：仓库（`*-repository.ts`）、生命周期、反思沉淀、触发器、测试都真实可用，但**接到活跃模型的最后一根线没接**。

### 1.4 关键发现：Ready 里有「四套人格表示」，没有任何一套进到活跃模型
| # | 人格来源 | 谁写 | 谁读 | 进活跃模型？ |
|---|---------|------|------|------------|
| 1 | `agent_personalities` 表（`AgentPersonalityRepository`） | 设置页 `PersonalityEditor` | 仅休眠的 `PromptAssemblyService.loadSOUL` | ❌ |
| 2 | `worktree-pool.ts getDefaultPersona()`（四个 agent 的完整 markdown 人格） | 硬编码 | 仅旧 `AgentManager.spawnAgent`（claude-CLI worktree 子系统，**未挂 IPC、未在 preload 暴露**） | ❌（旧路径） |
| 3 | `agent-sdk-runtime.ts defaultSystemPrompt()`（通用、与 agent 无关） | 硬编码 | **活跃 agent** | ✅ 但是通用一句话 |
| 4 | `useAgent.ts` 四个聊天 agent（管家/文案/剪辑/分析） | 渲染层硬编码 | 聊天面板标签；`agent` id 仅作 `orchestrator.send` 的 **session key** | ❌ |

> 结论：无论用户在聊天面板选哪个 agent、在设置里把人格改成什么，活跃模型拿到的永远是同一句通用 `defaultSystemPrompt()`。四个 agent 在系统提示层面行为完全一致，只是头像和名字不同。

用户档案同理：本地会话 scope 不带 `userId`，且唯一会读档案的 `PromptAssemblyService.assemble()` 从无调用点 → 默认档案进不了上下文。

记忆是**部分活的**：`ReflectionService`（会话后自动沉淀）+ `SessionRecallService`（召回胶囊实时注入）真实在跑；但设置页的「手动创建记忆」「L0/L1/L2 回读」是休眠 / 半截路径。

### 1.5 已验证的活跃链路（本方案的地基，已逐行核实）
活跃 LIVE 路径 = `ReadyAgentOrchestrator.send` → `AgentSdkRuntime.setSystemPrompt/sendMessage` → OpenAI Agents SDK `Runner.run`。关键点是 **`session.systemPrompt` 就是活跃 agent instructions 的第一行**，链路本身完好、只差「有人传 systemPrompt 进来」：

```
agent:send IPC (agent-lifecycle-group.ts:181-189)
  └─ deps.orchestrator.send(agent, message, sessionId, requestId)   ← 第 6 参 systemPrompt 没传
       └─ orchestrator.ts:368-369  if (systemPrompt) sdkEngine.setSystemPrompt(internalKey, systemPrompt)
            └─ agent-sdk-runtime.ts:2636-2643  setSystemPrompt → session.systemPrompt = systemPrompt || defaultSystemPrompt()
                 └─ agent-sdk-runtime.ts:3232-3251  const instructions = [ session.systemPrompt, '你现在运行在 Ready 的 OpenAI Agents SDK…', … ].join('\n')
                      └─ 该 instructions 作为 agent.instructions 进入 Runner.run
```

也就是说：**只要在 `orchestrator.send` 这个汇聚点把「人格正文 + 单用户档案」合成的 systemPrompt 传进去，就能真正进模型**，无需复活整套休眠的 `PromptAssemblyService.assemble()`。

### 1.6 Hermes 参考模型（成熟方案，已逐文件核实）
- **人格**：`SOUL.md`（单文件）= 基础持久身份，作为系统提示**第 1 槽（stable 层）**永远注入（`load_soul_md()`）；`/personality <name>` = 轻量可切换覆盖层，来自 `config.yaml` 的 `agent.personalities` 字典，每条 `{system_prompt, tone, style}` 拼成一段注入。**人格就是那个可切换身份，统一一份**——没有「编辑器和切换器两套不连」。tone/style 是真用的。
- **用户档案**：`USER.md`（单文件，**单用户**）= 「agent 对用户的了解」，每会话注入（volatile 层，表头 `USER PROFILE (who the user is)`），字符上限 1375。由 agent 自己用 `memory` 工具维护。
- **记忆**：两个扁平文件 `MEMORY.md` + `USER.md`，**没有 L0/L1/L2、没有 scope、没有 contentKey、没有正则触发器**；纯文本条目按字符预算，增改删用短唯一子串匹配；冻结快照（会话开始注入一次，会话内写入落盘但不改提示，保前缀缓存）；**agent 主动后台维护是主路径，手动配置是稀有高级功能**。任务/会话历史是另一套（FTS5 会话搜索），明确排除在记忆外。

> Hermes 的三条启示直接映射到本方案：①人格 = 可切换身份，统一一份并真进系统提示；②用户档案单用户即够；③记忆对普通用户极简、以「查看已沉淀」为主，内部机制全部隐藏。

### 1.7 已与用户确认的方向
- **人格深度：轻量覆盖层**（对应 Hermes 的 personality，不做 profile 整目录隔离）——四个 agent 共享同一套记忆/工具，只是系统提示（声音/角色）不同。
- **范围：三块一起做（A 人格接通 + 合并切换器 / B 用户档案降单用户 + 接通 / C 记忆普通-高级拆分 / D 按钮闭环）。**

---

## 2. 已核实的架构事实（file:line 锚点）

> 工作树有未提交改动，行号以「最近审查」为准；subagent 施工前必须打开文件二次确认，再动手。

### 2.1 接线汇聚点（后端）
- `src/main/modules/claude-bridge/ipc/agent-lifecycle-group.ts:181-189` — `agent:send` handler，调 `deps.orchestrator.send(agent, message, sessionId, requestId)`，**未传 systemPrompt**。
- `src/main/modules/agent-control/runtime-core/runtime.ts:1745` — 第二处 `this.orchestrator.send(agent, message, undefined, requestId)`（scoped/远程路径），同样未传。
- `src/main/modules/agent-control/runtime-core/orchestrator.ts:320-369` — `send(agent, message, sessionId?, requestId?, taskId?, systemPrompt?, …)`；`systemPrompt` 是**第 6 个参数**；`368-369` 仅当 `systemPrompt` 真值时调 `setSystemPrompt(internalKey, systemPrompt)`。
- `src/main/modules/agent-control/runtime-core/agent-sdk-runtime.ts`
  - `:309-311` `defaultSystemPrompt()` = `'你是 Ready 应用中的 AI 助手，面向自媒体创作者。…'`（通用）。
  - `:2622-2634` `newSession(name, systemPrompt?)`、`:2636-2643` `setSystemPrompt(name, systemPrompt?)` → `session.systemPrompt = systemPrompt || defaultSystemPrompt()`（session 不存在则建）。
  - `:3232-3251` `const instructions = [ session.systemPrompt, …运行环境/工具/日期… ].join('\n')` → Runner.run 的 agent instructions。

### 2.2 仓库（后端，schema 已读全）
- `src/main/modules/repositories/agent-personality-repository.ts`
  - 接口 `AgentPersonality { id, agentName, displayName?, personalityText, tone?, metaJson?, createdAt, updatedAt }`，表 `agent_personalities`。
  - 方法：`getPersonality(agentName)` / `createPersonality(partial)`（要求 agentName+personalityText）/ `updatePersonality(agentName, updates)`（**不存在则 throw** `Agent personality not found`）/ `listPersonalities()` / `deletePersonality(agentName)`。
  - **`metaJson` 可存 emoji 等切换器展示数据**（无需加列）。
- `src/main/modules/repositories/user-profile-repository.ts`
  - 接口 `UserProfile { id, name?, avatarUrl?, preferredLanguage, communicationStyle?, preferencesJson?, createdAt, updatedAt }`，表 `user_profiles`。
  - 方法：`getProfile(userId)` / `createProfile(partial)`（不给 id 则自动生成）/ `updateProfile(userId, updates)`（**不存在则 throw** `User profile not found`）/ `listProfiles()` / `deleteProfile(userId)`。
  - **字段映射**：昵称→`name`，语言→`preferredLanguage`，回复风格→`communicationStyle`，长期偏好→`preferencesJson.longTermPreferences`（用 JSON，无需加列）。
- `src/main/modules/agent-control/runtime-core/runtime.ts`
  - `:258` `private readonly userProfileRepository = new UserProfileRepository()`、`:259` `agentPersonalityRepository = new AgentPersonalityRepository()`（**两个仓库 runtime 已持有**，可直接用于合成器注入）。
  - `:300-317` `PromptAssemblyService` 已全量 dep-wire 但 `assemble()` 无调用点（休眠，**不要复活整套**）。
  - `:1109-1127` `createLocalScopeWithMode(...)` 调 `upsertConversationScope` **未带 `userId`** → `scope.userId` 为 null。

### 2.3 人格种子源（后端，复用现成好文案）
- `src/main/modules/claude-bridge/worktree-pool.ts:176-284` `getDefaultPersona(agentName)` — butler/copywriter/video-editor/`'video-editor'`/analyst 四段**完整中文 markdown 人格**（角色定位/核心能力/行为准则/Ready 工作台功能）。**WP1 的种子文案直接取这里**，不要另写单薄版本。

### 2.4 渲染层切换器与发送（前端）
- `src/renderer/stores/useAgent.ts:1132-1137` — 硬编码 `agents: [{butler,管家,🤖}, {copywriter,文案,✍️}, {video-editor,剪辑,🎬}, {analyst,分析,📊}]`；`:1147` `currentAgent: 'butler'`；`:1184` `selectAgent: (name) => set({ currentAgent: name })`；发送时用 `currentAgent` → `window.electronAPI.agent.send(currentAgent, …)`。
- 切换器 UI 渲染位于 `src/renderer/components/agent/ChatPanel.tsx` / `chat-panel/ChatPanelBody.tsx`（消费 `store.agents`，需确认）。

### 2.5 IPC / preload 面（两域已全通）
- `src/main/modules/memory-management/ipc-handler.ts` — `userProfile:get/list/create/update/delete`、`agentPersonality:get/list/create/update/delete`（均 catch 错误返回 `{success,error}`，不 throw）。
- `src/preload/index.ts:1009-1043` — `userProfileAPI` / `agentPersonalityAPI` 已暴露；`:1114-1115` 挂到 `electronAPI`。
- `src/renderer/types/electron.d.ts:3298-3299` — `userProfile` / `agentPersonality` 类型已声明。

### 2.6 记忆按钮闭环 bug（前端，本会话已确认）
- `src/renderer/hooks/useMemory.ts:19-34` — `refresh = useCallback(async ()=>{ … query(filtersRef.current) … }, [])` **空依赖**，读 ref；`:36-38` `useEffect(()=>{ void refresh() }, [refresh])` 只在挂载跑一次 → **改筛选不重查**。`runMaintenance`（约 `:190-202`）只调 `refreshStatus()`，不刷新 `useMemoryStats`。
- `src/renderer/components/memory/MemoryStatsCard.tsx:26` — `alert('…已归档: ' + result.archivedCount + …')`，但后端 `MaintenanceResult` 是 `{archivedL1Count, archivedL2Count, prunedCount, optimizedTriggers, timestamp}`（`src/main/modules/agent-control/memory/memory-lifecycle.ts:3-9`）→ `archivedCount` 恒 `undefined`（`prunedCount` 字段存在，无碍）。
- `src/renderer/components/memory/MemoryCreator.tsx`（约 `:28`）— `if (!scopeId || !title || !content) return`，强制 Scope ID；用 `createFromConversation`。
- `src/main/modules/claude-bridge/ipc/memory-group.ts:289-323` — `createFromConversation` 用 `listConversationScopes()` 查 scope，查不到返回 `Scope not found`（`:302-304`）。
- `src/renderer/components/memory/MemoryListPanel.tsx` — 直接展示 `memory.layer`（l0/l1/l2）、`contentKey`（「内容键」）、来源标签等内部词。
- `src/renderer/pages/Settings.tsx`（约 `:2922-2952`）— 记忆区渲染 `MemoryStatsCard`+`MemoryCreator`+`MemoryListPanel`+`TriggerManager`+`<ActiveChildRunsDebug/>`（约 `:2936`）；人格区（约 `:2941-2945`）；用户档案区（约 `:2948-2952`）。

### 2.7 编辑器闭环 bug（前端，源自审查）
- `src/renderer/components/personality/PersonalityEditor.tsx` — `handleSave`（约 `:111-149`）正确分支 create/update **但从不查 `result.success`**；`handleCreateNew`（约 `:176-186`）`prompt(...)` 只改本地 state，不调 create API。
- `src/renderer/components/profile/UserProfileEditor.tsx` — `handleSave`（约 `:119-142`）**永远调 `userProfile.update`**（从不 create）→ 新用户存不进；`handleCreateNew`（约 `:174-185`）只改本地 state；均不查 `result.success`；`default-user` 特判不可删（约 `:146-149, :450`）。

---

## 3. 目标设计（施工后应呈现）

### 3.1 人格（A）
- **一份人格 = 一个可切换 agent**。聊天面板的 agent 列表由 `agent_personalities` 表驱动；四个内置项作为种子人格存在；用户新建人格即在切换器出现并可选。
- 选中某 agent 发消息时，活跃模型 instructions 第一段 = 该 agent 的 `personalityText`（+ `tone`，若有）。
- 设置页人格编辑器：列表/编辑/新建/删除全部闭环（查 `result.success`），保存后切换器同步刷新。
- `tone` 真用（拼进系统提示），`displayName`+emoji 驱动切换器 chip。**纯展示、对模型/切换器都无作用的字段不要留在 UI。**

### 3.2 用户档案（B）
- 降为**单用户「我的偏好」**：删掉多用户列表/新建用户/删除用户；只编辑 `default-user` 的 昵称/语言/回复风格/长期偏好。
- 该档案真正进活跃模型（与人格同走 §1.5 汇聚点合成）。
- `createLocalScopeWithMode` 带上 `userId: 'default-user'`，使 `scope.userId` 有值（记忆归属正确）。

### 3.3 记忆（C）
- 设置页记忆区拆「普通视图 + 高级区」：
  - **普通**（默认可见，hero）：列表「最近记住了什么 / 来自哪次任务 / 删除·保留」，人话标签，不显示 scopeId/层级/contentKey。
  - **高级**（折叠或开发者开关后才显示）：原始 layer/contentKey、触发器管理、手动 `MemoryCreator`（含 scopeId）等。
- `<ActiveChildRunsDebug/>` **移出记忆区**。
- 主叙事从「创建记忆（要 scopeId）」翻成「查看 agent 已沉淀的记忆」。

### 3.4 按钮闭环（D，贯穿三块）
筛选真刷新；维护结果字段正确并刷新统计；创建/删除/维护后列表+统计同步；保存失败真提示失败；新建真创建。

---

## 4. 工作包（每个 = 一个 subagent 任务）

> 约束（CLAUDE.md）：手术式改动、只碰必须碰的文件；先合同后代码、修根因；不复活 `turn-engine`、不复活 `PromptAssemblyService.assemble()` 整套、不做 profile 整目录隔离；新增跨进程功能补齐「IPC→preload→类型→UI→测试」最小闭环。

### WP0 —【后端·地基】系统提示合成器 + 汇聚点接线
**目标**：让「人格正文 + 单用户档案」真正进活跃模型，覆盖所有 send 路径。
**涉及文件**：
- 新增 `src/main/modules/agent-control/runtime-core/persona-system-prompt.ts`。
- 改 `orchestrator.ts`（注入 resolver + send 内兜底合成）、`runtime.ts`（构造时注入 resolver；`createLocalScopeWithMode` 补 userId）。
**契约 / 实现要点**：
1. 合成器（纯函数，可单测）：
   ```ts
   export async function composePersonaSystemPrompt(
     agentName: string,
     personalityRepo: AgentPersonalityRepository,
     userProfileRepo: UserProfileRepository,
     fallback: () => string,           // = defaultSystemPrompt
   ): Promise<string>
   ```
   - 取 `personalityRepo.getPersonality(agentName)`：有则用 `personalityText`，无则 `fallback()`。
   - 若 `tone` 存在，追加一行 `语气：<tone>`。
   - 取 `userProfileRepo.getProfile('default-user')`：拼一段「用户档案（关于当前用户）」块（昵称/语言/回复风格/长期偏好，存在的字段才写）。Hermes 风格表头，便于模型识别。
   - 返回 `personaPart + '\n\n' + userProfileBlock`（任一为空则跳过）。
2. `orchestrator.send`：当**调用方未显式传 `systemPrompt`** 且已注入 `personaResolver` 时，`systemPrompt = await personaResolver(agent)`。仅当结果与 `session` 现有 systemPrompt 不同才 `setSystemPrompt`（避免每轮无谓重置、保前缀缓存）。显式传入的 systemPrompt 优先级最高（保留现有契约）。
   - 提供 `setPersonaResolver(fn)` 注入点；resolver 形如 `(agent: string) => Promise<string | undefined>`。
3. `runtime.ts` 构造时：`orchestrator.setPersonaResolver(agent => composePersonaSystemPrompt(agent, this.agentPersonalityRepository, this.userProfileRepository, defaultSystemPrompt))`。
   - 注意 `defaultSystemPrompt` 当前是 `agent-sdk-runtime.ts` 内的模块私有函数；导出它或在合成器内复刻同一句（择一，优先导出复用，避免双份漂移）。
4. `createLocalScopeWithMode`（runtime.ts:1109-1127）`upsertConversationScope` 入参补 `userId: 'default-user'`。
5. **可选优化（非阻塞）**：按 agent 缓存合成结果，档案/人格写入时失效。v1 可不做（两次带索引 SQLite 读，开销可忽略）。
**验收**：
- 行为测试：构造 runtime（最小替身），对一个种子 agent 触发一次 send，断言传入 SDK 的 instructions 含该 agent 的 `personalityText` 片段 **且** 含 `default-user` 档案字段；切换到另一 agent 断言换成另一段人格。
- 显式传 systemPrompt 时仍优先（回归）。
- `npm run typecheck` 通过。
**依赖**：无（地基）。WP1 落地后此 WP 的人格分支才有真实数据，但 WP0 可先用临时插入的人格行写测试。

### WP1 —【后端·迁移】种子四个内置人格
**目标**：把 `worktree-pool.getDefaultPersona()` 的四段 markdown 落入 `agent_personalities`，供切换器与 WP0 读取。
**涉及文件**：`src/main/modules/migrations.ts`（仿 `:730-737` default-user 种子写法新增一段）。
**契约 / 实现要点**：
- 幂等插入 butler/copywriter/`video-editor`/analyst 四行：`agent_name` = 这四个 id；`personality_text` = 对应 `getDefaultPersona` 文案（**逐字复用**）；`display_name` = 管家/文案/剪辑/分析；`tone` 可留空或给一句；`meta_json` = `{"emoji":"🤖|✍️|🎬|📊"}`。
- 用 `INSERT ... ON CONFLICT(agent_name) DO NOTHING`（或先查后插），不得覆盖用户已改人格。
- 确认 `agent_personalities` 表已在既有 migration 建好；若 `agent_name` 无唯一约束，按现有迁移风格补 UNIQUE（仅在必要且不破坏既有数据时）。
**验收**：`npm run verify:native` 通过；启动后 `agentPersonality.list()` 返回 ≥4 行且文案非空；重复启动不产生重复行。
**依赖**：无。建议先于 WP2 落地（让切换器有真实数据），但 WP2 有兜底。

### WP2 —【前端】聊天切换器由人格仓库驱动
**目标**：聊天面板 agent 列表来自 `agentPersonality.list()`，新建人格即可切换。
**涉及文件**：`src/renderer/stores/useAgent.ts`（`agents` 初始化与加载）、`components/agent/ChatPanel.tsx`/`chat-panel/ChatPanelBody.tsx`（确认消费 `store.agents`）。
**契约 / 实现要点**：
- 启动/打开聊天时调用 `window.electronAPI.agentPersonality.list()`，映射为 `{ name: agentName, displayName, avatar: metaJson?.emoji ?? '🤖', status:'idle' }` 写入 `store.agents`。
- 保留 `currentAgent` 默认 `'butler'`；列表为空（极端情况）时回退到现有四项硬编码，避免空切换器。
- 新建/编辑人格后（WP3）刷新该列表。
**验收**：手动——切换器显示种子四项；在设置新建一个人格后回到聊天，切换器出现该项且可选中发消息；选不同 agent 时模型自我介绍/语气随人格变化（结合 WP0）。`npm run typecheck` 通过。
**依赖**：WP1（数据）、WP0（切换后真的换人格）。

### WP3 —【前端】人格编辑器闭环
**目标**：人格列表/编辑/新建/删除全闭环；与切换器联动。
**涉及文件**：`src/renderer/components/personality/PersonalityEditor.tsx`、`src/renderer/pages/Settings.tsx`（人格区文案）。
**契约 / 实现要点**：
- `handleCreateNew`：真调 `agentPersonality.create({ agentName, personalityText, displayName, tone, metaJson:{emoji} })`；agentName 校验（小写、唯一、非保留冲突可提示）。
- `handleSave`：`create`/`update` 后**检查 `result.success`**，失败给明确错误，不再假成功。
- 保存/新建/删除成功后刷新本地列表，并通知 WP2 的切换器刷新（事件或重新 list）。
- 文案：按钮叫「新建人格 / 编辑人格」；明确「人格 = 聊天面板可切换 agent」。`tone` 字段保留（已被 WP0 使用）；移除纯展示无效字段（若有）。
**验收**：手动——新建人格持久化（重启仍在）；保存失败（如重名）显示失败；删除后切换器与列表同步消失。`npm run typecheck` 通过。
**依赖**：WP2（联动刷新）、WP0（语义真生效）。

### WP4 —【前端】用户档案降为单用户「我的偏好」
**目标**：去掉多用户 CRUD，单 `default-user` 偏好编辑并真接通。
**涉及文件**：`src/renderer/components/profile/UserProfileEditor.tsx`、`src/renderer/pages/Settings.tsx`（区块标题改「我的偏好」）。
**契约 / 实现要点**：
- 删除：用户列表、「新建用户」、「删除用户」入口与相关本地 state。
- 表单字段：昵称→`name`、语言→`preferredLanguage`、回复风格→`communicationStyle`、长期偏好→`preferencesJson.longTermPreferences`。
- `handleSave`：先 `getProfile('default-user')`，存在则 `update`、不存在则 `create({ id:'default-user', … })`（修掉「永远 update」的 bug）；**检查 `result.success`**。
- 保留 `default-user` 作为固定单用户；不提供切换。
**验收**：`npm run verify:native` 通过（持久化）；手动——改昵称/语言/风格/偏好后保存成功并回显；结合 WP0，新会话里模型能体现该偏好。`npm run typecheck` 通过。
**依赖**：WP0（接通）。可与 WP2/WP3 并行。

### WP5 —【前端】记忆普通/高级拆分 + 按钮闭环
**目标**：普通用户只见极简记忆视图；内部机制收进高级；修全部记忆按钮闭环。
**涉及文件**：`src/renderer/pages/Settings.tsx`（记忆区结构、移走 `ActiveChildRunsDebug`）、`src/renderer/hooks/useMemory.ts`、`components/memory/MemoryStatsCard.tsx`、`MemoryListPanel.tsx`、`MemoryCreator.tsx`、`renderer/types/electron.d.ts`（`MemoryMaintenanceResult` 类型对齐）。
**契约 / 实现要点**：
1. **结构**：记忆区分「普通视图」（列表 hero：记住了什么 / 来自哪次任务（人话来源）/ 删除·保留）与「高级」（折叠/开发者开关后显示：原始 layer/contentKey、`TriggerManager`、手动 `MemoryCreator`）。
2. `ActiveChildRunsDebug` 从记忆区移除（移到开发者/调试区或删其在此处的渲染）。
3. **D1 筛选刷新**：`useMemory.ts` 的 `useMemories` 让查询随 `filters` 变化重跑（`refresh` 依赖 `filters`，或 effect 依赖序列化后的 filters）；注意避免无限循环（filters 引用稳定化）。
4. **D2 维护字段**：`MemoryStatsCard.tsx:26` 改读真实字段：`已归档（L1/L2）: ${result.archivedL1Count} / ${result.archivedL2Count}`、`已清理: ${result.prunedCount}`；同步修正 `MemoryMaintenanceResult` 渲染类型与后端 `MaintenanceResult` 一致。
5. **D3 维护后刷新**：`runMaintenance` 成功后刷新 `useMemoryStats` 与列表（共享一个 refresh，或维护后显式触发统计+列表重查）。
6. **D6 手动创建**：普通路径不再要求 scopeId（手动 `MemoryCreator` 整体移入高级区；普通用户不需要它）。若保留常驻记忆手动入口，去掉「必须先有真实会话」的前置（改走不依赖 `listConversationScopes` 的常驻写入路径，或在 UI 隐藏直至高级区）。
7. **标签人话化**：`MemoryListPanel` 普通视图把 layer/contentKey/source 映射为用户可懂文案（如 l0→「常驻」、来源→任务名）。
**验收**：手动——切筛选列表即时刷新；点维护提示显示正确数字且统计/列表随后更新；普通视图无 scopeId/L0-L2/contentKey/Child Runs；创建/删除后列表+统计同步。`npm run typecheck` + `npm run verify:native`（若触及 memory IPC 读写）通过。
**依赖**：无（纯前端为主）。可与 WP0-4 并行。

---

## 5. 依赖与并行顺序
```
WP0 (地基·后端) ──┬──▶ WP3 (人格编辑器)
WP1 (种子·迁移) ──┴──▶ WP2 (切换器)  ── 联动 ── WP3
WP0 ───────────────────▶ WP4 (用户档案)
WP5 (记忆 UI) ── 独立，可全程并行
```
- **可立即并行**：WP0、WP1、WP5（彼此独立）。
- WP2 需 WP1（数据）+WP0（语义）；WP3 需 WP2+WP0；WP4 需 WP0。
- 建议批次：第一批 WP0+WP1+WP5 并行；第二批 WP2+WP4；第三批 WP3 收尾联动。

## 6. 验收与 verify 链（整体）
- `npm run typecheck` 全绿（每个 WP 完成即跑）。
- `npm run verify:native` 通过（WP1 迁移、WP4 档案持久化、WP5 若触及 memory 读写）。
- `npm run test` 通过，且 WP0 新增行为测试（人格+档案真进 instructions）通过。
- **手动回归（必须真跑 app，不能只过测试）**：
  1. 聊天面板切换四个 agent，确认模型自我介绍/语气随人格变化；新建人格后出现在切换器并生效。
  2. 改「我的偏好」后开新会话，确认模型体现偏好（如语言/风格）。
  3. 记忆：切筛选即时刷新；维护数字正确并刷新统计；普通视图无内部术语与 Child Runs。
  4. 人格/档案保存失败（构造一次失败）确认显示失败而非假成功。
- 关键日志：`<临时目录>/ready-directchat.log`（agent 决策，可确认 instructions 是否含人格/档案）。

## 7. 范围红线（不要做什么）
- ❌ 不复活 `turn-engine.ts` / `DirectChatEngine`（活跃路径是 `AgentSdkRuntime`）。
- ❌ 不复活 `PromptAssemblyService.assemble()` 整套 loadSOUL/loadUSER/loadL0；本方案走轻量合成器即可。
- ❌ 不做 profile 整目录隔离（重量级，超范围）。
- ❌ 不改 `worktree-pool` / `AgentManager.spawnAgent` 旧子系统行为（只**读取**其人格文案作种子源）。
- ❌ 不顺手重排/重命名无关代码；只碰每个 WP 列出的文件。
- ❌ 记忆不引入新层级/新内部概念；只做隐藏与人话化。

## 8. 给 Codex 的调度建议
- 每个 WP 派一个 subagent，按 §5 批次并行；WP 之间用「契约 + 验收」对齐，避免互相等待整文件。
- 每个 subagent 完成后自检：`npm run typecheck`，相关则 `npm run verify:native`；提交前不得跳过 SQLite 验收（CLAUDE.md §6）。
- 后端三处（WP0 合成器/orchestrator/runtime）改动集中，建议同一 subagent 串行做完 WP0 再交 WP2/WP3/WP4 依赖它的部分。
- 完成后产出一份「改动清单 + 验收输出」交 Claude 复审；复审重点：①instructions 是否真含人格+档案（看日志/测试）②切换器与编辑器是否联动③记忆普通视图是否无内部术语④四个 bug 是否闭环（筛选/维护字段/假成功/新建用户）。
