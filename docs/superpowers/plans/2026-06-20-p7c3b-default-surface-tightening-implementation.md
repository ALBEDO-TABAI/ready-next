---
title: P7c3b Default Surface Tightening Implementation
date: 2026-06-20
branch: agent-evolution/phase1
enforce: true
scope:
  - outputs/agent-audit/fix-plan/164-CONSENSUS-BROWSER-ISOLATION-SPECIALIST-PRODUCT-ROUTE.md
  - outputs/agent-audit/fix-plan/165-CLAUDE-P7C3B-PLAN-PROMPT-FAILURE.md
---

# P7c3b Default Surface Tightening

## Goal

Reduce the feeling that agent browser work silently occupies the user's current browser surface by making the two existing modes explicit:

- current visible page co-driving;
- background agent page work.

## Assumptions

- `browser-agent-runner` currently operates a deterministic workflow against the visible page under a `user-view` write lease.
- `scoped-browser-facade` already supports `agent-view` when a concrete `agentTabId` exists.
- Moving deterministic workflows to a background agent tab is not a safe P7c3b change because it touches page target selection, current focus, upload/submit behavior, and browser identity policy.

## Non-Goals

- No browser profile, partition, cookie, login, permission, history, download, or site-learning isolation.
- No claim that P7c3b closes P7c4.
- No browser module policy rewrite.
- No hidden switch that makes `browser-agent-runner` use `agent-view-background` by default.

## Work Packages

### WP1 · Route Plan Claim Guard

Add a small claim gate for this implementation plan so P7c3b cannot be described as browser isolation.

Acceptance:

- The gate fails if the P7c3b plan calls itself isolation or claims to close P7c4.
- The gate allows explicit non-goal wording such as "not isolation".

### WP2 · Visible Copy Tightening

Update browser ownership and supervision copy so the UI distinguishes:

- Agent co-driving the current visible page;
- Agent working on the background agent page;
- user takeover / pending confirmation / frozen control states.

Acceptance:

- `user-view` active write state says "current visible page" or equivalent, not generic "Agent browser".
- `agent-view` active write state says "background agent page" or equivalent.
- Existing takeover and pending-confirm states remain clear.

### WP3 · Surface Binding Contract

Codify the honest boundary:

- `browser-agent-runner` remains `user-view-assisted`;
- `scoped-facade` defaults to `agent-view-background` when it has an agent tab id;
- visible co-driving requires a lease;
- background agent-view writes require an agent tab id.

Acceptance:

- Existing surface-binding tests cover the runner and scoped facade distinction.
- No test implies a shared-session background tab is browser isolation.

## Verification

```bash
npm run verify:browser-surface
npm run verify:browser-native-lock
npm run typecheck
git diff --check
```

## Deferred To P7c4

- Whether agent browser work should use a separate partition/profile.
- Whether cookies/login/session state should be isolated or shared.
- Whether downloads, history, permissions, and site-card learning need separate ownership roots.
- Whether deterministic browser workflows can run safely in a background agent page by default.
