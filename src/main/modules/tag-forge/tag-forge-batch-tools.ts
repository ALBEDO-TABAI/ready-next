import type { DatabaseConnection } from '../database/connection'
import { createHash, randomUUID } from 'crypto'
import { lstat, readFile } from 'fs/promises'
import { dirname, extname, join, relative } from 'path'


import type { SearchEngine } from '../search-engine/indexer'
import { TagForgeRepository } from '../repositories/tag-forge-repository'
import {
  collectFileInventory,
  authorizeRoot,
  getFileManagementStoreDir,
  readJsonFile,
  resolveExistingPathInsideRoot,
  toJsonString,
  writeJsonFile,
  type FileManagementToolContext,
} from '../tools/file-management-runtime'
import { extractDocumentTagLabels } from './tag-forge-content-tags'
import { buildTagForgeLexiconSnapshot, executeTagForgeApply } from './tag-forge-tool'
import {
  evaluateControlledContentLabels,
  loadTagForgePolicy,
  type TagFacet,
  type TagProposal,
} from './tag-forge-policy'
import { revisionOf } from './tag-forge-writer'

const TAG_FORGE_BATCH_DOCUMENT_LIMIT = 4
const TAG_FORGE_BATCH_CONTENT_CHARS = 60_000
const TAG_FORGE_REVIEW_CANDIDATE_LIMIT = 35
const TAG_FORGE_REVIEW_OPTIONS_PER_QUESTION = 7
const TAG_FORGE_REVIEW_IGNORE_OPTION = '以上标签都不采用'

type TagForgeBatchItemState = {
  itemId: string
  path: string
  relativePath: string
  status: 'pending' | 'awaiting_review' | 'completed' | 'conflict' | 'failed'
  errorKind?: string | null
  pending?: Array<{ proposalId: string; facet: TagFacet; label: string }>
  pendingSubmission?: {
    expectedRevision: string
    proposals?: TagProposal[]
  }
}

type TagForgeBatchState = {
  batchId: string
  rootPath: string
  workspaceRoot: string
  policyVersion: string
  items: TagForgeBatchItemState[]
  reviewRequestId?: string
  reviewFingerprint?: string
  reviewCardId?: string
  reviewDecision?: {
    confirmationCardId: string
    selected: string[]
    decisions: Array<{ proposalId: string; facet: TagFacet; label: string; decision: 'approve' | 'ignore' }>
  }
  createdAt: string
  updatedAt: string
}

type TagForgeReviewItem = {
  facet: TagFacet
  label: string
  proposalIds: string[]
  files: string[]
  evidenceExcerpt: string | null
  confidence: number | null
}

export async function executeTagForgeBatchTool(
  toolName: string,
  args: Record<string, unknown>,
  engine: SearchEngine,
  context?: FileManagementToolContext,
): Promise<string> {
  switch (toolName) {
    case 'tag_forge_prepare_batch':
      return runTagForgePrepareBatch(args, engine, context)
    case 'tag_forge_apply_batch':
      return runTagForgeApplyBatch(args, engine, context)
    case 'tag_forge_review_batch':
      return runTagForgeReviewBatch(args, engine, context)
    default:
      return `Unknown file management tool: ${toolName}`
  }
}

function tagForgeBatchPath(storeDir: string, batchId: string): string {
  return join(storeDir, 'tag-forge-batches', `${batchId}.json`)
}

async function loadTagForgeBatch(storeDir: string, batchId: string): Promise<TagForgeBatchState | null> {
  if (!/^[a-zA-Z0-9-]{8,80}$/.test(batchId)) return null
  return readJsonFile<TagForgeBatchState>(tagForgeBatchPath(storeDir, batchId))
}

async function saveTagForgeBatch(storeDir: string, state: TagForgeBatchState): Promise<void> {
  state.updatedAt = new Date().toISOString()
  await writeJsonFile(tagForgeBatchPath(storeDir, state.batchId), state)
}

