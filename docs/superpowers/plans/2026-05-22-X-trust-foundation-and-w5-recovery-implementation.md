---
name: X-trust-foundation-and-w5-recovery-implementation
stage: X
date: 2026-05-22
status: implementation-draft
enforce: false
predecessor_closeout: docs/superpowers/audits/2026-05-22-stage-w-closeout/CLOSE-NOTE.md
predecessor_roadmap: docs/superpowers/plans/2026-05-22-W-ready-stabilization-roadmap.md
---

# Stage X - Trust foundation and W5 recovery implementation plan

## 0. Purpose

Stage W closed the stabilization roadmap, but it also left three release-facing risks that must be handled before broader product-completeness work can be trusted:

1. The W5 live dogfood session flow failed.
2. Some deep `verify:*` stage gates still reference stale pre-refactor paths, so they no longer prove the current architecture.
3. Workbench shell diagnosis is complete, but the first production fixes have not landed.

Stage X is the bridge between Stage W stabilization and Stage Y product-surface completion. It should make the project safe to iterate again by repairing gate trust, fixing the only Stage W release-relevant dogfood failure, adding a minimal CI loop, and landing the first Workbench shell production batch.

## 1. Scope

In scope:

- Repair stale deep verification scripts in the `verify:c` / `verify:r` / `verify:t` chain.
- Add a small meta-gate that prevents future hard-coded script paths from silently drifting.
- Fix the W5 item 3 multi-session failure: visible session tabs, session cap, completion toast, click-back into completed session, and composer unlock after failed sends.
- Classify the provider `HTTP 402` part as configuration/account failure and make the UI recover cleanly from it.
- Add a minimal CI workflow that runs the merge-critical checks on a clean machine.
- Land the first Workbench shell production batch from the W3 chosen layout model.
- Produce a Stage X closeout bundle with rerun evidence and a successor ledger for Stage Y / Stage Z.

Out of scope:

- Full product dogfood matrix across file manager / browser / RSS / document / calendar / skills / settings / provider recovery. That is Stage Y.
- Release candidate, packaging, signing, cross-platform install proof, and release notes. That is Stage Z.
- Broad lint warning reduction below the current 769 warning budget. Stage X only prevents growth.
- Large-file physical extraction unless it is required to fix W5 or to make a gate trustworthy.
- MCP real transport, cache quota enforcement, Windows parity completion, and Settings feature expansion. Stage X may record them, but should not absorb them.

## 2. Current truth at Stage X start

This section records the facts that Stage X implementers must verify again before editing.

- Branch at audit time: `codex/readyguy`.
- Working tree at audit time: clean.
- Current ordinary gates observed green:
  - `npm run typecheck`
  - `npm run lint:check` with 0 errors / 769 warnings
  - `npm run verify:lint-budget`
  - `node scripts/check-eslint-baseline.cjs`
  - `npm run verify:ipc-contract`
  - `npm run verify:native`
  - `npm run test`
- Current warning budget is exact, not loose:
  - `@typescript-eslint/no-explicit-any`: 551 / 551
  - `@typescript-eslint/no-unused-vars`: 180 / 180
  - `react-hooks/exhaustive-deps`: 18 / 18
  - `react-refresh/only-export-components`: 17 / 17
  - unused disable directive: 3 / 3
- Current deep-gate problem:
  - `npm run verify:r` and `npm run verify:t` enter stale gate scripts.
  - Example failure: `scripts/check-identity-resolver-pure-read.cjs` looks for `src/main/modules/agent-control/skill-turn-identity.ts`, while the current implementation lives under the post-refactor module layout.
- W5 item 3 root cause candidate is already proven at the store level:
  - `useAgent.getState().newSession()` from an empty `sessionOrder` creates an active session, but leaves `sessionOrder` empty.
  - `SessionTabs` intentionally renders nothing when `sessionOrder.length === 0`.
  - Header and local-channel paths still call `newSession()`, not the visible-tab `createNewSession()` path.
- Workbench shell state:
  - W3 chose the hybrid shell model.
  - PR-shell-1 / PR-shell-2 / PR-shell-4 are still implementation work, not completed code.
  - W3 measurements show mode switch around 1 second wall-clock and split secondary bounds count 0.
- CI state:
  - No `.github/workflows` directory was present at audit time.

## 3. Stage X exit criteria

Stage X is complete only when all of the following are true:

