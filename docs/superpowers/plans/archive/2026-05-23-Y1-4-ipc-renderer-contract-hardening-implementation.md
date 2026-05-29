---
name: Y1-4-ipc-renderer-contract-hardening-implementation
stage: Y1.4
date: 2026-05-23
status: implementation-draft
enforce: false
parent_roadmap: docs/superpowers/plans/2026-05-23-Y-ready-product-completion-and-release-hardening-roadmap.md
scope_lock: §11.4 (IPC/renderer contract hardening — reduction-only)
acceptance_reference: §11.4 acceptance + §13 Stage Z entry contract (Y1.4 is part of the release-relevant P1 subset)
---

# Y1.4 — IPC/renderer contract hardening (reduction-only) implementation plan

## 0. Decision summary

| Disposition | Count | Detail |
| --- | --- | --- |
| handled-only → removed | 1 | `browser:previewUpdateBounds` (legacy dual-registration, renderer uses `send` exclusively) |
| handled-only → kept with reason | 1 | `document:cancelReindex` (defensive teardown hook in 5-channel SourceIndexGroup; removing breaks group invariant + loses defensive abort) |
| non-literal push → removed | 0 | All 13 sites are forwarder lambdas wrapping a literal-emit upstream; removing requires architectural refactor of the forwarder pattern which is OUT of "reduction-only" scope |
| non-literal push → kept with reason | 13 | All re-verified: literal upstream emit sites still present at documented locations; reasons refreshed |
| `electron.d.ts` extraction | deferred to Y2.1 | 3294 lines; clear subgroup boundaries documented in §3 but extraction itself goes to Y2.1 large-file wave per §12.1 |

Net allowlist reduction: 1 entry removed (handled-only: 2 → 1; non-literal push: 13 → 13).

Per §11.4 scope lock the phase is reduction-only: I MUST NOT add new IPC channels; removing the legacy dual-registration handler at `ipc-shell.ts:233-236` is a pure reduction (the renderer side already uses `ipcRenderer.send`-only via `src/preload/index.ts:368-371`).

## 1. Scope

In scope:

- Remove the dead `ipcMain.handle('browser:previewUpdateBounds', ...)` registration at `src/main/modules/browser-engine/ipc-shell.ts:233-236`. The `ipcMain.on('browser:previewUpdateBounds', ...)` registration at lines 237-242 stays — that is the live path matching the preload `send`.
- Remove the corresponding `invoke_only` allowlist entry from `scripts/ipc-contract-allowlist.json`.
- Add a behavior test `src/__tests__/browser-preview-update-bounds-send-contract.test.ts` that proves:
  - `setupBrowserShellIPC` registers `ipcMain.on('browser:previewUpdateBounds', ...)` (the live send path).
  - `setupBrowserShellIPC` does NOT register `ipcMain.handle('browser:previewUpdateBounds', ...)` (the removed legacy path).
  - The preload (`src/preload/index.ts:368-371`) routes `previewUpdateBounds` through `ipcRenderer.send`, not `ipcRenderer.invoke`, by source-shape assertion.
