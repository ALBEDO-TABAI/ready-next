---
enforce: false
archived_at: 2026-09-06
archive_reason: superseded-project-documentation
---

> 已归档（2026-09-06）：本文保留编写当时的设计、状态与证据，不是当前执行入口；归档不表示原计划全部实现。现行说明见 [当前运行时合同](../../../../architecture/current-runtime-contracts.md)，去向见 [文档清单](../../../../documentation-inventory.md)。

# Stage 5 — Test-coverage hard gates (Plan v2)

> 上一版: plan-v1.md。  
> v2 变更原因: 吸收 Codex review 的 9 条 finding。重点是 Task 3 的间接 `better-sqlite3` import 漏洞（#5/#6）、test extension 矩阵显式化（#2）、skip token 结构化（#7）、操作风险补全（#9），并澄清 Codex 误读的 C2/orphan 区分（#3）、transitive expansion（#4）、verify wiring DAG（#8）。

---

## 0. 不变量 (合同)

Stage 5 完成后 CI 必须能机器验证以下 5 条合同 (v1 是 4 条；v2 把"orphan vs silent-failure"拆开 + 新增 transitive native gate)：

```ts
// 测试发现矩阵 — 在 gate 与文档中作为单一真值常量
const TEST_EXTENSIONS = [
  'src/__tests__/**/*.test.ts',
  'src/__tests__/**/*.e2e.ts',
  'eslint-rules/__tests__/**/*.test.{mjs,ts}',
  'scripts/__tests__/**/*.test.cjs',
] as const;
```

- **C1 (orphan-coverage)**: 每一个落入 `TEST_EXTENSIONS` 的磁盘文件必须出现在 `package.json` 某个 `verify:*` / `test:*` script 入口（直接命名 *或* 被该入口 glob 命中），或在 `scripts/test-coverage-exemptions.json` 显式登记 `{path, reason, since, owner}`。豁免列表中**不存在于磁盘**也要报错。脚本递归 `npm run X` 引用要展开到 leaf；带 visited-set 防环。
- **C2 (no-silent-failures)**: `npm run test` 在退出码 0 时 fail / not-ok 计数必须为 0。删除 `skill-primitive-tool-gating.test.ts` 后 baseline 应为零失败。该合同由现有 `test:*` 链负责执行，不另起 gate；只在文档与 v2 acceptance 步骤里明文锚定。
- **C3 (sqlite-direct-skip)**: 任何**直接** `import` / `require` `better-sqlite3` 的测试文件，必须在每个外层 `test(...)` 入口前调用 canonical helper `skipIfSqliteUnavailable(t, label)`；helper 在 host Node 失败路径上发出形如 `[ABI-SKIP][native_abi_host_mismatch] <label>: ...` 的结构化 reason。
- **C4 (sqlite-transitive-skip)**: 任何**间接**载入 `better-sqlite3` 的测试文件——即 import 链经过任一 `nativeBackedModules` 成员——同样必须使用 `skipIfSqliteUnavailable`。`nativeBackedModules` 由 gate 启动时 `grep -rl "better-sqlite3" src/main src/shared src/preload` + 已知短列表（`src/main/modules/database.ts`、`src/main/modules/db-worker.ts` 等）合成；从测试文件出发以 BFS 解析相对 import，深度 ≤ 6（实测仓库内最长链 ≤ 4），命中即触发要求。
- **C5 (CI-enforced-not-documented)**: C1/C3/C4 必须分别有 `scripts/check-*.cjs` 硬门 + `scripts/__tests__/check-*.test.cjs` 单测；都挂入新 `verify:k`。`verify:k` 接到 `verify:j` 之后；top-level `verify` 在 `npm run test` 之前**单次**调用 orphan gate（不调用整条 `verify:k`，避免与 `verify:j` 链重复跑 sqlite native）。文档（CLAUDE.md / AGENTS.md / testing-conventions.md）只是镜像，不替代 CI。

> **C1 vs C2 的区分**（回应 Codex #3）：C1 = "测试文件归属于某条 verify"；C2 = "归属之后真的跑且不静默失败"。两者正交：C1 守住 surface，C2 守住 behavior。Codex 把这两件事混读为一件，v2 显式拆开。

---

## 1. 任务清单

