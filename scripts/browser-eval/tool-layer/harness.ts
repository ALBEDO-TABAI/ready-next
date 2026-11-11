// Tool-layer eval harness (W7-T2). Runs inside a hidden Electron Main process (see app.mjs):
// a real BrowserController with real WebContentsView tabs, the production tool entry
// `executeToolCall`, and the tool context the Codex bridge builds for a model call.
// No model, no Codex runtime, no remote debugging port.
import { BrowserWindow } from 'electron'
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'

import { getDatabase } from '../../../src/main/modules/database'
import { BrowserController } from '../../../src/main/modules/browser-engine/ipc-handler'
import {
  createBrowserTurnLease,
  type BrowserTurnLease
} from '../../../src/main/modules/browser-engine/agent-browser-turn-lease'
import {
  AgentSessionCheckpointRepository
} from '../../../src/main/modules/repositories/agent-session-checkpoint-repository'
import { TaskProjectionRepository } from '../../../src/main/modules/repositories/task-projection-repository'
import { RunMetaRepository } from '../../../src/main/modules/agent-control/task-projection/run-meta-repository'
import { executeToolCall, type ToolContext } from '../../../src/main/modules/tools/tool-executor'
import {
  resolveTrustedBrowserEnvironment
} from '../../../src/main/modules/agent-control/runtime-core/trusted-browser-environment'
import {
  buildBrowserAdmissionAuthoritySnapshot,
  composeBrowserAdmissionToolNames,
} from '../../../src/main/modules/agent-control/codex-runtime/codex-browser-admission'
import {
  buildExplicitNoSkillAuthorization
} from '../../../src/main/modules/agent-control/skills/skill-tool-authorization'

/** pass: works as the contract says; fail: contract violation or regression (gate fails);
 * unavailable: closed today (by code or by the hidden window) and refused exactly as expected;
 * gap: works but short of the plan's target, recorded against the plan item without failing the gate. */
export type CaseStatus = 'pass' | 'fail' | 'unavailable' | 'gap'
export interface CaseResult {
  site: string
  id: string
  title: string
  status: CaseStatus
  tools: string[]
  detail: string
  evidence?: unknown
  durationMs: number
}

export interface ToolCallResult {
  tool: string
  args: Record<string, unknown>
  data: Record<string, unknown>
  text: string
  shape: string | null
  hasImage: boolean
  ms: number
}

export interface EvalServer {
  origins: { main: string; alt: string; third: string }
  url(path: string, origin?: 'main' | 'alt' | 'third'): string
  records(
    kind?: string
  ): Array<{ seq: number; kind: string; at: string; origin: string; data: Record<string, unknown> }>
  reset(): void
  /** Mints a logged-in session for the fake admin (the user has logged in beforehand). */
  login(): { name: string; value: string; url: string; path: string; httpOnly: boolean }
  fixtures: {
    files: Record<string, { name: string; path: string; size: number; sha256: string; contentType: string }>;
    credentials: { username: string; password: string }
  }
  close(): Promise<void>
}
type RawDb = NonNullable<ReturnType<ReturnType<typeof getDatabase>['getRawDb']>>

const VIEW_BOUNDS = { x: 0, y: 0, w: 1280, h: 800 }
let intentSeq = 1

/** Outcome a case reports; `unavailable` means the capability is closed today and the case
 * asserted exactly that (refused, nothing delivered). */
export interface CaseOutcome { status: CaseStatus; detail: string; evidence?: unknown }
export const pass = (detail: string, evidence?: unknown): CaseOutcome => ({ status: 'pass', detail, evidence })
export const fail = (detail: string, evidence?: unknown): CaseOutcome => ({ status: 'fail', detail, evidence })
export const unavailable = (
  detail: string,
  evidence?: unknown
): CaseOutcome => ({ status: 'unavailable', detail, evidence })
export const gap = (detail: string, evidence?: unknown): CaseOutcome => ({ status: 'gap', detail, evidence })

export interface Environment {
  db: RawDb
  controller: BrowserController
  window: BrowserWindow
  server: EvalServer
  attachmentsDir: string
  checkpoints: AgentSessionCheckpointRepository
  projections: TaskProjectionRepository
  runMeta: RunMetaRepository
}

