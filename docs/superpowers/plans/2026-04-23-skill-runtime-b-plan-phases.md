# B 方案详细实施计划 — Skill Runtime 现代化

> 起草：2026-04-23
> 分支：`codex/skill-runtime-b-plan`
> 上游：[2026-04-23-skill-agent-runtime-b-then-c-roadmap.md](./2026-04-23-skill-agent-runtime-b-then-c-roadmap.md)
> 根因：[2026-04-23-skill-runtime-bootstrap-rootcause.md](./2026-04-23-skill-runtime-bootstrap-rootcause.md)

---

## 0. 目标 & 边界

### 0.1 B 想解决的三件事
1. **止血**：`novel_writer_system` 这类 reference/advisory 技能不再被 `skill_submit_input` 诱导误用，立即可用。
2. **架构**：退役 `skill.workflow.json` + `skill_executions` 状态机，改为「markdown 方法论 + 4 个通用原语 + todo」驱动，让 reference 和 workflow 两类技能 **共享同一套心智模型**。
3. **为 C 造基石**：4 个通用原语（`skill_ask_user` / `skill_run_shell` / `skill_write_artifact` / `skill_read_artifact`）+ 沙箱路径策略 + tool-gating-by-context 模式，后续可无痛升级为全局工具供 C 方案使用。

### 0.2 绝对不能坏的（基线约束）
- `lets-go-rss` 的 rss_add / rss_list / rss_status 等路径在 B 结束前必须保持用户可达
- `video-expert-analyzer` 的 Python 管线仍要能跑出分镜 JSON / 精选帧 / 解说
- `video-copy-analyzer` 的单步分析仍要能产出结果
- UI 上任务卡仍要显示 skill 进度（不强求与现在像素级一致，但不能退化到「只能看对话」）
- 会话 scope 隔离（§6.3）不破坏
- 所有现有的 skill 相关测试在每个 phase 结束时必须继续通过（允许新增替代测试）

### 0.3 不做（本计划内的显式非目标）
- 不改 4 个 domain agent（browser / document / calendar / rss）
- 不引入全局 `Bash` 工具（原语只对 skill agent 开放，前缀 `skill_`）
- 不做 MCP 扩展
- 不动 `src/shared/ai-providers.ts`
- 不动 skill manifest 存储路径、import/export 流程

---

## 1. 架构蓝图

### 1.1 当前状态（Before B）

```
用户消息 ──► intent-classifier ──► skill-domain-adapter
                                        │
                                        ├─► skill_*_read_skill (reference, direct) ──┐
                                        │                                              │
                                        └─► skill_*_{action} (workflow, creates       │
                                                              skill_executions row) ──┤
                                                                                       ▼
                                                                              formatRunResult
                                                                                       │
                                                                                       ▼
     LLM 看到工具：                                                              返回模型
       skill_get_state    ◄── 无条件曝光
       skill_submit_input ◄── 无条件曝光（← 诱导 reference 场景误用）
       skill_submit_confirmation
       skill_submit_agent_result
       skill_restart_from_step
       skill_cancel_execution
       skill_{id}_{action}  (每个技能的动作)
```

### 1.2 目标状态（After B）

```
用户消息 ──► intent-classifier ──► skill-domain-adapter
                                        │
                                        ▼
                             skill-context-orchestrator
                                        │
                                        ├─► reference 技能 ──► 读 SKILL.md ──► isMeta 注入对话
                                        │                        │
                                        │                        └─► 暴露 4 个原语给模型
                                        │
                                        └─► (过渡期) workflow.json ──► 兼容态旧路径
                                                                         （Phase 4 彻底删除）

     LLM 看到工具：
       skill_ask_user           ◄── 按上下文 gated
       skill_run_shell          ◄── 按上下文 gated
       skill_write_artifact     ◄── 按上下文 gated
       skill_read_artifact      ◄── 按上下文 gated
       skill_{id}_{action}     (Phase 4 后简化为 skill_invoke 统一入口 — 可选)
```

### 1.3 核心设计原则
1. **无状态优先**：模型驱动，不是 harness 驱动。skill markdown 指示模型「用原语做 X」，模型自己按 todo 推进。
2. **沙箱路径强制**：`skill_run_shell` 和 `skill_write/read_artifact` 路径都必须落在 `<skill.managedPath>/output/` 子树内，越界即拒。
3. **工具按上下文可见**：只有当前 turn 的激活技能明确需要某原语时才出现在 LLM 工具清单里，减少误导。
4. **向后兼容期**：`skill.workflow.json` 在 Phase 2–3 迁移过程中继续工作；Phase 4 才彻底删除 loader。

---

## 2. Phase 0 — 止血（1–3 天）

### 2.1 目标
不改架构、不加新文件，仅通过「工具面 gating + 描述硬化 + 错误消息分支」三处改动，让 `novel_writer_system` 立即走通，同时不破坏 workflow 技能。

### 2.2 任务清单

#### P0-T1：execution-control 工具按 sessionId 动态曝光
- **文件**：`src/main/modules/tools/skills-tools.ts`
- **改动**：
  - `getSkillToolDefs(sessionId?: string): SkillToolDef[]` —— 新增 sessionId 入参
  - 当 `sessionId` 提供且 `findExecutionForSession(sessionId) === null` 时：
    - 保留：`skill_get_state`（只读操作）
    - 过滤掉：`skill_submit_input` / `skill_submit_confirmation` / `skill_submit_agent_result` / `skill_restart_from_step` / `skill_cancel_execution`
  - `getSkillAnthropicTools(sessionId?)` / `getSkillOpenAITools(sessionId?)` 透传 sessionId
- **文件**：`src/main/modules/agent-control/tool-registry.ts`
- **改动**：
  - `resolveSkillToolSchemas(format, sessionId?)` / `resolveSkillToolDefinitions(sessionId?)` 透传
  - 调用方（`buildAgentTools` 等）从 `request-envelope.sessionId` 取值下传
