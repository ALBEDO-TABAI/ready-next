---
name: E W0 — Pre-flight Audit Report
status: escalated
owner: Hubble
date: 2026-05-01
branch: codex/skill-runtime-b-plan
head: 18000aed7f0fe37ea2d8dc9493afa7cf15c23e16
---

# E W0 — Pre-flight Audit Report

## Completion Standard

W0 is complete when this report gives W1-W4 a current, command-backed map of O4 direct writes, O1 outputDir lifecycle gaps, O6 RSS/child-run retry behavior, O8 child-internal admission gaps, child-run JSONL contract readers, D verify-chain state, and explicit hard-gate status. W0 intentionally did not edit runtime/source/test/package files.

## Workspace State

- Worktree: `/Users/user/Documents/实验田/ready-cowork/.worktrees/codex-skill-runtime-b-plan`
- Branch: `codex/skill-runtime-b-plan`
- HEAD: `18000aed7f0fe37ea2d8dc9493afa7cf15c23e16`
- Working tree note: `docs/superpowers/plans/2026-04-30-E-defense-and-fragility-reduction-implementation.md` and unrelated `docs/superpowers/plans/2026-04-30-F-test-conventions-and-e2e-implementation.md` were already untracked at audit start. This W0 adds this report and amends only the E plan's stale reconnaissance facts.
- Out-of-bounds files not touched: all runtime/source/test/package files.

## Commands Run

