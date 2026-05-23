/**
 * Stage Y0.1.4 — research-vs-map domain-adapter overlap fixtures.
 *
 * Purpose (per plan §6.4 decision tree step 1):
 *   Establish whether MapDomainAdapter and ResearchDomainAdapter have a
 *   **real** routing conflict (both `shouldHandle` return true for the same
 *   `DomainAdapterSelectionContext`) or an **apparent** one (their triggers
 *   are read from disjoint upstream signals so they cannot both fire).
 *
 * Method:
 *   For 4 representative queries (pure-route, pure-research, ambiguous-overlap,
 *   research-with-map-keywords) we construct the minimum
 *   `DomainAdapterSelectionContext` that mirrors what production upstream
 *   (turn-engine.ts:1445-1481) feeds into `selectDomainAdapter`. We then call
 *   each adapter's `shouldHandle` independently AND call `selectDomainAdapter`
 *   under both orderings (Map-first, Research-first). The 4×2 = 8 outcomes
 *   are asserted verbatim. The decision-fixture evidence is recorded in
 *   `docs/superpowers/audits/2026-05-23-stage-y-closeout/y0-1-4-research-map-routing-decision.md`.
 *
 * Production-upstream invariants we encode in the fixtures:
 *   - `applyMapSemanticIntentToIntentClassification` (map-semantic-intent.ts:194)
 *     overwrites `intent.primaryDomain → 'map'` when map intent is active.
 *   - `task-type-resolver.ts:141-156` then maps `primaryDomain === 'research'`
 *     to `taskType: 'research', executor: 'research'` and
 *     `primaryDomain === 'map'` to `taskType: 'short_task', executor: 'map'`.
 *   - `turn-engine.ts:1463` keeps continuationResearchHint only when
 *     `!isMapSemanticIntentActive(mapSemanticIntent)`.
 *   So a real production turn never simultaneously has
 *   (`isMapSemanticIntentActive === true`) AND
 *   (`route.taskType === 'research'` OR `route.executor === 'research'`).
 *
 * The "ambiguous" + "research-with-map-keywords" fixtures intentionally test
 * the realistic upstream output for those phrasings — NOT a synthetic
 * impossible state — so the assertion captures genuine routing semantics.
 */
import test from 'node:test'
import assert from 'node:assert/strict'

import { MapDomainAdapter } from '../main/modules/agent-control/map-domain-adapter'
import { ResearchDomainAdapter } from '../main/modules/agent-control/domain-adapters/research-domain-adapter'
import {
  selectDomainAdapter,
  type DomainAdapter,
  type DomainAdapterSelectionContext,
} from '../main/modules/agent-control/domain-adapters/domain-adapter'

type Executor = DomainAdapterSelectionContext['route']['executor']
type TaskType = DomainAdapterSelectionContext['route']['taskType']

function buildRoute(taskType: TaskType, executor: Executor): DomainAdapterSelectionContext['route'] {
  return {
    taskId: 'task-overlap',
    taskType,
    chain: 'tool_loop',
    executor,
    steps: [],
    continuation: null,
  }
}

function buildContext(params: {
  userText: string
  route: DomainAdapterSelectionContext['route']
  mapSemanticIntentActive: boolean
}): DomainAdapterSelectionContext {
  return {
    route: params.route,
    userText: params.userText,
    hasTools: true,
    executionIntentContext: {
      mapSemanticIntent: params.mapSemanticIntentActive
        ? {
            isMapIntent: true,
            primaryTask: 'route',
            secondarySignals: [],
            confidence: 0.8,
          }
        : null,
    } as never,
  }
}

interface Outcome {
  query: string
  mapShouldHandle: boolean
  researchShouldHandle: boolean
  mapFirstPick: string | null
  researchFirstPick: string | null
}

function probe(query: string, ctx: DomainAdapterSelectionContext): Outcome {
  const map = new MapDomainAdapter()
  const research = new ResearchDomainAdapter()
  const mapFirst: DomainAdapter[] = [map, research]
  const researchFirst: DomainAdapter[] = [research, map]
  return {
    query,
    mapShouldHandle: map.shouldHandle(ctx),
    researchShouldHandle: research.shouldHandle(ctx),
    mapFirstPick: selectDomainAdapter(mapFirst, ctx)?.id ?? null,
    researchFirstPick: selectDomainAdapter(researchFirst, ctx)?.id ?? null,
  }
}

test('Query A (pure route): upstream produces map intent, neither order swallows it', () => {
  // "how do I drive to Beijing Capital Airport"
  // Upstream: classifyMapSemanticIntent fires → primaryDomain overwritten to
  // 'map' → task-type-resolver returns executor 'map', taskType 'short_task'.
  // Research's shouldHandle gate (taskType === 'research' || executor ===
  // 'research') is false. Map's shouldHandle (isMapSemanticIntentActive) is
  // true. Order is irrelevant.
  const outcome = probe('how do I drive to Beijing Capital Airport', buildContext({
    userText: 'how do I drive to Beijing Capital Airport',
    route: buildRoute('short_task', 'map'),
    mapSemanticIntentActive: true,
  }))
  assert.equal(outcome.mapShouldHandle, true, 'Query A: map.shouldHandle')
  assert.equal(outcome.researchShouldHandle, false, 'Query A: research.shouldHandle')
  assert.equal(outcome.mapFirstPick, 'map', 'Query A: map-first picks map')
  assert.equal(outcome.researchFirstPick, 'map', 'Query A: research-first still picks map (research declined)')
})

