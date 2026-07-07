---
status: done 2026-07-07 — 四单收口（P3-1 ~/.agents/skills 建议导入发现 / P3-2 按技能 shell 同意 + reminder + 设置开关 / P3-3 agentskills lint 单一规则引擎 + CLI + import WARN 透传 / P3-4 收尾同步）；红测先行 + 全链 test:parallel + typecheck 绿。偏差如实记录：P3-1 workspace 侧 .agents/skills 因无统一 workspace-root accessor 而 deferred（只做 home）；P3-3 lint ERROR 不阻断 import（Ready 宽松导入兜底派生 id/description），改由 CLI/CI 闸 + import WARN 透传。真机三验待用户执行。本篇为 P3 执行书（P2 收口后开工）
revision_history:
  - v1 (2026-07-07): 初稿。母合同 §4 T6 + §5 P3：中立目录发现、脚本执行按技能同意、作者 lint。
owner: 白
author: Claude (Opus 4.8)
executor: 任意 coding agent——严格按工单执行；执行者铁律同 P0 执行书 §0
reviewer: 白 / Codex
enforce: true
note: >
  姿态约束（用户既有反馈，必须遵守）：能力发现=后台自动积累 + 设置页确认；
  不做自动导入、不做前台弹窗打断。安全语义延续 Power-Mode 先例：缺同意 → 结构化
  grant_required 类拒绝 + 指路设置页，不是能力谎报"不存在"。
---

# P3 执行书：技能生态与同意 UX

## 1. 工单 P3-1：`.agents/skills` 中立目录发现（建议导入制）

### 锚点核验
```bash
grep -n "skills:importCustomSkill\|skills:list" src/main/modules/skills-runtime/ipc-handler.ts | head
grep -rn "workspace" src/shared/workspace-validation.ts | head -5
grep -n "importCustomSkill" src/renderer/components/layout/SkillsCenterPanel.tsx | head -3
```

### 合同
1. main 侧新函数（skills-runtime 内，如 `external-skill-discovery.ts`）：
   `listExternalSkillCandidates(): Array<{ path: string; name: string; description: string; source: 'user_agents_dir' | 'workspace_agents_dir'; alreadyImported: boolean }>`
   - 扫描 `join(os.homedir(), '.agents', 'skills')` 与 `<workspace root>/.agents/skills`（workspace root 取 Ready 现行工作区配置——核验 `grep -rn "getWorkspaceRoot\|workspaceRoot" src/main/modules --include='*.ts' | grep -v test | head` 找权威 accessor；找不到统一 accessor → 只做 home 目录，workspace 侧在报告中记为 deferred）；
   - 仅收含合法 SKILL.md（P2 的 `skill-frontmatter.ts` 助手）的直接子目录；symlink 用 `realpathSync` 去重；
   - `alreadyImported`：与已收编 custom skills 的 id 或 realpath 比对；
   - 目录不存在 → 返回 `[]`，零日志噪音。**只读扫描，绝不写入、绝不自动导入。**
2. IPC `skills:listExternalCandidates`（handler → preload → renderer 类型声明，五件套齐）。
3. `SkillsCenterPanel.tsx` 增加"发现的技能"折叠区（仅候选非空时渲染）：每条名称+描述+来源路径+`导入`按钮（点击走既有 `importCustomSkill` IPC，成功后刷新两个列表）。样式复用面板现有列表项，遵守 UI 反馈记忆（宽度收紧/hover 全覆盖/不加冗余装饰）。

### 红测
1. discovery 单测：tmp home 结构（合法/无 SKILL.md/symlink 重复/已导入）四案例；
2. IPC 合同测试仿既有 `skills:list` 测试写法；
3. 面板：候选空 → 区块不渲染（现有面板测试风格，若面板无测试则只做 1/2 + 真机核验）。

### 提交
`git commit -m "feat(skills): discover .agents/skills candidates with import-by-consent"`

## 2. 工单 P3-2：`skill_run_shell` 按技能同意

### 锚点核验
```bash
grep -n "explicitReferenceSkillHasScripts" src/main/modules/agent-control/runtime-core/agent-sdk-runtime.ts src/main/modules/agent-control/runtime-core/agent-sdk-utils.ts | head
grep -n "allowRunShell" src/main/modules/agent-control/runtime-core/agent-sdk-runtime.ts | head
grep -rn "getSetting\|setSetting" src/main/modules/skills-runtime --include='*.ts' | head -3
```

### 合同
1. 设置真值：`settingsRepository` 键 `skill_shell_consent`（JSON map `{ [skillId]: true }`）；
   读写助手放 skills-runtime（`getSkillShellConsent(skillId)` / `setSkillShellConsent(skillId, granted)`）。
