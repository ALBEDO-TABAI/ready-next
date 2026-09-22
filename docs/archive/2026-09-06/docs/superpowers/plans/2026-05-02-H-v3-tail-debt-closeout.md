---
name: H — v3 路线尾巴清扫（文档失真 / silent failure / timer idempotency / 测试反模式残留）
description: v3 路线全 9 阶段（A0-G）交付后的剩余尾巴清扫。10 项小颗粒度债，按 5 类根因聚类。不引入新抽象层，全部走"加 metric / 修文档 / 加 idempotency guard / 改 1 个测试"形态。这是 counter-proposal 文档，描述要修什么、修到什么程度算成功；具体实施计划由 codex 据此另开一份 implementation.md 文件。
status: completed
enforce: false
counter_proposal: 2026-04-30-skill-runtime-agent-layer-reframe.md
archived_at: 2026-09-06
archive_reason: superseded-project-documentation
---

> 已归档（2026-09-06）：本文保留编写当时的设计、状态与证据，不是当前执行入口；归档不表示原计划全部实现。现行说明见 [当前运行时合同](../../../../../architecture/current-runtime-contracts.md)，去向见 [文档清单](../../../../../documentation-inventory.md)。

# H — v3 路线尾巴清扫（counter-proposal）

> **定位**：v3 路线（A0/A0.5/A1/B/C/D/E/F/G）交付后实地 audit 出来的尾巴清扫。**不是 v4 路线开始**——这里 10 项全部是已识别根因的小颗粒度收口，不动抽象层。
>
> **写作目的**：把已 audit 出来的证据 + 期望状态 + hard contracts 一次性写清楚，让后续 implementation.md 的作者（codex）不必重新发现问题，只需写 W0-W? worker 划分 + 实施顺序 + 测试计划。
>
> **不在 H 范围**：v3 §5.1 列出的"留存项"——根因 4（产物可复用合同）/ O2（跨 device single-flight）/ O3（parent×child budget 联动）；这些是产品/架构决策级，需要独立 ADR，不属于尾巴清扫。

---

## 0. Context

### 0.1 audit 来源

2026-05-01 在 v3 全路线交付后实地 audit。3 个 Explore agent 各跑一条独立调查线（并发/race、stub/silent failure、CLAUDE.md vs 实际代码）；我 grep 验证了 explorer 报告里的所有具体声明，剔除掉 JS 单线程模型下不会真爆的理论风险（finalizeRun TOCTOU / Map iteration race / heartbeat timer race / hook handler 超时 promise 泄漏 / single-flight key hash collision 等）。

剩余的全部用 grep 证据支撑，**每条都有具体 file:line**。

### 0.2 v3 已交付，但发现了哪些事 v3 没顾上？

| v3 修了什么 | v3 没修什么（H 范围） |
|---|---|
| 词汇 invariant（A0）/ subagent 抽象（A1+B）/ coordinator（C）/ reminder+compaction+hook 骨架（D）/ atomic+GC+retry+admission（E）/ 测试规约+e2e（F）/ N1-N4+O7（G） | **CLAUDE.md §6.x 声明本身是否真实** |
| 各阶段 metric 注册到 `TOOL_ERROR_METRICS` registry | **几个 silent fallthrough catch{} 没人 metric** |
| 各阶段加新 timer 都配对 stop | **既有 timer 重入调用时是否 idempotent 没人挡** |
| F 阶段加 `ready/no-source-grep-test` rule | **rule 的逐行扫描可被 `function read()` 间接调用绕过** |
| v3 留存项（根因 4 / O2 / O3）显式 OUT | **HookRegistry 0 handler / LayeredCompactor L2 stub 何时由谁填没说** |

H 修补这些，但**不动 v3 已交付的合同**。

---

## 1. 范围 = 5 类根因 / 10 项

> 每项给出：**位置 + 证据 + 期望状态 + 不在 H 范围的相关项**。

### 根因 A — CLAUDE.md 声明与代码现状不符（**文档级失真**）

#### A1. F plan 提到 `ChildExecutionPermission`，生产文档的 permission context 措辞与代码不够对齐

**证据**：

```bash
$ grep -rn "ChildExecutionPermission" src/ CLAUDE.md AGENTS.md docs/
# src/：0
# CLAUDE.md / AGENTS.md：0
# docs/：6，其中 5 处来自本文档自身，1 处来自 F 阶段计划文档
```

