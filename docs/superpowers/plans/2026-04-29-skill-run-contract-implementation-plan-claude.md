# Skill Run Contract 实施计划（Claude 版）

> 与 codex 的 `2026-04-29-skill-run-contract-long-skill-ownership-route.md` 互为兄弟文档。
>
> 同意的部分不重复证明；只写我认为需要收紧或补齐的地方，并把 CC-Source 给出的 ownership 模型落到 Ready 当下的代码事实上。

**Goal:** 让 recoverable 长任务从一份显式、可序列化、跨 turn 可重建的 `SkillRunContract` 续跑，而不是从摘要文本、artifact 反推、或者父 turn 里的空 `force_tool` 续跑。

**与 codex 路线的关系：**
- 同意 codex 的 Stage A→F 骨架与"先红测再修"的顺序。
- 不同意三处细节，且 codex 的 Stage G 对 Ready 来说不能停在"文档化"——必须在代码里留下边界标记。
- 补一处 codex 漏写的关键问题：**契约的持久化源在哪里**。

---

## 1. 从 CC-Source 学到、Ready 还没装上的三件事

CC-Source 的有用之处不是 CLI 细节，而是它的 ownership 规则。三条直接可移植：

### 1.1 长任务有自己的 loop，不是父 loop 的一次工具调用
`src/tools/AgentTool/runAgent.ts:700-757` 的模式：
1. 父 loop 调 `createSubagentContext(...)`，拿到一个**完整解耦**的 `agentToolUseContext`：自己的 `agentId`、自己的 `abortController`、自己的 `messages`、自己的 `readFileState`。
2. 父 loop 然后 `for await (const message of query({ ..., toolUseContext: agentToolUseContext }))` —— 用同一个 `query()` 函数，但跑在子上下文里。
3. 子 agent 通过 `recordSidechainTranscript(initialMessages, agentId)` 把状态落盘。
4. Resume 是单独的 `resumeAgentBackground`（`src/tools/AgentTool/resumeAgent.ts`），从 sidechain 重建上下文，**不是父 loop 强续工具调用**。

父 loop 永远不会"硬塞一个空 input 把子任务续一步"。这就是 Ready 现在 force_tool 派 `input: {}` 的反例。

### 1.2 身份是 typed prefix + 8 char 随机，从来不靠 artifact 路径推断
`src/Task.ts:79-105` 把 `taskId` 生成为 `<typePrefix><8 base36 chars>`：

```ts
const TASK_ID_PREFIXES = {
  local_bash: 'b',
  local_agent: 'a',
  remote_agent: 'r',
  in_process_teammate: 't',
  local_workflow: 'w',
  monitor_mcp: 'm',
  dream: 'd',
}
```

两个 task 永远不会撞身份，因为身份是**内禀的**，不是"它们共享同一个 outputDir"。

对照 Ready：`task-projection-repository.ts:215-241` 的 `findByArtifactSiblings(args)` 接收 `skillId: string | null` 但 SQL 里完全没用它，只按 `scopeId + artifact 路径重叠`找兄弟记录。这就是 codex finding 8 ("不同 skill 共享 outputDir 时 supersede 误合并") 的根因——**身份模型选错了**。

### 1.3 Tool 结果带 typed 更新 slot，loop 在下一轮模型调用前应用
`src/Tool.ts:215-225` 的 `ToolUseContext` 显式列出跨迭代共享的 slot：`fileReadingLimits`、`loadedNestedMemoryPaths`、`dynamicSkillDirTriggers`、`discoveredSkillNames`。这些不是从摘要文本里 grep 出来的，是**typed slot**。

Ready 的 `TurnFramePatch`（`turn-frame.ts:116-157`）形状对了——`discoveredHandles / activeArtifactRoots / configValidation / livenessHint / skillStatusUpdates` —— 但**整个 main 模块树里只有 `skills-tools.ts:607` 一处 framePatch 引用，且是透传**。Stage 5 已经声明了管道，但**没有任何 producer**。

---

## 2. 三处对 codex 计划的具体修订

