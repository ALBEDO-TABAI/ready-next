---
enforce: false
archived_at: 2026-09-06
archive_reason: superseded-project-documentation
---

> 已归档（2026-09-06）：本文保留编写当时的设计、状态与证据，不是当前执行入口；归档不表示原计划全部实现。现行说明见 [当前运行时合同](../../../../architecture/current-runtime-contracts.md)，去向见 [文档清单](../../../../documentation-inventory.md)。

# Stage 5 — Test-coverage hard gates (Plan v4)

> 上一版: plan-v3.md (Codex round-3 → patch A, B)。  
> v4 变更原因: 修 round-3 两条 patch。
> - **Patch A**: `verify:cloud` 不跑 `native:check`（cloud env 无 Electron），v3 §0 C5 误写为"cloud 跑 verify:native"。v4 重新表述：cloud 只跑 `rebuild:native`，native runtime gate 仅由开发本机 `verify` 入口承担；cloud 把 sqlite-backed 验收 deferred 到 dev-machine 上，与 §6.13 现有约定一致。
> - **Patch B**: C3 `SQLITE_LOAD_FORMS` 第二条 `\bfrom\s+['"]better-sqlite3['"]` 会误命中 `import type X from 'better-sqlite3'`。v4 在 `from` 形态前加 type 否决（与 C4 的 type-only 排除规则统一）。

---

## 0. 不变量 (合同) — v4 仅微调

```ts
const TEST_EXTENSIONS = [
  'src/__tests__/**/*.test.ts',
  'src/__tests__/**/*.e2e.ts',
  'eslint-rules/__tests__/**/*.test.{mjs,ts}',
  'scripts/__tests__/**/*.test.cjs',
] as const;

// v4 收紧 — load 形态识别同时排除 type-only import
const SQLITE_LOAD_FORMS = [
  // require / await import 不存在 type-only 形态，原样保留
  /\brequire\(\s*['"]better-sqlite3['"]\s*\)/,
  /\bawait\s+import\(\s*['"]better-sqlite3['"]\s*\)/,
] as const;

// v4 单独处理 from 形态 — 必须先排除 `import type ... from '<m>'` 与
// `import { type X } from '<m>'` (整组都是 type-only) 之后再匹配。
function isDirectFromBetterSqlite3(line: string): boolean {
  // 1) 整体 type import 直接拒
  if (/^\s*import\s+type\s+/.test(line)) return false;
  // 2) `import { type X } from 'better-sqlite3'` — 整组都是 type 时拒
  const namedGroup = line.match(/^\s*import\s*\{\s*([^}]+)\s*\}\s*from\s*['"]better-sqlite3['"]/);
  if (namedGroup) {
    const allTypeOnly = namedGroup[1]
      .split(',')
      .map((s) => s.trim())
      .every((s) => s.startsWith('type '));
    if (allTypeOnly) return false;
  }
  return /\bfrom\s+['"]better-sqlite3['"]/.test(line);
}
```

- **C1 / C2 / C4** 与 v3 一致。
- **C3 — v4 收紧**：测试文件命中 `SQLITE_LOAD_FORMS` 任一 regex **或** `isDirectFromBetterSqlite3(line)` 为 true 时，必须用 helper。`import type X from 'better-sqlite3'` 不命中（与 C4 `import type` 规则统一）。
- **C5 — v4 修正 cloud 表述**：
  - 三处入口都插 orphan gate + sqlite-skip gate（与 v3 同）。
  - `npm run verify` (本机日常入口) 跑完整 `verify:native`（含 `rebuild:native + native:check`）。
  - `npm run verify:cloud` (CI 入口，无 Electron) 仅跑 `rebuild:native`，**不跑** `native:check`；这是与 §6.13 一致的——cloud 不证明 Electron ABI，本机 `verify` 才证明。
  - `verify:k` (stage 链入口) 不跑 native，纯静态。

> v3 §0 C5 与 §1 Task 2 DAG 在"cloud 是否跑 verify:native"上自相矛盾；v4 统一为：**cloud 只 rebuild，不跑 native:check**。

---

## 1. 任务清单

### Task 1 · 删除孤儿测试 — 与 v3 一致

### Task 2 · `verify:k` orphan-coverage 硬门 — v4 仅修接线段

(算法 / 单测 / 豁免 schema 与 v3 一致)

**接线 — v4 准确版**：

```jsonc
{
  "verify:k": "npm run verify:j && node scripts/check-test-coverage-by-verify.cjs && node --test scripts/__tests__/check-test-coverage-by-verify.test.cjs && node scripts/check-sqlite-test-skip-pattern.cjs && node --test scripts/__tests__/check-sqlite-test-skip-pattern.test.cjs",

  "verify": "npm run verify:native && npm run typecheck && npm run lint:check && node scripts/check-test-coverage-by-verify.cjs && node scripts/check-sqlite-test-skip-pattern.cjs && npm run test",

  "verify:cloud": "npm run rebuild:native && npm run typecheck && npm run lint:check && node scripts/check-test-coverage-by-verify.cjs && node scripts/check-sqlite-test-skip-pattern.cjs && npm run test"
}
```

**v4 DAG (准确)**：

```
verify (本机日常)   ─→ verify:native (rebuild + native:check) ─→ typecheck ─→ lint ─→ orphan gate ─→ sqlite-skip gate ─→ npm run test
verify:cloud (CI)   ─→ rebuild:native (无 native:check)        ─→ typecheck ─→ lint ─→ orphan gate ─→ sqlite-skip gate ─→ npm run test
verify:k (stage)    ─→ verify:j (static chain)                                              ─→ orphan gate ─→ sqlite-skip gate
verify:j → ... → verify:b: 全部静态检查 (typecheck / lint / area gates / focus tests)，无 native。
```

