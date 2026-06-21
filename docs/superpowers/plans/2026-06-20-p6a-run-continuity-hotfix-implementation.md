---
title: P6a run continuity hotfix implementation
date: 2026-06-20
phase: P6a
enforce: true
source:
  - outputs/agent-audit/fix-plan/208-CODEX-RUN-CONTINUITY-INDEPENDENT-REVIEW.md
  - outputs/agent-audit/fix-plan/209-CLAUDE-RUN-CONTINUITY-REVIEW.md
  - outputs/agent-audit/fix-plan/210-CONSENSUS-P6A-RUN-CONTINUITY-HOTFIX-ROUTE.md
  - outputs/agent-audit/fix-plan/212-CLAUDE-P6A-PLAN-FAILURE.md
  - outputs/agent-audit/fix-plan/213-CODEX-P6A-IMPLEMENTATION-PLAN-DRAFT.md
---

# P6a · Run Continuity Hotfix

## Goal

Fix the installed-app interruption pattern where the renderer declares an infrastructure timeout locally while the main-side run can remain alive, close late, or be preempted by a new same-scope run with poor visible continuity.

P6a is a hotfix slice, not a full P6 compaction rewrite.

## Non-Scope

Do not include:

- C28/C29 full context-budget or compaction unification.
- TurnEngine retirement.
- Giant-file splitting.
- Windows/path redaction.
- Browser identity/profile/partition isolation.
- Specialist-agent product work.
- P4 C20/C21 reflection or C27 recall migration.

## P6a-1 Main-Visible Renderer Timeout

Contract:

- Renderer infrastructure timeout must not only mutate local Zustand state.
- Timeout must call a main-visible IPC with `scopeId`, `requestId`, and `elapsedMs`.
- Main must verify that the timeout still targets the active same-scope/same-request run.
- If the run is still active, main must deterministically request cancellation through the owning runtime and return an explicit acknowledged state.
- If the cancellation request is accepted but the run has not settled yet, the visible state must say `cancelling`/`takeover_pending` rather than pretend final completion.
- If the run is no longer current, main must return a stale/noop result and must not affect the newer run.
- Renderer local recovery is provisional. It unlocks the composer, but the final visible terminal state must come from main or from an explicit stale/noop response.

Implementation shape:

- Add a narrow IPC such as `agent:reportInfrastructureTimeout`.
- Expose it through preload and renderer types.
- Add a minimal active-scope-run ledger in the main runtime boundary if no existing source can answer `scopeId + requestId -> active run`.
- Do not reuse broad `agent:kill(agent, sessionId)` as the primary mechanism because P6a needs request-id authority.

Tests/gates:

- `src/__tests__/renderer-infrastructure-timeout-main-visible.test.ts`
  - `fireInfrastructureTimeout(...)` invokes the new preload method before or alongside local recovery.
  - stale request id does not call destructive local recovery as if it were current.
  - local timeout UI is provisional and can be reconciled by the main acknowledgement.
- `src/__tests__/agent-run-infrastructure-timeout.test.ts`
  - active matching run receives a request-id-authorized cancel request.
  - accepted cancellation does not claim final completion before finalizer/close event.
  - stale request id is noop.
- `scripts/check-renderer-infrastructure-timeout-main-visible.cjs`
  - source gate: timeout path must call the main-visible API and must not be local-state-only.

## P6a-2 Old-Run Late Terminal Authority

Contract:

- A terminal event from an old request must not overwrite a newer same-scope run's visible state.
- Main result for a preempted old run must carry explicit lost/superseded authority instead of flattening into generic failure.
- Renderer must keep the newer `requestId` state authoritative when late events arrive.

Implementation shape:

- Keep or tighten renderer request-id guard in `runtimeDriver`.
- Ensure main `scopeRunAuthority` / `errorKind:'superseded'` is set for preempted old runs.
- If the old run closes after a new run starts, the old terminal status can be logged but cannot replace current scope state.

Tests/gates:

- `src/__tests__/agent-run-late-terminal-authority.test.ts`
  - old run terminal event after new run start does not alter the new run phase, terminal reason, composer lock, or tool trace.
  - old run result maps to `superseded`, not `unknown` or generic `Agent execution failed`.

