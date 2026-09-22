---
title: Lint exemption ledger
date: 2026-05-22
stage: W1
enforce: false
parent_roadmap: docs/superpowers/plans/archive/2026-05-22-W-ready-stabilization-roadmap.md
applies_to: docs/superpowers/plans/archive/2026-05-22-W1-lint-errors-and-baseline-drift-implementation.md
documentation_status: archived-in-place
archived_at: 2026-09-06
---

> 原位归档（2026-09-06）：固定历史证据仍引用此路径。保留此路径不代表全文仍是当前合同；其中的状态、源码位置和待办属于原记录。现行约束见 [当前运行时合同](../../architecture/current-runtime-contracts.md)，归档去向见 [文档清单](../../documentation-inventory.md)。

# Lint exemption ledger

Single source of truth for "why a Ready custom lint rule was silenced at a
specific file:line". Each row records the rule, the file:line, the reason,
the owner, and an expiry date or removal condition.

A new row is required whenever a W1 (or later) PR adds a
`// eslint-disable-next-line <rule-name> -- <reason>` comment for a
Ready-namespaced rule (`ready/no-source-grep-test`,
`ready/no-legacy-backdoor`, `ready/no-subagent-leak`,
`ready/no-migration-todo`). Generic ESLint suppressions
(`@typescript-eslint/*`, `no-control-regex`, etc.) do not need a row unless
the W-stage plan specifically asks.

Removal condition shorthand:

- **runtime-upgrade**: remove the exemption once the target code has an
  electron-free seam that lets `node:test` exercise the assertion at
  runtime (replace the source-grep test with a behavior test in the same
  PR).
- **stage-V/U-move-confirms**: remove the exemption once the prior
  move-only Stage U or V batch is confirmed to have left the assertion
  target in its current location for the rest of W.
- **rule-boundary-update**: remove the exemption once `ready/<rule>` itself
  is patched (and its `eslint-rules/__tests__/` test is updated) to
  sanction this code shape.

## Active exemptions

| Rule | File:line | Reason | Owner | Expiry / removal condition |
| --- | --- | --- | --- | --- |
| ready/no-source-grep-test | src/__tests__/document-attachment-async-io.test.ts:19 | ipc-handler.ts registers handlers against the Electron `ipcMain` singleton on import; no electron-free seam for the saveAs / writeDocumentEditableText branches yet. | W1.1 | runtime-upgrade when ipc-handler is split into an electron-free helper module |
| ready/no-source-grep-test | src/__tests__/document-attachment-async-io.test.ts:21 | file-io-group.ts imports `electron`'s IpcMain and registers IPC handlers at module load; async fs-promises migration asserted structurally because the module cannot be loaded from node:test. | W1.1 | runtime-upgrade when file-io-group is split into an electron-free helper module |
| ready/no-source-grep-test | src/__tests__/document-attachment-async-io.test.ts:26 | file-mutation-group.ts imports `electron`'s IpcMain and registers IPC handlers at module load; async fs-promises migration on copy/move/delete/mkdir asserted structurally. | W1.1 | runtime-upgrade when file-mutation-group is split into an electron-free helper module |
| ready/no-source-grep-test | src/__tests__/document-engine-async-handlers.test.ts:9 | file-io-group.ts imports `electron`'s IpcMain and registers document:read / document:list handlers at module load; node:test cannot import the module. | W1.1 | runtime-upgrade when file-io-group is split into an electron-free helper module |
| ready/no-source-grep-test | src/__tests__/document-engine-async-handlers.test.ts:14 | parser-group.ts imports `electron`'s IpcMain and registers document:parseDocx / document:parseXlsx handlers at module load; node:test cannot import the module. | W1.1 | runtime-upgrade when parser-group is split into an electron-free helper module |
| ready/no-source-grep-test | src/__tests__/document-insight-widget-window.test.ts:112 | document-task-pipeline-executor.ts transitively imports `electron` via ../ipc-handler (readDocumentEditableText); buildDocumentPipelineInsight has no electron-free seam. | W1.1 | runtime-upgrade when pipeline executor gets an electron-free harness |
| ready/no-source-grep-test | src/__tests__/document-list-widgets-metric.test.ts:13 | document-task-pipeline.ts is reached only through the electron-coupled pipeline executor; the metrics-import shape is locked structurally until a runnable pipeline fixture exists (>50 LOC, out of W1 scope). | W1.1 | runtime-upgrade when pipeline gets an electron-free harness |
| ready/no-source-grep-test | src/__tests__/document-list-widgets-metric.test.ts:19 | document_list_widgets branch lives inside runDocumentTaskPipeline; the metric-order assertion is held structurally until a runnable harness exists. | W1.1 | runtime-upgrade when pipeline gets an electron-free harness |
| ready/no-source-grep-test | src/__tests__/document-widget-target-controlled-selection.test.ts:59 | document-task-pipeline-executor.ts transitively imports `electron` (via ../ipc-handler); the update-branch envelope widget_target consumption has no electron-free seam. | W1.1 | runtime-upgrade when pipeline executor gets an electron-free harness |
| ready/no-source-grep-test | src/__tests__/patch-target-resolution-metric.test.ts:17 | document-task-pipeline-executor.ts transitively imports `electron` via ../ipc-handler; node:test cannot load the module to verify the metrics import wiring. | W1.1 | runtime-upgrade when pipeline executor gets an electron-free harness |
| ready/no-source-grep-test | src/__tests__/patch-target-resolution-metric.test.ts:23 | writeDocumentWidget.update branch lives inside the electron-coupled pipeline executor; metric-payload shape asserted structurally. | W1.1 | runtime-upgrade when pipeline executor gets an electron-free harness |
| ready/no-source-grep-test | src/__tests__/pipeline.update.includes-existing-widget-in-prompt.test.ts:13 | collectExistingWidgetsForPrompt / serializeExistingWidgetsForPrompt / buildWidgetDraftUserPrompt are private methods on DocumentTaskPipelineExecutor (electron-coupled). | W1.1 | runtime-upgrade when pipeline executor gets an electron-free harness |
| ready/no-source-grep-test | src/__tests__/pipeline.widget-draft.cache-invalidation-on-failure.test.ts:13 | buildDocumentPipelineWidgetDraft / deleteCachedWidgetDraft are private methods on DocumentTaskPipelineExecutor (electron-coupled); the cache-invalidation contract for compose_widget's try/catch is asserted structurally. | W1.1 | runtime-upgrade when pipeline executor gets an electron-free harness |
| ready/no-source-grep-test | src/__tests__/pipeline.widget-draft.reprompts-on-schema-error.test.ts:13 | The one-retry reprompt budget + zod-validator error injection live inside DocumentTaskPipelineExecutor's private methods (electron-coupled); attempt-1/attempt-2 ordering is asserted structurally. | W1.1 | runtime-upgrade when pipeline executor gets an electron-free harness |
| ready/no-source-grep-test | src/__tests__/chat-model-switcher-contract.test.ts:8 | ModelSelector.tsx is a React component coupled to react-router-dom (useNavigate) and the Zustand useSettings store; the switcher contract (listChatSwitcherProfiles / visibleProfiles / showInChatSwitcher / "当前使用中" / "管理显示项") has no electron-free seam and no JSDOM/React harness in W1 scope. | W1.2 | runtime-upgrade when the chat switcher gains a JSDOM/React-Testing-Library harness or the switcher logic is extracted into a renderer-context-free pure helper |
| ready/no-source-grep-test | src/__tests__/executor-routes-list-and-remove-intents.test.ts:18 | document-task-pipeline-executor.ts transitively imports `electron` via ../ipc-handler; all five it() blocks here assert structural routing (intent branches, dep injection, phase-order derivation) with no electron-free seam (mirrors existing W1.1 executor ledger entries). | W1.2 | runtime-upgrade when pipeline executor gets an electron-free harness |
| ready/no-source-grep-test | src/__tests__/executor.routes-list-and-remove-intents.test.ts:15 | Only the tryExecute four-intent branch-order assertion needs the executor source; the other three it() blocks already exercise buildPipelinePhaseOrder at runtime via direct import. The structural branch-order check stays exempt until an electron-free executor seam exists. Items 11 and 12 in the W1 inventory are intentionally split (this file = runtime phase-order + 1 structural branch check; the hyphenated sibling = 5 structural routing checks), not duplicates. | W1.2 | runtime-upgrade when pipeline executor gets an electron-free harness |
| ready/no-source-grep-test | src/__tests__/rss-preview-browser-handoff-contract.test.ts:8 | PreviewBrowser.tsx is a React component with renderer-only hook/store deps (useHostedPreviewBounds, useWorkspace, react refs/effects, requestWorkbenchModeChange); the handoff contract has no electron-free seam and no JSDOM/React harness in W1 scope. | W1.2 | runtime-upgrade when the RSS preview→browser handoff gains a JSDOM/React-Testing-Library harness or the handoff call site is extracted into a renderer-context-free pure helper |

