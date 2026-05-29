---
title: Plans archive index
date: 2026-05-29
enforce: false
---

# Plans archive

完成并收尾的历史 plan / roadmap / seed / audit / counter 材料归档在此目录，从活动的 `docs/superpowers/plans/` 中移出以保持索引清爽。本批次随 `codex/readyguy` 预发布收尾整理（2026-05-29）。

这些文档全部带 `enforce: false`，不参与任何 CI 强制闸门；保留是为了追溯历史决策与根因。所有指向它们的交叉引用已统一改写为 `docs/superpowers/plans/archive/<file>`。

## 归档清单（按阶段）

### Skill-runtime 子循环最终收尾（2026-04-30）
- `2026-04-30-skill-runtime-child-loop-final-closure-arrangement.md`
- `2026-04-30-skill-runtime-child-loop-final-closure-claude-counterplan.md`

### Q — skill resumability triple-fence（2026-05-07，roadmap/audit）
- `2026-05-07-Q-skill-resumability-triple-fence-roadmap.md`
- `2026-05-07-agent-resumability-root-cause-audit.md`

### R/S/T — deerflow deep-research 借鉴（2026-05-08，roadmap）
- `2026-05-08-deerflow-borrowing-roadmap.md`

### W — ready stabilization（2026-05-22，整阶段收尾）
- `2026-05-22-W-ready-stabilization-roadmap.md`
- `2026-05-22-W0-current-truth-freeze-implementation.md`
- `2026-05-22-W1-lint-errors-and-baseline-drift-implementation.md`
- `2026-05-22-W3-workbench-shell-diagnosis-implementation.md`
- `2026-05-22-W4-useagent-ownership-implementation.md`
- `2026-05-22-W5-live-dogfood-implementation.md`
- `2026-05-22-W6-release-gate-reconciliation-implementation.md`

### Y — product surface & release prep（2026-05-23，整阶段收尾）
- `2026-05-23-Y-product-surface-and-release-prep-seed.md`
- `2026-05-23-Y0-7-mcp-not-shipped-labeling-implementation.md`
- `2026-05-23-Y0-8-cache-quota-relabel-implementation.md`
- `2026-05-23-Y1-1-vea-test-reliability-implementation.md`
- `2026-05-23-Y1-3-warning-burn-implementation.md`
- `2026-05-23-Y1-4-ipc-renderer-contract-hardening-implementation.md`

### Z — release candidate（2026-05-24，整阶段收尾）
- `2026-05-24-Z-release-candidate-seed.md`
- `2026-05-24-Z0-1-release-candidate-gate-bundle-implementation.md`

## 仍留在 `plans/` 的相关文档

- **Q/R/S/T 的 `*-implementation.md`** 仍是 CLAUDE.md §8 索引的活动阶段合同，未归档；它们的 `roadmap:` / `audit:` frontmatter 现指向本目录的 `archive/<file>`。
- **三个仍被闸门按路径引用的 `enforce: false` 文档**留在 `plans/`，不可移动：
  - `2026-05-22-W2-lint-warning-debt-ledger-implementation.md`（`scripts/check-lint-warning-budget.cjs`）
  - `2026-05-22-X-trust-foundation-and-w5-recovery-implementation.md`（`scripts/check-stage-x-known-regressions.cjs`）
  - `2026-05-23-Y-ready-product-completion-and-release-hardening-roadmap.md`（`scripts/check-stage-y-p0-ledger.cjs`）
- 少量活动 plan（A0、cc-source、Q-impl、R、Y-roadmap）正文里仍以**纯文件名**（反引号）提及本目录中的文档；它们不是可解析链接，文件名唯一可检索，按历史叙述保留原样。