- **静态 fallback**：`skills-tools-static.ts` 的 STATIC_SKILL_TOOL_NAMES 不变；fallback 路径在运行时 manager 不可用时依旧能给出工具清单

#### P0-T2：工具描述加「禁用性前缀」
- **文件**：`src/main/modules/tools/skill-execution-tool-defs.ts`
- **改动**：5 个 submit_\* / restart / cancel 的 `description` 字段前置一句：
  > `ONLY call this if a previous skill_* tool returned an explicit executionId. Never fabricate an id like "new" or "0".`
- `skill_get_state` 不动（读操作安全）

#### P0-T3：错误消息按「最近注入过的 reference skill」分支
- **文件**：`src/main/modules/tools/skill-execution-missing.ts`
- **改动**：
  - 扩展 `buildSkillExecutionMissingOutput` 入参：新增可选 `lastReferenceSkill?: { id: string; name: string }`
  - 当 `activeExecution === null` 且 `lastReferenceSkill` 存在时，文案改为：
    > `你刚加载了 reference 技能「${name}」，它没有 workflow 状态可以提交。请直接按技能方法论完成任务，不要再调用 skill_submit_*。`
- **文件**：`src/main/modules/agent-control/skill-context-orchestrator.ts`
- **改动**：
  - 在 `maybeInjectExplicitSkillContext` 注入 reference 技能内容时，把 `{ id, name }` 记入 `session.skillHints.lastReferenceSkill`
  - `executeSkillTool` 调用 `runSkillCoordinator` 时从同一 hint 里取值传给 `buildSkillExecutionMissingOutput`

#### P0-T4：Zod golden snapshot 刷新
- **文件**：`src/__tests__/skill-zod-golden-snapshot.test.ts`
- **改动**：由于 P0-T2 改了描述字段，刷新快照；标记此次刷新为「有意的破坏性变更」

### 2.3 测试

**新增**：
| 文件 | 测试内容 |
|---|---|
| `src/__tests__/skill-tool-gating-by-session.test.ts` | 无 session 传入 → 全量曝光；有 session + 无 execution → 仅 `skill_get_state`；有 session + 有 execution → 全量 6 个 |
| `src/__tests__/skill-execution-missing-reference-hint.test.ts` | `lastReferenceSkill` 注入时错误文案替换正确；缺失时走旧文案 |
| `src/__tests__/skill-context-orchestrator-ref-skill-hint.test.ts` | 内联 reference 技能时 `session.skillHints.lastReferenceSkill` 被正确写入 |

**回归**：
- `skill-control-schemas.test.ts`
- `skill-execution-missing-output.test.ts`（现有）
- `skill-context-orchestrator.test.ts`
- `execution-tool-filter-skill-preservation.test.ts`

### 2.4 成功标准
- ✅ `novel_writer_system` 用户 prompt → agent 读 SKILL.md → 直接输出小说场景，工具记录里无 `skill_submit_input` 尝试
- ✅ `lets-go-rss` / `video-expert-analyzer` workflow 场景无任何退化
- ✅ typecheck 通过；上述 3 个新测试 + 4 个回归测试通过
- ✅ `main` 分支的 36 个既有红测试不新增

### 2.5 风险 & 回滚
- **风险 R0-1**：若某处代码假设 6 个 submit_\* 工具总在 Zod schema 里（`getSkillActionSchemas`）。
  - 缓解：检索 `SKILL_CONTROL_SCHEMAS` 的消费点，确认动态 schema 路径只用到 `skill_action` 类别；`execution_control` 类别的 Zod schema 仍静态可得（不受 sessionId 影响）
- **风险 R0-2**：`session.skillHints` 字段污染到 compaction 摘要
  - 缓解：只用于本 turn 决策，不持久化进消息数组；明确排除在摘要构建器之外
- **回滚**：单个 revert commit 即可复原；Phase 0 改动高度局部，无数据迁移

### 2.6 PR 边界
**1 个 PR**：`feat(skill): B Phase 0 — gate workflow tools by session + harden descriptions`

---

## 3. Phase 1 — 通用原语（5–7 天）

### 3.1 目标
给 skill agent 开 4 个 **受控通用原语**，搭配 inline injection 重构，让 reference 技能可以「只靠 markdown 指示 + 原语」完成原本需要 workflow.json 的工作。

### 3.2 新增原语接口

#### `skill_ask_user`
```ts
// 作用：暂停 skill 执行，问用户一个问题，拿回答继续
// 等价于 CC-Source 的 AskUserQuestion
schema: {
  question: string            // 必填，展示给用户的问题
  options?: string[]          // 可选，预设选项（按钮式）
  placeholder?: string        // 可选，自由输入占位符
}
behavior:
  - 通过 IPC 把 question 推到渲染端专用 UI（类似现有 need_input blocker 的胶囊）
  - 当前 turn 挂起（复用现有 blocker 机制的 turn-suspend 管线，不新造）
  - 用户回复后作为 tool result 返回字符串
timeoutMs: 24h（允许跨会话唤醒；Phase 4 上线后观察是否需要改短）
```

#### `skill_run_shell`
```ts
// 作用：在沙箱工作目录下执行 shell 命令（含 Python）
// 等价于受限的 Bash
schema: {
  command: string             // 必填，完整命令行
  timeoutMs?: number          // 默认 60s，最大 600s
  stdin?: string              // 可选
}
behavior:
  - cwd 强制 = 当前技能的 <managedPath>
  - env 注入 CLAUDE_SKILL_DIR / CLAUDE_SKILL_OUTPUT_DIR / PATH（含 venv bin）
  - 路径解析：command 里出现的相对路径解析为 cwd 下
  - 白名单：command 的可执行文件必须在 { skill.managedPath, skill.venvPath/bin, 系统 PATH 白名单（node, python, python3, bash, sh, curl, cat, ls） }
  - stdout/stderr 截断到 8K chars（超出部分写成 artifact 并在结果中注明）
返回:
  {
    exitCode: number
    stdout: string
    stderr: string
    durationMs: number
    artifactPath?: string   // 若 stdout 超过截断阈值，完整内容写到此
  }
```

