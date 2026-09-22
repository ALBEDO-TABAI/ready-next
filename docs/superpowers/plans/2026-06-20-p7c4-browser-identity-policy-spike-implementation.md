---
title: P7c4 Browser Identity Policy Spike Implementation
date: 2026-06-20
branch: agent-evolution/phase1
enforce: false
scope:
  - outputs/agent-audit/fix-plan/164-CONSENSUS-BROWSER-ISOLATION-SPECIALIST-PRODUCT-ROUTE.md
  - outputs/agent-audit/fix-plan/175-CONSENSUS-P8G9B-PROFESSIONAL-AGENT-DESIGNER-ROUTE.md
documentation_status: archived-in-place
archived_at: 2026-09-06
---

> 原位归档（2026-09-06）：代码/检查引用：scripts/__tests__/check-p7c4-browser-identity-policy.test.cjs, scripts/check-p7c4-browser-identity-policy.cjs。保留此路径不代表全文仍是当前合同；其中的状态、源码位置和待办属于原记录。现行约束见 [当前运行时合同](../../architecture/current-runtime-contracts.md)，归档去向见 [文档清单](../../documentation-inventory.md)。

# P7c4 Browser Identity Policy Spike

## Goal

Decide and document Ready's current agent-browser identity policy before any production partition/profile rewrite.

The immediate goal is not to implement isolation. It is to prevent the current protections from being misdescribed as isolation.

## Current State: Shared Default With Explicit Profiles

Current protections are real but limited:

- `browser-surface-binding.ts` separates `user-view-assisted`, `agent-view-background`, and `read-only-observe`.
- `browser-write-lease.ts` gates writes and supports user takeover.
- `ensureAgentTab()` creates an agent-owned background tab without stealing the user's foreground tab.
- P7c3/P7c3b use native lock/supervision copy for intentional visible co-driving.

The default identity is still shared:

- normal tabs and agent tabs use `persist:browser` unless a named profile is explicitly selected;
- agent tabs are created through the same tab lifecycle path;
- preview views use `createHost('persist:browser')`;
- auth popups follow the source tab's profile;
- background probes use `partition: 'persist:browser'`;
- downloads follow the source tab's browser session;
- permission/adblock policy is applied to every browser partition Ready creates.

Therefore, current agent browser work is not browser identity isolation.

## Policy Decision For This Batch

Ready keeps the default browser identity shared. `browser_session(action=switch_profile)` may explicitly open a named profile for a separate cookie and origin-storage identity.

This is an explicit product/infrastructure state, not an isolation claim:

- visible co-driving remains `user-view-assisted`;
- background agent tab work remains same-session `agent-view-background`;
- the native lock overlay and supervision panel signal control ownership only;
- default tabs continue sharing cookies and login state;
- named profiles isolate cookies and origin storage, while history and application-level learning remain shared by policy.
- Profile selection is explicit; Ready never silently moves an existing tab into another identity.

## Broader Isolation Option

Named profiles now provide a separate browser identity root for cookies and origin storage. If Ready later needs full product-data isolation, it must also separate the shared application records listed below.

Minimum proof for that future implementation:

- user tab and agent tab write different cookie/localStorage/IndexedDB values;
- each context proves the other value is invisible;
- in that future implementation, permission, download, history, popup, preview, background probe, and site-card learning ownership are either isolated or explicitly marked shared by policy;
- the user can inspect and reset the agent browser identity;
- visible co-driving still uses native lock/supervision.

## Non-Goals

- No silent profile migration or automatic per-agent identity split.
- No cookie/login/session migration.
- No browser history/download/schema migration.
- No UI claim that agent background tab means an independent browser.
- No change to P8 specialist-agent browser tool boundaries beyond saying they cannot claim browser isolation yet.

## Work Packages

### WP1 · Source Truth Map

Record the current shared-session evidence and keep it machine-checkable.

Acceptance:

- Gate proves the shared default, explicit named profiles, profile-following popups/downloads, and policy coverage stay aligned.
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
- Gate fails if the P7c4 plan stops saying the default identity is shared or overstates named-profile isolation.

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
