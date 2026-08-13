---
title: P8g-8a Routing Usability Implementation
date: 2026-06-20
branch: agent-evolution/phase1
enforce: false
scope:
  - outputs/agent-audit/fix-plan/164-CONSENSUS-BROWSER-ISOLATION-SPECIALIST-PRODUCT-ROUTE.md
  - docs/superpowers/plans/2026-06-20-p8g8a-specialist-create-entry-reliability-implementation.md
---

# P8g-8a Routing Usability

> Historical snapshot. Studio routing simulation, session preroute and specialist creation controls are retired from the current Codex product graph. Historical blueprints and routing rows remain audit-only; this file must not be used to recreate public IPC or controls.

## Goal

Make created specialist agents easier to understand after confirmation: a user should be able to type a sample new-session request and see whether current routing rules would suggest a specialist, route automatically, or stay with the main agent.

## Assumptions

- The existing session preroute evaluator remains the source of truth.
- Studio simulation must be read-only and must not create agents, activate routing cards, or write recent routing traces.
- Suggest-mode actions are presented as explicit choices. This slice does not add persistent "always route" writes.

## Changes

1. Add a Studio-only routing simulation IPC path that reuses `decideSessionPreroute` and `buildSessionPrerouteTrace` without pushing to the real trace buffer.
2. Expose the simulation through preload and renderer types.
3. Add an Agent System Studio routing probe with sample text, routing result chips, matched specialist/routing card, reasons, and three explicit choices:
   - use this specialist once;
   - always route this kind;
   - keep main agent.
4. Keep the Studio gate read-only by allowing only snapshot and simulation channels.
5. Add deterministic admission coverage for Chinese specialist creation phrasing: "我要一个...", "帮我建一个...", and "我需要一个...".

## Non-Goals

- No automatic specialist creation.
- No silent activation of staged routing cards.
- No route-card persistence from the simulation panel.
- No semantic interview redesign.
- No browser isolation work.

## Acceptance

- The Studio simulation channel returns the same decision shape as current preroute logic plus user-readable actions.
- Running a simulation does not call the real session preroute channel and does not push a trace.
- Studio still exposes no create/transition write channel under `agent:systemStudio`.
- Natural Chinese creation phrasing remains admitted only through the staged blueprint path.

## Verification

- `npx tsx@^4.19.2 --test src/__tests__/agent-system-studio-ipc.test.ts src/__tests__/agent-system-studio-render.test.tsx`
- `node scripts/check-specialist-studio-readonly.cjs && node --test scripts/__tests__/check-specialist-studio-readonly.test.cjs`
- `npm run verify:agent-system-studio`
- `npm run verify:specialist-blueprint`
- `npx tsx@^4.19.2 --test src/__tests__/session-preroute.test.ts`
- `npm run typecheck`
- `git diff --check`
