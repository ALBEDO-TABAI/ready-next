# RSS Source Connectivity Report - 2026-03-08

## Scope
- Added the requested creator watchlist sources into `~/Library/Application Support/ready/ready.db`.
- RSS diagnostics and browser-backed acquisition work since then changed the practical status of several platforms.
- This report now reflects the current code baseline rather than the earliest probe-only snapshot.

## Current platform summary
| Platform | Current status | Backend direction | Current note |
| --- | --- | --- | --- |
| Bilibili | Stable | native / lets-go-rss style fallback | Current stack is sufficient |
| YouTube | Stable | native | No heavier fallback needed |
| Vimeo | Stable | native | No heavier fallback needed |
| Behance | Stable | native | No heavier fallback needed |
| Twitter/X | Stable | native / syndication | No heavier fallback needed |
| Zsxq | Stable | native / API | No heavier fallback needed |
| Weibo | Conditionally stable | browser-backed / Chromium dependent | Keep current path and finish session stability |
| Xiaohongshu | Conditionally stable | app-browser-backed acquisition | Real Electron session capture now works on a logged-in Ready browser session; keep it in the conditional bucket until the in-app refresh path is rechecked end-to-end after restart |
| Douyin | Conditionally stable | app-browser-backed acquisition | Account-post-area extractor is now live-validated in the app browser session |

## Creator-watchlist notes
### Stable today on current stack
- 某幻君
- 罗永浩的十字路口
- 影视飓风
- Matthew Encina
- XK studio
- OFFF Festival
- Yokohara Hirokazu
- 歸藏(guizang.ai)
- 「美妆内行人」资料空间站

### Conditional or unfinished
- 歸藏的AI工具箱
  - viable when browser/Chromium session provisioning is healthy
- UmeDesign_wanying
  - live-validated through a real Electron `persist:browser` session after the extraction-script fix
- DiDi_OK
- Nio尼奥
  - remaining Xiaohongshu profiles still need explicit in-app refresh confirmation, but the shared extractor path is no longer blocked by syntax errors
- Kou悠悠
  - live-validated through a real Electron `persist:browser` session on the account post area

## Implementation status by platform
### Weibo
- Continue with the current browser-backed path.
- The key work is session/Chromium stability, not replacing the backend.

### Xiaohongshu
- Do not fall back to a parallel browser runtime.
- Continue on top of the app browser module.
- Do not silently accept RSSHub fallback content for this platform.
- Current work should focus on:
  - logged-in session reuse through the app browser only
  - same-profile live-tab capture reuse only
  - profile-card extraction when cards do not expose note ids directly
  - keeping the in-app refresh path aligned with the now-fixed extraction script
  - replacing stale source items after a successful browser refresh so old wrong-account content does not linger

### Douyin
- Share-link and account-route handling have already been tightened.
- Extraction should stay scoped to the account post area instead of page-wide recommendations.
- Do not silently accept RSSHub fallback content for this platform.
- The current extractor now returns the correct account page in a real Electron browser session.
- Remaining work is live refresh correctness and final hardening, not another parser reset.

## Scrapling position
- Scrapling remains a candidate only.
- It is not required for the default path while current-stack fixes are still unfinished.
- Re-evaluate only after Weibo/Xiaohongshu/Douyin have been pushed as far as practical on the current architecture.
