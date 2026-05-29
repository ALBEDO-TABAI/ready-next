/**
 * Stage W W4.6 — `ready/no-cross-area-mutation`.
 *
 * Forbids a single consumer file from importing **action names** belonging
 * to more than one declared `useAgent` ownership area. Selector reads
 * (`useAgent((s) => s.field)`) are out of scope; only the action surface
 * is policed.
 *
 * Source of the area-action map: `docs/superpowers/audits/2026-05-22-w4-useagent-ownership-map/ownership-areas.md`.
 *
 * Rule mechanic:
 *   - For each `ImportDeclaration` whose source contains `useAgent`
 *     (e.g. `'../renderer/stores/useAgent'`), collect the imported
 *     specifier names.
 *   - Map each name to its area via `AREA_ACTIONS`. Names not in the map
 *     (selectors, types, helpers) are ignored.
 *   - If the resulting area set has more than one entry, report on the
 *     second area's first import specifier with a message naming both
 *     areas.
 *
 * File-level opt-out: a `/* eslint-disable ready/no-cross-area-mutation -- reason *\/`
 * comment placed at the very top of the file (before any imports) is the
 * documented allowed disable. Per-line disables are intentionally
 * insufficient because a later import in the same file would still cross
 * the line — see plan §3.6.
 *
 * Plan: docs/superpowers/plans/archive/2026-05-22-W4-useagent-ownership-implementation.md §3.6
 * Areas map: docs/superpowers/audits/2026-05-22-w4-useagent-ownership-map/ownership-areas.md
 */

const AREA_ACTIONS = {
  sessionSlice: new Set([
    'addMessage',
    'appendToMessage',
    'setInputValue',
    'setComposerDraft',
    'setIsStreaming',
    'setActiveSessionId',
    'createNewSession',
    'closeSession',
  ]),
  runtimeListeners: new Set([
    'initAgentListeners',
    'initAgentInteractionListeners',
  ]),
  pendingSend: new Set([
    'setSendCoalescingEnabled',
    'setSendCoalescingWindowMs',
    'loadSendPreferences',
    '__disposePendingSendCoalescingForHMR',
  ]),
  persistence: new Set([
    'loadScopes',
    'loadScope',
    'setCurrentScope',
    'sendMessageToScope',
    'loadConversations',
    'loadConversation',
    'deleteConversation',
    'newSession',
    'undoLastMessage',
    'sendMessage',
    'stopStreaming',
  ]),
  projection: new Set([
    'clearToolTrace',
    'dismissSoftError',
    'setTaskSectionExpanded',
    'toggleTaskSection',
  ]),
  selectors: new Set([
    'setAgents',
    'selectAgent',
    'toggleAgentSelection',
    'addAttachments',
    'removeAttachment',
    'clearAttachments',
    'setActiveAttachmentPreview',
    'pickFiles',
    'clearPendingContinuationIntent',
  ]),
}

function areaFor(name) {
  for (const [area, names] of Object.entries(AREA_ACTIONS)) {
    if (names.has(name)) return area
  }
  return null
}

function isUseAgentSource(specifier) {
  if (typeof specifier !== 'string') return false
  // Match relative or absolute imports targeting the useAgent module or
  // any sub-module under a future `useAgent/<area>/` extraction tree.
  return specifier.endsWith('/stores/useAgent')
    || specifier.endsWith('/stores/useAgent.ts')
    || /\/stores\/useAgent(\/|\.)/.test(specifier)
}

export function createNoCrossAreaMutationRule() {
  return {
    meta: {
      type: 'problem',
      docs: {
        description: 'disallow a single consumer file from importing action names from more than one declared useAgent ownership area',
      },
      messages: {
        crossAreaMutation:
          'cross-area mutation: file imports actions from areas {{areas}}; only one area\'s actions allowed per consumer file',
      },
      schema: [],
    },
    create(context) {
      // Per-file state: map area → first reporting node, in the order each
      // area was first seen.
      const seenAreas = new Map()

      function recordImport(node) {
        const sourceValue = node.source?.value
        if (!isUseAgentSource(sourceValue)) return
        for (const spec of node.specifiers || []) {
          if (spec.type !== 'ImportSpecifier') continue
          const importedName = spec.imported?.name
          if (!importedName) continue
          const area = areaFor(importedName)
          if (!area) continue
          if (!seenAreas.has(area)) {
            seenAreas.set(area, { node: spec, name: importedName })
          }
        }
      }

      return {
        ImportDeclaration(node) {
          recordImport(node)
        },
        'Program:exit'() {
          if (seenAreas.size <= 1) return
          const areaNames = Array.from(seenAreas.keys())
          // Report on the second-or-later area's import specifier.
          const offendingAreas = areaNames.slice(1)
          for (const area of offendingAreas) {
            const seen = seenAreas.get(area)
            context.report({
              node: seen.node,
              messageId: 'crossAreaMutation',
              data: { areas: `{${areaNames.join(', ')}}` },
            })
          }
        },
      }
    },
  }
}

export const AREA_ACTIONS_MAP = AREA_ACTIONS

export default createNoCrossAreaMutationRule
