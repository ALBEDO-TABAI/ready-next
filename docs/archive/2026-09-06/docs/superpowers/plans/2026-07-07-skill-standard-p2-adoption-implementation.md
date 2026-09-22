---
status: done 2026-07-07 — 五单全部收口（P2-1 L1 目录 / P2-2 use_skill 激活组 + 注册 gate / P2-3 embedded 目录扫描 + union 退役 + 反转 parity gate / P2-4 frontmatter 容忍 + allowed-tools 忽略 / P2-5 L2 导入告警）；每单红测先行 + 全链 test:parallel + typecheck 绿。真机 dogfood（目录段/use_skill 激活/drop-in）待用户执行。本篇为 P2 执行书（P1 收口后开工）。
revision_history:
  - v1 (2026-07-07): 初稿。母合同 §4 T4/T5：L1 目录渐进披露 + use_skill 激活 + SKILL.md-only 全域一等公民 + union 退役。
owner: 白
author: Claude (Opus 4.8)
executor: 任意 coding agent——严格按工单执行；执行者铁律同 P0 执行书 §0
reviewer: 白 / Codex
enforce: false
note: >
  对标 agentskills.io 宿主合同：L1 目录注入（name+description，预算裁剪）、L2 激活注入
  （现有 12K 内联，保持）、L3 技能目录读取+脚本执行（已存在：CLAUDE_SKILL_DIR/只读
  assetRoot）。安全语义不变：hint 永不开原语；激活（mention / use_skill / 续跑）才开。
archived_at: 2026-09-06
archive_reason: superseded-project-documentation
---

> 已归档（2026-09-06）：本文保留编写当时的设计、状态与证据，不是当前执行入口；归档不表示原计划全部实现。现行说明见 [当前运行时合同](../../../../../architecture/current-runtime-contracts.md)，去向见 [文档清单](../../../../../documentation-inventory.md)。

# P2 执行书：Agent Skills 标准采纳

## 1. 工单 P2-1：L1 技能目录 system reminder

### 锚点核验
```bash
sed -n '1,35p' src/main/modules/agent-control/system-reminders/current-date-reminder.ts
grep -rn "createSystemReminderRegistry(" src/main --include='*.ts' | grep -v test | head
grep -n "registerCurrentDateReminder" src/main --include='*.ts' -r | grep -v system-reminders/ | head -3
```
第二条输出 = per-turn registry 的创建点（live SDK 路径那处是接线点）；第三条确认 current-date 的接线位置作为样板。

### 合同
1. 新文件 `system-reminders/skill-catalog-reminder.ts`，完全仿 `current-date-reminder.ts` 形状：
```ts
export const SKILL_CATALOG_CHAR_BUDGET = 4000
export const SKILL_CATALOG_DESC_CAP = 120
export interface SkillCatalogEntry { id: string; name: string; description: string }
export function buildSkillCatalogText(entries: ReadonlyArray<SkillCatalogEntry>, budget?: number): string
export function registerSkillCatalogReminder(registry: SystemReminderRegistry, entries: ReadonlyArray<SkillCatalogEntry>): void
```
   `buildSkillCatalogText` 确定性算法：
   - 每行 `- @[id]｜name｜description`；description 超 `SKILL_CATALOG_DESC_CAP` 截为 117 字符+`…`；
   - 逐行累加，超 `SKILL_CATALOG_CHAR_BUDGET` 即停止，被丢弃的技能只计数；
   - 有丢弃时末行追加 `（另有 N 个技能，可在技能中心查看或直接 @[技能id] 引用）`；
   - entries 为空 → 返回空串，`register` 不注册（不产生空段）。
   - 头部固定一行：`可用技能（引用 @[技能id] 或调用 use_skill 激活；激活前技能工具不可用）：`
   - topic `skill-catalog`，priority 低于 current-date（读该文件取值后减 10）。
2. 接线：在 live SDK 路径的 registry 创建点注册；entries 来源 `getSkillsRuntimeManager().listSkills()`
   映射为 `{id, name, description}`（listSkills 条目字段名以实际类型为准，先 `grep -n "SkillState" src/main/modules/skills-runtime/runtime-manager-types.ts` 核验；排除禁用/退役状态字段若存在）。
   **注意 CLAUDE.md §5**：提醒文案只能经 SystemReminderRegistry，不得内联进调度层。
3. 顺序敏感：注册点插在 current-date 注册的相邻位置，不改其他 reminder 顺序。

### 红测
`skill-catalog-reminder.test.ts`：
1. 空 entries → 空串、不注册；
2. 描述超长截断确定性（同输入两次调用逐字节相等）；
3. 预算溢出 → 尾部丢弃 + 计数行；边界：恰好等于预算不丢；
4. registry 集成：register 后 assembly 产物包含目录段（用 registry+assembly 的现有测试写法，参考 `grep -rln "system-reminder-assembly" src/__tests__`）。

### 提交
`git commit -m "feat(agent): L1 skill catalog system reminder with deterministic budget"`

## 2. 工单 P2-2：`use_skill` 激活工具

