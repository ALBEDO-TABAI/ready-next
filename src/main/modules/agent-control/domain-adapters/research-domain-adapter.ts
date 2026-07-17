/**
 * Stage R W1.6 — Research domain adapter.
 *
 * Trigger: intent-classifier sets primaryDomain === 'research'; task-type-resolver
 * returns { taskType: 'research', executionChain: 'domain_executor',
 * preferredExecutor: 'research' }; turn-engine selects this adapter via
 * shouldHandle(taskType === 'research').
 *
 * Tool routing (落点 17, plan §3.1.12):
 *   - browser-mode      → ['browser_collect', 'present_file']
 *   - non-browser-mode  → ['web_search_domains', 'web_search', 'web_fetch', 'present_file']
 * Both modes include `present_file` so the agent can present produced
 * artifacts regardless of which research backend ran (capability group
 * `general_research` exposure is profile-level only; mode-specific prefix
 * narrowing is the final gate).
 *
 * Per plan §3.1.12 R3-D1: filterAllowedToolNamesByPrefixes returns null when
 * no tool matches; turn-engine.ts:2543 then interprets null as
 * "unrestricted_passthrough". To prevent research routing from collapsing
 * back to all tools, we explicitly narrow null → [] (empty array means
 * "no tools allowed", which is what we want when the upstream allow-list
 * has nothing in our prefix set).
 */

import {
  filterAllowedToolNamesByPrefixes,
  type DomainAdapter,
  type DomainAdapterSelectionContext,
  type DomainAdapterPrepareParams,
  type DomainAdapterPrepareResult,
  type DomainAdapterDispatchParams,
  type DomainAdapterDispatchResult,
  type DomainAdapterApplyParams,
  type DomainAdapterApplyResult,
  type DomainAdapterProjectionParams,
  type CoordinatorPromptFragment,
  type CoordinatorCapabilityArbitration,
  type CoordinatorTextDecorationPhase,
} from './domain-adapter'

/**
 * Internal research planning shape — explicitly NOT a DocumentTaskPlan.
 *
 * Stage R chose to keep research planning separate from document planning
 * because the two domains have different lifecycle semantics:
 *   - DocumentTaskPlan models discrete edit jobs against an existing target
 *     document with primary/secondary source bindings.
 *   - ResearchPlan models open-ended dimensional decomposition + multi-source
 *     synthesis, with no "target document" until presentation time.
 *
 * Cross-importing DocumentTaskPlan would smuggle document-domain coupling
 * into research routing. Gate `check-research-plan-not-document-task-plan.cjs`
 * is the source-level fence.
 */
export interface ResearchPlan {
  objective: string
  dimensions: string[]
  queries: string[]
  sources: string[]
  synthesisSteps: string[]
}

export class ResearchDomainAdapter implements DomainAdapter {
  readonly id = 'research' as const

  shouldHandle(params: DomainAdapterSelectionContext): boolean {
    if (!params.route) return false
    // Direct research route: taskType === 'research' (intent-classifier path)
    if (params.route.taskType === 'research') return true
    // Continuation re-entry: TaskType is 'continuation' but executor is 'research'
    // (set by task-execution-router.ts:89 when continuation projection module
    // is 'research'). Without this branch, ResearchDomainAdapter would not
    // re-bind on continuation, dropping prepare.allowedToolNames narrowing.
    if (params.route.executor === 'research') return true
    return false
  }

  contributePromptFragment(): CoordinatorPromptFragment[] | null {
    // deep-research SKILL is injected via reference inline (W1.4) — no
    // hard-coded fragment here.
    return null
  }

  arbitrateRunCapabilities(
    _params: DomainAdapterPrepareParams,
  ): CoordinatorCapabilityArbitration | null {
    // CoordinatorCapabilityArbitration only carries forceTool /
    // hideAssistantProcessText / budgetMultiplier; tool-set narrowing happens
    // in `prepare()`, not here. See plan §3.1.12 R2 fix.
    return null
  }

  decorateUserText(
    text: string,
    _params: { phase: CoordinatorTextDecorationPhase },
  ): string {
    return text
  }

  prepare(params: DomainAdapterPrepareParams): DomainAdapterPrepareResult {
    const isBrowserMode = this.detectBrowserMode(params)
    const inputAllowed = params.allowedToolNames ?? null
    // P1.2 / Codex iter-3 — `web_clip_url` appears in BOTH mode prefix sets:
    // it is a general research output entry point (saving a public URL into
    // outputs as an Obsidian-style Markdown note), independent of whether
    // the agent is otherwise in browser-mode for live page interaction.
    const prefixes = isBrowserMode
      ? ['browser_collect', 'present_file', 'web_clip_url']
      : ['web_search_domains', 'web_search', 'web_fetch', 'present_file', 'web_clip_url']
    const filtered = filterAllowedToolNamesByPrefixes(inputAllowed, prefixes)
    return {
      // R3-D1: filtered === null means either input was empty OR no prefix
      // matched. Returning null lets turn-engine.ts:2543 interpret it as
      // "unrestricted passthrough" which would defeat research narrowing.
      // Force empty-array narrowing so the model sees ONLY the prefix tools
      // (or nothing) when this adapter is in charge.
      allowedToolNames: filtered ?? [],
    }
  }

  dispatch(_params: DomainAdapterDispatchParams): DomainAdapterDispatchResult {
    // Default tool_loop drive — let turn-engine handle the LLM iteration.
    return {}
  }

  applyResult(_params: DomainAdapterApplyParams): DomainAdapterApplyResult {
    return {}
  }

  buildProjectionPatch(
    _params: DomainAdapterProjectionParams,
  ): Record<string, unknown> | null {
    return null
  }

  /**
   * Detects whether the current run is operating in browser-capable mode.
   *
   * R1-C02 fix: derive from upstream `allowedToolNames` (capability resolver
   * already collected the available tool surface for this turn). When
   * `browser_collect` is allowed, the host's capability profile
   * exposes a browser backend → use the browser-mode prefix set; otherwise
   * fall back to the web_search / web_fetch surface.
   *
   * Note: `null` means "no narrowing yet" (unrestricted passthrough); we
   * treat that as non-browser-mode so research stays on the safe default
   * web tool surface unless browser capability was explicitly admitted.
   */
  private detectBrowserMode(params: DomainAdapterPrepareParams): boolean {
    const allowed = params.allowedToolNames
    if (!allowed || allowed.length === 0) return false
    return allowed.some((name) => name === 'browser_collect')
  }
}
