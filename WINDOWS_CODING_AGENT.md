# Ready Windows Coding Agent Sync Handoff

Last updated: 2026-06-11 22:16 CST

This document is for a Windows-side coding agent that needs to continue Ready development from the Mac source state and prove that the Windows UI and behavior still match the Mac development baseline.

## Completion Standard

The Windows handoff is complete only when all of these are true:

1. Windows works from one local copy made from one shared mirror.
2. Dependencies are installed on Windows, not copied from Mac.
3. Native SQLite is rebuilt and verified on Windows.
4. `typecheck` and the current phase verification pass on Windows, or every failure is explained with exact evidence.
5. The dev app opens on Windows and the required UI surfaces are manually checked.
6. Any Windows change is returned to the same shared mirror with a short verification report.

Do not report "synced" if only the files were copied. The app must run and the visible UI must be checked.

## Current Mac Baseline

- Mac working copy: `/Users/user/实验田/ready-cowork`
- Branch: `agent-evolution/phase1`
- Current HEAD: `9f583e1f` (`fix(agent): EP1 audit value-free shape -- DB row/metrics carry no parameter values`)
- Source-code working tree at this handoff: clean before this document was refreshed
- Expected uncommitted handoff file if not yet committed: `WINDOWS_CODING_AGENT.md`
- Current phase status: Agent evolution phase 1 is documented as 13/13 complete.
- Main regression entry for this phase: `npm run verify:evolution-p1`
- Current runtime source of truth: `package.json`
  - `electron`: `42.3.0`
  - Node requirement: `>=20.0.0`

Some older project docs still mention earlier Electron versions. For Windows setup and verification, trust `package.json`, `package-lock.json`, and the commands in this file.

Recent commits Windows should include:

```text
9f583e1f fix(agent): EP1 audit value-free shape -- DB row/metrics carry no parameter values
8baf16f6 fix(agent): EP1 audit strict form -- params_json stores summary+sha256 only; card/metrics carry fingerprint
6b586ca5 fix(agent): EP1 review rivets -- act_on_target gate, staged site cards, TTL unify, audit redaction, envelope reason
7a74a316 feat(agent): EP1-G1 verify chain + docs sync; fix phase-1 host-node regressions
2ac5efa0 feat(agent): EP1-I3-2 frozen-call release + confirmation card
c3c4c186 feat(agent): EP1-T4-2 tool result envelope coexistence + browser/skill pilot
34088199 feat(agent): EP1-I3-1 action confirmation policy table + dispatch gate
19b7db4e docs(agent-evolution): phase-1 checkpoint & handoff (9/13 done)
```

## Shared Mirrors

Use exactly one mirror for a task.

- Mirror A on Mac: `/Volumes/工作素材/ready`
- Mirror B on Mac: `/Volumes/视觉部/software-test/ready`
- Windows local working copy example: `C:\Work\ready-cowork`

The shared mirror is only a transfer surface. Do not run `npm install`, `npm run dev`, tests, or packaging directly on the shared path.

Ask the human which mirror is authoritative if it is not already clear. Never copy from one mirror and return changes to the other.

## Mac Side Publish Step

The Mac side should push the current source to the chosen mirror before Windows starts.

Dry run:

```bash
/Users/user/.codex/skills/soft-ready/scripts/soft-ready.sh up --shared-root /Volumes/工作素材/ready
```

Apply:

```bash
/Users/user/.codex/skills/soft-ready/scripts/soft-ready.sh up --shared-root /Volumes/工作素材/ready --apply
```

Use Mirror B only if the human chose it:

```bash
/Users/user/.codex/skills/soft-ready/scripts/soft-ready.sh up --shared-root /Volumes/视觉部/software-test/ready --apply
```

## Windows Intake

Copy the chosen shared mirror to a local Windows disk. Replace `$Shared` with the real mounted path.

```powershell
$Shared = "Z:\ready"
$Local = "C:\Work\ready-cowork"

robocopy $Shared $Local /MIR `
  /XD node_modules out exports dist coverage test-results logs .worktrees .superpowers `
      ".claude\codex-audit" ".claude\worktrees" "build\runtime-seeds" `
      ".git\lost-found" ".git\worktrees" ".git\logs" `
  /XF .env .env.local "*.env.local" "*.log" "*.tsbuildinfo" `
      COMMIT_EDITMSG FETCH_HEAD ORIG_HEAD REBASE_HEAD MERGE_HEAD MERGE_MSG CHERRY_PICK_HEAD index.lock gc.log
