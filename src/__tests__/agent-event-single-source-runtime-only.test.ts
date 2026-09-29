/**
 * Stage U PR U1.3 — agent:stream / agent:status / agent:error single producer.
 *
 * After U1.3, only the SDK runtime path (via ReadyAgentOrchestrator binding
 * its sdkEngine events) should be able to push to the renderer-facing
 * `agent:stream` / `agent:status` / `agent:error` channels. The legacy
 * AgentManager forwards in claude-bridge/ipc-handler.ts have been removed,
 * and the orchestrator no longer binds the DirectChatEngine's EventEmitter.
 *
 * Source-grep structural test (CLAUDE.md §6.4). Paired with
 * `legacy-agent-ipc-removed.test.ts` (U1.2) and the runtime gate
 * `check-no-legacy-agent-ipc.cjs`.
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..')

function readWorkspaceFile(rel: string): string {
  // eslint-disable-next-line ready/no-source-grep-test -- Stage U §0.7: source-grep is permitted as a structural gate when paired with a runtime gate. This test pairs with check-no-legacy-agent-ipc.cjs (U1.2).
  return readFileSync(resolve(REPO_ROOT, rel), 'utf8')
}

test('U1.3 ipc-handler: no remaining agentManager.on(output|status|error) forwards', () => {
  const source = readWorkspaceFile('src/main/modules/claude-bridge/ipc-handler.ts')
  assert.doesNotMatch(
    source,
    /agentManager\.on\(\s*['"](?:output|status|error)['"]/,
    'AgentManager event forwards must be removed in U1.3 (SDK runtime owns these channels)',
  )
})