**真相**：E 阶段 W4 的"explicit child-internal permission context" 是修辞，实际实装是把 `childInternal: true` boolean + 既有 `childInternalSkillAction` context 字段走 `executeSkillActionViaToolGateway`。`CLAUDE.md / AGENTS.md` 没有直接写 `ChildExecutionPermission` 类型名，但 §6.16 的"显式 child-internal permission context" 容易让后续实现者误以为存在正式类型。

**期望状态（二选一）**：

- **方案 A1-doc-only**：修 `CLAUDE.md / AGENTS.md` §6.16 措辞，改为描述实际机制（`childInternal` flag + `childInternalSkillAction` context + gateway path + tool-executor admission），避免暗示存在独立 permission 类型。
- **方案 A1-implement**：真实新建 `interface ChildExecutionPermission { isChildInternal: boolean; parentScopeId: string|null; parentSessionId: string|null; runtimeOwner: 'child-runner'; nestingDepth: number }`，把 runner 入口构造一次、显式传给 gateway。原 boolean + context 字段保留作 implicit fallback。

**推荐方案 A1-doc-only**：当下没有 caller 需要这个类型；半天文档修补 vs 半天类型实装+迁移，前者更贴合"尾巴清扫"语义。codex plan 阶段如选 A1-implement，必须给出"为什么 boolean + context 不够"的具体诱因，否则就是无意义抽象。

#### A2. §6.12 SHELL_ALLOWLIST 文档与代码不符

**证据**：

```bash
# CLAUDE.md §6.12 声明:
# "skill_run_shell 的命令白名单（Phase 1）：python / python3 / node / bash / sh / curl /
#   cat / ls / head / tail / grep / find / which / mkdir / pwd / echo / awk / sed /
#   yt-dlp / ffmpeg / ffprobe / scenedetect"

# src/main/modules/tools/skill-primitives/run-shell.ts:27-46 实际:
SHELL_ALLOWLIST = new Set([
  'python','python3','node','bash','sh','curl','cat','ls','head','tail',
  'grep','find','which','mkdir','pwd','echo','awk','sed',  // 18 个
])
# 不含 yt-dlp / ffmpeg / ffprobe / scenedetect
```

**真相**：这 4 个工具在生产里能跑只是因为 (a) `SkillsRuntimeManager.getRuntimeBinDir()` 把 runtime-bin/ + venv/bin 注入子进程 PATH（CLAUDE.md §6.12 末段已说明），(b) Python 脚本里间接 spawn `ffmpeg` / `yt-dlp` 不受 LLM-facing 白名单约束。LLM 直接调 `skill_run_shell({command:'ffmpeg ...'})` 会被白名单拒。

**额外发现**：`run-shell.ts:81` 的 `effectiveAllowlist` 参数允许 reference-skill 通过 `host_requirements.shell_allowlist_extensions` 扩展白名单 —— 这条机制 CLAUDE.md 完全没写。

**期望状态**：修 §6.12 / AGENTS.md §6.12，把 ALLOWLIST 列表改成实际 18 个，然后另起一段说明：
- yt-dlp / ffmpeg / ffprobe / scenedetect 通过 PATH 注入对 Python 脚本可达，但**不在 LLM-facing ALLOWLIST**。
- `effectiveAllowlist` 扩展机制 / `shell_allowlist_extensions` host requirement 怎么用。

#### A3. （新增防御）补 `scripts/check-claude-md-claims.cjs`

**根因**：A1 / A2 都是"文档夸大代码"形态。v3 路线建立了大量"代码必须满足合同"的 CI 强制（A0 词汇 / C coordinator isolation / D reminder rule / E atomic write / F 测试规约 / G status vocabulary），**唯独没建立"文档声明必须能在代码里找到对应 entity"的合同**。

**期望状态**：新建 `scripts/check-claude-md-claims.cjs`：

- 扫 `CLAUDE.md` / `AGENTS.md` §6.13-§6.18 的 backtick-quoted 标识符（建议正则匹配 `` `[A-Z][a-zA-Z]+` `` 类名 / `` `[a-z][a-zA-Z_]*` `` 函数名 / `` `READY_[A-Z_]+` `` env 变量名）。
- 每个标识符必须能在 `src/main/modules/` / `src/shared/` / `src/preload/` / `scripts/` 里 grep 命中（作为 export / function / const / env reader）。
- 不命中即报错：`<doc>:<line>: undefined identifier '<id>' — does not exist in code`。
- 白名单：自然语言里的常见词、UI 标签、日志字符串等不算 claim；rule 只识别 backtick + 标识符形态。