async function runTagForgePrepareBatch(
  args: Record<string, unknown>,
  engine: SearchEngine,
  context?: FileManagementToolContext,
): Promise<string> {
  const storeDir = await getFileManagementStoreDir(context)
  const requestedBatchId = typeof args.batchId === 'string' ? args.batchId.trim() : ''
  let state = requestedBatchId ? await loadTagForgeBatch(storeDir, requestedBatchId) : null
  if (requestedBatchId && !state) return toJsonString({ ok: false, errorKind: 'tag_forge_batch_not_found' })
  const policy = loadTagForgePolicy()
  if (!state || state.policyVersion !== policy.version) {
    const requestedRoot = state?.rootPath || (typeof args.rootPath === 'string' ? args.rootPath : '')
    const auth = await authorizeRoot(requestedRoot, engine, context?.workspaceRoots)
    if (!auth.ok) return toJsonString(auth.output)
    const inventory = await collectFileInventory(auth.rootPath, auth, true, Number.MAX_SAFE_INTEGER)
    const items: TagForgeBatchItemState[] = []
    for (const item of inventory) {
      if (item.kind !== 'file' || extname(item.path).toLowerCase() !== '.md') continue
      const itemId = `tfi-${randomUUID()}`
      const relativePath = relative(auth.rootPath, item.path)
      if (item.errorKind) {
        items.push({ itemId, path: item.path, relativePath, status: 'failed', errorKind: item.errorKind })
        continue
      }
      try {
        await readFile(item.path, 'utf-8')
        items.push({ itemId, path: item.path, relativePath, status: 'pending' })
      } catch {
        // silent-catch: an unreadable document is retained as a structured failed batch item instead of aborting the remaining batch.
        items.push({ itemId, path: item.path, relativePath, status: 'failed', errorKind: 'tag_read_failed' })
      }
    }
    const fingerprint = createHash('sha256').update(`${auth.rootPath}\0${Date.now()}\0${randomUUID()}`).digest('hex').slice(0, 20)
    const now = new Date().toISOString()
    state = {
      batchId: `tfb-${fingerprint}`,
      rootPath: auth.rootPath,
      workspaceRoot: auth.workspaceRoot,
      policyVersion: policy.version,
      items,
      createdAt: now,
      updatedAt: now,
    }
    await saveTagForgeBatch(storeDir, state)
  }
  for (const item of state.items) {
    item.itemId ||= `tfi-${randomUUID()}`
    item.relativePath ||= relative(state.rootPath, item.path)
  }
  const currentAuth = await authorizeRoot(state.rootPath, engine, [state.workspaceRoot])
  if (!currentAuth.ok) return toJsonString(currentAuth.output)
  const limit = typeof args.limit === 'number'
    ? Math.max(1, Math.min(TAG_FORGE_BATCH_DOCUMENT_LIMIT, Math.floor(args.limit)))
    : TAG_FORGE_BATCH_DOCUMENT_LIMIT
  const pending = state.items.filter((item) => item.status !== 'completed' && item.status !== 'awaiting_review')
  const documents: Array<{ itemId: string; file: string; expectedRevision: string; content: string }> = []
  let contentChars = 0
  for (const item of pending) {
    if (documents.length >= limit) break
    try {
      const currentStats = await lstat(item.path)
      if (currentStats.isSymbolicLink()) {
        item.status = 'failed'
        item.errorKind = 'symlink_not_supported'
        continue
      }
      const resolved = await resolveExistingPathInsideRoot(item.path, currentAuth)
      if (!resolved.ok) {
        item.status = 'failed'
        item.errorKind = 'workspace_boundary_rejected'
        continue
      }
      const content = await readFile(resolved.realPath, 'utf-8')
      if (documents.length > 0 && contentChars + content.length > TAG_FORGE_BATCH_CONTENT_CHARS) break
      item.status = 'pending'
      item.errorKind = null
      documents.push({ itemId: item.itemId, file: item.relativePath, expectedRevision: revisionOf(content), content })
      contentChars += content.length
    } catch (error) {
      // silent-catch: per-document preparation failures are persisted on the item and returned in the batch error list.
      item.status = 'failed'
      item.errorKind = error instanceof Error ? error.message : String(error)
    }
  }
  const actionableRemaining = state.items.filter((item) => item.status !== 'completed' && item.status !== 'awaiting_review').length
  const review = actionableRemaining === 0 ? await prepareTagForgeReview(state, engine) : null
  const completed = state.items.filter((item) => item.status === 'completed').length
  const remaining = state.items.filter((item) => item.status !== 'completed').length
  await saveTagForgeBatch(storeDir, state)
  if (review?.question && state.reviewDecision) {
    return runTagForgeReviewBatch({
      batchId: state.batchId,
      confirmationCardId: state.reviewDecision.confirmationCardId,
    }, engine, context)
  }
  const runStatePath = tagForgeBatchPath(storeDir, state.batchId)
  const overlay = new TagForgeRepository(engine.getRepository().getConnection()).listOverlay()
  return toJsonString({
    ok: true,
    batchId: state.batchId,
    total: state.items.length,
    completed,
    remaining,
    done: remaining === 0,
    contentChars,
    documents,
    errors: state.items.filter((item) => item.status === 'failed' || item.status === 'conflict').map((item) => ({ itemId: item.itemId, file: item.relativePath, errorKind: item.errorKind })),
    lexicon: buildTagForgeLexiconSnapshot(policy, overlay),
    reviewRequired: Boolean(review?.question),
    reviewItems: review ? publicTagForgeReviewItems(review.items) : [],
    reviewQuestion: review?.question ?? null,
    resume: remaining > 0 ? {
      tool: 'tag_forge_prepare_batch',
      args: { batchId: state.batchId },
      outputDir: dirname(runStatePath),
      runStatePath,
    } : null,
  })
}

