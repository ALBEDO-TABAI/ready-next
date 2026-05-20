import {
  FRAME_PATCH_EMITTING_TOOL_NAMES,
  isFramePatchEmittingToolName,
} from '../run-contracts'

/**
 * Phase 3 (skill-child-loop) — tools that may emit a `contextModifier` on
 * their `ToolExecutionOutput` to live-update the runtime's `activeFrame`
 * slot for dependent later tools in the SAME batch.
 *
 * The contract: any tool listed here must NOT join a parallel-safe group
 * along with a tool that depends on its `activeFrame` updates (e.g. a
 * `skill_read_artifact` that reads VEA's freshly-produced `outputDir`).
 *
 * This list is the union of:
 *   - `FRAME_PATCH_EMITTING_TOOL_NAMES` — tools that already emit durable
 *     end-of-turn frame patches, all of which surface `outputDir` /
 *     handles a later tool may need to see in-turn.
 *   - VEA typed-action wrappers `skill_video_expert_pipeline` and
 *     `skill_video_expert_ai_analyze`, whose typed-action result carries
 *     a fresh `outputDir` (also exposed via `contextModifier`).
 *
 * The existing `getToolResourceTag` already classifies all of the above
 * names as `interactive`, which forces serialization. This constant is
 * the explicit, type-checked source of truth for Phase 3's contract;
 * use it from any new gate that needs to know whether a tool will
 * mutate the live active-frame slot.
 */
export const CONTEXT_MUTATING_TOOL_NAMES: readonly string[] = [
  ...FRAME_PATCH_EMITTING_TOOL_NAMES,
  'skill_video_expert_pipeline',
  'skill_video_expert_ai_analyze',
] as const

/**
 * Predicate matching any tool name that may emit a `contextModifier` —
 * either a static name in `CONTEXT_MUTATING_TOOL_NAMES` or any dynamic
 * typed-action wrapper (`skill_<id>_<action>`) covered by
 * `isFramePatchEmittingToolName`.
 */
export function isContextMutatingToolName(toolName: string): boolean {
  if (!toolName || typeof toolName !== 'string') return false
  if (CONTEXT_MUTATING_TOOL_NAMES.includes(toolName)) return true
  return isFramePatchEmittingToolName(toolName)
}

export interface ParallelToolCall {
  id: string
  name: string
  input: Record<string, unknown>
}

export interface ParallelToolGroup {
  mode: 'parallel' | 'serial'
  toolCalls: ParallelToolCall[]
}

export interface ToolResourceTag {
  domain: 'browser' | 'document' | 'file' | 'rss' | 'calendar' | 'feishu' | 'skill' | 'memory' | 'session' | 'pet' | 'system' | 'general_research' | 'mcp' | 'agent_interaction'
  accessMode: 'read' | 'write' | 'interactive'
}

const READ_ONLY_DOCUMENT_TOOL_NAMES = new Set([
  'document_list_widgets',
])

const READ_ONLY_RSS_TOOL_NAMES = new Set([
  'rss_capture_session',
])

const READ_ONLY_CALENDAR_TOOL_NAMES = new Set([
  'calendar_list_window',
])

const READ_ONLY_FEISHU_TOOL_NAMES = new Set([
  'feishu_doc_read',
  'feishu_doc_list',
  'feishu_message_get_context',
  'feishu_calendar_list_events',
  'feishu_chat_list',
  'feishu_chat_get_members',
  'feishu_chat_get_info',
  'feishu_file_download',
])

const READ_ONLY_SKILL_TOOL_NAMES = new Set([
  'skill_rss_status',
  'skill_rss_list',
  'skill_rss_stats',
])

/**
 * Stage D9 — runtime invariant: no tool that emits a `framePatch.runContract`
 * (and therefore mutates durable cross-turn state) can ever be marked as
 * read-only parallel-safe. Failing this check at module load is intentional —
 * a regression here would silently cause two frame-patch emitters to run in
 * the same parallel group and clobber each other's contract updates.
 */
;(function assertNoFramePatchInReadOnlySkills(): void {
  const overlap = FRAME_PATCH_EMITTING_TOOL_NAMES.filter((name) => READ_ONLY_SKILL_TOOL_NAMES.has(name))
  if (overlap.length > 0) {
    throw new Error(
      `tool-parallelism-policy invariant violated: framePatch-emitting tools must not be read-only parallel-safe. Offending: ${overlap.join(', ')}`,
    )
  }
  // Phase 3 (skill-child-loop) — same invariant for context-mutating tools:
  // anything that may live-update the runtime `activeFrame` cannot be
  // marked read-only parallel-safe, otherwise dependent later tools in
  // the same parallel chunk could observe stale roots/handles.
  const ctxOverlap = CONTEXT_MUTATING_TOOL_NAMES.filter((name) => READ_ONLY_SKILL_TOOL_NAMES.has(name))
  if (ctxOverlap.length > 0) {
    throw new Error(
      `tool-parallelism-policy invariant violated: context-mutating tools must not be read-only parallel-safe. Offending: ${ctxOverlap.join(', ')}`,
    )
  }
})()