```bash
pwd && git branch --show-current && git rev-parse HEAD
sed -n '1,240p' docs/superpowers/plans/2026-04-30-E-defense-and-fragility-reduction-implementation.md
rg -n "writeFile|writeFileSync|atomicWriteJson|atomicWriteText" src/main/modules/agent-control src/main/modules/skills-runtime src/main/modules/tools/skill-primitives/patch-config.ts
rg -n "outputDir|\\.lifecycle\\.json|run_state|jsonl|cleanup|GC|garbage|rm\\(|rmSync|remove|unlink|rmdir|rm\\s" src/main/modules/agent-control src/main/modules/skills-runtime
nl -ba src/main/modules/skills-runtime/runtime-manager.ts | sed -n '560,610p;1500,1590p;1625,1645p;1774,1790p;1838,1855p;1858,1930p'
nl -ba src/main/modules/skills-runtime/skill-host-controller.ts | sed -n '220,295p;485,532p'
nl -ba src/main/modules/skills-runtime/custom-skill-registry.ts | sed -n '380,410p;450,466p'
nl -ba src/main/modules/agent-control/detached-skill-task-tracker.ts | sed -n '340,370p'; nl -ba src/main/modules/agent-control/session-continuity.ts | sed -n '280,298p;632,646p'; nl -ba src/main/modules/agent-control/sidecar-manager.ts | sed -n '392,406p'
rg -n "writeFile\\(" src/main/modules/agent-control src/main/modules/skills-runtime
rg -n "writeFileSync\\(" src/main/modules/agent-control src/main/modules/skills-runtime
rg -n "\\.lifecycle\\.json|lifecycle\\.json|resolveOutputDir|mkdirSync\\(outputDir|outputsRoot|run_state\\.json|\\.jsonl|rmSync\\([^\\n]*(outputDir|outputsRoot)|cleanup.*outputDir|sweep.*outputDir|outputDir.*cleanup|outputDir.*sweep" src/main/modules/agent-control src/main/modules/skills-runtime
rg -n '"verify:[de]"|verify:e|verify:d' package.json
rg -n "rss|RSS|visual|startSkillChildRun|startChild|childRun|retry|backoff|circuit|resolveRetryDelayMs|terminalReason|SkillChildRunTerminalReason" src/main/modules/agent-control src/main/modules/skills-runtime src/main/modules/rss src/main
nl -ba src/main/modules/agent-control/skill-child-run-types.ts | sed -n '1,120p;160,230p'
nl -ba src/main/modules/agent-control/tool-runtime.ts | sed -n '390,430p;470,500p'
nl -ba src/main/modules/agent-control/skill-child-runner.ts | sed -n '1,360p'
nl -ba src/main/modules/agent-control/skill-child-runner.ts | sed -n '360,760p'
nl -ba src/main/modules/skills-runtime/runtime-manager.ts | sed -n '1988,2092p'
rg -n "startSkillChildRunAndWait|skill_rss|rss_analyze|analyze_item|video-expert|visual" src/main/modules src/renderer src/shared
rg -n "circuit|backoff|retry|resolveRetryDelayMs|maxAttempts|shouldRetry" src/main/modules/agent-control/skill-child-runner.ts src/main/modules/skills-runtime/runtime-manager.ts src/main/modules/tools/skills-tools.ts src/main/modules/tools/rss-tools.ts src/main/modules/agent-control/rss-domain-adapter.ts
nl -ba src/main/modules/agent-control/skill-child-runner.ts | sed -n '760,1125p'
rg -n "spawn|execFile|writeFile|writeFileSync|runSkillFromChildRunner|executeSkillActionViaToolGateway|childInternal|requiresExplicitAllowlist|allowedToolNames|SHELL_ALLOWLIST" src/main/modules/agent-control/video-expert-child-driver.ts src/main/modules/agent-control/tool-registry.ts src/main/modules/skills-runtime/runtime-manager.ts src/main/modules/tools/tool-executor.ts src/main/modules/tools/skill-primitives/run-shell.ts src/main/modules/tools/skills-tools.ts
nl -ba src/main/modules/agent-control/video-expert-child-driver.ts | sed -n '1,380p'
nl -ba src/main/modules/agent-control/tool-registry.ts | sed -n '948,1062p'
nl -ba src/main/modules/skills-runtime/runtime-manager.ts | sed -n '680,770p;1930,1985p'
rg -n "executeSkillActionViaToolGateway|runSkillFromChildRunner|runSkill\\(" src/main/modules/agent-control src/main/modules/skills-runtime src/main/modules/tools src/__tests__
nl -ba src/main/modules/agent-control/skill-child-run-log.ts | sed -n '1,220p'
rg -n "appendChildRunEvent|readChildRunLog|deriveChildRunLogPath|eventLogPath|\\.ready/child-runs|child-runs|ChildRunLog" src/main/modules src/renderer src/shared src/__tests__
rg -n "event_log_path|eventLogPath|child_run|childRun" src/main/modules/repositories src/main/modules/database.ts src/main/modules/migrations.ts
nl -ba src/main/modules/tools/skills-tools.ts | sed -n '1970,2165p'
nl -ba src/main/modules/repositories/skill-task-run-repository.ts | sed -n '140,176p;420,492p;500,532p'
nl -ba src/main/modules/agent-control/skill-child-runner.ts | sed -n '1288,1388p'
rg -n "eventLogPath" src/main/modules/agent-control src/main/modules/tools src/renderer src/shared | grep -v __tests__
nl -ba src/main/modules/rss-engine/item-analysis-manager.ts | sed -n '140,260p;520,690p'
rg -n "mkdirSync\\(|outputDir =|outputDir\\)|visual-analysis|copy-analysis|startSkillChildRunAndWait|createRSSAnalysisJob|updateRSSAnalysisJob|observerTimeout|retry" src/main/modules/rss-engine/item-analysis-manager.ts src/main/modules/rss-engine src/main/modules/tools/rss-tools.ts src/main/modules/agent-control/rss-domain-adapter.ts src/main/modules/database.ts
nl -ba src/main/modules/tools/rss-tools.ts | sed -n '40,150p'
ls docs/superpowers/plans | sed -n '1,120p'
rg -n "audit|pre-flight|W0|O4|O1|O6|O8|ESCALATE|terminal reason|all 16|all 17" docs/superpowers/plans/2026-04-30-E-defense-and-fragility-reduction-implementation.md docs/superpowers/plans
git status --short
rg -n "\\.lifecycle\\.json|lifecycle\\.json" src/main/modules/agent-control src/main/modules/skills-runtime
rg -n "mkdirSync\\([^\\n]*(outputDir|dirname\\(eventLogPath\\))|resolveOutputDir\\(|join\\([^\\n]*outputsRoot[^\\n]*skillId[^\\n]*childRunId|join\\([^\\n]*targetDir[^\\n]*visual-analysis|copy-analysis" src/main/modules/agent-control src/main/modules/skills-runtime src/main/modules/rss-engine
rg -n "rmSync\\([^\\n]*(outputDir|outputsRoot)|cleanup.*outputDir|sweep.*outputDir|outputDir.*cleanup|outputDir.*sweep|output_dir_gc" src/main/modules/agent-control src/main/modules/skills-runtime src/main/modules/rss-engine
rg -n "run_state\\.json|\\.jsonl|manifest\\.json|scene_scores\\.json|delivery_report\\.json" src/main/modules/agent-control src/main/modules/skills-runtime src/main/modules/rss-engine
sed -n '1,220p' docs/superpowers/plans/2026-04-30-D-pre-flight-audit-report.md
```