function executionBinding(runId: string) {
  return {
    schemaVersion: 1 as const,
    runId,
    ownerAgentIdAtStart: 'butler',
    runOrigin: 'initial' as const,
    kind: 'registered_agent' as const,
    requestedAgentId: 'butler',
    effectiveAgentId: 'butler',
    executionMaterialHash: 'browser-eval-material',
    ownerAssignmentSource: 'conversation_active' as const,
    executionSelectionSource: 'task_owner' as const,
    resolutionKind: 'direct' as const,
  }
}

async function sleep(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms))
}

/** A page with an open native dialog never answers JS evaluation; bound every harness wait. */
export async function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  // A call that outlives its timeout may still reject later; that must not become unhandled.
  promise.catch(() => undefined)
  let timer: ReturnType<typeof setTimeout> | null = null
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms)
      }),
    ])
  } finally {
    if (timer) clearTimeout(timer)
  }
}

/**
 * One agent run bound to one user tab, the shape of a Browser-workbench turn: the user's
 * current page becomes the exact pageRef, the frozen tool surface comes from the production
 * admission composer, and every call goes through `executeToolCall` with invoker 'model'.
 */
export class AgentRun {
  readonly scopeId: string
  readonly parentTaskId: string
  readonly runId: string
  readonly sourceMessageId: string
  tabId = ''
  allowedToolNames: string[] = []
  calls: ToolCallResult[] = []
  private pageRef: Record<string, unknown> | null = null
  private lease: BrowserTurnLease
  private readonly binding: ReturnType<typeof executionBinding>

  constructor(
    private readonly env: Environment,
    label: string,
    private readonly options: { attachments?: Array<{ name: string; path: string; size: number }> } = {}
  ) {
    const suffix = `${label}-${Date.now().toString(36)}`
    this.scopeId = `browser-eval-scope-${suffix}`
    this.parentTaskId = `browser-eval-task-${suffix}`
    this.runId = `browser-eval-run-${suffix}`
    this.sourceMessageId = `browser-eval-msg-${suffix}`
    this.binding = executionBinding(this.runId)
    const now = new Date().toISOString()
    env.db.prepare(
      `INSERT INTO chat_conversations (id, agent, title, source_kind, source_id, thread_key, created_at, updated_at)
       VALUES (?, 'butler', ?, 'local', ?, ?, ?, ?)`,
    ).run(this.scopeId, `browser eval ${label}`, this.scopeId, this.scopeId, now, now)
    env.projections.create({
      taskId: this.parentTaskId,
      scopeId: this.scopeId,
      messageVisibilityEpoch: 0,
      runId: this.runId,
      taskType: 'direct_answer',
      module: 'browser',
      status: 'running',
      interactionState: 'running',
      waitingFor: 'none',
      steps: [],
      ownerAgentId: 'butler',
      taskOrigin: 'user_root',
      executionBinding: this.binding,
      createdAt: now,
      updatedAt: now,
    })
    env.runMeta.create({
      runId: this.runId,
      taskId: this.parentTaskId,
      scopeId: this.scopeId,
      messageVisibilityEpoch: 0,
      agentId: 'butler',
      executionBinding: this.binding,
      status: 'running',
    }, Date.parse(now))
    const attachments = (options.attachments || []).map((item, index) => ({
      id: `browser-eval-attachment-${index + 1}`,
      name: item.name,
      path: item.path,
      size: item.size,
      type: 'document',
      ext: item.name.split('.').pop() || '',
      source: 'upload',
    }))
    env.db.prepare(
      `INSERT INTO chat_messages (id, conversation_id, role, content, timestamp, meta_json, message_visibility_epoch)
       VALUES (?, ?, 'user', ?, ?, ?, 0)`,
    ).run(this.sourceMessageId, this.scopeId, `browser eval ${label}`, now, JSON.stringify({ attachments }))
    this.lease = createBrowserTurnLease({ taskId: this.parentTaskId, runId: this.runId })
  }

  get controller(): BrowserController { return this.env.controller }

  get server(): EvalServer { return this.env.server }