#### `skill_write_artifact`
```ts
// 作用：把字符串写入技能输出目录下的相对路径
schema: {
  relativePath: string        // 必填，相对 skill output dir；禁止 '..' / 绝对路径
  content: string             // 必填
  encoding?: 'utf-8' | 'base64'   // 默认 utf-8
}
behavior:
  - 路径解析后必须 startsWith(<managedPath>/output/)，否则拒
  - 不能覆盖 SKILL.md / ready-skill.json / manifest 文件
  - 同路径存在时允许覆盖（模型可能要更新结果）
  - 返回 { absolutePath, bytesWritten }
```

#### `skill_read_artifact`
```ts
// 作用：从技能目录（含 output）读文件
schema: {
  relativePath: string        // 必填
  maxBytes?: number           // 默认 32K
}
behavior:
  - 路径解析后必须 startsWith(<managedPath>/) —— 注意可读范围比 write 大，允许读 SKILL.md、README、templates/
  - 超出 maxBytes 截断并注明
  - 返回 { content, bytes, truncated }
```

### 3.3 文件结构

```
src/main/modules/tools/skill-primitives/
├── index.ts                  # 导出 PRIMITIVE_TOOL_DEFS + 调度函数
├── ask-user.ts               # skill_ask_user handler + IPC
├── run-shell.ts              # skill_run_shell handler + sandbox
├── write-artifact.ts         # 写入 + 路径校验
├── read-artifact.ts          # 读取 + 路径校验
├── path-sandbox.ts           # 共享的路径解析与校验（write/read 共用）
└── primitive-schemas.ts      # 4 个原语的 Zod schema（统一放一处）
```

### 3.4 任务清单

#### P1-T1：建立沙箱路径策略
- **新文件**：`src/main/modules/tools/skill-primitives/path-sandbox.ts`
- 接口：
  - `resolveWithinSkillRoot(skillId: string, relativePath: string): string`
  - `resolveWithinSkillOutput(skillId: string, relativePath: string): string`
  - `assertNotReservedPath(absolute: string): void`（禁止写 SKILL.md 等）
- 实现：依赖 `SkillsRuntimeManager.getSkillById(id).managedPath`

#### P1-T2：4 个原语 handler
- 4 个新文件在 `skill-primitives/` 下
- 每个 handler 返回 `ToolExecutionOutput`（沿用 §6.11 的错误契约）
- `ask-user` 需要：
  - 定义新 IPC 通道 `skill:askUserQuestion` / `skill:askUserResponse`
  - 渲染端组件 `src/renderer/components/skill/SkillAskUserPrompt.tsx`
  - 复用现有 turn-suspend 机制：在 handler 内 `await new Promise((resolve) => registerAskUserCallback(resolve))`，timeout 走 abort

#### P1-T3：工具清单合流
- **改**：`src/main/modules/tools/skills-tools.ts::getSkillToolDefs`
- 构造：`[...skillActionTools, ...executionControlTools（Phase 0 已 gated）, ...PRIMITIVE_TOOL_DEFS（按 context gated）]`
- **Primitive gating**：Phase 0 注入的 `session.skillHints.lastReferenceSkill` 存在时曝光原语；workflow 执行中也曝光（供 workflow skill 过渡期使用）
- Zod 动态 schema 缓存逻辑（`computeSkillActionSignature`）扩展为包含原语签名

#### P1-T4：orchestrator 改造 inline 注入
- **改**：`src/main/modules/agent-control/skill-context-orchestrator.ts::maybeInjectExplicitSkillContext`
- 当技能 `runtime === 'reference'` 时：
  - **旧行为**：调 `skill_*_read_skill` 工具（产生 tool_use 日志）
  - **新行为**：直接 `readFileSync(<managedPath>/SKILL.md)` → 作为 `{ role: 'user', isMeta: true, content: <...> }` 注入
  - 同时写入 `session.skillHints.lastReferenceSkill` 给 Phase 0 的错误分支用
- 保留旧代码路径作为 workflow 技能的 fallback（runtime !== reference 时继续走 tool 调用）
- **改**：`custom-skill-registry.ts` 让 reference skill 的 `read_skill` action 默认 `visibility: 'internal'`（避免 LLM 看到这个动作工具）

#### P1-T5：UI 支持
- **新文件**：`src/renderer/components/skill/SkillAskUserPrompt.tsx`
  - 渲染为胶囊，含 question + 选项按钮 + 文本输入
  - 提交后通过 IPC 回传
- **改**：`src/renderer/modules/agent/messageComposer.ts`（如有需要，把 ask_user 响应 composed 进下一 turn）

### 3.5 测试

**新增**：
| 文件 | 测试内容 |
|---|---|
| `src/__tests__/skill-primitive-path-sandbox.test.ts` | `..` / 绝对路径 / 越界 symlink 拒绝；合法路径允许 |
| `src/__tests__/skill-primitive-write-artifact.test.ts` | 写入成功、覆盖允许、reserved 路径拒绝、编码处理 |
| `src/__tests__/skill-primitive-read-artifact.test.ts` | 读取、截断、缺失文件错误 |
| `src/__tests__/skill-primitive-run-shell.test.ts` | cwd 正确、env 注入、超时生效、白名单外命令拒绝、stdout 截断 |
| `src/__tests__/skill-primitive-ask-user-turn-suspend.test.ts` | 挂起→回应→恢复流；abort 取消 |
| `src/__tests__/skill-primitive-tool-gating.test.ts` | 无激活技能 → 原语不曝光；reference 技能激活 → 原语曝光；workflow 执行中 → 曝光 |
| `src/__tests__/skill-reference-inline-injection.test.ts` | reference 技能不走 tool 调用，直接 isMeta 注入；`skillHints.lastReferenceSkill` 被写入 |

