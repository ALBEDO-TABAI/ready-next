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
| Xiaohongshu | Not signed off | app-browser-backed acquisition | Main blocker is login/session/live-tab reuse |
| Douyin | Not signed off | app-browser-backed acquisition | Extractor and route handling improved, but live refresh quality still needs final hardening |

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
- DiDi_OK
- Nio尼奥
  - all remain in the Xiaohongshu unfinished bucket
- Kou悠悠
  - Douyin account-path extraction has been tightened, but the source is still not treated as fully stable in the UI refresh path

## Implementation status by platform
### Weibo
- Continue with the current browser-backed path.
- The key work is session/Chromium stability, not replacing the backend.

### Xiaohongshu
- Do not fall back to a parallel browser runtime.
- Continue on top of the app browser module.
- Current work should focus on:
  - logged-in session reuse
  - same-profile live-tab capture reuse only
  - reliable note-list extraction once the page is in the correct logged-in state
  - replacing stale source items after a successful browser refresh so old wrong-account content does not linger

### Douyin
- Share-link and account-route handling have already been tightened.
- Extraction should stay scoped to the account post area instead of page-wide recommendations.
- Remaining work is live refresh correctness and final hardening, not another parser reset.

## Scrapling position
- Scrapling remains a candidate only.
- It is not required for the default path while current-stack fixes are still unfinished.
- Re-evaluate only after Weibo/Xiaohongshu/Douyin have been pushed as far as practical on the current architecture.
