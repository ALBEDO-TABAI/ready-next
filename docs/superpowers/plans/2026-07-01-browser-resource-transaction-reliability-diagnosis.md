---
title: Browser Resource And Transaction Reliability Diagnosis
date: 2026-07-01
status: diagnosis
enforce: false
source:
  - /var/folders/hz/n73vqpzs6991580kkw8jgsrh0000gn/T/TemporaryItems/NSIRD_screencaptureui_9FwVOE/截圖 2026-07-01 凌晨1.39.32.png
  - /Users/user/.codex/attachments/4c6ca2a1-bb6e-4282-bc61-95f94a20eae5/pasted-text.txt
  - /var/folders/hz/n73vqpzs6991580kkw8jgsrh0000gn/T/ready-agent-metrics.log
  - /var/folders/hz/n73vqpzs6991580kkw8jgsrh0000gn/T/ready-tools.log
  - /var/folders/hz/n73vqpzs6991580kkw8jgsrh0000gn/T/ready-browser.log
  - /Users/user/Library/Application Support/ready/ready.db
  - docs/superpowers/plans/2026-06-29-web-access-capability-integration-spec.md
  - docs/superpowers/plans/2026-06-30-power-browser-authorization-implementation.md
---

# Browser Resource And Transaction Reliability Diagnosis

## Purpose

This document freezes the current diagnosis for the Xiaohongshu browser-agent
regressions before implementation starts. It is intentionally a diagnosis note,
not an implementation contract. The executable repair plan is paired in
`docs/superpowers/plans/2026-07-01-browser-resource-transaction-reliability-implementation.md`.

The user-visible failures came from three nearby flows:

1. Xiaohongshu creator publishing improved after Power Browser work, but still
   stopped mid-task after `browser_power_eval` failures.
2. Dragging a Xiaohongshu browser tab into the file manager did not show
   `视觉分析`.
3. Xiaohongshu account-page collection became unstable and collected navigation
   links instead of account notes.

The central conclusion is that these are not three unrelated feature bugs. They
share two structural gaps:

1. Ready lacks a single browser tab/page/resource classifier that all browser
   consumers trust.
2. Browser success paths carry structured target state, but failure and edge
   paths still collapse into generic errors or coarse completion states.

## Current Baseline

Ready already has important browser infrastructure from earlier work:

- Power Browser tools exist: `browser_power_eval`, `browser_power_cdp`,
  `browser_power_network_trace`, `browser_power_resource_forensics`, and
  `browser_media_download_advanced`.
- Browser transaction task type and `transaction_confirmed` proof exist.
- Browser Action Session can store task-level `targetTabId`, optional frame
  state, current URL, last action, and transaction state.
- Resource sniffing exists under `browser-engine/resource-sniffer.ts`.
- Site cards exist as bundled knowledge plus user override cards.

The failures below are therefore not caused by total absence of browser tools.
They are caused by how identity, state, and failure information are routed
between these pieces.

## Investigation Method

The diagnosis followed the Ready debugging order:

1. Check database/native health first.
2. Read run lifecycle and metrics.
3. Read tool execution logs.
4. Inspect BrowserView/task logs.
5. Query the durable ledgers.
6. Compare the evidence against current source paths.

This order matters because browser-agent failures often look like "the browser
cannot do it" while the actual failure is completion adjudication, stale process
state, target ownership, or a polluted task ledger.

## Evidence Summary

### Database and process health

`ready-database.log` showed repeated successful `better-sqlite3` loads. There
was no ABI or migration failure matching the user-visible symptoms.

The live process list showed a dev main process started before later source
changes. That explains at least one stale-process false signal: the screenshot
run reported `browser_analyze_viewport` rejecting `input`, while current source
already accepts `input` in `BrowserAnalyzeViewportSchema`.

Interpretation:

- Do not treat the `input` enum failure as a current source bug.
- Future live verification must restart Ready onto the exact source under test.

### Publish transaction state mismatch

The latest relevant run in `run_meta` was:

```text
run_id=req-1782832613856-1yznr0
task_id=task-d85c9835-4129-40d6-bef8-4addf59ae2cf
status=error
terminal_reason=proof_gap
task_type=short_task
```

The paired `task_projections` row for the same task was:

```text
status=failed
interaction_state=suspended
task_type=browser_transaction
task_title=浏览器交互纪律
```

Its `progress_json` still contained useful Browser Action Session state:

```json
{
  "stage": "browser_transaction_active",
  "completed": 0,
  "total": 1,
  "detail": "read map again",
  "browserActionSession": {
    "targetTabId": "tab-2",
    "currentUrl": "https://creator.xiaohongshu.com/publish/publish?source=official&from=tab_switch",
    "origin": "https://creator.xiaohongshu.com",
    "lastAction": "browser_power_eval",
    "transactionStatus": "active",
    "confirmation": null,
    "nextSuggestedAction": "read map again"
  }
}
```

Interpretation:

- The task did reach the browser transaction lane.
- The final run ledger still wrote `short_task + proof_gap`.
- The visible UI and continuation behavior can therefore receive a generic
  failure instead of `browser_transaction_unconfirmed`.
- The final `task_projections.task_type=browser_transaction` row does not prove
  what the finalizer saw. The row may have been updated after finalization.
  The exact place where `browser_transaction` is lost must be verified at
  finalizer time, including which source `resolveEffectiveTaskFacts(...)` used.

### Power eval failure shape

`browser_power_eval` success returns an `attachBrowserActionSessionOutput(...)`
payload that carries grant, audit, target, frame, confirmation, and next action.

The failure path currently throws out of the tool case and is caught by the
generic browser tool catch, returning a plain string such as:

```text
Error executing browser_power_eval: ...
```

That generic error does not preserve:

- target tab
- current URL
- frame id
- code summary
- browser action session patch
- next suggested action
- recoverability category

Interpretation:

- The agent loses the state it needs to recover.
- It falls back to "read map again", screenshots, or repeated probing.
- This is the direct mechanism visible in the screenshot.

### Drag-to-file visual analysis

The renderer menu uses `isLikelyVideoDropPayload(...)` in
`src/renderer/components/layout/fileTreeExternalDrop.ts`. It is based on a
hardcoded list of video hosts and file extensions:

- YouTube
- Bilibili
- Vimeo
- Douyin
- TikTok
- direct video extensions
- `/video/` path fragments

Xiaohongshu is not in this list, and Xiaohongshu note pages often use
`/explore/...`, not `/video/...`.

The backend visual-analysis path repeats the same pattern in
`src/main/modules/rss-engine/item-analysis-manager.ts`. `runVisualFlow(...)`
throws `视觉分析仅支持视频链接` when `isLikelyVideoLink(payload.link)` is false.

Interpretation:

- This is not only a missing menu item.
- Showing `视觉分析` in the menu without changing backend preflight would still
  fail for Xiaohongshu.
- The frontend and backend need the same browser-resource classification result.

### Account-page collection pollution

Recent `browser_tasks` rows for a Xiaohongshu account page show:

- `visible_collect` froze around 185 candidates.
- The result included page navigation and sidebars such as `首页`,
  `red_video`, `livelist`, `worldcup26`, and `ai_chat`.
- A later `card_loop` tried to collect these navigation targets and failed or
  collected irrelevant pages.

The source path that explains this:

- `collection-targets.ts` uses generic URL/title heuristics.
- `NAVIGATION_WORDS` is English-only.
- The extracted `card_list` candidates currently behave like URL/title records;
  structural ancestor context is not guaranteed to be present per candidate.
- `collection-verdict.ts` treats `collected >= expected` as completed.
- It has no verdict for "candidate list is polluted or untrustworthy".

Interpretation:

- This is not mainly a network, anti-bot, or download problem.
- The first frozen target list is wrong.
- Once a polluted list is accepted, downstream collection faithfully performs
  the wrong work.
- Xiaohongshu profile note links often need operational query parameters such as
  `xsec_token` and `xsec_source` to open the detail page. Filtering must
  preserve the token-bearing `openUrl` while deduping by stable note id.
- Structural filtering requires the extraction layer to preserve per-candidate
  DOM context. If the candidate only carries URL/title, "exclude nav/aside/header"
  cannot be enforced and URL/path blacklists become the accidental primary rule.

### Site cards

`assets/site-cards/xiaohongshu.com.md` is bundled and active. Logs showing
`site_card_user_override_skipped` for `www.xiaohongshu.com` are not themselves
a bug: staged user override cards must be skipped by design and the bundled card
is still available.