1. `npm run verify:r` and `npm run verify:t` either pass, or any intentionally retired sub-gate is removed from the chain and recorded in the Stage X closeout ledger with a replacement gate.
2. No deep gate fails because it cannot read a moved source file.
3. A new or updated meta-gate catches stale hard-coded source paths in verification scripts.
4. W5 item 3 is rerun in the live Ready app and passes with evidence.
5. A failed provider send, including quota/account failures, unlocks the composer without manual Stop.
6. Minimal CI exists and runs the Stage X merge-critical checks.
7. Workbench shell PR-shell-1 / PR-shell-2 / PR-shell-4 have either landed with evidence, or one is explicitly deferred with a new blocking reason and replacement acceptance boundary.
8. Stage X closeout bundle exists under `docs/superpowers/audits/2026-05-22-stage-x-closeout/`.
9. The Stage Y entry document exists or is linked from the closeout ledger, with product-surface gaps deliberately moved out of Stage X.

## 4. Review cadence

Every Stage X sub-phase must have:

- A scoped implementation branch or clearly isolated commit.
- Before/after verification output.
- A short review note answering:
  1. Did this touch only the declared boundary?
  2. Which gate or behavior would fail if this regressed?
  3. Is any source-grep gate still unsupported by a behavior test?
  4. Did warning count grow?
  5. Did this add any new deferred item?

Do not proceed from X1 to X2 until the deep-gate trust repair is complete. Otherwise the session fix may appear verified while the surrounding gate system is still blind.

### 4.1 Phase scheduling (serial vs parallel)

| Phase | Must-precede | May-parallel-with | Notes |
| --- | --- | --- | --- |
| X0 | X1, X2, X3, X4 | nothing | Truth freeze is the entry point; everything else reads it. |
| X1 | X2, X4 | X3 | X1 inside can split into X1.1-X1.4 per `verify:*` chain (`c` / `r` / `s` / `t`), each owned by its own agent in parallel. The meta-gate is X1.5 and lands last. |
| X2 | X4 X5 | X3 | X2 needs a real Ready dev run plus tests; do not parallelize X2 with X4 because both touch live BrowserView. |
| X3 | X5 | X1, X2 | Pure infra add (CI yaml + taxonomy doc); no `src/` change. |
| X4 | X5 | nothing | PR-shell-1 → PR-shell-2 → PR-shell-4 strict serial inside X4. Each PR requires live validation on the W3.3 equipment. |
| X5 | nothing | nothing | Stage X closeout is the last work. |

Cross-phase parallelism rule: only X1 + X3, or X2 + X3, may run at the same time. X2 and X4 must never run concurrently because both touch the BrowserView lifecycle.

### 4.2 Rollback paths

| Phase | Symptom that triggers revert | Recovery action |
| --- | --- | --- |
| X1 | A repaired script starts passing on stale code, or fails a fresh run that previously passed. | `git revert <commit>`; add a reproducer test; redo the disposition decision with the new evidence. |
| X2 | An existing W4 test (`useAgent-*-contract.test.ts`) breaks; or the live dogfood rerun reveals a new failure mode. | `git revert <commit>`; reopen failing behavior test as a separate fix; do not bundle multiple session paths in one PR. |
| X3 | CI workflow shape is wrong (e.g., `continue-on-error` accidentally added). | Edit workflow in a same-day follow-up commit; do not delete and rewrite from scratch — keep the run history. |
| X4 | A shell PR breaks visible UI (flicker, blank, frozen mode switch) that did not exist before. | Immediately rerun live dogfood on the same equipment; if root cause cannot be identified within 1 hour, `git revert <commit>` and reopen the PR with the failing scenario added to the W3 failure-mode enumeration. |
| X5 | Closeout bundle is missing any § 10 deliverable. | Do not commit the closeout statement until all 6 deliverables exist; this is the only phase where "no commit" is the correct action when incomplete. |

### 4.3 Agent dispatch time estimate (for scheduling, not contract)

| Phase | Single-agent estimate | Human-in-loop portion |
| --- | --- | --- |
| X0 | 30 min | none |
| X1 (each sub-chain) | 1-2 h | none |
| X1.5 meta-gate | 1 h | none |
| X2 | 3-4 h | live dogfood rerun (~30 min by 白) |
| X3 | 1 h | optionally trigger first CI run (~5 min by 白 if remote) |
| X4 PR-shell-1 | 2 h | none |
| X4 PR-shell-2 | 2-3 h | live validation (~15 min by 白 on W3.3 equipment) |
| X4 PR-shell-4 | 2-3 h | live validation (~15 min by 白) |
| X5 | 1 h | none |

Stage X agent-time total: ~14-18 hours; 白-time total: ~1.5 hours.

## 5. Phase X0 - Stage X truth freeze and closeout scaffold

Goal: make the Stage X starting point reproducible and prepare the evidence directory before fixes begin.

Inputs:

