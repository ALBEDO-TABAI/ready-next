# Direct Answer and User Profile Truth Implementation

> Date: 2026-07-15
> Status: implemented
> Enforce: true

## Goal

Close two production gaps reproduced from the Ready 0.6.1 conversation history:

1. A non-empty zero-tool answer must be judged as a direct answer, not against the stale bootstrap short-task contract.
2. The confirmed long-term preferences saved in Settings must enter the production scoped-run system prompt on every turn.
3. Local conversations must retain their user binding, and the saved Agent tone must travel through the same production prompt path.

Existing rows created by the first defect must be repaired without reclassifying genuine incomplete work.

## Evidence baseline

- Five replies in conversation `conv-b4a38ced-bcab-40e3-97bf-fad75e419c60` have non-empty assistant messages and `task_projections.task_type = direct_answer`, but `run_meta.task_type = short_task`, `status = error`, and `terminal_reason = adjudication_degraded`.
- Their stored criterion is the short-task `tool_call` requirement, with zero of one satisfied, even though an `assistant_response` proof exists.
- The terminal projection patch already declares `direct_answer`; `resolveEffectiveTaskFacts()` incorrectly lets the stale bootstrap budget type win over that terminal fact.
- `default-user.preferences_json.longTermPreferences` contains the saved preference, while production `PromptAssemblyService.loadUSER()` renders name, language, and communication style only.
- `composePersonaSystemPrompt()` renders long-term preferences, but scoped production runs pass an already assembled system prompt and therefore do not use that fallback path.
- The legacy local-conversation persistence call omits `userId`; its upsert currently replaces an existing `default-user` binding with `NULL`.
- The personality editor persists `tone`, while the production execution profile carries only the personality body.

## Enforced contracts

### C1. Terminal task-type truth

- A terminal `direct_answer` patch overrides only a stale bootstrap budget; explicit research, browser, continuation, and skill budgets remain authoritative.
- A bootstrap budget may constrain execution but must not become the final task identity after the turn has proven itself to be a zero-tool direct answer.
- Zero-tool runs with a non-empty final answer reconcile their terminal budget snapshot to `direct_answer` before finalization.
- The response digest satisfies the direct-answer criterion, producing `done/completed`, never `adjudication_degraded/failed`.

### C2. Ledger agreement

- `run_meta.task_type`, terminal task projection type, adjudication criteria, and the terminal budget snapshot agree on `direct_answer` for a zero-tool answer.
- The run-close metric reports the same effective task type.

### C3. Historical repair safety

- The migration repairs only rows that simultaneously have:
  - persisted `task_type = direct_answer`;
  - failed/error with `adjudication_degraded`;
  - a non-empty assistant response for the same run;
  - exactly the obsolete single unsatisfied template `tool_call` criterion;
  - no model-declared criteria.
- The matching projection, run ledger, and message-attached task snapshot are repaired together.
- Genuine degraded work, empty replies, tool-bearing tasks, and model-criteria failures remain untouched.

### C4. User-profile single renderer

- Name, preferred language, communication style, and long-term preferences share one formatter used by both the production prompt assembly and the orchestrator fallback.
- A new profile field cannot silently exist in only one prompt path.

### C5. Preference application

- Confirmed long-term preferences are present in the production scoped-run system prompt on the very next turn, including existing conversations.
- Style preferences are framed as active response guidance, not passive profile metadata.
- A versioned response-style reminder is extracted from L0 and moved to the final provider-instruction block exactly once, after tool, document, and date reminders. Region/persona labels describe observable language qualities rather than a claimed real identity.
- Current user instructions, factual accuracy, and safety/code boundaries retain higher priority.

### C6. Local user binding

- Creating or re-persisting a local conversation binds it to `default-user` and an omitted optional field never erases an existing user binding.
- Historical local conversations with no user binding are backfilled to `default-user`; remote and channel conversations remain untouched.
- Existing and newly created local conversations therefore resolve the same current profile on the next turn.

### C7. Agent tone

- The saved personality tone is frozen into the production execution profile and rendered beside the personality body.
- Production scoped runs and the orchestrator fallback use the same executable wording for profile style and tone.
- Dynamic Delivery workers remain neutral, while owner delivery and any complete replacement answer preserve the already assembled user-facing style contract.

### C8. Renderer does not invent terminal truth

- A failed Main result stays failed in the live Renderer state even when partial text was already streamed.
- The partial text remains visible, but Renderer never converts `error/adjudication_degraded` into an unpersisted green completion.
- A valid direct answer becomes green because Main finalizes it as `done`, not because the UI guesses from text presence.

### C9. Fallback prompt identity isolation

- Persona fallback receives the public conversation scope identity instead of reading a process-global user.
- An unbound local scope resolves `default-user`; a bound remote scope resolves only its bound user; an unbound remote scope reads no local user profile.
- Background narration and other calls without an explicit system prompt use the same scope-aware resolver, so local long-term preferences cannot leak into remote output.

## Behavior gates

```bash
npx tsx@^4.19.2 --test --test-concurrency=1 \
  src/__tests__/run-finalizer-checkin.test.ts \
  src/__tests__/prompt-assembly.test.ts \
  src/__tests__/persona-system-prompt.test.ts \
  src/__tests__/orchestrator-persona-resolver.test.ts \
  src/__tests__/dynamic-delivery-coordinator.test.ts \
  src/__tests__/stores.test.ts \
  src/__tests__/migration-077-direct-answer-truth.test.ts \
  src/__tests__/migration-078-local-conversation-user-binding.test.ts \
  src/__tests__/user-profile-prompt-wiring.test.ts \
  src/__tests__/agent-sdk-turn-input-assembly.test.ts
npm run typecheck
npm run verify:stability
npm run verify:evolution-p2
npm run verify:native
```

Live acceptance additionally requires a fresh packaged-app run that proves a simple zero-tool reply closes successfully and a saved style preference is visible in the exact provider-bound system prompt or in the resulting response.

## 2026-07-15 packaged acceptance

- A fresh packaged user saved `风趣幽默，四川辣妹`, created a local conversation, and submitted a neutral two-sentence prompt through the real DOM composer.
- The persisted reply used a light joke and the natural Sichuan phrase `巴适得板` without claiming a real-world identity.
- The live run closed as `direct_answer / done`; the task projection closed as `completed`, every visible task-card source rendered done, and the isolated database contained zero failed runs or task projections.

## Explicit non-goals

- The migration does not relabel arbitrary historical failures merely because an assistant message exists.
- User preferences do not override a per-turn explicit request, factual correctness, safety policy, or action-confirmation rules.
- No second profile store or renderer-only personality cache is introduced.
