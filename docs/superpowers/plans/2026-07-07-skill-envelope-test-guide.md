---
status: 测试指南 — 覆盖已收口并验证的 P0 + P1 + P2-1（skill 信封地板）；P2-2…P3 待续（见 §5）
owner: 白
author: Claude (Opus 4.8)
enforce: false
date: 2026-07-07
branch: feature/skill-envelope-floors
---

# Skill 信封地板 —— 测试文档（测试内容 + 预期结果）

覆盖本轮已收口并全量验证的工作：**P0 解阻断 + P1 信封重铸 + P2-1 L1 技能目录**。
每节给出「怎么测」「预期结果」「它证明了什么」。分两类：A) 自动化（可直接跑，机器判定）；
B) 交互式真机 dogfood（需你在 `npm run dev` 里操作，机器代跑不了）。

分支 `feature/skill-envelope-floors`，相对基线 `ccef7295` 共 15 个提交（见 §4）。

---

## 1. 一次性总验证（先跑这三条）

```bash
npm run typecheck            # 预期 EXIT=0（无 TS 错误）
npm run test:parallel        # 预期 6446 pass / 0 fail / 232 skipped（skip=host-Node better-sqlite3 ABI，属正常）
node scripts/check-capability-gate-enforced-in-arbitration.cjs   # 预期 EXIT=0，打印 ... OK
```

- **预期**：三条都 `EXIT=0`；`test:parallel` 尾部 `ℹ pass 6446 / ℹ fail 0`。
- **证明**：整仓在本分支上无回归；能力地板 gate 强制两条裁决路径都计算 floors。
- 若想跑原生 SQLite 边界：`npm run verify:native`（那 232 个 skip 在原生环境里应转为 pass）。

> 验证纪律：命令请用 `... > /tmp/x.log 2>&1; echo EXIT=$?` 形式看退出码，别用 `cmd | tail`（会吞退出码）。

---

## 2. P0 —— 解阻断（技能 + 文档同轮不再 toolCount=0）

**背景**：2026-07-06 真机失败轮 `使用@[ready-human-touch-ppt]根据@[xx.md]生成ppt` → `sdk_runtime_final_tools toolCount=0 tools=none`。三层缺陷 D1/D2/D3 已修。

### A. 自动化

```bash
npx tsx --test src/__tests__/sdk-turnengine-capability-parity.test.ts   # 预期 EXIT=0，pass 23
npx tsx --test src/__tests__/skill-doc-toolset-floor.test.ts            # 预期 EXIT=0，pass 6
npx tsx --test src/__tests__/skill-doc-dogfood-proxy.test.ts            # 预期 EXIT=0，pass 1
```

- **`skill-doc-dogfood-proxy`（P0-4 自动化代理）**：用真实失败轮 fixture 跑真实 executor 工具面解析。
  预期最终工具面 = **8 个工具**：`document_read_section, file_locate, file_read_excerpt, skill_run_shell,
  skill_write_artifact, skill_read_artifact, skill_export_artifact, skill_inspect_run_state`；
  `toolCount≥7`、含三必需工具、`recovered=false`。
- **证明**：技能选中 + 本地文档同轮，工具面不再塌成空集；文档读取工具与技能原语共存。
- 想确认测试"真的能咬住"回归：把 `agent-sdk-utils.ts` 里 `narrowToolSurfaceForLocalDocument` 的函数体
  改回 `return toolDefinitions.filter((d) => isLocalDocumentToolDefinition(d))`（丢地板），
  再跑上面头两条 → 预期**变红**；改回即恢复。

### B. 交互式真机 dogfood（需你操作）

1. `npm run dev` 启动 Ready。
2. Agent 对话里，附一个真实 `.md` 文件 + 引用技能，发：
   `使用@[ready-human-touch-ppt]根据@[<任一 md 文档>]生成一个人文感风格的 ppt，输出到同一目录`
3. 运行结束后核日志（macOS，`$TMPDIR` 为系统临时目录）：
   ```bash
   grep "sdk_runtime_final_tools" "$TMPDIR/ready-tools.log" | tail -3
   ```
- **预期（三条全中才算过）**：
  - 末行 `toolCount ≥ 7`，且 `tools=` 同时含 `skill_read_artifact`、`skill_run_shell`、`file_read_excerpt`；
  - **不**出现 `stage=sdk_runtime_empty_surface_recovered`（出现=还有别的收窄路径在打架，请贴日志给我）；
  - agent 实际产出 HTML 到目标目录（`ls` 确认），对话里没有"工具未开放"类措辞。
