# Ready Windows Coding Agent Handoff

This document is for a Windows-side coding agent working from the shared Ready source mirror.

## Source Map

- Mac working copy: `/Users/user/实验田/ready-cowork`
- Mac shared mirror A: `/Volumes/工作素材/ready`
- Mac shared mirror B: `/Volumes/视觉部/software-test/ready`
- Windows working copy: use a local disk path, for example `C:\Work\ready-cowork`

The shared mirror is a transfer surface. Do not run dependency install, dev server, tests, or packaging directly on the shared path.

Use exactly one shared mirror for a given task. Ask which mirror is authoritative, copy that mirror to a local Windows folder, and return changes to the same mirror. Do not merge by copying from both shared mirrors.

## Start On Windows

1. Copy the shared mirror to a local Windows folder.
2. Open the local Windows folder in the coding agent.
3. Read `AGENTS.md` before editing.
4. Install dependencies locally:

```powershell
npm install
```

5. Prove native SQLite is usable under Electron:

```powershell
npm run verify:native
```

6. For ordinary development, run:

```powershell
npm run typecheck
npm run dev
```

If the task touches tests or shared contracts, run the narrow relevant test first, then the closest repo verify script named in `package.json`.

## Copy From Shared To Local

Use the real Windows-mounted path for the chosen shared mirror in `$Shared`.

```powershell
# Replace this with the mounted Windows path for the chosen mirror.
$Shared = "Z:\ready"
$Local = "C:\Work\ready-cowork"

robocopy $Shared $Local /MIR `
  /XD node_modules out exports dist coverage test-results logs .worktrees .superpowers `
      ".claude\codex-audit" ".claude\worktrees" "build\runtime-seeds" `
      ".git\lost-found" ".git\worktrees" ".git\logs" `
  /XF .env .env.local "*.env.local" "*.log" "*.tsbuildinfo" `
      COMMIT_EDITMSG FETCH_HEAD ORIG_HEAD REBASE_HEAD MERGE_HEAD MERGE_MSG CHERRY_PICK_HEAD index.lock gc.log
```

## Return Changes To Shared

Before copying back:

1. Stop `npm run dev` and any Electron child processes.
2. Do not copy `node_modules`, `out`, `exports`, `dist`, logs, test output, local env files, or Windows-only scratch data.
3. Leave a short summary of what changed and what was verified.

Then mirror the local Windows source back to the same shared folder you copied from:

```powershell
# Use the same mounted Windows path chosen above.
$Shared = "Z:\ready"
$Local = "C:\Work\ready-cowork"

robocopy $Local $Shared /MIR `
  /XD node_modules out exports dist coverage test-results logs .worktrees .superpowers `
      ".claude\codex-audit" ".claude\worktrees" "build\runtime-seeds" `
      ".git\lost-found" ".git\worktrees" ".git\logs" `
  /XF .env .env.local "*.env.local" "*.log" "*.tsbuildinfo" `
      COMMIT_EDITMSG FETCH_HEAD ORIG_HEAD REBASE_HEAD MERGE_HEAD MERGE_MSG CHERRY_PICK_HEAD index.lock gc.log
```

After Windows changes are back in the shared mirror, the Mac side should pull from the matching mirror:

```bash
# Mirror A
/Users/user/.codex/skills/soft-ready/scripts/soft-ready.sh in --shared-root /Volumes/工作素材/ready --apply

# Mirror B
/Users/user/.codex/skills/soft-ready/scripts/soft-ready.sh in --shared-root /Volumes/视觉部/software-test/ready --apply
```

## Boundaries

- Windows dependency/native rebuilds must happen on Windows.
- The current `electron-builder.yml` is Mac-first. If the task is Windows packaging, update and verify the Windows target explicitly.
- Do not treat a window opening as proof. For app changes, verify the route, native dependency check, and the concrete feature touched by the task.
- Do not add hardcoded routing or fixed-rule shortcuts to bypass Ready's agent/tool contracts.
