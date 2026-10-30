import { randomUUID } from 'node:crypto'
import type { ObjectLocation } from '../../shared/object-identity'
// Minimal Main identity substitute for non-SQLite attachment contract tests.
// Real registration and rename stability are exercised in the native C2 suite.
const objects = new Map<string, ObjectLocation>()
export function resolveTestObject(path: string): ObjectLocation {
  let object = objects.get(path)
  if (!object) { object = { objectId: randomUUID(), path, revision: 1 }; objects.set(path, object) }
  return object
}