- `docs/superpowers/audits/2026-05-22-stage-w-closeout/CLOSE-NOTE.md`
- `docs/superpowers/audits/2026-05-22-stage-w-closeout/deferred-work-ledger.md`
- `docs/superpowers/audits/2026-05-22-stage-w-closeout/dogfood/REPORT.md`
- `docs/superpowers/audits/2026-05-22-stage-w-closeout/dogfood/issues/item-03-session-tabs-composer-lock.md`
- `docs/superpowers/audits/2026-05-22-w3-workbench-shell-diagnosis/chosen-layout-model.md`
- `docs/superpowers/operations/verify-gate-taxonomy.md`
- `docs/superpowers/operations/lint-warning-debt-ledger.md`
- `package.json`

Deliverables:

1. `docs/superpowers/audits/2026-05-22-stage-x-closeout/README.md`
2. `docs/superpowers/audits/2026-05-22-stage-x-closeout/x0-starting-truth.md`
3. `docs/superpowers/audits/2026-05-22-stage-x-closeout/verification-start/`

Commands to capture in `verification-start/`:

```bash
npm run typecheck
npm run lint:check
npm run verify:lint-budget
node scripts/check-eslint-baseline.cjs
npm run verify:ipc-contract
npm run verify:native
npm run test
npm run verify:r
npm run verify:t
```

For each command, save stdout/stderr and exit code. For `verify:r` and `verify:t`, a non-zero start snapshot is acceptable only if the failure is recorded as a stale-gate repair target.

Done when:

- The starting state can be audited without rerunning commands.
- Each red deep gate has a row in `x0-starting-truth.md` naming the first failing script and the missing or stale file path.

## 6. Phase X1 - Deep gate trust repair

Goal: make the `verify:*` chain prove the current codebase again.

Known stale-path examples to audit:

- `scripts/check-identity-resolver-pure-read.cjs`
- `scripts/check-skill-rearm-locality.cjs`
- `scripts/check-current-date-reminder-registered.cjs`
- `scripts/check-web-search-tool-shape.cjs`
- `scripts/check-web-fetch-tool-shape.cjs`
- `scripts/check-tool-name-uniqueness.cjs`
- `scripts/check-mcp-tools-go-through-authorization.cjs`
- `scripts/check-mcp-group-registered.cjs`
- `scripts/check-agent-interaction-group-registered.cjs`
- `scripts/check-event-ledger-shape.cjs`
- `scripts/check-no-auto-rollback-on-cancel.cjs`
- `scripts/check-child-control-ipc.cjs`
- `scripts/check-child-run-output-dir-fallback.cjs`
- `scripts/check-message-capability-filter-wired-both-paths.cjs`
- `scripts/check-vision-tool-capability-gated.cjs`
- `scripts/check-skill-allowed-tools-enforced.cjs`

Step-by-step:

1. Inventory every script called by `verify:c`, `verify:r`, `verify:s`, and `verify:t`. Capture the inventory to `docs/superpowers/audits/2026-05-22-stage-x-closeout/x1-script-inventory.md` as a table: `verify-chain | script | hard-coded paths (extracted) | resolves-on-disk?`.
2. Run each script directly where practical and classify it via the **stale-path three-step verification**:

   For each hard-coded `src/...` path inside the script:
   - **Step a**: `ls -l <path>` — does the file exist at the cited path?
   - **Step b**: If no, `git log --follow --diff-filter=R -- <path>` and `git log --diff-filter=D -- <path>` — was it renamed (Stage U move-only series likely) or deleted?
   - **Step c**: `grep -rn '<symbol-the-script-was-asserting>' src/` — find the contract's current location; if zero matches, the contract may itself be retired.

   Then classify the script as one of:
   - `pass-current` — all paths exist, script runs green
   - `fail-real-regression` — paths exist but assertion fails on current code
   - `fail-stale-path` — at least one referenced path was moved/renamed (Step b finds rename)
   - `retire-replace` — referenced contract is gone (Step c finds zero matches)
3. For every `fail-stale-path`, update the script to the current file location or current exported contract.
4. If a script is only checking old architecture that no longer exists, remove it from the relevant `verify:*` chain and replace it with a gate for the current architecture.
5. Add or update `scripts/__tests__/*` coverage for every changed gate script.
6. Add one meta-gate, recommended name:

```bash
node scripts/check-verify-script-paths-current.cjs
```

**Meta-gate implementation sketch**:

```js
// scripts/check-verify-script-paths-current.cjs
const fs = require('fs');
const path = require('path');

const VERIFY_SCRIPTS_DIR = path.join(__dirname);
const ALLOWLIST_PATH = path.join(__dirname, 'check-verify-script-paths-allowlist.json');

// Match string literals referencing src/... paths in .cjs/.mjs scripts.
// Examples we want to catch:
//   path.join(process.cwd(), 'src/main/modules/agent-control/...')
//   resolve('src/main/...')
//   const PATH = 'src/...'
const PATH_RE = /['"](src\/[\w./-]+\.[tj]sx?)['"]/g;

const allowlist = new Set(
  fs.existsSync(ALLOWLIST_PATH)
    ? JSON.parse(fs.readFileSync(ALLOWLIST_PATH, 'utf8')).paths
    : []
);

let drift = 0;
for (const file of fs.readdirSync(VERIFY_SCRIPTS_DIR).filter(f => /^check-.+\.(cjs|mjs)$/.test(f))) {
  const src = fs.readFileSync(path.join(VERIFY_SCRIPTS_DIR, file), 'utf8');
  for (const m of src.matchAll(PATH_RE)) {
    const cited = m[1];
    if (allowlist.has(cited)) continue;
    const full = path.join(process.cwd(), cited);
    if (!fs.existsSync(full)) {
      console.error(`STALE: ${file} references ${cited} which does not exist`);
      drift++;
    }
  }
}
process.exit(drift === 0 ? 0 : 1);
```

Allowlist file `scripts/check-verify-script-paths-allowlist.json`:
```json
{
  "paths": [
    "src/__fixtures__/path-that-is-deliberately-a-snapshot/file.ts"
  ],
  "comment": "Only add paths here when the script intentionally references a non-live fixture / snapshot path. Stale moved sources do not belong here."
}
```

The meta-gate should fail when a verification script hard-codes a `src/...` path that no longer exists, unless the path is inside an explicitly documented fixture or snapshot allowlist.

Required verification:

```bash
node scripts/check-verify-script-paths-current.cjs
npm run verify:c
npm run verify:r
npm run verify:t
npm run typecheck
npm run lint:check
npm run verify:lint-budget
npm run test
```

Done when:

- `verify:r` and `verify:t` no longer fail on missing moved files.
- Any still-red gate is a real product or contract failure, not a stale script path.
- Warning count does not exceed 769.
- The Stage X closeout contains `x1-gate-repair-report.md` listing every script touched and its before/after status.

## 7. Phase X2 - W5 item 3 session and composer recovery

Goal: fix the only Stage W release-relevant dogfood failure.

Observed failure:

- Header `new session` path creates local scopes but no visible SessionTabs strip.
- First send can fail with provider `HTTP 402`.
- Composer remains locked until manual Stop.
- Because of the lock, the 3-session cap, completion toast, and click-back checks could not be exercised.

Root boundary:

- Renderer agent store session identity and visible session order.
- Runtime driver terminal-error handling.
- ChatPanel header/channel entry points.
- Provider failure classification and user-visible recovery.

### 7.1 Three-state failure decomposition

Each of the following states must be independently re-asserted by behavior tests; do not collapse them into one "composer locked" symptom:

| State name | Owner field(s) in `useAgent` | Healthy invariant | Observed broken invariant |
| --- | --- | --- | --- |
| Session visibility | `sessionOrder`, `activeSessionId`, `sessions[id].state` | When a UI control creates a new session, that session id appears in `sessionOrder` and `SessionTabs` renders it. | `newSession()` from header path leaves `sessionOrder` empty; `SessionTabs` early-returns; active session is hidden. |
| Composer lock | `isStreaming`, `foregroundBusy`, `composerLocked`, `streamingRequestId` | Setting `isStreaming = false` via terminal event must also clear `foregroundBusy` and `composerLocked` for the originally-locked session, even if active session switched mid-send. | A failed send returns terminal error but `composerLocked` stays true because the unwind path targets `activeSessionId` (which may have moved) instead of the session that was locked at send start. |
| Runtime intent | `runtimeDriver` request handle, `streamingMessageId` | A failed send clears the in-flight request handle; the Stop button is no longer shown. | Request handle persists; Stop button visible until manual click; new send blocked by "in-flight" guard. |

### 7.2 Provider error policy (HTTP 402 and friends)

The HTTP 402 failure is provider/account, not a Ready bug — but Ready's response to it **is** a Ready bug. Split the handling into two layers and write tests for each:

**Main-side (provider classification)**: in the relevant `claude-bridge` / agent-runtime layer, every provider error gets a typed `ProviderTerminalError` with shape `{ code: 'quota_exceeded' | 'auth_required' | 'rate_limited' | 'invalid_request' | 'network' | 'unknown', httpStatus?, providerMessage }`. HTTP 402 maps to `quota_exceeded`.

**Renderer-side (UI recovery policy)**: the runtime driver classifies the terminal error and decides:

