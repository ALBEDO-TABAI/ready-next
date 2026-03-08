# Ready Next Phase Plan - 2026-03-08

## Current baseline after integration
1. Core agent/runtime splitting is landed.
2. Browser main-process services and renderer shell splitting are landed.
3. Repository separation is landed enough to stop the old `database.ts` import warning and direct-coupling pattern.
4. Module handlers for design, video, RSS, and calendar are extracted from page components.
5. RSS runtime, diagnostics, benchmark, and browser-backed acquisition baseline are landed.

## Immediate next work
1. Finish RSS source acquisition on the current stack.
- Weibo: keep the current browser-backed path stable under Chromium/session conditions.
- Xiaohongshu: keep app-browser acquisition as the source of truth, treat the logged-in Ready browser session as the only supported auth path, and verify the real in-app refresh loop after the extraction-script fix.
- Douyin: keep app-browser acquisition as the source of truth and verify the real in-app refresh loop now that the account-post-area extractor is live-validated.

2. Finish the shared workbench visual baseline.
- Strictly align the top three workbench rows.
- Keep the first row mode strip wider and visually closer to the content chrome.
- Unify tabs for browser/document/design/video against the browser baseline.
- Keep document and design on dedicated toolbar rows instead of tab-strip action piles, then finish the remaining diagnostics-row alignment.
- Continue removing overlay/stacking edge cases.

3. Finish the highest-frequency design inspector gaps.
- radius
- font size
- font weight
- line height
- alignment
- basic layout controls across common shapes

4. Continue shrinking the remaining browser orchestration layer.
- keep promoting browser diagnostics toward a proper lab entry
- keep reducing orchestration hidden inside the remaining controller surface

## Mainline work after the above
1. `PromptAssemblyService` with `L0/L1/L2` memory layering and trigger runtime.
2. Feishu capability replacement path.
3. Full diagnostics/lab coverage across browser/document/design/video/rss/calendar.
4. Deeper `Remotion schema-first` completion for video.

## Defaults and constraints
- Keep `lets-go-rss / native / RSSHub` as the main RSS stack.
- Only consider Scrapling again after current-stack fixes are benchmarked.
- Prefer the app's own browser controller/session for browser-backed acquisition.
- Do not reintroduce parallel browser runtimes for RSS unless a later benchmark proves current architecture cannot be made stable.