### Task 1 · 删除孤儿测试 (无变更)
- `git rm src/__tests__/skill-primitive-tool-gating.test.ts`。
- 同模块覆盖：`skill-tool-gating-by-session.test.ts` / `skill-execution-tools-removed.test.ts` / `phase-4-tool-gating-expansion.test.ts`。
- 不存在 `verify:*` 引用此文件 (grep 已确认)。

### Task 2 · `verify:k` 的 orphan-coverage 硬门 (v2 收紧)

**新文件**:
- `scripts/check-test-coverage-by-verify.cjs`
- `scripts/__tests__/check-test-coverage-by-verify.test.cjs`
- `scripts/test-coverage-exemptions.json`

**算法 (v2 显式化 transitive expansion)**:

```pseudocode
TEST_EXTENSIONS  // 上面常量
SCRIPT_KEY_PREFIX = /^(verify|test)(:.+)?$/

function tokenize(scriptValue):
  // 拆 && / || / ; / 单空格，剔除引号；返回 token 序列
  // 当前 package.json 不含 ${VAR}；遇到 ${} 直接报 "unrecognized token"

function expandReferenced(scripts, key, visited):
  if key ∈ visited: throw "cycle detected: " + key
  visited.add(key)
  out = []
  for tok in tokenize(scripts[key]):
    if tok matches /^npm run (\S+)/: out += expandReferenced(scripts, $1, visited)
    elif tok matches *.test.ts | *.e2e.ts | *.test.mjs | *.test.cjs:
      out += globExpand(tok)  // mini-matcher; 见下
  return out

referenced = ⋃_{k matches SCRIPT_KEY_PREFIX} expandReferenced(scripts, k, new Set)
disk = ⋃_{glob ∈ TEST_EXTENSIONS} fs.glob(glob)
exempt = JSON.parse(scripts/test-coverage-exemptions.json).exempt.map(e => realpath(e.path))

orphans = disk \ referenced \ exempt
ghosts  = exempt \ disk        // 列表腐烂

if orphans ∪ ghosts non-empty: 列出 + exit 1
```

**glob mini-matcher**:
- 支持 `*` (单段不含 `/`)、`**` (跨段)、字面量、字符类 `[abc]`。
- 不依赖第三方包；< 40 行；附 5 个单测覆盖：`*.test.ts` / `**/*.test.ts` / `skill-*.test.ts` / `e2e/*.e2e.ts` / 字面量。
- 输入路径统一走 `path.posix.normalize`，先 `fs.realpathSync`（处理 symlink）。

**豁免格式 (v1 不变)**:
```json
{
  "schemaVersion": 1,
  "exempt": [
    {
      "path": "src/__tests__/foo-quarantine.test.ts",
      "reason": "<≥10 字符具体原因>",
      "since": "YYYY-MM-DD",
      "owner": "<team-or-handle>"
    }
  ]
}
```
gate 拒绝缺字段 / `reason` < 10 字符 / `since` 非 ISO 日期。

**单测最少覆盖**:
- T1 token 拆分（`&&` / `;` / 引号包裹）。
- T2 transitive `npm run` 展开 + 环检测。
- T3 5 类 glob 形态。
- T4 豁免命中 / 豁免列表多余 / 字段缺失各一。
- T5 注入伪 orphan → 报错。
- T6 注入 ghost (列表里写但磁盘没有) → 报错。

**接线**:
- 新增 `verify:k`：
  ```
  "verify:k": "npm run verify:j && node scripts/check-test-coverage-by-verify.cjs && node --test scripts/__tests__/check-test-coverage-by-verify.test.cjs && node scripts/check-sqlite-test-skip-pattern.cjs && node --test scripts/__tests__/check-sqlite-test-skip-pattern.test.cjs"
  ```
- top-level `verify`：在 `npm run test` 之前**单次**插入 orphan gate（不调用整条 `verify:k`，避免 sqlite native 二次跑）：
  ```
  "verify": "npm run verify:native && npm run typecheck && npm run lint:check && node scripts/check-test-coverage-by-verify.cjs && npm run test"
  ```
- DAG（回应 Codex #8）：
  ```
  verify (top)        → check-test-coverage  + npm test
  verify:k            → verify:j → ... → check-test-coverage + check-sqlite-skip-pattern
  verify:cloud        → 与 top-level verify 等价，不重写
  ```
  orphan gate 在 v2 跑 ≤ 2 次（top-level verify 跑 1 次；如果同时跑 verify:k 总共 2 次）。这是 by design：top-level 是日常入口要快速失败，stage 链是层级 audit。无重复执行风险。

