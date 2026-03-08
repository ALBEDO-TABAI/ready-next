# RSS Stabilization Baseline - 2026-03-08

## Current scope and architecture
The RSS stack remains:
1. `native feed / simple scraper`
2. `lets-go-rss style scraper`
3. `RSSHub`
4. `browser-backed acquisition` only where necessary

`Scrapling` remains a benchmark-gated fallback candidate only. It is not in the production default path.

## Landed runtime and packaging work
1. RSS now defaults to real runtime unless `ENABLE_MOCK_RSS=true` is explicitly set.
2. The embedded `rsshub-worker` is bundled into the main build output.
3. Worker lookup now prefers bundled artifacts and only falls back when needed.
4. Worker lifecycle now supports health reuse, wider port scan, explicit shutdown, and runtime repair from the UI.
5. RSSHub logging and runtime placement were tightened to stop repository-size blowups from runaway local log files.

## Landed diagnostics and UX work
1. RSS diagnostics now separate:
   - runtime state
   - source capability state
   - benchmark state
2. Route diagnostics persist across restarts.
3. Benchmark results persist under `rss-artifacts` and reload automatically.
4. Source capability UI now shows backend, backend state, failure kind, Chromium requirement, and Scrapling eligibility.
5. Manual refresh now follows current selection semantics:
   - selected source => refresh that source
   - no selected source => refresh all
6. RSS preview close no longer leaves a browser layer over the RSS pane.

## Current platform status
### Stable on current stack
- Bilibili
- YouTube
- Vimeo
- Behance
- Twitter/X
- Zsxq

### Conditionally stable
- Weibo
  - browser-backed / Chromium-dependent
  - current path is viable, but still depends on stable browser session provisioning
- Xiaohongshu
  - the browser-backed extraction script compiles again and has been live-validated in a real Electron `persist:browser` session
  - the platform still depends on an already logged-in Ready browser session, so it remains conditional until the in-app refresh loop is rechecked end-to-end after restart
- Douyin
  - the browser-backed extractor has been live-validated against the account post area in a real Electron `persist:browser` session
  - keep it conditional while the in-app refresh loop is rechecked end-to-end after restart

### Still not signed off
- Xiaohongshu
  - same-domain live-tab reuse has been narrowed to same-profile matching, so cross-account contamination is no longer an intended code path
  - profile-card extraction now supports note-id-missing cards by emitting stable profile-fragment links instead of dropping them
  - the previous extraction-script syntax error has been removed and covered by test
  - browser-backed refresh now replaces the source's old items once a valid browser result is returned
  - the default path no longer silently falls back to RSSHub when app-browser acquisition fails
  - remaining sign-off work is the real in-app refresh loop after restart, not another parser rewrite
- Douyin
  - browser-backed extractor has been tightened to target the account post area instead of page-wide recommendations
  - the default path no longer silently accepts RSSHub fallback content when the browser route fails
  - remaining sign-off work is final in-app refresh hardening, not another route reset

## Architecture changes already landed
1. RSS diagnostics logic is isolated in `source-diagnostics.ts`.
2. Browser-backed fallback now prefers the app's own browser/session path instead of introducing another parallel browser runtime.
3. Xiaohongshu and Douyin now treat app-browser acquisition as the source of truth instead of silently swapping in RSSHub fallback results.
4. RSS runtime and benchmark state is isolated in renderer hooks and dedicated diagnostics components.
5. Scrapling is represented only as a sidecar contract and benchmark candidate.

## What remains intentionally unfinished
1. Scrapling is not wired into production fetch flow.
2. Weibo, Xiaohongshu, and Douyin still need final source-specific hardening on the current stack.
3. RSS diagnostics are still part of RSS IPC and UI modules; a full standalone lab/service split is still available as cleanup work.

## Rejoin point for the main plan
RSS is now a prepared subsystem:
1. runtime is observable
2. repair exists
3. source failures are classified
4. benchmark results persist
5. browser-backed acquisition is integrated with the app browser stack

The next RSS-specific step is to finish Weibo/Xiaohongshu/Douyin acquisition quality on the current stack before introducing any heavier fallback.