### 2.1 `SkillRunContract` 必须自己拥有 force-loop 防护状态

codex 的 contract shape 缺了：

```ts
forceLoopGuard: {
  lastForceToolName: string | null
  lastForceToolDispatchedAt: string | null
  consecutiveForceCount: number
}
```

今天 `turn-engine.ts:1770` 的 `recentForceToolDispatched` 是迭代内 bool。一旦 contract 被定义成"跨 turn 可恢复"，这块状态必须搬进 contract，否则下一轮新 turn 重建 frame 时这个 flag 丢失，模型可以无限次被强推同一个工具。

### 2.2 Stage D 必须列穷 framePatch 的 producer

今天**零**个 main 模块 handler 在生产 framePatch。如果 Stage D 只接通 typed action 一个 producer，剩下的管道继续空跑。最小完整列表：

| Handler 位置 | 必须写入的 framePatch 字段 |
| --- | --- |
| `executeSkillTool` typed-action 分支（`skills-tools.ts:1338-1419`） | `discoveredHandles{taskRunId,detachedTaskId,jobId}`、`skillStatusUpdates{outputDir,runStatePath,artifactPaths,status,liveness}`、`livenessHint`、`activeArtifactRoots: [outputDir]` |
| `skill_inspect_run_state` | `skillStatusUpdates{status,liveness,progress,blocker}`、`activeArtifactRoots` |
| `skill_inspect_detached` | 同 inspect_run_state，外加 `discoveredHandles{detachedTaskId,jobId}` |
| `skill_patch_config` | `configValidation{valid,reason,message}`；valid===true 时 `skillStatusUpdates{staleBlockerReason: null}` |
| `skill_start_detached` | `discoveredHandles{detachedTaskId,jobId,outputDir}`、`livenessHint: 'running_process'` |
| `skill_read_artifact` | **consumer only**——必须先读 `frame.activeArtifactRoots`，找不到再回退原解析逻辑 |

不列穷，"Stage D 完成"就可能只接通一两个 handler。

### 2.3 Stage A 期望失败信息要更具体

codex 写"FAIL with `tool_not_registered` or `input_validation`"。读 `tool-executor.ts:113-138` 可知：Zod `validateToolInput` 在 dispatch 解析**之前**先跑。所以：

- **VEA `video_expert_pipeline`**：必填 `url`（`assets/embedded-skills/video-expert-analyzer/ready-skill.json` 已确认）。force_tool 派 `{}` 必先撞 `input_validation`，`firstPath === 'url'`。
- **VEA `video_expert_ai_analyze`**：必填 `sceneScoresPath`。`firstPath === 'sceneScoresPath'`。
- 只有在 tool 名根本注册不上时才会到 `tool_not_registered`，对静态 manifest 已声明的 VEA action 不会先撞这个。

Stage A 的断言应该明确到字段名，而不是 `errorKind` 二选一的并集。这样 bug 修了一半（input 填上了但 schema 改坏了）也能被这条测试抓住。

---

## 3. codex 漏写的问题：契约的持久化源在哪里？

codex §8 写"Do not treat `framePatch` as durable storage"——同意。但 codex 全篇没说 contract 跨 turn / 跨进程重启时**到底从哪里读出来**。

两种选择：
- **A. 新表 `skill_run_contracts`**，按 `(scopeId, skillId, outputDir)` 索引。
- **B. 复用现有 durable 源**：`<outputDir>/run_state.json`（VEA 已经在写）+ `task_projection_records`（已在 DB）+ supervisor in-memory snapshot + ephemeral execution store。

**我推荐 B**，A 留给未来真做 child-loop 时再上：

| 源 | 已有内容 | Contract 派生字段 |
| --- | --- | --- |
| `<outputDir>/run_state.json` | stage 进度、scene_scores 路径、delivery_report 路径、url、status | `progress / artifactPaths / sourceUrl / status` |
| `task_projection_records` | `recentArtifacts / continuationRef / blockedReason / resumableActions` | `taskRunId / detachedTaskId / blocker / resumableActions` |
| supervisor snapshot | liveness 实时观察 | `liveness` |
| reference-skill hint / ephemeral store | session-scope 提示 | `skillId / skillName` |