**验证**：CI 跑通 + 故意把 CLAUDE.md 加一条 `` `FakeNonexistentClass` `` → script 报错。

> codex plan 阶段如认为 A3 工时过大或假阳性多，可降级为 follow-up（**不阻塞 H 整体**），但 A1 / A2 必须修。

---

### 根因 B — Silent failure 缺观测面（**运维盲点**）

> 共同模式：`try { ... } catch { return raw/null/undefined }` + 0 metric / 0 log。caller 看到 fallback 值，运维 dashboard 看不到失败率。

#### B1 🔴. `secret-storage.ts` decrypt 失败静默 fallback

**证据**：

```ts
// src/main/modules/agent-control/secret-storage.ts:41-58
function decryptValue(raw: string): string {
  if (!raw) return raw
  try {
    if (raw.startsWith(ENC_PREFIX)) {
      const decrypted = safeStorage.decryptString(...)
      return decrypted
    }
    if (raw.startsWith(PLAIN_PREFIX)) { ... }
    return raw
  } catch {
    return raw    // ← raw 仍是 '<v1enc>...base64...' 形式
  }
}
```

**触发路径**：safeStorage 不可用 / OS keychain 重置 / encrypted blob 损坏。

**生产影响**：用户拿到 `<v1enc>iU3F2k...` 字符串当 API key 用 → 所有 LLM 请求 401 → UI 没有"key 已损坏" 提示，用户以为是 provider 问题。**真实 critical**。

**期望状态**：

1. catch 块内 `logAgentMetric(TOOL_ERROR_METRICS.secretDecryptFailed, { keyKind, errorKind: 'decrypt_threw'|'safe_storage_unavailable' })`。
2. 注册新 metric `secretDecryptFailed: 'secret_decrypt_failed'` 到 `TOOL_ERROR_METRICS`。
3. **决策**：catch 块返回什么？
   - 选项 1：保留 `return raw` 现状 + emit metric（向后兼容）。
   - 选项 2：返回 `null` 让 caller 显式处理（行为变化）。
   - 选项 3：throw 给 caller，由 channel config 加载层捕获并向 UI 推送"key 损坏"通知（行为变化最大但 UX 最好）。
   - **推荐选项 1 + 选项 3 组合**：H 范围内只做选项 1（加 metric，不变行为）；选项 3 留 follow-up，需要 UI 队配合。
4. CI 测试：mock decryptString throw → assert metric emitted + return value === raw。

#### B2. `skill-context-orchestrator.ts:355-368` reference SKILL.md 注入失败 0 metric

**证据**：

```ts
// src/main/modules/agent-control/skill-context-orchestrator.ts:355-368
for (const candidate of candidates) {
  if (!existsSync(absPath)) continue
  try {
    const raw = readFileSync(absPath, 'utf-8')
    return { text, basename, truncated }
  } catch {
    // Permission or read failure — try the next candidate, then fall
    // through to the tool-call path.
    continue
  }
}
return { text: null, basename: null, truncated: false }   // ← 0 metric
```

**对比**：成功路径在 line 292 / 324 emit `skill_reference_inlined` metric；**失败路径全部 0 metric**。运维只能看到"成功的 inline 数"，看不到"尝试 inline 但失败的数"，分不清失败率。

**期望状态**：候选全部失败、最终返回 `{ text: null }` 时 emit `skillReferenceInlineFailed: 'skill_reference_inline_failed'` metric，包含 `{ skillId, candidateCount, lastError? }`。注册到 `TOOL_ERROR_METRICS`。

#### B3. `skill-running-projection.ts:94 / 103 / 169` 静默 fallthrough

**证据**：

```ts
// L94: function safeStat(path)         catch { return null }
// L103: extractRunStateSummary parse    catch { return null }
// L169: readdirSync depth-walk          catch { return }
```

**触发**：stat / JSON.parse / readdirSync 任一失败。caller 拿到 partial null，**分不清"file missing" / "permission denied" / "malformed JSON"**。child-run 状态投影静默不完整。

**期望状态**：3 处 catch 各自 emit 独立 metric（或共享一个 metric + `kind` 字段区分）：
- `skill_projection_stat_failed`
- `skill_projection_parse_failed`
- `skill_projection_readdir_failed`

或合并为单一 `skillProjectionPartial: 'skill_projection_partial'`，payload 含 `{ phase: 'stat'|'parse'|'readdir', path, errorKind }`。**推荐合并形态** —— dashboard 只需一行就能看到投影完整度。

