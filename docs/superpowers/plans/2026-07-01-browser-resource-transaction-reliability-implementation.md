---
title: Browser Resource And Transaction Reliability Implementation
date: 2026-07-01
status: implementation
enforce: true
source:
  - docs/superpowers/plans/2026-07-01-browser-resource-transaction-reliability-diagnosis.md
  - docs/superpowers/plans/2026-06-29-web-access-capability-integration-spec.md
  - docs/superpowers/plans/2026-06-30-power-browser-authorization-implementation.md
  - /Users/user/.codex/attachments/4c6ca2a1-bb6e-4282-bc61-95f94a20eae5/pasted-text.txt
---

# Browser Resource And Transaction Reliability Implementation

## Goal

Make Ready's browser agent reliable for dynamic browser tasks that cross
publishing, visual/media analysis, and account-page collection.

The target user experience:

1. Xiaohongshu creator publishing does not stop in a blind loop after a Power
   tool error.
2. A browser tab dragged into the file manager exposes appropriate analysis
   actions based on the actual page/resource, including Xiaohongshu notes.
3. Xiaohongshu account-page collection freezes real note targets, not global
   navigation.
4. If a task cannot complete, Ready shows a recoverable reason and the exact
   next action rather than a generic failed card.

## Assumptions

1. Ready remains the browser host. No external `web-access` fallback is added.
2. Power Browser authorization from
   `2026-06-30-power-browser-authorization-implementation.md` remains the
   safety contract.
3. Staged user site cards must not enter prompt injection. Bundled active site
   cards may still be used.
4. The implementation must prefer deterministic routing, classification, and
   verdicts over model-only judgment.
5. Xiaohongshu is the regression surface, not a one-off script target.

## Completion Criteria

This plan is complete when all are true:

1. A Power eval/CDP failure still preserves browser action-session state and a
   next suggested action.
2. Browser transactions without success proof end as
   `browser_transaction_unconfirmed`, not generic `proof_gap`.
3. `run_meta`, `task_projections`, and finalizer metrics agree on
   `browser_transaction` for browser publishing/submission tasks.
4. A single classifier can identify at least:
   - generic webpage
   - video candidate
   - Xiaohongshu note
   - Xiaohongshu account/profile
   - Xiaohongshu creator/editor
5. Drag-menu analysis actions and backend visual analysis consume the same
   classification/preflight result.
6. Xiaohongshu account collection rejects polluted navigation-heavy target
   lists.
7. Site-card injection can use the current tab domain, not only user text.
8. Xiaohongshu collection candidates carry enough structural context to tell
   content-grid links from global navigation links, or explicitly degrade when
   that context is unavailable.
9. A named verification entry, `npm run verify:browser-reliability`, runs the
   focused browser reliability tests and single-source gates.
10. A gate prevents duplicated video-host whitelist / `isLikelyVideo*` logic from
   reappearing outside the classifier/preflight module.
11. Focused tests and the three live regressions pass after a full Ready
   restart.

## Phase 0: Current-Truth Verification

Do this before editing behavior. The goal is to avoid fixing a stale-process
ghost or the wrong loss point.

### V0-1 Restart on current source

Restart the dev app or installed app under test and record:

- source commit
- process start time
- whether `/Applications/Ready.app` or `electron-vite dev` is being tested
- current `ready-agent-metrics.log` and `ready-tools.log` timestamps

Acceptance:

- Logs created after restart reflect the same source under test.
- `browser_analyze_viewport` accepts `input`; if it does not, the process is
  not running current source.

### V0-2 Reproduce Xiaohongshu publish classification

Run one clean minimal prompt such as "从当前小红书创作页面发一条长文笔记，内容是今天天气不错".
Do not reuse a run polluted by browser-discipline debug prompts or an old
conversation that may change the task title.

Capture:

- intent primary domain
- `BrowserWorkflowIntent`
- task-type resolver output
- task-budget runtime task type
- projection truth task type
- `taskProjectionStore.get(taskId).taskType` at finalization time
- `resolveEffectiveTaskFacts(...)` source hit:
  `projectionPatch`, projection row, budget runtime, or fallback
- finalizer effective facts
- `run_meta.task_type`
- `task_projections.task_type`

Decision:

- If intent is not browser, fix intent/domain classification first.
- If intent is browser but budget runtime is `short_task`, fix budget runtime
  propagation.
- If final projection is `browser_transaction` but finalizer-time facts are not,
  fix the write-order/truth-source seam before finalization.