The real gaps are:

1. Site-card prompt fragments are currently matched against user text. In a
   multi-step browser run, later turns may not repeat "小红书" or the domain, so
   the card can stop matching even though the active tab is still on
   Xiaohongshu.
2. The card text is guidance for the model. It is not consumed by the
   deterministic classifier and collection-quality logic.

Interpretation:

- Do not "fix" staged card skipping.
- Fix site-card prompt matching by tab/domain. Keep deterministic Xiaohongshu
  extraction facts in the shared classifier and collection-quality path, not in
  a third site-card strategy layer.

## First-Principles Model

A reliable browser-agent task needs five layers:

1. Identity: what page or resource is this?
2. Target: which tab, frame, visible region, or resource is the task bound to?
3. Evidence: what proof shows progress or completion?
4. State: what durable session state can survive tool errors and compaction?
5. Recovery: if this step fails, what exact next action should the agent try?

Current Ready has parts of layers 2, 3, and 4. The observed failures are mostly
in layers 1 and 5:

- Different features answer "what page is this?" with unrelated heuristics.
- Success paths preserve state; failure paths often discard it.
- Collection can prove "many links found" but not "the right links found".

## Root Causes

### Root cause 1: no unified browser tab/resource classifier

Today, each consumer has its own local classifier:

| Consumer | Current classifier | Failure |
| --- | --- | --- |
| Drag menu | video host whitelist | Xiaohongshu note pages do not show visual analysis |
| Visual backend | same video whitelist | Xiaohongshu visual analysis is rejected |
| Visible collection | generic card/link heuristics | account navigation becomes content targets |
| Site-card injection | user-text alias match | later browser turns can drop site context |
| Transaction routing | user-text workflow intent | needs verification when run/projection disagree |

This must become one code-owned classification layer with testable outputs.

### Root cause 2: failure paths collapse state

`browser_power_eval` and related Power tools can produce structured state on
success, but failures fall through to a generic error envelope. That violates
Ready's "failure should be loud and useful" rule: the failure is loud enough to
show red, but not useful enough to continue.

### Root cause 3: browser transaction truth reaches projection too late

The current evidence shows `task_projections.task_type=browser_transaction` and
`run_meta.task_type=short_task` for the same run. The finalizer can only produce
`browser_transaction_unconfirmed` when effective task facts still say
`browser_transaction`.

The most likely class of bug is a write-order or truth-source race:

1. At finalization time, `resolveEffectiveTaskFacts(...)` reads
   `projectionPatch.taskType`, then the synchronous projection row, then budget
   runtime.
2. Because the terminal reason became `proof_gap`, none of those sources
   appeared to say `browser_transaction` at the moment of finalization.
3. The final projection row later says `browser_transaction`, which can be
   explained if a projection sync wrote the correct type after finalization.

The repair target is therefore not only "write `run_meta.task_type` from
effective facts". The transaction truth must be made durable in a finalizer
synchronous source before finalization runs, and then `run_meta.task_type`
should also record that same effective truth.

This still needs verification before code changes. If V0 proves the primary
intent was never browser, the root moves upstream to intent classification.
If intent and budget were already browser transaction, the root is likely the
projection/finalizer write-order seam.

### Root cause 4: collection has no "untrustworthy target list" verdict

`collection-verdict.ts` can distinguish empty, partial, paused, and completed,
but not "the count is high because the wrong links were collected". The
extracted candidates also do not reliably expose ancestor/container context,
so downstream filters cannot yet prove whether a link came from the content
grid or global navigation. That is why 185 navigation links can still look
better than zero links.

### Root cause 5: site experience is not deterministic enough

The Xiaohongshu site card contains useful guidance, but the important parts are
not consumed by the shared classifier or collection-quality code. Prompt
guidance alone cannot make a polluted target list safe, but the fix should not
create a separate third home for site-specific extraction rules.

### Root cause 6: stale process state contaminated live evidence

The `browser_analyze_viewport input` failure came from an older running process.
It should not drive source-code fixes, but it must drive verification discipline:
restart before every live regression.

## Claude Review Adjudication

Claude's independent review is useful and should be partially absorbed.

### Absorb directly

1. Collapse the symptoms into two shared roots:
   browser-resource classification and failure/recovery state.