#### B4. `run-state-selection.ts:135` readdirSync 失败默默跳过

**证据**：

```ts
// src/main/modules/agent-control/run-state-selection.ts:135
let entries: Dirent[]
try {
  entries = readdirSync(dir, { withFileTypes: true })
} catch {
  return    // ← 0 metric, 整个子树扫描跳过
}
```

**期望状态**：emit `runStateSelectionDirSkipped: 'run_state_selection_dir_skipped'` metric，payload 含 `{ dir, errorKind }`。

#### B5（共享合同）— silent fallthrough 必带 metric

**根因**：A0/E 都做了 metric registry，但**没立"凡 catch{} silent return 必须 emit metric"的合同**。B1-B4 是同形态债的 4 个投影。

**期望状态（CI 强制）**：新建 `scripts/check-silent-catch.cjs`：

- 扫 `src/main/modules/agent-control/` + `src/main/modules/skills-runtime/` + `src/main/modules/tools/`。
- 找 AST 上所有 `try { ... } catch (...) { ... }` 块，块体不调 `logAgentMetric` / `console.error` / `console.warn` / 不 throw / 不 fall through 到任何 logger 的，**视为 silent catch**。
- silent catch 必须配 `// silent-catch: <reason>` 注释明确豁免理由（如 "best-effort metric, never fail caller"）。
- 既有 silent catch 进 baseline；新增 0 条。

**这是 H 引入的唯一新 CI rule**，性质与 F-Contract-2 `ready/no-source-grep-test` 同形态。

---

### 根因 C — v3 留下的显式 deferred 项（**计划内空白，无 owner**）

> 不是 bug，是 v3 留的"由后续 PR 填"但**没明确何时由谁触发**的空格子。H 不实装，但**必须明确"何时算需要触发"的判定标准**。

#### C1. HookRegistry 0 个生产 handler — 触发标准

**现状**：grep `register('pre_tool_use'|'post_tool_use'|'user_prompt_submit'|'stop'` → 全仓 0 命中（除 D 阶段单测）。`turn-engine.ts` 在 user message 进来前 fire `'user_prompt_submit'`，永远 no-op。

**期望状态**：在 CLAUDE.md §6.15 末尾追加 1 段"hook handler 何时该填"：

> Hook handler 的注册由具体 telemetry / observability / audit 需求驱动，没有 default handler 是合规设计。引入新 handler 的标准：(a) 该 handler 解决的需求**当前用 metric / log 无法满足**；(b) handler 必须 idempotent（fire 失败不能让 turn 挂掉）；(c) handler 必须有独立测试 + 在 PR 描述里写明"为什么 metric/log 不够"。**禁止把 hook 当 logging 替代品**。

#### C2. LayeredCompactor L2 算法 — 触发标准

**现状**：默认 `l2Threshold = 0` → L2 不触发。stub `compactL2Stub` throw "not implemented"，由 circuit breaker 兜住，连续 3 次失败永久 break。

**期望状态**：在 CLAUDE.md §6.15 末尾追加 1 段"L2 何时该实装"：

> L2 实装的触发条件：(a) 生产中观察到 L1 后 messages 仍超 model context window 的实例 ≥ N 次/周（N 由当时观察决定，先不预设）；(b) 有用户报告"模型说"我已经忘了上文""的样本。**触发后 land 必须配 e2e 测试覆盖 L2 in-loop 正确性，circuit-break 行为不变**。

#### C3. v3 留存项（根因 4 / O2 / O3）— 不在 H 范围

明确写入 H 文档"out-of-scope"段；H 不动。**但**：在 `docs/superpowers/plans/2026-04-30-skill-runtime-residual-architectural-debt.md` §6 优先级矩阵末尾追加一段，标这 3 项为"待独立 ADR，无 owner"，提醒未来 PR 触发它们时**先开 ADR 不要直接动代码**。

---

### 根因 D — Timer / 资源生命周期 idempotency

#### D1. `startReferenceHintSweep` / `startOutputDirSweep` 没 idempotency guard

**证据**：

```ts
// src/main/modules/skills-runtime/runtime-manager.ts:471-487
private startReferenceHintSweep(): void {
  // 不检查 this.referenceHintBootTimer / this.referenceHintIntervalTimer 是否已存在
  this.referenceHintBootTimer = setTimeout(...)      // ← 重入调用泄漏前组
  this.referenceHintIntervalTimer = setInterval(...)
}
// startOutputDirSweep (line 520-527) 同形态
```

