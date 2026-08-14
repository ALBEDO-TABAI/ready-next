import type { ToolExecutionOutput } from '../agent-control/tools-runtime/tool-result-types'
import { createBrowserStructuredOutput as browserStructuredOutput, stringifyBrowserJsonOrFailure } from './browser-failure-output'
import type { BrowserActToolContext } from './browser-act-shared'
import {
  confirmLivePasswordFill,
  didBrowserActionChange,
  frameViewportOffset,
  invokeTargetFormSubmit,
  logBrowserAct,
  normalizedTargetPoint,
  readBrowserActionDeltaBestEffort,
  readTransientPageNotices,
  retainCompositeTrustedInputSequence,
  sameTargetFingerprint,
  snapshotBrowserTabs,
  submitResolvedTargetForm,
  trustedPointerExpected,
  waitForActionFollowedTab,
} from './browser-act-shared'
import { existsSync } from 'fs'
import { createHash } from 'node:crypto'
import { captureBrowserActionReceipt } from '../browser-engine/browser-action-receipt'
import { AgentRepository } from '../repositories/agent-repository'
import {
  findRecentBrowserAction,
  rememberBrowserAction,
} from '../agent-control/session/session-continuity'
import { agentBrowserError, isAgentBrowserError } from '../browser-engine/agent-browser-errors'
import { parseTargetId } from '../browser-engine/agent-browser-page-map'
import { browserSnapshotService, parseBrowserSnapshotRef } from '../browser-engine/browser-snapshot-service'
import { gateActOnTarget, type AgentBrowserAction, type AgentBrowserReadBack } from '../browser-engine/agent-browser-act'
import {
  buildBrowserBlockingChallengeProbeJs,
  buildFocusedEditableProbeJs,
  buildBrowserTargetProbeJs,
  throwIfLiveTargetGuardBlocked,
  normalizeBrowserBlockingChallengeProbe,
  probeCoordinateTargetOrThrow,
  callBrowserBackendTarget,
} from './browser-probe'
import { browserInputEnvironmentReadiness } from '../browser-engine/browser-input-readiness'
import {
  buildSmartTypeProbeJs,
  resolveCssPoint,
  runGuardedCoordinateClick,
  runGuardedCoordinateType,
  runGuardedTargetType,
  runGuardedSelectorClick,
  runGuardedSelectorType,
  sendKeyStroke,
  settleAfterAction,
  sleepWithAbort,
  throwIfAborted,
  dispatchTrustedPointer,
  dispatchTrustedText,
  pointerPhaseFailure,
  pointerPhaseOutput,
  trustedInputPageDenied,
  TrustedPointerBlockedError,
  waitForReady,
} from './browser-input-actions'
import { buildBrowserEnvironmentSummary } from '../browser-engine/browser-action-receipt'
import {
  describeComposedPointTarget,
  scanClosedShadowHostForClickPoint,
} from './browser-shadow-hit-test'
import {
  captureAgentPageMap,
  currentBrowserPageMapAmbiguity,
  DEFAULT_AGENT_PAGE_MAP_MAX_BYTES,
} from './browser-observe-tools'
import {
  activeBrowserToolUrl,
  activePageLikelyMatchesTarget,
  browserStructuredErrorOutput,
  listSubframesSafe,
  locateActionTargets,
  resolveToolContextMeta,
  uniqueStrings,
} from './browser-tool-shared'

interface ScopeAttachmentCandidate {
  attachmentId: string
  name: string
  path: string
  type: string
  size: number
  ext: string
  createdAt: string
}

async function listScopeAttachmentsForTool(sessionId?: string): Promise<ScopeAttachmentCandidate[]> {
  const scopeId = String(sessionId || '').trim()
  if (!scopeId) return []
  const repository = new AgentRepository()
  return repository
    .listConversationAttachments(scopeId)
    .then((items) => items
    .filter((item) => item.path && existsSync(item.path))
    .map((item) => ({
      attachmentId: item.attachment_id,
      name: item.name,
      path: item.path,
      type: String(item.type || 'other'),
      size: Number(item.size || 0),
      ext: String(item.ext || ''),
      createdAt: item.created_at,
    })))
}

