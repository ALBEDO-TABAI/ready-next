/**
 * Stage R W2.3 — boot-time invariant for tool-name uniqueness across
 * capability groups.
 *
 * Before Stage R the `listToolDefinitions()` aggregator silently
 * deduplicated tools sharing a name across different capability groups
 * (first writer wins). That hid genuine name collisions — e.g. a new
 * dynamic skill action that accidentally clashes with a static tool in
 * another group — until they manifested as wrong-handler dispatches
 * downstream. We now keep the silent dedup for *intra-group* duplicates
 * (legitimate static + dynamic registration of the same name) but
 * throw on *inter-group* clashes so the violation surfaces at boot.
 */

export interface ToolNameCollision {
  name: string
  existingGroup: string
  incomingGroup: string
}

export class ToolNameCollisionError extends Error {
  readonly collisions: ToolNameCollision[]

  constructor(collisions: ToolNameCollision[]) {
    super(
      `Tool name collision detected: ${collisions
        .map((c) => `${c.name} (${c.existingGroup} vs ${c.incomingGroup})`)
        .join('; ')}`,
    )
    this.name = 'ToolNameCollisionError'
    this.collisions = collisions
  }
}
