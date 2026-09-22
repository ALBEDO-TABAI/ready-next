---
enforce: false
archived_at: 2026-09-06
archive_reason: superseded-project-documentation
---

> 已归档（2026-09-06）：本文保留编写当时的设计、状态与证据，不是当前执行入口；归档不表示原计划全部实现。现行说明见 [当前运行时合同](../../../../../architecture/current-runtime-contracts.md)，去向见 [文档清单](../../../../../documentation-inventory.md)。

# J W0 Pre-flight Audit Report

> Date: 2026-05-02
> Worktree: `/Users/user/Documents/实验田/ready-cowork`
> Branch at audit start: `codex/i-cross-boundary-confirmation`
> HEAD at audit start: `a29425e feat(agent): land I cross-boundary confirmation and renderer observability`
> J counter-proposal source: `docs/archive/2026-09-06/docs/superpowers/plans/2026-05-02-J-main-process-stability-and-log-lifecycle.md` in the current worktree; it was untracked at W0 start.

## Summary

- J remains the right next stability slice: only main-process runtime boundary handlers and local `.log` lifecycle.
- W0 found material evidence drift in the counter-proposal:
  - The proposal said 7 `.log` channels; current code has 9 `.log` channels.
  - The proposal said 11 writer/path points; current code has 15 `getLogPath('ready-*.log')` path points.
  - The proposal only mentioned `appendFileSync`; `ready-browser.log` uses `fs/promises.appendFile`.
  - `getLogPath()` writes to the system temp directory, not `~/Library/Logs/ready`.
- This triggers the §8 evidence-drift ESCALATE. The counter-proposal was corrected in place before any business code planning.
- No current `.log` channel is close to the 1GB boot-rotation trigger; only two existing files were present in the local temp directory.

## Commands Run

```bash
git status --short
git branch --show-current
git log --oneline -5
rg -n "process\.on\('unhandledRejection'|process\.on\(\"unhandledRejection\"|process\.on\('uncaughtException'|process\.on\(\"uncaughtException\"|app\.on\('render-process-gone'|app\.on\(\"render-process-gone\"|app\.on\('child-process-gone'|app\.on\(\"child-process-gone\"|app\.on\(" src/main/index.ts src/main
rg -n "getLogPath\('ready-[^']*\.log'\)|getLogPath\(\"ready-[^\"]*\.log\"\)|getLogPath\('ready-[^']*\.ndjson'\)|getLogPath\(\"ready-[^\"]*\.ndjson\"\)" src/main
rg -n "appendFileSync|appendFile\(" src/main
rg -n "rotateLog|logRotation|maxLogSize|winston-daily|file-stream-rotator|rotating-logger|createRotatingLogger" src/main scripts package.json
node - <<'NODE'
const { tmpdir } = require('os');
const { join } = require('path');
const fs = require('fs');
const logs = [
  'ready-agent-metrics.log',
  'ready-database.log',
  'ready-tools.log',
  'ready-system-tools.log',
  'ready-memory-tools.log',
  'ready-directchat.log',
  'ready-search.log',
  'ready-settings.log',
  'ready-browser.log',
  'ready-design-run-captures.ndjson',
];
console.log(`tmpdir=${tmpdir()}`);
for (const name of logs) {
  const p = join(tmpdir(), name);
  if (!fs.existsSync(p)) {
    console.log(`${name}\tmissing`);
    continue;
  }
  const st = fs.statSync(p);
  console.log(`${name}\t${st.size}\t${(st.size / 1024 / 1024).toFixed(3)} MiB\tmtime=${st.mtime.toISOString()}`);
}
NODE
rg -n "\b(spawn|spawnSync|execFile|execFileSync|execSync|fork|new Worker)\b" src/main
```

## Current Git State

| Item | Current fact |
| --- | --- |
| Branch | `codex/i-cross-boundary-confirmation` |
| HEAD | `a29425e feat(agent): land I cross-boundary confirmation and renderer observability` |
| I docs commit | `7409864 docs(agent): add I cross-boundary confirmation plan and audit` |
| I code commit | `a29425e feat(agent): land I cross-boundary confirmation and renderer observability` |
| Dirty state at W0 start | `?? audits/` and `?? docs/archive/2026-09-06/docs/superpowers/plans/2026-05-02-J-main-process-stability-and-log-lifecycle.md` |

