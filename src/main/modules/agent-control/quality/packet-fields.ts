/**
 * EP3-PK1 — packet field conventions (09 §2). Packets are a usage convention
 * on task_projections, NOT a new table:
 *  - packet_role: 'parent' | 'child' | NULL is the ONLY packet marker — UI,
 *    statistics, DomainAdapters, and tests all key on it.
 *  - context_refs: reference strings (file paths / card slugs / parent
 *    packet ids) — references, never retellings (05 最小传话).
 *  - nesting: TWO levels maximum (parent → child). A child can never parent
 *    another packet; a packet may not sit under another packet as 'parent'.
 *    Deeper needs mean the task should split into multiple top-level tasks.
 */

export type PacketRole = 'parent' | 'child'

export const PACKET_ROLES: ReadonlyArray<PacketRole> = ['parent', 'child']

const MAX_CONTEXT_REF_LENGTH = 300

export function validatePacketFields(input: {
  packetRole?: PacketRole | null
  contextRefs?: ReadonlyArray<string> | null
}): void {
  if ('packetRole' in input && input.packetRole !== null && input.packetRole !== undefined) {
    if (!(PACKET_ROLES as readonly string[]).includes(String(input.packetRole))) {
      throw new Error(`[packet-fields] illegal packet_role: ${String(input.packetRole)} (closed union parent|child|NULL)`)
    }
  }
  if ('contextRefs' in input && input.contextRefs !== null && input.contextRefs !== undefined) {
    if (!Array.isArray(input.contextRefs)) {
      throw new Error('[packet-fields] contextRefs must be an array of reference strings — 只传引用不传转述')
    }
    for (const ref of input.contextRefs) {
      if (typeof ref !== 'string' || !ref.trim() || ref.length > MAX_CONTEXT_REF_LENGTH) {
        throw new Error(`[packet-fields] contextRefs entry must be a short reference string: ${String(ref).slice(0, 80)}`)
      }
    }
  }
}

export interface PacketDepthRow {
  taskId: string
  packetRole?: PacketRole | string | null
  parentTaskId?: string | null
}

/**
 * Two-level hard cap. `lookup` resolves a parent row (projection store or
 * fixture). Throws on: a child whose parent is itself a child (three levels),
 * and a 'parent' packet nested under another packet.
 */
export function assertPacketDepth(
  candidate: PacketDepthRow,
  lookup: (taskId: string) => PacketDepthRow | null,
): void {
  if (!candidate.packetRole) return // ordinary tasks: no packet constraints
  const parentId = candidate.parentTaskId ?? null
  if (candidate.packetRole === 'parent') {
    if (parentId) {
      const above = lookup(parentId)
      if (above?.packetRole) {
        throw new Error('[packet-fields] a parent packet cannot nest under another packet（两层上限）')
      }
    }
    return
  }
  // child: parent must exist and must be a 'parent' packet — never a child
  if (!parentId) {
    throw new Error('[packet-fields] a child packet requires parentTaskId')
  }
  const parent = lookup(parentId)
  if (!parent || parent.packetRole !== 'parent') {
    throw new Error('[packet-fields] child packets may only hang under a parent packet — 三层嵌套被拒（两层 depth 上限）')
  }
}
