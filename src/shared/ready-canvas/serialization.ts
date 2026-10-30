import { ReadyCanvasSchema, type ReadyCanvas } from './schema'

/** JSON-only, recursively sorted keys; arrays preserve drawing order. Reject lossy JS values. */
export function stableJson(value: unknown): string {
  function sorted(input: unknown): unknown {
    if (input === null || typeof input === 'string' || typeof input === 'boolean') return input
    if (typeof input === 'number' && Number.isFinite(input)) return input
    if (Array.isArray(input)) return input.map(sorted)
    if (typeof input === 'object' && input && Object.getPrototypeOf(input) === Object.prototype) {
      return Object.fromEntries(Object.keys(input).sort().map(key => [key, sorted(Reflect.get(input, key))]))
    }
    throw new Error('Canvas extensions must contain JSON values only')
  }
  return JSON.stringify(sorted(value), null, 2)
}
export function serializeCanvas(input: ReadyCanvas): string {
  const canvas = ReadyCanvasSchema.parse(input)
  // Keep the three standard/root entries first; extension keys have deterministic order.
  const extra = Object.fromEntries(Object.entries(canvas).filter(([key]) => !['nodes', 'edges', 'ready'].includes(key)))
  const ordered = { nodes: JSON.parse(stableJson(canvas.nodes)), edges: JSON.parse(stableJson(canvas.edges)), ready: JSON.parse(stableJson(canvas.ready)), ...JSON.parse(stableJson(extra)) }
  return JSON.stringify(ordered, null, 2) + '\n'
}
export async function sha256(value: string | Uint8Array): Promise<string> {
  const bytes = typeof value === 'string' ? new TextEncoder().encode(value) : Uint8Array.from(value)
  return Array.from(new Uint8Array(await globalThis.crypto.subtle.digest('SHA-256', bytes)), b => b.toString(16).padStart(2, '0')).join('')
}