async function runTagForgeApplyBatch(
  args: Record<string, unknown>,
  engine: SearchEngine,
  context?: FileManagementToolContext,
): Promise<string> {
  const batchId = typeof args.batchId === 'string' ? args.batchId.trim() : ''
  const storeDir = await getFileManagementStoreDir(context)
  const state = await loadTagForgeBatch(storeDir, batchId)
  if (!state) return toJsonString({ ok: false, errorKind: 'tag_forge_batch_not_found' })
  const submitted = Array.isArray(args.items) ? args.items : []
  const results: Array<Record<string, unknown>> = []
  for (const raw of submitted) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) continue
    const item = raw as Record<string, unknown>
    const itemId = typeof item.itemId === 'string' ? item.itemId.trim() : ''
    const tracked = state.items.find((candidate) => candidate.itemId === itemId)
    const reviewRetry = args.reviewRetry === true
    if (!tracked) {
      results.push({ itemId, ok: false, errorKind: 'item_not_in_batch' })
      continue
    }
    if (tracked.status === 'completed') {
      results.push({ itemId, file: tracked.relativePath, ok: true, status: 'completed', replayed: true })
      continue
    }
    if (tracked.status === 'awaiting_review' && !reviewRetry) {
      results.push({ itemId, file: tracked.relativePath, ok: true, status: 'waiting_review', reviewRequired: true, replayed: true })
      continue
    }
    const output = JSON.parse(await executeTagForgeApply({
      path: tracked.path,
      expectedRevision: item.expectedRevision,
      proposals: item.proposals,
    }, engine, { ...context, batchId, itemId })) as Record<string, unknown>
    if (output.ok === true && output.status === 'waiting_review') {
      tracked.pending = normalizePendingTags(output.pending)
      if (tracked.pending.length === 0) {
        tracked.status = 'failed'
        tracked.errorKind = 'tag_review_state_missing'
        tracked.pendingSubmission = undefined
      } else {
        tracked.status = 'awaiting_review'
        tracked.errorKind = null
        tracked.pendingSubmission = {
          expectedRevision: typeof output.revision === 'string' ? output.revision : String(item.expectedRevision || ''),
          proposals: normalizeTagProposals(item.proposals),
        }
      }
    } else if (output.ok === true && output.status === 'completed') {
      tracked.status = 'completed'
      tracked.errorKind = null
      tracked.pending = undefined
      tracked.pendingSubmission = undefined
    } else {
      const errorKind = typeof output.errorKind === 'string' ? output.errorKind : 'tag_write_failed'
      tracked.status = errorKind === 'revision_conflict' || errorKind === 'open_tab_revision_conflict' ? 'conflict' : 'failed'
      tracked.errorKind = errorKind
      tracked.pendingSubmission = undefined
    }
    results.push({ ...output, path: undefined, itemId, file: tracked.relativePath })
    await saveTagForgeBatch(storeDir, state)
  }
  const actionableRemaining = state.items.filter((item) => item.status !== 'completed' && item.status !== 'awaiting_review').length
  const review = actionableRemaining === 0 ? await prepareTagForgeReview(state, engine) : null
  const completed = state.items.filter((item) => item.status === 'completed').length
  const remaining = state.items.filter((item) => item.status !== 'completed').length
  const awaitingReview = state.items.filter((item) => item.status === 'awaiting_review').length
  await saveTagForgeBatch(storeDir, state)
  const runStatePath = tagForgeBatchPath(storeDir, batchId)
  return toJsonString({
    ok: submitted.length > 0 && results.length === submitted.length && results.every((result) => result.ok === true),
    batchId,
    completed,
    remaining,
    done: remaining === 0,
    awaitingReview,
    reviewRequired: Boolean(review?.question),
    reviewLocation: review?.question ? 'Agent 对话' : null,
    reviewItems: review ? publicTagForgeReviewItems(review.items) : [],
    reviewRequestId: review?.question ? state.reviewRequestId : null,
    reviewQuestion: review?.question ?? null,
    resume: remaining > 0 ? {
      tool: 'tag_forge_prepare_batch',
      args: { batchId },
      outputDir: dirname(runStatePath),
      runStatePath,
    } : null,
    results,
  })
}

