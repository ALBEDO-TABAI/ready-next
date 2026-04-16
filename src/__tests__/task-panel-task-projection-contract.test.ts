import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import test from 'node:test'

function readWorkspaceFile(path: string): string {
  return readFileSync(resolve(process.cwd(), path), 'utf8')
}

test('task panel reads task projections and renders budget and recovery hints', () => {
  const source = readWorkspaceFile('src/renderer/components/ready/TaskPanel.tsx')

  assert.match(source, /window\.electronAPI\.agent\.listTaskProjections/)
  assert.match(source, /const \[taskProjections, setTaskProjections\] = useState/)
  assert.match(source, /const activeProjection = useMemo\(/)
  assert.match(source, /activeProjection\?\.taskTitle\s*\|\|\s*activeRun\?\.taskTitle/)
  assert.match(source, /activeProjection\?\.taskSummary\s*\|\|\s*activeRun\?\.taskSummary/)
  assert.match(source, /activeProjection\?\.recentArtifacts/)
  assert.match(source, /预算进度/)
  assert.match(source, /自动恢复/)
  assert.match(source, /任务类型/)
  assert.match(source, /当前状态/)
  assert.match(source, /activeProjection\?\.budgetUsagePercent/)
  assert.match(source, /activeProjection\?\.recoveryHistory/)
  assert.match(source, /activeProjection\?\.interactionState/)
  assert.match(source, /degradationReason/)
  assert.match(source, /stepBudget/)
})
