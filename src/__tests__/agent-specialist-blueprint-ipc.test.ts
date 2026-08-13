import assert from 'node:assert/strict'
import test from 'node:test'
import type { IpcMain, IpcMainInvokeEvent } from 'electron'

import {
  agentSpecialistBlueprintGroup,
  _agentSpecialistBlueprintGroupChannelsForTest,
} from '../main/modules/claude-bridge/ipc/agent-specialist-blueprint-group'
import type { SpecialistAgentBlueprint } from '../shared/agent-specialist-blueprint'

type Handler = (event: IpcMainInvokeEvent, payload?: unknown) => unknown

test('specialist blueprint IPC is a historical list endpoint only', async () => {
  const handlers = new Map<string, Handler>()
  const removed: string[] = []
  const ipc = {
    handle: (channel: string, handler: Handler) => handlers.set(channel, handler),
    removeHandler: (channel: string) => { removed.push(channel); handlers.delete(channel) },
  } as unknown as IpcMain
  const rows = [{ blueprintId: 'bp-history', status: 'confirmed' }] as SpecialistAgentBlueprint[]
  const handle = agentSpecialistBlueprintGroup.register(ipc, {
    getBlueprintStore: () => ({ list: () => rows }),
  })

  assert.deepEqual(_agentSpecialistBlueprintGroupChannelsForTest, ['agent:specialistBlueprint:list'])
  assert.deepEqual(await handlers.get('agent:specialistBlueprint:list')?.({} as IpcMainInvokeEvent), {
    success: true,
    data: rows,
  })
  for (const channel of [
    'agent:specialistBlueprint:upsertDraft',
    'agent:specialistBlueprint:runAdmission',
    'agent:specialistBlueprint:requestConfirmation',
    'agent:specialistBlueprint:confirmCreate',
    'agent:specialistBlueprint:reject',
    'agent:specialistBlueprint:expire',
  ]) assert.equal(handlers.has(channel), false)

  handle.dispose()
  assert.equal(removed.at(-1), 'agent:specialistBlueprint:list')
})