async function runTagForgeReviewBatch(
  args: Record<string, unknown>,
  engine: SearchEngine,
  context?: FileManagementToolContext,
): Promise<string> {
  const batchId = typeof args.batchId === 'string' ? args.batchId.trim() : ''
  const storeDir = await getFileManagementStoreDir(context)
  const state = await loadTagForgeBatch(storeDir, batchId)
  if (!state) return toJsonString({ ok: false, errorKind: 'tag_forge_batch_not_found' })
  const confirmationCardId = typeof args.confirmationCardId === 'string' ? args.confirmationCardId.trim() : ''
  if (state.reviewCardId === confirmationCardId && state.items.every((item) => item.status !== 'awaiting_review')) {
    const remaining = state.items.filter((item) => item.status !== 'completed').length
    return toJsonString({ ok: remaining === 0, batchId, done: remaining === 0, remaining, confirmationCardId, replayed: true })
  }
  const review = await prepareTagForgeReview(state, engine)
  const reviewItems = review.items
  if (!state.reviewRequestId || reviewItems.length === 0) {
    return toJsonString({ ok: false, errorKind: 'tag_forge_review_not_pending' })
  }
  if (!review.question) return toJsonString({ ok: false, errorKind: 'tag_forge_review_question_missing' })
  if (state.reviewCardId && state.reviewCardId !== confirmationCardId) {
    return toJsonString({ ok: false, errorKind: 'tag_forge_review_card_already_consumed' })
  }
  let decisionLog = state.reviewDecision
  if (decisionLog && decisionLog.confirmationCardId !== confirmationCardId) {
    return toJsonString({ ok: false, errorKind: 'tag_forge_review_confirmation_mismatch' })
  }
  if (!decisionLog) {
    const confirmation = readTagForgeReviewConfirmation(
      engine.getRepository().getConnection(),
      confirmationCardId,
      review.question,
      context?.runId ?? null,
      context?.scopeId ?? null,
    )
    if (!confirmation.ok) return toJsonString({ ok: false, errorKind: confirmation.errorKind })
    const decisions = reviewItems.flatMap((item) => {
      const decision = confirmation.selected.has(tagForgeReviewOption(item)) ? 'approve' as const : 'ignore' as const
      return item.proposalIds.map((proposalId) => ({ proposalId, facet: item.facet, label: item.label, decision }))
    })
    decisionLog = { confirmationCardId, selected: [...confirmation.selected], decisions }
    state.reviewDecision = decisionLog
    await saveTagForgeBatch(storeDir, state)
  }
  const repository = new TagForgeRepository(engine.getRepository().getConnection())
  const resolved: Array<Record<string, unknown>> = []
  engine.getRepository().transaction(() => {
    for (const decision of decisionLog!.decisions) {
      repository.reviewPending(decision.proposalId, decision.decision === 'approve' ? 'approve' : 'dismiss')
      resolved.push({ proposalId: decision.proposalId, facet: decision.facet, label: decision.label, decision: decision.decision, ok: true })
    }
  })
  state.reviewCardId = confirmationCardId
  const decisionsById = new Map(decisionLog.decisions.map((decision) => [decision.proposalId, decision]))
  const overlay = repository.listOverlay()
  const policy = loadTagForgePolicy()
  const retryItems: Array<{ itemId: string; expectedRevision: string; proposals?: TagProposal[] }> = []
  for (const item of state.items) {
    if (item.status !== 'awaiting_review' || !item.pendingSubmission || !item.pending?.every((pending) => decisionsById.has(pending.proposalId))) continue
    const itemDecisions = item.pending.map((pending) => decisionsById.get(pending.proposalId)!)
    if (itemDecisions.every((decision) => decision.decision === 'ignore') && await hasCompleteTagForgeContent(item.path, policy, overlay)) {
      item.status = 'completed'
      item.errorKind = null
      item.pending = undefined
      item.pendingSubmission = undefined
      continue
    }
    retryItems.push({ itemId: item.itemId, ...item.pendingSubmission })
  }
  await saveTagForgeBatch(storeDir, state)
  if (retryItems.length === 0) {
    const continued = JSON.parse(await runTagForgePrepareBatch({ batchId }, engine, context)) as Record<string, unknown>
    return toJsonString({ ...continued, decisions: resolved, confirmationCardId })
  }
  const retried = JSON.parse(await runTagForgeApplyBatch({ batchId, items: retryItems, reviewRetry: true }, engine, context)) as Record<string, unknown>
  return toJsonString({ ...retried, ok: retried.ok === true, decisions: resolved, confirmationCardId })
}

