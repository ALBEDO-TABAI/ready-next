# Agent Core Loop Stage 5 Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在不把逻辑塞回 `DirectChatEngine` 的前提下，完成阶段 5 的四项增强：共享单轮预算、安全并发只读工具、只影响 prompt 的上下文压缩、统一的供应商回退链。

**Architecture:** `RunCoordinator` 成为单轮预算 owner，`PromptAssemblyService` 只负责 prompt 侧压缩与预算报告，execution clients 统一收口 provider fallback，`ExecutionLoopOrchestrator` 负责可并发只读工具的调度与回收。前台任务状态继续以 structured truth 为准，不消费压缩后的 prompt 文本。

**Tech Stack:** TypeScript、Electron main process、React renderer task state、Node test runner (`tsx --test`)

---

## Guardrails

- 不把新的高层策略判断塞回 `src/main/modules/claude-bridge/direct-chat.ts`
- 不改用户可见 tool 名、不改 BrowserView 规则、不改 scope 隔离
- 压缩只影响 prompt 入参，不改前台任务卡 truth
- 并发只允许只读、无副作用、无顺序依赖、无用户确认的工具族
- `npm test` 仍允许停留在当前已知旧失败：
  - `src/__tests__/browser-tab-switch-executor.test.ts`
  - `src/__tests__/workbench-liquid-shell-contract.test.ts`
- 不能新增本轮主控相关失败

## File Map

### Core files to modify

- `src/main/modules/agent-control/run-contracts.ts`
- `src/main/modules/agent-control/run-coordinator.ts`
- `src/main/modules/agent-control/prompt-assembly.ts`
- `src/main/modules/agent-control/execution-loop-orchestrator.ts`
- `src/main/modules/agent-control/run-projection.ts`
- `src/main/modules/agent-control/browser-domain-orchestrator.ts`
- `src/main/modules/agent-control/document-tool-loop-orchestrator.ts`
- `src/main/modules/agent-control/design-tool-loop-orchestrator.ts`
- `src/main/modules/claude-bridge/openai-execution-client.ts`
- `src/main/modules/claude-bridge/anthropic-execution-client.ts`
- `src/main/modules/claude-bridge/kimi-coding-client.ts`
- `src/main/modules/claude-bridge/video-fallback-service.ts`
- `src/main/modules/claude-bridge/direct-chat.ts`
- `src/main/modules/claude-bridge/ipc-handler.ts`
- `src/renderer/modules/agent/scopeRunState.ts`
- `src/renderer/modules/agent/taskCardViewModel.ts`
- `DOCUMENTATION.md`
- `PROGRESS.md`
- `CHANGELOG.md`

### New files to create

- `src/main/modules/agent-control/run-budget-policy.ts`
- `src/main/modules/agent-control/context-compression.ts`
- `src/main/modules/agent-control/tool-parallelism-policy.ts`
- `src/main/modules/claude-bridge/execution-fallback-policy.ts`
- `src/__tests__/run-coordinator-budget.test.ts`
- `src/__tests__/context-compression.test.ts`
- `src/__tests__/execution-loop-parallel-tools.test.ts`
- `src/__tests__/execution-fallback-policy.test.ts`

---

## Chunk 1: Shared Run Budget

### Task 1: Add explicit run budget contracts

**Files:**
- Create: `src/main/modules/agent-control/run-budget-policy.ts`
- Modify: `src/main/modules/agent-control/run-contracts.ts`
- Test: `src/__tests__/run-coordinator-budget.test.ts`

- [ ] **Step 1: Write the failing budget contract test**

Add a new test that expects these types and defaults to exist:

```ts
export interface RunBudgetSeed {
  maxIterations: number
  maxToolCalls: number
  maxParallelToolGroups: number
}

export interface RunBudgetUsage {
  iterationsUsed: number
  toolCallsUsed: number
  parallelToolGroupsUsed: number
}

export interface RunBudgetHint {
  maxIterations?: number
  reserveToolCalls?: number
}
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx tsx@^4.19.2 --test src/__tests__/run-coordinator-budget.test.ts`

