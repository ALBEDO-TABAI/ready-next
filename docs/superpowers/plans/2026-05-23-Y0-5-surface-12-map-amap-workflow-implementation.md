---
title: Stage Y0.5.12 — Map / Amap workflow dogfood sub-plan
stage: Y0.5.12
surface_id: 12
date: 2026-05-23
status: draft-for-baseline
parent_plan: 2026-05-23-Y-ready-product-completion-and-release-hardening-roadmap.md
parent_row: §9.1 row 12
operator_class: agent-only
enforce: false
documentation_status: archived-in-place
archived_at: 2026-09-06
---

> 原位归档（2026-09-06）：固定历史证据仍引用此路径。保留此路径不代表全文仍是当前合同；其中的状态、源码位置和待办属于原记录。现行约束见 [当前运行时合同](../../architecture/current-runtime-contracts.md)，归档去向见 [文档清单](../../documentation-inventory.md)。

# Surface 12 — Map / Amap workflow

## 0. §9.1 row reference (verbatim)

- **Minimum scenario**: "Ask route planning with research/browser secondary
  signals."
- **Must prove**: "Map intent wins only when it should; research intent is
  not swallowed by map (depends on Y0.1.4 disposition)."

## 1. Detailed reproduction steps

1. Pre-check: Y0.1.4 disposition (research-vs-map routing) must be landed; if not, mark as `deferred-with-owner` (owner=Y0.1.4 owner) and stop.
2. Launch app; capture build commit. Configure Amap key per Settings.
3. **Pure route-planning ask (map should win)**: ask the agent "从中关村到三里屯怎么走". Verify the map tool fires (not research).
4. **Pure research ask (research should win)**: ask the agent "中关村和三里屯之间的历史关系". Verify research/browser fires (not map).
5. **Overlap ask (Y0.1.4 disposition decides)**: ask "三里屯今天的活动地点和路线". Verify routing matches the Y0.1.4 disposition table.
6. **Research with location mention (research should still win)**: ask "比较北京几个 IT 园区的特色". Verify research fires, not map.
7. **Route with research secondary**: ask "推荐一家三里屯的咖啡店并告诉我怎么过去". Verify the agent handles both (research + map) per spec.
8. Verify in `ready-tools.log` that the correct tool is invoked per ask; verify no double-fire (map AND research both invoked for a pure research ask).
9. Stop recording; capture `ready-tools.log` + `ready-directchat.log` + console.

## 2. Expected result decomposition (test cases)

| # | Invariant | Observable signal |
| ---: | --- | --- |
| 12.1 | Pure route ask → map tool fires | Step 3: tools log shows map tool invocation; no research call |
| 12.2 | Pure research ask → research fires, not map | Step 4: tools log shows research; no map call |
| 12.3 | Overlap ask routes per Y0.1.4 disposition | Step 5: routing matches table |
| 12.4 | Research with location → research, not map | Step 6: no map call |
| 12.5 | Route with research secondary → both invoked correctly | Step 7: both tools, no double-fire |
| 12.6 | No swallow: research intent not eaten by map | Across all asks: research-flavored asks never lose research call to map |

## 3. Pre-existing automated coverage

Extensive at the map domain + routing layer:

- `src/__tests__/map-domain-adapter.test.ts`
- `src/__tests__/map-engine-route-planner.test.ts`
- `src/__tests__/map-semantic-intent.test.ts`
- `src/__tests__/map-tool-contract.test.ts`
- `src/__tests__/research-vs-map-overlap-fixtures.test.ts`
- `src/__tests__/renderer-error-mapping.test.ts`

The research-vs-map-overlap-fixtures test is the unit-level proof of the
Y0.1.4 disposition. This dogfood adds the live invariant proof in the
assembled product.

## 4. Operator class

`agent-only` — per §9.4 row 12: "Map/research routing is deterministic once
Y0.1.4 lands; agent can verify against the overlap fixtures." `bai_spotcheck`
optional.

## 5. Evidence file path

`docs/superpowers/audits/2026-05-23-stage-y-closeout/dogfood/surface-12-map-amap-workflow.md`

Manifest: `audits/2026-05-23-stage-y-closeout/dogfood/evidence/surface-12-map-amap-workflow-manifest.json`

## 6. Acceptance

### Per §9.1 "Must prove"

- Map intent wins only when it should (tests 12.1, 12.3, 12.4, 12.5).
- Research intent is not swallowed by map (test 12.6).

### Per-test-case checks

- All 6 invariants observable in `ready-tools.log` and screencap.

### Pre-condition

- Y0.1.4 disposition (research-vs-map routing) MUST be landed before this dogfood runs. If not landed: `status: deferred-with-owner`.

### Operator-class enforcement (per §9.4)

- `operator_class: agent-only`. `bai_spotcheck` NOT required.

### Evidence schema compliance

- Per §9.2, manifest includes head-capture, screencap, `ready-tools.log`.
- Per §9.2.1, `git_status_porcelain=0`.
- Per §9.2.2, log strictly overlaps reproduction window ± 30s.
