import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import test from 'node:test'

function readWorkspaceFile(path: string): string {
  return readFileSync(resolve(process.cwd(), path), 'utf8')
}

test('agent session teardown clears reference skill hints and pending ask_user records', () => {
  const ipcHandler = readWorkspaceFile('src/main/modules/claude-bridge/ipc-handler.ts')
  const killHandler = ipcHandler.match(/ipcMain\.handle\('agent:kill'[\s\S]*?\n  \}\)/)?.[0] || ''

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
