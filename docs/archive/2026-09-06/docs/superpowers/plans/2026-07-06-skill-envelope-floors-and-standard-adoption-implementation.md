---
status: approved — 白 2026-07-07 批准全案 P0-P3 文档化施工；本篇为母合同，执行以四份执行书为准
revision_history:
  - v2 (2026-07-07): 白批准全案；产出四份执行书（见 §8 执行索引），executor 面向弱 coding agent 编写（锚点核验/红测先行/EXIT 纪律内置）。
  - v1 (2026-07-06): 初稿。由 2026-07-06 真机失败轮（@[ready-human-touch-ppt]+@[*.md] → toolCount=0）确诊驱动；对标 agentskills.io 开放规范（Claude Code / Codex / Gemini CLI / Cursor / opencode / goose 已收敛同一格式）。
owner: 白
author: Claude (Opus 4.8)
executor: 任意 coding agent，按执行书逐单施工
reviewer: 白 / Codex
enforce: false
note: >
  两个主轨：A) 工具信封重铸——显式引用产生代码级能力地板，排他过滤器改为“减法但不破地板”，
  管线末端非空+覆盖不变量；B) Agent Skills 开放标准采纳——SKILL.md-only 全域一等公民、
  L1 目录渐进披露、嵌入式硬编码 union 退役为目录扫描。安全语义（hint 永不开原语、
  assetRoot 只读、激活=显式事件）全部保持，是 Ready 相对 CLI 宿主的差异化优势，不是要拆的东西。
archived_at: 2026-09-06
archive_reason: superseded-project-documentation
---

> 已归档（2026-09-06）：本文保留编写当时的设计、状态与证据，不是当前执行入口；归档不表示原计划全部实现。现行说明见 [当前运行时合同](../../../../../architecture/current-runtime-contracts.md)，去向见 [文档清单](../../../../../documentation-inventory.md)。

# Skill 信封地板 + Agent Skills 标准采纳

## 1. 背景与确诊（2026-07-06 真机取证）

用户消息 `使用@[ready-human-touch-ppt]…根据@[BV1vs411e7QF_audiovisual_analysis.md]生成…输出到同一目录`，
UI 显示技能上下文已启用，但 `ready-tools.log` 2026-07-06T15:15:37Z / 15:16:10Z：

```
stage=sdk_runtime_final_tools toolCount=0 tools=none skillHintRelevant=true:explicit_skill
```

同轮 `sdk_runtime_default_tools` 显示 `visibleCapabilityGroups=document|file_management|skills|…`——
默认面充足，收窄管线把它清零。三层缺陷，共享一个系统根因：

### D1 — 授权提取被上下文标记误杀（工作区已修，未提交）
`skillAuthorizationTextCandidates` 旧实现：`rawUserText` 只要含任一 `SDK_CONTEXT_MARKERS`
（含 `'--- 附件:'`，`agent-sdk-utils.ts:614-627`）就整体丢弃显式 mention；其余候选文本是
mention-stripped 的 → `findExplicitlyRequestedSkills` 全空 → `mode:'none'` → 所有 `skill_*`
被剥（`skill-tool-authorization.ts:201-219`）+ skills 组被压制。这是“带附件的技能轮全灭”
的根因。修复：`extractRawExplicitMentionCandidate`（`agent-sdk-utils.ts:819-830`）提取
mention 行。回归：`sdk-turnengine-capability-parity.test.ts:679-785`，2026-07-06 实测 14/14 绿。

### D2 — 排他过滤器串联出空集（未修，本轮 toolCount=0 的直接死因）
- 第一道：技能选中轮 `filterSelectedSkillToolSurface`（调用点 `agent-sdk-tool-executor.ts:350-358`）
  把整个面独占收窄成该 skill 的 allowed tools（advisory=4~6 个原语）。它内部有防空 fallback
  （`agent-sdk-utils.ts:196`），但只防自己这一层。
- 第二道：`agent-sdk-turn-orchestrator.ts:890-892` 本地文档过滤器
  （触发谓词 `shouldUseLocalDocumentToolSet` `agent-sdk-utils.ts:1597-1610`：`@[….md]`+“生成”即中）
  只保留 `domain==='document'|'file'`（`:1676-1678`）→ 把仅剩的 skill 原语全滤掉 → ∅。