async function hasCompleteTagForgeContent(
  path: string,
  policy: ReturnType<typeof loadTagForgePolicy>,
  overlay: ReturnType<TagForgeRepository['listOverlay']>,
): Promise<boolean> {
  const content = await readFile(path, 'utf8').catch(() => null)
  if (content === null) return false
  const coverage = evaluateControlledContentLabels(policy, extractDocumentTagLabels(content), overlay)
  return coverage.formCount >= 1 && (coverage.facets.includes('domain') || coverage.facets.includes('entity'))
}

function normalizePendingTags(value: unknown): Array<{ proposalId: string; facet: TagFacet; label: string }> {
  if (!Array.isArray(value)) return []
  return value.flatMap((item) => {
    if (!item || typeof item !== 'object' || Array.isArray(item)) return []
    const facet = (item as Record<string, unknown>).facet
    const label = (item as Record<string, unknown>).label
    const proposalId = (item as Record<string, unknown>).proposalId
    return typeof facet === 'string' && ['form', 'domain', 'entity', 'use'].includes(facet) && typeof label === 'string' && typeof proposalId === 'string'
      ? [{ proposalId, facet: facet as TagFacet, label }]
      : []
  })
}

function normalizeTagProposals(value: unknown): TagProposal[] | undefined {
  if (!Array.isArray(value)) return undefined
  return value.filter((item): item is TagProposal => Boolean(item && typeof item === 'object' && !Array.isArray(item)))
}