test('Query B (pure research): upstream produces research route, neither order swallows it', () => {
  // "research the latest GPT-5 benchmarks"
  // Upstream: classifyMapSemanticIntent declines (no route signal) →
  // primaryDomain stays 'research' → task-type-resolver returns taskType
  // 'research', executor 'research'. Map's shouldHandle is false (no active
  // map intent). Research's shouldHandle is true. Order is irrelevant.
  const outcome = probe('research the latest GPT-5 benchmarks', buildContext({
    userText: 'research the latest GPT-5 benchmarks',
    route: buildRoute('research', 'research'),
    mapSemanticIntentActive: false,
  }))
  assert.equal(outcome.mapShouldHandle, false, 'Query B: map.shouldHandle')
  assert.equal(outcome.researchShouldHandle, true, 'Query B: research.shouldHandle')
  assert.equal(outcome.mapFirstPick, 'research', 'Query B: map-first picks research (map declined)')
  assert.equal(outcome.researchFirstPick, 'research', 'Query B: research-first picks research')
})

test('Query C (ambiguous overlap): mapSemanticIntent wins upstream → research not on route', () => {
  // "research the fastest route from Shanghai to Beijing — should I drive or fly"
  // Upstream behavior: classifyMapSemanticIntent fires (drive + endpoint
  // signals) → applyMapSemanticIntentToIntentClassification overwrites
  // primaryDomain → 'map'. task-type-resolver returns executor 'map'
  // (preferredExecutor for primaryDomain 'map'); taskType 'short_task'.
  // turn-engine.ts:1463 explicitly suppresses the continuationResearchHint
  // when map intent is active. So the production
  // `DomainAdapterSelectionContext` for this query has:
  //   - mapSemanticIntent active
  //   - route.taskType !== 'research', route.executor !== 'research'
  // Research's shouldHandle declines; Map wins under both orderings.
  const outcome = probe('research the fastest route from Shanghai to Beijing — should I drive or fly', buildContext({
    userText: 'research the fastest route from Shanghai to Beijing — should I drive or fly',
    route: buildRoute('short_task', 'map'),
    mapSemanticIntentActive: true,
  }))
  assert.equal(outcome.mapShouldHandle, true, 'Query C: map.shouldHandle')
  assert.equal(outcome.researchShouldHandle, false, 'Query C: research.shouldHandle')
  assert.equal(outcome.mapFirstPick, 'map', 'Query C: map-first picks map')
  assert.equal(outcome.researchFirstPick, 'map', 'Query C: research-first still picks map (research declined)')
})

test('Query D (research with map keyword): no map signal upstream → research route', () => {
  // "compare the COVID-19 case map across countries in 2024"
  // "map" here is a noun (data visualization) — not a routing/navigation
  // signal. classifyMapSemanticIntent's hasPotentialMapSignal regex
  // requires an actual route/endpoint/transport token; "case map across
  // countries" does not match. So mapSemanticIntent is null and
  // primaryDomain stays 'research'. task-type-resolver returns taskType
  // 'research', executor 'research'. Map's shouldHandle is false (no
  // active map intent). Research's shouldHandle is true.
  const outcome = probe('compare the COVID-19 case map across countries in 2024', buildContext({
    userText: 'compare the COVID-19 case map across countries in 2024',
    route: buildRoute('research', 'research'),
    mapSemanticIntentActive: false,
  }))
  assert.equal(outcome.mapShouldHandle, false, 'Query D: map.shouldHandle')
  assert.equal(outcome.researchShouldHandle, true, 'Query D: research.shouldHandle')
  assert.equal(outcome.mapFirstPick, 'research', 'Query D: map-first picks research (map declined)')
  assert.equal(outcome.researchFirstPick, 'research', 'Query D: research-first picks research')
})

test('Conflict classification: APPARENT (no query has both shouldHandle return true under realistic upstream)', () => {
  // The 4 queries above collectively prove the conflict is APPARENT, not
  // REAL: each query has at most ONE of {map, research} returning true
  // from shouldHandle. Therefore array ordering between Map and Research
  // in `direct-chat.ts` `domainAdapters[]` cannot change selection outcome
  // for any of the representative phrasings. This justifies path
  // (a-reorder) per plan §6.4 decision tree branch "Apparent conflict".
  const queries: Array<{ q: string; ctx: DomainAdapterSelectionContext }> = [
    { q: 'A', ctx: buildContext({ userText: 'how do I drive to Beijing Capital Airport', route: buildRoute('short_task', 'map'), mapSemanticIntentActive: true }) },
    { q: 'B', ctx: buildContext({ userText: 'research the latest GPT-5 benchmarks', route: buildRoute('research', 'research'), mapSemanticIntentActive: false }) },
    { q: 'C', ctx: buildContext({ userText: 'research the fastest route from Shanghai to Beijing — should I drive or fly', route: buildRoute('short_task', 'map'), mapSemanticIntentActive: true }) },
    { q: 'D', ctx: buildContext({ userText: 'compare the COVID-19 case map across countries in 2024', route: buildRoute('research', 'research'), mapSemanticIntentActive: false }) },
  ]
  for (const { q, ctx } of queries) {
    const outcome = probe(q, ctx)
    const both = outcome.mapShouldHandle && outcome.researchShouldHandle
    assert.equal(both, false, `Query ${q}: both shouldHandle returning true would indicate a REAL conflict`)
    assert.equal(
      outcome.mapFirstPick,
      outcome.researchFirstPick,
      `Query ${q}: ordering changes selection (would indicate REAL conflict)`,
    )
  }
})