**回归**：
- `skill-context-orchestrator.test.ts`
- `skill-reference-output-contract.test.ts`
- `skill-domain-adapter-prefix-narrowing-contract.test.ts`

### 3.6 成功标准
- ✅ 4 个原语各自单元测试通过
- ✅ 沙箱路径穿越攻击全部拦截
- ✅ `ask_user` 跨 turn 挂起 + 恢复在集成测试里走通
- ✅ reference 技能的用户体验（`novel_writer_system`）仍是 Phase 0 的直接生成，没倒退
- ✅ 为 Phase 2 的 skill 迁移准备好所有运行时接口

### 3.7 风险 & 回滚
- **风险 R1-1**：`skill_run_shell` 白名单过严 → 老 skill 的 Python 脚本跑不起来
  - 缓解：Phase 1 在白名单里允许 `python / python3 / node / bash / sh / curl / cat / ls / head / tail / grep / find / mkdir / rm (only within output dir) / cp / mv (only within output dir)`；Phase 2 迁移技能时按需加；遇到真实需要的命令就打点并加白
- **风险 R1-2**：`skill_ask_user` 挂起机制与现有 blocker 机制冲突
  - 缓解：直接复用 `SkillExecutionState.blocker` 的 suspend/resume 管线，增加一个 `blocker.type === 'primitive_ask_user'` 分支；turn-engine 的恢复逻辑不变
- **风险 R1-3**：写 artifact 时并发冲突（两次 skill_run_shell 同时产出同名文件）
  - 缓解：Phase 1 不做并发保护，文档明确「同一 skill 内所有操作串行」；若 Phase 2 遇到真实并发再加锁
- **回滚**：4 个原语是纯新增，删除 `skill-primitives/` 目录和 gating 代码即可；inline injection 回退到 tool 调用版本

### 3.8 PR 边界
**2 个 PR**：
1. `feat(skill): B Phase 1 PR1 — path sandbox + file/shell primitives`（run_shell + write_artifact + read_artifact + path-sandbox + 相关测试）
2. `feat(skill): B Phase 1 PR2 — ask_user primitive + inline injection refactor`（ask_user + IPC + UI + orchestrator 改动 + 相关测试）

---

## 4. Phase 2 — 最小技能迁移（3–5 天）

> **状态：已完成（2026-04-23）** — 按用户指示做成机械迁移，未引入 wrapper 脚本；同时闭合了两处 Phase 1 平台缺口（`getSharedVenvBinDir` 接线 + inline cap 6K→12K）。详见 `CHANGELOG.md` 和 `embedded-skill-video-copy-migration.test.ts`。

### 4.1 目标
拿 `video-copy-analyzer`（最简单的 embedded skill）作为**第一个迁移样本**，验证「markdown + 原语」模式能否替代原来的 `skill.workflow.json`。

### 4.2 迁移前的 video-copy-analyzer 结构
```
assets/embedded-skills/video-copy-analyzer/
├── SKILL.md              # 方法论
├── README.md
├── ready-skill.json      # manifest，含 actions + execution.mode: 'workflow'
├── skill.workflow.json   # runtime_call → agent_task
├── requirements.txt
└── scripts/
    └── analyze.py
```

### 4.3 迁移后结构
```
assets/embedded-skills/video-copy-analyzer/
├── SKILL.md              # 重写：方法论 + 「如何调用原语」指令
├── README.md
├── ready-skill.json      # 精简：runtime: 'reference', defaultAction: 'read_skill', execution.mode: 'advisory'
├── requirements.txt
└── scripts/
    └── analyze.py        # 不变
```

`skill.workflow.json` 删除。

### 4.4 新 SKILL.md 结构（示意）

```markdown
---
name: video-copy-analyzer
description: 对视频文案做分镜级分析并输出结构化结果
when-to-use: 用户给出视频 URL 或本地路径，希望拿到逐段分镜文案
---

# Video Copy Analyzer

## 方法论
（原有内容）

## 执行步骤（给调用该技能的 agent 看）

当你被要求用这个技能分析视频时：

1. 确认输入：视频 URL 或本地文件路径，以及可选的输出格式
2. 调用 `skill_run_shell` 运行分析脚本：
   ```
   command: python scripts/analyze.py --input "<url_or_path>" --output output/result.json
   ```
3. 调用 `skill_read_artifact` 读取 `output/result.json`
4. 将结构化结果用人类可读的格式呈现给用户
5. 如果用户需要导出，调用 `skill_write_artifact` 保存到 `output/analysis-<timestamp>.md`

注意：
- 每一步产出写到 output/ 目录，路径由原语强制沙箱化
- 如果 Python 脚本失败（exitCode != 0），读 stderr 并向用户报告，不要强行继续
```

### 4.5 任务清单

#### P2-T1：改 manifest
- **文件**：`assets/embedded-skills/video-copy-analyzer/ready-skill.json`
- 改动：
  - `runtime` 从 `python` 改为 `reference`（actions 仍然可列出，但都标 `runtime: reference`）
  - 移除 `execution.workflowFile`
  - `execution.mode`: `advisory`

#### P2-T2：重写 SKILL.md
- 按 4.4 模板，保留方法论，补「执行步骤」章节明确原语调用
- 注意：写给模型看，不是写给人看 —— 用祈使句，强调「调原语」

#### P2-T3：删 workflow.json
- `git rm assets/embedded-skills/video-copy-analyzer/skill.workflow.json`