export function getToolResourceTag(toolName: string): ToolResourceTag {
  const normalized = String(toolName || '').trim()

  if (normalized.startsWith('browser_')) {
    return { domain: 'browser', accessMode: 'interactive' }
  }
  if (normalized.startsWith('document_')) {
    return {
      domain: 'document',
      accessMode: READ_ONLY_DOCUMENT_TOOL_NAMES.has(normalized) ? 'read' : 'write',
    }
  }
  if (normalized.startsWith('file_')) {
    const writeFileTools = new Set(['file_classify', 'file_rename', 'file_move'])
    return {
      domain: 'file',
      accessMode: writeFileTools.has(normalized) ? 'write' : 'read',
    }
  }
  if (normalized.startsWith('rss_')) {
    return {
      domain: 'rss',
      accessMode: READ_ONLY_RSS_TOOL_NAMES.has(normalized) ? 'read' : 'write',
    }
  }
  if (normalized.startsWith('calendar_')) {
    return {
      domain: 'calendar',
      accessMode: READ_ONLY_CALENDAR_TOOL_NAMES.has(normalized) ? 'read' : 'write',
    }
  }
  if (normalized.startsWith('feishu_')) {
    return {
      domain: 'feishu',
      accessMode: READ_ONLY_FEISHU_TOOL_NAMES.has(normalized) ? 'read' : 'write',
    }
  }
  if (normalized.startsWith('memory_')) {
    return { domain: 'memory', accessMode: 'read' }
  }
  if (normalized.startsWith('session_')) {
    return { domain: 'session', accessMode: 'read' }
  }
  if (normalized.startsWith('pet_')) {
    return { domain: 'pet', accessMode: 'write' }
  }
  if (normalized.startsWith('skill_')) {
    // Stage D9 — explicit `READ_ONLY_SKILL_TOOL_NAMES` is the authoritative
    // override list (currently RSS-only). The static
    // `FRAME_PATCH_EMITTING_TOOL_NAMES` and the read-only set must never
    // overlap (enforced by the module-load invariant above), so the
    // read-only set wins here without contradicting the framePatch invariant.
    //
    // For any other `skill_<id>_<action>` name not in the read-only set,
    // `isFramePatchEmittingToolName` returns true and we fall through to
    // `interactive` — matching the original behaviour where unknown skill
    // tools are non-parallel-safe.
    if (READ_ONLY_SKILL_TOOL_NAMES.has(normalized)) {
      return { domain: 'skill', accessMode: 'read' }
    }
    if (isFramePatchEmittingToolName(normalized)) {
      return { domain: 'skill', accessMode: 'interactive' }
    }
    return { domain: 'skill', accessMode: 'interactive' }
  }
  // Stage R W1.1/W1.2/W6.4 — `general_research` group tools. Read-safe HTTP
  // calls (`web_search` / `web_fetch`) join parallel groups; `present_file`
  // is interactive (renderer IPC) so it serializes. `web_clip_url` writes
  // a file + calls present_file so it is also interactive / serialized.
  if (normalized === 'web_search') return { domain: 'general_research', accessMode: 'read' }
  if (normalized === 'web_fetch') return { domain: 'general_research', accessMode: 'read' }
  if (normalized === 'present_file') return { domain: 'general_research', accessMode: 'interactive' }
  if (normalized === 'web_clip_url') return { domain: 'general_research', accessMode: 'interactive' }
  // Stage T PR-T5 — MCP tools advertised as `mcp_*` are dispatched to the
  // mcp client and are interactive by default (the client makes a remote
  // call per invocation, no parallelism guarantee from the server side).
  if (normalized.startsWith('mcp_')) return { domain: 'mcp', accessMode: 'interactive' }
  // agent_interaction group — the model pauses the turn waiting for the user
  // to answer N inline question cards. Serialized so the same session never
  // has two ask_user_questions cards pending in parallel.
  if (normalized === 'ask_user_questions') return { domain: 'agent_interaction', accessMode: 'interactive' }
  return { domain: 'system', accessMode: 'interactive' }
}

export function isParallelSafeTool(toolName: string): boolean {
  return getToolResourceTag(toolName).accessMode === 'read'
}

function canJoinParallelGroup(buffer: ParallelToolCall[], toolCall: ParallelToolCall): boolean {
  const candidate = getToolResourceTag(toolCall.name)
  if (candidate.accessMode === 'interactive') return false
  return buffer.every((existing) => {
    const current = getToolResourceTag(existing.name)
    if (current.accessMode === 'interactive') return false
    if (candidate.domain === current.domain && (candidate.accessMode === 'write' || current.accessMode === 'write')) {
      return false
    }
    return true
  })
}

export function groupParallelSafeToolCalls(toolCalls: ParallelToolCall[]): ParallelToolGroup[] {
  const groups: ParallelToolGroup[] = []
  let parallelBuffer: ParallelToolCall[] = []

  const flushParallelBuffer = () => {
    if (parallelBuffer.length === 0) return
    groups.push({
      mode: parallelBuffer.length > 1 ? 'parallel' : 'serial',
      toolCalls: parallelBuffer,
    })
    parallelBuffer = []
  }

  for (const toolCall of toolCalls) {
    if (canJoinParallelGroup(parallelBuffer, toolCall)) {
      parallelBuffer.push(toolCall)
      continue
    }
    flushParallelBuffer()
    const tag = getToolResourceTag(toolCall.name)
    if (tag.accessMode === 'interactive') {
      groups.push({
        mode: 'serial',
        toolCalls: [toolCall],
      })
      continue
    }
    parallelBuffer.push(toolCall)
  }

  flushParallelBuffer()
  return groups
}