| Error code | Composer behavior | Stop button | User-visible toast |
| --- | --- | --- | --- |
| `quota_exceeded` | unlock immediately | hide | "Provider quota exhausted; check provider settings" + deep-link to Settings |
| `auth_required` | unlock immediately | hide | "Provider auth failed; re-enter API key" + deep-link |
| `rate_limited` | unlock after retry-after seconds (default 30) | show during wait | countdown toast |
| `invalid_request` | unlock immediately | hide | "Request rejected by provider" + show error in message |
| `network` | unlock immediately | hide | "Network error; try again" |
| `unknown` | unlock after 60s safety timeout if no terminal event | show | generic error |

Test fixtures: simulate each error code at the runtime driver boundary; assert composer lock / Stop button / toast all match the policy row. These are unit-level, not dogfood-level.

Implementation rules:

- Add failing behavior tests before editing the store.
- Do not physically split `useAgent.ts` in this phase unless the testable fix cannot be made without it.
- Choose one explicit contract for session creation:
  - either `newSession()` always creates a visible local session when invoked from UI paths;
  - or UI paths call a visible-session API and non-UI scope creation uses a separate internal API.
- After fixing, there must not be two subtly different "new session" semantics reachable from visible UI controls.

Required tests:

1. Cold/header path:
   - Starting with `sessionOrder: []`, invoking the header new-session path creates one visible tab and makes it active.
2. Multiple local sessions:
   - Repeated visible new-session actions append or replace according to the chosen contract, but never leave active sessions hidden.
3. Hard cap:
   - The third session is allowed; the fourth is rejected with the existing visible cap behavior.
4. Failed send:
   - A provider failure unlocks the composer for the active visible session.
5. Session/scope mismatch guard:
   - Terminal events must unlock the session that was locked at send start, even if `currentScopeId` changes before the failure returns.

Suggested focused files:

- `src/renderer/stores/useAgent.ts`
- `src/renderer/components/agent/ChatPanel.tsx`
- `src/renderer/components/agent/chat-panel/session-tabs/SessionTabs.tsx`
- `src/renderer/modules/agent/runtimeDriver.ts`
- `src/__tests__/session-tabs-ui.test.ts`
- `src/__tests__/multi-session-isolation.test.ts`
- a new focused regression test if the current files cannot express the header path cleanly

Required verification:

```bash
npx tsx@^4.19.2 --test --test-concurrency=1 src/__tests__/session-tabs-ui.test.ts src/__tests__/multi-session-isolation.test.ts
npx tsx@^4.19.2 --test --test-concurrency=1 src/__tests__/useAgent-session-slice-migration.test.ts src/__tests__/useAgent-listener-routing-contract.test.ts src/__tests__/useAgent-cross-area-mutation-guard.test.ts
npm run typecheck
npm run lint:check
npm run verify:lint-budget
npm run test
```

Live dogfood rerun:

- Reuse W5 item 3 with isolated user data.
- Record new evidence under:

```text
docs/superpowers/audits/2026-05-22-stage-x-closeout/w5-item-03-rerun/
```

Done when:

- The visible session strip appears from the header path.
- The 3-session cap can be reached and observed.
- Failed provider sends unlock the composer without manual Stop.
- A completion toast appears for a successful short run.
- Clicking back into a completed session shows its prior transcript.
- Evidence includes screencap plus `ready-directchat.log` window.

## 8. Phase X3 - Minimal CI and gate taxonomy alignment

Goal: make the merge-critical checks run automatically somewhere other than the current terminal.

Inputs:

- `docs/superpowers/operations/verify-gate-taxonomy.md`
- `package.json`
- X1 gate repair results

Deliverables:

1. `.github/workflows/ready-merge-gates.yml` or an equivalent repository-native CI workflow if GitHub Actions is not the intended host.
2. Updated `docs/superpowers/operations/verify-gate-taxonomy.md` reflecting the CI reality.
3. `docs/superpowers/audits/2026-05-22-stage-x-closeout/ci-gate-report.md`.

Minimum CI job:

```bash
npm ci
npm run verify:native
npm run typecheck
npm run lint:check
npm run verify:lint-budget
node scripts/check-eslint-baseline.cjs
npm run verify:ipc-contract
npm run test
```

Recommended second job after X1:

```bash
npm run verify:r
npm run verify:t
```

If runtime cost is too high for every push, make this second job manual or scheduled, but do not call it a merge gate in the taxonomy.

Rules:

- CI must not use `continue-on-error` for merge-critical checks.
- CI must not hide warning growth; `verify:lint-budget` is mandatory.
- If `verify:r` or `verify:t` is not in the push gate, the taxonomy must say exactly when it runs.

### 8.1 GitHub Actions concrete shape

**Runner**: `macos-latest` is **required** for `verify:native`. Ready's `better-sqlite3` rebuild + Electron ABI check is platform-coupled; ubuntu/windows runners will produce a different `.node` ABI and the rebuild will be wasted. If cross-platform validation is needed later, that is Stage Z, not Stage X.