### Task 3 · sqlite skip 规范化 (v2 大改：补 transitive)

#### 3a · canonical helper (v2 token 结构化)
新文件 `src/__tests__/utils/sqlite-skip.ts`：

```ts
import type { TestContext } from 'node:test';

export type SqliteSkipReason = 'native_abi_host_mismatch' | 'binding_missing' | 'sqlite_runtime_error';

export function skipIfSqliteUnavailable(
  t: TestContext,
  label: string,
  probe: () => void = defaultProbe,
): boolean {
  try {
    probe();
    return false;
  } catch (error) {
    const reason: SqliteSkipReason =
      (error as NodeJS.ErrnoException)?.code === 'ERR_DLOPEN_FAILED' ? 'native_abi_host_mismatch'
      : (error as NodeJS.ErrnoException)?.code === 'MODULE_NOT_FOUND' ? 'binding_missing'
      : 'sqlite_runtime_error';
    t.skip(`[ABI-SKIP][${reason}] ${label}: ${(error as Error).message}; covered by npm run verify:native`);
    return true;
  }
}

function defaultProbe(): void {
  // 默认 probe：直接构造 :memory:
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const mod = require('better-sqlite3');
  const Sqlite = mod.default || mod;
  const db = new Sqlite(':memory:');
  db.close();
}
```

**关键合同**：skip 消息必须以 `[ABI-SKIP][<reason>]` 开头；gate (Task 3c) 用此 token 区分"合规 skip"与"伪装 skip"。

#### 3b · `nativeBackedModules` 索引 (v2 新增)

