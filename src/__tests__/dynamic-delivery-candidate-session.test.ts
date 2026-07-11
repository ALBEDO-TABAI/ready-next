import assert from 'node:assert/strict'
import test from 'node:test'
import { MemorySession, type AgentInputItem } from '@openai/agents'

import { CandidateSessionTransaction } from '../main/modules/agent-control/runtime-core/dynamic-delivery/candidate-session-fork'
import { DeliveryOutputBuffer } from '../main/modules/agent-control/runtime-core/dynamic-delivery/delivery-output-buffer'

const user = (text: string): AgentInputItem => ({ role: 'user', content: text } as AgentInputItem)
const assistant = (text: string): AgentInputItem => ({ role: 'assistant', content: text } as AgentInputItem)

test('candidate stays outside the committed session until acceptance', async () => {
  const committed = new MemorySession({ sessionId: 'committed', initialItems: [user('request')] })
  const tx = await CandidateSessionTransaction.create(committed, 'working')
  await tx.workingSession.addItems([assistant('rejected candidate')])
  assert.equal(JSON.stringify(await committed.getItems()).includes('rejected candidate'), false)
  assert.equal(JSON.stringify(tx.buildSanitizedCheckpoint()).includes('rejected candidate'), false)

  const delta = await tx.commitAccepted()
  assert.equal(JSON.stringify(delta).includes('rejected candidate'), true)
  assert.equal(JSON.stringify(await committed.getItems()).includes('rejected candidate'), true)
})

test('abort and sanitized checkpoint never persist rejected candidate', async () => {
  const committed = new MemorySession({ sessionId: 'committed-abort', initialItems: [user('request')] })
  const tx = await CandidateSessionTransaction.create(committed, 'working-abort')
  await tx.workingSession.addItems([assistant('do not persist')])
  const checkpoint = tx.buildSanitizedCheckpoint([user('canonical receipt')])
  assert.match(JSON.stringify(checkpoint), /canonical receipt/)
  assert.doesNotMatch(JSON.stringify(checkpoint), /do not persist/)
  tx.abortCandidate()
  assert.doesNotMatch(JSON.stringify(await committed.getItems()), /do not persist/)
})

test('canonical tool call receipts survive while candidate prose stays isolated', async () => {
  const committed = new MemorySession({ sessionId: 'committed-receipts', initialItems: [user('request')] })
  const tx = await CandidateSessionTransaction.create(committed, 'working-receipts')
  await tx.workingSession.addItems([
    { type: 'function_call', callId: 'c1', name: 'document_save_tab', arguments: '{}' } as AgentInputItem,
    { type: 'function_call_result', callId: 'c1', name: 'document_save_tab', status: 'completed', output: 'saved' } as AgentInputItem,
    assistant('rejected conclusion'),
  ])
  const receipts = await tx.collectCanonicalReceiptItems()
  const checkpoint = tx.buildSanitizedCheckpoint(receipts)
  assert.match(JSON.stringify(checkpoint), /document_save_tab/)
  assert.match(JSON.stringify(checkpoint), /saved/)
  assert.doesNotMatch(JSON.stringify(checkpoint), /rejected conclusion/)
})

test('accepted input collection keeps the user turn but excludes candidate assistant prose', async () => {
  const committed = new MemorySession({ initialItems: [user('base')] })
  const tx = await CandidateSessionTransaction.create(committed, 'candidate')
  await tx.workingSession.addItems([
    user('current request'),
    { role: 'assistant', content: 'unverified draft' } as AgentInputItem,
  ])
  const accepted = JSON.stringify(await tx.collectAcceptedInputItems())
  assert.equal(accepted.includes('current request'), true)
  assert.equal(accepted.includes('unverified draft'), false)
})

test('output buffer emits only after acceptance and can discard a rejected draft', () => {
  const accepted = new DeliveryOutputBuffer()
  accepted.append('final ')
  accepted.append('answer')
  assert.equal(accepted.snapshot(), 'final answer')
  assert.equal(accepted.releaseAccepted(), 'final answer')

  const rejected = new DeliveryOutputBuffer()
  rejected.append('rejected')
  rejected.discard()
  assert.throws(() => rejected.releaseAccepted(), /already released/)
})
