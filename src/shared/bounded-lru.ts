export class BoundedLruCache<K, V> {
  private readonly values = new Map<K, V>()

  constructor(private readonly capacity: number) {
    if (!Number.isInteger(capacity) || capacity < 1) throw new Error('capacity must be a positive integer')
  }

  get(key: K): V | undefined {
    const value = this.values.get(key)
    if (value === undefined) return undefined
    this.values.delete(key)
    this.values.set(key, value)
    return value
  }

  set(key: K, value: V): void {
    this.values.delete(key)
    this.values.set(key, value)
    while (this.values.size > this.capacity) {
      const oldest = this.values.keys().next().value as K | undefined
      if (oldest === undefined) break
      this.values.delete(oldest)
    }
  }

  delete(key: K): void {
    this.values.delete(key)
  }

  clear(): void {
    this.values.clear()
  }

  get size(): number {
    return this.values.size
  }

  keys(): K[] {
    return Array.from(this.values.keys())
  }
}