**Node version**: pin to `20.x` minor that matches `package.json` engines or the Electron-bundled Node (20.19.1 per W0 snapshot). Use `actions/setup-node@v4` with `node-version-file: '.nvmrc'` if `.nvmrc` exists, otherwise `node-version: '20.19.1'`.

**Cache strategy**:

```yaml
- uses: actions/cache@v4
  with:
    path: |
      ~/.npm
      node_modules/.cache/tsc
      node_modules/.cache/electron
      node_modules/.cache/electron-builder
    key: ready-${{ runner.os }}-${{ hashFiles('package-lock.json') }}
    restore-keys: ready-${{ runner.os }}-
```

Cache the npm download cache + tsc incremental cache + electron download cache. Do **not** cache `node_modules/` itself (npm ci should always re-extract).

**Secrets / env**: none required for Stage X merge gates. The full `npm run test` parallel + serial suite is offline-safe. If a future test needs an Anthropic key (Stage Y / Stage Z), introduce it via repository secrets behind a clear opt-in flag; do not let merge gates depend on a key.

**Concurrency / cost control**:

```yaml
concurrency:
  group: ready-merge-${{ github.ref }}
  cancel-in-progress: true
```

A new push to the same branch cancels the previous in-flight run. Stops needless minutes on rapid pushes.

**Branch protection** (configure in GitHub UI, document in X3 closeout):

- Required status checks: `Ready merge gates / merge` (the X3 workflow job name).
- Required reviewers: per existing org policy; X3 does not change this.
- Strict mode: PR must be up-to-date with base before merging.

**Verification of CI shape before merge**:

```bash
# Locally simulate the CI sequence to catch missing scripts before pushing the workflow:
npm ci
npm run verify:native && npm run typecheck && npm run lint:check && \
  npm run verify:lint-budget && node scripts/check-eslint-baseline.cjs && \
  npm run verify:ipc-contract && npm run test
echo "merge-gate equivalent exit: $?"
```

Done when:

- CI workflow file exists.
- Local command equivalent passes.
- Taxonomy no longer says "No CI present".
- Stage X closeout records the first CI run result or, if remote CI cannot be triggered locally, the exact local equivalent and the reason remote proof is pending.

## 9. Phase X4 - Workbench shell first production batch

Goal: convert W3 shell diagnosis into the first safe production fixes.

Source of truth:

- `docs/superpowers/audits/2026-05-22-w3-workbench-shell-diagnosis/chosen-layout-model.md`
- `docs/superpowers/audits/2026-05-22-w3-workbench-shell-diagnosis/reflow-measurements.md`
- `docs/superpowers/audits/2026-05-22-w3-workbench-shell-diagnosis/failure-modes.md`

Required PR order:

1. PR-shell-1: introduce a BrowserView intent boundary and a single main-side decision point.
2. PR-shell-2: make mode-switch hide/show/bounds/capture ordering atomic around the chosen hybrid shell model.
3. PR-shell-4: make split secondary BrowserView bounds observable and correct.

PR-shell-3, the measured width observer cleanup, is optional in Stage X unless the X4 measurements show drag jank or shell-width drift on the validation machine.

Acceptance per PR:

### PR-shell-1

Required result:

- Renderer emits declarative BrowserView intent.
- Main process owns the decision for show/hide/bounds.
- No new renderer-side BrowserView lifecycle guess is introduced.

Suggested `BrowserViewIntent` contract shape (renderer → main IPC payload):

```ts
type BrowserViewIntent =
  | { kind: 'show'; tabId: string; bounds: { x: number; y: number; w: number; h: number }; reason: 'mode-switch' | 'tab-activate' | 'split-promote' }
  | { kind: 'hide'; tabId: string; reason: 'mode-switch' | 'overlay-open' | 'tab-deactivate' | 'split-collapse' }
  | { kind: 'hide-all'; reason: 'overlay-open' | 'mode-switch-prepare' }
  | { kind: 'set-bounds'; tabId: string; bounds: ... }
  | { kind: 'secondary-set-bounds'; tabId: string; bounds: ... }
```

Renderer never calls `show()`/`hide()` directly; only emits intents. Main side `tab-shell-service.ts` is the single decision point that maps intent → actual `BrowserView` API calls. This eliminates the renderer-side guess that triggered FM-2 / FM-3 / FM-4.

Verification:

```bash
npm run typecheck
npm run verify:ipc-contract
npm run test
```

Add a focused behavior test proving intent-to-main mapping at `src/__tests__/browserview-intent-mapping.test.ts`. Test must cover every `kind` value above.

### PR-shell-2

Required result:

- Browser <-> non-browser mode switch has a single ordered ritual.
- No DOM overlay is shown above an active native BrowserView without first coordinating BrowserView visibility.
- Re-run W3 mode-switch measurement and record before/after.