function selectScopeAttachments(
  attachments: ScopeAttachmentCandidate[],
  args: Record<string, unknown>,
): { selected?: ScopeAttachmentCandidate[]; ambiguous?: ScopeAttachmentCandidate[]; reason?: string } {
  if (attachments.length === 0) {
    return { reason: '当前会话没有可用附件。' }
  }
  const attachmentId = String(args.attachment_id || '').trim()
  const attachmentIds = Array.isArray(args.attachment_ids)
    ? Array.from(new Set(args.attachment_ids.map((value) => String(value || '').trim()).filter(Boolean)))
    : []
  const attachmentName = String(args.attachment_name || '').trim().toLowerCase()

  if (attachmentId) {
    const match = attachments.find((item) => item.attachmentId === attachmentId)
    return match ? { selected: [match] } : { reason: `未找到附件: ${attachmentId}` }
  }

  if (attachmentIds.length > 0) {
    const byId = new Map(attachments.map((item) => [item.attachmentId, item]))
    const missing = attachmentIds.filter((id) => !byId.has(id))
    if (missing.length > 0) return { reason: `未找到附件: ${missing.join(', ')}` }
    return { selected: attachmentIds.map((id) => byId.get(id)!) }
  }

  if (attachmentName) {
    const matches = attachments.filter((item) => item.name.toLowerCase().includes(attachmentName))
    if (matches.length === 1) return { selected: matches }
    if (matches.length > 1) return { ambiguous: matches }
    return { reason: `未找到名称匹配的附件: ${attachmentName}` }
  }

  if (args.latest === true) return { selected: [attachments[0]!] }
  return { reason: '请明确指定 attachment_id、attachment_ids、attachment_name 或 latest=true。' }
}

