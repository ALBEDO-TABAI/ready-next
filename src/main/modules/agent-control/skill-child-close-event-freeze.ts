import type {
  MutableSkillChildCloseEvent,
  SkillChildCloseEvent,
} from './skill-child-run-types'

export function freezeSkillChildCloseEvent(
  close: MutableSkillChildCloseEvent,
): SkillChildCloseEvent {
  return deepFreeze(close)
}

function deepFreeze<T>(value: T, seen = new WeakSet<object>()): T {
  if (!value || typeof value !== 'object') return value
  if (seen.has(value)) return value
  seen.add(value)

  for (const key of Reflect.ownKeys(value)) {
    deepFreeze((value as Record<PropertyKey, unknown>)[key], seen)
  }

  return Object.freeze(value)
}