Expected: FAIL because the new contracts do not exist yet.

- [ ] **Step 3: Add minimal budget policy file and contract exports**

Implement:

- `createRunBudgetSeed()`
- `applyRunBudgetHint()`
- `consumeIterationBudget()`
- `consumeToolCallBudget()`
- `consumeParallelGroupBudget()`

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx tsx@^4.19.2 --test src/__tests__/run-coordinator-budget.test.ts`

Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/main/modules/agent-control/run-contracts.ts src/main/modules/agent-control/run-budget-policy.ts src/__tests__/run-coordinator-budget.test.ts
git commit -m "feat: add shared run budget contracts"
```

### Task 2: Make `RunCoordinator` own the budget for the full run

**Files:**
- Modify: `src/main/modules/agent-control/run-coordinator.ts`
- Modify: `src/main/modules/agent-control/run-contracts.ts`
- Modify: `src/__tests__/run-coordinator.test.ts`
- Test: `src/__tests__/run-coordinator-budget.test.ts`

- [ ] **Step 1: Extend the failing tests**

Update tests to expect:

- planning creates a budget seed
- execution host receives budget state
- completion records final budget usage

- [ ] **Step 2: Run the targeted tests to verify they fail**

Run: `npx tsx@^4.19.2 --test src/__tests__/run-coordinator.test.ts src/__tests__/run-coordinator-budget.test.ts`

Expected: FAIL because coordinator does not pass budget through yet.

- [ ] **Step 3: Implement minimal coordinator wiring**

Add to `RunCoordinatorRequest` / `ExecutionHostRequest`:

```ts
budget?: RunBudgetSeed
budgetState?: RunBudgetUsage
```

Then:

- seed the budget once per run in `runScoped()` / `runInboundChannel()`
- pass the live budget into execution host calls
- preserve final usage in result hooks / projection input

- [ ] **Step 4: Run the targeted tests to verify they pass**

Run: `npx tsx@^4.19.2 --test src/__tests__/run-coordinator.test.ts src/__tests__/run-coordinator-budget.test.ts`

Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/main/modules/agent-control/run-coordinator.ts src/main/modules/agent-control/run-contracts.ts src/__tests__/run-coordinator.test.ts src/__tests__/run-coordinator-budget.test.ts
git commit -m "feat: move run budget ownership into coordinator"
```

### Task 3: Let domain layers return budget hints instead of owning budgets

**Files:**
- Modify: `src/main/modules/agent-control/browser-domain-orchestrator.ts`
- Modify: `src/main/modules/agent-control/document-tool-loop-orchestrator.ts`
- Modify: `src/main/modules/agent-control/design-tool-loop-orchestrator.ts`
- Modify: `src/__tests__/browser-domain-orchestrator.test.ts`
- Modify: `src/__tests__/document-tool-loop-orchestrator.test.ts`
- Modify: `src/__tests__/design-tool-loop-orchestrator.test.ts`

- [ ] **Step 1: Add failing tests for budget hints**

Expect:

- browser upload flows can request extra iterations
- document/design loops can reserve tool-call headroom
- none of these layers directly own counters

- [ ] **Step 2: Run the orchestrator tests to verify they fail**

Run: `npx tsx@^4.19.2 --test src/__tests__/browser-domain-orchestrator.test.ts src/__tests__/document-tool-loop-orchestrator.test.ts src/__tests__/design-tool-loop-orchestrator.test.ts`

Expected: FAIL because no hint contract exists yet.

- [ ] **Step 3: Implement minimal hint-returning methods**

Add methods like:

- `getBudgetHint()`
- `getToolLoopBudgetHint()`

Return shape must stay advisory only:

```ts
{ maxIterations?: number, reserveToolCalls?: number }
```

- [ ] **Step 4: Run the orchestrator tests to verify they pass**

Run: `npx tsx@^4.19.2 --test src/__tests__/browser-domain-orchestrator.test.ts src/__tests__/document-tool-loop-orchestrator.test.ts src/__tests__/design-tool-loop-orchestrator.test.ts`

Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/main/modules/agent-control/browser-domain-orchestrator.ts src/main/modules/agent-control/document-tool-loop-orchestrator.ts src/main/modules/agent-control/design-tool-loop-orchestrator.ts src/__tests__/browser-domain-orchestrator.test.ts src/__tests__/document-tool-loop-orchestrator.test.ts src/__tests__/design-tool-loop-orchestrator.test.ts
git commit -m "feat: add domain budget hints"
```