- 管线末端（`agent-sdk-turn-orchestrator.ts:977-984` 记日志处）没有任何非空/覆盖断言。
- 代码推演：mode:'none'（D1 未修）会留下 document/file 工具（≠0）；观测到的 0 只能由
  “修复后 selected + D2 串联”产生 ⇒ 失败实例跑的是已含 D1 修复的代码，D2 是现行阻断点。

### D3 — 跨资源饥饿（设计缺口，即使修完 D1+D2 依旧）
技能选中轮的面只含 skill 原语 ⇒ 用户附的源文档不可读（`file_read_excerpt`/
`document_read_section` 被第一道过滤器丢弃）。`skill_read_artifact` 对沙箱外路径的官方出路
是“转投 `file_read_excerpt`”（`read-artifact.ts:139-151`）——而该工具在这类轮根本不在面上，
指路指向死胡同。“文档 → 风格化 PPT”这类技能的主用例在当前信封模型下结构性不可完成。

### 系统根因
工具信封由多层互不知情的**排他**过滤器串联而成，每层都靠对用户原文的正则/启发式推断；
显式用户授权信号（`@[skill]`、`@[文件]`、附件）从不产生代码级地板（Explore 全景确认：
“there is no code-level capability floor”）；末端无不变量。这直接违反本仓库红线
“路由/权限必须由代码承担，模型只做判断题”——现状是**正则在做权限**。

## 2. 现状资产盘点（先读后写：Ready 离标准比预想近）

已有且质量好、方案全部复用（不重建）：
- **SKILL.md-only 导入已是一等公民（custom 域）**：`custom-skill-registry.ts:327-343`——无
  manifest + 有 SKILL.md → 按 reference skill 收编，id 取 frontmatter。技能中心可导入文件夹
  （IPC `skills:importCustomSkill`）、可从 GitHub/URL 安装（`skill-install-pipeline.ts:101`）。
- **L3 已存在**：`skill_run_shell` 注入 `CLAUDE_SKILL_DIR`（=assetRoot=managedPath，只读，
  `run-shell.ts:239-240`、`path-sandbox.ts:8`）与 `CLAUDE_SKILL_OUTPUT_DIR`；
  `skill_read_artifact` 可读技能托管资源目录。与 Claude Code 的 `${CLAUDE_SKILL_DIR}` 约定对齐。
- **安全分层正确**：hint 永不单独开原语（`skill-tool-session-gate.ts:20-25` + 
  `skill-tool-gating-by-session.test.ts`）；detached 原语禁入 SDK 安全集
  （`check-detached-primitive-not-exposed.cjs`）；宿主路径脱敏 gate 健在。

真实缺口（对照 agentskills.io 宿主五合同）：
| # | 宿主合同 | Ready 现状 |
|---|---|---|
| G1 | L1 目录注入（全部技能 name+description 常驻，预算裁剪） | **无**。模型看不到技能清单，无法按描述自选；只有显式 mention/hint 服务 |
| G2 | 安装=放目录 | custom 域已达标；**embedded 域是编译期 union**（`manifest.ts` EmbeddedSkillId），放目录不注册 |
| G3 | 触发即授予 skill 目录读取 + 脚本执行 | 机制在（L3），但被 D1-D3 信封缺陷掐断通路 |
| G4 | 未知 frontmatter 忽略不拒；spec 6 字段为准 | 私有 `ready-skill.json` 方言优先；spec 字段（license/compatibility/metadata/allowed-tools）无映射 |
| G5 | 中立目录 `.agents/skills/`+`~/.agents/skills/` 扫描 | 无 |

## 3. 目标 / 非目标

目标：① 显式引用=代码级能力地板，信封永不为空；② 裸 SKILL.md 技能在 Ready 全域
（embedded/custom/导入）可安装、可发现、可激活、可用到 L3；③ 与 Claude/Codex 生态技能
双向兼容（他们的技能拿来能用，Ready 的技能拿出去能用）。

非目标：不复活 skill_executions/workflow coordinator；不放宽“hint 不开原语”；不引入
LLM 参与权限判定；不做 marketplace/评分；不动浏览器纪律与行动确认闸门。

