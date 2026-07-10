import assert from 'node:assert/strict'
import test from 'node:test'

import type { AgentInputItem, MemorySession } from '@openai/agents'
import { AgentSdkCompactor } from '../main/modules/agent-control/runtime-core/agent-sdk-compactor'
import { prependSystemReminderInput } from '../main/modules/agent-control/system-reminders/background-task-terminal-reminder'
import {
  buildSkillCatalogText,
  CATALOG_HEADER as HEADER
} from '../main/modules/agent-control/system-reminders/skill-catalog-reminder'
import { skipIfSqliteUnavailable } from './utils/sqlite-skip'

test('agent-sdk-compactor-skill-catalog declares transitive sqlite coverage', (t) => {
  skipIfSqliteUnavailable(t, 'agent-sdk-compactor-skill-catalog transitive sqlite guard')
})

function memory(initial: AgentInputItem[]) {
  let items = [...initial]
  return {
    session: {
      getItems: async () => [...items],
      clearSession: async () => {
        items = []
      },
      addItems: async (next: AgentInputItem[]) => {
        items.push(...next)
      }
    } as unknown as MemorySession,
    read: () => items
  }
}

test('durable compaction keeps only the newest accumulated skill catalog reminder', async () => {
  const call = {
    type: 'function_call',
    callId: 'c1',
    name: 'read',
    arguments: '{}'
  } as AgentInputItem
  const result = { type: 'function_call_result', callId: 'c1', output: 'ok' } as AgentInputItem
  const fixture = memory([
    prependSystemReminderInput(
      [],
      buildSkillCatalogText([{ id: 'old-1', name: 'old-1', description: 'old-1' }])
    )[0],
    call,
    result,
    prependSystemReminderInput(
      [],
      buildSkillCatalogText([{ id: 'old-2', name: 'old-2', description: 'old-2' }])
    )[0],
    { role: 'assistant', content: 'working' } as AgentInputItem,
    prependSystemReminderInput(
      [],
      buildSkillCatalogText([{ id: 'newest', name: 'newest', description: 'newest' }])
    )[0]
  ])

  const compacted = await new AgentSdkCompactor().compactMemorySession(fixture.session, 200_000)
  assert.equal(compacted.status, 'compacted')
  const serialized = JSON.stringify(fixture.read())
  assert.equal(serialized.split(HEADER).length - 1, 1)
  assert.match(serialized, /newest/)
  assert.doesNotMatch(serialized, /old-1|old-2/)
  assert.equal(
    fixture.read().some((item) => (item as { type?: string }).type === 'function_call'),
    true
  )
  assert.equal(
    fixture.read().some((item) => (item as { type?: string }).type === 'function_call_result'),
    true
  )
})

test('catalog-shaped user and assistant messages are never treated as system reminders', async () => {
  const user = { role: 'user', content: `${HEADER}\n- user-authored` } as AgentInputItem
  const assistant = {
    role: 'assistant',
    content: `${HEADER}\n- assistant-authored`
  } as AgentInputItem
  const system = prependSystemReminderInput([], `${HEADER}\n- system`)[0]
  const fixture = memory([user, system, assistant])

  const compacted = await new AgentSdkCompactor().compactMemorySession(fixture.session, 200_000)
  assert.equal(compacted.status, 'noop')
  assert.deepEqual(fixture.read(), [user, system, assistant])
})

test('durable compaction without a skill catalog is byte-shape neutral below the soft limit', async () => {
  const original = [{ role: 'user', content: 'hello' } as AgentInputItem]
  const fixture = memory(original)
  const compacted = await new AgentSdkCompactor().compactMemorySession(fixture.session, 200_000)
  assert.equal(compacted.status, 'noop')
  assert.deepEqual(fixture.read(), original)
})

test('unrelated system reminders that quote the catalog heading are preserved', async () => {
  const quotedHeading = prependSystemReminderInput([], `请不要重复输出：${HEADER}`)[0]
  const catalog = prependSystemReminderInput(
    [],
    buildSkillCatalogText([{ id: 'writer', name: 'Writer', description: 'Writes documents' }])
  )[0]
  const fixture = memory([quotedHeading, catalog])

  const compacted = await new AgentSdkCompactor().compactMemorySession(fixture.session, 200_000)
  assert.equal(compacted.status, 'noop')
  assert.deepEqual(fixture.read(), [quotedHeading, catalog])
})
