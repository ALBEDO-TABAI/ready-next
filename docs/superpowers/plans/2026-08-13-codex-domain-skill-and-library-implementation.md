---
title: Codex 下领域技能与资料库实施计划
date: 2026-08-13
status: ready
enforce: true
depends_on:
  - docs/superpowers/plans/2026-08-13-codex-capability-relight-index.md
  - docs/architecture/current-runtime-contracts.md
supersedes_live:
  - docs/agent-evolution/04-主Agent与专项Agent派生体系设计明细.md
  - docs/superpowers/plans/2026-06-13-agent-evolution-phase4-implementation.md
  - docs/superpowers/plans/2026-06-19-specialist-agent-creation-blueprint-implementation.md
note: >
  旧专项 live 路径保持退役。本文不恢复 preroute、handoff、人格注入或 AgentFactory。
  用户口中的“专项”在实现上拆成技能、按需资料和会话标签。
---

# Codex 下领域技能与资料库

## 目标

让 Ready 重新具备“不同日常工作有不同方法、知识和习惯积累”的产品能力，同时继续遵守现行 Codex 身份、权限和收口红线。

用户可以说“剪辑专项”“周报专项”。实现上永远是同一个中性 Codex 宿主，只是本轮选中了技能、点名了资料，或给会话贴了审计标签。

## 机器合同

1. Codex live 的 `developerInstructions` 仍只有固定 overlay。禁止出现 `用户画像`、`人格定义`、`USER.md`、`SOUL`、routing card 正文或历史 Agent RULES。
2. `additionalContext` 只允许资源版本引用；记忆卡正文不得作为 hidden context 进入。
3. 默认 Codex allow-set 不得包含 `memory_create`、`memory_search`、`memory_update`、`memory_list_recent`、`memory_write_card`、`memory_read_card`、`session_search`。只有本轮用户显式点名资料夹 / 记忆卡，或选中明确声明这些 primitive 的技能时，才按地板并入只读检索工具。
4. 写卡工具若重新进入模型面，默认只能写 `staged`；晋升必须走用户确认 IPC。`check-model-card-write-staged.cjs` 继续绿。
5. 公开 IPC 仍不得出现专项创建、改名、派生、预路由、handoff 采纳。`agent:specialistBlueprint:list`、`agent:registry:list`、`agent:registry:listKnowledge` 保持只读。
6. 生产 composition 不得 import `deriveSpecialistAgent`、`confirmCreate` 或 `session-preroute`。
7. 后台整理继续 0 次 provider 调用。
8. 换技能或换资料不得改写已有 native thread 的根指令；需要不同方法时由下一轮 pinned skill / 显式资源进入，或用户开新会话。
9. `ownerAgentId` 继续只做审计/会话标签，不得改变工具面或 overlay。
10. sidecar 继续隔离 `HOME` / `CODEX_HOME`，`agents.enabled=false`，`personality` 省略。

## 完成标准

- 用户在设置页看到的人格、专项名册、信念卡被明确标成历史资料；任何入口都不能让人以为换了这些就会换 Agent 身份。
- 用户显式 `@` 一张已确认卡或 pin 一个资料夹后，模型能按需读到内容，并完成与该资料相关的本轮任务；未点名时 Codex 输入与工具面都不含这些资料。
- 用户显式选择或 `@` 一个领域技能后，方法论经原生 skill input 进入，工具面等于该技能授权 ∪ 本轮资源地板。
- 旧管家/文案/剪辑名字若仍出现在会话选择器，只作为标签，不加载对应 SOUL/RULES。
- 下列 gate 全绿：既有 `verify:evolution-p1/p3/p4`、新增本计划焦点测试、`npm run typecheck`。涉及 SQLite 时加 `verify:native`。

## 禁止事项

- 复活公开专项创建漏斗、预路由、handoff、non-user successor。
- 把 Codex `personality` / `spawnAgent` / 项目 `AGENTS.md` 当成专项实现。
- 把历史 `agents/{id}/RULES.md` 自动写进 `developerInstructions`。
- 为“越用越准”重新打开 LLM 维护回合。
- 让 `memory_search` 在默认面上把整库倾倒进模型。
- 选择器继续暗示“换一个人格就会换一个 Agent”。