2. Treat `browser_power_eval` failure shape as the immediate publish-loop cause.
3. Treat visual analysis as a frontend and backend problem, not a menu-only
   problem.
4. Add collection-list trustworthiness as a first-class verdict.
5. Treat staged user site-card skipping as correct behavior.
6. Treat `browser_analyze_viewport input` as stale-process evidence, not a
   current bug.
7. Preserve Xiaohongshu `xsec_token` operational URLs while deduping by stable
   note id.
8. Prefer structural navigation exclusion over seasonal token blacklists.
9. Add per-candidate DOM/container context before relying on structural
   navigation exclusion.

### Absorb with correction

Claude's explanation for the `short_task + proof_gap` mismatch points at
projection fallback. That is plausible but not fully proven. The live evidence
shows the final projection row is already `browser_transaction`; the mismatch is
between final projection state and `run_meta`. This makes a finalize-time
ordering race more likely than a simple final field-write bug.

Implementation must therefore verify the exact loss point before choosing the
fix.

### Do not absorb

Do not add another independent classifier on top of existing heuristics. The
fix must retire or centralize the duplicated host/path/list logic rather than
copying it into a new place.

Do not "fix" staged site-card skipping. That is an intentional guard.

## Verified Code Anchors

- `src/renderer/components/layout/fileTreeExternalDrop.ts`
  - `isLikelyVideoDropPayload(...)` is static and does not include Xiaohongshu.
- `src/main/modules/rss-engine/item-analysis-manager.ts`
  - `VIDEO_HOST_HINTS` does not include Xiaohongshu.
  - `runVisualFlow(...)` rejects non-video links with a hard error.
- `src/main/modules/browser-engine/collection-targets.ts`
  - `NAVIGATION_WORDS` is English-only.
  - generic content-target logic can accept Xiaohongshu navigation links.
  - note target identity must preserve operational query in `openUrl` while
    deduping by stable note id.
  - structural filtering needs candidate ancestor/container metadata that is
    not guaranteed by the current generic extraction payload.
- `src/main/modules/browser-engine/collection-verdict.ts`
  - no untrustworthy/polluted list verdict exists.
- `src/main/modules/tools/browser-tools.ts`
  - `browser_power_eval` success attaches Browser Action Session state.
  - failure falls through the generic tool catch.
- `src/main/modules/agent-control/runtime-core/run-finalizer.ts`
  - browser transaction unconfirmed logic exists but depends on effective task
    facts.
- `src/main/modules/agent-control/task-projection/task-projection-sync.ts`
  - fallback task-type paths still use `short_task`.
- `src/main/modules/agent-control/domain-adapters/browser-domain-adapter.ts`
  - site-card fragments match user text aliases, not active tab domain.

## Open Verification Items

Before implementation, verify:

1. After a full restart on current source, does a Xiaohongshu long-form publish
   request classify as browser transaction from the first run frame?
2. Where exactly does `browser_transaction` get lost between intent,
   task-budget runtime, projection truth, finalizer facts, and `run_meta`?
3. At finalization time, what does `taskProjectionStore.get(taskId).taskType`
   return, and did `resolveEffectiveTaskFacts(...)` use
   `projectionPatch`, projection row, budget runtime, or fallback?
4. Does current source still produce generic `browser_tool_failed` for
   `browser_power_eval` failures after restart?
5. Which Xiaohongshu account-page DOM/network signals reliably distinguish note
   cards from global navigation, and can the extraction layer attach those
   signals to each candidate?
6. Can existing `resource-sniffer.ts` identify Xiaohongshu video resources from
   an already-open tab, or does it need page-playback/resource-trigger support?
7. Is the captured run a clean Xiaohongshu publish run? The observed
   `task_title=浏览器交互纪律` may indicate a mixed prompt/discipline context,
   so the V0 reproduction must use a clean publish request.

## Temporary Workarounds

Until the implementation plan lands:

1. Restart Ready before testing browser transaction changes.
2. For Xiaohongshu visual analysis, prefer a direct video/media link or use
   content/copy analysis when no media candidate has been sniffed.
3. For Xiaohongshu account collection, avoid accepting a generic `link_list` or
   `card_list` result if it contains navigation entries such as home, live,
   search, AI chat, or channel links.
