# J — Main Process Stability and Log Lifecycle Implementation

> W0 is complete in `2026-05-02-J-main-process-stability-and-log-lifecycle-pre-flight-audit-report.md`.
> This implementation plan follows the W0-corrected facts: 9 existing `.log` channels, 15 `getLogPath('ready-*.log')` path points, 1 ndjson whitelist candidate, and no J business code before review.

## Summary

J fixes two operational gaps only:

- Main process has no global `unhandledRejection`, `uncaughtException`, `render-process-gone`, or Electron-internal `child-process-gone` handler.
- Existing `ready-*.log` files are direct single-file writes with no rotation.

J does not start runtime audit harness work, e2e matrix expansion, turn-engine refactors, RSS reuse contracts, remote aggregation, or external `child_process.spawn` safety nets.

## Completion Standard

J is complete only when:

- The four main-process handlers exist and are registered before `app.whenReady()`.
- Fatal global errors attempt bounded cleanup and then exit.
- Electron runtime-gone events are logged and metriced without forcing main-process exit.
- All 9 existing `.log` channels use the rotating logger path.
- `ready-design-run-captures.ndjson` remains explicitly whitelisted.
- New gates fail if any target handler is removed or any new direct `.log` write appears.
- `npm run verify:j` passes, and `verify:j` embeds `verify:i`.
- `git diff --check` passes.

## ESCALATE Handling

| Trigger | W0 / implementation action |
| --- | --- |
| §1 evidence drift >30% | Triggered in W0. Counter-proposal corrected before code. |
| >=3 log channels already >1GB | Not triggered in W0. Use lazy rotation, not boot-time eager rotation. |
| cleanup path >10s | If discovered during implementation, stop and split J into J1/J2. |
| external spawn process safety appears necessary | Stop scope expansion; record ADR / follow-up only. |

## Dependency Note

The work packages remain W1 -> W5 for review, but implementation must avoid a temporary direct-write process log. If the handler code needs a file-backed event sink before W2 is complete, use an injected test sink in W1 and bind it to `createRotatingLogger` once W2 lands. Do not introduce a new direct `.log` writer as an intermediate state.

## Land Order

### W1 — Main Process Handlers

Files:

- `src/main/process-handlers.ts`
- `src/main/index.ts`
- focused handler tests under `src/__tests__/`

Tasks:

- Add a small `registerMainProcessHandlers` module.
- Register before `app.whenReady()`.
- Cover:
  - `process.on('unhandledRejection')`
  - `process.on('uncaughtException')`
  - `app.on('render-process-gone')`
  - `app.on('child-process-gone')`
- Fatal handlers:
  - record event
  - emit local process metric
  - call bounded cleanup
  - exit with code 1
- Runtime-gone handlers:
  - record event
  - emit local process metric
  - do not force exit
- Keep external `child_process.spawn` failures out of this module.

Verify:

```bash
npx tsx@^4.19.2 --test --test-concurrency=1 src/__tests__/process-handlers.test.ts
```

### W2 — Rotating Logger Helper

Files:

- `src/main/utils/rotating-logger.ts`
- `src/__tests__/rotating-logger.test.ts`

Tasks:

- Add `createRotatingLogger(filename, options?)`.
- Use `getLogPath(filename)` by default.
- Rotate lazily on append when current file reaches the threshold.
- Default threshold: 50MB.
- Default history count: 5 files.
- Support env overrides:
  - `READY_LOG_MAX_BYTES`
  - `READY_LOG_MAX_FILES`
- Rotation failure must not break the caller's main flow.
- Emit `log_rotation_failed` through local process/log metric constants, not `TOOL_ERROR_METRICS`.

Unit coverage:

- below threshold appends normally
- above threshold rotates
- at most 5 history files remain
- rotation failure does not break append
- restart/idempotence respects existing files

Verify:

```bash
npx tsx@^4.19.2 --test --test-concurrency=1 src/__tests__/rotating-logger.test.ts
```

### W3 — Existing Log Writer Migration

Migrate the 9 existing `.log` channels:

| Channel | Source files |
| --- | --- |
| `ready-agent-metrics.log` | `src/main/modules/agent-control/metrics.ts` |
| `ready-database.log` | `src/main/modules/database.ts`; `src/main/modules/database/worker-bridge.ts` |
| `ready-tools.log` | `src/main/modules/tools/tool-event-log.ts`; `src/main/modules/tools/browser-agent-runner.ts`; `src/main/modules/tools/browser-tools.ts` |
| `ready-system-tools.log` | `src/main/modules/tools/system-tools.ts` |
| `ready-memory-tools.log` | `src/main/modules/tools/memory-tools.ts` |
| `ready-directchat.log` | `src/main/modules/claude-bridge/direct-chat.ts`; `src/main/modules/claude-bridge/ipc-handler.ts` |
| `ready-search.log` | `src/main/modules/search-engine/indexer.ts`; `src/main/modules/search-engine/file-watcher.ts`; `src/main/modules/search-engine/adapters.ts` |
| `ready-settings.log` | `src/main/modules/settings-engine/ipc-handler.ts` |
| `ready-browser.log` | `src/main/modules/browser-engine/diagnostics-service.ts` |

Tasks:

- Replace direct `.log` `appendFileSync` / `appendFile` paths with rotating logger calls.
- Preserve current swallow-on-log-failure behavior at call sites.
- Keep `ready-design-run-captures.ndjson` unchanged and explicitly whitelisted.
- Do not migrate non-`ready-*.log` artifact/debug writes in this stage.