#### P2-T4：runtime-manager 向后兼容
- **改**：`src/main/modules/skills-runtime/runtime-manager.ts`
- 确保 `resolveSkillForExecution` 读到 `runtime: 'reference'` 但仍需要访问 `scripts/analyze.py` 时，用 `managedPath` 正确定位
- 确保 reference 技能的 `venvPython` 仍可用（在 sandbox 的 PATH 里）

#### P2-T5：端到端测试
- **新文件**：`src/__tests__/embedded-skill-video-copy-migration.test.ts`
- 模拟用户 prompt「分析这个视频 https://... 的文案」
- 断言：
  - `skill_run_shell` 被调，command 正确
  - `skill_read_artifact` 读到 `result.json`
  - 最终 agent 回复含结构化分析
  - 无 `skill_executions` 行被创建

### 4.6 测试

**新增**：上面的 migration e2e

**回归**：
- 所有既有 `video-copy` 相关测试（如有）
- `skill-context-orchestrator.test.ts`（确认 reference 技能路径生效）

### 4.7 成功标准
- ✅ 内置 `video-copy-analyzer` 用户可正常触发
- ✅ Python 脚本正常运行（原本能跑的 URL 样本仍 work）
- ✅ 无 `skill_executions` 行
- ✅ 所有原 skill 相关测试通过

### 4.8 风险 & 回滚
- **风险 R2-1**：`analyze.py` 的命令行签名与 SKILL.md 里写的不一致
  - 缓解：Phase 2 第一步先跑一次现有脚本，打印实际参数，再写 SKILL.md
- **风险 R2-2**：Python 脚本依赖 `venvPython`，但 `skill_run_shell` 的 PATH 里用的是系统 python
  - 缓解：原语 env 注入 `PATH=<venvBin>:$PATH`，并在脚本里显式 `#!/usr/bin/env python3`
- **回滚**：restore 3 个文件（ready-skill.json / SKILL.md / skill.workflow.json）

### 4.9 PR 边界
**1 个 PR**：`feat(skill): B Phase 2 — migrate video-copy-analyzer to markdown + primitives`

---

## 5. Phase 3 — 剩余技能迁移（7–10 天）

### 5.1 目标
把 `video-expert-analyzer` 和 `lets-go-rss` 两个复杂技能按 Phase 2 模板迁移。

### 5.2 video-expert-analyzer

复杂点在于它有 **3 个步骤 + 1 个用户确认**：
```
runtime_call (Python pipeline, 产出 scene_scores.json / best_frames/ …)
  ↓
confirmation (user: 精选帧 OK?)
  ↓
agent_task (Claude 写解说)
```

#### 迁移后的 SKILL.md 执行步骤
```markdown
1. 解析输入：视频 URL + 可选阈值参数
2. 调 skill_run_shell 跑 pipeline：
   command: python scripts/pipeline.py --url <url> --scene-threshold <th> --output output/
3. 调 skill_read_artifact 读 output/scene_scores.json，用人类可读格式展示给用户
4. 调 skill_ask_user 请用户确认：
   question: "以下是候选精选帧……是否确认采用？（可输入需要删除的编号列表）"
5. 根据用户反馈：
   - 若直接确认 → 进入第 6 步
   - 若给出删除编号 → 调 skill_run_shell "python scripts/filter.py --drop 3,7"
6. 为每个精选帧写解说 narration（由当前 agent 直接生成文本），批量调 skill_write_artifact 存到 output/narration/<frame_id>.md
7. 调 skill_run_shell 跑收尾打包：python scripts/finalize.py --output output/final.json
8. 向用户呈现最终 output/final.json 的摘要和文件路径
```

#### 关键点
- 第 4 步的 `skill_ask_user` 替代原 `confirmation` blocker
- 第 6 步的「写解说」从原 `agent_task`（submit_agent_result）退化为「模型自己在对话里生成 + 写文件」—— 因为 markdown 驱动后模型天然就在 agent loop 里

#### 脚本拆分
- 原本 `skill.workflow.json` 里的 `runtime_call` 可能是单一脚本，也可能是多个；按需把单脚本拆成 `pipeline.py` / `filter.py` / `finalize.py`，或把所有参数都通过 CLI flag 接入单脚本
- 优先选择「多个小脚本」方案，匹配 markdown 驱动的分步心智

### 5.3 lets-go-rss

rss 技能的现状：
- `skill_rss_add({url, name, category})` 是典型 workflow，创建 rss feed 条目
- `skill_rss_update` / `skill_rss_list` / `skill_rss_status` 是查询/变更
- 大量与 `rss-engine` 的 IPC

#### 迁移策略
- 这一组是**强工具型技能**（每个 action 都是对 rss-engine 的薄封装），不像 video-expert 那样「一个长流程」
- 更适合保留 **典型 tool 形态**，而不是强塞进 markdown
- 做法：
  - `runtime: 'reference'` + 5 个 action 都 `runtime: 'reference'`（但 action 本身是薄胶水）
  - 每个 action 的「执行」通过 `skill_run_shell` 调一个本地脚本？—— **不**，rss-engine 在 Electron 主进程，shell 子进程无法直接访问
  - 替代方案：保留 action tool 的 `skill_rss_add` 形态，但内部实现不再走 `runDefinitionActionDirect`（Python 子进程），而是直接调 `rss-engine` 的 JS API
  - 也就是说：lets-go-rss 的 action 从「Python 脚本」改为「JS handler」，workflow.json 退役，manifest 中新增 `runtime: 'handler'` 分支指向 JS

#### 新 runtime 分支（Phase 3 小规模增）
- **文件**：`src/main/modules/skills-runtime/handler-registry.ts`（新）
- 作用：把 `runtime: 'handler'` 的 action 映射到 JS 函数（`'lets-go-rss:rss_add' → rssEngine.addFeed`）
- 这样 rss 技能既保留 typed tool 体验，又不用维护 Python 管线