---

## Chunk 2: Prompt-Side Context Compression

### Task 4: Extract compression into a dedicated helper

**Files:**
- Create: `src/main/modules/agent-control/context-compression.ts`
- Modify: `src/main/modules/agent-control/prompt-assembly.ts`
- Test: `src/__tests__/context-compression.test.ts`

- [ ] **Step 1: Write the failing compression helper test**

Cover:

- long conversation history becomes a short summary block
- long tool trace becomes collapsed bullets
- artifact history becomes summarized labels
- empty inputs stay untouched

- [ ] **Step 2: Run the helper test to verify it fails**

Run: `npx tsx@^4.19.2 --test src/__tests__/context-compression.test.ts`

Expected: FAIL because the helper does not exist yet.

- [ ] **Step 3: Implement the helper with stable output buckets**

Implement exported functions:

```ts
compressHistoryForPrompt()
compressToolTraceForPrompt()
compressArtifactsForPrompt()
buildCompressionReport()
```

Do not mutate renderer-facing state. Output should be prompt-only strings and a report object.

- [ ] **Step 4: Run the helper test to verify it passes**

Run: `npx tsx@^4.19.2 --test src/__tests__/context-compression.test.ts`

Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/main/modules/agent-control/context-compression.ts src/main/modules/agent-control/prompt-assembly.ts src/__tests__/context-compression.test.ts
git commit -m "feat: add prompt-side context compression helpers"
```

### Task 5: Wire compression into `PromptAssemblyService` and preserve front-end truth

**Files:**
- Modify: `src/main/modules/agent-control/prompt-assembly.ts`
- Modify: `src/main/modules/agent-control/run-projection.ts`
- Modify: `src/renderer/modules/agent/scopeRunState.ts`
- Modify: `src/__tests__/prompt-assembly.test.ts`
- Modify: `src/__tests__/run-projection.test.ts`
- Modify: `src/__tests__/scope-run-state.test.ts`

- [ ] **Step 1: Add failing tests for compression boundaries**

Expect:

- prompt assembly returns a compression report when thresholds are exceeded
- `RunProjection` does not replace task truth with compressed text
- renderer still prefers structured fields over compressed text

- [ ] **Step 2: Run the targeted tests to verify they fail**

Run: `npx tsx@^4.19.2 --test src/__tests__/prompt-assembly.test.ts src/__tests__/run-projection.test.ts src/__tests__/scope-run-state.test.ts`

Expected: FAIL because compression report plumbing is missing.

- [ ] **Step 3: Implement minimal wiring**

Add to `PromptAssemblyResult`:

```ts
compression?: {
  historyCompressed: boolean
  toolTraceCompressed: boolean
  artifactSummaryUsed: boolean
}
```

Then:

- apply compression only while building prompt input
- expose the report to run metadata if useful for diagnostics
- never overwrite `taskTitle/taskSummary/steps` with compressed text

- [ ] **Step 4: Run the targeted tests to verify they pass**

Run: `npx tsx@^4.19.2 --test src/__tests__/prompt-assembly.test.ts src/__tests__/run-projection.test.ts src/__tests__/scope-run-state.test.ts`

Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/main/modules/agent-control/prompt-assembly.ts src/main/modules/agent-control/run-projection.ts src/renderer/modules/agent/scopeRunState.ts src/__tests__/prompt-assembly.test.ts src/__tests__/run-projection.test.ts src/__tests__/scope-run-state.test.ts
git commit -m "feat: wire prompt compression without changing frontend truth"
```

---

## Chunk 3: Unified Provider Fallback

### Task 6: Create a shared fallback policy contract for execution clients