## 4. 架构合同条款（全部可机器验证）

- **T1 类型化显式引用**：request envelope 增加结构化 `explicitRefs: {kind:'skill'|'document'|'folder'|'attachment', id|path}[]`，由 renderer composer（本就结构化持有 mention）填充；
  `resolveSkillAuthorizationForTurn` 与 intent surface **优先消费 typed refs**，正则文本候选降级为无 refs 时的兜底。红测：带附件块/上下文标记的消息，typed ref 在→授权必 selected（D1 类故障从机制上不可再发）。
- **T2 能力地板 + 非空不变量**：唯一裁决点计算 `floors = ⋃(skill ref→该技能 allowed tools+原语; document/attachment ref→file_read_excerpt(+document_read_section 当 document context); 交付意图→export/write)`；
  一切后续过滤器只允许移除**非地板**项；管线末端断言 `surface ⊇ floors ∧ surface ≠ ∅`，
  违反→结构化日志 `tool_surface_floor_violation` + 回退 `floors ∪ 最小默认面`。
  红测矩阵：skill×doc×save 组合全过；gate：`check-capability-gate-enforced-in-arbitration.cjs` 扩展断言地板检查在裁决点内、不得旁路。
- **T3 组合过滤器收编**：`agent-sdk-turn-orchestrator.ts:890` 的本地文档过滤器与技能收窄
  改为对同一 floors 结构的减法（保留 `isLocalDocumentToolDefinition ∪ floors`）；长期迁入
  intent surface / 唯一裁决点，不留 orchestrator 后置独立过滤。
- **T4 L1 目录渐进披露**：经 `SystemReminderRegistry` 注册“可用技能目录”段（name+description
  (+when-to-use)，字符预算+先缩后丢，参照 Claude Code 1%ctx/1536 字符、Codex 2%ctx 的量级）；
  新增 `use_skill` 工具=模型侧显式激活事件，走与 mention 同一条授权通道（激活≠hint，安全语义不变）。红测：目录超预算裁剪确定性；`use_skill` 激活后地板生效；未激活技能原语不可见（沿用现有 gating 测试）。
- **T5 SKILL.md-only 全域一等公民**：embedded 注册改为启动目录扫描
  （`assets/embedded-skills/*/SKILL.md` frontmatter 校验），`EmbeddedSkillId` union 退役；
  `ready-skill.json` 降级为**可选宿主扩展**（typed actions/execution mode 才需要）；spec 6 字段
  容忍映射（未知字段忽略不拒，`metadata.version` 为版本正源）。gate 反转：
  `check-embedded-skill-manifest-vs-asset-parity.cjs` → “每个目录有合法 SKILL.md”存在性合同。
  drop-in 红测：临时放一个仅含 SKILL.md 的目录 → 目录可见、可激活、L3 可读，全程零源码改动。
- **T6 安全语义保持（红线）**：hint 永不开原语；激活=显式事件（mention / use_skill / 续跑 handle）；
  assetRoot 只读；`skill_run_shell` 沿用沙箱+确认闸门，P3 增加每技能首次同意（Gemini CLI 模式）。
  现有 gate（detached 不外露、路径脱敏、conservative default）全部保持绿。

## 5. 工单分解

> 进度：P0 done 2026-07-07（四单 + 对抗性审查修复循环；见 2026-07-07-skill-envelope-p0-closeout.md）。
> P1 done 2026-07-07（五单 + 对抗性审查修复循环：typed refs / floors 进裁决面 / controller parity / gate + 指引同步）。
> P2 done 2026-07-07（L1 目录 + use_skill 激活组 + embedded 目录扫描/union 退役 + frontmatter 容忍/allowed-tools 忽略 + L2 导入告警）。
> P3 done 2026-07-07（.agents/skills 建议导入发现 + 按技能 shell 同意 + agentskills lint + 收尾同步）。
> P1 复审补修 done 2026-07-07（独立对抗性审查：capability gate 扩到 orchestrator live 强制点 + CLAUDE/AGENTS floors 权威表述纠偏）。