## 应用事实（落地时不得绕过）

- Overlay 唯一来源：`src/main/modules/agent-control/codex-runtime/codex-thread-instructions.ts` 的 `CODEX_HOST_OVERLAY`。
- 旧注入仍在 `prompt-assembly.ts`，但不在 Codex send 图。`codex-live-graph-contract.test.ts` 禁止 `promptAssembly` 进入 coordinator。
- 记忆组仍注册在 `tool-registry.ts` 的 `MEMORY_TOOL_NAMES` / `SESSION_RECALL_TOOL_NAMES`，且不在 `resolveIntentCapabilityGroupModes` 的 false 列表里，因此会漏进 Codex 默认面。
- 退役门禁已存在：`check-preroute-status-single-source.cjs`、`check-agent-handoff-retired.cjs`、`specialist-ipc-readonly`、`specialist-tools-retired`、`check-specialist-studio-readonly.cjs`。
- 历史资产可整理：信念卡 transition、Studio 文件提案、设置页人格/偏好编辑。这些可以留下，但文案必须继续声明不改变当前 Codex。
- 设置页高级区若仍写“当模式匹配时自动加载相关记忆”，这是 TriggerManager 旧承诺，必须改成“仅存档，不自动注入”。

## 保留与放弃

| 旧能力 | 处置 |
| --- | --- |
| 领域方法论（RULES） | **保留为技能。** 新领域用 embedded/imported skill；历史 RULES 只在用户确认后迁移成 skill 正文 |
| 领域知识卡 | **保留为资料库。** 可读、可整理、可按需引用；默认不注入 |
| 用户确认后的派生/退役审计 | **保留只读名册。** 不再作为运行时 owner |
| 人格 / SOUL / 语气扮演 | **放弃 live。** 档案可看；不得进 Codex |
| 预路由 / handoff / 自动换会话 | **放弃。** 用户自己选会话或选技能 |
| USER.md 常驻 L0 | **放弃自动注入。** 后续若做习惯，只允许另立的短偏好资源 |
| ownerAgentId | **保留审计标签** |
| 本地 crystallize / decay / staged 学习 | **保留。** 继续 0 provider |

## 工单

### D0 · 先关泄漏，再谈积累

缺口：合同说记忆不得进工具面，实现上 `memory_*` / `session_search` 仍可能出现在 Codex allow-set。

改动：

- `resolveReadyToolTurnSnapshot` 之后的产品 composition 增加默认剥夺：`memory` 与 `session_recall` 组不进 Codex allow-set。
- 只有本轮 `SendScopedResourceSelection` 出现 `knowledge_card` / `knowledge_folder`，或选中技能的 `allowedPrimitives` 显式包含只读检索名时，才并入 `memory_read_card` 或一个新的只读 `knowledge_read`。
- 写工具 `memory_create/update/write_card` 继续对 Codex 关闭；设置页手工 CRUD 走 IPC，不走模型。

测试：

- 普通直答 turn 的 allow-set 不含任何 `memory_*` / `session_search`。
- `@[knowledge/foo.md]` 后只出现只读检索，且读到的是该卡正文；staged 卡默认不可读。
- overlay / additionalContext digest 断言不含 `用户画像`、`人格定义`、`USER.md`。

验证：`npx tsx --test src/__tests__/codex-memory-surface-retired.test.ts src/__tests__/codex-thread-instructions.test.ts && npm run typecheck`

### D1 · 选择器与设置页预期收口

缺口：`FALLBACK_AGENTS` 和设置页旧文案会让用户以为换名字就换了人格。

改动：

- 会话选择器若仍列出管家/文案/剪辑，文案改为“会话标签”，创建会话不再写入会触发旧 assembly 的 persona id 作为 live 身份。
- 设置页「记忆系统」高级区删除或改写“自动加载相关记忆”。
- 「Agent 历史资料」保持只读审计 + 已有文件提案；继续禁止创建/分配 Agent。

测试：

- `verify:agent-identity` 继续绿。
- 设置文案契约测试：不得出现“会改变当前 Codex / 自动路由 / 自动加载记忆”。