**触发概率**：今天 `start()` 仅 boot 时一次调用，**未爆**。但如果未来 settings hot-reload / 测试 fixture 重入 / 错误恢复路径调 start()，会泄漏。

**期望状态**：

```ts
private startReferenceHintSweep(): void {
  if (this.referenceHintBootTimer || this.referenceHintIntervalTimer) {
    // already running; idempotent no-op
    return
  }
  // ... existing setup
}
```

`startOutputDirSweep` 同改。**不需要新 metric** —— idempotent guard 是防御性，正常路径不触发。

---

### 根因 E — 测试反模式残余

#### E1. `src/__tests__/active-child-run-ipc.test.ts` source-grep 通过 `read()` 间接调用绕过 F lint

**证据**：

```ts
// src/__tests__/active-child-run-ipc.test.ts (G 阶段加)
function read(path: string): string {
  return readFileSync(resolve(root, path), 'utf8')   // ← F lint 逐行扫描看不见 read()
}
test('active child run IPC surface stays wired ...', () => {
  const ipc = read('src/main/modules/claude-bridge/ipc-handler.ts')
  assert.match(ipc, /agent:listActiveChildRuns/)    // ← 27 个断言，全部 source-grep
  ...
})
```

**问题**：(a) 100% 与 `scripts/check-child-control-ipc.cjs` 的 27 patterns 重合，**纯冗余**；(b) F testing-conventions.md 反模式；(c) F lint rule 没抓到（间接调用），是 F rule 的盲点。

**期望状态**：

- **方案 E1-delete**：直接删除该测试文件。所有 IPC parity 检查由 `check-child-control-ipc.cjs` 覆盖；renderer behavior 由 dev preview mocks（已存在）+ 手测覆盖。
- **方案 E1-rewrite**：用 React Testing Library mount `<ActiveChildRunsDebug />` + mock electronAPI + click 取消按钮 + assert mock IPC 被调。这是 F testing-conventions.md 提倡的真行为测试。

**推荐方案 E1-delete**：rewrite 需要 RTL 接入 + Electron API mock 框架，工时与价值不匹配；删除 + 增强 cjs 即可（cjs 已经足够）。**codex plan 阶段如倾向 rewrite，必须先 grep 全仓有没有既有 RTL 接入，否则就是为这一个测试引入新依赖**。

#### E2. F lint 的 `function read()` 间接调用盲点 — 是否补强

**根因**：F 的 `ready/no-source-grep-test` rule 是逐行 AST 扫描，看不见跨函数 indirection。E1 的 evasion 模式（`function read() { return readFileSync(...) }`）不会被识别。

**期望状态**：

- **方案 E2-tighten-rule**：扩展 lint rule，把"在 `__tests__/` 内定义、内部调 readFileSync(<*.ts>) 的辅助函数"也识别为反模式。**实施代价**：rule 复杂度 +50%，假阳性风险高（很多正当辅助函数会被误伤）。
- **方案 E2-skip**：不动 rule，依靠 E1 修复 + 未来 review 抓取。F testing-conventions.md 已有反模式描述。

**推荐方案 E2-skip**：F rule 已经是 "best-effort"，进一步收紧成本远高于收益；E1 删除后这条逃生通道关闭。codex plan 阶段如选 E2-tighten-rule，必须给假阳性测试 case 验证。

---

## 2. 显式 out-of-scope

不在 H 范围，留给独立 PR / ADR / 长期决策：

- **根因 4（产物可复用合同）**：`findReusableRunByKey` 设计 / RSS timeout 后重跑相同视频。需要独立 ADR + 跨 RSS 团队协调。
- **O2（跨 device single-flight）**：用户跨设备续跑长任务。产品决策级，需 UX 确认。
- **O3（parent × child budget 联动）**：监控精度问题，量级未到生产爆炸阈值。
- **C1 真实 hook handler 实装**：等 telemetry 需求驱动；H 只补"何时填"判定标准。
- **C2 LayeredCompactor L2 算法**：等观察样本累积；H 只补"何时填"判定标准。
- **B1 选项 3（UI 推送 key 损坏通知）**：需 UI 队配合，独立 PR。
- **F lint 跨函数 indirection 防御**（方案 E2-tighten-rule）：成本不匹配。
- **既有 142 条 source-grep baseline 全量 cleanup**：F-Contract-6 已显式明确"baseline 冻结，不全量清"，H 也不动。
- **任何引入新抽象层 / 新合同 / 新阶段命名**：H 是尾巴清扫，**禁止 scope 蔓延到新架构方向**。

