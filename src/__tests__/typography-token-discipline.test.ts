import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { test } from 'node:test'
import { readRendererStyles } from './utils/read-renderer-styles'

const repoRoot = path.resolve(import.meta.dirname, '../..')

async function readRepoFile(relativePath: string): Promise<string> {
  return readFile(path.join(repoRoot, relativePath), 'utf8')
}

// Structural guard for the typography token system. A real computed-style render
// assertion (mount a surface in jsdom, read getComputedStyle role output) is the
// follow-up; this guard locks the token contract so the family/size/leading/tracking
// discipline cannot silently regress.

test('typography tokens are a single deduplicated source in @theme', async () => {
  const css = readRendererStyles()

  // Font roles: CJK-preserving stack, head/numeric defined by reference (one source).
  const tokens = await readRepoFile('src/renderer/design/next/tokens.css')
  assert.match(css, /--font-ui:\s*var\(--rn-font-ui\);/)
  assert.match(css, /--font-mono:\s*var\(--rn-font-mono\);/)
  assert.match(tokens, /--rn-font-ui:[^;]*RN Inter[^;]*PingFang SC[^;]*sans-serif;/)
  assert.match(css, /--font-head:\s*var\(--font-ui\);/)
  assert.match(css, /--font-numeric:\s*var\(--font-mono\);/)
  // The UI/body face must never become a Latin-only display font (would drop CJK).
  assert.doesNotMatch(css, /--font-ui:[^;]*\bDoto\b[^;]*;/)
  assert.doesNotMatch(tokens, /--rn-font-ui:[^;]*\bDoto\b[^;]*;/)

  // Size scale anchors.
  assert.match(css, /--text-2xs:\s*9px;/)
  assert.match(css, /--text-base:\s*12px;/)
  assert.match(css, /--text-md:\s*13px;/)
  assert.match(css, /--text-5xl:\s*64px;/)

  // Leading / tracking live under the canonical Tailwind namespaces (so they also
  // generate utilities) — the old shorthand duplicates must be gone.
  assert.match(css, /--leading-dense:\s*1\.4;/)
  assert.match(css, /--tracking-label:\s*0\.08em;/)
  assert.match(css, /--fw-semibold:\s*600;/)
  assert.doesNotMatch(css, /--lh-(none|tight|snug|normal|dense)\b/)
  assert.doesNotMatch(css, /--track-(label|tight|normal)\b/)
})

test('typography roles are global utilities with a mono label signature', async () => {
  const css = readRendererStyles()

  // Roles are plain global utility classes — not gated behind a fake skin-scoped pilot.
  assert.match(css, /\.t-body\s*\{/)
  assert.match(css, /\.t-data\s*\{/)
  assert.match(css, /\.t-numeral\s*\{/)
  assert.doesNotMatch(css, /ready-typography-pilot/)
  assert.doesNotMatch(css, /\[data-typography-role=/)

  // The label signature is mono + uppercase + wide tracking (the one intentionally
  // visible role). It was previously sans, which erased the signature.
  const labelBlock = css.match(/\.t-label\s*\{[^}]*\}/)
  assert.ok(labelBlock, '.t-label rule must exist')
  assert.match(labelBlock[0], /var\(--font-mono\)/)
  assert.match(labelBlock[0], /var\(--tracking-label\)/)
  assert.match(labelBlock[0], /text-transform:\s*uppercase/)

  // Data / numeral roles are tabular numeric so counters and timestamps don't jitter.
  assert.match(css, /\.t-numeral\s*\{[^}]*font-variant-numeric:\s*tabular-nums[^}]*\}/)
})

test('chat and task surfaces consume role utilities (no dead pilot wrapper)', async () => {
  const chatMessages = await readRepoFile('src/renderer/components/agent/ChatMessages.tsx')
  const taskCard = await readRepoFile('src/renderer/components/agent/chat-panel/task/TaskCard.tsx')

  assert.match(chatMessages, /className="t-body"/)
  assert.match(chatMessages, /data-typography-role="body"/)
  assert.match(taskCard, /data-typography-role="meta"/)
  assert.match(taskCard, /data-typography-role="data"/)

  // The scoping wrapper and the old token shorthand must not survive in components.
  assert.doesNotMatch(chatMessages, /ready-typography-pilot/)
  assert.doesNotMatch(taskCard, /ready-typography-pilot/)
  assert.doesNotMatch(taskCard, /var\(--lh-/)
  assert.doesNotMatch(taskCard, /var\(--track-/)
})
