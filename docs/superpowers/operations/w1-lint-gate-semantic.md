---
title: W1 lint gate semantic
date: 2026-05-22
stage: W0
enforce: false
parent_roadmap: docs/superpowers/plans/archive/2026-05-22-W-ready-stabilization-roadmap.md
applies_to: docs/superpowers/plans/archive/2026-05-22-W1-lint-errors-and-baseline-drift-implementation.md
documentation_status: archived-in-place
archived_at: 2026-09-06
---

> 原位归档（2026-09-06）：固定历史证据仍引用此路径。保留此路径不代表全文仍是当前合同；其中的状态、源码位置和待办属于原记录。现行约束见 [当前运行时合同](../../architecture/current-runtime-contracts.md)，归档去向见 [文档清单](../../documentation-inventory.md)。

# W1 "lint green" definition

`npm run lint:check` exits with no rule-level errors. The current warning
count (~769 as of 2026-05-22, captured in
`docs/superpowers/audits/2026-05-22-verification-snapshot/lint-check.out`)
is W2 scope, not W1.

A W1 PR that touches warnings but not errors is out of scope. A W1 PR that
resolves errors and accidentally reduces warning count is fine but must not
increase warnings beyond the snapshot baseline.

Companion gate: `node scripts/check-eslint-baseline.cjs` must also exit 0
(the 19 new / 16 stale entries captured in
`docs/superpowers/audits/2026-05-22-verification-snapshot/baseline.out` are
the W1 starting drift; W1 resolves them per-entry rather than blindly
regenerating).