- If finalizer-time facts are `browser_transaction` but `run_meta` is not, fix
  run-meta writing to use those effective facts.

Do not implement A2 before this decision is made.

### V0-3 Snapshot the two non-publish regressions

After restart:

1. Drag a Xiaohongshu note tab into the file manager and record menu actions.
2. Run visible collection on a Xiaohongshu profile and inspect frozen targets.
3. Confirm whether each extracted account-page candidate includes structural
   context such as nearest `nav`/`aside`/`header`/`[role=navigation]` ancestor,
   container role, or content-grid marker.

Acceptance:

- Existing failures are reproducible or explicitly marked stale.

## Phase 1: Stop Blind Failure Loops

This phase is intentionally small. It repairs recovery state without yet
rewiring every consumer to the new classifier.

### A1: Structured Power tool failure output

Scope:

- `browser_power_eval`
- `browser_power_cdp`
- `browser_power_network_trace`
- `browser_power_resource_forensics` where applicable

Behavior:

1. A Power tool failure must return structured JSON or an equivalent tool
   output envelope.
2. The output must preserve:
   - `ok: false`
   - `tool`
   - `tabId`
   - `frameId`
   - `currentUrl`
   - `origin`
   - `errorKind`
   - `errorSummary`
   - `codeSummary` or method summary where relevant
   - `nextSuggestedAction`
   - Browser Action Session patch
3. It must not bypass Power authorization or audit.
4. It must not expose raw secrets, cookies, or full scripts in normal output.
5. Failure patches must be additive. They may preserve or refine target and
   recovery state, but must not clear an existing target, clear existing
   confirmation evidence, or set `transactionStatus` to `confirmed`.

Suggested next actions:

- syntax/runtime eval error on top frame:
  `retry browser_power_eval with wrapped async function or use browser_power_cdp Runtime.evaluate for exception details`
- iframe/OOPIF suspicion:
  `use browser_power_cdp Page.getFrameTree then retry with frame_id`
- stale/closed target:
  `use browser_get_tabs and rebind BrowserActionSession target`
- timeout:
  `reduce probe scope or use resource_forensics/network_trace`

Acceptance:

- A failing `browser_power_eval` no longer returns only
  `Error executing browser_power_eval`.
- The next model turn sees target tab, URL, frame, and a recovery hint.
- A browser transaction projection keeps its action-session state after the
  failure.

Tests:

- Unit test for failing eval returning structured state.
- Unit test for frame eval failure preserving `frameId`.
- Regression test that failure output updates Browser Action Session.

### A2: Browser transaction task-type continuity

Only implement after V0-2 identifies the loss point.

Possible fixes:

1. If intent classification is wrong:
   - update browser workflow intent/domain routing so publish/submit/upload/form
     tasks with current browser page context resolve to browser transaction.
2. If budget runtime is wrong:
   - ensure `resolveTaskTypeFromBrowserWorkflowText(...)` and tool-definition
     inference cannot downgrade a transaction to `short_task`.
3. If final projection truth is right but finalizer-time facts are stale:
   - persist `browser_transaction` into a finalizer synchronous source before
     finalization runs, such as budget runtime, outcome-level facts, or the
     terminal projection patch.
4. If finalizer-time effective facts are right but `run_meta` is wrong:
   - make `writeRunMetaOutcome(...)` record effective task facts, not only
     `outcome.taskBudgetRuntime`.

Required behavior:

- Browser transaction without confirmation proof ends as:
  - `status=error` or recoverable terminal state as currently mapped
  - `terminal_reason=browser_transaction_unconfirmed`
  - user-visible copy: "网页操作还没有成功证据，可以继续这项任务。"
- It must not end as generic `proof_gap` when task facts say
  `browser_transaction`.

Acceptance:

- `run_meta.task_type` and `task_projections.task_type` agree for the
  Xiaohongshu publish regression.
- Finalizer run-close metrics report `taskType=browser_transaction`.
- UI does not show a misleading generic failure for unconfirmed publish tasks.

Tests:

- Existing projection says `browser_transaction`, budget runtime absent or stale
  -> finalizer writes browser transaction outcome.
- Browser transaction with no `transaction_confirmed` proof ->
  `browser_transaction_unconfirmed`.
- Browser transaction truth written after finalization is not sufficient; the
  test must assert the finalizer sees the transaction type before it resolves
  terminal reason.
- Non-browser direct answers keep existing proof-gap behavior.

## Phase 2: Browser Tab Resource Classifier Contract