2. 授权策略（改 `resolveSkillAuthorizationForTurn` 的 `allowRunShell` 计算处）：
   `allowRunShell = hasScripts && (isEmbeddedSkill(skillId) || getSkillShellConsent(skillId))`。
   embedded 默认放行（随包分发、经 CI 合同审过）；custom/导入技能默认关。
   `isEmbeddedSkill` 用 `EMBEDDED_SKILL_IDS.has(id)`（P2-3 后仍存在）。
3. 拒绝可观测（延续 Power-Mode `grant_required` 语义）：同意缺失且技能带 scripts 时，
   经 SystemReminderRegistry 注册一条 selected 轮提醒：
   `该技能包含可执行脚本但未获脚本执行授权；请在 技能中心 → <技能名> 开启"允许运行脚本"，或改用只读方法论部分。`
   模型据此不会伪造脚本结果（配合技能 SKILL.md 的降级路径）。禁止在调度层内联文案。
4. UI：`SkillsCenterPanel.tsx` custom 技能条目加"允许运行脚本"开关（仅带 `scripts/` 目录的技能显示；
   IPC get/set + preload + 类型五件套）。开关默认关，文案注明风险一句话以内。
5. **不回归**：embedded 两个设计 skill（ppt/card）真机脚本链路不受影响（默认放行路径）。

### 红测
1. 授权矩阵：embedded+scripts → allow；custom+scripts+无同意 → deny；custom+scripts+同意 → allow；无 scripts → deny（现状保持）；
2. consent 读写助手（含缺省键、坏 JSON 容错→视为全 false）；
3. 提醒注册条件（selected∧hasScripts∧!consent 才有）。

### 提交
`git commit -m "feat(skills): per-skill shell-execution consent with settings toggle"`

## 3. 工单 P3-3：作者侧 lint（agentskills.io 规范面）

### 合同
1. `scripts/lint-skill.cjs <skill-dir>`（零依赖，node 内置）检查并输出 `ERROR/WARN` 行、按 ERROR 数定退出码：
   - ERROR：缺 SKILL.md；frontmatter 缺 name 或 description；name 不匹配 `^[a-z0-9]([a-z0-9-]{0,62}[a-z0-9])?$` 或含 `--`；name ≠ 目录名；description 空或 >1024 字符。
   - WARN：正文 >12000 字符（Ready L2 截断线）；>500 行（spec 建议）；存在 `allowed-tools`（Ready 忽略该字段）；`scripts/` 存在但 SKILL.md 未出现 `$CLAUDE_SKILL_DIR`。
2. `package.json` scripts 增 `"skills:lint": "node scripts/lint-skill.cjs"`。
3. 导入管线接入：`importCustomSkillFolder` 前置调用 lint 的 ERROR 集（复用同一实现，提取 `lint-skill-core.cjs` 或等价共享——**同一套规则两处消费，不许抄两份**）；ERROR → 导入拒绝并把行文返回 UI；WARN → 并入 P2-5 的 warnings 通道。
4. 对存量 `assets/embedded-skills/*` 全量跑 lint：ERROR 必须为 0（有则修 frontmatter，属本单 diff；改动逐条列报告）。

### 红测
lint 规则矩阵单测（每条 ERROR/WARN 一个 fixture）；导入拒绝路径测试（坏 name 目录 → 拒绝且信息含规则名）。

### 提交
`git commit -m "feat(skills): agentskills-spec lint for authoring and import gate"`

## 4. 工单 P3-4：收尾同步

1. `CLAUDE.md` §2/§3 增补（`AGENTS.md` 同次同文）：中立目录发现=建议导入制；custom 技能脚本执行默认关、按技能同意；lint 为导入 ERROR 闸。
2. 母合同（2026-07-06 文档）P0-P3 段落全部标记完成日期；本执行书 status 更新。
3. `PROGRESS.md` / `CHANGELOG.md` 按仓库惯例补一条（CHANGELOG 此时允许改——发布线冲突期已过；若仍有未发布占位冲突，只写 PROGRESS 并报告）。
4. 全链回归：
```bash
npm run test > /tmp/p34a.log 2>&1; echo EXIT=$?
npm run typecheck > /tmp/p34b.log 2>&1; echo EXIT=$?
npm run verify:native > /tmp/p34c.log 2>&1; echo EXIT=$?
```
   全 `EXIT=0`（基线既知失败按差集报告）。

### 提交
`git commit -m "docs(skills): close out skill ecosystem phase and sync guidelines"`

## 5. 完成定义（P3 整相）
- 四单 commit；上面全链回归绿；
- 真机三验：①把一个标准 Claude 技能放 `~/.agents/skills/` → 技能中心"发现的技能"出现、点导入可用；
  ②custom 带脚本技能：未开同意 → agent 明确说明需授权并指路设置页（不伪造、不硬失败）；开同意 → 脚本真跑；
  ③`npm run skills:lint assets/embedded-skills/ready-human-touch-ppt` EXIT=0。