也就是说，**Stage C 不该新增持久化层**，应该新增一个：

```ts
loadSkillRunContract({
  scopeId, skillId, outputDir, sessionId,
}): SkillRunContract | null
```

它是个**读模型**：把上述四个源normalize 成一份 contract。写入由现有 producer（typed action / supervisor / projection-sync）各自负责。

如果未来真做 child-loop runtime（codex Stage G+），再上 `skill_run_contracts` 表作为 parent 视角对 child owned-state 的快照——但**不是现在**。

---

## 4. 修订后的 Stage Map

骨架沿用 codex A→F，下面只写差异。

### Stage A — 锁定红测（断言更尖）

- **A1**：`defaultToolRegistry` 不打补丁。VEA `recoverable_paused` 状态 + force_tool。断言 `errorKind === 'input_validation'` 且 `firstPath === 'url' | 'sceneScoresPath'`（按 action 区分）。
- **A2**：力推 `{}` 进 schema 必填的 action，断言永远不应发生。
- **A3**：next-frame artifact 连续性。同 codex。
- **A4 (新)**：进程重启 fixture。读现成的 `run_state.json` 重建 contract。断言 `sceneScoresPath / outputDir / status` 与重启前一致。今天会失败因为 contract 类型不存在。

### Stage B — 注册表/schema 一致

- 同 codex B1-B4。
- **B5 (补)**：`getSkillActionSchemas` 在运行时 manager 不可用时也回退到静态 manifest 派生的 Zod schema，否则"静态 fallback dispatch 通过 + Zod 校验放行所有"会变成更隐蔽的洞。

### Stage C — 把 Contract 做成读模型

- **C1**：在 `run-contracts.ts` 加 `SkillRunContract` 类型 + `loadSkillRunContract({...})` 读函数。读函数只读不写。
- **C2**：`TurnFrame.skill` 加 `runContract: SkillRunContract | null`。`turn-frame-resolver` 在 resolve frame 时调 `loadSkillRunContract` 填进去。
- **C3**：typed action 结果走 framePatch 更新 contract（不是替换 contract，是 `discoveredHandles + skillStatusUpdates`）。
- **C4**：supervisor 现有 reconcile 路径同时填 contract liveness slot。
- **C5**：targeted test 同 codex。
- **C6 (新)**：contract 加 `forceLoopGuard`（§2.1）。`buildTurnFrameSteering` 读它；`turn-engine` 不再单独维护 `recentForceToolDispatched` —— 这块状态搬进 contract。

### Stage D — Producer 列穷

按 §2.2 表，**每个 handler 一个独立 step**，每个 step 自带 targeted test 验证 framePatch shape。
- D1: typed action
- D2: skill_inspect_run_state
- D3: skill_inspect_detached
- D4: skill_patch_config
- D5: skill_start_detached
- D6: skill_read_artifact 改为 **consumer**（先读 frame roots，再回退）

### Stage E — Force_tool 走 contract 派生 input

- E1：`TurnFrame.steering` 加 `FrameAction { mode, toolName, input, reason, missingInputs }`。保留旧 `requiredToolName` 兼容。
- E2：从 `frame.skill.runContract` 派生 `actionInput`：
  - `video_expert_pipeline`：`{ url, outputDir? }`
  - `video_expert_ai_analyze`：`{ sceneScoresPath }`
  - 一般规则：取 contract 的 `originalInput` ∪ `actionInput` ∪ `artifactPaths` ∪ supervisor 已发现的 handle，按 schema required 字段 cherry-pick。
- E3：派发前用 `getSkillActionSchemas()[toolName]` 跑一次 `safeParse`。失败 → 不派发。
- E4：派不出 → `mode: 'checkpoint'`，`reason: 'missing_<fieldName>'`，systemReminder 明确告诉模型缺哪个字段。**不再硬塞 `{}`**。
- E5：targeted test。
- **E6 (新)**：reason 字段格式契约 `missing_<schemaPath>`，下游可以解析；checkpoint 显示给用户的中文文案从 reason 派生（"等待补充：scene_scores.json 路径"）。

