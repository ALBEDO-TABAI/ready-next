---
enforce: false
archived_at: 2026-09-06
archive_reason: superseded-project-documentation
---

> 已归档（2026-09-06）：本文保留编写当时的设计、状态与证据，不是当前执行入口；归档不表示原计划全部实现。现行说明见 [当前运行时合同](../../../../../architecture/current-runtime-contracts.md)，去向见 [文档清单](../../../../../documentation-inventory.md)。

# C Pre-flight Audit Report

Date: 2026-05-01
Worktree: `/Users/user/Documents/实验田/ready-cowork/.worktrees/codex-skill-runtime-b-plan`
Branch: `codex/skill-runtime-b-plan`
Audit base: `5feca7c docs(agent): add C coordinator plan`
B acceptance base: `b2982e0 docs(agent): close B child runtime acceptance`

## Summary

- C plan file is now tracked in git before this report was created.
- B is present on the current branch through W7; W3 is not blocked by B.
- Local `main` does not contain `b2982e0`; C execution must stay on this worktree branch unless B is merged back first.
- Residual untracked file ignored by this audit: `docs/archive/2026-09-06/docs/superpowers/plans/2026-04-30-D-reminder-registry-compaction-hooks-implementation.md`.

## Commands and Results

### turn-engine product id comparisons

Command:

```bash
git grep -nP "\.id\s*===\s*['\"](browser|document|skill|rss|calendar|feishu)['\"]" src/main/modules/agent-control/turn-engine.ts
```

Result: 3 hits.

```text
src/main/modules/agent-control/turn-engine.ts:1650:      const browserDomainAdapter = domainAdapters.find((adapter) => adapter.id === 'browser') || null
src/main/modules/agent-control/turn-engine.ts:1771:        selectedDomainAdapter?.id === 'browser'
src/main/modules/agent-control/turn-engine.ts:1791:        selectedDomainAdapter?.id === 'browser'
```

Command:

```bash
git grep -nP "\.id\s*!=\s*['\"](browser|document|skill|rss|calendar|feishu)['\"]" src/main/modules/agent-control/turn-engine.ts
```

Result: 0 hits.

### turn-engine single-product imports

Command:

```bash
git grep -n "import" src/main/modules/agent-control/turn-engine.ts | grep -E "(browser-tools|document-domain-helpers|document-task-pipeline|skills-tools)"
```

Result: 0 hits.

### prompt-assembly hardcoded TRIGGERS

Source: `src/main/modules/agent-control/prompt-assembly.ts:130-203`

Result: 6 product trigger entries.

| id | module | blocking | owner |
| --- | --- | --- | --- |
| `feishu-doc` | `feishu` | `true` | W2 |
| `feishu-image` | `feishu` | `true` | W2 |
| `browser-upload` | `browser` | `false` | W5 |
| `document-write` | `document` | `false` | W4 |
| `rss-analysis` | `rss` | `false` | W2 |
| `calendar-write` | `calendar` | `true` | W2 |

Bucket counts:

- `feishu`: 2
- `browser`: 1
- `document`: 1
- `rss`: 1
- `calendar`: 1
- `skill`: 0
- `system` / `undefined`: 0

### turn-engine hardcoded coordinator fields

Command:

```bash
git grep -nP "shouldHideBrowserProcessText|forceDocumentTool|browserDecisionMode" src/main/modules/agent-control/turn-engine.ts
```

Result: 16 raw hits.

```text
src/main/modules/agent-control/turn-engine.ts:736:  browserDecisionMode?: string | null
src/main/modules/agent-control/turn-engine.ts:762:    browserDecisionMode: params.browserDecisionMode || null,
src/main/modules/agent-control/turn-engine.ts:847:  // forceDocumentTool x browser_workflow and related conflicts. If a violation
src/main/modules/agent-control/turn-engine.ts:1532:        browserDecisionMode: browserDecision.mode as any,
src/main/modules/agent-control/turn-engine.ts:1548:        browserDecisionMode: browserDecision.mode,
src/main/modules/agent-control/turn-engine.ts:1576:        Boolean((toolPolicy as any).forceDocumentTool)
src/main/modules/agent-control/turn-engine.ts:1674:        browserDecisionMode: browserDecision.mode as any,
src/main/modules/agent-control/turn-engine.ts:1683:        browserDecisionMode: browserDecision.mode,
src/main/modules/agent-control/turn-engine.ts:1790:      const shouldHideBrowserProcessText =
src/main/modules/agent-control/turn-engine.ts:2490:          browserDecisionMode: browserDecision.mode,
src/main/modules/agent-control/turn-engine.ts:2719:              browserDecisionMode: browserDecision.mode,
src/main/modules/agent-control/turn-engine.ts:2886:            if (!shouldHideBrowserProcessText || genericInteractionDetected) {
src/main/modules/agent-control/turn-engine.ts:2905:          if (response.text && response.toolTransport !== 'text' && !shouldHideBrowserProcessText) {
src/main/modules/agent-control/turn-engine.ts:3260:            if (!shouldHideBrowserProcessText) {
src/main/modules/agent-control/turn-engine.ts:3294:            if (!shouldHideBrowserProcessText) {
src/main/modules/agent-control/turn-engine.ts:3327:            if (!shouldHideBrowserProcessText) {
```

Breakdown:

- `browserDecisionMode`: 9 raw hits.
- `forceDocumentTool`: 2 raw hits, including 1 comment and 1 direct read.
- `shouldHideBrowserProcessText`: 5 raw hits.

## B Land Status

Commands:

```bash
git log --oneline --decorate -10
git branch --contains b2982e0 --all
git merge-base --is-ancestor fdf73f1 HEAD
git merge-base --is-ancestor b2982e0 main
```

Results:

- Current branch contains `b2982e0`.
- Current branch contains `fdf73f1`, so B W4 cleanup unification is present.
- `main` does not contain `b2982e0` in this local checkout.
- W3 can run in this worktree branch, but C should not be restarted from local `main` without first landing B.

## Execution Notes for W1-W7

- W1 may proceed; no W0 blocker found.
- W2 owns `feishu-doc`, `feishu-image`, `rss-analysis`, and `calendar-write`.
- W4 owns `document-write` and the `forceDocumentTool` direct read.
- W5 owns `browser-upload`, `browserDecisionMode` coordination, and `shouldHideBrowserProcessText`.
- W3 has no hardcoded skill TRIGGER to migrate, but must verify SkillDomainAdapter does not reach into B child runtime territory.