#### 迁移后
```
assets/embedded-skills/lets-go-rss/
├── SKILL.md               # 方法论（何时建议 rss 方案、如何选 category）
├── ready-skill.json       # runtime: handler, 5 个 actions 每个有 handler 名
└── README.md
```
（scripts/ 和 requirements.txt 删除）

### 5.4 任务清单

#### P3-T1：迁移 video-expert-analyzer
- 改 manifest、重写 SKILL.md、删 workflow.json
- 按需拆 Python 脚本为 pipeline/filter/finalize
- e2e 测试：`src/__tests__/embedded-skill-video-expert-migration.test.ts`

#### P3-T2：增加 `runtime: 'handler'` 分支
- `handler-registry.ts` 注册 `'lets-go-rss:rss_add'` / `'rss_update'` / `'rss_list'` / `'rss_status'` / `'rss_stats'` 到 rss-engine 的对应函数
- `runtime-manager.ts::runDefinitionActionDirect` 增加 handler 分支

#### P3-T3：迁移 lets-go-rss
- 改 manifest 为 handler runtime
- 删 Python 脚本和 requirements
- 保留 SKILL.md 作为方法论文档
- 已有 `skill_rss_*` 静态工具名映射不变（`STATIC_TOOL_NAMES` 里 5 条）

#### P3-T4：验证所有 3 个迁移后的技能
- 跑集成测试
- `npm run dev` 手动冒烟

### 5.5 测试

**新增**：
- `embedded-skill-video-expert-migration.test.ts`（完整流程覆盖：pipeline 调用 → ask_user → 解说生成 → finalize）
- `embedded-skill-lets-go-rss-handler.test.ts`（5 个 action 通过 handler runtime 调 rss-engine）
- `skill-handler-runtime.test.ts`（handler 注册、未注册报错、签名不匹配报错）

**回归**：
- 所有现有 rss 相关测试（例如 `rss-agent-workbench-regressions.test.ts`）
- 所有 video 相关测试

### 5.6 成功标准
- ✅ 3 个 embedded skill 全部运行在 markdown + 原语（或 handler）模式
- ✅ 无 `skill.workflow.json` 文件存在
- ✅ 既有集成测试全部通过
- ✅ 手动冒烟：三种技能各跑一次典型场景

### 5.7 风险 & 回滚
- **风险 R3-1**：video-expert 的 agent_task 步骤（原本 submit_agent_result）改为直接对话生成后，输出结构化程度可能下降
  - 缓解：SKILL.md 里强调输出格式，并要求模型用 `skill_write_artifact` 落到 JSON；测试检查 JSON schema
- **风险 R3-2**：lets-go-rss 的 handler runtime 引入新抽象
  - 缓解：handler-registry 只做 name → function 映射，代码量 < 50 行；Phase 3 完全可以单独 revert 只保留 video 两个迁移
- **回滚**：每个迁移独立回滚；handler runtime 可以保留（即使未来只服务这一个技能）

### 5.8 PR 边界
**3 个 PR**：
1. `feat(skill): B Phase 3 PR1 — migrate video-expert-analyzer to markdown + primitives`
2. `feat(skill): B Phase 3 PR2 — add handler runtime for JS-backed skill actions`
3. `feat(skill): B Phase 3 PR3 — migrate lets-go-rss to handler runtime`

---

## 6. Phase 4 — 状态机退役 + UI 切换（5–7 天）

### 6.1 目标
**到 Phase 3 结束，已无任何 skill 使用 `skill_executions` 状态机**。Phase 4 彻底删除这套机制，并把任务卡 UI 从 `SkillExecutionDetail` 切到 todo。

### 6.2 删除清单

#### 删除的代码
| 文件 | 处置 |
|---|---|
| `src/main/modules/skills-runtime/execution-coordinator.ts` | 删除 |
| `src/main/modules/skills-runtime/execution-state-store.ts` | 删除 |
| `src/main/modules/skills-runtime/next-action-resolver.ts` | 删除或简化为 no-op 兼容层 |
| `src/main/modules/tools/skill-execution-tool-defs.ts` | 删除（6 个 execution-control 工具不再需要） |
| `src/main/modules/tools/skill-execution-missing.ts` | 删除 |
| `src/__tests__/skill-execution-*.test.ts` | 删除对应用例 |
| `src/__tests__/skill-zod-golden-snapshot.test.ts` | 更新为只覆盖动作工具 schema |

#### 删除的 schema
| 位置 | 处置 |
|---|---|
| `src/main/modules/tools/schemas/skill-control-schemas.ts` | 删除 |
| `src/main/modules/database.ts` migration | 增加新 migration：drop table `skill_executions`, `skill_execution_steps`, `skill_execution_artifacts` |

#### 删除的运行时 API
- `SkillsRuntimeManager.submitExecutionInput / submitExecutionConfirmation / submitExecutionAgentResult / restartExecutionFromStep / cancelExecution / getExecution / listExecutions` —— 全部移除
- `SkillsRuntimeManager.runSkill` 返回类型简化：`SkillRunResult` 的 `mode: 'workflow'` 分支删除，只剩 `reference` 和 `handler`

### 6.3 UI 切换：任务卡从 SkillExecutionDetail 改为 todo

#### 新的 todo 模型
- **新文件**：`src/main/modules/agent-control/skill-task-tracker.ts`
  - 简化的 in-memory todo，每个 sessionId + skillId 一个 `TodoList`
  - 接口：`addTodo(session, item) / updateTodo(session, id, patch) / listTodos(session)`
  - 模型通过 **观察 tool 调用序列** 自动生成 todo（例如第一次 `skill_run_shell` → 新增 todo "运行 pipeline"），或者显式调 `skill_todo_write` 工具

#### 可选：新增 `skill_todo_write` 工具
- schema: `{ action: 'add' | 'update' | 'remove', id?: string, title?: string, status?: 'pending' | 'running' | 'done' | 'blocked' }`
- 让模型显式管理进度
- **决策**：Phase 4 先做隐式版本（从 tool call 推断），Phase 5 视效果决定是否补显式 todo_write

