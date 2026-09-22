---
enforce: false
archived_at: 2026-09-06
archive_reason: superseded-project-documentation
---

> 已归档（2026-09-06）：本文保留编写当时的设计、状态与证据，不是当前执行入口；归档不表示原计划全部实现。现行说明见 [当前运行时合同](../../../../architecture/current-runtime-contracts.md)，去向见 [文档清单](../../../../documentation-inventory.md)。

# Stage 5 — Test-coverage hard gates (Plan v3)

> 上一版: plan-v2.md (Codex round-2 NACK)。  
> v3 变更原因: 修 round-2 的 4 条 new issue。重点：(a) C3 字面量扫改为只识别 load 形态——`require('better-sqlite3') / from 'better-sqlite3' / await import('better-sqlite3')`；(b) C4 transitive 滤掉 `import type` 并新增 per-file exemption；(c) wiring DAG 修正——v2 错说 `verify:j` 链含 `verify:native`，实际不含；(d) 删 Sanity D 改 unit test 覆盖。

---

## 0. 不变量 (合同) — v3 收紧

```ts
const TEST_EXTENSIONS = [
  'src/__tests__/**/*.test.ts',
  'src/__tests__/**/*.e2e.ts',
  'eslint-rules/__tests__/**/*.test.{mjs,ts}',
  'scripts/__tests__/**/*.test.cjs',
] as const;

// v3 新增 — 严格 load 形态（不接受字符串字面量在 assert 里）
const SQLITE_LOAD_FORMS = [
  /\brequire\(\s*['"]better-sqlite3['"]\s*\)/,
  /\bfrom\s+['"]better-sqlite3['"]/,
  /\bawait\s+import\(\s*['"]better-sqlite3['"]\s*\)/,
] as const;
```

- **C1 (orphan-coverage)** — 与 v2 一致。
- **C2 (no-silent-failures)** — 与 v2 一致 (基于 `npm run test`)。
- **C3 (sqlite-direct-skip) — v3 收紧**：测试文件命中 **`SQLITE_LOAD_FORMS` 任一正则** 时（不是任意 `'better-sqlite3'` 字面量），必须用 canonical helper `skipIfSqliteUnavailable(t, label)`。`database.test.ts:155` 那种 `assert.match(databaseModule, /require\('better-sqlite3'\)/)` 不会被 SQLITE_LOAD_FORMS 命中（被 regex 内嵌字面量逃过载入形态判定）→ 不受 C3 约束。
- **C4 (sqlite-transitive-skip) — v3 收紧**：测试文件**通过 value import**（不是 `import type`）到达任一 `nativeBackedModules` 成员，且文件未在 `c4Exempt` 列表里登记，则必须用 helper。
- **C5 (CI-enforced-not-documented) — v3 修正**：
  - 新 gate (`check-test-coverage-by-verify.cjs` / `check-sqlite-test-skip-pattern.cjs`) 都是 **STATIC**，不依赖 Electron / native runtime。
  - 三处 CI 入口必须都跑 orphan gate：top-level `verify`、`verify:k`、`verify:cloud`。
  - 不重复运行 `verify:native`（top-level `verify` 与 `verify:cloud` 各跑一次；`verify:k` 不跑 native，因为静态 gate 不需要）。

> v2 误述："verify:j 链已含 native:check" → **错误**。实际 `verify:j → verify:i → ... → verify:b` 这条链全部是静态 check，没有任何 `npm run rebuild:native` / `npm run native:check` / `npm run verify:native`。v3 修正为：static gates 与 native runtime check 是两个独立维度，由不同入口承担。

---

## 1. 任务清单

### Task 1 · 删除孤儿测试 (无变更)
同 v2。

### Task 2 · `verify:k` orphan-coverage 硬门 — v3 仅修接线段

(算法 / 单测 / 豁免 schema 与 v2 一致，不再赘述)

**接线 — v3 修正版**：

```jsonc
// package.json scripts:
{
  "verify:k": "npm run verify:j && node scripts/check-test-coverage-by-verify.cjs && node --test scripts/__tests__/check-test-coverage-by-verify.test.cjs && node scripts/check-sqlite-test-skip-pattern.cjs && node --test scripts/__tests__/check-sqlite-test-skip-pattern.test.cjs",

  "verify": "npm run verify:native && npm run typecheck && npm run lint:check && node scripts/check-test-coverage-by-verify.cjs && node scripts/check-sqlite-test-skip-pattern.cjs && npm run test",

  "verify:cloud": "npm run rebuild:native && npm run typecheck && npm run lint:check && node scripts/check-test-coverage-by-verify.cjs && node scripts/check-sqlite-test-skip-pattern.cjs && npm run test"
}
```