  /**
   * Open `url` as the user's active tab, present it like the renderer does, bind the pageRef and,
   * like a model starting a turn, observe it once (actions need an observed document identity).
   */
  async open(url: string, options: { observe?: boolean } = {}): Promise<void> {
    const created = await this.controller.createTab(url)
    if (!created.success || !created.tabId) throw new Error(`createTab failed: ${created.error || 'unknown'}`)
    this.tabId = created.tabId
    this.controller.applyBrowserViewIntent(
      { kind: 'show', intentId: ++intentSeq, tabId: this.tabId, bounds: VIEW_BOUNDS, reason: 'tab-activate' }
    )
    this.controller.applyBrowserViewIntent(
      { kind: 'set-bounds', intentId: ++intentSeq, tabId: this.tabId, bounds: VIEW_BOUNDS }
    )
    await this.waitForDocument()
    await this.rebindPageRef()
    if (options.observe !== false) await this.call('browser_snapshot', {})
  }

  /** Re-freeze admission against the tab's current document, as a new user turn would. */
  async rebindPageRef(): Promise<void> {
    const environment = await resolveTrustedBrowserEnvironment(this.controller, this.tabId)
    if (!environment.browserPageRef) throw new Error('page reference unavailable for the user tab')
    this.pageRef = environment.browserPageRef as unknown as Record<string, unknown>
    const snapshot = buildBrowserAdmissionAuthoritySnapshot({
      authorityId: `${this.runId}-admission`,
      activeWorkbenchMode: 'browser',
      currentBrowserPageRef: environment.browserPageRef,
      hasExplicitAttachment: (this.options.attachments || []).length > 0,
      hasWritableRoot: false,
    })
    this.allowedToolNames = composeBrowserAdmissionToolNames(snapshot)
  }

  async waitForDocument(timeoutMs = 15_000): Promise<void> {
    const deadline = Date.now() + timeoutMs
    while (Date.now() < deadline) {
      const state = await withTimeout(
        this.controller.executeJS(this.tabId, 'document.readyState'),
        2_000,
        'readyState'
      ).catch(
        () => null
      )
      if (state === 'complete') return
      await sleep(50)
    }
    throw new Error(`document not complete within ${timeoutMs}ms`)
  }

  private context(): ToolContext {
    const repository = this.env.checkpoints
    return {
      runtime: null,
      browserController: this.controller,
      sidecarManager: null,
      scope: null,
      agent: 'butler',
      sessionId: this.scopeId,
      scopeId: this.scopeId,
      messageVisibilityEpoch: 0,
      runId: this.runId,
      taskId: this.parentTaskId,
      sourceMessageId: this.sourceMessageId,
      executionBinding: this.binding,
      browserLease: this.lease,
      ensureBrowserWorkflowRoute: async () => repository.bindBrowserWorkflowRoute({
        parentTaskId: this.parentTaskId,
        ownerRunId: this.runId,
        sourceMessageId: this.sourceMessageId,
        executionBinding: this.binding,
        resourceAnchors: [],
      }),
      requestEnvelope: { environmentHints: { workbenchMode: 'browser', browserPageRef: this.pageRef } },
      allowedToolNames: new Set(this.allowedToolNames),
      authorization: buildExplicitNoSkillAuthorization('no_skill_signal'),
      abortSignal: new AbortController().signal,
      codexHostPrimitiveOnly: true,
      invoker: 'model',
      allowInternal: false,
    } as ToolContext
  }

