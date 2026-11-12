import { toReadyUri, type ReadyRef } from '../../../shared/ready-ref'
import type { ReadySkillReference } from '../agent/chat-input-bridge'

let gesture: { uri: string; skill: ReadySkillReference } | null = null
export function beginSkillDrag(ref: ReadyRef, skill: ReadySkillReference) { gesture = { uri: toReadyUri(ref), skill } }
export function endSkillDrag() { gesture = null }
export function draggedSkill(ref: ReadyRef): ReadySkillReference | null { return gesture?.uri === toReadyUri(ref) ? gesture.skill : null }