---

## 3. Hard Contracts（CI 必须可机器验证）

> 实施 plan 阶段必须把这些落实到具体测试 / 脚本 / lint。

### H-Contract-1（A1 / A2 / A3）：CLAUDE.md 文档真实性

- §6.13 / §6.12 文字与代码现状一致（A1 / A2 修文档完成）。
- `scripts/check-claude-md-claims.cjs` 存在并通过。故意在 CLAUDE.md 加 `` `FakeClass` `` → 报错。
- baseline：A3 实施时记录当前 CLAUDE.md / AGENTS.md 中 N0 个 backtick 标识符全部命中。

### H-Contract-2（B1-B5）：silent failure 全部带 metric + CI 防新增

- B1-B4 共 4 处 catch 全部 emit 对应 metric（注册到 `TOOL_ERROR_METRICS`）。
- `scripts/check-silent-catch.cjs` 存在并通过。新增 silent catch 必须配 `// silent-catch: <reason>` 豁免注释。
- baseline：当前 silent catch 数（W0 audit 报告时给出 N）冻结，新增 0 条。
- 至少 4 条单元测试覆盖 B1-B4 的 metric emit 行为（trigger error → assert metric called）。

### H-Contract-3（C1 / C2）：deferred 项判定标准成文

- CLAUDE.md §6.15 / AGENTS.md §6.15 末尾各追加 1 段（hook handler 何时填 / L2 何时填）。
- `docs/superpowers/plans/2026-04-30-skill-runtime-residual-architectural-debt.md` §6 末尾追加"无 owner 留存项 ADR 触发条件"段。
- 不需要新 CI 校验（这是文字规约，靠 review 强制）。

### H-Contract-4（D1）：timer idempotency

- `startReferenceHintSweep` / `startOutputDirSweep` 重入调用是 no-op（不泄漏 timer）。
- 单元测试覆盖：连续调 2 次 start → 仅 1 组 timer 注册。
- 不需要 lint rule（点状修改）。

### H-Contract-5（E1）：删除 source-grep 反模式测试 + cjs 强化

- `src/__tests__/active-child-run-ipc.test.ts` 删除（或按方案 E1-rewrite 改为 RTL 行为测试）。
- 删除后 `scripts/check-child-control-ipc.cjs` 检查项加强到不弱于原测试（27 patterns 至少保留）。
- F-Contract-6 baseline N0=142 不变（删除该 test 不增不减 baseline，因为它本身没进 baseline，是用 indirection 绕过去的）。

### H-Contract-6：A0/A1/B/C/D/E/F/G 不退化 + verify:h 绿

- `verify:h` 内嵌 `verify:g`（→f→e→d→c→b→a*）。
- H 自有 gates：`check-claude-md-claims.cjs`、`check-silent-catch.cjs`、加 4 条 metric 单测、加 timer idempotency 单测。

### H-Contract-7：H 范围内不引入新抽象层

- 不新建 `*-registry.ts` / `*-coordinator.ts` / `*-context-builder.ts` 类。
- 不修改 `verify:a*-g` 任一阶段的合同（仅追加 H 自己的 gate）。
- 不引入 ESLint hard rule（cjs 脚本 + baseline 形态足够）。

---

## 4. 已知风险与边界

### 4.1 A1 选 doc-only vs implement 的 trade-off

doc-only：0.5 天，无代码风险；但留下"如果未来真需要 ChildExecutionPermission 类型时"的开放问题。
implement：1 天，需 W4 在 E 范围之外加新代码路径；valid 但**违反"不引入新抽象层"H-Contract-7**。

**结论**：H 强制选 doc-only。如未来真需要类型，独立 PR 不属于 H。

### 4.2 B1 选项 1 加 metric 不变行为可能让用户感觉"系统更不稳"

观测面打开后，dashboard 上会出现以前看不到的失败率。这**不是回归**，是把已存在的失败显出来。运维同事需要被告知：B1 metric 的 baseline 不为 0 不是 H 引入的 bug。

**缓解**：H 阶段 docs 同步段写明"B1-B4 metric 数据为已存在但之前不可观测的失败，不代表 H 引入新 bug"。

### 4.3 silent-catch 检查脚本的假阳性风险

`scripts/check-silent-catch.cjs` AST 扫描"catch{}+无 logger 调用"模式可能假阳性高（如 best-effort cleanup / 恢复路径）。codex plan 阶段必须：

