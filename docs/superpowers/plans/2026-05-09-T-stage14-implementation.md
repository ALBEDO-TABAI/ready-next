---
stage: T (Stage 14)
date: 2026-05-09
enforce: true
status: approved v18 — Codex round 18 converged 2026-05-09 (18 rounds × 30+ 瑕疵 cleared)
predecessor: 2026-05-09-S-stage13-implementation.md
roadmap: archive/2026-05-08-deerflow-borrowing-roadmap.md
revision_history:
  - v1 (2026-05-09): initial implementation plan from roadmap v13; covers W0.3 / W7.1-W7.3 / W9.1-W9.2 / T-B / T-C with 13 CI gates
  - v2 (2026-05-09): incorporated Codex round 1 — 5 瑕疵（2 Contract Gap + 3 Major）：(R1-#1) 行号修正——`tool-registry.ts:673` `GROUP_TOOL_PROVIDERS` 实测 14 provider entries（Stage R `general_research` + Stage S 7 子模块路径，见 capability groups list 14 元）；`run-budget-policy.ts:16-46` 不是 16-43。(R1-#2 Contract Gap W7.1) `run-shell.ts:239` `shouldUseShell` 路径走 `bash -c "<full cmd>"` 直接 spawn，**绕过** `parseCommand` —— `parseCommand 后注入` 漏审 `| sh / 重定向类 / $(curl ...)` 整个复合命令族。修：审计层在 `executeRunShell` 入口（`:236-300` 之间）调 `auditBashCommand(args.command)`，**先于** `shouldUseShell` 分支判断；两条分支统一审。(R1-#3 W9.1) JSONL 写位真实位置在 `skill-child-run-log.ts:61-68 appendChildRunEvent`（`fs.appendFile`），不在 skill-child-runner；runner `:624, :1473` 是 caller。修：W9.1 落点改 `appendChildRunEvent` 内 event shape + caller 调用位带 event_kind/terminal_reason/rollback_target。(R1-#7) PR-T1 verify:t 串引用 T2-T5 未存在 gate → 改 verify:t 串接 gates 在 PR-T6 收尾时一次拼齐；PR-T1 仅含 check-verify-t-defined.cjs；T2-T5 各 PR 在落 gate 时同步把脚本名追加到 verify:t（实施时 1 处 atomic edit）。(R1-#8 minor) roadmap 文件在 main repo 的 `docs/superpowers/plans/`，worktree 只 land plan + implementation；与 Stage R/S 同款形态，不修。
  - v3 (2026-05-09): incorporated Codex round 2 — 4 瑕疵：(R2-#1) §1 现实核实段残留旧"7 个 capability group"+"16-43"+runner 写位描述；同步到 14 元 + 16-46 + appendChildRunEvent + caller 表述（同 v2 round 1 修正一致）；(R2-#2) §9 §6.27 草稿"parseCommand 后审计"残留改"executeRunShell 入口审计先于 shouldUseShell"；(R2-#3) §4.3 W9.1 gate `check-event-ledger-shape.cjs` 描述同时锁 `skill-child-run-log.ts` event shape + caller 字段；(R2-#4) §2 verify:t 一次性串拆为 **PR-T1 骨架版**（仅 check-verify-t-defined）+ **PR-T6 最终态**（含全 12 gate）两段，文档明示 T2-T5 累加节奏
  - v4 (2026-05-09): incorporated Codex round 3 — 3 瑕疵（2 Contract Gap + 1 Major）：(R3-#1 §2) PR-T1 骨架版 verify:t 不能含 `test:t:gates` / `test:t:focus`（指向 T2-T5 才落的文件），改为最简 `verify:s + check-verify-t-defined`；test:t:gates 在第一个内容 PR 加，test:t:focus 在最后一个内容 PR 加；(R3-#2 §3.1) §3.1 W7.1 `run-shell.ts parseCommand 后调 auditBashCommand` 残留改"executeRunShell 入口（先于 shouldUseShell）"；(R3-#3 §5.2) ParallelBranchOrchestrator.spawn 函数签名 `(signal: AbortSignal) => Promise<unknown>` 让分支真能接收取消信号；cancel 通过对应 AbortController 触发
  - v5 (2026-05-09): incorporated Codex round 4 — 6 瑕疵（5 Contract Gap + 1 Major）：(R4-CG#1 W7.2 size) gate 加 100MB 上限语义校验；(R4-CG#2 W9.2 UI) gate 加 renderer TaskCard `rollback_target` 引用校验；(R4-CG#3 T-B cancel) 新 gate `check-parallel-branch-cancel-signal.cjs` 验 spawn AbortSignal 参数；(R4-CG#4 T-C mcp group) 新 gate `check-mcp-group-registered.cjs` 验 CapabilityGroupId 'mcp' 第 15 值 + GROUP_TOOL_PROVIDERS 含 mcp entry；(R4-CG#5 T-C OAuth) 新 gate `check-mcp-oauth-authorization-flow.cjs` 验 OAuth 核心入口 + client 请求前 ensureAuthorized；(R4-MJ#1 W7.1 |sh) `pipe to shell` 正则去 `$/m` 锚定，覆盖 `| sh -s` / `| sh -c "..."`；总 gate 数 13 → 16 unique
  - v6 (2026-05-09): incorporated Codex round 5 — 3 瑕疵（2 Contract Gap + 1 Major）：(R5-CG#1 §2) PR-T6 最终态 verify:t 串遗漏 round 4 新增 3 gate（cancel-signal / mcp-group / oauth-flow）；明文加上 PR-T6 最终态字符串。(R5-CG#2 W9.1) `check-event-ledger-shape.cjs` 真实落点是 `skill-child-run-types.ts:197 SkillChildRunEvent` 类型，不是 `skill-child-run-log.ts`；gate 落点改正。(R5-MJ#1 W7.2 size) 不上冲 100MB——保留 §6.12 现有合同 read 1MB（`read-artifact.ts:18 HARD_CAP_BYTES`）+ write 50MB（`write-artifact.ts:30 WRITE_ARTIFACT_HARD_CAP_BYTES`），gate 改为验现有上限不退化
  - v7 (2026-05-09): incorporated Codex round 6 — 2 瑕疵（1 Contract Gap + 1 Major）：(R6-CG#1 §2) 删除残留的旧 PR-T6 最终态 verify:t 字符串（line 47，13-gate 版本）——只保留 line 45 的 16-gate 版本；同步 §8 标题 13→16 unique；(R6-MJ#1 §9 §6.27) CLAUDE.md 草稿"100MB 文件大小限"残留改"现有 read 1MB / write 50MB 与 §6.12 一致"；"12 个新 gate"残留改"15 个内嵌 + 切换 gate 1 = 16 unique"
  - v8 (2026-05-09): incorporated Codex round 7 — 3 瑕疵（1 Contract Gap + 1 Major + 1 sub-Contract）：(R7-CG#1 §8) gate 完整列表 T-B/T-C 行残留 2 + 3 写法，加全 cancel-signal / mcp-group / oauth-flow 共 T-B 3 + T-C 5；(R7-MJ#1 §7) PR-T4 + PR-T5 描述补 "+3 gates" / "+5 gates" 含 round 4 新 gate 标注；(R7-CG#2 §10) 收敛条件 "13 cjs gate" 改 "16 unique cjs gate（verify:t 内嵌 15 + 切换 gate 1）"
  - v9 (2026-05-09): incorporated Codex round 8 — 3 瑕疵（3 Major）：(R8-#1 §5.4) "T-B Gates（2 个）" → "（3 个）"；(R8-#2 §6.5) "T-C Gates（3 个）" → "（5 个）"；(R8-#3 §7 PR-T1) "T2-T5 的 12 个 gate" → "T2-T5 的 14 个 gate（3+3+3+5）"
  - v10 (2026-05-09): incorporated Codex round 9 — 1 Major：(R9-#1) §1 "skill-child-runner.ts JSONL 写位" 残留改正——真实写入函数 `appendChildRunEvent` 在 `skill-child-run-log.ts:61-68`，runner 是 caller；event 类型定义在 `skill-child-run-types.ts:197 SkillChildRunEvent`；§4.1 W9.1 三步落地清单同步加 types 文件 + log 函数 + runner caller
  - v11 (2026-05-09): incorporated Codex round 10 — 1 Contract Gap：(R10-#1) §4.1 `lastSafeStepId` 来源未定义 + §4.3 gate 终态字段合同未闭合。修：§4.1 第 3 步说明 lastSafeStepId 是 runner 内部记录最后持久化 step id 的字段（如不存在新加 `private lastSafeStepId: string \| null = null`，每 step 完成时更新；cancel 终态填 `?? null`）；§4.3 gate (C) 加 `lastSafeStepId` 引用校验，gate (B) 加 `cancelled` 字面量分支 + `rollback_target` 字段闭合
  - v12 (2026-05-09): incorporated Codex round 11 — 1 Contract Gap：(R11-#1) `rollback_target` 类型从 `string?`（=`string | undefined`）改 `string \| null`（cancel 路径若无 safe step 会写 null，必须允许 null 不仅 undefined）；§4.1 类型扩描述 + §4.3 gate (A) 校验同步
  - v13 (2026-05-09): incorporated Codex round 12 — 2 瑕疵（1 Contract Gap + 1 Major）：(R12-CG#1 §3.3 W7.3) overflow log（§6.12 `<artifactRoot>/.logs/shell-<ts>-<uuid>-<stream>.txt`）持久化路径未脱敏，会泄漏 `/Users/<name>`；修：写 overflow log 前调 `redactHostPaths`，gate 升级为要求 ≥3 处调用（stdout / stderr / overflow log）；同样 `stdoutArtifactPath / stderrArtifactPath` 返回字符串走脱敏。(R12-MJ#1 §4.1) 示例 inline `rollback_target?: string` 残留与 round 11 改正不一致；改为 `rollback_target?: string | null`
  - v14 (2026-05-09): incorporated Codex round 13 — 1 Contract Gap：(R13-#1 T-C) §6.23 现有 `SkillToolAuthorization` 只过滤 `skill_*` 前缀；MCP 工具是非 `skill_*` 前缀，会漏过。修：(a) §6.5 gate `check-mcp-tools-go-through-authorization.cjs` 强化为 MCP 独立 authorization 合同（不复用 §6.23），grep `mcp/registry.ts` 的 `isAuthorized` 在 list resolver 内 production 调用位；(b) §6.5 gate `check-mcp-group-registered.cjs` 加 `CAPABILITY_GROUPS` 数组完整条目校验（不只 union）；(c) §6.3 改写 MCP authorization 形态——新建独立 `mcp.registry.isAuthorized` 接口，与 §6.23 合同正交
  - v15 (2026-05-09): incorporated Codex round 14 — 1 Contract Gap：(R14-#1 §9 §6.27) CLAUDE.md 草稿"MCP tool 走 §6.23 authorization"残留与 §6.3/6.5 独立 MCP 合同冲突；改为"MCP tool 走独立 `mcp.registry.isAuthorized` 合同（与 §6.23 SkillToolAuthorization 正交不复用）"
  - v16 (2026-05-09): incorporated Codex round 15 — 1 Contract Gap：(R15-#1) MCP `isAuthorized` 签名只锁 `sessionId` 会让跨 scope 泄漏（MCP server 通常按 scope 授权，单 sessionId 不够）；§6.5 gate `check-mcp-tools-go-through-authorization.cjs` 加 (C) 校验：调用必须含 `sessionId` AND `scopeId` 两个参数
  - v17 (2026-05-09): incorporated Codex round 16 — 1 Contract Gap：(R16-#1) scopeId 端到端流通——仅校验 isAuthorized 调用形状不够，可传 fake 值；gate 加 (D) 校验三处接入：(1) `ToolPolicy.scopeId?: string` 字段扩，(2) `run-capability-controller.ts` 装配时从 `requestEnvelope.scopeId` 读入，(3) `tool-gateway.ts.getToolDefinitionsForGroup` 签名扩第 4 个 `scopeId?` 参数；防 fake scopeId 注入
  - v18 (2026-05-09): incorporated Codex round 17 — 2 Contract Gap：(R17-#1) `RequestEnvelope` 实测无 scope 字段——gate (D) 必须先要求 RequestEnvelope 扩 `scopeId?: string`，再串联 4 处接入；(R17-#2) `getToolSchemasForGroup`（OpenAI/Anthropic schema 列表）签名也要扩 `scopeId?` 参数；schema list 与 definition list 双源都过授权
---

> 2026-09-06 文档核对：本文保留当前仍使用的专项合同及原验收记录；后文的日期、阶段状态和现场缺口按原记录理解，不据此推导今天全部已验收或仍未实现。当前应用边界以 [运行时合同](../../architecture/current-runtime-contracts.md) 为准，近期状态见 [PROGRESS](../../../PROGRESS.md)。

# Stage T (Stage 14) — 深度扩展 · 实施计划

## 0. 背景

Stage R + Stage S 已收敛于 worktree `deerflow-stage-r-s-t`（27 commits since Stage Q）。Stage T 是路线图最后一段，每条工作项先过决策（路线图 §4 已决断）：W7.1-7.3 sandbox / W9.1-9.2 event ledger 直接立项；T-B parallel subagent + T-C MCP 立项；T-A 由 Theme 6（Stage S）取代不独立；T-D 远程 projection join 不立项。

## 1. 现实核实（基于 Stage S 收敛后 worktree HEAD `6be1362`）

- `verify:s` 是当前主 verify 起步链；§6.26 已 land
- `src/main/modules/tools/skill-primitives/run-shell.ts` 是 `parseCommand` + bash spawn 调度位（W7.1 接入位）
- `src/main/modules/tools/skill-primitives/{read-artifact, write-artifact}.ts` 是 W7.2 接入位
- `src/main/modules/agent-control/skill-child-run-log.ts:61-68 appendChildRunEvent` 是 JSONL 实际写函数；caller 在 `skill-child-runner.ts:624, :1473`；event 类型定义在 `skill-child-run-types.ts:197 SkillChildRunEvent`（W9.1 三处协调修改）
- `src/main/modules/agent-control/skill-child-run-log.ts` JSONL 读位（W9.2）
- `src/main/modules/agent-control/tool-registry.ts:673` `GROUP_TOOL_PROVIDERS` 实测 14 个 capability group 的 provider entry（含 Stage R `general_research`），未含 mcp（T-C 加第 15 值）
- `src/main/modules/agent-control/run-budget-policy.ts:16-46` `TASK_TYPE_BUDGET_PRESETS` 6 元（T-B 加 hard cap subagent 预算）
- `src/main/modules/agent-control/skill-child-run-log.ts:61-68 appendChildRunEvent` 是 JSONL 真实写函数；caller 在 `skill-child-runner.ts:624, :1473`

## 2. W0.3 — verify:t 定义

`package.json`：

```jsonc
"test:t:gates": "node --test eslint-rules/__tests__/*.test.mjs scripts/__tests__/*.test.cjs",
"test:t:focus": "npx tsx@^4.19.2 --test --test-concurrency=1 src/__tests__/sandbox-bash-high-risk.test.ts src/__tests__/sandbox-symlink-rejected.test.ts src/__tests__/shell-output-host-path-redacted.test.ts src/__tests__/event-ledger-shape.test.ts src/__tests__/rollback-target-readable.test.ts src/__tests__/parallel-branch-orchestrator.test.ts src/__tests__/mcp-tools-authorization.test.ts src/__tests__/deferred-tool-promotion.test.ts",
// PR-T1 仅落 verify:t skeleton（不引用 T2-T5 gates，**也不**包 test:t:gates / test:t:focus，避免 T1 阶段红）：
"verify:t": "npm run verify:s && node scripts/check-verify-t-defined.cjs"
// 各 PR-T2..T5 land 时除追加 gate 外，**首次** atomic 加 test:t:gates；T5 land 后加 test:t:focus；T6 收尾时无新 atomic edit。
// PR-T6 最终态（必须含 round 4 新增 3 gate）：
"verify:t": "npm run verify:s && node scripts/check-verify-t-defined.cjs && node scripts/check-sandbox-bash-high-risk-patterns.cjs && node scripts/check-skill-primitives-symlink-rejected.cjs && node scripts/check-shell-output-host-path-redacted.cjs && node scripts/check-event-ledger-shape.cjs && node scripts/check-rollback-target-readable.cjs && node scripts/check-no-auto-rollback-on-cancel.cjs && node scripts/check-parallel-branch-frame-merge.cjs && node scripts/check-parallel-branch-hard-cap.cjs && node scripts/check-parallel-branch-cancel-signal.cjs && node scripts/check-mcp-tools-go-through-authorization.cjs && node scripts/check-deferred-tool-promotion-after-authorization.cjs && node scripts/check-deferred-registry-per-turn-reset.cjs && node scripts/check-mcp-group-registered.cjs && node scripts/check-mcp-oauth-authorization-flow.cjs && npm run test:t:gates && npm run test:t:focus"
```

新建 `scripts/check-verify-t-defined.cjs`（参考 stage-s-verify-defined 形态）+ `scripts/check-stage-t-verify-switch.cjs`（PR-T-final 切换 gate）。

## 3. Theme 7 [RC-2] · Sandbox Hardening（W7.1+W7.2+W7.3）

### 3.1 W7.1 — bash 危险模式正则审计

`src/main/modules/tools/skill-primitives/run-shell.ts`：**Codex round 1 R1-#2 修正**：审计层必须在 `executeRunShell` 入口（`:236` 后），**先于** `shouldUseShell` 分支判断（实测 `:239`）。这样 `bash -c` 复合命令路径与 `parseCommand` 解析路径**两条都被审**，避免 `| sh / 重定向 / $(curl ...)` 类绕过。

**Source**：deer-flow `agents/middlewares/sandbox_audit_middleware.py:25-51, 137-189` `_HIGH_RISK_PATTERNS`。

新建 `src/main/modules/tools/skill-primitives/bash-risk-patterns.ts`：

```ts
export const HIGH_RISK_PATTERNS: Array<{ pattern: RegExp; description: string }> = [
  { pattern: /\brm\s+-rf\s+\/(?:\s|$)/i, description: 'rm -rf root' },
  { pattern: /\brm\s+-rf\s+\$HOME/i, description: 'rm -rf $HOME' },
  { pattern: /\bdd\s+if=/i, description: 'dd raw write' },
  { pattern: /\bmkfs\b/i, description: 'mkfs' },
  { pattern: /\|\s*(?:bash|sh|zsh)\b/i, description: 'pipe to shell' },  // R4 修：去 $/m 锚定，覆盖 `| sh -s`、`| sh -c "..."` 类
  { pattern: /\$\(curl\s/i, description: 'curl in cmd substitution' },
  { pattern: /\bbase64\s+-d\s*\|/i, description: 'base64 decode pipe' },
  { pattern: />\s*\/etc\//i, description: 'overwrite /etc' },
  { pattern: />\s*\/usr\/bin\//i, description: 'overwrite /usr/bin' },
  { pattern: /\bwget\b[^|;]*\|\s*(?:python|node|sh|bash)\b/i, description: 'wget exec' },
]

export function auditBashCommand(command: string): { allowed: boolean; matched?: { pattern: string; description: string } } {
  for (const { pattern, description } of HIGH_RISK_PATTERNS) {
    if (pattern.test(command)) return { allowed: false, matched: { pattern: pattern.source, description } }
  }
  return { allowed: true }
}
```

`run-shell.ts` 在 `executeRunShell` 入口（line `:236-300` 之间，**先于** `shouldUseShell` 分支判断）调 `auditBashCommand(args.command)`，命中抛 `ToolDomainError('command_high_risk_blocked', ...)`。两条分支（`bash -c` 复合命令 + `parseCommand` 解析路径）共享同一审计 gate。

### 3.2 W7.2 — symlink 拒绝 + 文件大小限制

**Codex round 5 修正**：实测 `read-artifact.ts:18` `HARD_CAP_BYTES = 1_048_576`（1MB）；`write-artifact.ts:30 WRITE_ARTIFACT_HARD_CAP_BYTES = 50 * 1024 * 1024`（50MB）。**不冲突现有上限**——本 W 不动 write 50MB（保留 §6.12 现有合同），只在 read 路径加 symlink 拒绝；如需更大 read 上限留给后续 stage。

`src/main/modules/tools/skill-primitives/read-artifact.ts` + `write-artifact.ts`：在路径解析后用 `fs.lstatSync` 检测 symlink，命中拒绝；现有 size 上限保留（read 1MB，write 50MB），**不**改为 100MB（避免冲突 §6.12）。

复用 `path-sandbox.ts:202-228` `resolveReadableWithinRoot` 内已有的 symlink 检查（grep 看是否已有；如无加）。

### 3.3 W7.3 — host path 脱敏（含 overflow log）

`run-shell.ts` 输出处理层：把 stdout / stderr 中的 `$HOME / /Users/<name>` 等 host path 脱敏为 `~` 或 `/<redacted>`。

**Codex round 12 修正**：现 `run-shell.ts` 在 stdout/stderr 超 8K 时会写 `<artifactRoot>/.logs/shell-<ts>-<uuid>-<stream>.txt` overflow log（§6.12 现有合同）。**该 overflow log 内容也必须经 `redactHostPaths` 脱敏后才落盘**——避免持久化文件泄漏 `/Users/<name>`。grep `run-shell.ts` 写 overflow log 位（`writeFileSync` / 写入 `.logs/shell-` 路径处），调 helper 后再写。同时 `stdoutArtifactPath` / `stderrArtifactPath` 字段路径返回前也要走 `redactHostPaths` 包装（路径本身可能含 /Users）。

新建 `src/main/modules/tools/skill-primitives/host-path-redactor.ts`：

```ts
export function redactHostPaths(text: string): string {
  return text
    .replace(new RegExp(escapeRegex(process.env.HOME || ''), 'g'), '~')
    .replace(/\/Users\/[^/\s]+/g, '/Users/<redacted>')
    .replace(/\/home\/[^/\s]+/g, '/home/<redacted>')
}
```

`run-shell.ts` 在返回 stdout/stderr 前调 `redactHostPaths`。

### 3.4 Gates（3 个）

- `check-sandbox-bash-high-risk-patterns.cjs`：fixture 矩阵（rm -rf / / dd / mkfs / |sh / $(curl) / base64 -d| / >/etc/* / >/usr/bin/）
- `check-skill-primitives-symlink-rejected.cjs`：grep read/write-artifact.ts 含 `lstatSync` + symlink 拒绝；同时验现有 `HARD_CAP_BYTES`（read 1MB，read-artifact.ts:18）+ `WRITE_ARTIFACT_HARD_CAP_BYTES`（write 50MB，write-artifact.ts:30）保留不退化（R5 修正：与 §6.12 现有合同一致，不上冲 100MB）
- `check-shell-output-host-path-redacted.cjs`：grep run-shell.ts 含 redactHostPaths 调用 ≥ 3 处（stdout 返回前 / stderr 返回前 / overflow log 写入前），覆盖 inline output + persisted overflow log（**round 12 修正**：原仅 ≥1 调用允许 overflow log 泄漏 host path）

## 4. Theme 9 [RC-5] · Worker Event Ledger（W9.1+W9.2）

### 4.1 W9.1 — child runner JSONL 加事件账本字段

**Codex round 1+5+9 修正**：实测 JSONL 真实写入函数是 `src/main/modules/agent-control/skill-child-run-log.ts:61-68 appendChildRunEvent`（用 `fs.appendFile`）；caller 在 `skill-child-runner.ts:624, :1473`；event 类型定义在 `skill-child-run-types.ts:197 SkillChildRunEvent`（**不**在 -log.ts 内）。

W9.1 三步落地：
1. `skill-child-run-types.ts:197 SkillChildRunEvent` 类型扩 `event_kind / ts / terminal_reason? / rollback_target?: string \| null` 字段（**round 11 修正**：runner 内 cancel 路径若无安全 step 会写 null，类型必须允许 `null` 不仅 `undefined`）
2. `skill-child-run-log.ts:61-68 appendChildRunEvent` 函数体读取/写入新字段（路径不变）
3. `skill-child-runner.ts:624 / :1473` 等 caller 在构造 event 时填新字段。**`lastSafeStepId` 定义**：runner 内部记录每个 step 完成后最后一个**真正持久化**的步骤 id（grep `currentStepId` / `stepId` 的 step-complete 写入位作为锚点；如不存在专用变量，新加 `private lastSafeStepId: string | null = null` 字段，每个 step 完成时更新）；cancel 终态时填 `rollback_target = this.lastSafeStepId ?? null`

```ts
{
  ts: number,
  event_kind: 'started' | 'progress' | 'budget_warning' | 'paused' | 'resumed' | 'cancelled' | 'completed' | 'failed',
  // 终态事件可选：
  terminal_reason?: string,
  // 仅在 cancel 时填：
  rollback_target?: string | null,  // lastSafeStepId（无 safe step 时 null）
  // ... 现有字段
}
```

显式拒绝自动状态回滚——只是诊断字段。

### 4.2 W9.2 — rollback_target 读取展示

`src/main/modules/agent-control/skill-child-run-log.ts` reader：解析 rollback_target 字段供 renderer TaskCard 展示。**不**触发任何 rollback 函数。

renderer TaskCard 加 `rollback_target` 显示位（实施期 grep TaskCard 渲染位）。

### 4.3 Gates（3 个）

- `check-event-ledger-shape.cjs`：(A) grep `skill-child-run-types.ts:197 SkillChildRunEvent` 类型含 `event_kind` + `ts` + `terminal_reason?` + `rollback_target?: string \| null` 字段（**round 11 修正**：必须允许 null 不仅 undefined）；(B) grep `skill-child-runner.ts` 任一 caller 调用位（grep `appendChildRunEvent\(\s*{[^}]*event_kind\s*:`）含 `terminal_reason` 且至少一处终态分支条件含 `cancelled` / `cancel` 字面量加 `rollback_target` 字段；(C) grep runner 含 `lastSafeStepId` 引用作为 rollback_target 来源（**round 10 修正**：闭合终态字段合同）
- `check-rollback-target-readable.cjs`：grep skill-child-run-log.ts 含 `rollback_target` 读取；同时 grep TaskCard renderer 组件（`ChatPanel.tsx` / `taskCardViewModel.ts` / `TaskPanel.tsx` 任一）含 `rollback_target` 引用（R4 增——锁 UI 展示）
- `check-no-auto-rollback-on-cancel.cjs`：grep cancel 路径不调用任何 rollback function（hard ban：`/rollback\(/i` not in cancel handler）

## 5. T-B [扩展] · Parallel subagent + hard cap

### 5.1 Source
deer-flow `subagents/executor.py` 概念 + `subagent_limit_middleware.py:1-75` 硬限流。

### 5.2 新建 `src/main/modules/agent-control/parallel-branch-orchestrator.ts`

```ts
export interface ParallelBranch {
  id: string
  task: string
  promise: Promise<unknown>
  startedAt: number
}

export interface ParallelBranchOrchestrator {
  // R3: 分支函数必须接收 AbortSignal 并在阻塞点检查；否则 cancel 不可达
  spawn(task: string, fn: (signal: AbortSignal) => Promise<unknown>): ParallelBranch | null  // null 表示 hard cap reached
  awaitAll(): Promise<unknown[]>
  cancel(branchId: string): void  // 内部 abort 对应 branch 的 AbortController
  getActive(): ParallelBranch[]
}

export const PARALLEL_BRANCH_HARD_CAP = 3 as const

export function createParallelBranchOrchestrator(): ParallelBranchOrchestrator {
  // 实现：维护 active branches 数组，spawn 时检查 < hard cap；超过返 null + emit metric `parallel_branch_hard_cap_reached`
  // awaitAll 用 Promise.allSettled
  // cancel 用 AbortController（每 branch 独立）
}
```

### 5.3 §6.20 frame 单源合规

并行 branch 不能同时写 TurnFrame；orchestrator 在 awaitAll 完成后**串行 merge** 各 branch 的 framePatch（按 branch id 顺序 deterministic）。

### 5.4 Gates（3 个）

- `check-parallel-branch-frame-merge.cjs`：grep parallel-branch-orchestrator.ts 含 `applyTurnFramePatch` 串行调用（不能并行写 frame）
- `check-parallel-branch-hard-cap.cjs`：grep `PARALLEL_BRANCH_HARD_CAP === 3` + spawn 内 cap 检查
- `check-parallel-branch-cancel-signal.cjs`（R4 新增）：grep `parallel-branch-orchestrator.ts` `spawn` 签名含 `AbortSignal` 参数；grep `cancel` 路径调 `AbortController` `.abort()`

## 6. T-C [扩展] · MCP integration + OAuth + deferred discovery

### 6.1 Source
deer-flow `mcp/{cache,client,oauth,tools}.py` + `tools/builtins/tool_search.py:31-120` + `agents/middlewares/deferred_tool_filter_middleware.py`

### 6.2 新建 `src/main/modules/mcp/`

```
src/main/modules/mcp/
├── client.ts        # MCP client (stdio + websocket transport)
├── oauth.ts         # OAuth interceptor for MCP servers requiring auth
├── registry.ts      # MCP server registry (active + deferred)
├── tool-discovery.ts  # 从 MCP server 拉工具 schema
└── deferred-filter.ts # deferred tool 在 turn-gap 提级到 active
```

### 6.3 tool-registry.ts MCP 集成（round 13 修正）

**两处协调**：
1. `src/shared/ai-capability-groups.ts`：`CapabilityGroupId` union 加 `'mcp'` 第 15 值；`CAPABILITY_GROUPS[]` 数组加 `id: 'mcp'` 完整条目（label / exposure: `'model_visible'` / availability / defaultMode / defaultProfiles 等字段）。
2. `tool-registry.ts:673` `GROUP_TOOL_PROVIDERS` 加 `mcp` provider entry。

**MCP authorization 独立合同**：§6.23 现有 `SkillToolAuthorization` 只过滤 `skill_*` 前缀；MCP 工具是非 `skill_*` 前缀，**不能复用**该合同。本 W 新建独立 `mcp.registry.isAuthorized(toolName, sessionId, scopeId)` 接口，在 mcp provider 的 `getToolDefinitionsForGroup` list resolver 内调用，未授权 MCP 工具不进模型可见列表。这是合同独立维度，与 §6.23 互不干扰。

### 6.4 deferred 注册表 per-turn 重置

abort/error 后 deferred registry 必须重置（防 schema 数量爆炸）。`turn-engine.ts` 在 turn 结束 hook 内调 `mcp.deferredRegistry.reset()`。

### 6.5 Gates（5 个）

- `check-mcp-tools-go-through-authorization.cjs`（round 13+15+16+17 强化）：(A) grep `mcp/registry.ts` 含 authorization filter 调用；(B) §6.23 现有 authorization 实测**只过滤 `skill_*` 前缀工具**（`skill-tool-authorization.ts`），MCP 工具非 `skill_*` 前缀会漏过——本 W 必须新建 **MCP 工具独立 authorization gate**：在 `tool-registry.ts` 的 `mcp` provider list resolver 内加二层 `mcp.registry.isAuthorized(toolName, sessionId, scopeId)` 调用，未授权 MCP 工具不入模型可见列表；(C) **scope 必须随 sessionId 一起传**——gate 必须 grep `isAuthorized` 调用签名包含 `sessionId` AND `scopeId` 两个参数（防跨 scope 泄漏：MCP server 通常按 scope 授权，单 sessionId 不够）；(D) **scopeId 端到端流通校验**（round 16+17 修正）：`request-envelope.ts RequestEnvelope` 接口扩 `scopeId?: string` 字段（实测 `RequestEnvelope` 当前无 scope 字段，必须先扩；亦可从 `request.session.scope.id` 通过 closure 读，二选一——本计划选 RequestEnvelope 扩字段以保单源）；`ToolPolicy` 接口扩 `scopeId?: string`，`run-capability-controller.ts` 装配 toolPolicy 时从 `requestEnvelope.scopeId` 读入；`tool-gateway.ts` `getToolDefinitionsForGroup` 签名扩第 4 个参数 `scopeId?: string`（已有 `sessionId` 是第 2 个）；`tool-registry.ts` mcp provider 内调 `isAuthorized(name, sessionId, scopeId)` 时三个参数都从同一上游链路读，gate 同时 grep 这 4 处接入点（RequestEnvelope 字段扩 / policy 装配 / gateway 签名扩 / registry 调用位）；(E) **schema 工具列表同链路授权**（round 17 新增）：除 `getToolDefinitionsForGroup`（值列表），`getToolSchemasForGroup`（OpenAI/Anthropic schema 列表）签名也必须扩 `scopeId?` 参数，避免 schema 列表绕过授权；grep 两个 list resolver 都扩了；grep 该独立 gate 的 production 调用位（不仅 helper export）
- `check-deferred-tool-promotion-after-authorization.cjs`：grep `deferred-filter.ts` 含 promotion 路径走 authorization check
- `check-deferred-registry-per-turn-reset.cjs`：grep `turn-engine.ts` 在 turn 结束 hook 调 `deferredRegistry.reset()`
- `check-mcp-group-registered.cjs`（R4 新增；round 13 强化）：grep `src/shared/ai-capability-groups.ts` `CapabilityGroupId` union 含 `'mcp'` 第 15 值 + `CAPABILITY_GROUPS` 数组含 `id: 'mcp'` 条目（exposure / defaultProfiles / availability 字段齐）；grep `tool-registry.ts:673` `GROUP_TOOL_PROVIDERS` 含 `mcp` provider entry
- `check-mcp-oauth-authorization-flow.cjs`（R4 新增）：grep `mcp/oauth.ts` 含 OAuth `requestAuthorizationCode` / `exchangeCodeForToken` 等核心入口 + `mcp/client.ts` 在请求前调 `oauth.ensureAuthorized()` 之类的 gate 调用

## 7. PR 拆分

| PR | 内容 | depends-on |
|---|---|---|
| **PR-T1** | W0.3 verify:t skeleton（**仅含 check-verify-t-defined.cjs；T2-T5 的 14 个 gate（3+3+3+5）由各 PR 落 gate 时同步追加到 verify:t 串**——避免 PR-T1 引用未存在 gate） | — |
| **PR-T2** | W7.1+W7.2+W7.3 sandbox hardening + 3 gates | PR-T1 |
| **PR-T3** | W9.1+W9.2 event ledger + 3 gates | PR-T1 |
| **PR-T4** | T-B parallel-branch-orchestrator + 3 gates（含 round 4 cancel-signal） | PR-T1 |
| **PR-T5** | T-C MCP integration + 5 gates（含 round 4 mcp-group + oauth-flow） | PR-T1 |
| **PR-T6** | Stage 切换：主 verify / verify:cloud / CLAUDE.md §6.27 | PR-T1..T5 |

## 8. CI gate 完整列表（16 个 unique）

```
W0.3: check-verify-t-defined.cjs (verify:t 内嵌)
      check-stage-t-verify-switch.cjs (PR-T6 切换 gate)
W7.1: check-sandbox-bash-high-risk-patterns.cjs
W7.2: check-skill-primitives-symlink-rejected.cjs
W7.3: check-shell-output-host-path-redacted.cjs
W9.1: check-event-ledger-shape.cjs
W9.2: check-rollback-target-readable.cjs + check-no-auto-rollback-on-cancel.cjs
T-B:  check-parallel-branch-frame-merge.cjs + check-parallel-branch-hard-cap.cjs + check-parallel-branch-cancel-signal.cjs
T-C:  check-mcp-tools-go-through-authorization.cjs + check-deferred-tool-promotion-after-authorization.cjs + check-deferred-registry-per-turn-reset.cjs + check-mcp-group-registered.cjs + check-mcp-oauth-authorization-flow.cjs
```

合计 **16 unique gate**（verify:t 内嵌 15 + 切换 gate 1）：W0.3 (2) + W7 (3) + W9 (3) + T-B (3) + T-C (5) = 16。roadmap §11 写 12 是旧计数；本 plan v4 round 4 加 4 个 gate（cancel-signal / mcp-group / oauth-flow / 现有 gate 加 size-bound + UI-rollback 子项校验），让合同更紧。

## 9. CLAUDE.md §6.27 草稿

```md
### 6.27 deer-flow 借鉴 · 深度扩展（T / Stage 14）

- Stage 14（T 阶段）落地 sandbox hardening 三件套 + worker event ledger + parallel subagent + MCP integration。
- **Sandbox**：`bash-risk-patterns.ts` 10 条高危正则（rm -rf / / dd / mkfs / |sh / $(curl) / base64 -d| / >/etc / >/usr/bin / wget exec），`run-shell.ts executeRunShell` 入口审计（先于 `shouldUseShell` 分支，覆盖 bash -c 复合命令路径与 parseCommand 解析路径双侧）；read/write-artifact symlink 拒绝 + 现有大小限保留（read 1MB read-artifact.ts:18，write 50MB write-artifact.ts:30；与 §6.12 一致）；run-shell stdout/stderr 走 `redactHostPaths` 脱敏 host path。
- **Event ledger**：skill-child-runner JSONL 加 `event_kind / ts / terminal_reason / rollback_target` 字段；rollback_target 仅在 cancel 终态填，**只作诊断字段不触发回滚**——deer-flow worker abort rollback 自动语义显式拒绝。
- **Parallel subagent**：`parallel-branch-orchestrator.ts` PARALLEL_BRANCH_HARD_CAP=3；framePatch 串行 merge 保 §6.20 单源；超 cap 返 null + emit `parallel_branch_hard_cap_reached`。
- **MCP**：`src/main/modules/mcp/{client,oauth,registry,tool-discovery,deferred-filter}.ts` 五件套；新 capability group `'mcp'`（第 15 值；同步 `CapabilityGroupId` union + `CAPABILITY_GROUPS` 数组）；MCP tool 走**独立** `mcp.registry.isAuthorized(toolName, sessionId, scopeId)` 合同（**与 §6.23 `SkillToolAuthorization` 正交不复用**：§6.23 只过滤 `skill_*` 前缀，MCP 工具非 `skill_*` 前缀会漏，因此独立维度）；deferred registry per-turn reset 防 schema 爆炸。
- **Verify chain**：`npm run verify:t` 必须内嵌 `verify:s`（已含 verify:r + verify:native），并覆盖 15 个内嵌 gate + `test:t:gates` + `test:t:focus`（外加 PR-T6 切换 gate `check-stage-t-verify-switch.cjs`，共 16 unique）。Stage T done 后主 `verify` / `verify:cloud` 起步链切到 `verify:t`。
```

## 10. 收敛条件

- [ ] §3-§6 所有 W 落点 land
- [ ] 16 unique cjs gate（verify:t 内嵌 15 + 切换 gate 1）+ 8 tsx test 全部绿
- [ ] `npm run verify:t` 在 worktree 内通过
- [ ] CLAUDE.md §6.27 land
- [ ] 主 `verify` / `verify:cloud` 切换到 `verify:t`
- [ ] PR-T1..T6 全部 commit
