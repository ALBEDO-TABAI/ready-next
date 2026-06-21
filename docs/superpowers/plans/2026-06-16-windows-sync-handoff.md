---
status: handoff
created_at: 2026-06-16
updated_at: 2026-06-18 15:00:24 +0800
source_project: /Users/user/实验田/ready-cowork
target_project: /Users/user/实验田/ready-win
source_branch: agent-evolution/phase1
source_head: a0e0084d7aac7186d7b03411bf1de6bdc849430f
latest_source_export: /Users/user/实验田/ready-win/ready-source-20260618-150051.zip
enforce: false
---

# Ready Windows Sync Handoff

## 1. Purpose

This document is for the Windows-side coding agent that will continue Ready from a clean source snapshot. The goal is not to run the macOS build on Windows. The goal is to rebuild Ready from source on Windows, preserve the current feature state, and make platform differences explicit.

The downstream agent must only modify the Windows target repo. Do not modify `SOURCE_REF`. Do not copy dependencies, build products, local app data, logs, archives, or secrets from this macOS checkout.

## 2. Source And Target

- Source path: `/Users/user/实验田/ready-cowork`
- Source branch: `agent-evolution/phase1`
- Source commit: `a0e0084d7aac7186d7b03411bf1de6bdc849430f`
- Current date: `2026-06-18`
- Target delivery root: `/Users/user/实验田/ready-win`

The package is a live working tree export. These uncommitted source documents are intentionally included because they describe the current Windows handoff contract:

- `AGENTS.md`
- `CLAUDE.md`
- `LESSONS_LEARNED.md`
- `docs/superpowers/plans/2026-06-16-windows-sync-handoff.md`

These local test artifacts are intentionally excluded from the source package:

- `outputs/send-im-live-20260618-135029/`

## 3. Materials Provided

- Source snapshot folder: `/Users/user/实验田/ready-win/ready-source-20260618-150051`
- Source snapshot zip: `/Users/user/实验田/ready-win/ready-source-20260618-150051.zip`
- Top-level handoff doc: `/Users/user/实验田/ready-win/WINDOWS_SYNC_HANDOFF.md`
- Handoff doc inside snapshot: `docs/superpowers/plans/2026-06-16-windows-sync-handoff.md`
- Snapshot exporter proof before final doc refresh: `forbidden_found = []`, `zip_test_ok = true`, `file_count = 2950`

No macOS installer or Windows installer was built for this handoff. Any Windows runtime, packaging, or installer claim still requires real Windows verification.

## 4. Copy-Paste Prompt For Downstream Agent