**修正点**：
1. v2 仅在 top-level `verify` 插了 orphan gate，**漏了** `verify:cloud`。v3 同时插。
2. v2 在 top-level `verify` 没插 sqlite-skip gate（只插 orphan）；v3 把两个 gate 都插到三个入口（`verify` / `verify:k` / `verify:cloud`），保证一致性。
3. v2 错说"verify:j 链已含 native"。v3 修正：static gates 在 `verify:k` 跑（无 native 依赖）；native check 仍归 `verify:native`，由 `verify` / `verify:cloud` 各自一次拉起。

**DAG (v3 准确版)**：

```
verify (top)        ─→ verify:native (rebuild + native:check) ─→ typecheck ─→ lint ─→ orphan gate ─→ sqlite-skip gate ─→ npm run test
verify:cloud        ─→ rebuild:native               ─→ typecheck ─→ lint ─→ orphan gate ─→ sqlite-skip gate ─→ npm run test
verify:k            ─→ verify:j (static chain)                                          ─→ orphan gate ─→ sqlite-skip gate
verify:j → ... → verify:b 链路：纯静态 (typecheck / lint / 各 area gates / focus tests)，不含 native
```

每个 gate 在每条入口至多跑 1 次；orphan + sqlite-skip 在 `verify` / `verify:cloud` / `verify:k` 各跑 1 次（静态 < 200ms）。`verify:native` 仅在 `verify` 与 `verify:cloud` 跑。

### Task 3 · sqlite skip 规范化 — v3 收紧检测

#### 3a · canonical helper — 与 v2 一致

```ts
// src/__tests__/utils/sqlite-skip.ts
export type SqliteSkipReason = 'native_abi_host_mismatch' | 'binding_missing' | 'sqlite_runtime_error';

export function skipIfSqliteUnavailable(
  t: TestContext,
  label: string,
  probe: () => void = defaultProbe,
): boolean {
  try { probe(); return false; }
  catch (error) {
    const reason: SqliteSkipReason =
      (error as NodeJS.ErrnoException)?.code === 'ERR_DLOPEN_FAILED' ? 'native_abi_host_mismatch'
      : (error as NodeJS.ErrnoException)?.code === 'MODULE_NOT_FOUND' ? 'binding_missing'
      : 'sqlite_runtime_error';
    t.skip(`[ABI-SKIP][${reason}] ${label}: ${(error as Error).message}; covered by npm run verify:native`);
    return true;
  }
}
```

#### 3b · `nativeBackedModules` 索引 — v2 算法不变 + v3 显式 type-only 排除

```pseudocode
nativeBackedSeed = [
  'src/main/modules/database.ts',
  'src/main/modules/db-worker.ts',
]
nativeBackedModules = grep_lr "better-sqlite3" src/main src/shared src/preload  ∪  nativeBackedSeed
                     // 索引模块本身的 import-graph 不再深挖；测试侧 BFS 时遇到这些路径就算命中
```

#### 3c · `check-sqlite-test-skip-pattern.cjs` — v3 大改

```pseudocode
// v3 直接 hit (替代 v2 的 raw_text 字面量包含)
function isDirectSqliteLoader(testFile):
  src = readFile(testFile)
  return any(rgx.test(src) for rgx in SQLITE_LOAD_FORMS)
  // 这一步过滤掉 v2 误伤：assert.match(databaseModule, /require\('better-sqlite3'\)/)
  // 中的 'better-sqlite3' 字面量在 regex 字面量内部，没有 \brequire(\s*['"] 前缀，
  // SQLITE_LOAD_FORMS[0] 不会命中。

// v3 transitive (替代 v2 的"任意 import 即视为命中")
function bfs_value_imports(testFile, depth=6):
  // 仅追 value import，剔除 type-only。
  // 形态识别：
  //   * `import type ... from '<p>'`        → 跳过
  //   * `import { type X, Y } from '<p>'`   → 当作 value import (有 Y)
  //   * `import { type X } from '<p>'`      → 跳过 (整组都是 type-only)
  //   * `import('<p>')`                     → value import
  //   * `require('<p>')`                    → value import
  // 仅追相对路径；解析 .ts / .tsx / .mts / .cts，realpath + path.posix.normalize。

function reachesNativeBackedModule(testFile):
  graph = bfs_value_imports(testFile)
  return any(m in nativeBackedModules for m in graph)

c4Exempt = JSON.parse('scripts/test-coverage-exemptions.json').c4Exempt
violations = []

for testFile in TEST_EXTENSIONS expanded:
  direct  = isDirectSqliteLoader(testFile)
  transit = reachesNativeBackedModule(testFile) and not (testFile in c4Exempt)
  if not (direct or transit): continue

  // 若文件在 c4Exempt 但 direct 命中 → 仍要 helper (C3 不可豁免)
  if not has_skip_helper_call(testFile):
    violations += { file: testFile, kind: 'missing_helper', reason: direct ? 'C3-direct' : 'C4-transitive' }
  for testBlock in find_outer_test_blocks(testFile):
    if not testBlock.has_helper_invoke_within_first_4_lines():
      violations += { file: testFile, kind: 'unguarded_block', block: testBlock.line }

if violations: 列出 + exit 1
```