- **证明**：真机端到端，失败轮场景已通。这是 P0 唯一需你亲自验的一环（自动代理跑不了真模型回合）。

---

## 3. P1 —— 信封重铸（typed refs + 能力地板进裁决面）

### A. 自动化

```bash
npx tsx --test src/__tests__/capability-floors.test.ts                  # 预期 EXIT=0，pass 12
npx tsx --test src/__tests__/request-envelope.test.ts                   # 预期 EXIT=0，pass 9（含 skill_reference + staleness）
npx tsx --test src/__tests__/sdk-turnengine-capability-parity.test.ts   # 预期 EXIT=0，pass 23
npx tsx --test src/__tests__/agent-sdk-runtime.test.ts                  # 预期 EXIT=0，pass 90
```

- **typed refs（P1-1/P1-2）**：`@[技能]` 进 envelope 成结构化 `skill_reference` 资源；授权先消费 typed refs
  （日志 `source=typed_ref`），正则文本候选降兜底（`source=text_fallback`）。stale 上下文里的旧 `@[技能]`
  提及**不**会升级成本轮引用（`request-envelope.test.ts` 的 staleness 用例守这条）。
- **能力地板（P1-3/P1-4）**：`computeCapabilityFloors`（selected→typed actions∪primitives；本地文档→
  file_locate/file_read_excerpt；当前文档上下文→document_read_section）在 executor 与 controller 两条路径
  用同一函数；一切收窄只做减法、不移除地板项；管线末端 `surface ⊇ floors`，违反落 `tool_surface_floor_violation`。
- **端到端接线**：`agent-sdk-runtime.test.ts` 的 "surfaces capability floor tools to the model end-to-end"
  驱动真实 `sendMessage`，断言地板工具（技能原语 + file_read_excerpt）真的到达模型。
- **证明**：权限判定不再靠对用户原文正则猜测；typed envelope refs 为第一信源；地板由代码承担，信封永不为空。

### B. 交互式真机 dogfood（需你操作）

复跑 §2.B 的场景，核 `sdk_runtime_final_tools` 日志行：
- **预期**：行内出现 `floors=` 字段（如 `floors=skill_selected:ready-human-touch-ppt,local_document_resource`）；
  **不**出现 `tool_surface_floor_violation` / `empty_surface_recovered`。
- **证明**：地板在真机裁决面被计算并可观测。

---

## 4. P2-1 —— L1 技能目录 system reminder

### A. 自动化

```bash
npx tsx --test src/__tests__/skill-catalog-reminder.test.ts   # 预期 EXIT=0，pass 9
```

- **预期**：确定性预算算法通过——空 entries→空串不注册；描述超 120 字截 117+`…`；超预算末尾丢弃 + `（另有 N 个技能…）`
  计数行；恰好等预算不丢；同输入两次逐字节相等。
- **证明**：目录文案确定、预算可控、经 SystemReminderRegistry 组装（不内联进调度层）。

### B. 交互式真机 dogfood（需你操作）

1. `npm run dev`，随便发一轮 agent 对话。
2. 核 `$TMPDIR/ready-directchat.log`（或调试面）里本轮注入的系统提醒：
- **预期**：出现 `可用技能（引用 @[技能id] 或调用 use_skill 激活；激活前技能工具不可用）：` 开头的目录段，
  逐行列出 `- @[技能id]｜名称｜描述`。
- **已知边界（诚实标注）**：目录里提到的 `use_skill` 激活工具属 **P2-2**，尚未实现（见 §5）。当前目录只做"清单"
  展示 + 让模型可按 `@[技能id]` 显式引用；`use_skill` 那条激活路径还没接。若技能运行时未初始化，本段为安全 no-op（不注入）。

---

## 5. 未完成范围（P2-2 … P3）—— 诚实交代

> ⚠️ 更新 2026-07-07：下列 P2-2 … P3 **均已实现并收口**（见母合同 §5 进度、P2/P3 执行书 status=done、提交序 65ac1054→990aa352）。
> 每项红测先行 + 全链 test:parallel + typecheck 绿；新增自动化测试：`use-skill-activation`、`embedded-manifest-scan`、
> `custom-skill-import-metadata`、`external-skill-discovery`、`skill-shell-consent`、`lint-skill`。真机 dogfood（目录段/use_skill
> 激活/drop-in 目录/`~/.agents/skills` 发现导入/脚本同意开关）待用户执行。本节以下原文保留为当时的范围勘察记录。