```text
You are synchronizing Ready from SOURCE_REF into TARGET_REPO for Windows development.

Inputs:
- SOURCE_REF = the provided Ready source snapshot folder or zip.
- TARGET_REPO = the Windows-side Ready repo.

Rules:
1. Modify only TARGET_REPO. Do not edit SOURCE_REF.
2. Do not copy node_modules, out, dist, exports, .env*, logs, caches, .app, .dmg, .zip, .asar, local DBs, or local user data.
3. Install dependencies on Windows with npm ci.
4. Rebuild native dependencies on Windows. better-sqlite3 must match the Electron ABI.
5. Do not claim Windows behavior works unless it was verified on Windows.

Read these first:
- AGENTS.md
- CLAUDE.md
- package.json
- electron-builder.yml
- docs/superpowers/plans/2026-06-16-windows-sync-handoff.md
- docs/superpowers/plans/2026-06-17-send-im-l1-and-agent-state-fix-implementation.md

Must sync from the current source:
1. Send IM / WeChat delivery hardening:
   - assets/embedded-skills/send-im/
   - src/shared/remote-im-file-intent.ts
   - src/main/modules/tools/send-im-skill-tool.ts
   - src/main/modules/agent-control/runtime-core/channel-delivery-result.ts
   - src/main/modules/agent-control/runtime-core/agent-sdk-runtime.ts
   - src/main/modules/agent-control/runtime-core/runtime.ts
   - src/python/ready_sidecar/channels/wechat_openclaw_adapter.py
   - src/__tests__/send-im-skill-tool.test.ts
   - src/__tests__/remote-im-attachment-contract.test.ts
   - src/__tests__/browser-download-recent-artifacts.test.ts
   - package.json verify:send-im-l1
2. Run finalization and task-card truthfulness:
   - All terminal paths go through runtime-core/run-finalizer.ts.
   - Delivery failures must remain diagnosable and must not collapse into a generic failed-looking state.
3. Current Windows handoff rules:
   - AGENTS.md, CLAUDE.md, and LESSONS_LEARNED.md contain current Windows source-sync and titlebar constraints.
4. Existing Ready behavior:
   - Browser mode, Document mode, RSS, Calendar, Settings, Agent runtime, embedded skills, sidecar runtime, and local file handling must remain intact.

Windows platform work:
- electron-builder.yml currently has mac targets. Add Windows win/nsis/dir targets without breaking mac targets.
- Use build/icon.ico for Windows, not icon.icns.
- Rebuild better-sqlite3 on Windows. Never copy the macOS native build.
- Use app.getPath, process.resourcesPath, path.join, and path.delimiter for platform paths.
- P6c/C31-a covers shell-output host-path redaction for Windows string shapes (`C:\Users\<name>`, `%USERPROFILE%`, and backslash home paths). C31-b remains deferred/unresolved: read/write/inspect/patch primitives may still need primitive-wide absolute-path redaction before the model sees paths.
- Python sidecars use Scripts/python.exe on Windows and bin/python on macOS/Linux.
- Test local-file:// with drive-letter paths, spaces, Chinese paths, and video range requests.
- boot-reaper-core.ts has a Windows cleanup gap; implement equivalent cleanup or explicitly surface unsupported behavior.

Windows titlebar/chrome:
- Treat "immersive taskbar" as Ready's top titlebar/window-control area, not the Windows bottom taskbar.
- Keep native Windows minimize/maximize/close buttons in the top right.
- Move the Ready dot from ModeSlider's right side to the Windows top left.
- Align the Ready dot center X to the IconRail slot center:
  WORKBENCH_EDGE_RAIL_SLOT_INSET_X + WORKBENCH_EDGE_RAIL_SLOT_SIZE / 2 = 25px.
- Prefer titleBarStyle: hidden plus titleBarOverlay.
- Let the renderer paint the continuous top background when possible.
- Mica is only an enhancement for Windows 11 22H2+. Provide an opaque fallback.

Required validation on Windows:
- npm run native:check
- npm run typecheck
- npm run verify:stability
- npm run verify:evolution-p4
- npm run build
- node scripts/export-ai-settings-seed.mjs
- npm run build:dir
- electron-builder --config electron-builder.yml --win --x64

Manual smoke:
- /workbench opens without white screen.
- Settings/Appearance switches theme, skin, and accent.
- Browser mode opens a tab and native web content does not cover DOM overlays.
- Document preview opens Markdown, PDF, and local files.
- RSS and Calendar pages open.
- Agent panel handles missing API key gracefully.
- ready.db is created under Windows userData or READY_USER_DATA_DIR and survives restart.
- Packaged resources resolve: embedded skills, pets, prompts, site cards, RSS worker, and sidecar runtime.
- Send IM skill is visible only when intended, and file/image/PDF/video sends report clear success or a clear delivery error.

Final report:
- Changed files/features.
- Windows-specific branches added.
- macOS branches preserved.
- Commands passed.
- Package path.
- Screenshots for titlebar checks.
- Real blockers requiring human help.
```

## 5. Must-Read Files

- `AGENTS.md`, `CLAUDE.md`
- `package.json`, `electron-builder.yml`
- `src/main/index.ts`
- `src/main/modules/window-material/main-window-material.ts`
- `src/renderer/stores/useTheme.ts`
- `src/renderer/styles/index.css`
- `src/main/modules/database.ts`
- `scripts/check-better-sqlite3-electron-abi.cjs`
- `scripts/patch-better-sqlite3-electron42.cjs`
- `src/main/modules/skills-runtime/runtime-manager.ts`
- `src/main/modules/process-cleanup/boot-reaper-core.ts`
- `src/main/modules/rss-engine/rsshub-process.ts`
- `src/shared/browser-view-intent.ts`
- `src/main/modules/browser-engine/`
- `src/main/modules/tools/send-im-skill-tool.ts`
- `src/python/ready_sidecar/channels/wechat_openclaw_adapter.py`