### Stage F — Projection 消费 contract

- F1：`ProjectionTruthSnapshot.frameSnapshot.skill` 扩字段：`sceneScoresPath / deliveryReportPath / status / liveness / progress / terminalReason / actionInputDigest / projectionStableKey`。
- F2：`task-projection-sync.ts` 改吃 `frameSnapshot` 优先，summary/artifacts 仅 fallback。
- F3：**身份升级**——`findByArtifactSiblings` 加 `skillId` SQL 过滤；supersede 键从"artifact 重叠"改为"`(scopeId, skillId, outputDir | runStatePath)` 命中"。这是 §1.2 的 CC-Source 规则落地。
- F4：targeted test。
- **F5 (新)**：跨 skill 不应 supersede 的回归测试——两个 skill 共享 outputDir 前缀（罕见但存在）也不应误合并。

### Stage G — Child-loop 边界**写进代码**，不止文档化

codex 把 G 放成纯文档步骤；我认为不够。Ready 现在的代码里有几处明显的"父 loop 在做应该是子 loop 做的事"，下次架构走查会写出一模一样的 9 条 finding，除非现在就在代码里留下标记。

- **G1**：在以下位置插 `// TODO(skill-child-loop):` 标记 + 一行说明：
  - `turn-engine.ts:2073-2094` 的 force_tool dispatch 块——"长 skill 的下一步应该由 child runner 决定，不是父 turn 的合成 toolCall"。
  - `skills-tools.ts:1338-1419` typed action 等结果块——"这块是父 turn 在等子任务完成；child runner 应该返回 awaitable handle，父只 poll"。
  - `skill-task-supervisor.ts` 的 reconcile 入口——"liveness 应该由 child runner 自报，不是父 supervisor 拉"。
- **G2**：写 `docs/architecture/skill-child-loop-boundary.md`，引用 CC-Source `runAgent.ts` 当 reference impl。Ready 不立即抄，但下次重构有锚点。
- **G3**：guardrail test：budget 用尽 + 后台 detached 仍存活 → `terminalReason === 'checkpoint_background'`，**永远不会** `'done'`。这是 codex G3 的强化——加上"否则就是把假完成当真完成"的负向断言。

---

## 5. 验收链（覆盖 codex §2 的版本）

```
recoverable VEA on disk: <outputDir>/run_state.json + task_projection row
  ↓
loadSkillRunContract({scopeId, skillId, outputDir, sessionId})
  → 读 run_state.json + projection + supervisor + ref-hint
  → 返回 SkillRunContract（含 actionInput / artifactPaths / forceLoopGuard / sourceUrl）
  ↓
TurnFrame.skill.runContract 已附着
  ↓
buildTurnFrameSteering(frame)
  → 派生 FrameAction { toolName, input, missingInputs, reason }
  ↓
if missingInputs.length === 0:
  force_tool 派发（input 已 Zod-validated）
  → tool-executor 校验通过
  → executeSkillTool 跑 typed action
  → 返回 ToolExecutionOutput { framePatch: {discoveredHandles, livenessHint, activeArtifactRoots, skillStatusUpdates}, projectionPatch }
  → applyTurnFramePatch 更新 frame
  → 下一轮 frameSnapshot 直接带新 artifact 路径 / 新 status
  → projection-sync 优先读 frameSnapshot，summary 仅 fallback
  → frame 的 forceLoopGuard 已自增（防止下一轮再无意义 force）
else:
  steering = checkpoint
  reason = 'missing_<field>'
  systemReminder 明确写出缺哪个字段
  → UI 显示"等待补充：<字段中文名>"
  → 永不派发 input: {} 的 force_tool
```

**任何 stage 跑通的判定**：上面这条链能跑过实测、无 monkey-patch、registry 真实、tool-executor 真实，且**两条**负向 case 都被覆盖（缺 url / 缺 sceneScoresPath）。