```

`robocopy` can return `1` when files were copied successfully. Treat exit codes `0` through `7` as non-fatal; investigate `8` or higher.

Then enter the local copy:

```powershell
cd C:\Work\ready-cowork
git status --short --branch
git log -8 --oneline --decorate
```

Expected baseline before Windows edits:

```text
## agent-evolution/phase1
 M WINDOWS_CODING_AGENT.md
```

If `WINDOWS_CODING_AGENT.md` has already been committed by the Mac side, the status can be clean. No source file should be dirty before Windows starts.

The log must include `9f583e1f` at HEAD or the newer Mac-approved handoff commit.

## Windows Setup

Use Node 20 or newer. Do not reuse Mac `node_modules`.

```powershell
node -v
npm -v
npm install
```

If the install fails because native packages are stale, delete `node_modules` and run `npm install` again. Do not edit source code to bypass native dependency failures.

## Required Verification

Run these first on Windows:

```powershell
npm run verify:native
npm run typecheck
npm run verify:evolution-p1
```

For broad changes, also run:

```powershell
npm run test
```

For release or packaged-app work, build the Windows unpacked app and smoke it:

```powershell
npm run build
npx electron-builder --config electron-builder.yml --win --dir
node scripts/run-packaged-smoke.cjs --platform win32 --port 9335 --timeout 90000 --out test-results/windows-packaged-smoke.json
```

Do not use the old 2026-05-28 Windows CI smoke as current proof. It is useful history, not proof for this branch.

## Dev App Manual UI Check

Start the app:

```powershell
npm run dev
```

Check these surfaces in the real Windows Electron window:

1. Startup: no white screen, no bootstrap failure, title is Ready.
2. Workbench: `browser`, `document`, `rss`, and `calendar` modes can be opened or switched without breaking layout.
3. Browser surface: BrowserView content appears in the correct area; native overlay does not cover the chat panel or toolbar unexpectedly.
4. Document surface: a local document can be opened, edited, and saved in a scratch workspace.
5. Agent panel: conversation UI loads; if provider keys are unavailable, the error must be clear and non-destructive.
6. High-risk action confirmation: use a scratch file only. A delete or similarly risky agent action must show a confirmation path instead of silently executing.
7. Chat input liquid glass: verify in the real dev app, not only `#/liquid-test`. Scrolled text behind the input should update live, the final message should not be hidden behind the input, and there should be no external dark shadow.
8. Settings: AI provider/settings pages open; do not copy or expose real `.env` values, cookies, tokens, or API keys.
9. Logs: check `%TEMP%\ready-directchat.log`, `%TEMP%\ready-tools.log`, and `%TEMP%\ready-browser.log` if any surface fails.

Known Windows-specific note: `src/main/modules/rss-engine/rsshub-worker.mjs` skips its parent-process watchdog on `win32`. That skip is not by itself a parity failure, but RSS startup and shutdown should still be observed if the task touches RSS.

## Must-Read Files

Read these before editing:

- `AGENTS.md`
- `CLAUDE.md`
- `package.json`
- `electron-builder.yml`
- `docs/agent-evolution/PHASE1-CHECKPOINT-handoff.md`
- `docs/agent-evolution/08-缺陷解决映射与验收追踪.md`
- `docs/superpowers/plans/2026-06-11-agent-evolution-phase1-implementation.md`
- `docs/superpowers/specs/2026-06-11-electron-liquid-glass-composer.md`
- `docs/superpowers/audits/2026-05-24-stage-z-closeout/platform-parity.md`
- `docs/superpowers/audits/2026-05-24-stage-z-closeout/platform-windows-smoke.md`

## Current Phase Modules To Preserve

Do not weaken or bypass these phase-1 contracts while making Windows fixes:

- Action confirmation policy: `src/main/modules/agent-control/safety/action-confirmation-policy.ts`
- Frozen call bridge/store/confirmation:
  - `src/main/modules/agent-control/safety/frozen-call-bridge.ts`
  - `src/main/modules/agent-control/safety/frozen-call-store.ts`
  - `src/main/modules/agent-control/safety/frozen-call-confirmation.ts`
- Tool executor and result envelope:
  - `src/main/modules/tools/tool-executor.ts`
  - `src/main/modules/tools/tool-result-envelope.ts`
