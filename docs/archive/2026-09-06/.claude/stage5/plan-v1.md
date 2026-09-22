---
enforce: false
archived_at: 2026-09-06
archive_reason: superseded-project-documentation
---

> 已归档（2026-09-06）：本文保留编写当时的设计、状态与证据，不是当前执行入口；归档不表示原计划全部实现。现行说明见 [当前运行时合同](../../../../architecture/current-runtime-contracts.md)，去向见 [文档清单](../../../../documentation-inventory.md)。

# Stage 5 — Test-coverage hard gates (Plan v1)

> 出处: codex Stage 5 路线确认的三件事。  
> 日期: 2026-05-06。  
> 目标: 把"测试装在哪儿运行"这件事彻底说死，让破损/孤儿/伪通过的测试在合并前必败。

---

## 0. 不变量 (写合同 — §0.5 Principle 1)

Stage 5 完成后 CI 必须能机器验证以下 4 条合同：

- **C1 (no orphan tests)**: `src/__tests__/**/*.test.ts`、`src/__tests__/e2e/**/*.e2e.ts`、`eslint-rules/__tests__/**/*.test.{mjs,ts}`、`scripts/__tests__/**/*.test.cjs` 中的每一个文件，要么被 `package.json` 的 `verify:*` / `test:*` 脚本之一直接或间接引用 (含 glob 展开)，要么出现在 `scripts/test-coverage-exemptions.json` 并附 `reason` + `since`。
- **C2 (no broken silent tests)**: `npm run test` 不允许在退出码 0 时出现 "fail / not ok" 计数 > 0；现有的 `skill-primitive-tool-gating.test.ts` 删除后 `npm run test` 应零失败。
- **C3 (sqlite-backed test skip discipline)**: 任何 `import` 或 `require('better-sqlite3')` 的测试文件，必须满足以下之一：
  1. 显式属于 Electron-runtime acceptance 集合 (列入 `electronOnlyTests` allowlist，并配套通过 `scripts/check-better-sqlite3-electron-abi.cjs` 验收)；
  2. 在 host Node 加载失败时使用 **canonical t.skip pattern** —— `t.skip(<reason>)` 调用 (regex 可识别)，**禁止** 仅用 `console.warn(...skipping)` + early return 形式假装跳过。
- **C4 (CI 强制 ≠ 文档)**: 上述 3 条都必须落到 `scripts/check-*.cjs` 硬门并有自己的 `scripts/__tests__/*.test.cjs`，挂入新的 `verify:k` 入口；`verify:k` 进入 top-level `verify` 链；不允许只靠 CLAUDE.md 告诫。

> 这 4 条写不出来就不开工。当前已经写得出来，可开工。

---

## 1. 任务清单 (顺序，每步独立可验证)

### Task 1 · 删除孤儿测试
**文件**: `src/__tests__/skill-primitive-tool-gating.test.ts`  
**为什么删而不是修**:
- 调用 `filterSkillPrimitivesBySession(defs, sessionId, fn)` 用 3 参数旧签名，真签名是 4 个 (新增 `hasReferenceSkillHint` 后又叠了 2 个 optional)；现在跑 5 个子测试 3 个直接 `TypeError`。
- 同模块已被 3 份测试用新签名完整覆盖：
  - `src/__tests__/skill-tool-gating-by-session.test.ts` (主)
  - `src/__tests__/skill-execution-tools-removed.test.ts` (去 state machine 后回退路径)
  - `src/__tests__/phase-4-tool-gating-expansion.test.ts` (Phase 4.3 投影信号)
- 没有任何 `verify:*` / `test:*` 脚本按名字引用它 (grep 结果空)。
- 删除是"修根因" (§0.5 Principle 2)：根因是 Phase 4 PR5 的退场没把这份冗余文件一并删，不是"少了一份测试"。

**操作**: `git rm src/__tests__/skill-primitive-tool-gating.test.ts`。  
**验证**: `npm run test` 局部跑 `skill-tool-gating*` glob 应零失败 (注意主 `npm run test` 全集会因别的 ABI skip 卡 5–10s，单独跑此 glob 即可)。

### Task 2 · 实现"测试覆盖率 vs verify 入口"硬门
**新文件**:
- `scripts/check-test-coverage-by-verify.cjs` (实现)
- `scripts/__tests__/check-test-coverage-by-verify.test.cjs` (单元测试)
- `scripts/test-coverage-exemptions.json` (豁免登记)

**算法**:
1. 读 `package.json.scripts`，遍历键名匹配 `^(verify|test)(:|$)` 的 entry；对每条 value 用简单 tokenizer 抽出所有 `src/__tests__/...test.ts` / `*.e2e.ts` / `eslint-rules/__tests__/*.test.mjs` / `scripts/__tests__/*.test.cjs` 字面量 (含 glob)。
2. 跨脚本递归展开 `npm run X` 引用。
3. 对每个抽出的字面量做 `glob` 扩展 (用 Node 自带 `fs.readdirSync` 简化，不引第三方依赖)。
4. 收集 disk-side 全集；diff 出未被引用的文件。
5. 与 `test-coverage-exemptions.json` 取差集；剩余非空 → 列出文件 + 退出 1。
6. 反向校验：豁免列表中**不存在**于磁盘 → 也要报错 (避免列表腐烂)。