#### UI：`buildSkillProjectionPatch` 重写
- **改**：`src/main/modules/tools/skills-tools.ts::buildSkillProjectionPatch`
- 旧：从 `SkillExecutionDetail.steps / artifacts / blocker` 构造
- 新：从 `SkillTaskTracker.listTodos(session)` + 最近的 tool_event_log 构造
- 字段映射：
  - `steps`: todo 列表
  - `currentStepId`: 最近 running todo
  - `recentArtifacts`: 最近 `skill_write_artifact` 的路径
  - `waitingFor`: 若当前 turn 有 `skill_ask_user` pending → 'clarification'，否则 none
  - `taskContinuation`: sessionId + active skillId

### 6.4 任务清单

#### P4-T1：代码删除 + DB migration
- 删除 6.2 节列出的全部文件
- 新增 DB migration：`2026-04-??-drop-skill-executions.sql`（在 `src/main/modules/migrations.ts` 里注册）
- 跑一次 app 启动验证 migration 无异常

#### P4-T2：simplify skills-tools.ts
- `getSkillToolDefs` 不再合并 `EXECUTION_TOOL_DEFS`，只合动作工具 + 原语
- `executeSkillTool` 删除 `execution_control` 分支
- `runSkillCoordinator` 删除

#### P4-T3：skill-task-tracker + projection patch
- 新 tracker 模块
- `buildSkillProjectionPatch` 重写
- 前端任务卡无需大改，因为 patch 的 projection 字段结构相同

#### P4-T4：feature flag 保护
- `skill-task-tracker` 上线先走 flag `ENABLE_SKILL_TODO_PROJECTION`
- 若 flag off，projection patch 退回空（前端任务卡不显示 skill 特定信息，回落到对话）
- Phase 4 合并后 1 周 flag 稳定则删除

### 6.5 测试

**新增**：
- `src/__tests__/skill-task-tracker.test.ts`
- `src/__tests__/skill-projection-patch-todo-based.test.ts`
- `src/__tests__/skill-execution-tools-removed.test.ts`（负向测试：LLM 拿不到 skill_submit_\*）

**删除**：
- 所有涉及 `SkillExecutionDetail` / `executionCoordinator` 的旧测试

**DB migration 测试**：
- `src/__tests__/migrations-drop-skill-executions.test.ts`

### 6.6 成功标准
- ✅ 代码里无 `SkillExecutionDetail` / `ExecutionCoordinator` / `skill_submit_*` 引用
- ✅ DB 里 `skill_executions*` 三张表删除，migration 可重复执行
- ✅ 任务卡仍能反映 skill 进度（通过 todo）
- ✅ 3 个 embedded skill 继续跑通
- ✅ 全套测试通过（允许有已知红测试，但不增加）

### 6.7 风险 & 回滚
- **风险 R4-1**：删除后某处残留引用导致运行时错误
  - 缓解：先做 dry-run，`tsc --noEmit` + `rg` 全仓搜索关键字
- **风险 R4-2**：DB migration 在老用户库上失败
  - 缓解：migration 用 `DROP TABLE IF EXISTS`；提供回滚 migration 占位（不实现内容）
- **风险 R4-3**：todo projection 下任务卡信息密度下降
  - 缓解：Phase 4 上线初期只暴露给开发者；收集一周用户反馈再全量
- **回滚**：保留 Phase 4 前的 commit 作为 recovery 点，最坏情况直接 revert 整个 PR；DB 层面 migration 不可逆，但 `skill_executions` 表里的数据在 Phase 3 之后已无产品意义

### 6.8 PR 边界
**2 个 PR**：
1. `refactor(skill): B Phase 4 PR1 — retire skill_executions state machine + DB migration`
2. `feat(skill): B Phase 4 PR2 — todo-based projection for skill task cards`

---

## 7. Phase 5 — C 方案准备（2–3 天）

### 7.1 目标
产出「C 方案启动 brief」：把 B 过程中验证过的原语、模式、边界明文化，减少 C 的未知。

### 7.2 交付物

#### 1）C 启动 brief 文档
- **文件**：`docs/superpowers/plans/2026-0?-??-agent-runtime-c-kickoff-brief.md`
- 内容：
  - B 实际上线后的收益对比表（skill 代码量、workflow.json 数量、测试数、运行时复杂度）
  - 4 个原语在 Electron 安全边界里的最终形态（白名单、沙箱路径、超时策略）
  - inline injection 模式可推广到 browser/document/calendar 的可行性分析
  - tool-gating-by-context 能否替代 domain adapter 的现有降级逻辑
  - 决策矩阵：是否启动 C（参考 roadmap §5）

#### 2）Telemetry 仪表盘雏形
- 指标清单（供 Phase 5 之后的 4 周观察期用）：
  - `skill_primitive_used{primitive=run_shell|ask_user|write_artifact|read_artifact}`
  - `skill_primitive_rejected{reason=path_escape|cmd_not_allowlisted|…}`
  - `skill_reference_inlined{skillId}`
  - `skill_todo_transition{from,to}`
  - `skill_migration_regression{skillId}`（对比迁移前后成功率）

#### 3）C 的 Phase-0 草案
（不实施，只是草稿）
- 把 skill 里的 4 个原语升级为全局 `ask_user` / `run_shell` / `write_file` / `read_file`
- 先只对一个 domain（建议 document）开放
- 验证能否用来替代 `document-task-pipeline-executor` 里的一两个简单步骤

### 7.3 任务清单

#### P5-T1：收集 telemetry 数据
- Phase 2/3/4 每个 PR 合进去后，观察两周
- 把实际数据填入「收益对比表」