- Belief/site card and prompt assets:
  - `src/main/modules/agent-control/knowledge/site-card-reader.ts`
  - `src/main/modules/agent-control/domain-adapters/site-card-fragments.ts`
  - `src/main/modules/agent-control/prompt-assets/roots.ts`
  - `assets/prompts/**`
  - `assets/site-cards/**`
- IPC/preload/renderer type surface:
  - `src/preload/index.ts`
  - `src/renderer/types/electron.d.ts`
- Migrations:
  - `src/main/modules/migrations.ts`

If a Windows issue appears in one of these areas, write or run the matching focused test first. Do not patch around the contract with platform-only shortcuts.

## Do Not Do

- Do not copy `node_modules`, `out`, `exports`, `dist`, logs, caches, local env files, or generated test output between Mac and Windows.
- Do not copy Mac native binaries into Windows.
- Do not run heavy dev/build loops directly on the shared mirror.
- Do not mix Mirror A and Mirror B in one task.
- Do not hide failures by skipping `verify:native`.
- Do not hardcode routing or fixed-rule shortcuts to bypass Ready agent/tool contracts.
- Do not turn platform differences into permanent UI divergence unless the human explicitly approves it.
- Do not commit secrets, logs with credentials, cookies, OAuth device codes, provider keys, or feedback packages.

## Returning Windows Changes To Shared

Before copying back:

```powershell
git status --short
git diff --stat
npm run verify:native
npm run typecheck
npm run verify:evolution-p1
```

If the task touched packaging, also include the packaged smoke output path.

Stop `npm run dev` and any Electron child processes, then mirror the local source back to the same shared folder:

```powershell
$Shared = "Z:\ready"
$Local = "C:\Work\ready-cowork"

robocopy $Local $Shared /MIR `
  /XD node_modules out exports dist coverage test-results logs .worktrees .superpowers `
      ".claude\codex-audit" ".claude\worktrees" "build\runtime-seeds" `
      ".git\lost-found" ".git\worktrees" ".git\logs" `
  /XF .env .env.local "*.env.local" "*.log" "*.tsbuildinfo" `
      COMMIT_EDITMSG FETCH_HEAD ORIG_HEAD REBASE_HEAD MERGE_HEAD MERGE_MSG CHERRY_PICK_HEAD index.lock gc.log
```

## Mac Side Pullback

After Windows returns changes to the shared mirror, the Mac side pulls from the same mirror:

```bash
/Users/user/.codex/skills/soft-ready/scripts/soft-ready.sh in --shared-root /Volumes/工作素材/ready --apply
```

Or Mirror B if that was the chosen mirror:

```bash
/Users/user/.codex/skills/soft-ready/scripts/soft-ready.sh in --shared-root /Volumes/视觉部/software-test/ready --apply
```

Then Mac should run at least:

```bash
git status --short --branch
npm run verify:native
npm run typecheck
npm run verify:evolution-p1
```

## Copy-Paste Prompt For The Windows Coding Agent

```text
You are continuing Ready on Windows from the Mac source handoff.

Source baseline:
- Branch: agent-evolution/phase1
- Expected HEAD: 9f583e1f or a newer Mac-approved handoff commit
- Work only in a local Windows copy, not on the shared mirror

First read:
- WINDOWS_CODING_AGENT.md
- AGENTS.md
- CLAUDE.md
- package.json
- electron-builder.yml
- docs/agent-evolution/PHASE1-CHECKPOINT-handoff.md
- docs/agent-evolution/08-缺陷解决映射与验收追踪.md
- docs/superpowers/specs/2026-06-11-electron-liquid-glass-composer.md

Rules:
- Do not copy node_modules, build outputs, logs, local env files, or Mac native binaries.
- Do not bypass Ready's agent/tool contracts for a Windows-only shortcut.
- Do not claim UI parity until the Windows Electron dev app has been opened and checked.
- If provider keys are unavailable, verify UI/error behavior without exposing secrets.

Required checks:
- npm install
- npm run verify:native
- npm run typecheck
- npm run verify:evolution-p1
- npm run dev, then manually check startup, workbench modes, BrowserView, document editing, agent panel, confirmation card behavior in a scratch workspace, liquid-glass chat input, settings, and relevant logs.

Final report:
- State the starting commit and ending commit/status.
- List changed files.
- List commands run and pass/fail result.
- List manual UI surfaces checked.
- Call out any Windows-only platform difference, with file/log evidence.
- Return changes only to the same shared mirror used for intake.
```