**v4 显式声明**：cloud 入口故意不跑 `native:check`——与 §6.13 "Electron native gate 由本机 dev-machine 承担"一致；cloud 只证明 sqlite static skip pattern + orphan coverage 这两条静态合同。两个 native runtime 验证只在 `verify` (本机) 走。

### Task 3 · sqlite skip 规范化 — v4 仅修 C3 检测

#### 3a · helper 与 v3 一致

#### 3b · `nativeBackedModules` 索引与 v3 一致

#### 3c · `check-sqlite-test-skip-pattern.cjs` — v4 仅改 isDirectSqliteLoader

```pseudocode
function isDirectSqliteLoader(testFile):
  src = readFile(testFile)
  // require / await import 直接看 SQLITE_LOAD_FORMS
  for rgx in SQLITE_LOAD_FORMS:
    if rgx.test(src): return true
  // from 形态需要按行做 type-only 排除（与 C4 统一）
  for line in src.split(/\r?\n/):
    if isDirectFromBetterSqlite3(line): return true
  return false
```

**单测追加 (v3 T1–T10 之上)**：
- T11 (v4 新增) `import type X from 'better-sqlite3'` 不命中 C3。
- T12 (v4 新增) `import { type X } from 'better-sqlite3'` 不命中 C3（整组 type-only）。
- T13 (v4 新增) `import { type X, Y } from 'better-sqlite3'` **命中** C3（混合形态有 value Y）。
- T14 (v4 新增) `import 'better-sqlite3'` (副作用 import) **命中** C3——`from` 形态匹配。

> 注意 T14 的 side-effect import (`import 'better-sqlite3'`) 在仓库当前没有，但 regex 必须能命中以保证未来不漏。

#### 3d · 改造现有违规 — 与 v3 一致

#### 3e · 接线 — 见 Task 2 (v4 三入口确认)

### Task 4 · 文档同步 — v4 仅在 testing-conventions 强调 cloud 行为

- `docs/superpowers/testing-conventions.md` 追加 §"Stage 5 covenants"：
  - 5 条合同 + token schema + DAG（v4 准确版）。
  - **明确 cloud 不跑 `native:check`**：cloud CI env 无 Electron runtime，sqlite-backed 验收必须本机 `npm run verify` 覆盖；cloud 只承担静态 gate 与单元测试。
- `CLAUDE.md` §6.17 末尾追加：
  > Stage 5 起 verify:k / verify / verify:cloud 强制 orphan-coverage、sqlite-direct-skip、sqlite-transitive-skip 三件事；新增测试必须出现在某 verify:* / test:* 入口或显式豁免；接触 sqlite (load 形态直接 require/import 或 value import 经 nativeBackedModules) 必须用 `skipIfSqliteUnavailable` helper；`import type` 不视为 sqlite 接触；C4 间接路径在确认仅用 fake 注入时可登记 `c4Exempt`；cloud 入口故意不跑 native:check，sqlite-backed 真值验收仍由本机 `verify:native` / `verify` 承担。
- `AGENTS.md` 同步同段落。

### Task 5 · 验收 — 与 v3 一致 + Sanity F (type-only)

**v4 新增 Sanity F**: 临时新建 `src/__tests__/__import_type_probe.test.ts` 仅 `import type X from 'better-sqlite3'` → gate 不报错（确认 v4 type-aware C3 滤过）→ 删除。

> v3 已有 Sanity D (`import type` from `database.ts`，验 C4 transitive 滤过)；v4 Sanity F 验 C3 direct 滤过。两个互补。

---

## 2. 不做什么 — 与 v3 一致

---

## 3. 时序与回滚 — 与 v3 一致

---

## 4. 操作风险 — 与 v3 一致 (OR1–OR6)

---

## 5. 与 Codex round-3 review 的对应 (v4 新增)

| Round-3 issue | 严重 | v4 处理 |
|---|---|---|
| Patch A — cloud 是否跑 verify:native 自相矛盾 | patch | §0 C5 / §1 Task 2 接线 / §1 Task 4 文档统一为"cloud 只 rebuild，不跑 native:check"；理由 = §6.13 Electron native gate 限本机 |
| Patch B — C3 `from` regex 误命中 `import type` | patch | 拆出 `isDirectFromBetterSqlite3(line)` 函数；type-only 整组拒；混合形态保留命中 |
| §6 Q1 (gates×3 entries) | — | 接受：两个 gate 都进三入口，<200ms 静态成本，反馈一致 |
| §6 Q2 (mixed import) | — | 接受：`{ type X, Y }` 视为 value import |
| §6 Q3 (c4Exempt staleness) | — | 接受：Stage 5 不做 rot detector；登记里有 owner/reason，等需要再做 |
| §6 Q4 (defer prompt-assembly decision) | — | 接受：让 gate 实际跑出报告再决定 |

---

## 6. v4 待审查疑点 (尽量留空)

1. v4 §0 C5 显式声明 cloud 不跑 native:check 是否会让别的 stage 文档（CLAUDE.md §6.13 / testing-conventions.md）出现新的不一致？我已在 Task 4 加了显式段落对齐，确认即可。
2. 其余疑点 v3 §6 codex 已答；v4 不再追问。