- Refresh `reason` field on the `document:cancelReindex` allowlist row to reflect current Stage Y understanding (it's a defensive teardown hook, no longer scheduled for stage-W cleanup).
- Refresh `reason` fields on all 13 non-literal-push allowlist rows to (a) confirm the literal upstream emit site still exists at the documented line, (b) note that removal would require forwarder-pattern refactor out of `reduction-only` scope, (c) extend `expiry` no longer than the existing 2026-08-21 baseline (i.e., do NOT bump expiry — Stage Y is not extending the debt window; subsequent stages may re-evaluate).
- Document `src/renderer/types/electron.d.ts` extraction proposal in §3 (DO NOT execute extraction; defer to Y2.1 per `parent_roadmap` §12.1).
- Update `docs/superpowers/audits/2026-05-23-stage-y-closeout/deferred-work-ledger.md` with one disposition row for Y1.4 and one row for the deferred electron.d.ts extraction.

Out of scope (explicit):

- Adding any new IPC channel (forbidden by §11.4 "May NOT add new IPC channels; this phase is reduction-only").
- Removing the `document:cancelReindex` handler (would break the 5-channel SourceIndexGroup invariant; the channel ships defensively for app-quit teardown; renderer wiring is Stage Z scope).
- Refactoring the browser-engine forwarder-lambda pattern (12 of the 13 non-literal-push sites). The pattern is architectural — each service receives `sendToRenderer` as a DI prop so it can be unit-tested in isolation. Removing the pattern would either (a) push direct `controller.sendToRenderer('literal', data)` calls into every service (no scanner benefit, more coupling), or (b) require a registry-based publish surface (a real refactor, out of scope).
- Executing `electron.d.ts` extraction (defer to Y2.1 per §12.1; extraction proposal documented in §3 below).
- Touching `src/preload/index.ts`, `src/renderer/types/electron.d.ts` member surface, or any other IPC-shaped renderer code beyond the one test file.

## 2. Inventory of current allowlist (Y1.4 entry state)

### 2.1 handled-only (`invoke_only`) — 2 rows

| # | channel | live handler | preload caller | decision |
| --- | --- | --- | --- | --- |
| 1 | `browser:previewUpdateBounds` | `src/main/modules/browser-engine/ipc-shell.ts:233-236` (`ipcMain.handle`) — dead | `src/preload/index.ts:368-371` uses `ipcRenderer.send` only | **REMOVE** the `handle()` registration. The `on()` registration at lines 237-242 is the live path. |
| 2 | `document:cancelReindex` | `src/main/modules/search-engine/ipc/source-index-group.ts:183-193` (`ipcMain.handle`) — defensive | no renderer caller | **KEEP**, refresh reason. The SourceIndexGroup intentionally bundles 5 channels (`document:listSources/indexDocument/reindexAllSources/reindexWorkspace/cancelReindex`) per Stage V V2.4a; removing one would break the group invariant. The handler exists as the abort hook for in-flight worker reindex jobs (per `searchEngine.cancelReindex()` plumbing) — when a renderer caller is wired at Stage Z's workspace-close lifecycle work, no IPC contract change is needed. |

### 2.2 non-literal push (`non_literal_push`) — 13 rows

All 13 are forwarder lambdas of the shape `(channel, data) => sendToRenderer(channel, data)` (or the spy wrapper at row 13). Each row's literal upstream emit site was verified present at the documented line.

| # | callsite | variable | upstream literal source | decision |
| --- | --- | --- | --- | --- |
| 1 | `ipc-handler.ts:149` | `channel` | `download-service.ts:229,268` `'browser:downloadUpdate'` | KEEP — forwarder lambda; upstream literal confirmed |
| 2 | `ipc-handler.ts:155` | `channel` | `app-shortcut-service.ts:26` `'app:shortcut'` | KEEP — forwarder lambda; upstream literal confirmed |
| 3 | `ipc-handler.ts:173` | `channel` | `context-menu-service.ts:401` `'browser:fastCardContextAction'` | KEEP — forwarder lambda; upstream literal confirmed |
| 4 | `ipc-handler.ts:182` | `channel` | `bookmark-transfer-service.ts:179,221` `'browser:bookmarksChanged'` | KEEP — forwarder lambda; upstream literal confirmed |
| 5 | `ipc-handler.ts:198` | `channel` | `preview-service.ts:68` `'browser:previewUpdate'` | KEEP — forwarder lambda; upstream literal confirmed |
| 6 | `ipc-handler.ts:228` | `channel` | `tab-meta-service.ts:65` `'browser:tabUpdate'` | KEEP — forwarder lambda; upstream literal confirmed |
| 7 | `ipc-handler.ts:247` | `channel` | `tab-lifecycle-service.ts:194,237,246,255,270` `'browser:tabUpdate'` | KEEP — forwarder lambda; upstream literal confirmed |
| 8 | `ipc-handler.ts:289` | `channel` | `session-policy-service.ts:173,180` `'browser:adblockUpdate'` | KEEP — forwarder lambda; upstream literal confirmed |
| 9 | `ipc-handler.ts:329` | `channel` | `utility-menu-service.ts:106,109,123,176` `'browser:bookmarksChanged'` + `'browser:clipCurrentTabRequested'` | KEEP — forwarder lambda; upstream literals confirmed |
| 10 | `ipc-handler.ts:420` | `channel` | central `sendToRenderer` body; all emitters listed in row reason | KEEP — central dispatch helper; this is the runtime fan-out endpoint, all callers emit literals at their own sites which the literal scan catches |
| 11 | `ipc-handler.ts:1441` | `channel` | `clip-dragged-tab-runner.ts:304` `'clip:backgroundUpdate'` | KEEP — forwarder lambda; upstream literal confirmed |
| 12 | `ipc-handler.ts:1444` | `channel` | `content-study-runner.ts:409` `'clip:contentStudyUpdate'` | KEEP — forwarder lambda; upstream literal confirmed |
| 13 | `content-study-runner.ts:182` | `channel` | upstream `clip-dragged-tab-runner.ts:304` (`clip:backgroundUpdate`) + `content-study-runner.ts:409` (`clip:contentStudyUpdate`) | KEEP — spy wrapper inside the content-study runner; both literals confirmed upstream |

Removal of any of the 13 would require architectural refactor of the forwarder/DI pattern (out of "reduction-only" scope). The 12 forwarder rows + 1 spy row stay as-is with refreshed reasons; **expiry is NOT bumped past 2026-08-21** — Stage Y respects the existing debt window and lets the next post-Stage-Y owner re-evaluate.

## 3. `src/renderer/types/electron.d.ts` size review

Current size: **3294 lines**.

Top-level structure (interfaces / types declared at file root):

- IPC response helpers (`IPCResponse`, `SendScopedResponse`)
- Channel/agent types (`ChannelAdapterType`, `AgentChannelConfigData`, `AgentCronTaskData`, `AgentHeartbeatSnapshot`, `AgentRuntimeStatusData`)
- Capability/conversation types (`CapabilityRuntimeSnapshotData`, `ConversationScopeData`, `ConversationScopeMessageData`, `ConversationEventData`, `ConversationAttachmentData`, `RemoteAttachmentCacheStatsData`)
- ScopeRun family (`ScopeRunTraceItemData`, `ScopeRunMemoryRefData`, `ScopeRunTriggerHitData`, `ScopeRunContextBudgetData`, `ScopeRunTaskStepData`, `ScopeRunTaskContinuationData`, `ScopeRunSkillProgressData`, `ScopeRunSkillHandoffData`, `ContinuationIntentData`, `ScopeRunMemoryCaptureItemData`, `ScopeRunMemoryCaptureData`, `ScopeRunExecutionDiagnosticsData`)
- Task projection family (`TaskTypeData`, `TaskInteractionStateData`, `TaskProjectionStatusData`, `TaskBudgetData`, `RecoveryRecordData`, `TaskProjectionStepData`, `TaskProjectionRecordData`)
- Session recall / detached / reference (`ScopeRunSummaryData`, `SessionRecallMatchKindData`, `SessionRecallHitData`, `SessionRecallCapsuleData`, `ReferenceSkillHintData`, `DetachedSkillTaskData`, `ActiveChildRunSummaryData`)
- Terminal/event (`ScopeRunTerminalReasonData`, `ScopeRunEventData`, `TaskProjectionChangeEventData`)
- ElectronAgentAPI (~310 lines)
- Browser-side types (`BrowserTabInfo`, `BrowserTabUpdateEvent`, `BrowserBookmarkData`, …)
- ElectronAPI (the main interface, ~1500+ lines)

**Extraction proposal (DEFERRED to Y2.1 per `parent_roadmap` §12.1)**:

The file has clear subgroup boundaries amenable to extraction. If Y2.1 chooses to act:

- `electron-agent.d.ts` — `ElectronAgentAPI` + all `Agent*` / `ScopeRun*` / `TaskProjection*` / `Conversation*` / `SessionRecall*` / `Detached*` / `ActiveChildRun*` types (~1500 lines)
- `electron-browser.d.ts` — `BrowserTabInfo`, `BrowserTabUpdateEvent`, `BrowserBookmarkData`, browser sub-namespace of `ElectronAPI` (~400 lines)
- `electron-fastcard.d.ts` — FastCard overlay/translate/describe/resolve-video types (~150 lines)
- `electron-rss.d.ts` — RSS status/diagnostics/benchmark types (~200 lines)
- `electron-pet.d.ts` — Pet types (~100 lines)
- `electron-document.d.ts` — DocumentMark/source/preview types (~200 lines)
- `electron-core.d.ts` — remaining IPC response helpers, channel-adapter types, top-level Window declaration (~800 lines)

The split respects the `D. METHODS_EXPOSED == METHODS_TYPED` IPC contract: `ElectronAPI`'s top-level keys all stay in `electron-core.d.ts` (the file that declares `Window['electronAPI']`), and the extracted files only contribute nested type aliases imported into `ElectronAPI` field signatures. The IPC contract gate (`scripts/check-ipc-contract.cjs:640-664`) only counts top-level property signatures of the `ElectronAPI` interface, so extraction does not change the contract surface.

Per §11.4 + §12.1 split rule, extraction itself is OUT of scope for Y1.4. This proposal is documented for Y2.1 only.

## 4. Implementation steps

1. **Behavior test first**: write `src/__tests__/browser-preview-update-bounds-send-contract.test.ts` (FAILS initially because `ipcMain.handle('browser:previewUpdateBounds', ...)` still registers).
2. **Remove dead handler**: delete lines 233-236 of `src/main/modules/browser-engine/ipc-shell.ts` (the `ipcMain.handle('browser:previewUpdateBounds', ...)` block). Leave the `ipcMain.on(...)` block intact.
3. **Refresh allowlist**:
   - Delete the `browser:previewUpdateBounds` row from `invoke_only` in `scripts/ipc-contract-allowlist.json`.
   - Refresh `reason` for `document:cancelReindex` (kept).
   - Refresh `reason` for all 13 `non_literal_push` rows; do NOT bump expiry past 2026-08-21.
4. **Update ledger**: append Y1.4 disposition row + electron.d.ts deferred-to-Y2.1 row to `docs/superpowers/audits/2026-05-23-stage-y-closeout/deferred-work-ledger.md`.
5. **Verify**:
   - `npm run verify:ipc-contract` exit 0 (1 fewer handled-only entry).
   - `npm run typecheck` exit 0.
   - `npm run lint:check` warning count stays at 771.
   - `npm run test` exit 0 (the new behavior test passes).

## 5. Acceptance evidence

- **`verify:ipc-contract` before**: `invoke=260/258 send=4/4 push=35/35 methods=23/23 allowlist=2 non_literal_push=13` (captured 2026-05-23 at Y1.4 entry).
- **`verify:ipc-contract` after**: `invoke=259/258 send=4/4 push=35/35 methods=23/23 allowlist=1 non_literal_push=13` (1 handler removed; allowlist drops from 2 to 1).
- **New test file**: `src/__tests__/browser-preview-update-bounds-send-contract.test.ts`.
- **Modified files**: `src/main/modules/browser-engine/ipc-shell.ts`, `scripts/ipc-contract-allowlist.json`, `docs/superpowers/audits/2026-05-23-stage-y-closeout/deferred-work-ledger.md`.
- **No new IPC channels added** — verified by `git diff scripts/ipc-contract-allowlist.json` (only deletion + reason refresh) and `git diff src/main/modules/browser-engine/ipc-shell.ts` (only deletion).
- **No `src/preload/index.ts` or `src/renderer/types/electron.d.ts` edits** — extraction deferred to Y2.1.

## 6. Risk + rollback

Risk surface is small:

- The removed handler at `ipc-shell.ts:233-236` is dead code (the renderer side has used `ipcRenderer.send` for as long as the dual-registration has been in place per Stage V V5 contract documentation in the allowlist). Removing it cannot regress runtime behavior.
- The `document:cancelReindex` kept-row keeps the existing handler invariant — no code change.
- The 13 non-literal-push rows are unchanged code-wise; only the `reason` text is refreshed.

Rollback path: if `npm run test` surfaces any unexpected dependency on the dead `handle()` registration (none expected), revert `src/main/modules/browser-engine/ipc-shell.ts` and restore the allowlist row.

## 7. Out-of-scope items deferred to Stage Z or later

- `electron.d.ts` extraction → Y2.1 large-file wave.
- Forwarder-pattern refactor for the 12 browser-engine `non_literal_push` lambdas → no current owner; the 2026-08-21 expiry forces re-evaluation by whichever stage holds the IPC contract at that date.
- `document:cancelReindex` renderer wiring → Stage Z workspace-close lifecycle work per `parent_roadmap` §13.