**Files:**
- Create: `src/main/modules/claude-bridge/execution-fallback-policy.ts`
- Modify: `src/main/modules/claude-bridge/openai-execution-client.ts`
- Modify: `src/main/modules/claude-bridge/anthropic-execution-client.ts`
- Modify: `src/main/modules/claude-bridge/kimi-coding-client.ts`
- Test: `src/__tests__/execution-fallback-policy.test.ts`

- [ ] **Step 1: Write the failing fallback policy test**

Expect one shared helper to normalize these cases:

- native tools -> text bridge
- video blocks -> extracted frames
- OpenAI wire API retry path
- Kimi Coding special fallback tags

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx tsx@^4.19.2 --test src/__tests__/execution-fallback-policy.test.ts`

Expected: FAIL because the shared policy file does not exist yet.

- [ ] **Step 3: Implement the shared fallback contract**

Add helpers like:

```ts
resolveFallbackPlan()
shouldRetryWithVideoFrames()
shouldRetryWithTextBridge()
annotateFallbackResult()
```

The output must be client-friendly and not require `DirectChatEngine` to make per-provider decisions again.

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx tsx@^4.19.2 --test src/__tests__/execution-fallback-policy.test.ts`

Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/main/modules/claude-bridge/execution-fallback-policy.ts src/__tests__/execution-fallback-policy.test.ts
git commit -m "feat: add shared execution fallback policy"
```

### Task 7: Move provider-specific fallback ladders fully into the clients

**Files:**
- Modify: `src/main/modules/claude-bridge/openai-execution-client.ts`
- Modify: `src/main/modules/claude-bridge/anthropic-execution-client.ts`
- Modify: `src/main/modules/claude-bridge/kimi-coding-client.ts`
- Modify: `src/main/modules/claude-bridge/video-fallback-service.ts`
- Modify: `src/main/modules/agent-control/execution-loop-orchestrator.ts`
- Modify: `src/main/modules/claude-bridge/direct-chat.ts`
- Modify: `src/__tests__/openai-execution-client-contract.test.ts`
- Modify: `src/__tests__/anthropic-execution-client-contract.test.ts`
- Modify: `src/__tests__/kimi-coding-client-contract.test.ts`
- Modify: `src/__tests__/video-fallback-service-contract.test.ts`

- [ ] **Step 1: Extend client contract tests to fail on old fallback ownership**

Expect:

- execution clients return normalized fallback metadata
- `DirectChatEngine` no longer branches on provider fallback choice
- `ExecutionLoopOrchestrator` only coordinates retries, not provider-specific rules

- [ ] **Step 2: Run the targeted tests to verify they fail**

Run: `npx tsx@^4.19.2 --test src/__tests__/openai-execution-client-contract.test.ts src/__tests__/anthropic-execution-client-contract.test.ts src/__tests__/kimi-coding-client-contract.test.ts src/__tests__/video-fallback-service-contract.test.ts src/__tests__/agent-runtime-host-contract.test.ts`

Expected: FAIL because fallback ownership is still split.

- [ ] **Step 3: Implement minimal client-side fallback normalization**

Each client should return a stable shape such as:

```ts
{
  response: OpenAIExecutionResponse | AnthropicExecutionResponse | KimiExecutionResponse
  fallback?: {
    kind: 'none' | 'text_bridge' | 'video_frames' | 'wire_api_retry' | 'kimi_coding_retry'
    attempts: number
  }
}
```

- [ ] **Step 4: Run the targeted tests to verify they pass**

Run: `npx tsx@^4.19.2 --test src/__tests__/openai-execution-client-contract.test.ts src/__tests__/anthropic-execution-client-contract.test.ts src/__tests__/kimi-coding-client-contract.test.ts src/__tests__/video-fallback-service-contract.test.ts src/__tests__/agent-runtime-host-contract.test.ts`

Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/main/modules/claude-bridge/openai-execution-client.ts src/main/modules/claude-bridge/anthropic-execution-client.ts src/main/modules/claude-bridge/kimi-coding-client.ts src/main/modules/claude-bridge/video-fallback-service.ts src/main/modules/agent-control/execution-loop-orchestrator.ts src/main/modules/claude-bridge/direct-chat.ts src/__tests__/openai-execution-client-contract.test.ts src/__tests__/anthropic-execution-client-contract.test.ts src/__tests__/kimi-coding-client-contract.test.ts src/__tests__/video-fallback-service-contract.test.ts src/__tests__/agent-runtime-host-contract.test.ts
git commit -m "feat: unify provider fallback inside execution clients"
```

