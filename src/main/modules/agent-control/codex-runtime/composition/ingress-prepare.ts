import { productionLibraryReader } from '../library-read-production'
import { readCapturedReference } from '../captured-reference'
import { readStoredObjectPreview } from '../../../object-service/preview'
import { toReadyUri } from '../../../../../shared/ready-ref'
import { FastCardRepository } from '../../../repositories/fastcard-repository'
import { libraryTools } from '../library-read-resources'
import { ObjectPresentationService } from '../../../object-service/presentation'
import { ObjectRegistry } from '../../../object-service/registry'
import { mkdirSync, realpathSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { readActionAuthorizationModeFromEnvelope } from '../../../../../shared/action-authorization-mode'
import { isBrowserPublicToolName } from '../../../../../shared/browser-capability-registry'
import { persistableCalendarEventId } from '../../../../../shared/calendar-event-identity'
import type { SendScopedRequest, ProductTurnReceipt } from '../../../../../shared/ipc-contracts/agent-runtime'
import { getMcpCatalogSnapshot } from '../../../mcp/registry'
import { classifyIntent } from '../../intent-classifier'
import { isMapSemanticIntentActive, classifyMapSemanticIntentFallback } from '../../map-semantic-intent'
import { resolveTrustedBrowserReference } from '../../runtime-core/trusted-browser-environment'
import { PrePersistenceAdmissionError } from '../../send-scoped-confirmation'
import { readProjectDirectory, canonicalProjectDirectory, withProjectDirectorySelection, projectDirectoryContext } from '../chat-project-directory'
import { resolveReadyActionObligationSet } from '../codex-action-obligation'
import { projectCodexHeadActionProjection } from '../codex-action-surface'
import { CodexBindingRepository } from '../codex-binding-repository'
import { resolveBrowserExecutionPageRef, buildBrowserAdmissionAuthoritySnapshot } from '../codex-browser-admission'
import { resolveReadyCapabilityTurnAvailability } from '../codex-capability-turn-availability'
import { resolveExactRetryEligibility, exactRetrySourceFacts } from '../codex-exact-retry-eligibility'
import { resolveCodexExplicitResources } from '../codex-explicit-resources'
import { resolveCodexExplicitRetryLineage } from '../codex-explicit-retry-lineage'
import { parseCodexExternalReadSliceRequest, externalReadResourceReference } from '../codex-external-read-slice'
import { resolveExplicitRetryTailPlan } from '../codex-history-continuity-policy'
import { classifyCodexIngressPreparationError } from '../codex-ingress-preparation-error'
import { digestCanonicalJson, resolveCodexNativeModelSettings } from '../codex-model-gateway-contract'
import { TAG_FORGE_EXCLUSIVE_TOOL_NAMES } from '../codex-product-action-map'
import { trustedBrowserReferenceInput, trustedCalendarReferenceInput, trustedRssItemInput, trustedRssSourceInput, assertWidgetTargetsMatchAnchor, extractProductSurfaceTargets, sha256 } from '../codex-product-surface-ingress'
import { resolveCodexProductTaskFacts, createCodexProductBudgetSeed } from '../codex-product-task-facts'
import { toCodexInput, resolveCurrentDocumentActivation, buildCodexRetryAuthorizationRequest, resolveCodexProductTurnAuthorization, toRunMessage, resolveCodexRetryAuthorizationCeiling, resolveCodexThreadInstructionContract, resourceReferenceForAnchor, createCodexProductUpstreamProfileSnapshot } from '../codex-product-turn-authorization'
import { settleWorkbenchRSSSelections, RSS_READ_TOOL_NAMES, validateRSSResource } from '../codex-rss-resources'
import type { CodexIngressPort } from '../codex-runtime-composition'
import type { SameThreadContinuationCandidate } from '../codex-same-thread-continuation'
import { CodexToolSurfaceError } from '../codex-tool-surface'
import { composeCodexTurnToolSnapshot } from '../codex-tool-surface-composition'
import { digestCodexUserInput, type CodexUserInput } from '../codex-user-input'
import type { CodexCompositionBase } from './base'
import type { BeginNewContextIssuer } from './begin-new-context'
import type { HeadContinuation } from './head-continuation'
import type { resolveIngressMcpResource } from './ingress-mcp-resource'
import type { CodexCompositionLive } from './live-state'
import { activeProfile, isoNow } from './support'

export type IngressPrepareDeps = Pick<CodexCompositionBase, 'detailPrepared' | 'gate' | 'input' | 'nativeRuntime' | 'preparedDetails' | 'preparer' | 'rawDb' | 'readyMemoryRepository' | 'repository' | 'verified'>
  & Pick<BeginNewContextIssuer, 'issueBeginNewContextAction'>
  & Pick<HeadContinuation, 'resolveHeadContinuation'>
  & { readonly live: CodexCompositionLive; readonly resolveIngressMcpResource: typeof resolveIngressMcpResource }

/** Preparing product ingress: resources, tools, continuation and the exact request, before anything is persisted. */
export function createIngressPrepare(deps: IngressPrepareDeps) {
  const { live, detailPrepared, gate, input, issueBeginNewContextAction, nativeRuntime, preparedDetails, preparer, rawDb, readyMemoryRepository, repository, resolveHeadContinuation, verified } = deps
  const prepareIngress: CodexIngressPort['prepareIngress'] = async ({ scope, request, reservation }) => {
    let recoveryEvidenceResolver: (() => string | null) | null = null
    try {
      gate.assertOpen()
      const boundHost = live.host
      if (!boundHost) throw new Error('codex_runtime_host_unbound')
      if (request.expectedMessageVisibilityEpoch !== scope.messageVisibilityEpoch) {
        throw new PrePersistenceAdmissionError(
          'conversation_reset_required',
          false,
          digestCanonicalJson({
            scopeId: scope.id,
            expectedMessageVisibilityEpoch: request.expectedMessageVisibilityEpoch,
            actualMessageVisibilityEpoch: scope.messageVisibilityEpoch,
          }),
          'codex_message_visibility_epoch_mismatch',
        )
      }
      const currentInput = toCodexInput(request)
      if (!currentInput) throw new Error('codex_product_ingress_unsupported')
      const profile = activeProfile(input.settings)
      await input.providerReadiness.ensureReady(profile)
      const binding = repository.readActiveAliasBinding(scope.id)
      if (!binding) {
        throw new Error('codex_alias_generation_mismatch')
      }
      if (
        typeof request.expectedAliasGeneration === 'number'
        && request.expectedAliasGeneration > binding.aliasGeneration
      ) {
        throw new Error('codex_alias_generation_mismatch')
      }
      if (
        typeof request.expectedAliasGeneration === 'number'
        && request.expectedAliasGeneration < binding.aliasGeneration
      ) {
        const predecessor = rawDb.prepare(`
            SELECT retired_reason
              FROM codex_thread_bindings
             WHERE ready_conversation_alias = ? AND alias_generation = ?
             LIMIT 1
          `).get<{ retired_reason: string | null }>(scope.id, request.expectedAliasGeneration)
        if (!predecessor || !['publication_diverged', 'pristine_contract_refresh'].includes(predecessor.retired_reason || '')) {
          throw new Error('codex_alias_generation_mismatch')
        }
      }
      const currentHeadFacts = repository.readHeadActionFacts({
        aliasId: binding.aliasId,
        aliasGeneration: binding.aliasGeneration,
        currentRuntimeManifestDigest: verified.manifestDigest,
        currentProtocolSchemaDigest: verified.manifest.stableV2SchemaSha256,
      })
      const requestedProbeMode = request.userMessage.meta.workbenchMode
      const probeMode = requestedProbeMode === 'browser'
        || requestedProbeMode === 'document'
        || requestedProbeMode === 'rss'
        || requestedProbeMode === 'calendar'
        ? requestedProbeMode : 'browser'
      const currentHeadProjection = projectCodexHeadActionProjection({
        ...currentHeadFacts,
        headContractBlocker: resolveHeadContinuation({
          aliasId: binding.aliasId,
          aliasGeneration: binding.aliasGeneration,
          scopeEpoch: currentHeadFacts.scopeEpoch,
          workbenchMode: probeMode,
          threadBindingId: binding.threadBindingId,
          codexThreadId: binding.codexThreadId,
          materializationKind: binding.materializationKind,
        })?.reason ?? (binding.codexThreadId
          || binding.materializationKind === 'fresh_root_with_tail' ? null : undefined),
      })
      if (currentHeadProjection.actions.send_new_message.availability !== 'ready') {
        throw new PrePersistenceAdmissionError(
          currentHeadProjection.actions.send_new_message.blockers[0] === 'history_materializing'
            ? 'conversation_materializing'
            : currentHeadProjection.actions.send_new_message.blockers[0] === 'thread_busy'
              ? 'thread_busy'
              : 'conversation_reset_required',
          false,
          currentHeadProjection.evidenceDigest,
          'codex_head_action_not_ready',
        )
      }
      if (!request.explicitRetry) {
        const expectedAdmissionRef = currentHeadProjection.actionHeadIdentity && {
          headProjectionDigest: currentHeadProjection.evidenceDigest,
          actionProjectionVersion: currentHeadProjection.actionProjectionVersion,
          actionHeadIdentity: currentHeadProjection.actionHeadIdentity,
        }
        if (!request.actionAdmissionRef || !expectedAdmissionRef
          || digestCanonicalJson(request.actionAdmissionRef)
            !== digestCanonicalJson(expectedAdmissionRef)) {
          throw new PrePersistenceAdmissionError(
            'action_projection_confirmation_required',
            true,
            currentHeadProjection.evidenceDigest,
            'codex_action_admission_ref_stale',
          )
        }
      }
      if (binding.aliasGeneration !== scope.aliasGeneration) {
        throw new Error('codex_alias_generation_mismatch')
      }
      const externalReadRequest = parseCodexExternalReadSliceRequest(request.userMessage.meta)
      if (request.currentDocumentAnchor && externalReadRequest) {
        throw new Error('codex_external_read_slice_conflicts_with_current_document')
      }
      const externalReadSlice = externalReadRequest
        ? await boundHost.resolveExternalReadSlice(externalReadRequest)
        : null
      const requestedWorkbenchMode = request.userMessage.meta.workbenchMode
      const browserSelections = (request.resources ?? []).filter(
        (selection): selection is Extract<NonNullable<SendScopedRequest['resources']>[number], { kind: 'browser_tab' }> => (
          selection.kind === 'browser_tab'
        ),
      )
      if (browserSelections.length > 1) throw new Error('codex_explicit_browser_reference_ambiguous')
      const browserReference = browserSelections[0]
        ? await (boundHost.browserController
            ? resolveTrustedBrowserReference(boundHost.browserController, browserSelections[0].tabId)
            : Promise.resolve(null))
        : null
      if (browserSelections[0] && !browserReference) {
        throw new Error('codex_explicit_browser_reference_unavailable')
      }
      const hostEnvironment = await boundHost.runtime.resolveTrustedRequestEnvironment(
        requestedWorkbenchMode === 'browser'
          || requestedWorkbenchMode === 'document'
          || requestedWorkbenchMode === 'rss'
          || requestedWorkbenchMode === 'calendar'
          ? { workbenchMode: requestedWorkbenchMode }
          : undefined,
      )
      const activeWorkbenchMode = requestedWorkbenchMode === 'browser'
        || requestedWorkbenchMode === 'document'
        || requestedWorkbenchMode === 'rss'
        || requestedWorkbenchMode === 'calendar'
        ? requestedWorkbenchMode
        : hostEnvironment.workbenchMode
      if (!activeWorkbenchMode) throw new Error('codex_trusted_workbench_mode_missing')
      const executionPageRef = resolveBrowserExecutionPageRef(buildBrowserAdmissionAuthoritySnapshot({
        authorityId: `browser-exec:${request.requestId}`,
        activeWorkbenchMode,
        currentBrowserPageRef: activeWorkbenchMode === 'browser'
          ? hostEnvironment.browserPageRef || null
          : null,
        explicitBrowserReadRefs: browserReference?.environment.browserPageRef
          ? [browserReference.environment.browserPageRef]
          : [],
      }))
      const trustedEnvironment = {
        ...(activeWorkbenchMode ? { workbenchMode: activeWorkbenchMode } : {}),
        ...(executionPageRef ? { browserPageRef: executionPageRef } : {}),
      }
      const resolvedBrowserInput = trustedBrowserReferenceInput(browserReference)
      let retryPredecessor: ReturnType<CodexBindingRepository['readProductTurnRuntime']> | null = null
      let retryPredecessorReceipt: ProductTurnReceipt | null = null
      let retryTaskContext: ReturnType<CodexBindingRepository['readProductTurnRuntime']> | null = null
      let retryCapabilityCeilingValid = false
      if (request.explicitRetry) {
        const lineage = resolveCodexExplicitRetryLineage({
          repository,
          requestedRunId: request.explicitRetry.predecessorRunId,
          requestedPresentationDigest: request.explicitRetry.predecessorPresentationDigest,
          readyScopeId: scope.id,
        })
        retryTaskContext = lineage.taskContext
        retryPredecessor = lineage.predecessor
        retryPredecessorReceipt = lineage.predecessorReceipt
        const lineageProjection = lineage.predecessorReceipt.actionProjection
        if (lineageProjection.retryEvidenceKind !== 'complete'
          || lineageProjection.headProjectionRef.digest !== currentHeadProjection.evidenceDigest
          || digestCanonicalJson(lineageProjection.headProjectionRef.version)
            !== digestCanonicalJson(currentHeadProjection.actionProjectionVersion)) {
          throw new PrePersistenceAdmissionError(
            'conversation_reset_required',
            false,
            currentHeadProjection.evidenceDigest,
            'codex_explicit_retry_head_projection_stale',
          )
        }
        const sourceMode = lineage.taskContext.prepared.sourceTrustedEnvironmentRef.workbenchMode
        if (sourceMode !== activeWorkbenchMode
          || (sourceMode !== 'browser' && sourceMode !== 'document')
          || executionPageRef !== null
          || browserReference !== null
          || externalReadSlice !== null) {
          throw new PrePersistenceAdmissionError(
            'explicit_retry_control_invalid', false,
            digestCanonicalJson({
              readyRunId: lineage.predecessor.readyRunId,
              sourceMode,
              activeWorkbenchMode,
              currentEnvironmentEmpty: false,
            }),
            'codex_explicit_retry_current_environment_requires_restatement',
          )
        }
      }
      const projectDirectory = readProjectDirectory(scope)
      if (projectDirectory) canonicalProjectDirectory(projectDirectory)
      const currentDocument = resolveCurrentDocumentActivation({
        resources: request.resources ?? [],
        anchor: request.currentDocumentAnchor ?? null,
        intentText: request.explicitRetry && retryTaskContext
          ? retryTaskContext.prepared.ingress.canonicalCurrentInputRef.input
              .filter((item): item is Extract<CodexUserInput, { type: 'text' }> => item.type === 'text')
              .map((item) => item.text)
              .join('\n')
          : request.userMessage.content,
        ambient: !request.explicitRetry,
      })
      const requestSelections = (request.resources ?? []).filter((resource) => (
        !currentDocument.documentFileIds.has(resource.id)
      ))
      const settledRSS = scope.sourceKind === 'local'
        ? settleWorkbenchRSSSelections({
          store: input.database.rss,
          selections: requestSelections,
          threadCanReadRSS: !binding.toolSurface
            || RSS_READ_TOOL_NAMES.every((name) => binding.toolSurface!.toolNames.includes(name)),
        })
        : { selections: requestSelections, explicitBlocked: false }
      if (settledRSS.explicitBlocked) {
        throw new PrePersistenceAdmissionError(
          'native_tool_surface_extension_required',
          false,
          digestCanonicalJson({ scopeId: scope.id, requestId: request.requestId, missing: 'rss_read_tools' }),
          'rss_read_tool_surface_missing',
        )
      }
      const currentResourceSelections = withProjectDirectorySelection(settledRSS.selections, projectDirectory)
      const explicitResources = await resolveCodexExplicitResources({
        resolveReadyReference: async selection => {
          if (scope.sourceKind !== 'local') throw new Error('引用只允许在本地对话中选入')
          if (selection.ref.kind === 'web') {
            const preview = await readStoredObjectPreview(new ObjectRegistry(rawDb), selection.ref)
            if (preview?.kind !== 'web') throw new Error('网页引用不可用')
            const text = JSON.stringify(preview)
            return { name: preview.title, text, path: toReadyUri(selection.ref), digest: sha256(text) }
          }
          return readCapturedReference(selection.ref, {
            cards: () => new FastCardRepository(rawDb).list(),
            conversation: id => {
              if (!input.database.chat.getConversationScope(id)) throw new Error('对话已不存在或不可见')
              return input.database.chat.getChatMessages(id).map(row => ({ id: row.id, role: row.role, content: row.content, meta: JSON.parse(row.meta_json || '{}') }))
            },
          })
        },
        resolveLocalObject: path => new ObjectPresentationService(new ObjectRegistry(rawDb)).resolve(path),
        selections: currentResourceSelections,
        resolveLibrary: async selection => {
          if (scope.sourceKind !== 'local') throw new Error('library_resource_unavailable')
          return (await productionLibraryReader(input.database)).admit(selection)
        },
        resolveSkill: (selection) => {
          const resolved = boundHost.resolveNativeSkillInput?.({
            skillId: selection.skillId,
            path: selection.path,
          })
          return resolved ? { name: resolved.name, path: resolved.path } : null
        },
        resolveBrowser: async (selection) => (
          browserSelections[0]?.id === selection.id ? resolvedBrowserInput : null
        ),
        resolveCalendar: (selection) => {
          const event = input.database.calendar.getCalendarEventReference(selection.eventId)
          return event ? trustedCalendarReferenceInput(event) : null
        },
        resolveRssReference: (resource) => scope.sourceKind === 'local' ? validateRSSResource(input.database.rss, resource) : null,
        resolveRssItem: (selection) => {
          const item = input.database.rss.getRSSItemsByIds([selection.itemId])[0]
          return item ? trustedRssItemInput(item) : null
        },
        resolveRssSource: (selection) => {
          const source = input.database.rss.getRSSSources().find((candidate) => candidate.id === selection.sourceId)
          return source ? trustedRssSourceInput(source) : null
        },
        resolveMcpResource: deps.resolveIngressMcpResource,
      })
      const turnResources = explicitResources
      assertWidgetTargetsMatchAnchor(request.resources ?? [], request.currentDocumentAnchor ?? null)
      const currentDocumentAnchor = currentDocument.anchor
      const currentDocumentWriteIntent = currentDocument.canWrite
      const hasFolderExportDestination = turnResources.requestResources.some((resource) => (
        resource.kind === 'folder_reference'
      ))
      let authorizationRequest = request
      if (request.explicitRetry && retryTaskContext) {
        try {
          authorizationRequest = buildCodexRetryAuthorizationRequest(
            request,
            retryTaskContext.prepared.ingress.canonicalCurrentInputRef.input,
          )
        } catch {
          throw new PrePersistenceAdmissionError(
            'explicit_retry_control_invalid', false,
            digestCanonicalJson({ readyRunId: retryTaskContext.readyRunId, reason: 'nontext_task_root' }),
            'codex_explicit_retry_task_root_requires_restatement',
          )
        }
      }
      const { requestEnvelope, authorization } = resolveCodexProductTurnAuthorization({
        mode: request.explicitRetry ? 'observe' : 'commit',
        host: boundHost,
        request: authorizationRequest,
        scopeId: scope.id,
        externalReadSlice,
        trustedEnvironment,
        trustedResources: turnResources.requestResources,
        currentDocumentCanWrite: currentDocumentWriteIntent,
        currentDocumentCanRead: Boolean(currentDocumentAnchor),
      })
      if (request.explicitRetry && authorization.mode === 'selected') {
        throw new PrePersistenceAdmissionError(
          'explicit_retry_control_invalid', false,
          digestCanonicalJson({
            readyRunId: retryTaskContext?.readyRunId,
            skillId: authorization.skillId,
          }),
          'codex_explicit_retry_current_skill_requires_restatement',
        )
      }
      const intentClassification = classifyIntent(requestEnvelope)
      const hasMapRouteIntent = isMapSemanticIntentActive(
        classifyMapSemanticIntentFallback(requestEnvelope.primaryInstruction),
      )
      const readyMemorySnapshot = readyMemoryRepository.buildSnapshot(isoNow())
      let resolvedToolSnapshot
      try {
        resolvedToolSnapshot = boundHost.resolveToolTurnSnapshot({
          surfaceId: `codex-surface:${scope.id}:${request.requestId}`,
          authorizationId: `codex-auth:${request.requestId}`,
          authorization,
          message: toRunMessage(request),
          sessionId: scope.id,
          scopeId: scope.id,
          config: profile.config,
          requestEnvelope,
          frozenToolSurface: binding.toolSurface || undefined,
        })
      } catch (error) {
        if (error instanceof CodexToolSurfaceError
          && error.compatibility
          && error.compatibility.kind !== 'compatible') {
          throw new PrePersistenceAdmissionError(
            error.compatibility.kind,
            false,
            error.compatibility.evidenceDigest,
            error.code,
          )
        }
        throw error
      }
      const explicitAllowedToolNames = [...new Set(
        turnResources.authorities.flatMap((authority) => authority.allowedToolNames),
      )]
      const exclusiveAllowSet = authorization.mode === 'selected' && authorization.skillId === 'tag-forge'
        ? TAG_FORGE_EXCLUSIVE_TOOL_NAMES
        : null
      const browserAdmission = buildBrowserAdmissionAuthoritySnapshot({
        authorityId: `browser-auth:${request.requestId}`,
        activeWorkbenchMode,
        currentBrowserPageRef: activeWorkbenchMode === 'browser'
          ? hostEnvironment.browserPageRef || null
          : null,
        explicitBrowserReadRefs: browserReference?.environment.browserPageRef
          ? [browserReference.environment.browserPageRef]
          : [],
        selectedSkillToolNames: authorization.mode === 'selected'
          ? [...authorization.allowedTypedActions, ...authorization.allowedPrimitives]
          : [],
        hasExplicitAttachment: turnResources.requestResources.some((resource) => resource.kind === 'attachment'),
        hasWritableRoot: turnResources.requestResources.some((resource) => (
          resource.kind === 'folder_reference' && resource.canWrite
        )),
        tagForgeExclusive: exclusiveAllowSet !== null,
      })
      const composeCurrentToolSnapshot = (
        resolved: typeof resolvedToolSnapshot,
        memory: typeof readyMemorySnapshot,
      ) => {
        const surfaceNames = new Set(resolved.readyToolSurface.toolNames)
        const capabilityAvailability = resolveReadyCapabilityTurnAvailability({
          publicResearchProviderAvailable: surfaceNames.has('web_search') || surfaceNames.has('web_fetch'),
          calendarHostAvailable: surfaceNames.has('calendar_list_window')
            || surfaceNames.has('calendar_capture_session')
            || surfaceNames.has('calendar_create_event'),
          calendarProductMapped: surfaceNames.has('calendar_create_event'),
          workbenchMode: trustedEnvironment.workbenchMode,
          currentBrowserPageRef: browserAdmission.currentBrowserRoot,
          explicitBrowserReadRefs: browserAdmission.explicitBrowserReadRefs,
          hasCalendarResource: turnResources.requestResources.some((resource) => (
            resource.kind === 'calendar_window' || resource.kind === 'calendar_event'
          )),
          tagForgeExclusive: exclusiveAllowSet !== null,
        })
        const mapRouteMode = hasMapRouteIntent
          ? resolved.readyTurnToolAuthorization.allowedToolNames.includes('map_plan_route')
            ? 'configured_primary' as const
            : 'public_web_fallback' as const
          : null
        return composeCodexTurnToolSnapshot({
          resolved,
          authorizationId: `codex-auth:${request.requestId}`,
          authorization,
          currentDocument: currentDocumentAnchor
            ? { present: true, allowWrite: currentDocumentWriteIntent }
            : undefined,
          folderExport: {
            present: hasFolderExportDestination,
            allowWrite: hasFolderExportDestination,
          },
          externalReadAllowedToolNames: externalReadSlice?.allowedToolNames,
          explicitResourceAllowedToolNames: explicitAllowedToolNames,
          hasRSSResource: turnResources.rssReferences.length > 0,
          libraryReadTools: turnResources.libraryResources.flatMap(grant => libraryTools(grant.selection)),
          workbenchMode: trustedEnvironment.workbenchMode,
          exclusiveAllowSet,
          browserAdmission,
          capabilityAvailability,
          mapRouteMode,
          readyMemory: {
            enabled: memory.enabled,
            hasEntries: memory.entries.length > 0,
          },
        })
      }
      let toolSnapshot = composeCurrentToolSnapshot(resolvedToolSnapshot, readyMemorySnapshot)
      if (request.explicitRetry && retryTaskContext) {
        const ceiling = resolveCodexRetryAuthorizationCeiling({
          source: retryTaskContext.prepared,
          current: toolSnapshot,
          currentSkillAuthorization: authorization,
        })
        if (!ceiling.ok) {
          throw new PrePersistenceAdmissionError(
            ceiling.code === 'tool_surface_requires_restatement'
              ? 'conversation_reset_required' : 'explicit_retry_control_invalid',
            false,
            digestCanonicalJson({ readyRunId: retryTaskContext.readyRunId, code: ceiling.code }),
            `codex_explicit_retry_${ceiling.code}`,
          )
        }
        toolSnapshot = ceiling.snapshot
        retryCapabilityCeilingValid = true
      }
      const selectedSkill = toolSnapshot.readyTurnToolAuthorization.skillAuthorization
      const selectedNativeSkill = selectedSkill.mode === 'selected'
        ? boundHost.resolveNativeSkillInput?.({
            skillId: selectedSkill.skillId,
            authorizedToolNames: [
              ...selectedSkill.allowedTypedActions,
              ...selectedSkill.allowedPrimitives,
            ],
          }) ?? null
        : null
      if (selectedSkill.mode === 'selected' && !selectedNativeSkill) {
        throw new Error('codex_selected_skill_unavailable')
      }
      const productSurfaceTargets = extractProductSurfaceTargets(request.resources ?? [])
      const actionObligations = resolveReadyActionObligationSet({
        intent: intentClassification,
        allowedToolNames: toolSnapshot.readyTurnToolAuthorization.allowedToolNames,
        productSurfaceTargets,
        primaryInstruction: requestEnvelope.primaryInstruction,
      })
      const mcpCatalog = getMcpCatalogSnapshot()
      const productTaskInput = {
        skillAuthorization: selectedSkill.mode === 'selected'
          ? {
              mode: 'selected' as const,
              completionProfile: selectedNativeSkill!.completionProfile,
            }
          : { mode: 'none' as const },
        intentClassification,
        hasFolderExportDestination,
        hasActionObligations: actionObligations.requirements.length > 0,
        hasBrowserToolSurface: Boolean(
          executionPageRef
          && toolSnapshot.readyTurnToolAuthorization.allowedToolNames.some(
            isBrowserPublicToolName,
          ),
        ),
      }
      const productTaskFacts = resolveCodexProductTaskFacts(productTaskInput)
      const selectedSkillResources = selectedNativeSkill
        ? await resolveCodexExplicitResources({
            selections: [],
            resolveSkill: () => null,
            selectedSkill: {
              name: selectedNativeSkill.name,
              path: selectedNativeSkill.path,
            },
          })
        : null
      const instructionContract = resolveCodexThreadInstructionContract({
        assetRoot: verified.assetRoot,
        host: boundHost,
        skillAuthorization: selectedSkill,
      })
      const resourceReferences = [
        ...(currentDocumentAnchor ? [resourceReferenceForAnchor(currentDocumentAnchor)] : []),
        ...(externalReadSlice ? [externalReadResourceReference(externalReadSlice)] : []),
        ...turnResources.resourceRefs,
        ...(selectedSkillResources?.resourceRefs ?? []),
      ].filter((reference, index, all) => all.findIndex(
        (candidate) => candidate.logicalResourceId === reference.logicalResourceId,
      ) === index)
      const explicitResourceInput = [
        ...(scope.sourceKind === 'local' && 'projectDirectory' in scope.meta
          ? [{ type: 'text' as const, text: projectDirectoryContext(projectDirectory), text_elements: [] as [] }]
          : []),
        ...turnResources.input,
        ...(selectedSkillResources?.input ?? []),
      ].filter((entry, index, all) => all.findIndex((candidate) => (
        digestCanonicalJson(candidate) === digestCanonicalJson(entry)
      )) === index)
      const uncommittedUserTail = repository.readLiveUncommittedUserTail(
        binding.threadBindingId,
      )
      let explicitRetry: {
        predecessorRunId: string
        predecessorPresentationRef: {
          readyRunId: string
          presentationDigest: string
        }
        controlAuditMessageRef: {
          messageId: string
          inputDigest: string
        }
        modelVisibleRootOriginRef: {
          sourceReadyRunId: string
          sourceIngressContractDigest: string
          originUserMessageId: string
          inputDigest: string
        }
        selectedHistorySeedItemRef: {
          threadBindingId: string
          historySeedDigest: string
          originUserMessageId: string
          inputDigest: string
        }
        currentTrustedEnvironmentRef: {
          requestedWorkbenchMode: 'browser' | 'document' | 'rss' | 'calendar'
          trustedWorkbenchMode: 'browser' | 'document' | 'rss' | 'calendar'
          modeDigest: string
        }
        sourceTrustedEnvironmentRef: {
          workbenchMode: 'browser' | 'document' | 'rss' | 'calendar'
          environmentDigest: string
        }
        historyParityEvidenceDigest: string
        currentThreadReadEvidenceDigest: string
        continuationContractDigest: string
        taskRootInput: CodexUserInput[]
        taskRootInputDigest: string
        artifactSources: []
      } | undefined
      if (request.explicitRetry) {
        const predecessorReceipt = retryPredecessorReceipt as ProductTurnReceipt
        const predecessor = retryPredecessor as ReturnType<CodexBindingRepository['readProductTurnRuntime']>
        const threadRead = binding.codexThreadId
          ? await nativeRuntime.threadRead({ threadId: binding.codexThreadId, includeTurns: true })
          : null
        const currentThreadReadEvidenceDigest = digestCanonicalJson({
          contract: 'codex_explicit_retry_thread_read_v1',
          aliasId: scope.id,
          aliasGeneration: binding.aliasGeneration,
          codexThreadId: binding.codexThreadId,
          threadRead,
        })
        const predecessorTurnPresent = !binding.codexThreadId
          || predecessor.codexThreadId !== binding.codexThreadId
          || !predecessor.codexTurnId
          || Boolean(threadRead?.thread.turns.some((turn) => turn.id === predecessor.codexTurnId))
        if (!predecessorTurnPresent) throw new Error('codex_explicit_retry_history_parity_failed')
        const historyParityEvidenceDigest = digestCanonicalJson({
          contract: 'codex_explicit_retry_history_parity_v1',
          predecessorPresentationDigest: predecessorReceipt.presentationDigest,
          predecessorProductTerminalDigest: repository.readProductCloseout(
            predecessor.readyRunId,
          )?.productTerminalDigest,
          predecessorTurnPresent,
        })
        const taskRootInput = retryTaskContext!.prepared.ingress.canonicalCurrentInputRef.input
        const taskRootInputDigest = digestCodexUserInput(taskRootInput)
        const tailPlan = resolveExplicitRetryTailPlan(uncommittedUserTail, {
          originUserMessageId: retryTaskContext!.prepared.ingress.canonicalCurrentInputRef.messageId,
          inputDigest: taskRootInputDigest,
        })
        if (tailPlan.kind !== 'eligible' || !binding.historySeedDigest) {
          throw new Error('codex_explicit_retry_selected_seed_missing')
        }
        const selectedSeed = tailPlan.selected
        const predecessorPresentationRef = {
          readyRunId: predecessor.readyRunId,
          presentationDigest: predecessorReceipt.presentationDigest,
        }
        const controlAuditMessageRef = {
          messageId: request.userMessage.id,
          inputDigest: digestCodexUserInput(currentInput),
        }
        const modelVisibleRootOriginRef = {
          sourceReadyRunId: retryTaskContext!.readyRunId,
          sourceIngressContractDigest: digestCanonicalJson(retryTaskContext!.prepared),
          originUserMessageId: retryTaskContext!.prepared.ingress.canonicalCurrentInputRef.messageId,
          inputDigest: taskRootInputDigest,
        }
        const selectedHistorySeedItemRef = {
          threadBindingId: binding.threadBindingId,
          historySeedDigest: binding.historySeedDigest,
          originUserMessageId: selectedSeed.originUserMessageId,
          inputDigest: selectedSeed.inputDigest,
        }
        const currentTrustedEnvironmentRef = {
          requestedWorkbenchMode: activeWorkbenchMode,
          trustedWorkbenchMode: trustedEnvironment.workbenchMode || activeWorkbenchMode,
          modeDigest: digestCanonicalJson({
            requestedWorkbenchMode: activeWorkbenchMode,
            trustedWorkbenchMode: trustedEnvironment.workbenchMode || activeWorkbenchMode,
          }),
        }
        explicitRetry = {
          predecessorRunId: predecessor.readyRunId,
          predecessorPresentationRef,
          controlAuditMessageRef,
          modelVisibleRootOriginRef,
          selectedHistorySeedItemRef,
          currentTrustedEnvironmentRef,
          sourceTrustedEnvironmentRef: retryTaskContext!.prepared.sourceTrustedEnvironmentRef,
          historyParityEvidenceDigest,
          currentThreadReadEvidenceDigest,
          taskRootInput,
          taskRootInputDigest,
          artifactSources: [],
          continuationContractDigest: digestCanonicalJson({
            contract: 'codex_explicit_retry_continuation_v1',
            predecessorRunId: predecessor.readyRunId,
            predecessorPresentationDigest: predecessorReceipt.presentationDigest,
            currentUserMessageId: request.userMessage.id,
            currentInputDigest: digestCanonicalJson(currentInput),
            taskRootInputDigest,
            resourceReferences,
            predecessorPresentationRef,
            controlAuditMessageRef,
            modelVisibleRootOriginRef,
            selectedHistorySeedItemRef,
            currentTrustedEnvironmentRef,
          }),
        }
      }
      const retryTailPlan = explicitRetry
        ? resolveExplicitRetryTailPlan(uncommittedUserTail, explicitRetry.selectedHistorySeedItemRef)
        : null
      if (retryTailPlan?.kind === 'ineligible') throw new Error('codex_explicit_retry_selected_seed_missing')
      const uncommittedTailAssignments = retryTailPlan?.kind === 'eligible'
        ? retryTailPlan.assignments
        : uncommittedUserTail.map((item) => ({
        originUserMessageId: item.originUserMessageId,
        inputDigest: item.inputDigest,
        plan: item.policy === 'untrusted_text_history'
            ? 'deliver_untrusted_history' as const
            : 'omit_from_current_run' as const,
      }))
      const supersededUncommittedItems = request.explicitRetry
        ? []
        : uncommittedUserTail.flatMap((item) => item.policy === 'untrusted_text_history'
            ? []
            : [{
                originUserMessageId: item.originUserMessageId,
                inputDigest: item.inputDigest,
                policy: item.policy,
              }])
      if (request.explicitRetry) {
        const terminal = repository.readTerminalCloseoutEvidence(
          retryPredecessor!.readyRunId,
        )
        if (!terminal) throw new Error('codex_explicit_retry_terminal_facts_missing')
        const source = retryTaskContext!.prepared
        const currentResourceEmpty = explicitResourceInput.length === 0
          && resourceReferences.length === 0
          && !currentDocumentAnchor
          && !executionPageRef
          && !externalReadSlice
          && turnResources.authorities.length === 0
          && !productSurfaceTargets
          && actionObligations.requirements.length === 0
        const retryContext = repository.readProductTurnActionContext(retryPredecessor!.readyRunId)
        if (!retryContext) throw new Error('codex_explicit_retry_context_missing')
        const eligibility = resolveExactRetryEligibility({
          phase: 'pre_persistence',
          sourceRootCompacted: retryContext.sourceRootCompacted,
          historyKind: terminal.terminalFacts.history.kind,
          effectState: terminal.terminalFacts.effect.state,
          toolCount: retryPredecessorReceipt!.tools.length,
          interactionCount: 0,
          ...exactRetrySourceFacts(source),
          currentMode: activeWorkbenchMode,
          trustedCurrentMode: trustedEnvironment.workbenchMode || activeWorkbenchMode,
          historyMaterialized: binding.materializationState === 'confirmed'
            && (binding.materializationKind === 'native_fork'
              || binding.materializationKind === 'fresh_root_with_tail')
            && Boolean(binding.historySeedDigest),
          currentSourceEligible: retryPredecessorReceipt!.actionProjection.retry_failed_task.availability === 'ready',
          currentFacts: {
            resourceEmpty: currentResourceEmpty,
            skillAndExecutionCeilingValid: retryCapabilityCeilingValid,
            memoryPayloadEmpty: !readyMemorySnapshot.enabled || readyMemorySnapshot.entries.length === 0,
            selectedSeedCount: uncommittedTailAssignments.filter((item) => item.plan === 'replace_with_explicit_retry').length,
          },
        })
        if (eligibility.availability !== 'ready') {
          throw new PrePersistenceAdmissionError(
            'explicit_retry_control_invalid',
            false,
            digestCanonicalJson(eligibility),
            `codex_explicit_retry_${eligibility.blockers[0] || 'not_available'}`,
          )
        }
      }
      const preparedResult = preparer.prepare({
        taskId: `codex-task-${sha256(request.requestId).slice(0, 24)}`,
        runId: request.requestId,
        requestId: request.requestId,
        scopeId: scope.id,
        aliasId: scope.id,
        aliasGeneration: binding.aliasGeneration,
        taskOrigin: 'user_root',
        runOrigin: 'initial',
        originUserMessageId: request.userMessage.id,
        reservationSetId: reservation.reservationSetId,
        reservationEvidenceDigest: reservation.reservationEvidenceDigest,
        currentInput,
        explicitResourceEnvelope: { input: explicitResourceInput, resourceRefs: resourceReferences },
        resourceAdditionalContext: resourceReferences,
        trustedWorkbenchMode: activeWorkbenchMode,
        currentDocumentAnchor,
        ...(currentDocumentAnchor && !currentDocument.readRequired ? { currentDocumentAmbient: true as const } : {}),
        ...(uncommittedUserTail.length > 0 ? { uncommittedUserTail } : {}),
        ...(!request.explicitRetry ? { actionAdmissionRef: request.actionAdmissionRef } : {}),
        uncommittedTailAssignments,
        supersededUncommittedItems,
        externalReadSlice,
        resourceAuthorities: turnResources.authorities,
        rssReferences: turnResources.rssReferences,
        libraryResources: turnResources.libraryResources,
        ...(executionPageRef
          ? { browserPageRef: executionPageRef }
          : {}),
        productSurfaceTargets,
        actionObligations,
        mcpCatalog,
        actionAuthorizationMode: readActionAuthorizationModeFromEnvelope(requestEnvelope),
        readyMemorySnapshot,
        readyToolSurface: toolSnapshot.readyToolSurface,
        readyTurnToolAuthorization: toolSnapshot.readyTurnToolAuthorization,
        authorizationOwnerId: scope.activeAgentId || scope.agent,
        resourceOwnerId: scope.activeAgentId || scope.agent,
        productBudgetSeed: createCodexProductBudgetSeed(productTaskInput),
        ...(explicitRetry ? { explicitRetry } : {}),
      })
      if (!preparedResult.ok) throw new Error(preparedResult.code)
      const upstream = createCodexProductUpstreamProfileSnapshot({
        profileId: profile.profileId,
        config: profile.config,
      })
      const threadBindingId = binding.threadBindingId
      if (!live.state) throw new Error('codex_runtime_state_unavailable')
      const requestedThreadCwd = binding.isolatedThreadCwd || join(live.state.threadCwdRoot, threadBindingId)
      mkdirSync(requestedThreadCwd, { recursive: true, mode: 0o700 })
      const isolatedThreadCwd = binding.isolatedThreadCwd || realpathSync(requestedThreadCwd)
      const continuationRequired = Boolean(binding.codexThreadId
        || (binding.materializationKind === 'fresh_root_with_tail'
          && repository.freshRootRequiresReseed(binding.threadBindingId)))
      const resolveCurrentContinuationCandidate = (): SameThreadContinuationCandidate | null => {
        if (!continuationRequired) return null
        const currentProfile = activeProfile(input.settings)
        const currentUpstream = createCodexProductUpstreamProfileSnapshot(currentProfile)
        const currentResolved = boundHost.resolveToolTurnSnapshot({
          surfaceId: `codex-surface:${scope.id}:${request.requestId}`,
          authorizationId: `codex-auth:${request.requestId}`,
          authorization,
          message: toRunMessage(request),
          sessionId: scope.id,
          scopeId: scope.id,
          config: currentProfile.config,
          requestEnvelope,
          frozenToolSurface: binding.toolSurface || undefined,
        })
        let currentTools = composeCurrentToolSnapshot(
          currentResolved,
          readyMemoryRepository.buildSnapshot(isoNow()),
        )
        if (request.explicitRetry && retryTaskContext) {
          const ceiling = resolveCodexRetryAuthorizationCeiling({
            source: retryTaskContext.prepared,
            current: currentTools,
            currentSkillAuthorization: authorization,
          })
          if (!ceiling.ok) throw new Error(`codex_explicit_retry_${ceiling.code}`)
          currentTools = ceiling.snapshot
        }
        const currentInstruction = resolveCodexThreadInstructionContract({
          assetRoot: verified.assetRoot,
          host: boundHost,
          skillAuthorization: currentTools.readyTurnToolAuthorization.skillAuthorization,
        })
        return {
          model: 'ready-e0-model',
          threadConfig: resolveCodexNativeModelSettings(currentUpstream.snapshot).threadConfig,
          isolatedThreadCwd,
          cwdAvailable: existsSync(isolatedThreadCwd),
          instructionContractDigest: currentInstruction.instructionContractDigest,
          currentToolSurface: currentTools.readyToolSurface,
        }
      }
      const resolveCurrentContinuation = () => {
        const candidate = resolveCurrentContinuationCandidate()
        if (!candidate) return null
        // The ingress snapshot predates native start and tail coverage.
        // Use the repository's current delivery obligation on every readback.
        const decision = repository.freshRootRequiresReseed(binding.threadBindingId)
          ? repository.resolveFreshRootInheritance({
              threadBindingId: binding.threadBindingId,
              candidate,
            })
          : repository.resolveSameThreadContinuation({
              aliasId: binding.aliasId,
              aliasGeneration: binding.aliasGeneration,
              candidate,
            })
        return { candidate, decision }
      }
      const resolveRecoveryEvidence = (): string | null => {
        try {
          const current = resolveCurrentContinuation()
          return current?.decision.kind === 'requires_new_context'
            ? current.decision.evidenceDigest
            : null
        } catch (error) {
          // silent-catch: only a tool-surface incompatibility carries recovery evidence; any other readback failure yields none
          return error instanceof CodexToolSurfaceError
            && error.compatibility
            && error.compatibility.kind !== 'compatible'
            ? error.compatibility.evidenceDigest
            : null
        }
      }
      let currentContinuation: ReturnType<typeof resolveCurrentContinuation>
      try {
        currentContinuation = resolveCurrentContinuation()
      } catch (error) {
        if (!(error instanceof CodexToolSurfaceError)
          || !error.compatibility
          || error.compatibility.kind === 'compatible') throw error
        recoveryEvidenceResolver = resolveRecoveryEvidence
        throw new PrePersistenceAdmissionError(
          error.compatibility.kind,
          false,
          error.compatibility.evidenceDigest,
          error.code,
        )
      }
      const continuationCandidate = currentContinuation?.candidate ?? null
      if (currentContinuation?.decision.kind === 'requires_new_context') {
        const reason = currentContinuation.decision.reason ?? 'host_unavailable'
        recoveryEvidenceResolver = resolveRecoveryEvidence
          throw new PrePersistenceAdmissionError(
            reason,
            reason === 'host_unavailable',
            currentContinuation.decision.evidenceDigest,
            currentContinuation.decision.reason || 'host_unavailable',
          )
      }
      const turnContractDigest = digestCanonicalJson({
        runId: preparedResult.prepared.runId,
        requestId: request.requestId,
        toolSurfaceDigest: toolSnapshot.readyToolSurface.toolSurfaceDigest,
        authorizationDigest: toolSnapshot.readyTurnToolAuthorization.authorizationDigest,
        resourceAnchorDigest: preparedResult.prepared.resourceAnchorDigest,
        readyMemorySnapshotDigest: readyMemorySnapshot.snapshotDigest,
        actionObligationDigest: actionObligations.digest,
        mcpCatalogDigest: mcpCatalog.digest,
        ...(preparedResult.prepared.outputContract
          ? { outputContract: preparedResult.prepared.outputContract }
          : {}),
        ...(externalReadSlice ? {
          methodConstraintDigest: externalReadSlice.methodConstraintDigest,
          dependencySnapshotDigest: externalReadSlice.dependencySnapshotDigest,
        } : {}),
      })
      preparedDetails.set(preparedResult.prepared.runId, {
        projectDirectory,
        preparedAtMs: Date.now(),
        executionBinding: await boundHost.createInitialExecutionBinding({
          runId: preparedResult.prepared.runId,
          ownerAgentIdAtStart: scope.activeAgentId || scope.agent,
        }),
        threadBindingId,
        isolatedThreadCwd,
        turnRequestId: request.requestId,
        upstream,
        developerInstructions: instructionContract.developerInstructions,
        instructionContractDigest: instructionContract.instructionContractDigest,
        continuationCandidate,
        resolveCurrentContinuation,
        turnContractDigest,
        productTaskFacts,
      })
      detailPrepared.set(preparedResult.prepared.runId, preparedResult.prepared)
      return { ok: true, dispatchContext: preparedResult.prepared }
    } catch (error) {
      const failure = classifyCodexIngressPreparationError(error)
      const admissionEvidenceDigest = error instanceof PrePersistenceAdmissionError
        ? error.admissionEvidenceDigest
        : digestCanonicalJson({ scopeId: scope.id, requestId: request.requestId, stage: 'prepare' })
      const recoveryReasons = new Set([
        'runtime_unverified',
        'runtime_unsupported',
        'model_changed',
        'thread_config_changed',
        'cwd_unavailable',
        'cwd_changed',
        'instruction_contract_changed',
        'native_tool_surface_extension_required',
        'native_tool_definition_changed',
        'ready_tool_execution_contract_changed',
      ])
      const recoveryActionRef = recoveryReasons.has(failure.code)
        && recoveryEvidenceResolver
        ? issueBeginNewContextAction({
              scopeId: scope.id,
              scopeEpoch: scope.messageVisibilityEpoch,
              candidateEvidenceDigest: admissionEvidenceDigest,
              consequenceDigest: digestCanonicalJson({
                requestId: request.requestId,
                actionAdmissionRef: request.actionAdmissionRef ?? null,
              }),
              draftRevision: request.draftRevision ?? null,
            }, recoveryEvidenceResolver)
        : undefined
      return {
        ok: false,
        code: failure.code,
        retryableByUser: failure.retryableByUser,
        error: failure.error,
        admissionEvidenceDigest,
        ...(recoveryActionRef ? { recoveryActionRef } : {}),
      }
    }
  }

  return {
    prepareIngress,
  }
}

export type IngressPrepare = ReturnType<typeof createIngressPrepare>