**豁免格式 (允许 4 类原因)**:
```json
{
  "schemaVersion": 1,
  "exempt": [
    {
      "path": "src/__tests__/foo-quarantine.test.ts",
      "reason": "manually-quarantined: failing flaky on macOS, see issue #1234",
      "since": "2026-05-06",
      "owner": "agent-runtime"
    }
  ]
}
```

**与现有脚本的隔离原则**:
- 不 reuse 任何已有 grep / lint baseline；这是结构性 audit，不是 source-grep test。
- 输出格式仿 `scripts/check-coordinator-isolation.cjs` (有 violation 列表 + summary)。

**单测覆盖**:
- 解析 `package.json` 抽 token 正确性 (含 `&&` / `||` / `;` 拆分)。
- glob 展开正确处理 `src/__tests__/skill-*.test.ts`。
- 跨脚本 `npm run X` 链路递归。
- 豁免命中 / 反向豁免 (列表多余) 各一例。
- 表现一个伪造 orphan 文件被检测到。

**接线**:
- `package.json` 新增 `verify:k`：`"npm run verify:j && node scripts/check-test-coverage-by-verify.cjs && node --test scripts/__tests__/check-test-coverage-by-verify.test.cjs"`。
- top-level `"verify"` 改成 `"npm run verify:native && npm run typecheck && npm run lint:check && node scripts/check-test-coverage-by-verify.cjs && npm run test"`。理由：让 `verify` 在 `npm run test` 之前先发现孤儿；`verify:k` 单独存在以便 stage 链显式串入。

**风险与回避**:
- 风险 R2.1: glob 扩展可能误判 `src/__tests__/skill-*.test.ts` 类前缀通配。
  → 实测：用 `fs.readdirSync` + `minimatch`-style 内置正则 (避免引第三方包)；附单测覆盖 5 种 glob 形态。
- 风险 R2.2: 跨 script 递归 `npm run` 引用形成环。
  → 加 visited set，环 → 报错 (这是 package.json 写错，不是合法状态)。
- 风险 R2.3: 静态字符串解析漏掉模板拼接 (`$VAR`)。
  → 当前 package.json 没有；如未来引入，gate 报"unrecognized token, please update parser"。

### Task 3 · better-sqlite3 / Electron ABI 测试规范化
**子任务 3a · 调研当前 sqlite-backed 测试**:
已知有这些文件 (按出现次数排序，可能有遗漏):
- `database-pragmas.test.ts` ✓ 已用 `t.skip`
- `single-file-link-resolve.test.ts` ✓ 已用 `t.skip`
- `db-worker.test.ts` ✓ 已用 `t.skip`
- `chat-message-persistence.test.ts` ✓ 已用 `t.skip`
- `migrations-drop-skill-executions.test.ts` ✗ throws Error 而不 skip
- `skill-task-run-repository.test.ts` ✗ 用 `console.warn` + early return
- `skill-child-runner.test.ts` ✗ 用 `console.warn` + early return

**子任务 3b · canonical skip helper**:
新文件 `src/__tests__/utils/sqlite-skip.ts`：
```ts
export function skipIfSqliteUnavailable(t: TestContext, label: string): boolean {
  try {
    const mod = require('better-sqlite3');
    const Sqlite = mod.default || mod;
    const probe = new Sqlite(':memory:');
    probe.close();
    return false;
  } catch (error) {
    t.skip(`${label}: better-sqlite3 native binding unavailable (${(error as Error).code ?? 'unknown'}); covered by npm run verify:native`);
    return true;
  }
}
```
所有 sqlite-backed test 改为：
```ts
test('xxx', (t) => {
  if (skipIfSqliteUnavailable(t, 'skill-task-run-repository')) return;
  ...
});
```

**子任务 3c · 硬门**:
新文件 `scripts/check-sqlite-test-skip-pattern.cjs`：
- 静态扫描 `src/__tests__/**/*.test.ts`，对所有内含 `better-sqlite3` 字面量的文件，断言：
  1. 文件 import 了 `skipIfSqliteUnavailable` 并在每个外层 `test(...)` 中前置使用，OR
  2. 文件名出现在 `electronOnlyTests` allowlist (留作未来支持，初期为空数组)。
- 否则报错。
- 配套测试 `scripts/__tests__/check-sqlite-test-skip-pattern.test.cjs`。

