import type { ReadyRef } from '../../../shared/ready-ref'
export interface RelationItem {
  id: string
  title: string
  ref: ReadyRef | null
  sourceType: string
  reason: string | null
  relation: string
}
export interface ObjectRelations {
  outgoing: RelationItem[]
  incoming: RelationItem[]
  backlinkCount: number
  truncated: boolean
}
export type ObjectRelationsResult = { ok: true; value: ObjectRelations } | { ok: false; message: string }
export interface ObjectRelationsAPI { query(objectId: string): Promise<ObjectRelationsResult> }