验证：`npm run verify:evolution-p4 && npm run typecheck`

### D2 · 资料按需进入本轮

缺口：信念卡只能在设置页看，Agent 既不能自动用，也不能被用户合法点名。

改动：

- 新增 typed resource：`knowledge_card`（relPath + content digest）与可选 `knowledge_folder`（agents/{id}/knowledge 或 root knowledge，只读）。
- Renderer `@` / 拖拽 / 资料库“用于本轮”只传稳定 relPath；Main 读文件真值，校验 `isAllowedCardPath`、非 staged（除非用户显式 include_staged）、scope 安全。
- 进入 turn 的方式与本地文件相同：mention 或短 text excerpt + `additionalContext` 版本引用。禁止把整夹倾倒进 overlay。
- 单卡正文上限与现有 file excerpt 预算对齐；超限只给目录行，要求模型再读。

测试：

- 点名 active 卡：模型可见正文，工具面不加写卡。
- 点名 staged 卡：默认拒绝或只返回“待确认，未进入本轮”。
- 未点名：零资料进入 input / additionalContext。
- 路径穿越 / 非允许目录：turn 前失败。

验证：`npx tsx --test src/__tests__/codex-knowledge-resource.test.ts && npm run typecheck`

### D3 · 领域方法只走技能

缺口：旧专项 RULES 还在磁盘上，但不能合法进入 Codex；用户新建领域方法也没有一条不破坏红线的路。

改动：

- 不新造 Agent 实体。领域方法 = 普通 Ready skill。
- 提供一次性、用户确认的迁移：从历史 `agents/{id}/RULES.md` + charter 生成 **staged skill draft**（reference/advisory，无脚本）。确认后走既有技能导入校验，不走 `AgentFactory`。
- 迁移产物不得包含“你是某某人格/SOUL/必须扮演”。只保留可执行方法。
- 选技继续只认完整名或明确别名；`use_skill` 仍不进 Codex 模型面。
- 已有 `social-media-ops`、`tag-forge`、`lets-go-rss`、`lark-cli` 就是这个形态的先例，不另起一套。

测试：

- 确认前不写技能目录、不改 registry。
- 确认后技能可被 `@` 选中，native skill input 路径与摘要校验与现网一致。
- 含 SOUL/扮演句的 RULES 在迁移预检被拒绝或剥离。
- 既有 specialist 只读 IPC 仍无 create/rename。

验证：`npx tsx --test src/__tests__/historical-rules-to-skill-migration.test.ts && npm run verify:evolution-p4 && npm run typecheck`

### D4 · 短偏好（可选，不阻塞 D0–D3）

缺口：用户习惯现在能存在设置页，但不能合法影响 Codex。

仅当 D0–D3 完成且产品仍需要“少打断/先结论/固定语言”时开工。

改动：

- 新资源 kind：`user_preference_pin`。内容来自用户在设置里勾选的 **已确认短句**，硬上限 800 字符，禁止工具名、路径、授权声明。
- 只进入用户显式开启“本会话使用我的偏好”的本地 scope；远程会话永不带。
- 变更只影响新 turn 的显式资源，不改旧 thread overlay。
- 禁止从整份 USER.md / 人格档案自动同步。

测试：超长截断、远程会话为 0、未确认偏好为 0、digest 不含人格档案正文。

## 验证门

每单先红测试再实现。整计划收口：

```bash
npx tsx --test \
  src/__tests__/codex-memory-surface-retired.test.ts \
  src/__tests__/codex-knowledge-resource.test.ts \
  src/__tests__/historical-rules-to-skill-migration.test.ts
npm run verify:evolution-p1
npm run verify:evolution-p3
npm run verify:evolution-p4
npm run verify:codex-runtime-source
npm run typecheck
```

涉及记忆表或技能导入落盘时加 `npm run verify:native`。

## 文档同步

落地后只改一处权威合同：`docs/architecture/current-runtime-contracts.md` §8。写明：

- 历史专项/人格仍只读；
- 领域方法走技能；
- 知识按需引用；
- 记忆默认不在 Codex 工具面。

不要回填 `docs/agent-evolution/04` 为 live。