### 合同
1. 工具定义：`name: 'use_skill'`（**故意不带 `skill_` 前缀**——`filterToolsByAuthorization` 按前缀剥
   `skill_*`，use_skill 必须在 mode:'none' 轮存活）；schema `{ skill_id: string }`；description 写明
   "按技能目录激活一个技能：返回其 SKILL.md 方法论并解锁下一轮技能工具"。
2. 曝光规则（代码而非模型）：`listDefaultToolDefinitionsForTurn` 末段，当
   `params.authorization.mode === 'none'` 且技能目录非空时追加 use_skill 定义；
   `mode === 'selected'` 轮不追加（防递归激活）。
3. 执行语义（dispatch 层，找 `grep -rn "skill_inspect_run_state" src/main/modules/tools --include='*.ts' -l` 里的原语执行文件作参考样板）：
   a. 校验 skill_id 存在于 listSkills，不存在 → 结构化 ToolExecutionOutput 错误 `unknown_skill`（不冒泡）。
   b. 读该技能 SKILL.md 正文（复用 12K 上限逻辑：`grep -n "REFERENCE_SKILL_INLINE_CAP_CHARS" src/main/modules/agent-control/skills/skill-context-orchestrator.ts`——若内联函数私有，提取共享助手 `readReferenceSkillDocCapped(managedPath)` 放 skills-runtime 侧，orchestrator 与 use_skill 共用，行为不变由现有内联测试守护）。
   c. 调 skill-context-orchestrator 的显式 hint 记忆接口（核验：`grep -n "rememberLastReferenceSkill\|rememberExplicitReferenceSkillHint" src/main/modules/agent-control -r`），使**下一轮** `resolveSkillAuthorizationForTurn` 走 selected（source 沿用既有 hint→selected 通路，不新造 source 枚举值）。
   d. 返回 `{ skill_id, doc: <capped text>, activation: 'armed_next_turn', note: '技能方法论已注入；skill_* 工具将于下一轮可用' }`。
4. **安全红线回归**：mode:'none' 轮除 use_skill 外不得出现任何 `skill_*` 原语（现有 `skill-tool-gating-by-session.test.ts` 必须保持绿）。

### 红测
1. 曝光矩阵：none+目录非空 → 有；none+目录空 → 无；selected → 无。
2. dispatch：合法 id 返回 doc（≤12000 字符）+ armed 标记；非法 id → `unknown_skill` 结构化错误。
3. 激活链：调用 use_skill 后，用 parity 测试的 harness 再解析下一轮授权 → `mode:'selected'` 且 skillId 正确。

### 提交
`git commit -m "feat(agent): use_skill activation tool for model-side skill selection"`

## 3. 工单 P2-3：embedded 注册改目录扫描，union 退役

### 锚点核验
```bash
grep -rn "EmbeddedSkillId" src --include='*.ts' -l
node scripts/check-embedded-skill-manifest-vs-asset-parity.cjs > /tmp/p23gate.log 2>&1; echo EXIT=$?
```
预期消费方恰为：`manifest.ts`、`runtime-manager.ts`、`runtime-manager-types.ts`、`maintenance-sweeps.ts`、`skill-install-pipeline.ts`、`skill-host-controller-wiring.test.ts`。多出文件 → 停止报告。

### 合同
1. `manifest.ts` 重写（**导出面形状不变**）：
   - `export type EmbeddedSkillId = string`（union 退役；保留导出名，消费方类型引用零改动）。
   - `EmbeddedSkillManifest` 接口不变。
   - 新增纯函数 `export function buildEmbeddedSkillManifests(rootDir: string): EmbeddedSkillManifest[]`：
     `readdirSync(rootDir)` 取子目录；每目录：有 `ready-skill.json` → 读 `id/displayName||name/description/version`；
     否则读 `SKILL.md` frontmatter `name/description`（id=目录名；解析失败 → 该目录**跳过并 console.warn**，不 throw——容忍性合同）；
     `version` 取 ready-skill.json.version → SKILL.md frontmatter `metadata.version`（若有）→ `'0.0.0'`；
     `requirementsFile` 固定 `'requirements.txt'`；输出按目录名排序（确定性）。
   - `EMBEDDED_SKILLS` = `buildEmbeddedSkillManifests(resolveEmbeddedSkillsRootStatic())`；
     `resolveEmbeddedSkillsRootStatic` = 把 `runtime-manager.ts` 的 `resolveEmbeddedSkillsRoot` 三路候选
     （resourcesPath → app.getAppPath()/assets → cwd/assets）复制为**模块内私有函数**，但 `app`/`process.resourcesPath`
     访问必须 try/catch（普通 node 测试进程无 electron app——catch 后跳过该候选）。找不到根目录时返回 `[]`
     并 console.warn，**不 throw**（boot 防爆：CLAUDE.md §2 主进程启动是验收边界）。
   - `EMBEDDED_SKILL_IDS`、`getEmbeddedSkillManifest` 保持现签名。