Verify:

```bash
npm run verify:i
```

### W4 — Gates and Scripts

Files:

- `scripts/check-process-handlers.cjs`
- `scripts/check-log-rotation.cjs`
- `scripts/__tests__/check-process-handlers.test.cjs`
- `scripts/__tests__/check-log-rotation.test.cjs`
- `package.json`

Tasks:

- Add `check-process-handlers.cjs`.
  - Fails if any of the four target handlers is missing.
  - Fails if process/log metrics are routed through `TOOL_ERROR_METRICS`.
- Add `check-log-rotation.cjs`.
  - Fails on direct `.log` `appendFileSync` / `appendFile` in `src/main/` outside the rotating logger helper and tests.
  - Allows `ready-design-run-captures.ndjson`.
- Add break tests for both scripts.
- Add scripts:
  - `test:j:gates`
  - `test:j:focus`
  - `verify:j`
- `verify:j` must be:

```text
npm run verify:i && node scripts/check-process-handlers.cjs && node scripts/check-log-rotation.cjs && npm run test:j:gates && npm run test:j:focus
```

Verify:

```bash
npm run test:j:gates
npm run test:j:focus
```

### W5 — Docs and Final Record

Files:

- `docs/superpowers/plans/2026-05-02-J-main-process-stability-and-log-lifecycle.md`
- `docs/superpowers/plans/2026-04-30-skill-runtime-agent-layer-reframe.md`
- `CLAUDE.md`
- `AGENTS.md`

Tasks:

- Fill the J Final Record:
  - final HEAD
  - `npm run verify:j` output
  - 9 migrated `.log` channels
  - ndjson whitelist decision
  - break-test coverage
- Add J row to the roadmap as v3 audit-scope expansion, not v4.
- Add synced J constraints to CLAUDE.md / AGENTS.md:
  - four main-process handlers must exist
  - `ready-*.log` must use rotating logger
  - process/log metrics do not enter `TOOL_ERROR_METRICS`
  - `READY_LOG_MAX_BYTES` / `READY_LOG_MAX_FILES` are the supported thresholds

Verify:

```bash
git diff --check
npm run verify:j
```

## Test Plan

| Area | Required proof |
| --- | --- |
| process handler gate | Removing any one target handler fails `check-process-handlers.cjs`. |
| metric placement | Adding process/log metric names to `TOOL_ERROR_METRICS` fails the gate. |
| log rotation gate | Adding direct `.log` `appendFileSync` or `appendFile` outside the helper fails `check-log-rotation.cjs`. |
| ndjson whitelist | `ready-design-run-captures.ndjson` is allowed by `check-log-rotation.cjs`. |
| rotating logger unit tests | Below threshold, threshold crossing, max history, failure tolerance, restart/idempotence. |
| fatal handler behavior | Fatal process errors attempt cleanup and exit; handler itself does not throw. |
| runtime-gone behavior | Renderer/Electron child process events log and metric without forced main exit. |
| final verification | `npm run verify:j` and `git diff --check`. |

## Risk + Mitigation

| Risk | Mitigation |
| --- | --- |
| Global fatal handler swallows real bugs | Fatal handlers always exit after bounded cleanup. |
| Cleanup hangs | Use 5s timeout; if evidence shows >10s, split J1/J2. |
| New logger creates boot slowdown | Use lazy rotation because W0 found no >1GB channels. |
| Async browser diagnostics behavior changes | Preserve fire-and-forget semantics; only replace write sink. |
| Gate catches non-log artifact writes | Limit check to `ready-*.log` and direct `.log` writes, with explicit helper/test/ndjson whitelist. |
| Scope expands into external spawn cleanup | External spawn inventory remains ADR/follow-up only. |
| Process/log metrics pollute tool-error registry | Gate rejects `TOOL_ERROR_METRICS` use for J metric names. |

## Final Record

- Feat HEAD: `9453967 feat(stability): land J main-process handlers and log rotation`
- `npm run verify:j`: passed. The chain includes `verify:i`, `check-process-handlers.cjs`, `check-log-rotation.cjs`, `test:j:gates`, and `test:j:focus`.
- `git diff --check`: passed.
- Main process handlers: `unhandledRejection`, `uncaughtException`, `render-process-gone`, and Electron-internal `child-process-gone` are registered before `app.whenReady()`.
- Fatal behavior: fatal process handlers attempt 5s bounded cleanup and then call `app.exit(1)`.
- Runtime-gone behavior: Electron runtime-gone handlers record event + metric and do not force main-process exit.
- Migrated `.log` channels: `ready-agent-metrics.log`, `ready-database.log`, `ready-tools.log`, `ready-system-tools.log`, `ready-memory-tools.log`, `ready-directchat.log`, `ready-search.log`, `ready-settings.log`, `ready-browser.log`.
- ndjson decision: `ready-design-run-captures.ndjson` remains unchanged and explicitly whitelisted.
- Break coverage: missing handler, metric registry pollution, direct sync `.log` write, direct async `.log` write, threshold rotation, max history, rotation failure tolerance, restart idempotence, and sync + async writer coverage.
- ESCALATE outcomes: cleanup >10s not observed; external spawn scope did not expand; no new evidence drift after W0 correction.
