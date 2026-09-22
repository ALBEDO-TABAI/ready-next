---
enforce: false
documentation_status: archived-in-place
archived_at: 2026-09-06
---

> 原位归档（2026-09-06）：代码/检查引用：src/main/modules/skills-runtime/runtime-provisioner.ts。保留此路径不代表全文仍是当前合同；其中的状态、源码位置和待办属于原记录。现行约束见 [当前运行时合同](../../architecture/current-runtime-contracts.md)，归档去向见 [文档清单](../../documentation-inventory.md)。

# Packaged Provider and Runtime Recovery Implementation

> Date: 2026-07-15
> Status: implemented
> Enforce: true

## Goal

Close two failures reproduced from the Ready 0.6.1 arm64 package:

1. An OpenAI-compatible origin such as `https://relay.example.com` must resolve to its actual API prefix instead of the relay website.
2. Runtime provisioning must remain observable and recoverable when the Settings panel unmounts and remounts.
3. The same address and identity contracts must hold in background model calls, editable Settings fields, and the package builder.

## Evidence baseline

- The packaged seed used `https://cn-novacode.i0yu.cn` without `/v1`.
- The relay origin returned HTML from `/chat/completions`; the same credential and model succeeded at `/v1/chat/completions`.
- Runtime provisioning lived in Main, but only the mounted Renderer component retained phase, percentage, error, and completion state.
- A duplicate provision request was rejected while the original task remained active, leaving a remounted Settings page unable to recover.
- The content-study one-shot path appended `/v1/chat/completions` to a base that had already been canonicalized to `/v1`, producing `/v1/v1/chat/completions`.
- Base URL normalization ran on every keystroke in the controlled Settings input, so typing `https://relay...` could be rewritten halfway through entry.
- The package builder accepted domains beginning with `127.` as private HTTP hosts even when they were not IP addresses.
- A production-shaped NovaCode probe against `/v1/chat/completions` returned real SSE and `[DONE]` for both plain text and an OpenAI function-tool request. That proves tools for this fixed endpoint/model pair, but does not prove tools for arbitrary compatible relays.
- Standard `build:dist` could package whichever non-empty developer seed happened to be present, while the retired seeded-build helper exported broad local settings instead of one reviewed package request.

## Enforced contracts

### C1. Compatible-provider URL contract

- Origin-only OpenAI-compatible URLs canonicalize to `<origin>/v1`.
- Explicit path prefixes are preserved.
- Anthropic-wire compatible URLs are not forced through the OpenAI prefix.
- Packer applies the same rule before writing a seed.
- Public plain HTTP is rejected by Packer; localhost and private-network HTTP remain supported.
- URL credentials, query parameters, and fragments are removed at the shared persistence/request boundary; Packer rejects them as invalid package input.
- Every consumer appends only its protocol resource path to the canonical API base; no background path may add a second `/v1`.

### C2. Main-owned provision task contract

- Main owns one task snapshot with `runId`, monotonic `revision`, state, latest progress, timestamps, terminal error, and verified result.
- State is one of `idle`, `running`, `cancelling`, `succeeded`, `failed`, or `cancelled`.
- Renderer state is a projection of this snapshot, not the task authority.

### C3. Start and join contract

- A start request returns the current snapshot immediately while work continues in Main.
- A second start during an active task joins the existing promise and must not launch another download.
- A joining observer receives the latest known progress immediately.

### C4. Recovery contract

- Main exposes a snapshot query and broadcasts every revision to all live windows.
- Renderer subscribes before querying so an event/query race cannot lose newer state.
- Renderer ignores a queried or delivered snapshot older than its highest accepted revision.
- Remounting Settings restores the current phase, percentage, disabled action, error, and terminal result.

### C5. Terminal truth contract

- `succeeded` is published only after a final real status probe reports `overallReady=true`.
- A core-dependency install result with `ready=false` is a failed terminal state and remains retryable.
- A Python distribution is reused only after its executable probe succeeds; path existence alone is insufficient.

