import type {
  ParentSteeringReceipt,
  SteeringMessageContentInput,
  SteeringMessageResourceRef,
} from '../../../shared/browser-workflow-control'
import {
  parseObjectStrict,
  serializeWorkflowJson,
  workflowDigest,
} from './browser-workflow-codec'
import type {
  DurableWriteResult,
  WorkflowDatabaseAccessor,
} from './browser-workflow-unit-of-work'
import { BrowserWorkflowUnitOfWork } from './browser-workflow-unit-of-work'
import {
  readWorkflowParent,
  type BrowserWorkflowParentRecord,
} from './browser-workflow-row-mapping'
import type { PersistSteeringInput } from './agent-session-checkpoint-types'

interface ChatMessageRow {
  id: string
  conversation_id: string
  role: string
  content: string
  timestamp: string
  meta_json?: string | null
}

interface SteeringMessageResourceRow {
  resource_id: string
  message_id: string
  ordinal: number
  block_type: 'text' | 'image' | 'video'
  media_type: string | null
  content: string
  content_digest: string
  provenance_digest: string
}

function sanitizeSteeringText(text: string): string {
  return String(text || '')
    .replace(/^\s*-\s*路径:\s*[^\n]*$/gm, '- 资源路径: [resource-layer]')
}

function steeringResourceDrafts(input: {
  messageId: string
  content: SteeringMessageContentInput
}): Array<SteeringMessageResourceRef & { content: string }> {
  const blocks = typeof input.content === 'string'
    ? [{ type: 'text' as const, text: input.content }]
    : input.content
  return blocks.map((block, ordinal) => {
    const blockType = block.type
    const mediaType = blockType === 'text' ? null : String(block.mimeType || '').trim() || null
    const content = blockType === 'text'
      ? sanitizeSteeringText(String(block.text || ''))
      : String(block.base64 || '')
    if (blockType !== 'text' && !content) throw new Error('steering_media_resource_empty')
    const contentDigest = workflowDigest({ blockType, mediaType, content })
    const provenanceDigest = workflowDigest({
      contract: 'ready_steering_resource_v1',
      messageId: input.messageId,
      ordinal,
      blockType,
      mediaType,
      contentDigest,
    })
    return {
      resourceId: `steering-resource-${provenanceDigest}`,
      ordinal,
      blockType,
      mediaType,
      contentDigest,
      provenanceDigest,
      content,
    }
  })
}

function sanitizeSteeringMessageMeta(
  meta: Record<string, unknown> | undefined,
  resourceRefs: SteeringMessageResourceRef[],
): Record<string, unknown> {
  const source = meta || {}
  const attachments = Array.isArray(source.attachments)
    ? source.attachments.map((item) => {
        if (!item || typeof item !== 'object' || Array.isArray(item)) return null
        const value = item as Record<string, unknown>
        return {
          id: typeof value.id === 'string' ? value.id : null,
          name: typeof value.name === 'string' ? value.name : null,
          type: typeof value.type === 'string' ? value.type : null,
          source: typeof value.source === 'string' ? value.source : null,
          size: typeof value.size === 'number' ? value.size : null,
        }
      }).filter(Boolean)
    : undefined
  return {
    ...source,
    ...(attachments ? { attachments } : {}),
    readySteeringResources: resourceRefs,
  }
}

const readParent = readWorkflowParent

function changed(result: unknown): number {
  return Number((result as { changes?: unknown } | null)?.changes || 0)
}

export class AgentSessionCheckpointSteeringRepository {
  constructor(
    private readonly accessor: WorkflowDatabaseAccessor,
    readonly unitOfWork: BrowserWorkflowUnitOfWork,
  ) {}

