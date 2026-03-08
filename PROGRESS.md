# Ready 开发进展

> 更新时间: 2026-03-08

## 2026-03-08 Integration Baseline
1. Agent/runtime baseline has been restructured.
- `useAgent` no longer owns the whole execution pipeline alone.
- runtime routing, message composition, command execution, and scope-run patching are split into dedicated modules.
- structured run state now carries module-aware execution metadata.

2. Browser architecture has been materially reduced.
- main-process browser logic is split into focused services.
- renderer browser shell/layout and diagnostics entry are separated from the page container.
- browser-related overlay bugs around preview/context-menu layering have been explicitly addressed.

3. Repository access is now separated by domain.
- browser/chat/rss/calendar/settings/agent access no longer depends on direct cross-domain database calls in the old style.
- the previous mixed static/dynamic database import warning has been removed.

4. Workbench modules are on a more consistent execution model.
- design/video/rss/calendar module handlers are extracted from page components.
- diagnostics panels exist for browser, RSS, calendar, design, and video.
- browser/document/design/video tab chrome is now on a shared path instead of fully separate styling.
- document and design controls are now split out of the tab strip into dedicated toolbar rows, moving the workbench closer to a consistent tabs + toolbar structure.

5. RSS is now a standalone prepared subsystem.
- packaged/runtime RSSHub behavior is fixed enough to be observable and repairable in-product.
- route diagnostics and benchmark results persist.
- browser-backed acquisition now prefers the app browser stack.
- browser-backed RSS refresh now replaces stale source items for browser platforms after a successful fetch.
- Xiaohongshu live-tab reuse has been narrowed to same-profile matching instead of same-domain matching.
- Xiaohongshu and Douyin no longer silently fall back to RSSHub when app-browser acquisition fails.
- the Xiaohongshu extraction script regression is fixed and covered by test.
- Xiaohongshu capture now succeeds again in a real Electron `persist:browser` session when the Ready browser session is logged in.
- Douyin account-post-area extraction is live-validated in a real Electron `persist:browser` session.
- RSS selected-source state now uses the session store as a single source of truth instead of diverging between local page state and diagnostics state.
- RSS diagnostics now surface the last refresh invocation so renderer-side refresh wiring can be verified without tailing logs.
- shared workbench chrome now keeps the first-row mode strip compact, while the second-row tab rail and third-row toolbar rail are locked back onto the same content boundary instead of drifting by component-local padding.

## Current known unfinished work
- Weibo/Xiaohongshu/Douyin still need final acquisition hardening.
- Workbench top-row vertical alignment still needs a final polish pass, but the second/third-row boundary mismatch is no longer intentional code.
- Design inspector still lacks several high-frequency controls.
- Browser diagnostics are not yet full labs.
- Memory layering and Feishu replacement are still ahead on the mainline.

## Next recommended sequence
1. Finish RSS source acquisition quality.
2. Finish workbench UI alignment and tabs.
3. Continue browser orchestration reduction and diagnostics lab work.
4. Return to layered memory and Feishu replacement.