**子任务 3d · 改造现有违规**:
- `migrations-drop-skill-executions.test.ts`: throw → `skipIfSqliteUnavailable`。
- `skill-task-run-repository.test.ts`: 5 处 `console.warn` → `skipIfSqliteUnavailable`。
- `skill-child-runner.test.ts`: 3 处 `console.warn` → `skipIfSqliteUnavailable`。

**子任务 3e · 接线**:
`verify:k` 追加 `&& node scripts/check-sqlite-test-skip-pattern.cjs && node --test scripts/__tests__/check-sqlite-test-skip-pattern.test.cjs`。

**风险**:
- R3.1: 改造后 sqlite-backed test 的"看起来更像跑了"行为变化 → 实际不变 (仍然 skip)，但 `npm run test` 输出里的 skip 标记会从 console.warn 噪声变成 node-test 原生 skip 计数。这是想要的可观察性提升。
- R3.2: 用 `requireFromHere` (源自 `skill-task-run-repository.test.ts`) 而非裸 `require` 的文件，skip helper 的 probe 会与目标 require 路径不一致 → 给 helper 设计成"接受 probe fn"以兼容多种 require 形态：
  ```ts
  export function skipIfSqliteUnavailable(t, label, probe = defaultProbe): boolean
  ```

### Task 4 · 文档同步 (§12 规约)
- `docs/superpowers/testing-conventions.md` 末尾追加 §"Stage 5 covenants"，引用 4 条合同 + canonical skip pattern + verify:k。
- `CLAUDE.md` §6.17 末尾追加：`Stage 5 起测试文件覆盖与 sqlite skip 规范由 verify:k 强制；新增测试必须出现在某个 verify:* / test:* 入口或显式豁免。`
- `AGENTS.md` 同步同样一段。

### Task 5 · 验收
按顺序：
1. `npm run verify:k` (新链) 全绿。
2. `npm run verify:j` 仍全绿 (向后兼容)。
3. `npm run verify` 全绿 (含 sqlite native + lint + test + 新 gate)。
4. 手工 sanity：临时新建 `src/__tests__/__orphan_probe.test.ts` 仅写 `test('x', () => {})`，跑 `verify:k` 应失败并指出 orphan；删除后再跑应通过。
5. 手工 sanity：临时把 `skill-task-run-repository.test.ts` 中一个 skip 改回 `console.warn`，跑 `verify:k` 应失败。

---

## 2. 不做什么 (反范围)

- **不**重写任何业务代码 (skill runtime / turn engine / tools 一律不动)。
- **不**引入第三方依赖 (`minimatch` / `glob` / `picomatch` 都不引；用 Node 18+ 自带 `fs.glob` 或自写 ≤ 30 行 mini-matcher)。
- **不**把 sqlite-backed 测试搬到 Electron runtime 跑 (那是 Stage 6+ 的工作；本期只规范 skip 形态)。
- **不**改 `npm run test` 的 glob (`src/__tests__/*.test.ts`)；保持原状，靠新 gate 反向兜底。
- **不**重构现有 `verify:a0…verify:j` 链。

---

## 3. 时序与回滚

| Phase | 步骤 | 可独立 PR? |
|---|---|---|
| P1 | Task 1 (删 orphan) | ✅ |
| P2 | Task 2 (test-coverage gate + 单测 + verify:k 接线) | ✅ |
| P3 | Task 3a–3c (skip helper + sqlite skip gate) | ✅ |
| P4 | Task 3d (3 个文件改造) | ✅ |
| P5 | Task 4 文档同步 | ✅ (可与 P2/P3 合并) |
| P6 | Task 5 验收 | — |

每 phase 独立可回滚 = `git revert <commit>`。无 DB / 状态迁移；零运行时风险。

---

## 4. 待 Codex 审查的具体疑点

请重点指出：
1. C1–C4 合同写法是否覆盖了 codex Stage 5 路线的全部三件事？是否漏了暗合同？
2. Task 2 的 glob 解析方案 (自写 mini-matcher) 是否足以覆盖 `package.json` 现有所有 `*.test.ts` 模式？是否应改为枚举 + verify-script 直接 sourcing？
3. Task 3 的 canonical skip pattern (`skipIfSqliteUnavailable` helper + 静态 grep gate) 是否会漏检"测试文件 import 了 sqlite 但不直接构造 DB"的间接路径 (例如 import 一个 module 内部用 sqlite)？
4. 把 `verify:k` 插入 top-level `verify` 而不替换现有链路，是否最小化改动？是否应该让 `verify:j` 内部就直接含 `verify:k`？
5. P4 改造可能让某些原本意外通过的断言被 skip 跳过 (因为 console.warn early-return 可能让后续断言根本不跑) → 是否需要先用 `npm run test` baseline diff?
6. 风险 R2.3 (模板拼接) 当前是否真的为零？任何已存在的 `${VAR}` 形式都必须被识别。

请给出 ACK / NACK / patch 建议；如有强反对请 reframe 而非局部缝合。