#### P5-T2：写 C 启动 brief
- 基于真实数据（不是 Phase 0 时的估算）
- 结合 roadmap §5 的决策门清单，给出明确 GO/NO-GO 判断

#### P5-T3：C Phase-0 草案
- 只写「打算怎么做」+ 「第一个 PR 会改哪几个文件」
- 不实施

### 7.4 成功标准
- ✅ C 启动 brief 文档交付
- ✅ 决策门数据齐全可判断
- ✅ C Phase-0 草案评审可进行

### 7.5 PR 边界
**1 个 PR**：`docs: B Phase 5 — C kickoff brief + telemetry dashboard spec`

---

## 8. 总时间线（参考）

```
              Day:  1  2  3  4  5  6  7  8  9 10 11 12 13 14 15 16 17 18 19 20 21 22 23 24 25 26 27 28 29 30 31 32 33
              ─────────────────────────────────────────────────────────────────────────────────────────────────────
Phase 0  止血 ▓▓▓
Phase 1  原语     ▓▓▓▓▓▓▓
Phase 2  迁移 1         ▓▓▓▓
Phase 3  迁移 2+3           ▓▓▓▓▓▓▓▓▓▓
Phase 4  退役 +                          ▓▓▓▓▓▓
         UI 切换
Phase 5  C 准备                               ▓▓▓
```

保守乘 1.3 ×，实际耗时约 **6 周**。

---

## 9. 验证矩阵（每个 phase 合并前检查）

| 检查项 | Phase 0 | Phase 1 | Phase 2 | Phase 3 | Phase 4 | Phase 5 |
|---|---|---|---|---|---|---|
| typecheck | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ |
| 新增单元测试通过 | ✓ | ✓ | ✓ | ✓ | ✓ | N/A |
| 既有 36 个红测不增加 | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ |
| `novel_writer_system` 可用 | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ |
| `video-copy-analyzer` 可用 | ✓ | ✓ | ✓（新路径） | ✓ | ✓ | ✓ |
| `video-expert-analyzer` 可用 | ✓ | ✓ | ✓ | ✓（新路径） | ✓ | ✓ |
| `lets-go-rss` 可用 | ✓ | ✓ | ✓ | ✓（handler） | ✓ | ✓ |
| 沙箱路径穿越测试 | N/A | ✓ | ✓ | ✓ | ✓ | ✓ |
| Skill 任务卡仍显示进度 | ✓（旧路径） | ✓ | ✓ | ✓ | ✓（新 todo 路径） | ✓ |
| DB migration 可重跑 | N/A | N/A | N/A | N/A | ✓ | N/A |
| CLAUDE.md 同步更新 | 若改 §6.7/6.10 必改 | ✓ §6.7 | ✓ | ✓ | ✓ | ✓ |

---

## 10. 回滚策略

每个 phase 都设计为 **可独立 revert**：
- Phase 0：1 个 PR，revert 直接走
- Phase 1：2 个 PR，revert PR2 先、再 revert PR1
- Phase 2：1 个 PR，restore 3 个 asset 文件 + revert manifest
- Phase 3：3 个 PR，按 PR 顺序反向 revert
- Phase 4：2 个 PR，revert 会涉及 DB migration —— 接受 DB 不回滚，只 revert 代码（`skill_executions` 表留空即可）

**最坏情况 recovery**：保留 `main@ce98417`（B 启动前的 commit）作为恢复锚点，紧急回滚 `git reset --hard ce98417`（需与团队确认）。

---

## 11. CLAUDE.md / AGENTS.md 同步计划

每个 phase 合并时**必须**同步更新：
- §6.7（技能中心）：反映新架构（markdown + 原语 + handler runtime）
- §6.10（工具策略仲裁）：`skill_submit_*` 删除后相关表述更新
- §6.11（工具错误契约）：原语遵守同一契约，具体错误类型枚举补充

新增条款（Phase 1 之后）：
- §6.12（新增）「Skill 原语沙箱边界」：明确 run_shell 白名单、write_artifact 路径规则、ask_user 跨 turn 挂起机制

---

## 12. 开放问题（实施前再确认）

1. **`skill_ask_user` 的跨会话持久化策略**：若用户关闭 app 后再开，pending 的 ask_user 是直接失效，还是提示「上次有一个 skill 在等你回复」？
   - 建议：Phase 1 先做 in-memory（会话级），Phase 5 观察需求再决定
2. **`skill_run_shell` 的白名单是否开放用户自定义**：某些 custom skill 可能需要不在默认白名单的命令（如 `ffmpeg`）
   - 建议：Phase 1 不开放；Phase 3 视 embedded skill 需要扩展白名单；Phase 5 评估「用户可配置」
3. **是否立刻废除动态 `skill_<id>_<action>` 工具**：迁移后 reference 技能的 action 工具仍然存在（`visibility: 'internal'` 隐藏）
   - 建议：Phase 4 保留（代码量小），Phase 5 评估是否换为单一 `skill_invoke(name, args?)`
4. **runtime: 'handler' 是否会挤占 runtime: 'reference' 的语义边界**
   - 建议：handler 只用于强 typed-tool 场景（lets-go-rss 这一家）；普通迁移优先 reference + 原语

---

## 13. 第一个 commit 的具体 scope

本计划落地的**第一个 commit** 就是本文档 + [roadmap](./2026-04-23-skill-agent-runtime-b-then-c-roadmap.md) 的创建。之后按 Phase 0 任务清单（§2.2）动手。

Phase 0 的实际改动**预计 5 个文件**：
- `src/main/modules/tools/skills-tools.ts`
- `src/main/modules/tools/skill-execution-tool-defs.ts`
- `src/main/modules/tools/skill-execution-missing.ts`
- `src/main/modules/agent-control/skill-context-orchestrator.ts`
- `src/main/modules/agent-control/tool-registry.ts`
- 配套 3 个新测试

估算 1–2 个工作日完成。