  async call(tool: string, args: Record<string, unknown> = {}, timeoutMs = 45_000): Promise<ToolCallResult> {
    const started = Date.now()
    const output = await withTimeout(executeToolCall(tool, args, this.context()), timeoutMs, `${tool} call`)
    let data: Record<string, unknown> = {}
    if (output.data && typeof output.data === 'object') data = output.data as Record<string, unknown>
    else {
      try {
        const parsed = JSON.parse(output.text) as unknown
        if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) data = parsed as Record<string, unknown>
      } catch { /* non-JSON tool text stays in `text` */ }
    }
    const content = (output as { content?: unknown }).content
    const hasImage = Array.isArray(content) && content.some((item) => {
      const type = (item as { type?: unknown })?.type
      return type === 'inputImage' || type === 'image' || type === 'input_image'
    })
    const result: ToolCallResult = {
      tool,
      args,
      data,
      text: output.text,
      shape: output.shape ?? null,
      hasImage,
      ms: Date.now() - started
    }
    this.calls.push(result)
    return result
  }

  /** Harness-side read of the page probe counters (not a tool call). */
  async probe(): Promise<{
    counts: Record<string, number>;
    lastClick: string | null;
    lastKey: string | null;
    trusted: Record<string, number>
  } | null> {
    const raw = await withTimeout(
      this.controller.executeJS(this.tabId, 'JSON.stringify(window.__evalProbe || null)'),
      3_000,
      'probe'
    ).catch(
      () => null
    )
    return typeof raw === 'string' ? JSON.parse(raw) : null
  }

  async pageEval<T>(expression: string): Promise<T | null> {
    const raw = await withTimeout(
      this.controller.executeJS(this.tabId, `JSON.stringify((() => { ${expression} })())`),
      3_000,
      'pageEval'
    ).catch(
      () => null
    )
    return typeof raw === 'string' ? JSON.parse(raw) as T : null
  }

  async currentUrl(): Promise<string> {
    return String(
      await withTimeout(this.controller.executeJS(this.tabId, 'location.href'), 3_000, 'location').catch(() => '') || ''
    )
  }

  close(): void {
    this.lease.release()
    if (this.tabId) {
      try { this.controller.closeTab(this.tabId) } catch { /* the tab may already be gone */ }
    }
  }
}

export interface GroupContext {
  env: Environment
  server: EvalServer
  url(path: string, origin?: 'main' | 'alt' | 'third'): string
  run(label: string, options?: { attachments?: string[] }): Promise<AgentRun>
  /** Put a logged-in admin session into the browser partition, as if the user had logged in. */
  loginAsUser(): Promise<void>
  check(id: string, title: string, tools: string[], body: () => Promise<CaseOutcome>): Promise<CaseOutcome>
}

export interface CaseGroup {
  site: string
  title: string
  run(ctx: GroupContext): Promise<void>
}

export async function createEnvironment(server: EvalServer, profile: string): Promise<Environment> {
  const manager = getDatabase()
  const db = manager.getRawDb()
  if (!db) throw new Error('eval database unavailable')
  const accessor = { getRawDb: () => db }
  const checkpoints = new AgentSessionCheckpointRepository(accessor)
  const projections = new TaskProjectionRepository(accessor)
  const runMeta = new RunMetaRepository(db)
  const window = new BrowserWindow({
    show: false,
    width: VIEW_BOUNDS.w,
    height: VIEW_BOUNDS.h,
    webPreferences: { backgroundThrottling: false },
  })
  await window.loadURL('about:blank')
  const controller = new BrowserController(window)
  // Same ports AgentControlRuntime wires in production.
  controller.setBrowserTargetCheckpointResolver((parentTaskId) => (
    projections.get(parentTaskId)?.checkpointRefs?.cleanBaseCheckpointId || null
  ))
  controller.setBrowserWorkflowWriteAdmissionPort((input) => checkpoints.isBrowserWorkflowWriteAdmitted({
    parentTaskId: input.parentTaskId,
    ownerRunId: input.ownerRunId,
    browserTaskId: input.browserTaskId,
    physicalTarget: {
      surface: input.surface,
      scopeId: input.scopeId,
      profileId: input.profileId,
      sessionId: input.sessionId,
      tabId: input.tabId,
      physicalTargetToken: input.physicalTargetToken,
      source: 'physical_input',
    },
  }))
  controller.setBrowserWorkflowJournalUnitOfWork({
    beginAction: (input) => checkpoints.beginBrowserWorkflowAction(input),
    settleAction: (taskId, actionId, outcome) => checkpoints.settleBrowserWorkflowAction(taskId, actionId, outcome),
    recordObservation: (input) => checkpoints.recordBrowserWorkflowObservation(input),
    upsertResearchWorkItems: (
      taskId,
      ownerRunId,
      inputs
    ) => checkpoints.upsertBrowserResearchWorkItems(taskId, ownerRunId, inputs),
    bindResearchEvidence: (
      taskId,
      ownerRunId,
      bindings
    ) => checkpoints.bindBrowserResearchEvidence(taskId, ownerRunId, bindings),
  })
  const attachmentsDir = join(profile, 'attachments')
  mkdirSync(attachmentsDir, { recursive: true })
  return { db, controller, window, server, attachmentsDir, checkpoints, projections, runMeta }
}