Suggested ordered ritual for mode switch (cite this in PR description):

```
mode-switch(from, to):
  if from === 'browser' and to !== 'browser':
    1. emit BrowserViewIntent { kind: 'hide-all', reason: 'mode-switch-prepare' }
    2. wait for main ack (1 round-trip)
    3. setWorkbenchMode(to)  // renderer state flip; DOM mounts new mode
    4. nextTick: emit any DOM overlay opens
  if from !== 'browser' and to === 'browser':
    1. setWorkbenchMode(to)  // DOM mounts first (Browser mode mounts an empty native overlay slot)
    2. nextTick: emit BrowserViewIntent { kind: 'show', tabId: <activeTabId>, bounds, reason: 'mode-switch' }
  if from === to: no-op
```

The "wait for main ack" before flipping renderer state is the critical step missing today; it removes the ~1s wall-clock window where the renderer says "I'm in document mode" but the native BrowserView is still on top.

Re-measure on **the same W3.3 equipment** (MacBook Pro M5 Pro 24 GB, macOS 26.4, 120Hz ProMotion); record in `docs/superpowers/audits/2026-05-22-stage-x-closeout/workbench-shell-report.md` table: Scenario C (mode switch) median + p95 before vs after. Target: wall-clock < 300ms p95 (current ~1s).

Verification:

```bash
npm run typecheck
npm run test
```

Live validation:

- Record browser -> document -> browser transition.
- Include `ready-browser.log` window around `hideAll`, `showActive`, and bounds updates.

### PR-shell-4

Required result:

- Split workbench mode sends non-null secondary bounds when a secondary BrowserView should be visible.
- Main `tab-shell-service` receives and applies the secondary bounds.
- The W3 "secondary bounds count 0" failure is no longer true in the reproduced split scenario.

Suggested data flow (renderer → main):

```
Split mode active:
  renderer useBrowserViewBounds.ts measures both primary + secondary pane DOMRect
  →  emit BrowserViewIntent { kind: 'set-bounds', tabId: primaryId, bounds: primaryRect }
  →  emit BrowserViewIntent { kind: 'secondary-set-bounds', tabId: secondaryId, bounds: secondaryRect }
  main tab-shell-service.ts applies both via BrowserView.setBounds()
  main logs both in ready-browser.log
```

The "secondary bounds count = 0" failure was: renderer measured the primary pane but never emitted the secondary intent because the split-pane mount only had one ref. PR-shell-4 must add the second ref + the second intent path.

Add focused behavior test at `src/__tests__/browserview-split-secondary-bounds.test.ts` that asserts: when split mode is active with both panes mounted, both `set-bounds` and `secondary-set-bounds` intents fire within one frame.

Verification:

```bash
npm run typecheck
npm run verify:ipc-contract
npm run test
```

Live validation:

- Record browser/RSS or browser/document split behavior as applicable.
- Capture `ready-browser.log` showing primary and secondary bounds.

X4 done when:

- PR-shell-1 / PR-shell-2 / PR-shell-4 each has code, tests, and live evidence.
- W5 dogfood item 4 and item 5 rerun without new shell regressions.
- `docs/superpowers/audits/2026-05-22-stage-x-closeout/workbench-shell-report.md` summarizes before/after measurements.

## 10. Phase X5 - Stage X closeout and Stage Y handoff

Goal: close the foundation work without letting product-surface gaps disappear.

Deliverables:

1. `docs/superpowers/audits/2026-05-22-stage-x-closeout/CLOSE-NOTE.md`
2. `docs/superpowers/audits/2026-05-22-stage-x-closeout/deferred-work-ledger.md`
3. `docs/superpowers/audits/2026-05-22-stage-x-closeout/no-drift.md`
4. `docs/superpowers/audits/2026-05-22-stage-x-closeout/w5-item-03-rerun/`
5. `docs/superpowers/audits/2026-05-22-stage-x-closeout/workbench-shell-report.md`
6. A Stage Y seed plan or a link to the existing product acceptance matrix.

Final required commands:

```bash
npm run verify:native
npm run typecheck
npm run lint:check
npm run verify:lint-budget
node scripts/check-eslint-baseline.cjs
npm run verify:ipc-contract
npm run verify:r
npm run verify:t
npm run test
npm run build
```

If `npm run build` fails for an environment reason, record exact stderr and decide whether it is a Stage X blocker. Do not silently omit it from the closeout.

Closeout ledger must classify every remaining item into one of:

- `Stage Y product-surface`
- `Stage Z release-candidate`
- `debt-warning-burn`
- `retired`
- `blocked-external`

Stage X is not closed if a release-relevant user-visible failure remains only in prose without a successor owner.

