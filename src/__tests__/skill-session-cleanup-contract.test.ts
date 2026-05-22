import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import test from 'node:test'

test('agent session teardown clears reference skill hints and pending ask_user records', () => {
  // eslint-disable-next-line ready/no-source-grep-test -- reviewed hard contract: IPC session cleanup wiring is closure-local inside setupAgentIPC and has no exported behavior seam
  const ipcHandler = readFileSync(resolve(process.cwd(), 'src/main/modules/claude-bridge/ipc-handler.ts'), 'utf8')
  // eslint-disable-next-line ready/no-source-grep-test -- reviewed hard contract: lifecycle handlers were split out of ipc-handler.ts; kill cleanup still has to stay wired in that group.
  const lifecycleGroup = readFileSync(resolve(process.cwd(), 'src/main/modules/claude-bridge/ipc/agent-lifecycle-group.ts'), 'utf8')
  const killStart = lifecycleGroup.indexOf("ipcMain.handle('agent:kill'")
  const nextHandler = lifecycleGroup.indexOf("ipcMain.handle('agent:sendScoped'", killStart)
  const killHandler = killStart >= 0 && nextHandler > killStart
    ? lifecycleGroup.slice(killStart, nextHandler)
    : ''

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