export async function executeBrowserActUpload(
  toolName: string,
  args: Record<string, unknown>,
  ctx: BrowserActToolContext,
): Promise<string | ToolExecutionOutput> {
  const { controller, abortSignal, sessionId, mutationBoundary, attachBrowserToolOutput } = ctx
  switch (toolName) {
      case 'upload': {
        const startedAt = Date.now()
        const uploadMetaFor = (effectiveTabId: string | null) => ({
          ...resolveToolContextMeta(controller, effectiveTabId),
          latencyMs: Date.now() - startedAt,
        })
        const attachments = await listScopeAttachmentsForTool(sessionId)
        const selection = selectScopeAttachments(attachments, args)
        if (selection.reason) {
          return browserStructuredOutput({
            ok: false,
            errorCode: 'attachment_selection_failed',
            ...uploadMetaFor(null),
            reason: selection.reason,
            candidates: attachments.slice(0, 6),
          })
        }
        if (selection.ambiguous && selection.ambiguous.length > 0) {
          return browserStructuredOutput({
            ok: false,
            errorCode: 'attachment_selection_ambiguous',
            ...uploadMetaFor(null),
            reason: '存在多个候选附件，请补充 attachment_id 或 attachment_name。',
            candidates: selection.ambiguous,
          })
        }
        const selectedAttachments = selection.selected || []
        if (selectedAttachments.length === 0) {
          return browserStructuredOutput({ ok: false, errorCode: 'attachment_not_selected', ...uploadMetaFor(null), reason: '未能选择附件。' })
        }
        const missingAttachments = selectedAttachments.filter((attachment) => !existsSync(attachment.path))
        if (missingAttachments.length > 0) {
          return browserStructuredOutput({
            ok: false,
            errorCode: 'attachment_file_missing',
            ...uploadMetaFor(null),
            reason: `附件文件不存在: ${missingAttachments.map((attachment) => attachment.path).join(', ')}`,
            attachments: missingAttachments,
          })
        }

        const tabId = (args.tab_id as string) || null
        const selector = typeof args.selector === 'string' ? args.selector.trim() : ''
        const targetId = typeof args.target_id === 'string' ? args.target_id.trim() : ''
        const targets = await locateActionTargets(controller, tabId, 'upload')
        if (!selector && !targetId) {
          return browserStructuredOutput({
            ok: false,
            errorCode: 'upload_target_required',
            ...uploadMetaFor(tabId),
            attachments: selectedAttachments,
            candidates: targets.slice(0, 12),
            writesPerformed: 0,
          })
        }
        const uploadExpected = trustedPointerExpected(ctx, tabId)
        if (uploadExpected) {
          const denied = await trustedInputPageDenied(controller, tabId, uploadExpected)
          if (denied) return denied
        }
        let targetToken: string | undefined
        let frameDocumentToken: string | undefined
        let backendDOMNodeId: number | undefined
        if (targetId) {
          const resolved = await browserSnapshotService.resolveRef(controller, tabId, targetId)
          if (!resolved.ok) {
            return browserStructuredOutput({
              ok: false,
              errorCode: 'upload_target_stale',
              ...uploadMetaFor(tabId),
              targetId,
              reason: resolved.errorCode,
              writesPerformed: 0,
            })
          }
          const parsed = parseTargetId(resolved.rawTargetId)
          const target = resolved.target
          const fileInput = String(target.inputType || '').toLowerCase() === 'file'
            || (target.states && typeof target.states === 'object' && (target.states as Record<string, unknown>).fileInput === true)
          if (!parsed || !fileInput || parsed.frameId !== '0') {
            return browserStructuredOutput({
              ok: false,
              errorCode: 'upload_file_input_target_required',
              ...uploadMetaFor(tabId),
              targetId,
              target,
              writesPerformed: 0,
            })
          }
          const backendMatch = /^b(\d+)$/.exec(parsed.node)
          if (backendMatch) backendDOMNodeId = Number(backendMatch[1])
          else targetToken = parsed.node
          frameDocumentToken = resolved.frameDocumentToken
        }
        if (!frameDocumentToken && uploadExpected?.mainFrameDocumentToken) {
          frameDocumentToken = uploadExpected.mainFrameDocumentToken
        }

        const setResult = await controller.setFileInputFiles(tabId, {
          files: selectedAttachments.map((attachment) => attachment.path),
          selector: selector || undefined,
          targetToken,
          frameDocumentToken,
          backendDOMNodeId,
        })
        if (!setResult.ok) {
          mutationBoundary.recordMechanicalFact({ delivery: 'not_delivered' })
          return browserStructuredOutput({
            ok: false,
            errorCode: 'upload_target_not_found',
            ...uploadMetaFor(tabId),
            reason: '未找到可用的上传入口。',
            attachments: selectedAttachments,
            candidates: targets.slice(0, 8),
            target: setResult.targetDescription,
            evidenceIds: uniqueStrings(targets.flatMap((item) => item.evidence || [])),
            dispatch: 'rejected',
            delivery: 'not_delivered',
            mayHaveCommitted: false,
          })
        }

        const assignedNames = Array.isArray(setResult.assignedFileNames) ? setResult.assignedFileNames : []
        const expectedNames = selectedAttachments
          .map((attachment) => attachment.name.normalize('NFC'))
          .sort((left, right) => left.localeCompare(right))
        const observedNames = assignedNames
          .map((name) => String(name || '').normalize('NFC'))
          .sort((left, right) => left.localeCompare(right))
        const fileAssigned = Boolean(setResult.filesAssigned)
          && expectedNames.length === observedNames.length
          && expectedNames.every((name, index) => name === observedNames[index])
        mutationBoundary.recordMechanicalFact(fileAssigned
          ? { delivery: 'delivered', effect: 'target_value' }
          : { delivery: 'unknown' })
        const payload = {
          ok: fileAssigned,
          ...(!fileAssigned ? { errorCode: 'upload_assignment_readback_failed' } : {}),
          ...uploadMetaFor(tabId),
          attachments: selectedAttachments.map((attachment) => ({
            attachmentId: attachment.attachmentId,
            name: attachment.name,
            path: attachment.path,
          })),
          targetId: targetId || null,
          selector: selector || null,
          target: setResult.targetDescription,
          setResult: {
            filesAssigned: Boolean(setResult.filesAssigned),
            assignedFileNames: assignedNames,
          },
          verification: {
            success: fileAssigned,
            reason: fileAssigned ? 'exact_file_assignment_readback' : 'exact_file_assignment_missing',
          },
          evidenceIds: fileAssigned ? ['input_files_assigned_exact'] : [],
          dispatch: 'accepted',
          delivery: fileAssigned ? 'delivered' : 'unknown',
          effect: fileAssigned ? 'target_value' : 'unknown',
          mayHaveCommitted: true,
          needsObservation: !fileAssigned,
        }
        return stringifyBrowserJsonOrFailure(payload)
      }

    default:
      return `Unknown browser tool: ${toolName}`
  }
}