**`c4Exempt` schema**（`test-coverage-exemptions.json` 内并列于 `exempt`）：
```json
{
  "schemaVersion": 1,
  "exempt": [...],
  "c4Exempt": [
    {
      "path": "src/__tests__/database-readiness.test.ts",
      "reason": "fake-injection only; tests assertDatabaseConnectionReady / assertPrimaryDatabaseReady with synthetic DatabaseConnection — never triggers lazy require('better-sqlite3') in database.ts",
      "since": "2026-05-06",
      "owner": "agent-runtime"
    },
    {
      "path": "src/__tests__/session-recall-service.test.ts",
      "reason": "import type only from database.ts; SessionRecallService receives FakeSessionRecallDb adapter",
      "since": "2026-05-06",
      "owner": "agent-runtime"
    }
  ]
}
```

**单测最少覆盖**（v3 新增 6/7/8）:
- T1 仅 direct (load 形态命中) → violation。
- T2 仅 transitive (value import → nativeBackedModules) → violation。
- T3 direct + helper → pass。
- T4 transitive + helper → pass。
- T5 transitive + 文件在 `c4Exempt` → pass。
- T6 direct + 文件在 `c4Exempt` → 仍 violation（C3 不可豁免）。
- T7 测试 `import type` 不触发 transitive 命中。
- T8 测试 `import { type X, Y } from '...'` 混合形态——只要有非 type 导入即视为 value import。
- T9 `assert.match(src, /require\('better-sqlite3'\)/)` 这种字符串内嵌不命中 SQLITE_LOAD_FORMS。
- T10 cycle import 不死循环。

#### 3d · 改造现有违规 — v3 表

| 文件 | v3 处理 | 理由 |
|---|---|---|
| `migrations-drop-skill-executions.test.ts` | 改 helper | C3 direct |
| `skill-task-run-repository.test.ts` | 改 helper | C3 direct |
| `skill-child-runner.test.ts` | 改 helper | C3 direct |
| `database-pragmas.test.ts` | 收编 helper | C3 direct (现已用 t.skip) |
| `single-file-link-resolve.test.ts` | 收编 helper | C3 direct |
| `db-worker.test.ts` | 收编 helper | C3 direct |
| `chat-message-persistence.test.ts` | 收编 helper | C3 direct |
| `database.test.ts` | **不动** | regex 字符串字面量；C3 不命中（v3 收紧后） |
| `prompt-assembly-memory-create-insert.test.ts` | 待确认 | gate 跑一次后看是否 C3 / C4 命中再决定 |
| `database-readiness.test.ts` | **登记 c4Exempt** | fake injection only |
| `session-recall-service.test.ts` | **登记 c4Exempt** | fake injection only |

> 不靠人工列表兜底；以 gate 实际报错列表为真值。表格用于 PR 自检与初次构造 c4Exempt。

#### 3e · 接线 — 见 Task 2 接线段（已合并三处入口）

### Task 4 · 文档同步

- `docs/superpowers/testing-conventions.md` 追加 §"Stage 5 covenants"：
  - 5 条合同 (C1–C5) 文字版。
  - `[ABI-SKIP][<reason>]` token schema 与 reason 取值表。
  - DAG 图（v3 准确版）。
- `CLAUDE.md` §6.17 末尾追加：
  > Stage 5 起 verify:k / verify / verify:cloud 强制 orphan-coverage、sqlite-direct-skip、sqlite-transitive-skip 三件事；新增测试必须出现在某 verify:* / test:* 入口或显式豁免；接触 sqlite (load 形态直接 require/import 或 value import 经 nativeBackedModules) 必须用 `skipIfSqliteUnavailable` helper；C4 间接路径在确认仅用 fake 注入时可登记 `c4Exempt`。
- `AGENTS.md` 同步同段落。

### Task 5 · 验收 — v3 删 Sanity D + 加 unit-test 路径覆盖