---

## Chunk 4: Parallel Read-Only Tools

### Task 8: Define which tools are safe to run in parallel

**Files:**
- Create: `src/main/modules/agent-control/tool-parallelism-policy.ts`
- Modify: `src/main/modules/agent-control/execution-tool-policy.ts`
- Test: `src/__tests__/execution-loop-parallel-tools.test.ts`

- [ ] **Step 1: Write the failing policy test**

Cover:

- read-only document inspection tools are eligible
- read-only design inspection tools are eligible
- skill/memory/rss status tools are eligible
- browser interaction, document writes, and destructive system tools are not eligible

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx tsx@^4.19.2 --test src/__tests__/execution-loop-parallel-tools.test.ts`

Expected: FAIL because the policy file does not exist yet.

- [ ] **Step 3: Implement the minimal policy helper**

Add helpers:

```ts
isParallelSafeTool()
groupParallelSafeToolCalls()
```

Use explicit allowlists first; do not infer from tool names loosely.

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx tsx@^4.19.2 --test src/__tests__/execution-loop-parallel-tools.test.ts`

Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/main/modules/agent-control/tool-parallelism-policy.ts src/main/modules/agent-control/execution-tool-policy.ts src/__tests__/execution-loop-parallel-tools.test.ts
git commit -m "feat: add safe parallel tool policy"
```

### Task 9: Execute parallel-safe tool groups and merge results deterministically

**Files:**
- Modify: `src/main/modules/agent-control/execution-loop-orchestrator.ts`
- Modify: `src/main/modules/agent-control/tool-runtime-context-builder.ts`
- Modify: `src/main/modules/claude-bridge/direct-chat.ts`
- Modify: `src/__tests__/execution-loop-parallel-tools.test.ts`
- Modify: `src/__tests__/agent-runtime-host-contract.test.ts`

- [ ] **Step 1: Add failing tests for grouped execution**

Expect:

- eligible tool calls in the same iteration can run concurrently
- result ordering stays stable by original tool-call order
- failures collapse back into a single loop result shape
- budget usage is charged per tool and per parallel group

- [ ] **Step 2: Run the targeted tests to verify they fail**

Run: `npx tsx@^4.19.2 --test src/__tests__/execution-loop-parallel-tools.test.ts src/__tests__/agent-runtime-host-contract.test.ts`

Expected: FAIL because loop orchestrator is still serial-only.

- [ ] **Step 3: Implement minimal parallel execution**

Rules:

- only group calls returned by `groupParallelSafeToolCalls()`
- execute with `Promise.allSettled`
- preserve original call order when writing results back into the loop
- if any grouped call is unsafe or ambiguous, drop back to serial execution

- [ ] **Step 4: Run the targeted tests to verify they pass**

Run: `npx tsx@^4.19.2 --test src/__tests__/execution-loop-parallel-tools.test.ts src/__tests__/agent-runtime-host-contract.test.ts`

Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/main/modules/agent-control/execution-loop-orchestrator.ts src/main/modules/agent-control/tool-runtime-context-builder.ts src/main/modules/claude-bridge/direct-chat.ts src/__tests__/execution-loop-parallel-tools.test.ts src/__tests__/agent-runtime-host-contract.test.ts
git commit -m "feat: execute safe read-only tool groups in parallel"
```

---

## Chunk 5: Integration, Projection Safety, and Docs

### Task 10: Keep projection/task cards stable and update docs

**Files:**
- Modify: `src/main/modules/claude-bridge/ipc-handler.ts`
- Modify: `src/renderer/modules/agent/scopeRunState.ts`
- Modify: `src/renderer/modules/agent/taskCardViewModel.ts`
- Modify: `DOCUMENTATION.md`
- Modify: `PROGRESS.md`
- Modify: `CHANGELOG.md`
- Modify: `src/__tests__/scope-run-state.test.ts`
- Modify: `src/__tests__/task-card-view-model-contract.test.ts`

