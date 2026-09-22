---
title: Web Access Capability Integration Spec
date: 2026-06-29
status: proposed
enforce: false
source:
  - https://github.com/eze-is/web-access/tree/7af34af6a25940d917905f0e5f2a7ef056952971
  - /tmp/ready-web-access-audit/SKILL.md
  - /tmp/ready-web-access-audit/scripts/cdp-proxy.mjs
  - /tmp/ready-web-access-audit/scripts/browser-discovery.mjs
  - /tmp/ready-web-access-audit/scripts/check-deps.mjs
  - /tmp/ready-web-access-audit/scripts/find-url.mjs
  - /tmp/ready-web-access-audit/scripts/match-site.mjs
  - /tmp/ready-web-access-audit/references/cdp-api.md
  - /tmp/ready-web-access-audit/references/migration-2.5.3.md
  # 2026-06-29 full-source teardown read the canonical installed skill + exported artifact:
  - ~/.codex/skills/web-access/ (SKILL.md, README.md, scripts/*, references/*, config.env)
  - /Users/user/Documents/Codex/2026-06-29/k-k/outputs/douyin-video-download.mjs
  - src/main/modules/browser-engine/ipc-handler.ts
  - src/main/modules/browser-engine/automation-service.ts
  - src/main/modules/tools/browser-tools.ts
  - src/main/modules/tools/browser-tool-catalog.ts
  - src/main/modules/tools/schemas/browser-content-schemas.ts
  - src/main/modules/browser-engine/download-service.ts
  - src/main/modules/browser-engine/fastcard-video-resolver.ts
  - src/main/modules/browser-engine/browser-site-experience-store.ts
  - src/main/modules/agent-control/knowledge/site-card-reader.ts
  - src/shared/browser-collection-intent.ts
archived_at: 2026-09-06
archive_reason: superseded-project-documentation
---

> 已归档（2026-09-06）：本文保留编写当时的设计、状态与证据，不是当前执行入口；归档不表示原计划全部实现。现行说明见 [当前运行时合同](../../../../../architecture/current-runtime-contracts.md)，去向见 [文档清单](../../../../../documentation-inventory.md)。

# Web Access Capability Integration Spec

## 0. Purpose

This document turns the `web-access` project into a Ready-native browser and agent capability plan.

The goal is not to shell out to `web-access`, run an external Edge/Chrome proxy, or expose a universal eval surface to the model. The goal is to understand why `web-access` feels useful and reliable, then internalize the transferable capability set inside Ready's existing BrowserView, tool authorization, task projection, download, site-card, and safety architecture.

## 1. Assumptions

1. Ready remains the browser host. No external browser fallback is part of this plan.
2. Web tasks must keep using Ready's `persist:browser` session, BrowserView/WebContentsView tabs, task projections, and download ledger.
3. The model must not regain freeform script execution. P3c remains true: ordinary-site script-like tool inputs accept only code-owned named templates.
4. High-control platforms such as Douyin, Xiaohongshu, Weibo, Bilibili, TikTok, Kuaishou, Instagram, and Taobao remain conservative surfaces. We may add stronger read-only resource observation, but not silent posting, captcha bypass, password entry, or unreviewed destructive actions.
5. A resource download is complete only when Ready can show the saved local path, size/probe where applicable, and the source evidence chain. "Found a URL" is not completion.

## 2. Completion Criteria For This Program

Ready should feel at least as capable as `web-access` for ordinary user-facing web tasks when all of these are true:

1. Given a URL or current page, the agent can choose between page map, DOM extraction, network/resource sniffing, screenshots, scrolling, and site experience without guessing.
2. Given a media page such as a Douyin video, the agent can resolve the real downloadable media candidate through code-owned observation and save it locally through Ready's download service.
3. Given a dynamic/login-gated page, the agent can use Ready's existing browser session and ask for user takeover only when the target content is actually blocked.
4. Given a long page or feed, the agent can run bounded, checkpointed collection instead of repeating ad hoc scroll/read calls.
5. Given a site-specific trick or trap, Ready can persist that experience as reviewed site knowledge and reinject it later without letting staged model-written cards enter the prompt.
6. Given failure, the agent returns a structured reason and next action: page blocked, login required, captcha/manual step, no candidate, unsupported stream, download failed, or verification failed.

## 3. What Web Access Actually Is

`web-access` is small. Its power comes from a strong operating method plus a thin CDP bridge, not from a large browser framework.

### 3.1 Method Layer

The `SKILL.md` instruction layer teaches the agent to:

1. Define success criteria before browsing.
2. Choose the cheapest likely path first: search, fetch, curl, Jina, or CDP.
3. Escalate quickly when static access cannot prove the target.
4. Treat every step as evidence, not as a binary pass/fail.
5. Avoid repeating the same failed path.
6. Prefer first-party sources and original pages.
7. Use real browser state when login, dynamic rendering, or platform context matters.
8. Record site experience as domain-scoped Markdown.

Ready should absorb this as browser discipline and route selection, not as a text prompt only. The code must make the same choices observable through tool results and task state.

### 3.2 Browser Discovery And Pinning

`scripts/browser-discovery.mjs` detects Chrome, Chrome Canary, Chromium, and Edge by reading each browser's `DevToolsActivePort` file. Its important design decisions:

1. Browser preference has one durable source: `config.env`.
2. Command-line `--browser` is a one-run override.
3. If a requested browser is unavailable, it errors loudly.
4. It does not silently downgrade from Edge to Chrome or from Chrome to a fallback port.
5. Once a proxy connects to a browser, it pins that browser id and refuses drift until the proxy is restarted.
6. It uses TCP port checks before WebSocket connection, reducing accidental remote-debugging permission prompts.

Ready equivalent: Ready does not need browser discovery, because it owns the BrowserView host. But it should copy the "no silent drift" principle for any background tab, resource observer, or capture context. A resource sniff started on tab A must not accidentally read active tab B.

### 3.3 Dependency And Proxy Lifecycle

`scripts/check-deps.mjs` checks Node 22, creates `config.env`, resolves the browser, starts `cdp-proxy.mjs` detached, waits for `/targets`, verifies `/health`, and prints available site-patterns.

Transferable ideas:

1. Preflight should produce a usable, explicit failure message.
2. A running control process must expose health.
3. The health surface includes browser identity, session count, managed tab count, and port.
4. Site knowledge availability is visible at startup.

Ready equivalent: add browser-agent capability health into the existing diagnostics panel and/or agent task proof output: active tab id, observer attached, network domain enabled, resource buffer count, site-card hits, and download service availability.

### 3.4 CDP Proxy Control Surface

`scripts/cdp-proxy.mjs` provides a local HTTP API over Chrome DevTools Protocol:

1. `GET /health`
2. `GET /targets`
3. `POST /new` with URL in raw body
4. `GET /close?target=...`
5. `POST /navigate?target=...` with URL in raw body
6. `GET /back?target=...`
7. `GET /info?target=...`
8. `POST /eval?target=...`
9. `POST /click?target=...`
10. `POST /clickAt?target=...`
11. `POST /setFiles?target=...`
12. `GET /scroll?target=...`
13. `GET /screenshot?target=...`

Internally it uses:

1. `Target.getTargets`, `Target.createTarget`, `Target.attachToTarget`, `Target.closeTarget`
2. `Runtime.evaluate`
3. `Page.enable`, `Page.navigate`, `Page.captureScreenshot`
4. `Input.dispatchMouseEvent`
5. `DOM.getDocument`, `DOM.querySelector`, `DOM.setFileInputFiles`
6. `Fetch.enable` and `Fetch.failRequest` to block page probes against the debug port

Ready already has many of these primitives inside `BrowserAutomationService`: debugger attach, layout metrics, screenshots, mouse/key dispatch, text insertion, file input assignment, and drag events. The missing major CDP primitive is a code-owned Network observation layer.

### 3.5 URL Transport Discipline

The v2.5.3 migration moved `/new` and `/navigate` from query params to POST body. The reason is structural: target URLs themselves contain `?`, `&`, `#`, and tokens, so putting them inside another query string causes truncation and context loss.

Ready equivalent:

1. Browser tool schemas can keep JSON fields, but every internal handoff must preserve URL bytes exactly.
2. Never normalize away query/fragment tokens from user-provided or site-generated links unless a strategy explicitly proves they are tracking-only.
3. Provenance should store both `openUrl` and `canonicalUrl` when a stable dedupe form differs from the operational URL.

### 3.6 Managed Tabs

`web-access` marks only tabs it created through `/new` as managed, touches them on access, closes idle tabs after 15 minutes, and closes them on proxy shutdown.

Ready equivalent:

1. Agent-owned tabs should remain distinct from manual tabs.
2. Background resource sniff tasks should bind to a tab id and task id.
3. Task cleanup should close or release only agent-owned tabs.
4. Visible user tabs should never be silently closed.

Ready already has `BrowserLifecycleTabOwner`, background tab creation, `agentTabId`, task persistence, and browser task supervision. The resource-sniff layer should reuse those ownership fields.

### 3.7 Local Browser History And Bookmark Search

`scripts/find-url.mjs` searches Chrome/Edge bookmarks and history:

1. It enumerates browser user-data directories by platform.
2. It enumerates profiles through Chromium `Local State`.
3. It parses bookmarks JSON.
4. It copies the locked SQLite `History` file to tmp before querying.
5. It supports keyword AND, `--since`, source selection, browser selection, and recent/visits sort.
6. It only prints source tags when multiple browsers/profiles are present.

Ready equivalent:

1. Add a Ready-native `browser_find_known_url` or integrate into browser search routing.
2. Search Ready's own browser history first.
3. Optionally import/read system Chrome/Edge history only as an explicit local-resource feature, with a clear setting and no cloud transmission of raw history.
4. Return structured candidates with title, URL, browser/profile/source, visit time, and confidence.

### 3.8 Site Patterns

`scripts/match-site.mjs` loads `references/site-patterns/<domain>.md`, parses aliases from frontmatter, matches user input, and injects the body.

Ready already has a stronger version:

1. Bundled `assets/site-cards/*.md`
2. User override cards under agent memory
3. `SiteCardReader`
4. `BrowserSiteExperienceStore`
5. Staged-card exclusion
6. Code-owned high-control risk authority

Gap: Ready's bundled site cards are currently shallow. They should evolve from generic "login/selector" cards into validated strategy cards with observed URL patterns, known traps, resource signatures, collection limits, and verification instructions.

## 4. Ready Current State

### 4.1 Browser Host

Ready owns browser tabs through `BrowserController`, `BrowserTabLifecycleService`, and `BrowserHostLayoutService`. Tabs run in `persist:browser`, use the app browser user agent, have popup/auth handling, context menu integration, app shortcut bridges, local media drag/drop bridges, and download session registration.

This is stronger than an external CDP proxy for product integration because Ready can bind browser state to session scope, task projections, UI state, and file downloads.

### 4.2 CDP Primitives Already Present

`BrowserAutomationService` already supports:

1. Debugger attach through `webContents.debugger.attach('1.3')`
2. `Page.getLayoutMetrics`
3. `Input.dispatchMouseEvent`
4. `Input.dispatchKeyEvent`
5. `Input.insertText`
6. `Page.captureScreenshot`
7. `DOM.getDocument`
8. `DOM.querySelector`
9. `DOM.setFileInputFiles`
10. `Input.dispatchDragEvent`

Therefore the right implementation path is to add missing CDP domains to Ready's own automation layer, not to copy `cdp-proxy.mjs`.

### 4.3 Tool Surface

Ready's browser tool catalog already includes:

1. Page navigation, search, tab list, page text, page map, readonly probe
2. Target-based action through `browser_act_on_target`
3. Fallback click/type/coordinate/key tools
4. Screenshots and visual analysis
5. Upload target discovery and file assignment
6. Image collection
7. URL download and collected-media download
8. Video resolution
9. Structured extraction
10. Scroll collect
11. Background tasks
12. Visible collect and note collect

The main missing tool family is resource inspection: "what did this page load, which of those resources are candidate media/data assets, and what evidence supports downloading one?"

### 4.4 Safety Layer

Ready has stronger product safety than `web-access`:

1. `browser-tool-write-classification.ts` classifies read/write effects.
2. `action-confirmation-policy.ts` gates payment, password, captcha, uploads, deletion, and external sends.
3. `browser-tools.ts` blocks high-control freeform scripts.
4. P3c rejects freeform code/custom_script/custom_js and only compiles named read-only templates.
5. Site-card risk is code-authoritative, not model-authoritative.

Any Web Access integration must keep these protections. The model should receive higher-level resource and page evidence, not raw authority to run arbitrary page JavaScript.

### 4.5 Download Layer

`BrowserDownloadService.downloadUrlToDirectory()` already uses Electron session downloads, validates http/https and absolute target directories, preserves referrer, assigns a unique save path, stores download rows, emits progress, and resolves final paths.

Gap: video/mime extension inference currently covers image MIME types but not video/audio/application streams comprehensively. The resource integration should add video-aware naming and optional probe metadata rather than bypassing the service with raw `fetch`.

### 4.6 Existing Video Resolver

`fastcard-video-resolver.ts` resolves direct video URLs, then uses site scripts for Douyin/Xiaohongshu or `yt-dlp` for generic URLs.

Gap exposed by the Douyin test:

1. The current Douyin path depends on an embedded Python parser.
2. It does not observe the live page's network responses.
3. It cannot generalize to "the real media URL is inside an API response that only appears after rendering."

## 5. Capability Gap Matrix

| Capability | web-access | Ready now | Ready target |
|---|---|---|---|
| Real browser login state | External Chrome/Edge | Ready `persist:browser` | Keep Ready session as source of truth |
| CDP target/tab control | Full via proxy | Native BrowserView tabs | Use existing tabs and background agent tabs |
| Page eval | Freeform `/eval` | Freeform rejected; templates allowed | Keep rejection; add code-owned probes |
| Real mouse and keyboard | CDP Input | Present | Keep under target/gate discipline |
| File upload | `DOM.setFileInputFiles` | Present | Keep current upload tool |
| Screenshot/video frame | `Page.captureScreenshot` | Present | Add video frame sampling helper if needed |
| Network/resource observation | Not exposed as endpoint in generic proxy, but easy through CDP and used by exported Douyin script | Missing | Add native network observer and resource sniffer |
| Site experience | Markdown site-patterns | Site cards + DB store | Upgrade card schema and learning flow |
| Browser history/bookmark search | Chrome/Edge local files | Ready history only | Add explicit local-resource finder |
| URL byte preservation | POST body migration | JSON tool fields plus mixed URL handling | Add canonical/open URL provenance rules |
| Task cleanup | Managed tabs + idle timeout | Background tab/task projection | Bind sniff tasks to projection and cleanup |
| Download verification | Script-specific | Download ledger, partial media proof | Add media metadata/probe proof |

## 6. Target Architecture: Ready Web Access Layer

### 6.1 New Core Modules

1. `src/main/modules/browser-engine/cdp-session-service.ts`
   - Owns debugger attach per tab.
   - Reference-counts enabled CDP domains.
   - Provides `sendCommand(tabId, method, params)` and event subscription.
   - Avoids competing attach/detach behavior with `BrowserAutomationService`.

2. `src/main/modules/browser-engine/network-observer-service.ts`
   - Enables `Network.enable` on a scoped tab.
   - Records bounded request/response events in a ring buffer.
   - Tracks request id, URL, method, status, mime type, resource type, initiator, headers, redirect chain, timing, and source tab id.
   - Supports `getResponseBody` only for strategy-approved JSON/text responses or size-limited bodies.
   - Never exposes cookies or full headers to the model.

3. `src/main/modules/browser-engine/resource-sniffer.ts`
   - Merges candidates from DOM, performance entries, Network events, response bodies, page metadata, and site strategies.
   - Emits normalized candidate objects:

```ts
export interface BrowserResourceCandidate {
  id: string
  kind: 'video' | 'audio' | 'image' | 'document' | 'json' | 'stream' | 'unknown'
  url: string
  sourcePageUrl: string
  sourceTabId: string
  source: 'dom' | 'performance' | 'network' | 'response_body' | 'site_strategy'
  mimeType?: string
  status?: number
  width?: number
  height?: number
  durationMs?: number
  byteLength?: number
  score: number
  evidence: string[]
  suggestedName?: string
  referer?: string
  downloadHeaders?: Record<string, string>
  strategyId?: string
}
```

4. `src/main/modules/browser-engine/site-strategy-registry.ts`
   - Code-owned strategies for domains where generic sniffing is insufficient.
   - Initial strategies:
     - Douyin video detail API response strategy.
     - Xiaohongshu video/image signature strategy.
     - Generic HTML5 video/source strategy.
     - Generic HLS/DASH manifest strategy.
   - Strategies return candidates and evidence, not raw page authority.

5. `src/main/modules/browser-engine/media-verification-service.ts`
   - Confirms downloaded file exists, byte size is non-zero, and extension/MIME match.
   - Optionally runs `ffprobe` when available or when packaged runtime provides it.
   - Stores verification metadata next to existing download ledger or task result.

6. `src/main/modules/browser-engine/local-browser-resource-service.ts`
   - Optional local-only reader for Chrome/Edge bookmarks/history, modeled after `find-url.mjs`.
   - Reads only on explicit tool invocation or setting.
   - Copies locked SQLite databases to tmp before querying.

### 6.2 Tool Changes

1. Add `browser_inspect_resources`
   - Read-only from the model's point of view.
   - Inputs: `tab_id?`, `url?`, `kinds?`, `wait_ms?`, `include_response_json?`, `max_candidates?`.
   - Behavior:
     1. Bind to explicit tab or open/navigate a scoped agent tab.
     2. Attach network observer before navigation when `url` is provided.
     3. Wait for page readable/network quiet or strategy-specific signal.
     4. Return compact candidates and evidence.
   - Never returns full response bodies by default.

2. Extend `browser_resolve_video`
   - Current direct/yt-dlp/script resolution remains fallback.
   - New order:
     1. Direct `video_url`/`sources`
     2. Current DOM `<video>`/`source`
     3. Resource sniffer candidates
     4. Site strategy
     5. Existing Python/yt-dlp resolvers
   - Output includes `candidateId`, `evidence`, `source`, and `verificationRequired`.

3. Add `browser_download_resolved_media` or extend `browser_download_urls`
   - Preferred minimal path: extend `browser_download_urls` to accept `candidate_id` from latest resource inspection only if it maps to a frozen candidate store.
   - The direct URL path remains for user-provided explicit URLs.
   - Candidate path preserves referer, suggested name, and strategy headers.

4. Add `browser_find_known_url`
   - Searches Ready history first.
   - Optional Chrome/Edge history/bookmarks when enabled.
   - Returns structured URL candidates.

5. Add no general `browser_eval`.
   - Keep P3c.
   - Add named templates as needed: `read_media_elements`, `read_links_deep`, `read_shadow_dom_outline`, `read_iframe_outline`, `read_video_state`, `seek_video_frame`.

### 6.3 Task And Projection Changes

1. Introduce task kind `resource_inspect` in `BROWSER_CAPABILITY_TASK_KINDS`.
2. Long resource inspection uses `BrowserContentTaskRunner`.
3. Projection fields:
   - `sourcePageUrl`
   - `sourceTabId`
   - `candidateCount`
   - `selectedCandidateId`
   - `downloadPath`
   - `verification`
   - `siteStrategyId`
4. Terminal verdicts:
   - `completed`
   - `partial`
   - `waiting_human`
   - `failed_no_candidate`
   - `failed_download`
   - `failed_verification`
   - `blocked_high_control`
   - `blocked_login_required`
   - `blocked_captcha`

### 6.4 Site Knowledge Upgrade

Ready should treat site knowledge as structured experience, not just prompt prose.

Suggested site card additions:

```md
---
site: douyin.com
status: active
confidence: M
updated: 2026-06-29
---

## Entry Patterns
- Video detail page: https://www.douyin.com/video/<aweme_id>

## Resource Signals
- Detail API includes /aweme/v1/web/aweme/detail and aweme_id=<id>.
- Prefer h264 bit_rate play_addr with video_mp4 or douyinvod URL.

## Known Traps
- Platform "content unavailable" may mean missing context or bot challenge, not missing content.
- Do not strip query parameters from site-generated URLs.

## Verification
- Downloaded mp4 must have non-zero bytes and ffprobe metadata when available.
```

`BrowserSiteExperienceStore` can store structured equivalents for runtime use. Prompt site cards should summarize, not act as the only executable source of truth.

## 7. Douyin First Strategy

### 7.1 Input

User request:

```
下载 https://www.douyin.com/video/7650355790565395731 这个视频到本地
```

### 7.2 Strategy

1. Extract `aweme_id` from URL path or query.
2. Start resource observer before navigating.
3. Navigate Ready agent-owned tab to the page with Ready's browser user agent.
4. Wait for one of:
   - Network response URL includes `/aweme/v1/web/aweme/detail` and `aweme_id=<id>`.
   - DOM exposes usable video/source URL.
   - Timeout.
5. For matching JSON responses, call `Network.getResponseBody`.
6. Parse `aweme_detail.video`.
7. Candidate ranking:
   - Non-H265 `bit_rate` entries sorted by bitrate.
   - Prefer URL containing `mime_type=video_mp4`.
   - Prefer `douyinvod.com`.
   - Fall back to `play_addr_h264`, `play_addr`, `download_addr`.
8. Download through `BrowserDownloadService.downloadUrlToDirectory()` with source page referrer and browser session.
9. Verify file exists, bytes > 0, optional ffprobe duration/dimensions.
10. Save meta JSON or task result with source URL, aweme id, author/title if present, candidate label, path, bytes, and verification.

### 7.3 What This Must Not Do

1. It must not launch Edge/Chrome.
2. It must not bypass captcha or login walls.
3. It must not export cookies to the model or disk.
4. It must not let the model author the response-body parser.
5. It must not claim success before download and verification finish.

### 7.4 Focused Tests

1. Pure test: `extractAwemeId()` handles path/query/raw id.
2. Pure test: candidate ranking chooses best non-H265 mp4 candidate.
3. Fake debugger test: matching Network response body produces candidate.
4. Fake debugger test: non-matching response is ignored.
5. Tool test: `browser_resolve_video` returns structured `video_parse_failed` when no candidate.
6. Download test: candidate path calls `downloadUrlToDirectory()` with referer and suggested `.mp4` name.
7. Guard test: no full headers/cookies in model-visible output.
8. Regression gate: P3c no-freeform script gate still passes.

### 7.5 Live Proof

Run against a real Douyin URL in dev:

1. `npm run dev` or a dedicated Electron smoke runner.
2. Open target through Ready browser/agent path.
3. Resolve candidate through resource inspector.
4. Download to a user-specified local directory.
5. Verify path, byte size, and optional ffprobe metadata.
6. Record the task projection and final user-visible result.

## 8. Phased Implementation Plan

### W0 - Spec And Baseline

Scope:

1. Land this document.
2. Add a minimal no-code audit checklist for current browser resource gaps.
3. Confirm no implementation changes are mixed into W0.

Acceptance:

1. `git diff --check`.
2. Document names source files and proposed test gates.

### W1 - Download Identity Hardening

Scope:

1. Extend `BrowserDownloadService.downloadUrlToDirectory()` to accept code-owned `downloadHeaders`.
2. Allow only identity/resource-request headers needed for browser-equivalent downloads: `Referer`, `User-Agent`, `Accept-Language`, `Accept`.
3. Keep cookies inside the Electron `persist:browser` session; never accept or expose `Cookie` in model-visible payloads.
4. Add video/audio/document MIME extension inference for extensionless suggested names.

Acceptance:

1. Fake session test proves only whitelisted headers reach `session.downloadURL`.
2. Fake session test proves `video/mp4` produces `.mp4` for extensionless names.
3. Existing unsupported-scheme and unique-path behavior remains green.
4. `npm run typecheck`.

### W2 - Shared CDP Session And Network Observer

Scope:

1. Add `cdp-session-service.ts`.
2. Migrate `BrowserAutomationService` CDP commands to the shared session entrypoint before adding another CDP consumer.
3. Add `network-observer-service.ts`.
4. Wire through `BrowserController` and `BrowserAgentRuntimeAdapter`.
5. No model-visible tool yet, or hidden test-only seam only.

Acceptance:

1. Unit tests with fake `webContents.debugger`.
2. Observer attaches to explicit tab id only.
3. Event ring buffer bounds memory.
4. Detach/cleanup leaves existing automation intact.
5. `npm run typecheck`.

### W3 - Resource Sniffer And Tool Surface

Scope:

1. Add `resource-sniffer.ts`.
2. Add `browser_inspect_resources` schema/catalog/dispatcher.
3. Add candidate store scoped to session + tab + task.
4. Add compact model-visible output.

Acceptance:

1. DOM/performance/network candidates dedupe correctly.
2. No raw response body appears in model-visible output unless explicitly summarized by code.
3. Tool classified as read unless it opens/navigates a URL; conditional classification test updated.
4. `browser-tool-failure-envelope.test.ts`.
5. `check-browser-tool-no-json-failure.cjs`.

### W4 - Video Resolution Integration

Scope:

1. Extend `browser_resolve_video` to call resource sniffer.
2. Add Douyin strategy.
3. Add generic HTML5 video and HLS/DASH candidate normalization.
4. Download resolved candidates through W1's header-correct path.

Acceptance:

1. Focused tests in §7.4.
2. Existing direct video test remains green.
3. Xiaohongshu current behavior is not regressed.
4. Live Douyin proof produces a local file.
5. `npm run typecheck`.
6. `npm run verify:ipc-contract`.

### W5 - Download And Verification Closeout

Scope:

1. Candidate-based download path.
2. Media verification service.
3. Task result includes path, bytes, metadata, source evidence.
4. UI/task projection shows "saved" only after verification.

Acceptance:

1. Download tests with fake session.
2. Verification tests for nonzero file, missing file, and optional ffprobe.
3. User-facing result cannot mark completed when download fails.
4. `npm run verify:native` if SQLite/download ledger paths are touched.

### W6 - Local URL Finder

Scope:

1. Add Ready history search route.
2. Add optional Chrome/Edge history/bookmark reader with explicit setting.
3. Return structured candidates.

Acceptance:

1. Tests use temp fixture browser profiles and copied SQLite.
2. No raw browser history is injected into prompts.
3. User-visible result shows source labels only when useful.

### W7 - Site Experience Upgrade

Scope:

1. Upgrade bundled site cards with resource signatures.
2. Store structured browser-site experience rows from verified outcomes.
3. Keep model-written cards staged until user confirmation.
4. Add settings visibility for site experience and risk.

Acceptance:

1. `site-card-learning.test.ts`.
2. `site-card-alignment.test.ts`.
3. High-control risk remains code-authoritative.
4. No staged cards enter prompt injection.

### W8 - Browser Discipline Routing

Scope:

1. Update browser prompt discipline to prefer resource inspection for media download tasks.
2. Update collection intent/tool exposure to include resource inspection for videos/media.
3. Add routing tests for "download this video", "save images from this page", "find a previous page I visited".

Acceptance:

1. Route exposes the right subset without exposing `browser_execute_js`.
2. Media download tasks do not terminate at "found URL".
3. Status-only questions do not expose write tools.

## 9. Verification Matrix

| Layer | Tests/Gates |
|---|---|
| CDP session | Fake debugger unit tests; attach/detach/refcount tests |
| Network observer | request/response/loadingFinished body retrieval tests |
| Resource sniffer | DOM/performance/network/JSON merge and ranking tests |
| Tool schema/catalog | zod param derivation, capability parity, write classification |
| Safety | `browser-script-m1-net.test.ts`, `browser-high-control-guard.test.ts`, no-freeform gate |
| Download | `browser-download-service.test.ts`, media candidate download tests |
| Task projection | browser task status/projection tests |
| Site knowledge | site-card learning/alignment tests |
| Native persistence | `npm run verify:native` when DB/download rows change |
| Full closeout | `npm run typecheck`, `npm run verify:ipc-contract`, focused browser tests, live dogfood proof |

## 10. Design Tradeoffs

### 10.1 Why Not Copy cdp-proxy.mjs

Copying `cdp-proxy.mjs` would create a second browser control plane beside Ready's BrowserView. That would make tab ownership, user-visible state, downloads, task cleanup, login/session boundaries, and error reporting harder. Ready already owns the host and has richer product seams.

The useful transferable parts are:

1. CDP command coverage.
2. No silent target drift.
3. Managed background tabs.
4. URL transport discipline.
5. Evidence-first browsing method.
6. Site experience accumulation.

### 10.2 Why Not Reopen Freeform Eval

`web-access` relies heavily on `/eval`. That is acceptable for a local agent skill controlled by a technical user, but Ready has already established product safety contracts that forbid model-authored freeform scripts on ordinary sites and block script-hard tools on high-control platforms.

Ready should add more code-owned probes, not more model-owned code.

### 10.3 Why Network Observation Is The Highest Leverage Gap

Modern media sites often do not expose the real file URL in stable DOM. The reliable path is:

1. Open the real page with the real session.
2. Observe first-party requests and responses.
3. Extract structured media candidates from API responses and media requests.
4. Download through the same browser session.
5. Verify the saved artifact.

This is exactly the gap shown by the Douyin script.

## 11. First PR Shape

Recommended first implementation PR:

1. Header-correct `downloadUrlToDirectory()` with safe header whitelist.
2. `cdp-session-service.ts`.
3. `network-observer-service.ts`.
4. `resource-sniffer.ts`.
5. `browser_inspect_resources` schema/catalog/dispatcher.
6. Focused unit tests only.

Recommended second PR:

1. Douyin response-body strategy.
2. `browser_resolve_video` current-tab resource inspection.
3. Candidate download path.
4. Verification closeout and live proof artifact.

This keeps the architecture contract small before adding site-specific behavior.

## 12. Open Questions

1. Should local Chrome/Edge history search be enabled by default, or only after an explicit setting?
2. Should resource candidates be persisted in DB, or kept in scoped memory and only persist final downloads?
3. Should `ffprobe` verification depend on the optional skill runtime, or should Ready ship a tiny media probe path?
4. Should HLS/DASH download be in scope for the first media release, or should W3 only resolve direct downloadable files?
5. What is the UX for "found candidate but download likely violates platform terms"? This needs product wording, not just a tool error.

## 13. Immediate Recommendation

Start with the lowest-risk contract that immediately changes outcomes, then add the missing browser intelligence layer:

1. Header-correct browser-session downloads.
2. Shared native CDP session service.
3. Network observer and resource candidate normalization.
4. `browser_resolve_video` upgraded to use live page evidence.
5. Douyin as the first proof strategy.

Do not start by adding an external proxy, plugin, or general eval tool. That would make the agent look more capable for one day and less trustworthy over time.

---

# Addendum (2026-06-29 full-source teardown)

> This addendum was added after an exhaustive read of every `web-access` source file
> (`cdp-proxy.mjs`, `browser-discovery.mjs`, `check-deps.mjs`, `find-url.mjs`,
> `match-site.mjs`, `SKILL.md`, `references/*`) plus the exported
> `douyin-video-download.mjs`. It captures the parts of "why web-access feels
> reliable" that §3–§12 underweighted. Sections §1–§13 above remain the
> authoritative architecture; this addendum sharpens the reliability methodology
> and the Ready hardening checklist. It does not change any safety contract.

## 14. Reliability & Anti-Detection Methodology (the "靠谱" layer)

web-access is ~2000 lines. Its perceived reliability is not from coverage; it is
from a small set of robustness techniques. These are the transferable assets.

### 14.1 Use a real browser with real identity

- web-access attaches to the user's **daily** Chrome/Edge via the
  `chrome://inspect/#remote-debugging` toggle (reads `DevToolsActivePort`), so
  every request carries the real profile: cookies, login state, TLS/JA3
  fingerprint, real UA, real timezone/locale. No headless heuristics fire.
- **Ready is already in this position and stronger**: it owns an embedded
  `persist:browser` session with real login state. It needs no external browser,
  no discovery, no `DevToolsActivePort`, no auth popup, no port pinning. The
  whole §3.2/§3.3 discovery+pinning machinery collapses to "Ready is the browser."
  This is a Ready *advantage* to state explicitly to users, not a gap.

### 14.2 The debug-port probe guard

- `cdp-proxy.mjs` runs `Fetch.enable` scoped to `http://127.0.0.1:{port}/*` and
  `http://localhost:{port}/*`, and `Fetch.failRequest(ConnectionRefused)` on any
  match (`enablePortGuard`, lines 236–247). This defeats a known automation tell:
  pages that fetch the local DevTools port to detect a debugger.
- **Ready impact**: Ready's CDP attach is **not** a page-reachable localhost
  port (it is in-process `webContents.debugger`), so this specific tell does not
  exist for Ready. Document this as "not applicable — structurally safer," and do
  **not** port the guard. If `network-observer-service` later adds any localhost
  bridge, revisit.

### 14.3 Genuine user gestures vs synthetic clicks

- web-access exposes two click paths on purpose: `/click` (JS `el.click()`, fast,
  but a synthetic event some sites reject) and `/clickAt` (real
  `Input.dispatchMouseEvent` press/release at element center — a true user
  gesture that can open file dialogs and pass gesture-gated handlers).
- **Ready already has both** (`BrowserAutomationService` Input.dispatch* +
  JS-level click via `browser_act_on_target`). Keep the two-tier model; ensure
  the gesture-grade path stays available for media/upload flows under the
  existing action-confirmation gate.

### 14.4 navigator hardening (from the Douyin script, not the proxy)

The exported `douyin-video-download.mjs` launches a *fresh* instance and injects,
via `Page.addScriptToEvaluateOnNewDocument`, before any page script runs:

```js
Object.defineProperty(navigator, 'webdriver',  { get: () => undefined });
Object.defineProperty(navigator, 'languages',  { get: () => ['zh-CN','zh','en'] });
Object.defineProperty(navigator, 'plugins',    { get: () => [1,2,3,4,5] });
```

Plus `Network.setUserAgentOverride` and an `Accept-Language` header.

- **Ready impact**: attaching `webContents.debugger` does **not** set
  `navigator.webdriver = true` (that flag comes from `--enable-automation` /
  ChromeDriver, which Ready does not use), so Ready's BrowserView is already
  clean on the main tell. **Action item (verify, then harden if needed):** add a
  one-line check that `navigator.webdriver` is falsy in `persist:browser`; if any
  future flag flips it, add a `Page.addScriptToEvaluateOnNewDocument` hardening
  shim in `cdp-session-service` applied only to agent-owned tabs. Do not spoof
  beyond removing genuine automation tells — fingerprint forgery is out of scope.

### 14.5 Header-correct download is the actual download trick

The reason the Douyin `.mjs` download succeeds where a naive `fetch` 403s is the
request headers, not the URL:

```
Referer: <the douyin page URL>
User-Agent: <the same UA the page used>
Accept-Language: zh-CN,zh;q=0.9,en;q=0.8
Accept: video/webm,video/ogg,video/*;q=0.9,*/*;q=0.8
```

Anti-hotlink CDNs reject requests lacking a matching `Referer`/UA.

- **Ready impact (highest-value, lowest-cost fix):** this is the single most
  important portable detail. `BrowserDownloadService.downloadUrlToDirectory()`
  must accept and apply per-download headers carried from the resource
  candidate (`referer`, `User-Agent`, `Accept-Language`, and — only inside the
  main process, never model-visible — the session cookie via the existing
  `persist:browser` session). Because Ready downloads through the **same
  Electron session** that rendered the page, cookie/UA continuity is automatic if
  it uses `session.downloadURL` on that session; the explicit `Referer` is the
  piece to thread through. Add this in W1 and reference it from the candidate's
  `downloadHeaders` field already defined in §6.1.3.

### 14.6 In-site URLs are trustworthy; hand-built URLs are not

web-access methodology fact: a URL reached by interacting with the page (clicking
a card/entry) carries all implicit required params (tokens like xhs `xsec_token`);
a URL the agent assembles by hand often drops them and trips anti-crawl. The
v2.5.3 POST-body migration exists for the same reason (don't let a syntax-bearing
URL ride inside another query string and get truncated).

- **Ready impact**: §3.5 already covers byte-exact URL transport. Reinforce: the
  resource sniffer must capture the **exact request URL observed on the wire**
  (from `Network.requestWillBeSent`), never a reconstructed one. Provenance keeps
  `openUrl` (operational, full tokens) distinct from `canonicalUrl` (dedupe).

### 14.7 Errors are evidence, not truth

web-access fact: platform "内容不存在 / 页面不见了" often means a bad access path
(missing param, bot challenge), not real absence. The method is to re-evaluate
the access path, not to give up or blindly retry.

- **Ready impact**: the structured terminal verdicts in §6.3 already encode this
  (`blocked_*` vs `failed_no_candidate`). Ensure the model-facing failure copy
  distinguishes "platform said unavailable" from "Ready confirmed unavailable,"
  so the agent escalates access path rather than reporting false absence.

## 15. Video Frame Sampling (content understanding, distinct from download)

A capability §6.2.5 lists (`seek_video_frame`) but does not justify. web-access
uses it for *understanding* video without downloading: drive the `<video>`
element (`currentTime` seek, play/pause), then `Page.captureScreenshot` to sample
discrete frames for visual analysis. Useful when the user asks "what happens in
this video" rather than "download it," and when the media is login-gated and not
downloadable.

- **Ready mapping**: two named read-only templates instead of freeform eval:
  - `read_video_state` → returns `{duration, currentTime, paused, videoWidth,
    videoHeight, src}` for `<video>` matches.
  - `seek_video_frame` → sets `currentTime` to a code-supplied timestamp (param,
    not model JS), waits for `seeked`, returns ready signal; caller then uses the
    existing screenshot path. Keep it parameterized so the model supplies only the
    timestamp list, never code (P3c preserved).

## 16. Login Wall Takeover (Ready is smoother than web-access)

web-access login method: try to get content first; only when the target is
*confirmed* unobtainable, tell the user "log into <site> in your browser, then say
continue"; after login just refresh — no restart.

- **Ready advantage**: the BrowserView is **in-app**, so the user can log in
  *inside Ready's own tab* — no "go to your separate browser" context switch.
  Define the flow:
  1. Resource inspect / resolve fails with `blocked_login_required`.
  2. Agent surfaces the tab to the user (BrowserView show) with a one-line ask.
  3. User logs in directly in the Ready tab (session persists in
     `persist:browser`).
  4. User confirms; agent re-runs the inspect on the same tab — no re-navigation
     needed beyond a reload.
- This reuses the existing user-takeover / `ask_user_questions` + action
  confirmation surfaces; it must not auto-submit credentials (M1 password guard
  stays). Add `blocked_login_required` handling to the `resource_inspect` runner.

## 17. Methodology Distilled → Ready Routing Discipline

The transferable operating method (SKILL.md "浏览哲学") restated as Ready rules,
to fold into the browser DomainAdapter prompt discipline (W7), **as routing not
prose**:

1. **Define success first.** A media task's success = verified local file +
   evidence chain, never "found a URL" (already §2.5 / §6.3).
2. **Cheapest path first, escalate fast.** Tool ladder: existing page text /
   page map → DOM extraction templates → `browser_inspect_resources` (network) →
   screenshot/frame-sample → site strategy. Escalate the moment a cheaper rung
   fails to *prove* the target; do not retry the same rung.
3. **Every step is evidence.** Feed each tool result back into the route choice;
   a `blocked_*` verdict changes the path, a `failed_no_candidate` changes the
   extraction method.
4. **First-party / on-wire over reconstructed.** Prefer observed requests and
   site-generated URLs over hand-built ones (§14.6).
5. **Stop at success, don't over-operate.** Bounded, checkpointed collection
   (existing collection-verdict) instead of open-ended scroll/read loops.

These are already mostly enforced by Ready's controller and collection contracts;
W7's job is to make the *route ordering for media/resource tasks* explicit so the
agent reaches `browser_inspect_resources` instead of dead-ending at yt-dlp.

## 18. Revised Priority Call

The teardown confirms §13's ordering but sharpens the highest-leverage, lowest-
cost items to do **first within W1–W4**:

1. **Header-correct download** (§14.5) — thread `Referer`(+UA/Accept-Language)
   through `downloadUrlToDirectory`, download on the page's own `persist:browser`
   session for automatic cookie/UA continuity. This alone unblocks most
   anti-hotlink media and is a few lines.
2. **Network observer + Douyin response-body strategy** (§3.4 / §7) — the real
   structural gap.
3. **`navigator.webdriver` verification** (§14.4) — confirm Ready is already
   clean; only add a hardening shim if a flag flips it.
4. Everything else (frame sampling, local URL finder, site-card upgrade) is
   genuinely additive and can follow.

## 19. Claude Addendum Adoption Verdict

The full-source teardown in §14-18 is accepted with these implementation locks:

1. **Adopt now:** §14.5 header-correct downloads and §14.6 exact on-wire URL
   provenance. These are small, high-confidence changes and become W1/W3
   requirements.
2. **Adopt as architecture:** §14.1 Ready-is-the-browser. Ready must use its own
   `persist:browser` session as the source of login/cookie/UA continuity instead
   of depending on Chrome/Edge discovery or an external proxy.
3. **Keep existing contract:** §14.3 two-tier click behavior. JS-level click and
   gesture-grade CDP input both remain, but gesture-grade actions stay under
   target freshness and action-confirmation gates.
4. **Do not port:** §14.2 debug-port probe guard. It is only needed for a
   localhost CDP proxy; Ready's in-process debugger has no page-reachable port.
5. **Verify before hardening:** §14.4 `navigator.webdriver`. Add a test/probe;
   only add a new-document shim if Ready ever exposes a real automation tell.
6. **Adopt later:** §15 frame sampling, §16 login-wall takeover, §17 routing
   discipline, and local URL finder behavior. They remain in the phased plan but
   must not delay W1/W2.

This means the first development slice is deliberately narrow: make downloads
behave like the page's own browser session, then add the observer that can find
the right resource in the first place.