1. 先在 W0 audit 给出当前命中数 N。
2. 评估 N 个里有多少是真正"应该加 metric"的，多少是"合理 silent"。
3. 合理 silent 的批量加 `// silent-catch: <reason>` 注释，不强制改 catch 内容。
4. baseline 设为 N（含合理 silent），新增 0。

如 N > 50 → 工时风险，codex 需在 plan 里说明是否拆 H1 / H2 两阶段。

### 4.4 D1 idempotency guard 可能掩盖真实 race

idempotent guard 让重入调用变 no-op，但**如果未来有 bug 真的需要"重启 sweep"语义**，guard 会让 caller 困惑。

**缓解**：guard 同时 log warning（`console.warn('startReferenceHintSweep called while already running; ignored')`），让未来调试者看得到。**不发 metric**（防御性 log 即可，metric 留给真实 catch 路径）。

### 4.5 H 工期估算

| 项 | 估算 | 串行/并行 |
|---|---|---|
| A1 / A2 修文档 | 0.5 天 | 并行 |
| A3 check-claude-md-claims.cjs + 接 verify:h | 0.5 天 | 串行（依赖 A1/A2） |
| B1-B4 加 metric + 单测 | 1 天 | 并行（独立文件） |
| B5 check-silent-catch.cjs + baseline | 0.5-1 天 | 串行（依赖 B1-B4） |
| C1 / C2 文档 | 0.25 天 | 并行 |
| C3 残债文档追加 | 0.25 天 | 并行 |
| D1 idempotency guard + 单测 | 0.5 天 | 并行 |
| E1 删测试 + 强化 cjs | 0.25 天 | 并行 |
| docs sync + verify:h gate + final record | 0.5 天 | 末尾 |

**总工时**：约 3-4 天（并行后）。比 G（2-3 天）略大，因为 silent-catch 脚本可能假阳性多。

---

## 5. 留给 codex implementation.md 的开放问题

codex 写实施计划时必须明确决策的事项（不要再问，自己决定 + 在 plan 里说明理由）：

1. **W0 audit 报告**：N0 数字（CLAUDE.md backtick 标识符数 / silent catch 数）落实，决定 baseline。
2. **A1 选 doc-only**（强制，H-Contract-7 已规定不引入新抽象）。
3. **A3 check-claude-md-claims.cjs 假阳性策略**：如 N0 > 30 且其中假阳性率 > 30%，可降级为 "soft check"（warning 而非 error）；codex 自决。
4. **B1 选项 1 加 metric**（H 强制；选项 3 UI 推送独立 PR）。
5. **B3 合并形态**：4 处 catch 用 1 个 metric + `kind` 字段还是 4 个独立 metric？codex 自决，建议合并。
6. **B5 baseline 大小评估**：如 N > 50 → 拆 H1（A+B1-B4+D1+E1，不含新 cjs）/ H2（B5 + A3 两个新 cjs）两阶段实施；codex 在 W0 audit 后决定。
7. **E1 选 E1-delete**（推荐；选 E1-rewrite 必须先 grep 现有 RTL 接入，没有就强制 delete）。
8. **W 划分**：建议 W0(audit) → W1(A1-A2 文档) → W2(A3 cjs) → W3(B1-B4 metric) → W4(B5 cjs) → W5(C+D+E 收口) → W6(verify:h + docs)。codex 可调整。
9. **Subagent 分配**：参 G 阶段形态，建议 Hubble W0+W6、Avicenna A 系列、Erdos B 系列、Darwin / Hume / Noether 各承一项。codex 自决。
10. **verify:h chain**：内嵌 `verify:g`（v3 路线最末），**不**新建 verify chain。

---

## 6. 文档维护

- H 完成后更新本文档 `status: completed` + 加 Final Record 段。
- 路线图 `docs/archive/2026-09-06/docs/superpowers/plans/2026-04-30-skill-runtime-agent-layer-reframe.md` §5.1 末尾追加 H 行（**标记为"v3 路线尾巴清扫"，不是 v4**）。
- residual-debt 文档 §6 末尾按 C3 要求追加无 owner 留存项段。
- 如 W0 audit 发现本文档 §1 任一项数字偏离（grep 命中数与文档不符），**优先修本文档** —— 跟 D-G 阶段同一规约。
- 如 audit 发现新的"不属于 v3 留存项也不在 H 列出"的债 —— 列入"H 后续 follow-up"段，**不**塞进本计划。

