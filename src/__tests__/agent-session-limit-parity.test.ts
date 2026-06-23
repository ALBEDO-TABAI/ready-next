/**
 * Anti-regression: the renderer session-tab cap and the main-process
 * orchestrator admission cap MUST be the SAME number.
 *
 * History: the renderer raised its "+" enable/disable cap to 5 while the
 * orchestrator still rejected past 3, so sessions 4–5 looked creatable in the
 * UI but failed with `session_limit_exceeded` on the first send / background
 * create. Each side's own test passed in isolation — exactly the gap a parity
 * check closes. The fix made `src/shared/agent-session-limits.ts` the single
 * source of truth; this test fails if either side ever hardcodes its own value
 * again.
 *
 * The renderer side is checked at runtime (its module loads under tsx). The
 * main orchestrator cannot be imported under `node --test` (electron-only
 * imports), so it is checked structurally — it must import and assign the
 * shared constant, never a literal.
 */

import assert from 'node:assert/strict'
import test from 'node:test'
import { readFileSync } from 'node:fs'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

import { MAX_AGENT_SESSIONS as SHARED_MAX } from '../shared/agent-session-limits'
import { MAX_AGENT_SESSIONS as RENDERER_MAX } from '../renderer/stores/useAgent'

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..')

function readSource(relPath: string): string {
  return readFileSync(resolve(REPO_ROOT, relPath), 'utf8')
}

test('renderer session cap equals the shared single-source-of-truth constant', () => {
  assert.equal(
    RENDERER_MAX,
    SHARED_MAX,
    'useAgent must re-export MAX_AGENT_SESSIONS from src/shared/agent-session-limits, not redefine it',
  )
})

test('main orchestrator sources its concurrent-session cap from the shared constant', () => {
  // eslint-disable-next-line ready/no-source-grep-test -- the orchestrator pulls electron-only imports and cannot run under node:test; this structurally proves it shares the renderer's cap constant (the parity contract) rather than hardcoding a number.
  const orchestrator = readSource('src/main/modules/agent-control/runtime-core/orchestrator.ts')

  assert.match(
    orchestrator,
    /import \{ MAX_AGENT_SESSIONS \} from '\.\.\/\.\.\/\.\.\/\.\.\/shared\/agent-session-limits'/,
    'orchestrator must import MAX_AGENT_SESSIONS from the shared module',
  )
  assert.match(
    orchestrator,
    /MAX_CONCURRENT_SESSIONS\s*=\s*MAX_AGENT_SESSIONS/,
    'orchestrator cap must be assigned from MAX_AGENT_SESSIONS, never a literal',
  )
  assert.doesNotMatch(
    orchestrator,
    /MAX_CONCURRENT_SESSIONS\s*=\s*\d/,
    'orchestrator cap must not be hardcoded to a number',
  )
})

test('renderer "+" disable affordance is driven by the shared cap constant', () => {
  // eslint-disable-next-line ready/no-source-grep-test -- locks the visible affordance to the same constant the guard uses, so the button cannot be re-pinned to a divergent literal.
  const chatPanel = readSource('src/renderer/components/agent/ChatPanel.tsx')
  assert.match(
    chatPanel,
    /isLiveSession\(s, id\)\)\.length < MAX_AGENT_SESSIONS/,
    'the "+" enable check must compare the live-session count against MAX_AGENT_SESSIONS',
  )
})