function collectTagForgeReviewItems(state: TagForgeBatchState): TagForgeReviewItem[] {
  const grouped = new Map<string, TagForgeReviewItem>()
  for (const item of state.items) {
    if (item.status !== 'awaiting_review') continue
    for (const pending of item.pending ?? []) {
      const key = `${pending.facet}:${pending.label}`.toLocaleLowerCase()
      const proposal = item.pendingSubmission?.proposals?.find((candidate) => (
        candidate.facet === pending.facet && candidate.label.toLocaleLowerCase() === pending.label.toLocaleLowerCase()
      ))
      const current = grouped.get(key) ?? {
        ...pending,
        proposalIds: [],
        files: [],
        evidenceExcerpt: proposal?.evidenceExcerpt?.trim() || null,
        confidence: typeof proposal?.confidence === 'number' ? proposal.confidence : null,
      }
      if (!current.proposalIds.includes(pending.proposalId)) current.proposalIds.push(pending.proposalId)
      if (!current.files.includes(item.relativePath)) current.files.push(item.relativePath)
      grouped.set(key, current)
    }
  }
  const facetPriority: Record<TagFacet, number> = { form: 0, domain: 1, entity: 2, use: 3, state: 4 }
  return [...grouped.values()].sort((a, b) => (
    facetPriority[a.facet] - facetPriority[b.facet]
    || (b.confidence ?? 0) - (a.confidence ?? 0)
    || a.label.localeCompare(b.label)
  ))
}

async function prepareTagForgeReview(
  state: TagForgeBatchState,
  engine: SearchEngine,
): Promise<{ items: TagForgeReviewItem[]; question: Record<string, unknown> | null }> {
  const candidates = collectTagForgeReviewItems(state)
  const reviewAlreadyUsed = Boolean(state.reviewCardId)
  const items = reviewAlreadyUsed ? [] : candidates.slice(0, TAG_FORGE_REVIEW_CANDIDATE_LIMIT)
  const ignoredProposalIds = new Set((reviewAlreadyUsed ? candidates : candidates.slice(TAG_FORGE_REVIEW_CANDIDATE_LIMIT))
    .flatMap((item) => item.proposalIds))
  if (ignoredProposalIds.size > 0) {
    const repository = new TagForgeRepository(engine.getRepository().getConnection())
    engine.getRepository().transaction(() => {
      for (const proposalId of ignoredProposalIds) repository.reviewPending(proposalId, 'dismiss')
    })
    for (const item of state.items) {
      if (item.status !== 'awaiting_review') continue
      item.pending = item.pending?.filter((pending) => !ignoredProposalIds.has(pending.proposalId))
      if ((item.pending?.length ?? 0) > 0) continue
      const complete = await hasCompleteTagForgeContent(item.path, loadTagForgePolicy(), repository.listOverlay())
      item.status = complete ? 'completed' : 'failed'
      item.errorKind = complete ? null : 'insufficient_content_tags_after_review'
      item.pending = undefined
      item.pendingSubmission = undefined
    }
  }
  if (items.length === 0) return { items, question: null }
  const fingerprint = createHash('sha256').update(JSON.stringify(items.map((item) => [item.facet, item.label, item.proposalIds]))).digest('hex')
  if (state.reviewFingerprint !== fingerprint || !state.reviewRequestId) {
    state.reviewFingerprint = fingerprint
    state.reviewRequestId = `tfr-${randomUUID()}`
    state.reviewCardId = undefined
    state.reviewDecision = undefined
  }
  return { items, question: buildTagForgeReviewQuestion(state.reviewRequestId, items) }
}

function buildTagForgeReviewQuestion(requestId: string, items: TagForgeReviewItem[]): Record<string, unknown> {
  const chunks: TagForgeReviewItem[][] = []
  for (let index = 0; index < items.length; index += TAG_FORGE_REVIEW_OPTIONS_PER_QUESTION) {
    chunks.push(items.slice(index, index + TAG_FORGE_REVIEW_OPTIONS_PER_QUESTION))
  }
  return {
    questions: chunks.map((chunk, index) => ({
      id: `tag-forge-${requestId}-${index + 1}`,
      question: '请选择要采用的存疑标签。未选择的标签会被忽略。',
      kind: 'multi_choice',
      options: [...chunk.map(tagForgeReviewOption), TAG_FORGE_REVIEW_IGNORE_OPTION],
      required: false,
    })),
  }
}