`audits/` is unrelated and remains out of scope.

## Handler Evidence

`src/main/index.ts` currently has only these four existing `app.on(...)` hooks:

| Handler | Evidence |
| --- | --- |
| `browser-window-created` | `src/main/index.ts:573` |
| `activate` | `src/main/index.ts:590` |
| `window-all-closed` | `src/main/index.ts:598` |
| `before-quit` | `src/main/index.ts:611` |

J target handlers are absent from the main process entry:

| Target handler | Current count in `src/main/index.ts` |
| --- | ---: |
| `process.on('unhandledRejection')` | 0 |
| `process.on('uncaughtException')` | 0 |
| `app.on('render-process-gone')` | 0 |
| `app.on('child-process-gone')` | 0 |

Note: `src/main/modules/rss-engine/rsshub-worker.mjs` has its own worker-local `process.on('uncaughtException')` and `process.on('unhandledRejection')`; that does not satisfy the main-process global handler contract.

## Log Path Evidence

`src/main/utils/platform.ts` defines:

```ts
export function getLogPath(filename: string): string {
  return join(tmpdir(), filename)
}
```

Local macOS W0 measurement used:

```text
/var/folders/wd/bypcpnbx07n5_07dhp1m03xm0000gn/T
```

So J documentation must refer to the system temp directory, not `~/Library/Logs/ready`.

## Log Channel Inventory

| Channel | Path points | Writer shape | Current file size |
| --- | ---: | --- | ---: |
| `ready-agent-metrics.log` | 1 | `appendFileSync` | 2.627 MiB |
| `ready-database.log` | 2 | `appendFileSync` | 0.054 MiB |
| `ready-tools.log` | 3 | `appendFileSync` | missing |
| `ready-system-tools.log` | 1 | `appendFileSync` | missing |
| `ready-memory-tools.log` | 1 | `appendFileSync` | missing |
| `ready-directchat.log` | 2 | `appendFileSync` | missing |
| `ready-search.log` | 3 | `appendFileSync` | missing |
| `ready-settings.log` | 1 | `appendFileSync` | missing |
| `ready-browser.log` | 1 | `fs/promises.appendFile` | missing |

Total: 9 `.log` channels, 15 `getLogPath('ready-*.log')` path points.

### Per-channel Source Evidence

| Channel | Source locations |
| --- | --- |
| `ready-agent-metrics.log` | `src/main/modules/agent-control/metrics.ts:4` |
| `ready-database.log` | `src/main/modules/database.ts:306`; `src/main/modules/database/worker-bridge.ts:34` |
| `ready-tools.log` | `src/main/modules/tools/tool-event-log.ts:4`; `src/main/modules/tools/browser-agent-runner.ts:227`; `src/main/modules/tools/browser-tools.ts:30` |
| `ready-system-tools.log` | `src/main/modules/tools/system-tools.ts:14` |
| `ready-memory-tools.log` | `src/main/modules/tools/memory-tools.ts:13` |
| `ready-directchat.log` | `src/main/modules/claude-bridge/direct-chat.ts:144`; `src/main/modules/claude-bridge/ipc-handler.ts:75` |
| `ready-search.log` | `src/main/modules/search-engine/indexer.ts:19`; `src/main/modules/search-engine/file-watcher.ts:39`; `src/main/modules/search-engine/adapters.ts:10` |
| `ready-settings.log` | `src/main/modules/settings-engine/ipc-handler.ts:22` |
| `ready-browser.log` | `src/main/modules/browser-engine/diagnostics-service.ts:4` |

## ndjson Escape Clause

`ready-design-run-captures.ndjson` appears at `src/main/modules/claude-bridge/ipc-handler.ts:284`.

Local W0 measurement:

