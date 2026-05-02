/**
 * Phase 1 — Skill Child Run identity helper.
 *
 * Long-running skills run under a child-run boundary that owns its own loop,
 * abort controller, transcript/log, and close event. Each child run carries
 * a typed id that identifies its kind without ambiguity. Compared with UUIDs,
 * this is shorter, sortable enough, and self-classifying — the prefix tells
 * the parent turn what kind of close event to expect.
 *
 * Identity rules (source plan §5.1):
 *   - kind 'vea'      -> prefix 'v'
 *   - kind 'skill'    -> prefix 's'
 *   - kind 'detached' -> prefix 'd'
 *   - 8 base36 lowercase chars body
 *   - final pattern: /^[vsd][a-z0-9]{8}$/
 *
 * Do NOT use UUIDs for new child runs.
 */

import { randomBytes } from 'node:crypto'

export type SkillChildRunKind = 'vea' | 'skill' | 'detached'

const KIND_PREFIX: Record<SkillChildRunKind, string> = {
  vea: 'v',
  skill: 's',
  detached: 'd',
}

const PREFIX_TO_KIND: Record<string, SkillChildRunKind> = {
  v: 'vea',
  s: 'skill',
  d: 'detached',
}

const ID_BODY_LENGTH = 8
const ID_PATTERN = /^[vsd][a-z0-9]{8}$/

/**
 * Generate an 8-char base36 lowercase body from cryptographically strong
 * random bytes. We oversample (12 bytes -> bigint -> base36) and slice to 8
 * chars so the distribution is uniform over the 36^8 space. Re-roll if the
 * sliced body falls below 8 chars after stripping leading zeros.
 */
function generateBase36Body(): string {
  // 12 random bytes -> ~96 bits of entropy, more than enough for 36^8 (~2.8e12)
  // distinct ids before collision probability becomes meaningful.
  while (true) {
    const buf = randomBytes(12)
    let acc = 0n
    for (const byte of buf) {
      acc = (acc << 8n) | BigInt(byte)
    }
    const str = acc.toString(36)
    if (str.length >= ID_BODY_LENGTH) {
      return str.slice(-ID_BODY_LENGTH)
    }
    // Extremely unlikely path; loop and resample.
  }
}

export function createSkillChildRunId(kind: SkillChildRunKind): string {
  const prefix = KIND_PREFIX[kind]
  if (!prefix) {
    throw new Error(`Unknown SkillChildRunKind: ${String(kind)}`)
  }
  return `${prefix}${generateBase36Body()}`
}

export function isSkillChildRunId(value: unknown): value is string {
  return typeof value === 'string' && ID_PATTERN.test(value)
}

export function getSkillChildRunKind(id: string): SkillChildRunKind | null {
  if (!isSkillChildRunId(id)) return null
  const prefix = id.charAt(0)
  return PREFIX_TO_KIND[prefix] ?? null
}
