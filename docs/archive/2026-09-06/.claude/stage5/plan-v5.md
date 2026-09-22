---
enforce: false
archived_at: 2026-09-06
archive_reason: superseded-project-documentation
---

> 已归档（2026-09-06）：本文保留编写当时的设计、状态与证据，不是当前执行入口；归档不表示原计划全部实现。现行说明见 [当前运行时合同](../../../../architecture/current-runtime-contracts.md)，去向见 [文档清单](../../../../documentation-inventory.md)。

# Stage 5 — Test-coverage hard gates (Plan v5)

> 上一版: plan-v4.md (Codex round-4 → patch A only).  
> v5 变更原因: 修一条 round-4 patch — `import 'better-sqlite3'`（side-effect import）形态 v4 regex 漏检；T14 单测会失败。  
> v5 是相对 v4 的最小补丁，其它章节全部 by reference 引用 v4。

---

## 唯一变更：side-effect import 检测

**v4 §0**：
```ts
const SQLITE_LOAD_FORMS = [
  /\brequire\(\s*['"]better-sqlite3['"]\s*\)/,
  /\bawait\s+import\(\s*['"]better-sqlite3['"]\s*\)/,
] as const;
```

**v5 §0**（新增第 3 条 regex）：
```ts
const SQLITE_LOAD_FORMS = [
  /\brequire\(\s*['"]better-sqlite3['"]\s*\)/,
  /\bawait\s+import\(\s*['"]better-sqlite3['"]\s*\)/,
  // v5: side-effect import — `import 'better-sqlite3'` / `import "better-sqlite3";`
  // 行首 `import` 直接接字符串字面量；不允许中间夹 `type` / 标识符。
  /^\s*import\s+['"]better-sqlite3['"]/m,
] as const;

// isDirectFromBetterSqlite3 (v4 引入) 不变 — 处理 `import ... from 'better-sqlite3'` 的 type-aware 路径。
```

> side-effect import 不存在 type-only 形态（语义上必然触发 runtime 加载），所以无需 type 排除分支。`m` flag 让 `^` 在多行文本里按行起锚。

---

## 单测确认

v4 §3c 已经写了 T14：

> T14 (v4 新增) `import 'better-sqlite3'` (副作用 import) **命中** C3——`from` 形态匹配。

v5 修正 T14 注解为「**命中** C3——side-effect form (`SQLITE_LOAD_FORMS[2]`) 匹配」，不再依赖 `from`。

---

## 与 Codex round-4 review 的对应

| Round-4 issue | 严重 | v5 处理 |
|---|---|---|
| Patch A — `import 'better-sqlite3'` 漏检 | patch | 新增第 3 条 regex `/^\s*import\s+['"]better-sqlite3['"]/m`；T14 注解修正 |

---

## 其余章节

§1–§6 全部沿用 v4，不重复列出。Task 1 / Task 2 / Task 3 (3a/3b/3c/3d/3e) / Task 4 / Task 5 / 风险登记 / 时序与回滚都不变。

---

## v5 待审查疑点

无。这是一个一行修复；如果 codex round-5 仍有意见，预期是新角度而非这条遗留。