## Rule boundary updates

`boundary-update` dispositions (per W1 plan §3.0 matrix) do not silence
individual sites; instead they patch the Ready ESLint rule so the new
sanctioned code shape is allowed. The W1 ledger tracks them here for the
same audit reason: a future reader must be able to see "why the rule
boundary changed" without reverse-engineering the diff.

| Rule | Old boundary | New boundary | Reason | Owner |
| --- | --- | --- | --- | --- |
| ready/no-subagent-leak | `isBStageChildSubagentConsumer` allowlisted the four child-run bridge files at their pre-move paths under `src/main/modules/agent-control/` (skill-child-runner.ts, skill-child-sub-agent.ts, skill-child-sub-agent-close-mapping.ts, skill-child-sub-agent-factory.ts) | Allowlist updated to the post-move paths under `src/main/modules/agent-control/skills/`; the four files retain their sanctioned ability to import from `agent-control/sub-agent/`. No other file inside `skills/` is added to the allowlist. | Stage U5.1a2 commit d7897542 relocated the four bridge files into `skills/` as a [move-only] refactor. The rule's intent (only the parent→sub-agent bridge may reach into `sub-agent/`) is unchanged; only the file paths moved. Verified by `eslint-rules/__tests__/a0-rules.test.mjs` (post-move paths accepted, pre-move paths and a non-bridge `skills/skill-domain-adapter.ts` counterexample rejected). | W1.3 |

## How to add a row

1. Run `npm run lint:check` (or `npx eslint <file>`) and confirm the rule
   actually fires at the file:line you intend to silence.
2. Add the `// eslint-disable-next-line <rule-name> -- <reason>` comment
   immediately above the offending line.
3. Append a row to the table above with the rule, file:line of the
   disabled line itself (not the comment), reason, owner (the W-stage that
   added it), and removal condition.
4. Re-run `npm run lint:check` and confirm the targeted error is gone and
   no other lint errors regressed.
5. Re-run `node scripts/check-eslint-baseline.cjs` and confirm the
   corresponding `new` entry disappeared (because the rule no longer
   fires).

## How to remove a row

1. Confirm the removal condition listed in the row is satisfied (e.g.,
   the runtime seam exists, the boundary-update PR landed).
2. Delete the `// eslint-disable-next-line` comment in the test file.
3. Delete the row from the table above.
4. Re-run `npm run lint:check`; either the test must already be replaced
   by a runtime behavior test, or the rule fires again and the PR must
   reach `replace` / `delete` disposition before merging.