### 10.1 Closeout bundle reuse pattern (from Stage W)

Mirror the Stage W §2.1 5-artifact closeout shape so future stages have a consistent pattern:

| Artifact | Stage W path (reference) | Stage X path |
| --- | --- | --- |
| CLOSE-NOTE.md | `2026-05-22-stage-w-closeout/CLOSE-NOTE.md` | `2026-05-22-stage-x-closeout/CLOSE-NOTE.md` |
| deferred-work-ledger.md | `2026-05-22-stage-w-closeout/deferred-work-ledger.md` | `2026-05-22-stage-x-closeout/deferred-work-ledger.md` |
| no-drift.md | `2026-05-22-stage-w-closeout/no-drift.md` | `2026-05-22-stage-x-closeout/no-drift.md` |
| verify-bundle.sh | `2026-05-22-stage-w-closeout/verify-bundle.sh` (W0-captured baseline) | `2026-05-22-stage-x-closeout/verify-bundle.sh` (X0-captured baseline; new copy, not edit) |
| per-phase reports | `w1/` `dogfood/` | `x1-gate-repair-report.md`, `w5-item-03-rerun/`, `workbench-shell-report.md`, `ci-gate-report.md` |

The Stage X `verify-bundle.sh` should follow the same portable bash 3.2 / 4+ pattern (parallel NAMES + CMDS arrays, 0-indexed while loop, shebang `#!/usr/bin/env bash`). Do not re-run the Stage W `verify-bundle.sh` in Stage X close — that one is locked to Stage W's snapshot; Stage X needs its own baseline.

### 10.2 Stage X retrospective

The closeout note must include a "Lessons learned" section answering at minimum:

- Which X1 gate failures were real regressions vs stale paths? (informs whether Stage U move-only series needs a process retrospective)
- Did the X2 three-state decomposition catch a state the original W5 root-cause analysis missed?
- Did the X4 ordered ritual fix mode-switch within target, or did W3.3 measurement need to be re-baselined?
- Did the X3 minimal CI catch anything in its first 5 runs that the local merge gate had let through?

Each answer is one paragraph; if the answer is "no" or "n/a", say so explicitly. This is the seed for future stages' a-priori risk assessment.

## 11. Stage Y seed items

The following items are intentionally not Stage X work, but must be visible at Stage X close. Tagged with priority for Stage Y planning:

**P0 — release-blocking once Stage Y opens**:

- Full product dogfood matrix:
  - file manager
  - embedded browser
  - RSS
  - document editor / preview / widgets
  - calendar
  - Agent panel
  - settings
  - skills
  - provider failure recovery
- Release checklist synchronization for old Stage U yellow/manual items.

**P1 — should land in Stage Y core scope**:

- MCP real transport or explicit "not shipped" product labeling.
- Settings cache quota enforcement.
- Warning reduction below the 769 budget — start with `react-hooks/exhaustive-deps` (18) and `react-refresh/only-export-components` (17) since they hide real correctness bugs; `any` (551) is volume but lower correctness signal.
- Source-grep gate replacement with behavior tests where feasible.

**P2 — Stage Y stretch / Stage Z carry**:

- Windows parity for process cleanup / RSSHub worker behavior.
- Large-file extraction after boundaries are stable:
  - `turn-engine.ts`
  - `browser-tools.ts`
  - `agent-sdk-runtime.ts`
  - `skill-child-runner.ts`
  - `Settings.tsx`
  - `database.ts`
  - `FileTree.tsx`
  - `useAgent.ts` (W4.8 explicitly deferred)
  - document task pipeline executor

## 12. Claude executor handoff

Claude should start with X0 and X1, not with broad refactors.

Recommended first prompt:

```text
We are in /Users/user/实验田/ready-cowork on branch codex/readyguy.
Implement Stage X from docs/superpowers/plans/2026-05-22-X-trust-foundation-and-w5-recovery-implementation.md.
Start with X0 and X1 only:
1. create the Stage X closeout scaffold and starting verification snapshot;
2. inventory verify:c/r/t scripts;
3. repair stale-path deep gates;
4. add the stale-path meta-gate;
5. rerun the X1 required verification.
Do not fix W5 sessions or Workbench shell until X1 is green.
Keep changes surgical and record all evidence under docs/superpowers/audits/2026-05-22-stage-x-closeout/.
```

After X1 is green, use a second prompt for X2:

```text
Proceed to Stage X2 only.
Fix W5 item 3 session/composer recovery from the Stage X plan.
Start with failing behavior tests for the cold/header new-session path and failed-send composer unlock.
Do not physically split useAgent unless required by the fix.
Rerun W5 item 3 with isolated user data and store evidence under the Stage X closeout directory.
```

