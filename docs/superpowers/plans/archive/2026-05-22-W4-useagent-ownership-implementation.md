---
name: W4-useagent-ownership-implementation
stage: W4
date: 2026-05-22
status: implementation-draft
enforce: false
parent_roadmap: docs/superpowers/plans/archive/2026-05-22-W-ready-stabilization-roadmap.md
predecessor_phase: docs/superpowers/plans/archive/2026-05-22-W1-lint-errors-and-baseline-drift-implementation.md
---

# W4 — `useAgent` state ownership implementation plan

## 0. Scope

W4 declares ownership boundaries inside `useAgent.ts` (currently 2,570 LOC) so the next multi-session work does not turn the store into a new monolith. It also lands the V3.3b.3-5 per-session field migrations deferred from Stage V (audit § G5.1).

In scope: ownership area inventory, V3.3b.3-5 (streaming / scopeRuns / taskProjections) mirror migration, 4 falsifiable acceptance contracts (selector / cross-area mutation guard / listener routing / per-field mirror), optional internal extraction.

Out of scope: large rewrite of consumers (ChatPanel, TaskPanel, MeetingChat), new multi-session features, any UI change.

## 1. Preconditions

- W1 closed: lint clean baseline.
- W0 verification snapshot present.
- May run in parallel with W3 (no shared files).
- Stage V V3.3b.1 (inputValue) and V3.3b.2 (messages) already landed (commits `f174de11` and `fad6e299`); W4 extends the existing mirror pattern.

## 2. Success criteria

1. `docs/superpowers/audits/2026-05-22-w4-useagent-ownership-map/` directory with:
   - `current-test-coverage.md` — every `useAgent` / `chat-session` / `multi-session` / `pending-send` test labeled by ownership area.
   - `consumer-dependency-map.md` — every `useAgent.getState()` / `useAgent(...)` call site outside the store, grouped by area and read/write.
   - `ownership-areas.md` — 6 areas (session slice / runtime event listeners / pending-send coalescing / message persistence and replay / task projection merging / UI selectors) with explicit boundaries.
2. V3.3b.3-5 migrations landed: `streaming`, `scopeRuns`, `taskProjections` fields live in `sessions[id].slice` with top-level mirror for consumer back-compat.
3. 4 acceptance contracts present and passing (test file paths from roadmap § 7):
   - `src/__tests__/useAgent-area-selector-contract.test.ts`
   - `src/__tests__/useAgent-cross-area-mutation-guard.test.ts` + `eslint-rules/no-cross-area-mutation.mjs`
   - `src/__tests__/useAgent-listener-routing-contract.test.ts`
   - `src/__tests__/useAgent-session-slice-migration.test.ts` (3 sub-cases: streaming / scopeRuns / taskProjections)
4. `useAgent.ts` either shrinks OR its 6 ownership areas are extracted into named sub-modules (`useAgent/<area>/index.ts` style).
5. A sample diff demonstrating "one ownership area's internals can change without touching consumers" is in the W4 closeout note.

## 3. Step-by-step

### W4.1 — Inventory pass

#### Current test coverage

```bash
find src/__tests__ -name "*useAgent*" -o -name "*chat-session*" -o -name "*multi-session*" -o -name "*pending-send*" | sort
```

For each file, open and label which of the 6 ownership areas it touches. Write `current-test-coverage.md`.

#### Consumer dependency map

```bash
grep -rn "useAgent\.getState\|useAgent(" src/renderer src/preload --include="*.ts" --include="*.tsx" | grep -v "src/renderer/stores/useAgent.ts" > w4-consumer-raw.txt
```

Group findings by ownership area and read/write intent. Write `consumer-dependency-map.md` as a table: `file:line | area | intent (read/write) | selector name`.

#### Ownership area declaration

Write `ownership-areas.md`, one section per area. Each section names:

- Owned state keys.
- Declared selectors (typed, return narrow slices).
- Declared actions (the only allowed write path).
- Forbidden cross-area access (link to acceptance contract that enforces it).

### W4.2 — V3.3b.3 streaming field migration

Following the V3.3b.1 / V3.3b.2 mirror pattern:

- Add `streaming` to `SessionSlice` type in `useAgent.ts`.
- Initialize on `createSession()`.
- Mirror top-level `streaming` to `sessions[activeId].slice.streaming` on every relevant write.
- Add sub-case to `useAgent-session-slice-migration.test.ts`:
  - Set `sessions[id1].slice.streaming = X`; assert top-level `streaming === X`.
  - `setActiveSessionId(id2)` where `sessions[id2].slice.streaming = Y`; assert top-level `streaming === Y`.
- Consumers stay unchanged.

### W4.3 — V3.3b.4 scopeRuns field migration

Same pattern as W4.2 for `scopeRuns`.

### W4.4 — V3.3b.5 taskProjections field migration

Same pattern for `taskProjections`. Watch for the existing task-projection merging logic in §3.5; the mirror must run after merge, not replace it.

### W4.5 — Acceptance contract: per-area selector

Create `src/__tests__/useAgent-area-selector-contract.test.ts`:

- For each of the 6 areas, import its declared selector.
- Assert: calling the selector twice with no state change returns `===` (shallow stability).
- Assert: the area's internal state is not exported (try `import { internal_X } from '...useAgent...'`, expect TS or runtime error).

### W4.6 — Acceptance contract: cross-area mutation guard

Create `eslint-rules/no-cross-area-mutation.mjs` (matches existing rule style in `eslint-rules/`):

- Inputs: a static map `AREA_ACTIONS = { sessionSlice: [...], runtimeListeners: [...], pendingSend: [...], persistence: [...], projection: [...], selectors: [...] }` enumerated from `ownership-areas.md`.
- AST visitor: for each `ImportDeclaration` whose source matches `useAgent` (or its sub-module), collect the imported names. Group them by their `AREA_ACTIONS` membership. If a file imports actions from more than one area, report on the second area's import with message: `"cross-area mutation: file imports actions from areas {A, B}; only one area's actions allowed per consumer file"`.
- Allowlist: a file may opt out via a file-level disable comment `/* eslint-disable no-cross-area-mutation -- reason */` placed at the very top of the file (before any imports), only when justified in the lint exemption ledger. Note: `eslint-disable-line` only suppresses one line and will not cover later imports — use the file-level form `eslint-disable`.

Test fixtures (under `eslint-rules/__tests__/no-cross-area-mutation.test.mjs`, matching the existing `.test.mjs` pattern):

- Fixture 1 (rejected): a file importing `setInputValue` (sessionSlice) + `flushPendingSend` (pendingSend) — must fire.
- Fixture 2 (accepted): a file importing only `setInputValue` + a selector from the same area — must not fire.

Create `src/__tests__/useAgent-cross-area-mutation-guard.test.ts`:

- Imports the rule module + a fixture file that violates it.
- Test asserts the rule produces one diagnostic with the expected message.

### W4.7 — Acceptance contract: listener routing

Create `src/__tests__/useAgent-listener-routing-contract.test.ts`:

- For each push channel type, simulate event delivery 3 times:
  1. With `sessionId` set on the payload.
  2. With `sessionId` absent, `conversation` set.
  3. With both absent (`activeSessionId` fallback).
- Assert resolution order matches the 3-level fallback from `useAgent.ts`.
- Test fails if a listener falls back in a different order.

### W4.8 — Optional internal extraction

If `useAgent.ts` ownership areas can be cleanly extracted into `src/renderer/stores/useAgent/<area>/index.ts` modules without breaking any consumer, do so. Otherwise document in `ownership-areas.md` why extraction is deferred and what cross-area state forced the deferral.

### W4.9 — Sample diff demonstration

In W4 closeout note, include a sample diff showing how one ownership area's internal slice was changed without touching any consumer file. This is the falsifiable proof of success criterion 5.

## 4. Final verification

```bash
npm run typecheck
npm run lint:check
node scripts/check-eslint-baseline.cjs
npm run test
npm run test:serial-skill-child
```

All must pass. The 4 new tests must be discovered and run.

## 5. Codex review

Per roadmap § 2.2:

- Plan review before W4.1.
- Per-PR review for each of W4.2-W4.4 (3 migration PRs).
- Per-PR review for W4.5-W4.8 (4 contract PRs).
- W4 exit review after the sample diff is in the closeout note.

W4 closes when exit review returns 0-异议.