### P0 — 解阻断（两个设计 skill 端到端可用）
- **P0-1** 提交工作区已验证的 D1 修复 + parity 测试（14/14 绿）与两技能注册/资产（fac 6/6 绿）。
- **P0-2** D2：`:890` 过滤器 floor-respecting（保留技能 allowed tools）+ 末端非空守卫
  （空→回退+`tool_surface_empty_recovered` 日志）。红测：完整 orchestrator 路径的 skill+doc 组合案例。
- **P0-3** D3：技能选中轮地板并集——envelope 含本地文档引用 ⇒ `file_read_excerpt`
  （及 document context 时 `document_read_section`）必在面上。红测同矩阵。
- **P0-4** 真机 dogfood：复跑截图原场景（文档→Human Touch PPT→导出同目录），留运行记录。
- 验证：`npx tsx --test` 焦点测试 + `npm run typecheck`；不动 verify 链结构。

### P1 — 信封重铸（T1+T2+T3 全量）
typed explicitRefs 端到端（renderer→envelope→授权/意图面）；floors 进唯一裁决点；文本启发式降兜底；
`[tool_capability]` 日志增加 `floors=` 段。合同：地板矩阵测试 + arbitration gate 扩展。

### P2 — 标准采纳（T4+T5）
L1 目录 + `use_skill`；embedded 目录扫描 + union 退役 + gate 反转；frontmatter 容忍映射；
L2 沿用 12K 内联上限（≈spec“<5000 token”指引），作者侧超限告警而非截断静默。

### P3 — 生态与 UX（T6 收尾）
`.agents/skills/` + `~/.agents/skills/` 发现（建议导入制，保持 Ready 同意姿态）；技能中心：
run_shell 每技能同意、能力可见化（该技能激活时会开哪些工具）、`skills-ref` 风格 lint。

## 6. 受影响面（改前必读）
- 代码：`agent-sdk-utils.ts`、`agent-sdk-tool-executor.ts:199-364`、`agent-sdk-turn-orchestrator.ts:820-990`、
  `run-capability-controller.ts`、`execution-intent-resolver.ts:214-306`、`skill-tool-authorization.ts`、
  `skills-runtime/manifest.ts` 及消费方 `runtime-manager.ts:408/:935-984`、`custom-skill-registry.ts`、
  `skill-context-orchestrator.ts`、`prompt-assembly.ts`（P2 目录段）。
- Gate：`check-capability-gate-enforced-in-arbitration.cjs`、`check-capability-gate-conservative-default.cjs`、
  `check-embedded-skill-manifest-vs-asset-parity.cjs`（P2 反转）、`check-detached-primitive-not-exposed.cjs`（保持）、
  `check-model-visible-primitive-path-redaction.cjs`（保持）。
- 测试：`sdk-turnengine-capability-parity`、`run-capability-controller*`、`capability-gate-arbitration`、
  `tool-policy-authorization`、`skill-tool-gating-by-session`、`embedded-skill-*`、`skill-install-*`。
- 文档：CLAUDE.md/AGENTS.md §2 硬约束需新增“显式引用=能力地板/信封非空”条 + §3 速查更新（P1 落地时同步）。

## 7. 工单纪律
先红测 → 实现 → 焦点验证 → typecheck；单单小 diff、单独 commit、不顺手重构。
P0 每单必须以“真机失败轮场景”当验收面之一，不以单测绿代替端到端。

## 8. 执行索引（2026-07-07 定稿，按序施工，跨阶段有硬依赖）
1. P0 解阻断：`2026-07-07-skill-envelope-p0-unblock-implementation.md`（含既有工作区修复的提交编排；代码级、可直接粘贴）
2. P1 信封重铸：`2026-07-07-skill-envelope-p1-floors-implementation.md`（typed refs + floors 进裁决面 + gate/指引同步）
3. P2 标准采纳：`2026-07-07-skill-standard-p2-adoption-implementation.md`（L1 目录 + use_skill + union 退役目录扫描 + frontmatter 容忍）
4. P3 生态与同意：`2026-07-07-skill-ecosystem-p3-implementation.md`（.agents 发现 + 脚本按技能同意 + 作者 lint）

执行者从 P0 §0 的"执行者铁律"读起；任何锚点核验失配 → 停止报告，不得即兴替代。