2. frontmatter 解析：查 `grep -rn "gray-matter\|parseFrontmatter\|frontmatter" src/main/modules/skills-runtime --include='*.ts' | head`——custom-skill-registry 已有 SKILL.md frontmatter 读取（:333-343 一带），**提取共用助手**放 `skills-runtime/skill-frontmatter.ts`，两处共用；禁止引第三方新依赖。
3. gate 反转：`check-embedded-skill-manifest-vs-asset-parity.cjs` 改为断言
   `assets/embedded-skills/*` 每个子目录含可解析出 name+description 的 `SKILL.md`（或合法 ready-skill.json），
   并且 `SKILL.md` frontmatter 存在时 `name` 与目录名一致（agentskills.io 规范：name MUST match dir name；
   现存目录若不满足，一次性把 frontmatter name 对齐目录名——**只改 frontmatter，不改目录名**，改动列入本单 diff）。
4. 消费方逐个过 typecheck；`skill-install-pipeline.ts`/`maintenance-sweeps.ts` 若用 union 做穷举 switch，改为字符串处理（核验后如实报告改动点）。

### 红测
1. `embedded-manifest-scan.test.ts`：tmp 目录三案例——ready-skill.json 目录 / 仅 SKILL.md 目录 / 坏 frontmatter 目录（跳过不 throw）；输出排序确定。
2. **drop-in 合同（母合同 T5 核心）**：tmp root 放一个只有 SKILL.md 的目录 → `buildEmbeddedSkillManifests` 产出该技能且字段齐全。
3. 存量测试（embedded-skill-fac-three-skills / methodology-set / deep-research / video-expert-vnext-swap / skill-host-controller-wiring）**零修改**通过——它们消费 EMBEDDED_SKILLS 数组形状，形状未变。任何一个需要改 → 停止报告（说明形状破坏了）。

### 验证
```bash
npx tsx --test src/__tests__/embedded-*.test.ts src/__tests__/skill-host-controller-wiring.test.ts > /tmp/p23a.log 2>&1; echo EXIT=$?
node scripts/check-embedded-skill-manifest-vs-asset-parity.cjs > /tmp/p23b.log 2>&1; echo EXIT=$?
npm run typecheck > /tmp/p23c.log 2>&1; echo EXIT=$?
npm run verify:native > /tmp/p23d.log 2>&1; echo EXIT=$?   # boot 边界回归
```
### 提交
`git commit -m "refactor(skills): embedded registry becomes SKILL.md directory scan, union retired"`

## 4. 工单 P2-4：spec frontmatter 容忍 + allowed-tools 安全策略

### 合同
1. `skill-frontmatter.ts` 助手对未知字段**忽略不拒**（agentskills.io/opencode 行为）；识别但只透传：
   `license`、`compatibility`、`metadata`（string map）。
2. **安全策略（不是兼容项）**：导入/外来技能的 frontmatter `allowed-tools` **一律忽略**并在导入结果里记
   `ignoredFields: ['allowed-tools']`（下载来的技能不得自带工具授权——工具面只由 Ready 授权层决定；
   embedded 技能要 typed actions 走 ready-skill.json）。
3. `custom-skill-registry.ts` 导入路径接入助手；行为回归：现有 skill-install 端到端测试零修改通过。

### 红测
frontmatter 容忍矩阵：未知字段/新字段/allowed-tools 存在 → 导入成功 + ignoredFields 记录 + 技能 allowedTools 为空。

### 提交
`git commit -m "feat(skills): spec frontmatter tolerance; imported allowed-tools ignored by policy"`

## 5. 工单 P2-5：L2 超限导入告警

### 合同
`importCustomSkillFolder` 返回值扩展 `warnings: string[]`：SKILL.md 字符数 > 12000（与
`REFERENCE_SKILL_INLINE_CAP_CHARS` 同值，import 该常量勿硬编码）时追加
`SKILL.md 超过 12000 字符，激活时将被截断内联；建议把细节移入 references/ 由 L3 读取`。
IPC `skills:importCustomSkill` 透传；`SkillsCenterPanel.tsx` 导入完成 toast/提示区展示 warnings（复用面板现有提示样式，不新造组件）。跨进程五件套自查（IPC/preload/renderer 类型/组件/测试——CLAUDE.md §7）。

### 提交
`git commit -m "feat(skills): oversized SKILL.md import warning surfaced in skills center"`

## 6. 完成定义
- 五单 commit；焦点测试 + typecheck + parity gate + `verify:native` 全 `EXIT=0`；
- 真机：技能目录段出现在系统提醒（日志或调试面核对）；对一个**未被 mention** 的技能说"用 xx 技能…" → 模型可经 use_skill 激活并在下一轮获得技能工具；
- 把一个只含 SKILL.md 的目录放进 `assets/embedded-skills/` → 重启后技能中心可见、可激活（T5 drop-in 真机验证）；
- CLAUDE.md §3 速查同步："embedded 注册=目录扫描（SKILL.md frontmatter），ready-skill.json 仅 typed-action 技能需要；外来 allowed-tools 一律忽略"（AGENTS.md 同步）。