function tagForgeReviewOption(item: TagForgeReviewItem): string {
  const facet = ({ form: '形态', domain: '领域', entity: '实体', use: '用途', state: '状态' } as const)[item.facet]
  const evidence = item.evidenceExcerpt ? ` | “${item.evidenceExcerpt.replace(/\s+/g, ' ').slice(0, 32)}”` : ''
  const identity = createHash('sha256').update(item.proposalIds.join('\0')).digest('hex').slice(0, 6)
  return `[${identity}] ${facet}：${item.label}${evidence}`.slice(0, 80)
}

function publicTagForgeReviewItems(items: TagForgeReviewItem[]): Array<Record<string, unknown>> {
  return items.map(({ proposalIds: _proposalIds, ...item }) => item)
}

function readTagForgeReviewConfirmation(
  db: DatabaseConnection,
  cardId: string,
  expectedArgs: Record<string, unknown>,
  runId: string | null,
  scopeId: string | null,
): { ok: true; selected: Set<string> } | { ok: false; errorKind: string } {
  if (!cardId || !runId || !scopeId) return { ok: false, errorKind: 'tag_forge_review_confirmation_required' }
  const row = db.prepare(`SELECT role,meta_json AS metaJson FROM chat_messages WHERE id=?`).get<{ role: string; metaJson: string | null }>(cardId)
  if (!row || row.role !== 'agent_card') return { ok: false, errorKind: 'tag_forge_review_card_not_found' }
  let meta: Record<string, unknown>
  try {
    meta = JSON.parse(row.metaJson || '{}') as Record<string, unknown>
  } catch {
    // silent-catch: malformed confirmation metadata is returned as an explicit invalid-card result and cannot authorize a write.
    return { ok: false, errorKind: 'tag_forge_review_card_invalid' }
  }
  const ask = meta.askUserQuestions && typeof meta.askUserQuestions === 'object' && !Array.isArray(meta.askUserQuestions)
    ? meta.askUserQuestions as Record<string, unknown>
    : null
  if (!ask || ask.status !== 'submitted' || ask.requestId !== runId) {
    return { ok: false, errorKind: 'tag_forge_review_card_not_submitted_for_run' }
  }
  if (ask.scopeId !== scopeId) return { ok: false, errorKind: 'tag_forge_review_card_scope_mismatch' }
  const expectedQuestions = canonicalReviewQuestions(expectedArgs.questions)
  const actualQuestions = canonicalReviewQuestions(ask.questions)
  if (expectedQuestions.length === 0 || JSON.stringify(actualQuestions) !== JSON.stringify(expectedQuestions)) {
    return { ok: false, errorKind: 'tag_forge_review_card_question_mismatch' }
  }
  const answers = Array.isArray(ask.answers) ? ask.answers : []
  const selected: string[] = []
  for (const question of expectedQuestions) {
    const answer = answers.find((candidate) => candidate && typeof candidate === 'object' && !Array.isArray(candidate) && (candidate as Record<string, unknown>).id === question.id) as Record<string, unknown> | undefined
    const values = answer?.answer === undefined ? [] : answer.answer
    if (!Array.isArray(values) || values.some((value) => typeof value !== 'string')) {
      return { ok: false, errorKind: 'tag_forge_review_card_answer_invalid' }
    }
    const allowed = new Set(question.options)
    if (values.some((value) => !allowed.has(String(value)))) return { ok: false, errorKind: 'tag_forge_review_card_answer_mismatch' }
    selected.push(...values.map(String).filter((value) => value !== TAG_FORGE_REVIEW_IGNORE_OPTION))
  }
  return { ok: true, selected: new Set(selected) }
}

function canonicalReviewQuestions(value: unknown): Array<{ id: string; question: string; kind: string; options: string[]; placeholder: null; required: false }> {
  if (!Array.isArray(value)) return []
  const result: Array<{ id: string; question: string; kind: string; options: string[]; placeholder: null; required: false }> = []
  for (const candidate of value) {
    if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) return []
    const question = candidate as Record<string, unknown>
    if (typeof question.id !== 'string' || typeof question.question !== 'string' || question.kind !== 'multi_choice' || !Array.isArray(question.options) || question.required !== false) return []
    result.push({
      id: question.id,
      question: question.question,
      kind: 'multi_choice',
      options: question.options.map(String),
      placeholder: null,
      required: false as const,
    })
  }
  return result
}
