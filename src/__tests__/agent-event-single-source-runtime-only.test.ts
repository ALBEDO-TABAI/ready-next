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

test('U1.3 orchestrator: bindEngineEvents only on sdkEngine, not domainAdapterEngine', () => {
  const source = readWorkspaceFile('src/main/modules/agent-control/runtime-core/orchestrator.ts')
  // Only sdkEngine should be bound. Phase C C3 起 DomainAdapterHost 承载
  // 适配器与依赖接线，任何引擎/宿主都不得成为 renderer 事件发射者。
  assert.match(
    source,
    /this\.bindEngineEvents\(this\.sdkEngine\)/,
    'sdkEngine event binding must remain (single producer)',
  )
  assert.doesNotMatch(
    source,
    /this\.bindEngineEvents\(this\.domainAdapterEngine\)/,
    'DirectChatEngine event binding must be removed in U1.3 (no dual-shape emission)',
  )
})

test('U1.3 retirement is announced in code comments', () => {
  const ipc = readWorkspaceFile('src/main/modules/claude-bridge/ipc-handler.ts')
  assert.match(
    ipc,
    /U1\.3.*legacy AgentManager event forwards removed/i,
    'ipc-handler must contain the U1.3 retirement note',
  )
  const orchestrator = readWorkspaceFile('src/main/modules/agent-control/runtime-core/orchestrator.ts')
  // 合同随实现同步（Phase C C3，2026-07-05）：引擎退役后注释改述为
  // "legacy engine fully out of this loop / SDK runtime is the single
  // emission producer"——不变量（退役声明 + 单一发射者）不变，锚随行文。
  assert.match(
    orchestrator,
    /U1\.3[\s\S]*Phase C C3[\s\S]*single renderer-facing emission producer/,
    'orchestrator must contain the U1.3/Phase-C retirement note',
  )
})