为应对间接 import (Codex #6)：gate 启动时构建 native-backed 模块集合：

```pseudocode
nativeBackedSeed = [
  'src/main/modules/database.ts',
  'src/main/modules/db-worker.ts',
  // 任何 grep -l better-sqlite3 src/{main,shared,preload} 命中的文件
]
nativeBackedModules = grep_lr 'better-sqlite3' src/main src/shared src/preload
                   ∪ nativeBackedSeed
```

构建逻辑放在 `scripts/check-sqlite-test-skip-pattern.cjs` 启动期（每次跑都重算，避免索引腐烂）。

#### 3c · `check-sqlite-test-skip-pattern.cjs` (v2 加 BFS)

```pseudocode
nativeBackedModules = build_index()  // 见 3b

violations = []
for testFile in TEST_EXTENSIONS expanded:
  importGraph = bfs_relative_imports(testFile, depth ≤ 6)
  reachesNative =
       'better-sqlite3' ∈ raw_text(testFile)                  // direct C3
    ∨ ∃ m ∈ importGraph: m ∈ nativeBackedModules               // transitive C4

  if reachesNative:
    if not has_skip_helper_call(testFile):
      violations += { file: testFile, kind: 'missing_helper' }
    if exists test-block without leading skipIfSqliteUnavailable(t, ...):
      violations += { file: testFile, kind: 'unguarded_block' }

if violations: 列出 + exit 1
```

`bfs_relative_imports` 实现:
- 解析 `import ... from '<path>'` / `require('<path>')` / `await import('<path>')` 的字面量参数。
- 仅追相对路径 (`.` / `..`)；node_modules 路径里只关心 `'better-sqlite3'` 字面量本身（直接 hit）。
- realpath 解析 + `path.posix.normalize` 统一格式（回应 Codex #9 的 Windows / symlink 风险）。
- 缓存 module → set (memoization 避免 N²)。

`has_skip_helper_call` 用正则验证 import 来自 `'./utils/sqlite-skip'` 且 `skipIfSqliteUnavailable(` 至少出现一次。  
`unguarded_block` 用正则查找形如 `^\s*test\(['"]` 而其后 4 行内没有 `skipIfSqliteUnavailable(t,`。允许误报，由具体文件结构调整 — 单测覆盖 happy / unguarded / nested describe。

**单测最少覆盖**:
- T1 仅直接 import → 命中 + 无 helper → violation。
- T2 仅间接 import (经 `database.ts`) → 命中 + 无 helper → violation。
- T3 直接 import + 完整 helper → pass。
- T4 间接 import + 完整 helper → pass。
- T5 既无 direct 也无 indirect → 不动该文件。
- T6 nested describe + 缺 helper 的 test block → violation。
- T7 cycle import 不死循环 (visited set)。
- T8 native-backed module 索引为空 → 仍能正确处理 direct C3 路径。

#### 3d · 改造现有违规

按 v1 列表 + Codex #5 补充：

| 文件 | v1 状态 | v2 处理 |
|---|---|---|
| `migrations-drop-skill-executions.test.ts` | throw → fail | 改 `skipIfSqliteUnavailable` |
| `skill-task-run-repository.test.ts` | 5×`console.warn` | 改 helper |
| `skill-child-runner.test.ts` | 3×`console.warn` | 改 helper |
| `database-pragmas.test.ts` | 已用 `t.skip` | 收编为 helper（统一 token） |
| `single-file-link-resolve.test.ts` | 9×`t.skip` | 收编为 helper |
| `db-worker.test.ts` | `t.skip` | 收编 |
| `chat-message-persistence.test.ts` | `t.skip` | 收编 |
| `database.test.ts` | **v2 新增 (Codex #5)** | 检查是否 import sqlite，按情况收编 |
| `prompt-assembly-memory-create-insert.test.ts` | **v2 新增 (Codex #5)** | 检查 + 收编 |
| `database-readiness.test.ts` | **v2 新增 (Codex #6, transitive)** | 通过 `database.ts` 间接载入 → 收编 |
| `session-recall-service.test.ts` | **v2 新增 (Codex #6, transitive)** | 检查 + 收编（如间接依赖） |

> **不要靠人工列表兜底**：Task 3c 的 gate 是真值；上表只用于 PR 自检。如果 gate 在改造后还报新文件，按报错列表收编而不是改 gate 放过。

#### 3e · 接线 (与 Task 2 合并到 verify:k，已写在 Task 2 接线段)

### Task 4 · 文档同步 (与 v1 一致)
- `docs/superpowers/testing-conventions.md`：追加 §"Stage 5 covenants"，5 条合同 + helper 用法 + DAG 图。
- `CLAUDE.md` §6.17 追加一段："Stage 5 起 verify:k 强制 orphan-coverage / sqlite-direct-skip / sqlite-transitive-skip 三件事；新增测试必须出现在某 verify:* / test:* 入口或显式豁免；接触 sqlite (直接或经 nativeBackedModules) 必须用 `skipIfSqliteUnavailable` helper。"
- `AGENTS.md` 同步同段落（§12 一致性约束）。

### Task 5 · 验收 (v2 加 transitive sanity)
1. `npm run verify:k` 全绿。
2. `npm run verify:j` 仍全绿。
3. `npm run verify` 全绿。
4. **Sanity A (orphan)**：`echo 'test("x", () => {})' > src/__tests__/__orphan_probe.test.ts` → `verify:k` 失败 → 删 → 通过。
5. **Sanity B (silent skip)**：把 `skill-task-run-repository.test.ts` 一处 helper 临时退回 `console.warn` → gate 报 missing_helper → 还原。
6. **v2 新增 Sanity C (transitive)**：临时新建 `src/__tests__/__transitive_probe.test.ts`，仅 `import '../main/modules/database'`，不调用 helper → gate 报 transitive violation → 删除。
7. **v2 新增 Sanity D (windows/symlink)**：人工运行 `node scripts/check-sqlite-test-skip-pattern.cjs` 后查看其内部 normalized path log；确认 `path.posix.normalize` 输出无反斜杠（macOS 当前环境只能间接验证；Windows 真机回归推迟到下游 stage）。

---

## 2. 不做什么 (反范围，与 v1 一致 + v2 微调)
- 不引入第三方 npm 包（`minimatch` / `glob` / `picomatch` / `fast-glob` 全部不引）。
- 不重写 `verify:a0…verify:j` 链。
- 不把 sqlite-backed test 实际搬到 Electron runtime 跑（那是 Stage 6+）。
- 不把 `npm run test` 的 glob 改窄。
- v2 新加："不"自己实现完整 TypeScript AST parser；BFS 限定字面量正则即可；如果未来出现动态拼接 import 路径再说。

---

## 3. 时序与回滚 (与 v1 同结构)

| Phase | 步骤 | 独立 PR? |
|---|---|---|
| P1 | Task 1 删 orphan | ✅ |
| P2 | Task 2 (orphan gate + 单测 + verify:k 首次接线) | ✅ |
| P3 | Task 3a/3b/3c (helper + nativeBackedModules + skip-pattern gate) | ✅ |
| P4 | Task 3d 改造 (≥ 9 个文件，可拆 2–3 个 PR) | ✅ |
| P5 | Task 4 文档 | ✅ (可与 P2/P3 合) |
| P6 | Task 5 验收 | — |

每 phase `git revert` 即回滚；零运行时风险。

---

## 4. 操作风险显式登记 (v2 新增 — 回应 Codex #9)

| 编号 | 风险 | 应对 |
|---|---|---|
| OR1 | Windows 路径分隔符 (`\`) 与 POSIX 路径混入 gate 输出 | 所有路径统一 `path.posix.normalize`；gate 输入入口 `path.resolve` + `replace(/\\/g, '/')`；单测在 macOS 下用人造 `\\` 字符串覆盖正则解析。|
| OR2 | symlink 测试目录 (`.worktrees/*` / `.claude/worktrees/*` 内同名 orphan 文件) | gate 启动时 `fs.realpathSync` 测试目录；BFS 跨 symlink 走 realpath；显式排除 `.worktrees/**` 和 `.claude/**` 不参与 disk 全集。|
| OR3 | 动态 require / import 不写字面量 | gate 用 grep 检测 `require\((?![\'"])` 等动态形式；命中即 violation 加 hint「请改用静态 import 或加豁免」。当前 src/__tests__ 不应有动态 import；若有就是潜在漏洞。|
| OR4 | 并行 CI 链路顺序差异 | `verify:k` 内部串行 (`&&`)；不允许 `&` / `wait` 并行；典型 GitHub Actions 矩阵串行运行；本地 `package.json` 也是 `&&`。|
| OR5 | `nativeBackedModules` 索引启动时为空 (e.g. 首次 clone 还没编译) | gate 启动时如果 `grep` 命中 0 个文件且 seed 列表为空 → 警告并继续；只走 direct C3 路径；这是降级而非误判。|
| OR6 | TypeScript 路径别名 (`@/main/...`) | 当前 `tsconfig.json` 检查；如果有别名映射 → 在 BFS resolver 里读 `tsconfig.json` 的 `paths` 字段并解 alias。如果没有别名（实测当前没有），不实现 alias 解析以保持 ≤ 40 行。|

---

## 5. 与 Codex review 的对应关系 (v2 新增)

| Codex finding | 严重 | v2 处理 |
|---|---|---|
| #1 orphan gate 应作为唯一硬门 | patch | 已统一为 `scripts/check-test-coverage-by-verify.cjs` (Task 2)。 |
| #2 缺 mjs/cjs/e2e 矩阵 | NACK | `TEST_EXTENSIONS` 常量显式四类。 |
| #3 C2 与 C1 混淆 | NACK | C1=orphan-coverage / C2=no-silent-failures，§0 拆开。 |
| #4 缺 transitive 展开 | NACK | Task 2 算法显式 `expandReferenced` + visited set + 环报错。 |
| #5 sqlite 列表不全 | NACK | 改为 gate 自动发现；3d 表只作 PR 自检。 |
| #6 静态文本扫漏间接 import | NACK | 新增 C4 + Task 3b `nativeBackedModules` + 3c BFS。 |
| #7 skip reason 应结构化 | NACK | helper 输出 `[ABI-SKIP][<reason>] ...`；gate 解析。 |
| #8 verify:k 双跑 | patch | DAG 图明示：top-level 单独跑 orphan gate，verify:k 串完整套；不重复跑 sqlite native (`verify:j` 链已含 native:check)。|
| #9 操作风险未登记 | patch | §4 OR1–OR6 显式列出。|

---

## 6. 待 v2 审查的疑点
1. C4 的 BFS 深度上限设为 6；仓库里实测最长链是多少？是否需要 unlimited + 仅靠 visited set 终止？
2. `nativeBackedModules` 由 grep 动态构建意味着每次跑 gate 都做 `find + grep`；500+ 文件 * 7+ 测试涉及一遍，预计 < 200ms。是否需要缓存？
3. `[ABI-SKIP][<reason>]` token 是否需要写入 testing-conventions.md 的 schema 定义而不是只在 helper 注释里？我倾向写文档+gate 双锚定，确认。
4. OR2 的 `.worktrees/**` / `.claude/**` 排除是否会误漏掉将来真实迁移到那里的 contract test？建议是排除当前两个 path 但 gate 输出里 emit 一个 info 日志说明跳过的目录数。
5. Task 3a 的 helper 是否要 `await probe()` 形态以兼容 async probe？当前需求只是同步构造 `:memory:`，建议保持 sync；如未来要测异步 lazy load 再加 overload。