Notes on command results:
- The `rg ... src/main/modules/rss ...` command intentionally exposed that `src/main/modules/rss` does not exist; RSS code lives under `src/main/modules/rss-engine` and RSS tools/adapters.
- The async `writeFile\(` scan exited with no matches in `agent-control` / `skills-runtime`.
- The lifecycle and outputDir cleanup scans exited with no matches for `.lifecycle.json` / outputDir sweep / outputDir GC.

## O4 Direct Write Audit

Inventory scope: `src/main/modules/agent-control` and `src/main/modules/skills-runtime`.

Current direct write calls: 12 total.

| Bucket | Count | Calls | Required E action |
|---|---:|---|---|
| JSON state/manifest direct writes | 8 | `skills-runtime/runtime-manager.ts:1517`, `1572`, `1636`, `1784`; `skills-runtime/custom-skill-registry.ts:389`; `agent-control/detached-skill-task-tracker.ts:358`; `agent-control/session-continuity.ts:291`; `agent-control/sidecar-manager.ts:401` | Migrate to shared `atomicWriteJson`. |
| Text/config direct writes | 3 | `skills-runtime/skill-host-controller.ts:237`, `246`, `288` | Migrate to shared `atomicWriteText` or equivalent atomic text helper. |
| Temporary script write | 1 | `skills-runtime/runtime-manager.ts:587` writes generated `ready-embedded-*.py` | Does not migrate for O4 JSON/text state integrity. |
| Async `writeFile(...)` | 0 | none in audited directories | No async migration target in these two directories. |

Existing atomic helper fact:

- `src/main/modules/tools/skill-primitives/patch-config.ts:186` has private `atomicWriteJson(path, value)`.
- It is used at `patch-config.ts:348` and `391`.
- No `atomicWriteText` exists in the audited paths.

Conclusion: the known current O4 facts are verified: 12 direct write calls; 8 JSON migrations; 3 text migrations; 1 temp `.py` non-migration; 0 async `writeFile` matches; existing private `atomicWriteJson` in `tools/skill-primitives/patch-config.ts`.

## O1 OutputDir Lifecycle Audit

Creation and sidecar paths:

| Path type | Count | Calls | Notes |
|---|---:|---|---|
| Runtime output root creation | 1 | `skills-runtime/runtime-manager.ts:1592` | Creates `<runtimeRoot>/outputs`. |
| Runtime action outputDir creation | 1 | `skills-runtime/runtime-manager.ts:747 -> resolveOutputDir(...)`; implementation at `1846-1849` | Used when host requirements prepare an action output dir. |
| Child-run outputDir creation through event-log parent mkdir | 1 | `agent-control/skill-child-runner.ts:274-280` | Child run computes `<outputsRoot>/<skillId>/<childRunId>` and creates `dirname(eventLogPath)`, which creates the outputDir tree plus `.ready/child-runs`. |
| RSS analysis outputDir creation | 1 | `rss-engine/item-analysis-manager.ts:241-243` | Product RSS analysis creates `<targetDir>/<safeTitle-id>/{copy-analysis|visual-analysis}`. |

Lifecycle and cleanup counts:

| Item | Count | Evidence |
|---|---:|---|
| `.lifecycle.json` references | 0 | No matches in `agent-control` / `skills-runtime`. |
| OutputDir cleanup / sweep / GC references | 0 | No matches for outputDir sweep/cleanup or `output_dir_gc` in audited runtime paths. |
| Existing orphan skill-artifact cleanup | 1 | `skills-runtime/runtime-manager.ts:1868+` cleans retired skill asset dirs, not child-run output dirs. |
| Skill uninstall lifecycle cleanup | 1 | `skills-runtime/skill-host-controller.ts:493+` removes manifest-declared uninstall paths, not child-run output dirs. |