---

## 6. Non-Goals（在 codex §8 基础上加）

- **不**新增 `skill_run_contracts` 表。这一轮把 contract 做成读模型，复用 `run_state.json + task_projection`。
- **不**承诺超出 `run_state.json + DB projection` 已有的崩溃恢复能力。
- **不**把 `forceLoopGuard` 状态留在 turn engine 局部；它必须在 contract 里。
- **不**让 `skill_read_artifact` 在 frame roots 已填的情况下还跑原解析路径。
- **不**在这一轮做真正的 child-loop runtime —— 但**必须**留 `// TODO(skill-child-loop):` 标记。
- **不**依赖 system prompt reminder 来代替架构修复。

---

## 7. 优先级（如果只能落 3 件）

按对用户可见 bug 的影响排序：

1. **Stage B + Stage E1+E3+E4**：force_tool 要么派合法 input，要么 checkpoint。空 input force 是最显眼的 bug，且会让用户看到"明明知道任务没完成却又装作派了一刀"。
2. **Stage C1+C2+C3**：contract 类型存在 + 挂在 frame 上 + typed action 写入。没有它，下一轮 bug 没地方"住"。
3. **Stage D1 + D6**：typed action 产 framePatch + `skill_read_artifact` 读 frame roots。没有这俩，同 turn 内发现的 artifact 不会变成下一轮的真相。

Stage F（projection）和 Stage G（child-loop 边界标记）次优——重要但不是这次修复的核心 bug。Stage F3（身份过滤）可以单独提一个紧凑 PR，不一定要等整个 Stage F。

---

## 8. 与 codex 计划的对照速查

| 维度 | codex 路线 | 本路线 |
| --- | --- | --- |
| Stage A 期望失败 | `tool_not_registered` 或 `input_validation` | 明确 `input_validation` 且 firstPath = 缺失字段名 |
| Stage A 测试覆盖 | 3 条 | 4 条（加进程重启重建 fixture） |
| Stage B schema fallback | 隐式 | 显式 B5：runtime manager 缺时静态 manifest 派生 schema |
| Stage C 持久化策略 | 未定义 | 明确：读模型，复用 run_state.json + projection |
| Stage C forceLoopGuard | 不在 contract 里 | 在 contract 里 |
| Stage D producer 列表 | "discovers handles, roots, ..."，没列穷 | 6 个 handler 各自一行明确字段 |
| Stage E checkpoint reason | "clear reminder" | 格式契约 `missing_<field>`，UI 文案派生 |
| Stage F 身份升级 | 顺手提了一句 F3 | 升级为身份模型替换（CC-Source 规则） |
| Stage G | 文档化 | 代码内 TODO 标记 + 单独架构文档 + guardrail 负向测试 |
| 持久化层新增 | 未表态 | 明确 No-Goal |

---

## 9. 给下一位实施者的话

修复顺序很重要：

1. 先证明 force_tool + 真实 registry 必撞 `input_validation`（不打补丁）。
2. 再让 dispatch 与 schema 在静态 fallback 下一致。
3. 再加 contract（**读模型**，不新建表）。
4. 再让 force 派发消费 contract。
5. 再让 projection 从 frame 真相消费。
6. 在代码里留下 child-loop TODO 标记 + 架构文档。
7. **不要**先去做 child-loop runtime；那是下一条路线。

如果之后又发现 contract 缺字段：先在 `SkillRunContract` 加字段并加生产者测试，再给消费者加分支。**不要只给消费者打补丁**。这是 memory 里"架构优先于战术补丁"的具体表现。

---

## 10. 一句话立场

codex 的计划方向对，骨架我会照做。我的核心补充是：**契约要有持久化源（读模型，不要新建表），producer 要列穷，身份要换模型（CC-Source 规则），child-loop 边界要在代码里留标记**。少了这四样，下一轮架构走查会写出几乎一模一样的 9 条 finding，只是症状会换地方。