本轮收口了 **P0 全量 + P1 全量 + P2-1**（skill 信封的核心：真机报的 `toolCount=0` bug 已修 + 地板架构已落）。
以下为**尚未实现**，每项都是深集成多文件特性，建议新开上下文按执行书逐项做（每项：红测→实现→验证→单独 commit，
每阶段起对抗性审查修复循环）：

- **P2-2 `use_skill` 激活工具**：已勘明需 7 处集成——新 `ToolDomain`（如 `skill_activation`）、host-only 组 provider、
  `buildToolDefinitions` 组→domain 映射、带 context 的路由 case、`builtins/use-skill.ts` handler（校验 skill_id→
  `unknown_skill` 结构化错误 / 读 SKILL.md 12K 上限 / `rememberLastReferenceSkill` 置下轮 selected / 返回 doc+armed）、
  executor 侧 mode:'none'+目录非空的条件曝光、安全回归（none 轮除 use_skill 外无 skill_*）。
- **P2-3 embedded 注册改目录扫描 + union 退役**：`manifest.ts` 重写（`EmbeddedSkillId=string`、
  `buildEmbeddedSkillManifests(rootDir)` 扫 `assets/embedded-skills/*/SKILL.md`）、6 个消费方过 typecheck、
  gate `check-embedded-skill-manifest-vs-asset-parity.cjs` 反转为"每目录有合法 SKILL.md"、frontmatter 助手提取。
- **P2-4 spec frontmatter 容忍 + `allowed-tools` 安全策略**：未知字段忽略不拒；导入技能的 `allowed-tools` 一律忽略并记 `ignoredFields`。
- **P2-5 L2 超限导入告警**：`importCustomSkillFolder` 返回 `warnings`（SKILL.md >12000 字），IPC/preload/renderer/组件五件套 + toast。
- **P3-1 `.agents/skills` 中立目录发现（建议导入制）** / **P3-2 `skill_run_shell` 按技能同意** /
  **P3-3 作者侧 lint（`scripts/lint-skill.cjs` + 导入 ERROR 闸）** / **P3-4 收尾同步**。

执行书就绪：`docs/superpowers/plans/2026-07-07-skill-standard-p2-adoption-implementation.md` 与
`2026-07-07-skill-ecosystem-p3-implementation.md`（代码级、可直接照单执行）。

---

## 6. 本轮提交序（分支 feature/skill-envelope-floors，基线 ccef7295）

```
7b7f46d3 feat(agent): L1 skill catalog system reminder with deterministic budget      (P2-1)
5b0aca06 test(agent): close P1 review gaps — honest parity, floor wiring e2e, ...      (P1 复审修复)
d64864b6 chore(agent): floors arbitration gate + guideline sync                        (P1-5)
ccea1f95 feat(agent): run-capability-controller applies the same capability floors     (P1-4)
3804d03b feat(agent): capability floors computed at arbitration surface + invariant    (P1-3)
53e1b07d feat(agent): skill authorization consumes typed envelope refs before text     (P1-2)
aae4681e feat(agent): carry explicit skill mentions as typed envelope resources        (P1-1)
6ebf9040 docs(skills): P0 skill-envelope closeout                                      (P0 留档)
8059843a fix(agent): make empty-surface recovery safety-aware + guard D2 ...           (P0 复审修复)
c482a00c test(agent): P0-4 automated dogfood proxy                                     (P0-4)
ca294171 fix(agent): preserve document-read floor tools on explicit skill turns        (P0-3)
7d730190 fix(agent): local-document narrowing keeps skill floor + empty recover        (P0-2)
3749795e fix(agent): keep explicit skill mention through attachment markers            (P0-1 B / D1)
90fb5f98 feat(skills): register ready-human-touch ppt/card embedded skills + plans     (P0-1 A)
```

对抗性审查：P0（正确性/合同/测试质量 3 视角 + Codex 替身裁决 + fix-delta 复核）、
P1（3 视角 + fix-delta 复核）——所有 blocker/major 已修，findings 全部收口或明确 P1-deferred。
Codex CLI 本机未安装，独立外审均以具名 Claude 子代理补位（母指引"外部复审无输出必须替代补位"）。