Existing run-state/jsonl sidecars:

- `run_state.json` is the durable state sidecar used by VEA and contract/supervisor readers. Child runner computes it at `skill-child-runner.ts:275`.
- Child-run JSONL is `<outputDir>/.ready/child-runs/<childRunId>.jsonl`, derived by `skill-child-run-log.ts:27-29`.
- RSS analysis additionally writes `manifest.json` under its analysis output dirs (`item-analysis-manager.ts:520`, `711`) and looks for `scene_scores.json`.

Conclusion: O1 still has no outputDir lifecycle marker and no outputDir cleanup/GC. W2 should add the lifecycle sidecar and sweep; it should distinguish child-run output dirs from RSS product analysis dirs unless the product owner explicitly wants RSS analysis output retention governed by the same policy.

## O6 RSS / Retry / Circuit Audit

RSS analysis entrypoints:

| Entrypoint | File:line | Behavior |
|---|---|---|
| Tool definition | `tools/rss-tools.ts:50-55` | `rss_analyze_item` queues copy or visual analysis. |
| Tool dispatch bridge | `tools/rss-tools.ts:126-133` | Validates `analysisType`, emits `rss.analyzeItem`; does not run child run itself. |
| Domain adapter | `agent-control/rss-domain-adapter.ts:73-202` | Routes RSS turns to `rss_*` / `skill_rss_*`; failure states expose UI `retry`, but no child-run backoff/circuit. |
| Product manager | `rss-engine/item-analysis-manager.ts:237-271` | Creates analysis job/outputDir and queues execution. |
| Visual flow child-run launches | `rss-engine/item-analysis-manager.ts:639-647`, `663-676` | Launches VEA `video_expert_pipeline`, then `video_expert_ai_analyze`, via `startSkillChildRunAndWait`. |

Current retry/backoff/circuit behavior:

- RSS visual has a bounded retry only for `queued_global_concurrency`: `VEA_AWAIT_RETRY_LIMIT = 3`, `VEA_AWAIT_RETRY_DELAY_MS = 5000`, implemented at `item-analysis-manager.ts:560-585`.
- RSS visual does not retry `host_unavailable`, `persistence_failed`, `child_process_crashed`, `failed_skill`, `blocked_*`, or `cancelled_user`; those are translated into job errors.
- Child runner has single-flight collapse, active VEA concurrency cap, launch-stuck guard, process-restart reconciliation, and cancellation handling.
- Child runner has no terminal-reason retry policy table and no single-flight-key circuit breaker.
- Tool runtime has per-tool retry/recovery around execution errors (`tool-runtime.ts:412-419`), but that is not child-run-level retry.

Terminal reason correction:

- Current `SkillChildRunTerminalReason` union is 17 members (`skill-child-run-types.ts:39-56`).
- The E plan draft says "all 16 terminal reasons covered" in W3 test text; that is stale and must be corrected to 17.

Conclusion: O6 needs W3. The current RSS visual retry is narrow and product-local; it does not satisfy E's child-run retry/backoff/circuit contract.

## O8 VEA / Admission Audit

VEA driver spawn/direct-write count:

| Item | Count | Evidence |
|---|---:|---|
| VEA driver direct spawn/exec | 0 | `video-expert-child-driver.ts` imports only `existsSync` / `readFileSync` from fs and no child-process APIs. |
| VEA driver direct write calls | 0 | No `writeFile` / `writeFileSync` in `video-expert-child-driver.ts`. |
| VEA driver direct shell allowlist use | 0 | No `SHELL_ALLOWLIST` or primitive shell call in driver. |

Production child internal admission gateway usage:

| Path | Count | Evidence |
|---|---:|---|
| Gateway helper definitions | 1 | `agent-control/tool-registry.ts:986` exports `executeSkillActionViaToolGateway`. It calls `executeToolCall` with `allowedToolNames: new Set([toolName])`, `allowInternal: true`, `skillRuntimeManager`, and `childInternalSkillAction`. |
| Production runner calls to gateway | 0 | `skill-child-runner.ts:900-906` calls `runtimeManager.runSkillFromChildRunner(...)` if present, else `runtimeManager.runSkill(...)`. It does not call `executeSkillActionViaToolGateway`. |
| `runSkillFromChildRunner` implementation | 1 bypass | `skills-runtime/runtime-manager.ts:687-688` is a thin alias to `runSkill`. |
| Test-only gateway uses | present | `tool-input-schemas-registry.test.ts` and `tool-internal-admission.test.ts` call the gateway directly. |

Required W4 fix:

- The runner currently bypasses `executeSkillActionViaToolGateway`. This is the O8 hard finding.
- The VEA driver itself is clean, but the production child-run action execution path does not use the explicit admission gateway that exists for this purpose.
- W4 must route child-run internal actions through `executeSkillActionViaToolGateway` or otherwise prove the same admission function and context are used in production. As of this audit, tests alone exercise the gateway; production does not.

## Child-Run JSONL Writer / Reader Audit

Writer/reader inventory:

| Item | Count | Evidence |
|---|---:|---|
| Production JSONL path derivation helper | 1 | `skill-child-run-log.ts:27-29` derives `<outputDir>/.ready/child-runs/<childRunId>.jsonl`. |
| Production JSONL writer helper | 1 | `appendChildRunEvent(...)` at `skill-child-run-log.ts:31-39`. |
| Production writer call sites | 1 | `skill-child-runner.ts:1012` appends events through `appendChildRunEvent`. |
| Production `readChildRunLog(...)` reader call sites | 0 | Only tests call it. |
| Production fallback path reader | 1 | `skill-child-runner.ts:1302-1306` derives event path from persisted payload/outputDir, but does not read JSONL. |

`eventLogPath` contract/read surface:

- Persisted in `SkillChildRunPayload` and repository create path: `skill-task-run-repository.ts:151-165`, `430-452`, `488`.
- Reused by runner resume/reconcile paths and returned in launch results.
- Transmitted in tool envelope data at `skills-tools.ts:2144-2152`.
- Not used by renderer/UI as a JSONL reader in production.

Classification:

- Cross-run/contract/UI JSONL readers >2? No. Production `readChildRunLog` readers = 0.
- Hard gate `JSONL reader >2`: DONE / not escalated.

Conclusion: JSONL remains single-writer and has no production reader fan-out today. The eventLogPath is persisted/transmitted mostly as a handle, not as a parsed UI/contract dependency.

## D Land / Verify Chain State

- `package.json` currently has `verify:d`.
- `package.json` currently has no `verify:e`.
- `verify:d` chains through `npm run verify:c` and the D focused tests.

Conclusion: W5 must add `verify:e`; it should embed `verify:d`, not skip it.

## Hard Gate Status

| Gate | Status | Reason |
|---|---|---|
| JSONL reader >2 | DONE | Production writer call sites = 1; production `readChildRunLog` readers = 0; eventLogPath is persisted/transmitted but not broadly parsed. |
| Driver direct spawn / risky bypass | ESCALATE | Driver direct spawn/write count is 0, but production runner bypasses `executeSkillActionViaToolGateway` via `runSkillFromChildRunner -> runSkill`. W4 must fix this path. |
| fsync measured yet | ESCALATE | Existing private `atomicWriteJson` uses tmp+rename but no fsync. E shared helper design mentions fsync, but no measurement/verification exists yet. |

## Plan Amendments Needed

The implementation plan's W0 section is correct in spirit, but the reconnaissance table is stale:

1. O4 should say 12 direct writes, not "5-ish" migration work. Buckets: 8 JSON, 3 text/config, 1 temp `.py`.
2. O6 terminal reason coverage must say 17, not 16.
3. O8 current-state statement must not say production actions already go through the tool gateway. The gateway exists and tests call it, but the production runner currently bypasses it.
4. O1 should keep the "no outputDir cleanup" conclusion, but note the current creation paths are runtime action outputDir, child-run event-log tree creation, and RSS product analysis outputDir.

## W0 Result

Status: ESCALATE. W0 is complete as an audit, and no runtime/source/test/package files were changed. W1 and W2 can proceed from the inventories above, but W4 must treat the production runner gateway bypass as a required fix before E can be considered safe.