1. `npm run verify:k` 全绿。
2. `npm run verify:j` 仍全绿（向后兼容）。
3. `npm run verify` 全绿。
4. `npm run verify:cloud` 全绿（v3 新增）。
5. **Sanity A (orphan)**: 临时新建 `src/__tests__/__orphan_probe.test.ts` → `verify:k` 失败 → 删除 → 通过。
6. **Sanity B (silent skip)**: 临时把 `skill-task-run-repository.test.ts` 一处 helper 退回 `console.warn` → gate 报 missing_helper → 还原。
7. **Sanity C (transitive)**: 临时新建 `src/__tests__/__transitive_probe.test.ts` 仅 `import { someValue } from '../main/modules/database'` → gate 报 C4-transitive → 删除。
8. **Sanity D (type-only)**: 临时新建 `src/__tests__/__type_only_probe.test.ts` 仅 `import type { X } from '../main/modules/database'` → gate 不报错（确认 type-only 滤过）→ 删除。
9. **Sanity E (regex literal)**: 临时新建 `src/__tests__/__regex_probe.test.ts` 仅含 `assert.match(s, /require\('better-sqlite3'\)/)` → gate 不报错（确认 SQLITE_LOAD_FORMS 不命中）→ 删除。
10. v2 的 Sanity D（"normalized path log"）删除；改由 `check-sqlite-test-skip-pattern.test.cjs` 的 T11 单测覆盖：构造 `\\` 反斜杠路径输入，断言 gate 输出 normalized 为 `/`。

---

## 2. 不做什么 — 与 v2 一致

---

## 3. 时序与回滚 — 与 v2 一致

---

## 4. 操作风险 — v2 OR1–OR6 全部保留 + v3 微调

| OR | v3 状态 |
|---|---|
| OR1 Windows 路径 | 单测覆盖（见 Task 5 step 10） |
| OR2 symlink / .worktrees | gate 启动排除 `.worktrees/**`；不排除 `.claude/**` 全部，仅排除 `.claude/worktrees/**` |
| OR3 动态 require | v3 不变 — 命中即 violation |
| OR4 并行 CI | v3 不变 |
| OR5 nativeBackedModules 索引为空 | v3 不变 |
| OR6 TS path 别名 | 当前 tsconfig 无 paths 映射；v3 不实现 alias 解析；如未来加 paths → 报 "alias detected, gate needs update" |

---

## 5. 与 Codex round-2 review 的对应

| Round-2 issue | 严重 | v3 处理 |
|---|---|---|
| Issue 1 — C4 误伤 fake-injection 测试 | High | (a) `import type` 滤过；(b) 新增 `c4Exempt` 列表；(c) `database-readiness.test.ts` / `session-recall-service.test.ts` 登记 |
| Issue 2 — C3 误伤源文本断言 | High | `SQLITE_LOAD_FORMS` 三 regex 替代字面量包含；`assert.match` 内嵌字符串不命中 |
| Issue 3 — wiring 不一致 (`verify:cloud` 漏 / `verify:j` 实际不含 native) | High | 三入口（`verify` / `verify:cloud` / `verify:k`）都插 orphan + sqlite-skip gate；DAG 修正：static gates ≠ native check，互不重叠 |
| Issue 4 — Sanity D 引用不存在的 debug log | Low | 删 Sanity D；改由 unit test (Task 5 step 10) 覆盖路径正规化 |
| §6 Q1 BFS 深度=6 是否够 | — | depth=6；超深度报错而非 silent miss |
| §6 Q2 nativeBackedModules 缓存 | — | 不缓存，每次重算 (< 200ms) |
| §6 Q3 [ABI-SKIP] token 写文档 | — | 写入 testing-conventions.md schema |
| §6 Q4 .worktrees 排除 | — | 仅排 `.worktrees/**` 与 `.claude/worktrees/**`，不排 `.claude/` 全部 |
| §6 Q5 sync probe | — | sync |

---

## 6. v3 待审查疑点（如有）

1. v3 把 orphan + sqlite-skip 两个 gate 都插到三个入口（`verify` / `verify:k` / `verify:cloud`），是否过度？另一种是仅把 orphan gate 插所有入口，sqlite-skip gate 只挂 `verify:k`。我倾向"两个都进三入口"以保证 short feedback loop 上 (`npm run verify`) 也能直接抓到 sqlite skip 违规——欢迎反对。
2. C4 判定里 `import { type X, Y } from '...'` 这种"混合"被视为 value import 是否合适？严格来说 `Y` 才是 value，TypeScript 编译会保留对模块的 runtime 依赖。所以视为命中是正确的；如果要宽，需要 AST 级别分析才能确认 `Y` 是 type-only re-export ——超出本期范围。
3. `c4Exempt` 是否应该有自动腐烂检测？例如未来 `database-readiness.test.ts` 真的开始构造 sqlite 连接，`c4Exempt` 就过时了。当前 gate 只校验"列表里的文件存在于磁盘"。要再做 "exemption 是否仍合理" 的检测需要运行时验证；推迟到 Stage 6+。
4. `prompt-assembly-memory-create-insert.test.ts` 上次 grep 命中——但我没读其内容。v3 不强行决策，等 gate 实际跑出报告再处置。