## 6. Behavior To Preserve

- Send IM skill can directly send local files and recent downloaded artifacts to the configured IM channel.
- WeChat delivery supports clear file/image/video/PDF success or explicit delivery errors.
- Short follow-up phrases such as "再试试这个" with an attachment stay on the Send IM path only when there is a real recent Send IM context.
- Ordinary "帮我整理/写报告/搜资料" file tasks must not accidentally trigger Send IM.
- Successful attachment delivery must not be reclassified as failed only because the follow-up text acknowledgement could not be posted back to the channel.
- Agent run finalization remains centralized and projection remains derived from the run truth source.

## 7. Platform Differences

- Native dependency: `better-sqlite3` must be rebuilt on Windows for Electron 42.3.0. macOS `node_modules` must never be reused.
- Filesystem: Windows must use `%APPDATA%` or `READY_USER_DATA_DIR` for user data, and path helpers for packaged resources.
- Packaged resources: embedded skills, prompts, site cards, pets, RSS worker, board assets, Python sidecar, and native sqlite resources must resolve from `process.resourcesPath` or development equivalents.
- Windowing: Windows does not support macOS traffic lights or vibrancy. Use native right-side controls and a Windows-specific titlebar overlay.
- Runtime sidecars: Python, RSSHub, Puppeteer, and process cleanup must use Windows process/path conventions.

## 8. Do Not Do

- Do not copy `node_modules`, `out`, `dist`, `exports`, `.env*`, logs, caches, `.app`, `.dmg`, `.zip`, `.asar`, local DBs, local seeds, or user data.
- Do not turn macOS `vibrancy`, `.icns`, `setWindowButtonPosition`, or `/Users/...` paths into shared Windows code.
- Do not use `frame: false` unless you also implement and test Windows window controls, dragging, Aero Snap, double-click maximize, system menu, and accessibility.
- Do not say Windows works until it was tested on Windows.
- Do not use source grep as the only proof for native, packaging, file protocol, database, or sidecar behavior.

## 9. Required Validation Commands

Run these in the Windows target repo after syncing:

```bash
npm ci
npm run rebuild:native
npm run native:check
npm run typecheck
npm run verify:stability
npm run verify:evolution-p4
npm run build
node scripts/export-ai-settings-seed.mjs
npm run build:dir
electron-builder --config electron-builder.yml --win --x64
```

On macOS, this handoff package was created from a source tree where the latest Send IM implementation had already passed:

```bash
npx tsx@^4.19.2 --test --test-concurrency=1 src/__tests__/agent-sdk-runtime.test.ts
npm run verify:send-im-l1
npm run typecheck
npm run verify:stability
```

Those macOS checks do not prove Windows runtime behavior.

## 10. Manual Packaged-App Checks

- App opens `/workbench` with no white screen.
- Settings/Appearance switches theme, skin, and accent.
- Browser mode opens a page and DOM overlays remain visible above native web content when expected.
- Document mode opens Markdown, PDF, and local files.
- RSS and Calendar open.
- Agent panel handles missing API key with a visible configuration prompt.
- `ready.db` is created in Windows user data and persists after restart.
- Packaged resources resolve for embedded skills, prompts, site cards, pets, RSS worker, and sidecar runtime.
- WeChat/Remote IM setup can show status, bind when available, and report delivery failures clearly.

## 11. Downstream Final Response Contract

The Windows agent's final response must include:

- What was synced.
- What was changed for Windows only.
- What macOS behavior was preserved.
- Which commands passed.
- Where the Windows package was written.
- Which manual checks were completed.
- Real blockers, if any.

## 12. Known Blockers / Human Intervention

- This handoff was produced on macOS; Windows build and packaged-app behavior are not verified here.
- Windows may need Visual Studio Build Tools for native rebuild.
- Windows signing, installer distribution, and certificate setup are not included.
- WeChat/OpenClaw availability depends on the Windows-side runtime and authenticated WeChat environment.