### C6. Cancellation contract

- Cancellation first publishes `cancelling`.
- Work checks cancellation after each asynchronous safe point.
- `cancelled` is published only after the worker exits; a cancelled run cannot later publish `done` or `succeeded`.
- Every progress callback carries its originating `runId`; late callbacks from a terminal or previous run are ignored and cannot overwrite a retry.
- A running task exposes a real Stop action in Settings, and the stopping state remains visible until Main confirms exit.

### C7. User-facing diagnosis contract

- HTML/non-JSON responses from a model endpoint are reported as an API-address problem.
- Generic service-unavailable text is reserved for failures that are not already actionable address/protocol errors.

### C8. Editable address contract

- Renderer keeps the Base URL exactly as the user is currently typing.
- Canonicalization happens at persistence and request boundaries; a successful save must not rewrite the active editor draft mid-entry.

### C9. Package transport boundary

- HTTP is accepted only for `localhost`, loopback IPs, or syntactically valid private-network IPs.
- Hostnames that merely begin with a private-looking prefix, such as `127.attacker.example`, are public and must be rejected before a credential can be embedded.

### C10. Compatible-provider capability boundary

- Generic OpenAI-compatible profiles in `auto` mode expose no tools by default.
- Explicit `toolUseMode=on` remains available for a relay whose capability is known.
- The Packer stamps `on` only for the verified NovaCode host plus `gpt-5.6-terra`; arbitrary compatible inputs are stamped `off`. Vision and native video remain off.

### C11. Package seed and publication boundary

- Normal `build:dist` fails closed when the repository seed is malformed or non-empty.
- Only a controlled Packer process may set the explicit seed override, and temporary seeds/backups are mode `0600` with interrupted-run recovery.
- Legacy helpers that exported broad local settings are physically removed, not retained as alternate release paths.
- A Packer job reaches `done` only after the app and mounted DMG contain the exact requested seed, the expected slim/full runtime shape, Electron Framework, a valid app signature, a valid DMG, and the `/Applications` link.

## Behavior gates

```bash
node --import tsx --test \
  src/__tests__/ai-provider-workspace.test.ts \
  src/__tests__/headless-one-shot.test.ts \
  src/__tests__/renderer-error-mapping.test.ts \
  src/__tests__/runtime-provisioner.test.ts \
  src/__tests__/runtime-provision-settings-resume.test.tsx \
  src/__tests__/stores.test.ts
node --test Packer/server.test.mjs
node --test scripts/__tests__/check-ai-seed-release-safety.test.cjs
npm run typecheck
npm run verify:native
npm run verify:streaming
```

Packaging acceptance additionally requires a new DMG, mounted-app signature verification, packaged seed inspection, and a fresh isolated-user-data smoke test.

## 2026-07-15 packaged acceptance

- `Ready-0.7.1-arm64.dmg` passed checksum verification, read-only mount inspection, arm64/version checks, deep signature verification, application launch, and clean-user database initialization.
- The mounted seed contained exactly one `https://cn-novacode.i0yu.cn/v1` / `gpt-5.6-terra` preset with verified tool use enabled and unverified vision/video capabilities disabled.
- Two real packaged-app turns completed through the OpenAI chat-completions stream with no provider error; both runs and projections closed successfully.
- Runtime remount/retry behavior passed its Renderer/Main behavior gate, and the clean packaged run reached a ready Python runtime. The company private relay remains a network-local acceptance item.

## Explicit non-goals

- Byte-range download continuation after the whole application exits is not part of this recovery contract. The active task survives Settings navigation, and failed/cancelled terminal states are retryable.
- No provider-specific request-routing branch is added for NovaCode; the shared OpenAI-compatible URL contract owns the behavior. The Packer's explicit capability stamp is limited to the endpoint/model pair proven by the real probe.
