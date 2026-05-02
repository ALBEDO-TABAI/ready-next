import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import test from 'node:test'

test('agent session teardown clears reference skill hints and pending ask_user records', () => {
  // eslint-disable-next-line ready/no-source-grep-test -- reviewed hard contract: IPC session cleanup wiring is closure-local inside setupAgentIPC and has no exported behavior seam
  const ipcHandler = readFileSync(resolve(process.cwd(), 'src/main/modules/claude-bridge/ipc-handler.ts'), 'utf8')
  const killHandler = ipcHandler.match(/ipcMain\.handle\('agent:kill'[\s\S]*?\n {2}\}\)/)?.[0] || ''

  assert.match(ipcHandler, /cleanupSkillSessionState/)
  assert.match(ipcHandler, /clearLastReferenceSkill/)
  assert.match(ipcHandler, /clearSkillTaskProjection/)
  assert.match(ipcHandler, /rejectBySession/)
  assert.match(ipcHandler, /clearAllReferenceSkillHints/)
  assert.match(ipcHandler, /getEphemeralExecutionStore\(\)\.clear\(\)/)
  assert.match(ipcHandler, /agent:newSession[\s\S]*cleanupSkillSessionState\(sessionId/)
  assert.match(killHandler, /cancelSkillSessionPendingInteractions\(sessionId/)
  assert.doesNotMatch(killHandler, /cleanupSkillSessionState\(sessionId/)
})