| File | Current state | Decision |
| --- | --- | --- |
| `ready-design-run-captures.ndjson` | missing | Keep whitelisted and unchanged in J. |

The escape clause is not triggered: the file does not exist locally, so W0 has no evidence of the same accumulation risk as the `.log` streams. If this capture becomes high-frequency later, it should be handled by a separate follow-up.

## Rotation Evidence

The rotation grep returned no existing implementation:

```text
rotateLog / logRotation / maxLogSize / winston-daily / file-stream-rotator / rotating-logger / createRotatingLogger: 0 hits
```

Conclusion: rotation is a real missing capability, not a naming mismatch.

## External Spawn Inventory

External child processes are out of J scope. W0 only records the surface so it is not accidentally folded into the Electron `child-process-gone` work.

Representative external process / worker surfaces:

| Area | Source |
| --- | --- |
| boot cleanup | `src/main/modules/process-cleanup/boot-reaper-core.ts` |
| process-group helper | `src/main/modules/process-cleanup/spawn-with-tree-kill.ts` |
| video fallback | `src/main/modules/claude-bridge/video-fallback-service.ts` |
| worktree commands | `src/main/modules/claude-bridge/worktree-pool.ts` |
| Claude agent process | `src/main/modules/claude-bridge/agent-manager.ts` |
| skill shell primitive | `src/main/modules/tools/skill-primitives/run-shell.ts` |
| system tools | `src/main/modules/tools/system-tools.ts` |
| database worker | `src/main/modules/database/worker-bridge.ts` |
| RSSHub worker | `src/main/modules/rss-engine/rsshub-process.ts` |
| skills runtime | `src/main/modules/skills-runtime/runtime-manager.ts` |
| agent sidecar | `src/main/modules/agent-control/sidecar-manager.ts` |

Decision: external spawn process safety remains ADR / follow-up, not J.

## Open Decisions

| Question | Decision |
| --- | --- |
| W split | W0 doc correction + audit -> W1 process handlers -> W2 rotating logger -> W3 log writer migration -> W4 gates/scripts -> W5 docs/final record. |
| rotation shape | Size-based rotation, default 50MB, keep 5 historical files. |
| handler organization | Split to `src/main/process-handlers.ts` and register from `src/main/index.ts` before `app.whenReady()`. |
| cleanup timeout | 5s timeout. If implementation evidence shows cleanup exceeds 10s, split J1/J2. |
| metric names | `process_unhandled_rejection`, `process_uncaught_exception`, `render_process_gone`, `child_process_gone`, `log_rotation_failed`. |
| metric registry | Do not use `TOOL_ERROR_METRICS`; keep local process/log metric constants. |
| renderer crash notification | Do not push to already-mounted renderer in J; log and metric only. |
| log thresholds | Use one shared threshold for all 9 `.log` channels. |
| ndjson handling | Whitelist and leave unchanged; revisit only if future evidence shows high-frequency growth. |

## ESCALATE Outcomes

| Trigger | Outcome |
| --- | --- |
| §1 evidence drift >30% | Triggered. Counter-proposal was corrected from 7 `.log` / 11 writer-path points / sync-only / wrong path to 9 `.log` / 15 path points / sync+async / system temp directory. |
| >=3 channels already >1GB | Not triggered. Present files: `ready-agent-metrics.log` 2.627 MiB, `ready-database.log` 0.054 MiB; all other measured channels missing. |
| cleanup >10s | Not evaluated in W0 because no business code was run. Implementation keeps this as a hard stop condition. |

## W0 Correction Record

The counter-proposal was revised in place before implementation planning:

- `7` `.log` channels -> `9` `.log` channels + 1 ndjson whitelist candidate.
- Added `ready-settings.log` and `ready-browser.log`.
- Writer/path evidence -> 15 `getLogPath('ready-*.log')` points.
- Direct-write language -> `appendFileSync / appendFile`.
- Log path -> system temp directory through `getLogPath()`.
- External spawn process safety -> explicitly kept as ADR / follow-up.

## Stop Condition

W0 is documentation-only. J business code must not start until the implementation plan is reviewed and approved.