- [ ] **Step 1: Add failing regression tests**

Expect:

- task cards still show structured truth instead of compressed prompt text
- budget/fallback metadata can appear in diagnostics without replacing task summary
- skill/document/design/browser task cards remain stable

- [ ] **Step 2: Run the targeted tests to verify they fail**

Run: `npx tsx@^4.19.2 --test src/__tests__/scope-run-state.test.ts src/__tests__/task-card-view-model-contract.test.ts`

Expected: FAIL if any new metadata leaks into primary task summary fields.

- [ ] **Step 3: Implement minimal renderer-safe plumbing and update docs**

Only surface new metadata in secondary diagnostics fields or logs. Do not demote structured task state.

- [ ] **Step 4: Run the targeted tests to verify they pass**

Run: `npx tsx@^4.19.2 --test src/__tests__/scope-run-state.test.ts src/__tests__/task-card-view-model-contract.test.ts`

Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/main/modules/claude-bridge/ipc-handler.ts src/renderer/modules/agent/scopeRunState.ts src/renderer/modules/agent/taskCardViewModel.ts DOCUMENTATION.md PROGRESS.md CHANGELOG.md src/__tests__/scope-run-state.test.ts src/__tests__/task-card-view-model-contract.test.ts
git commit -m "docs: record stage 5 runtime enhancements"
```

### Task 11: Final verification and known-failure check

**Files:**
- Modify only if verification reveals a regression

- [ ] **Step 1: Run the full targeted stage 5 suite**

Run:

```bash
npx tsx@^4.19.2 --test \
  src/__tests__/agent-runtime-host-contract.test.ts \
  src/__tests__/run-coordinator.test.ts \
  src/__tests__/run-coordinator-budget.test.ts \
  src/__tests__/prompt-assembly.test.ts \
  src/__tests__/context-compression.test.ts \
  src/__tests__/execution-fallback-policy.test.ts \
  src/__tests__/openai-execution-client-contract.test.ts \
  src/__tests__/anthropic-execution-client-contract.test.ts \
  src/__tests__/kimi-coding-client-contract.test.ts \
  src/__tests__/video-fallback-service-contract.test.ts \
  src/__tests__/execution-loop-parallel-tools.test.ts \
  src/__tests__/browser-domain-orchestrator.test.ts \
  src/__tests__/document-tool-loop-orchestrator.test.ts \
  src/__tests__/design-tool-loop-orchestrator.test.ts \
  src/__tests__/run-projection.test.ts \
  src/__tests__/scope-run-state.test.ts \
  src/__tests__/task-card-view-model-contract.test.ts
```

Expected: PASS

- [ ] **Step 2: Run typecheck**

Run: `npm run typecheck`

Expected: PASS

- [ ] **Step 3: Run full test suite**

Run: `npm test`

Expected:

- no new stage-5-related failures
- only the currently known unrelated failures may remain

- [ ] **Step 4: If full test output changed, inspect and fix before continuing**

Do not close the work if a new failure appears in:

- run coordinator
- prompt assembly
- execution clients
- browser/document/design/skill task state

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "test: verify agent core loop stage 5 rollout"
```

---

## Acceptance Criteria

- Every run has one shared budget owner, and domain layers only return hints
- Prompt compression happens before provider calls and never replaces front-end truth
- Provider fallback decisions live in execution clients, not in `DirectChatEngine`
- Safe read-only tool groups can run concurrently with deterministic merge order
- Browser/document/design/skill task cards remain structured and stable
- `npm run typecheck` passes
- Targeted stage 5 tests pass
- `npm test` introduces no new main-loop regressions

## Out Of Scope

- Cross-scope or cross-agent shared quotas
- Cross-provider hot switching
- Browser interactive step parallelism
- Document write parallelism
- Memory strategy redesign outside prompt compression
- Feishu capability replacement