This phase introduces the shared deterministic classifier. It should be small
and explicit. Do not turn it into a large site framework.

### P2-1 Add shared classifier

Place the shared classifier at:

```text
src/shared/browser-tab-resource-classifier.ts
```

It must live in `src/shared/` because the renderer drag menu and the main-process
visual-analysis backend must import the same source. A main-only classifier would
make the single-source gate unenforceable.

Add a code-owned classifier, for example:

```ts
export type BrowserTabResourceKind =
  | 'generic'
  | 'video_candidate'
  | 'xhs_note'
  | 'xhs_account'
  | 'xhs_creator_editor'
  | 'xhs_creator_upload'

export interface BrowserTabResourceClassification {
  kind: BrowserTabResourceKind
  url: string
  origin: string
  host: string
  siteKey?: string
  confidence: 'low' | 'medium' | 'high'
  evidence: string[]
  hasLikelyVideo: boolean
  shouldSniffResources: boolean
  supportedActions: Array<'web_clip' | 'content_study' | 'copy_analysis' | 'visual_analysis' | 'profile_collect' | 'publish_transaction'>
}
```

The classifier can start with URL and host facts, then optionally accept sniffed
resource hints later. It must not require model judgment.

Minimum Xiaohongshu rules:

- `creator.xiaohongshu.com/publish` ->
  `xhs_creator_editor` or `xhs_creator_upload` depending on path/page hints.
- `www.xiaohongshu.com/user/profile/...` -> `xhs_account`.
- `www.xiaohongshu.com/explore/<stable-id>` -> `xhs_note`.
- `www.xiaohongshu.com/explore/<stable-id>?xsec_token=...&xsec_source=...`
  -> `xhs_note`.
- `www.xiaohongshu.com/discovery/item/<stable-id>` -> `xhs_note`.
- `www.xiaohongshu.com/discovery/item/<stable-id>?xsec_token=...`
  -> `xhs_note`.
- Xiaohongshu note pages are visual-analysis candidates only after resource
  sniffing or a high-confidence media hint.

For Xiaohongshu note links, preserve the operational `openUrl` query. Do not
strip `xsec_token` or `xsec_source` before opening details. Dedupe by stable
note id plus site key, not by the full token-bearing URL.

Minimum generic video rules:

- existing YouTube/Bilibili/Douyin/TikTok direct hints still map to
  `video_candidate`.
- direct video file extensions still map to `video_candidate`.

Acceptance:

- Existing duplicated frontend/backend video whitelist logic can be replaced or
  routed through the classifier.
- Classifier tests cover all rules above.
- The classifier returns evidence strings so wrong classifications are
  debuggable.
- Renderer and main-process consumers import the shared classifier from
  `src/shared/browser-tab-resource-classifier.ts`.

### P2-2 Add optional preflight resource sniff result

Add a small preflight shape used by visual analysis and drag menu:

```ts
export type BrowserMediaPreflightStatus =
  | 'video_found'
  | 'video_possible'
  | 'no_video_found'
  | 'needs_playback_or_scroll'
  | 'unsupported'

export interface BrowserMediaPreflightResult {
  status: BrowserMediaPreflightStatus
  candidates: Array<{ url: string; kind: string; source: string; score: number }>
  message: string
}
```

Use existing `resource-sniffer.ts` wherever possible. Do not add a separate
media sniffer unless the existing one cannot cover the required signal.

### P2-3 Add candidate structural context

Before Phase 3C can use structural navigation exclusion, the extraction layer
must carry structure metadata with each candidate. Extend the relevant
capability-service/page extraction template output so collection candidates can
include a compact context object, for example:

```ts
export interface BrowserCandidateStructureContext {
  nearestSemanticAncestor?: 'nav' | 'aside' | 'header' | 'main' | 'article' | 'section'
  nearestRole?: string
  inNavigationRegion?: boolean
  inSidebarRegion?: boolean
  inHeaderRegion?: boolean
  inMainContentRegion?: boolean
  containerLabel?: string
  containerClassHint?: string
}
```

This context can live in `rawFields.structure` or a similarly typed field that
survives `BrowserStructuredItem` handoff into `deriveCollectionTargets(...)`.

Acceptance:

- At least the generic card/list extraction path can emit structure context for
  each link candidate.
- Missing structure context is explicit, not silent. The collection-quality path
  must mark that it degraded to URL/path evidence and log that degradation.
- Structural context is compact and does not dump large DOM fragments.

Tests:

- extraction fixture: link inside `nav` emits `inNavigationRegion=true`.
- extraction fixture: link inside main content/card grid emits
  `inMainContentRegion=true` or no navigation flag.
- collection fixture: missing structure context produces a degraded quality
  reason rather than silently relying only on token blacklist.

## Phase 3: Wire Consumers To The Classifier

### B: Drag menu and visual backend

Renderer:

- Replace `isLikelyVideoDropPayload(...)` host checks with classifier output.
- For a browser tab payload, classify by URL immediately.
- If `supportedActions` includes `visual_analysis`, show `视觉分析`.
- If classification is `xhs_note` but video is only possible, show
  `视觉分析` with backend preflight responsibility.

Backend:

- Replace `isLikelyVideoLink(...)` as the only visual-analysis gate.
- Run media preflight before starting the video analyzer.
- If `video_found`, continue with the visual analyzer.
- If `video_possible` or `needs_playback_or_scroll`, return a clear
  recoverable message or run resource sniffing/playback steps if available.
- If `no_video_found`, fail gracefully and suggest `内容学习` or `文案分析`.

Acceptance:

- Xiaohongshu note browser-tab drag can show `视觉分析`.
- Non-video Xiaohongshu notes do not crash into a hard backend exception.
- YouTube/Douyin/Bilibili behavior does not regress.

Tests:

- renderer menu test for Xiaohongshu note URL.
- backend visual preflight test for Xiaohongshu note with no video candidate.
- backend visual preflight test for direct video URL.

### C: Xiaohongshu account collection target quality

Add deterministic filtering for Xiaohongshu profile pages.

Target rules:

- Accept stable note URLs:
  - `/explore/<id>`
  - `/explore/<id>?xsec_token=...&xsec_source=...`
  - `/discovery/item/<id>`
  - `/discovery/item/<id>?xsec_token=...`
  - stable profile-card note links if discovered in page data.
- Preserve token-bearing `openUrl` for actual page opening.
- Dedupe by stable note id, not by the whole query-bearing URL.
- Reject navigation and global surfaces primarily by structure:
  - links inside `nav`, `aside`, `header`, sidebar containers, or navigation
    roles
  - links whose nearby container is a global menu, channel rail, or sidebar
  - links without stable note id on an account/profile page
- Use token/path blacklist only as fallback evidence:
  - home/explore channel without stable id
  - search
  - live/livelist
  - red video channel pages
  - AI chat
- account/settings/message/login/register
- Use URL shape, DOM/container context, and page data when available.
- Do not rely only on fragile CSS classes.
- If structure context is missing, explicitly degrade with a logged reason such
  as `collection_structure_context_missing`; do not silently treat URL/path
  blacklist as the primary filter.

Add a target-quality verdict:

```ts
export type CollectionTargetQuality =
  | 'trustworthy'
  | 'suspect_navigation_pollution'
  | 'empty'
  | 'needs_content_area_relocation'
```

`collection-verdict.ts` must not return completed when quality is
`suspect_navigation_pollution` or `needs_content_area_relocation`.

Acceptance:

- A list containing mostly navigation links is paused/failed with a clear reason
  and next action.
- A profile grid containing stable note links can proceed to
  `browser_collect_notes`.
- `allow_partial` does not bypass polluted-list rejection.

Tests:

- `deriveCollectionTargets(...)` filters Xiaohongshu global nav links.
- structural nav/aside/header candidates are rejected before token blacklist
  fallback.
- profile note URLs are retained and deduped.
- token-bearing profile note `openUrl` is preserved while note identity dedupes
  by stable id.
- missing structure context is surfaced in the result/progress diagnostics.
- `resolveCollectionVerdict(...)` rejects polluted high-count lists.

### D: Site-card prompt context

Prompt injection:

- Site-card fragments should match current active browser tab domain when a
  browser task is active.
- User-text alias matching can remain as fallback.
- Staged user cards still must be skipped.

Deterministic Xiaohongshu extraction facts must live in the classifier and the
collection-quality path from P2/C. Do not create a third site-strategy home in
this phase.

Acceptance:

- Multi-step browser turns keep Xiaohongshu site context even when the latest
  user-visible step does not repeat "小红书".
- Site-card guidance is not the only protection against polluted target lists.

Tests:

- site-card prompt fragment matches active tab domain.
- staged user override still skipped.
- bundled card still available.

## Phase 4: Verification

### Focused automated tests

Run the smallest relevant focused tests first:

```bash
npm run typecheck
```

Add or update focused tests for:

- classifier contract
- candidate structural context extraction
- renderer drag menu classification
- visual-analysis backend preflight
- `browser_power_eval` structured failure
- browser transaction finalizer/run-meta continuity
- Xiaohongshu collection target filtering
- collection polluted-list verdict
- site-card active-tab-domain matching

Then run:

```bash
npm run verify:browser-reliability
npm run verify:native
npm run verify:stability
```

If existing unrelated failures appear, document them with exact failing tests
and evidence. Do not claim green on skipped or unrelated broken paths.

### Live regression tests

After a full Ready restart on current source:

1. Xiaohongshu creator long-form publish:
   - agent reaches editor or reports a recoverable next step
   - no blind `read map again` loop after Power eval failure
   - no generic `proof_gap` for unconfirmed transaction
2. Xiaohongshu note tab drag:
   - file manager menu shows expected actions
   - visual analysis either starts from sniffed video or clearly says no video
     was found and suggests another action
3. Xiaohongshu account-page collection:
   - frozen list contains stable note targets
   - navigation/sidebar links are excluded
   - polluted list cannot be marked completed

### Ledger checks

Use SQLite after live tests:

```sql
SELECT run_id, task_id, status, terminal_reason, task_type, updated_at
FROM run_meta
ORDER BY updated_at DESC LIMIT 10;

SELECT task_id, status, interaction_state, task_type, blocked_reason, progress_json
FROM task_projections
ORDER BY updated_at DESC LIMIT 10;

SELECT id, kind, status, payload_json, result_json, error
FROM browser_tasks
ORDER BY updated_at DESC LIMIT 10;
```

Acceptance:

- `verify:browser-reliability` includes classifier, Power failure, visual
  preflight, transaction finalizer, structural candidate context, collection
  quality, site-card prompt, and duplicate-classifier gate coverage.
- Run and projection task types agree for publish tasks.
- Browser transaction unconfirmed is visible as recoverable.
- Account collection results show real note targets or a clear polluted-list
  blocker.

### Single-source gates

Add a gate similar in spirit to the existing browser-route/finalizer gates:

```bash
node scripts/check-browser-resource-classifier-single-source.cjs
```

The gate must fail when:

- a second video-host whitelist appears outside the classifier/preflight module
- `isLikelyVideoDropPayload(...)` or `isLikelyVideoLink(...)` is reintroduced as
  an independent source of truth
- drag-menu visual-analysis eligibility and backend visual-analysis eligibility
  do not import or consume the shared classifier/preflight path
- the shared classifier is not located under `src/shared/`

Pair it with red/green self-tests and include it in
`npm run verify:browser-reliability`.

## Implementation Order

1. V0 current-truth verification.
2. A1 structured Power failure output.
3. A2 task-type continuity, using the verified loss point.
4. P2 classifier contract and tests.
5. P2 candidate structural context extraction.
6. B visual drag/backend integration.
7. C account collection filtering and polluted-list verdict.
8. D site-card active-tab-domain prompt context.
9. `verify:browser-reliability`, native/stability gates, live regressions.

## Non-Goals

- Do not add a Xiaohongshu-only posting script.
- Do not bypass Power Browser authorization.
- Do not make staged site cards injectable.
- Do not create a third Xiaohongshu deterministic strategy home separate from
  the classifier and collection-quality path.
- Do not remove Safe Mode behavior.
- Do not solve DRM/paid-access extraction here.
- Do not make visual analysis pretend that every Xiaohongshu note contains
  video.
- Do not accept generic high-count link discovery as collection success.

## Risks And Mitigations

### Risk: classifier becomes another duplicated heuristic

Mitigation:

- Replace old consumers or route them through the classifier.
- Add `check-browser-resource-classifier-single-source.cjs` and include it in
  `verify:browser-reliability`.

### Risk: task-type fix masks a wrong intent classifier

Mitigation:

- Phase 0 requires finding the exact loss point before A2.
- Add tests at the resolver and finalizer levels.

### Risk: Xiaohongshu account extraction becomes too site-specific

Mitigation:

- Keep the site-specific branch small.
- Express it as classification plus target-quality filtering, not an ad hoc
  scraping script.
- Make structural context a generic candidate feature, not a Xiaohongshu-only
  hidden payload.
- Preserve generic collection behavior for other sites.

### Risk: visual analysis offers actions that cannot complete

Mitigation:

- The menu can show candidates, but backend preflight must verify media before
  starting the analyzer.
- No-video outcomes must be clear and suggest another action.