  async persistCanonicalMessageAndSteer(input: PersistSteeringInput): Promise<DurableWriteResult<{
    parent: BrowserWorkflowParentRecord
    receipt: ParentSteeringReceipt
  }>> {
    return this.unitOfWork.commitCoreCloseout({
      writeCore: (db) => {
        const parent = readParent(db, input.parentTaskId)
        if (parent.runId !== input.ownerRunId) throw new Error('steering_owner_mismatch')
        const liveRun = db.prepare(
          `SELECT status FROM run_meta WHERE run_id = ? AND task_id = ? LIMIT 1`,
        ).get<{ status: string }>(input.ownerRunId, input.parentTaskId)
        if (liveRun?.status !== 'running') throw new Error('steering_owner_not_running')

        const resources = steeringResourceDrafts({
          messageId: input.message.id,
          content: input.message.structuredContent,
        })
        const resourceRefs: SteeringMessageResourceRef[] = resources.map(({ content: _content, ...ref }) => ref)
        const contentDigest = workflowDigest({ version: 1, resourceRefs })
        const sanitizedMeta = sanitizeSteeringMessageMeta(input.message.meta, resourceRefs)
        for (const resource of resources) {
          db.prepare(
            `INSERT INTO agent_steering_message_resources (
              resource_id, message_id, ordinal, block_type, media_type, content,
              content_digest, provenance_digest, created_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(resource_id) DO NOTHING`,
          ).run(
            resource.resourceId,
            input.message.id,
            resource.ordinal,
            resource.blockType,
            resource.mediaType,
            resource.content,
            resource.contentDigest,
            resource.provenanceDigest,
            input.message.timestamp,
          )
          const readback = db.prepare(
            `SELECT resource_id, message_id, ordinal, block_type, media_type, content,
                    content_digest, provenance_digest
               FROM agent_steering_message_resources WHERE resource_id = ? LIMIT 1`,
          ).get<SteeringMessageResourceRow>(resource.resourceId)
          if (
            !readback
            || readback.message_id !== input.message.id
            || readback.ordinal !== resource.ordinal
            || readback.block_type !== resource.blockType
            || readback.media_type !== resource.mediaType
            || readback.content_digest !== resource.contentDigest
            || readback.provenance_digest !== resource.provenanceDigest
            || workflowDigest({
              blockType: readback.block_type,
              mediaType: readback.media_type,
              content: readback.content,
            }) !== resource.contentDigest
          ) throw new Error('steering_resource_readback_mismatch')
        }

        const canonicalValue = {
          id: input.message.id,
          conversationId: input.message.conversationId,
          role: 'user',
          content: input.message.content,
          timestamp: input.message.timestamp,
        }
        const digest = workflowDigest(canonicalValue)
        const existing = parent.steeringReceipts.find((receipt) => receipt.messageId === input.message.id)

        db.prepare(
          `INSERT INTO chat_messages (id, conversation_id, role, content, timestamp, meta_json)
           VALUES (?, ?, 'user', ?, ?, ?)
           ON CONFLICT(id) DO NOTHING`,
        ).run(
          input.message.id,
          input.message.conversationId,
          input.message.content,
          input.message.timestamp,
          serializeWorkflowJson(sanitizedMeta, 'steering_message_meta'),
        )
        const canonical = db.prepare(
          `SELECT id, conversation_id, role, content, timestamp, meta_json
             FROM chat_messages WHERE id = ? LIMIT 1`,
        ).get<ChatMessageRow>(input.message.id)
        if (!canonical || canonical.role !== 'user' || canonical.conversation_id !== input.message.conversationId) {
          throw new Error('canonical_steering_message_readback_failed')
        }
        const canonicalDigest = workflowDigest({
          id: canonical.id,
          conversationId: canonical.conversation_id,
          role: canonical.role,
          content: canonical.content,
          timestamp: canonical.timestamp,
        })
        if (canonicalDigest !== digest) throw new Error('canonical_steering_message_digest_mismatch')
        const canonicalMeta = parseObjectStrict<Record<string, unknown>>(
          canonical.meta_json || '{}',
          'canonical_steering_message_meta_json',
        )
        if (workflowDigest(canonicalMeta) !== workflowDigest(sanitizedMeta)) {
          throw new Error('canonical_steering_message_meta_mismatch')
        }
        if (existing) {
          if (
            existing.messageDigest !== digest
            || existing.contentVersion !== 1
            || existing.contentDigest !== contentDigest
            || workflowDigest(existing.resourceRefs) !== workflowDigest(resourceRefs)
          ) throw new Error('steering_message_digest_conflict')
          return { parent, receipt: existing }
        }

        const receipt: ParentSteeringReceipt = {
          receiptId: `steering-${input.message.id}`,
          messageId: input.message.id,
          messageDigest: digest,
          sequence: parent.steeringReceipts.reduce((max, item) => Math.max(max, item.sequence), 0) + 1,
          ownerRunIdAtIngress: input.ownerRunId,
          wakeClaimedByRunId: null,
          contentCheckpointId: null,
          consumedByOwnerRunId: null,
          contentVersion: 1,
          contentDigest,
          resourceRefs,
          createdAt: input.message.timestamp,
        }
        const receipts = [...parent.steeringReceipts, receipt]
        const update = db.prepare(
          `UPDATE task_projections
              SET steering_receipts_json = ?, revision = revision + 1, updated_at = ?
            WHERE task_id = ? AND revision = ? AND run_id = ?`,
        ).run(
          serializeWorkflowJson(receipts, 'steering_receipts_json'),
          input.message.timestamp,
          parent.taskId,
          parent.revision,
          input.ownerRunId,
        )
        if (changed(update) !== 1) throw new Error('steering_parent_revision_conflict')
        return { parent: readParent(db, parent.taskId), receipt }
      },
      repairDerived: input.repairDerivedState
        ? async () => {
            const canonical = {
              id: input.message.id,
              conversationId: input.message.conversationId,
              role: 'user' as const,
              content: input.message.content,
              timestamp: input.message.timestamp,
              meta: sanitizeSteeringMessageMeta(
                input.message.meta,
                steeringResourceDrafts({
                  messageId: input.message.id,
                  content: input.message.structuredContent,
                }).map(({ content: _content, ...ref }) => ref),
              ),
            }
            await input.repairDerivedState?.(canonical, workflowDigest(canonical))
          }
        : undefined,
    })
  }

  hasPendingSteering(parentTaskId: string): boolean {
    const db = this.accessor.getRawDb()
    if (!db) throw new Error('Database not available')
    return readParent(db, parentTaskId).steeringReceipts.some((receipt) => !receipt.contentCheckpointId)
  }
}