---

## 7. 与战略原则的对照

`CLAUDE.md §0.5` 5 条 + 升维 2 条原则在 H 的应用：

1. **先合同，后代码**：§3 给 7 条 hard contract，每条 CI 可机器验证（cjs 脚本 / 单测 / baseline）。
2. **修根因，不修症状**：A 系（文档 vs 代码）、B 系（silent catch）都是根因聚类，不是单点补丁。A3 / B5 两条新 CI 防止同形态债再生。
3. **拒绝 legacy 兼容分支**：H 不留 legacy fallback。`secret-storage.ts` catch 改为 emit metric + 保留行为，**不**双轨支持"老不 emit / 新 emit"。
4. **形态意识**：H 是尾巴清扫的形态 —— 加 metric / 修文档 / 加 idempotency guard，**不**引入新抽象。如 codex plan 阶段倾向引入新抽象，违反此原则。
5. **CI 强制 > 文档约束 > 人审**：A3 / B5 两条新 cjs 是 CI 强制；C1 / C2 / C3 三条只能靠文档（因为是判定标准而非可校验事实）。
6. **抽象的边界 = 形态的差异**：H 不引入新抽象。
7. **重新做一遍优于继续打磨**：本条不适用 —— H 是打磨现有抽象的尾巴，不是重做。

---

## 8. 给 codex 的执行摘要

> 这份文档是 counter-proposal，**你需要据此另写一份 implementation.md**（命名建议 `2026-05-02-H-v3-tail-debt-closeout-implementation.md`）。
>
> **必读**：
> - §1 全部 10 项及证据（每条 grep 输出 + file:line 已给出，不要重新发现）。
> - §3 7 条 hard contracts —— 每条必须机器可验证。
> - §5 10 个开放问题 —— 你必须自决并写明理由。
>
> **必做**：
> - W0 pre-flight audit 报告（参 D-G 阶段形态）：grep 验证 §1 全部数字 + 给出 N0 baseline + 决定 §5 全部开放问题。
> - implementation.md 包含 Worker 划分、land 顺序、测试计划、验证步骤、Risk + Mitigation、Final Record 段（land 后填）。
> - 实施完成后回 ping，我审 implementation.md → 接受 / 修订 → 你执行 → 我审实施 + commit。
>
> **不允许**：
> - 引入新抽象层 / 新阶段命名（H 不是 v4 起点）。
> - scope 蔓延到 §2 out-of-scope 列表。
> - 修改 v3 路线 A0-G 任一阶段的合同。
> - 用 try/catch 掩盖 H 阶段引入的回归。
>
> **三类 ESCALATE 条件硬执行**：
> 1. W0 audit 发现 §1 任一证据数字与文档严重偏离（>30% 差异）→ 修文档不修代码。
> 2. B5 silent-catch baseline N0 > 50 → 拆 H1 / H2 两阶段，不强行单 PR 落地。
> 3. A3 check-claude-md-claims.cjs 假阳性率 > 30% → 降级为 soft warning 或推迟到独立 follow-up PR。

---

## Final Record — 2026-05-02

H 已按 H1 / H2 两段落地，未引入 v4 新抽象，未修改 A0-G 既有合同。

- Verification HEAD: `e0916f3bd3658c79d35b3b9365ef191cfcdd380f`
- Final gate: `npm run verify:h` exited 0.
- `verify:h` chain: `verify:g` -> `test:h:gates` -> `test:h:focus`.
- Final focused counts observed in `verify:h`: G focus 54 tests passed / 0 failed; H gates 9 tests passed / 0 failed.
- Doc claim gate: `CLAUDE.md claims: ok`; fake-claim regression is covered by `check-claude-md-claims.test.cjs`.
- Silent catch gate: `silent catch: ok (198 baseline entries)`; bare-catch regression is covered by `check-silent-catch.test.cjs`.
- Baseline: W0 broad silent-catch candidate range was 204-248; W4 AST gate froze `N0 = 198`, `N_FINAL = 198` with `{ file, line, snippetHash }` entries.
- H1 / H2 split: H1 landed documentation truth, B1-B4 metrics, timer idempotency, and active-child-run behavior test cleanup; H2 landed doc-claim and silent-catch gates plus final docs.
- H post-follow-up: the local `errorKind(error: unknown): string` helper remains duplicated in four H1-touched files by design, to avoid adding a shared abstraction inside H. A later non-H cleanup PR may extract it.