## P6a-3 Continuity Seed Minimum

Contract:

- Preempt/resume seed must preserve the latest user request, current task context, owner agent, and complete tool call/result pairs.
- Tool calls may be compacted, but a call must not survive without its matching result or vice versa.
- If seed cannot prove this minimum, the next run must receive an explicit continuation notice instead of silent amnesia.

Implementation shape:

- Add focused assertions around `normalizeSessionSnapshotForSeed(...)` and the preempt carry-over path.
- Treat task/owner context as a combination of SDK session items plus the runtime `scopeRunSummary` / task projection context; do not force everything into the SDK memory snapshot.
- Prefer small seed validation and visible notice over rewriting the compactor.
- Do not implement full C28/C29 context-budget unification here.

Tests/gates:

- `src/__tests__/agent-run-continuity-seed.test.ts`
  - carried seed keeps latest user message.
  - tool call/result pairs remain paired.
  - owner agent/current task refs survive or produce explicit notice.

## P6a-4 Error Display And Persisted-Message Honesty

Contract:

- If `sendScoped` returns `success:false` but `persistence.message === 'persisted'`, renderer must not present it as "message lost" or a generic whole-agent failure.
- Friendly error copy must distinguish at least:
  - renderer infrastructure timeout
  - model/provider timeout
  - tool timeout / renderer bridge timeout
  - proof gap
  - blocked external
  - superseded/preempted
  - persistence display failure
- Existing response text, if present and persisted, must remain visible with a partial/unfinished framing.

Implementation shape:

- Adjust `useAgent.sendMessage` failure branch to treat `persisted` as a different display state from failed persistence.
- Extend `mapBackendErrorToFriendly(...)` or adjacent mapping for the P6a terminal/error kinds.
- Add renderer metric fields so persisted-message failures are separated from true message persistence failure.

Tests/gates:

- `src/__tests__/renderer-send-persisted-failure-display.test.ts`
  - persisted message is not shown as lost.
  - input preservation follows persistence truth.
  - partial generated text is not overwritten by a generic failure when it exists.
- `src/__tests__/agent-error-surface-classification.test.ts`
  - maps P6a error kinds and terminal reasons to distinct user-facing categories.

## P6a-5 Verification Chain

Contract:

- P6a must be callable as a named verify chain.
- The same tests must also be wired into the relevant long-lived chains so they do not become one-off proofs.

Implementation shape:

- Add `verify:evolution-p6a`.
- Wire runtime/finalizer-related tests or gates into `verify:stability`.
- Wire renderer display tests into the existing renderer/test chain used by nearby store/runtime-driver tests.
- Update `00-ROADMAP.md`, `AGENTS.md`, and `CLAUDE.md` only for the finalized P6a constraints.

Verification commands:

```bash
npm run verify:evolution-p6a
npm run verify:stability
npm run typecheck
git diff --check -- <P6a file set>
```

Run broader `verify:evolution-p1` only if P6a touches shared tool/result contracts.

## Exit Standard

P6a is complete only when:

- The focused P6a tests and gates pass.
- `verify:evolution-p6a` passes.
- `verify:stability` passes.
- `typecheck` passes.
- Claude implementation review accepts the final code, or a named alternate reviewer accepts it after Claude no-output. A no-output exception alone is only a failure record, not approval.
- `00-ROADMAP.md` is updated from "P6a current" to "P6a closed; P4 later next".

## Implementation Decisions

1. IPC name: `agent:reportInfrastructureTimeout`.
2. Terminal/error shape: reuse `cancelled_runtime` for actual cancellation and add `errorKind:'renderer_infrastructure_timeout'` for UI distinction unless code evidence shows a new terminal reason is unavoidable.
3. Active scope-run authority lives at the `AgentControlRuntime` boundary, not renderer state and not broad orchestrator session state.
4. `verify:evolution-p6a` does not run `verify:native` by default unless implementation touches SQLite-backed persistence. Native coverage remains owned by the affected existing chains.
