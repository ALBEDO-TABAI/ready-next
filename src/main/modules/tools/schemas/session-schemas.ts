/**
 * Zod schemas for the session recall domain tools (Phase 2.5 PR 5).
 *
 * Today this domain has exactly one tool — session_search — but the file is
 * sized for growth so subsequent recall-style tools can plug into the same
 * registry (e.g. session_inspect, session_attach_reference).
 *
 * Pure module — Zod only.
 */

import { z } from 'zod'

export const SessionSearchSchema = z.object({
  query: z.string().optional().describe('可选，搜索关键词'),
  channelKey: z.string().optional().describe('可选，限定频道来源，例如 local:app'),
  sourceKind: z
    .enum(['local', 'channel'])
    .optional()
    .describe('可选，限定会话来源 local 或 channel'),
  hasAttachments: z.boolean().optional().describe('可选，只返回带附件的历史会话'),
  limit: z.number().optional().describe('可选，返回数量限制，默认 5'),
})

export type SessionToolName = 'session_search'

export const SESSION_SCHEMAS: Record<SessionToolName, z.ZodObject<z.ZodRawShape>> = {
  session_search: SessionSearchSchema,
}
