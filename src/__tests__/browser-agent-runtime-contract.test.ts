import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import test from 'node:test'

function readWorkspaceFile(path: string): string {
  return readFileSync(resolve(process.cwd(), path), 'utf8')
}

test('browser agent runtime is split into planner, runtime adapter, page-state service, and evidence service', () => {
  const directChat = readWorkspaceFile('src/main/modules/claude-bridge/direct-chat.ts')
  const browserRunner = readWorkspaceFile('src/main/modules/tools/browser-agent-runner.ts')
  const browserTools = readWorkspaceFile('src/main/modules/tools/browser-tools.ts')
  const ipcHandler = readWorkspaceFile('src/main/modules/claude-bridge/ipc-handler.ts')
  const planner = readWorkspaceFile('src/main/modules/agent-control/browser-task-planner.ts')
  const runtimeAdapter = readWorkspaceFile('src/main/modules/browser-engine/agent-runtime-adapter.ts')
  const pageStateService = readWorkspaceFile('src/main/modules/browser-engine/page-state-service.ts')
  const evidenceService = readWorkspaceFile('src/main/modules/browser-engine/evidence-service.ts')
  const sharedTypes = readWorkspaceFile('src/shared/browser-agent-task.ts')

  assert.match(sharedTypes, /export type BrowserWorkflowStage =/)
  assert.match(sharedTypes, /export interface BrowserTaskDecision/)
  assert.match(sharedTypes, /export interface BrowserTaskPlan/)
  assert.match(sharedTypes, /export interface BrowserPageState/)
  assert.match(sharedTypes, /export interface BrowserTaskProjectionPayload/)

  assert.match(runtimeAdapter, /export interface BrowserAgentRuntime/)
  assert.match(runtimeAdapter, /export class BrowserAgentRuntimeAdapter/)
  assert.match(runtimeAdapter, /getActiveTab\(\)/)
  assert.match(runtimeAdapter, /getTabContext\(/)
  assert.match(runtimeAdapter, /executeJS\(/)
  assert.match(runtimeAdapter, /navigate\(/)

  assert.match(pageStateService, /export class BrowserPageStateService/)
  assert.match(pageStateService, /capturePageState\(/)
  assert.match(pageStateService, /getPageIdentity\(/)

  assert.match(evidenceService, /export class BrowserEvidenceService/)
  assert.match(evidenceService, /isTargetPageMatched\(/)
  assert.match(evidenceService, /isUploadComplete\(/)
  assert.match(evidenceService, /isPromptComplete\(/)
  assert.match(evidenceService, /isRunningState\(/)

  assert.match(planner, /export class BrowserTaskPlanner/)
  assert.match(planner, /decideTask\(/)
  assert.match(planner, /buildContinuityContext\(/)
  assert.match(planner, /applyContinuityToDecision\(/)
  assert.match(planner, /buildContinuityInstruction\(/)
  assert.match(planner, /shouldUseDeterministicRunner\(/)
  assert.match(planner, /buildToolLoopInstruction\(/)
  assert.match(planner, /buildPromptRefinementRequest\(/)
  assert.match(planner, /parsePromptDraft\(/)
  assert.match(planner, /buildClarifyMessage\(/)
  assert.match(planner, /getRecommendedMaxToolIterations\(/)

  assert.match(directChat, /import \{ BrowserTaskPlanner \} from '\.\.\/agent-control\/browser-task-planner'/)
  assert.match(directChat, /import type \{[\s\S]*BrowserTaskDecision[\s\S]*BrowserTaskPlan[\s\S]*BrowserTaskPlanContinuity[\s\S]*\} from '\.\.\/\.\.\/\.\.\/shared\/browser-agent-task'/)
  assert.match(directChat, /private readonly browserTaskPlanner: BrowserTaskPlanner/)
  assert.doesNotMatch(directChat, /interface BrowserTaskDecision \{/)
  assert.doesNotMatch(directChat, /private async buildBrowserTaskContinuityContext\(/)
  assert.doesNotMatch(directChat, /private applyBrowserContinuityToDecision\(/)
  assert.doesNotMatch(directChat, /private decideBrowserTask\(/)
  assert.doesNotMatch(directChat, /private buildBrowserContinuityInstruction\(/)
  assert.doesNotMatch(directChat, /## 浏览器任务执行计划/)
  assert.doesNotMatch(directChat, /private parseBrowserPromptDraft\(/)
  assert.doesNotMatch(directChat, /private buildBrowserPromptDraft\(/)
  assert.doesNotMatch(directChat, /private getEffectiveMaxToolIterations\(/)

  assert.match(browserRunner, /import \{ BrowserAgentRuntimeAdapter \} from '\.\.\/browser-engine\/agent-runtime-adapter'/)
  assert.match(browserRunner, /import \{ BrowserPageStateService \} from '\.\.\/browser-engine\/page-state-service'/)
  assert.match(browserRunner, /import \{ BrowserEvidenceService \} from '\.\.\/browser-engine\/evidence-service'/)
  assert.match(browserRunner, /private readonly runtime: BrowserAgentRuntimeAdapter/)
  assert.match(browserRunner, /private readonly pageStateService: BrowserPageStateService/)
  assert.match(browserRunner, /private readonly evidenceService: BrowserEvidenceService/)

  assert.match(browserTools, /import \{ BrowserAgentRuntimeAdapter \} from '\.\.\/browser-engine\/agent-runtime-adapter'/)
  assert.match(browserTools, /import \{ BrowserPageStateService \} from '\.\.\/browser-engine\/page-state-service'/)
  assert.match(browserTools, /import \{ BrowserEvidenceService \} from '\.\.\/browser-engine\/evidence-service'/)

  assert.match(ipcHandler, /const parseStructuredScopeProjection = \(text: string\): Record<string, unknown> \| null =>/)
  assert.match(ipcHandler, /taskTitle: typeof structured\?\.taskTitle === 'string' \? structured\.taskTitle : undefined/)
  assert.match(ipcHandler, /taskSummary: typeof structured\?\.taskSummary === 'string' \? structured\.taskSummary : undefined/)
})
