---
title: P7c4 Browser Identity Policy Spike Implementation
date: 2026-06-20
branch: agent-evolution/phase1
enforce: true
scope:
  - outputs/agent-audit/fix-plan/164-CONSENSUS-BROWSER-ISOLATION-SPECIALIST-PRODUCT-ROUTE.md
  - outputs/agent-audit/fix-plan/175-CONSENSUS-P8G9B-PROFESSIONAL-AGENT-DESIGNER-ROUTE.md
---

# P7c4 Browser Identity Policy Spike

## Goal

Decide and document Ready's current agent-browser identity policy before any production partition/profile rewrite.

The immediate goal is not to implement isolation. It is to prevent the current protections from being misdescribed as isolation.

## Current State: Shared Browser Identity

Current protections are real but limited:

- `browser-surface-binding.ts` separates `user-view-assisted`, `agent-view-background`, and `read-only-observe`.
- `browser-write-lease.ts` gates writes and supports user takeover.
- `ensureAgentTab()` creates an agent-owned background tab without stealing the user's foreground tab.
- P7c3/P7c3b use native lock/supervision copy for intentional visible co-driving.

Current identity is still shared:

- normal tabs are created with `createHost('persist:browser')`;
- agent tabs are created through the same tab lifecycle path;
- RSS article fetch uses `session.fromPartition('persist:browser')`; the native RSS preview host was retired on 2026-09-30;
- auth popups use `partition: 'persist:browser'`;
- background probes use `partition: 'persist:browser'`;
- downloads use `session.fromPartition('persist:browser')`;
- permission/adblock policy is applied only to `persist:browser`.

Therefore, current agent browser work is not browser identity isolation.

## Policy Decision For This Batch

Ready keeps the current shared browser identity for now.

This is an explicit product/infrastructure state, not an isolation claim:

- visible co-driving remains `user-view-assisted`;
- background agent tab work remains same-session `agent-view-background`;
- the native lock overlay and supervision panel signal control ownership only;
- cookies, login state, permissions, downloads, history, and site learning remain shared unless a future batch changes the browser identity root.

## Future Isolation Option

If Ready later chooses true agent browser isolation, the implementation must use a separate browser identity root such as a dedicated Electron partition/profile.

Minimum proof for that future implementation:

- user tab and agent tab write different cookie/localStorage/IndexedDB values;
- each context proves the other value is invisible;
- in that future implementation, permission, download, history, popup, preview, background probe, and site-card learning ownership are either isolated or explicitly marked shared by policy;
- the user can inspect and reset the agent browser identity;
- visible co-driving still uses native lock/supervision.

## Non-Goals

- No production partition/profile change in this batch.
- No cookie/login/session migration.
- No browser history/download/schema migration.
- No UI claim that agent background tab means an independent browser.
- No change to P8 specialist-agent browser tool boundaries beyond saying they cannot claim browser isolation yet.

## Work Packages

### WP1 · Source Truth Map

Record the current shared-session evidence and keep it machine-checkable.

Acceptance:

- Gate proves normal tabs, agent tabs, RSS article fetch, auth popup, background probe, downloads, and session policy all still use `persist:browser`.
- Gate fails if docs claim current P7c4 isolation while source remains shared.

### WP2 · Negative Isolation Claim Gate

Add a gate that blocks overclaims:

- same-session background tab is not isolation;
- native lock overlay is not isolation;
- surface binding and write lease are not isolation;
- P7c4 is a decision/spike unless a future source-backed proof implements a separate identity root.

Acceptance:

- Gate passes with current honest wording.
- Gate fails on "P7c4 isolation complete" while source still uses `persist:browser`.
- Gate fails if the P7c4 plan stops saying current identity is shared.

### WP3 · Roadmap Sync

Update the route so P7c4 is closed only as a decision/spike.

Acceptance:

- Roadmap says production browser identity isolation is still not implemented.
- P8g specialist work remains separate and cannot imply independent browser identity.

## Verification

```bash
node scripts/check-p7c4-browser-identity-policy.cjs
node --test scripts/__tests__/check-p7c4-browser-identity-policy.test.cjs
npm run verify:browser-surface
npm run verify:browser-native-lock
npm run typecheck
git diff --check
```
