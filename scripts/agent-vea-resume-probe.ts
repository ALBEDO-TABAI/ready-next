import { mkdtempSync, readFileSync, writeFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname, basename } from 'node:path'
import { randomUUID } from 'node:crypto'
import { registerHooks } from 'node:module'
import { pathToFileURL } from 'node:url'

import type { ToolDefinition } from '../src/main/modules/agent-control/tool-definition'
import type { AIModelConfig } from '../src/shared/ai-providers'

interface AgentMetricEvent {
  at: string
  metric: string
  [key: string]: unknown
}

registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === 'electron') {
      const source = [
        'const noop=()=>{};',
        'class StubWindow{',
        'static getAllWindows(){return []}',
        'static fromWebContents(){return null}',
        'static getFocusedWindow(){return null}',
        'constructor(){this.webContents={send:noop,on:noop,once:noop,off:noop,isDestroyed:()=>false};}',
        'isDestroyed(){return false}',
        'on(){return this}',
        'once(){return this}',
        'off(){return this}',
        'show(){} hide(){} close(){} setBounds(){} loadURL(){return Promise.resolve()}',
        '}',
        'export const app={getPath:()=>"/tmp/ready-agent-probe",whenReady:()=>Promise.resolve(),isReady:()=>true,on:noop,once:noop,quit:noop,exit:noop,getName:()=>"Ready"};',
        'export const ipcMain={handle:noop,on:noop,removeHandler:noop,removeAllListeners:noop};',
        'export const dialog={showErrorBox:noop,showMessageBox:()=>Promise.resolve({response:0}),showOpenDialog:()=>Promise.resolve({canceled:true,filePaths:[]}),showSaveDialog:()=>Promise.resolve({canceled:true})};',
        'export const shell={openExternal:()=>Promise.resolve(),openPath:()=>Promise.resolve("")};',
        'export const BrowserWindow=StubWindow;',
        'export const BrowserView=StubWindow;',
        'export const WebContentsView=StubWindow;',
        'export const WebContents=class{};',
        'export const Menu={buildFromTemplate:()=>({popup:noop}),setApplicationMenu:noop};',
        'export const nativeImage={createFromPath:()=>({isEmpty:()=>true,resize(){return this}})};',
        'export const nativeTheme={shouldUseDarkColors:false,on:noop,off:noop};',
        'export const protocol={handle:noop,registerFileProtocol:noop};',
        'export const session={defaultSession:{webRequest:{onHeadersReceived:noop},cookies:{get:()=>Promise.resolve([])}}};',
        'export const safeStorage={isEncryptionAvailable:()=>false,encryptString:(value)=>Buffer.from(String(value)),decryptString:(value)=>Buffer.from(value).toString("utf8")};',
      ].join('')
      return {
        url: `data:text/javascript,${encodeURIComponent(source)}`,
        shortCircuit: true,
      }
    }
    return nextResolve(specifier, context)
  },
})

interface ProbeOptions {
  json: boolean
  fixture: boolean
  runStatePath: string | null
  message: string | null
}

interface ProbeFixture {
  outputDir: string
  runStatePath: string
  sceneScoresPath: string
  createdSceneScoresDuringInspect: boolean
}

interface ProbeReport {
  success: boolean
  scenario: string
  agentEntrypoint: string
  fixture: {
    outputDir: string
    runStatePath: string
    sceneScoresPath: string
  }
  result: {
    success: boolean
    terminalReason: string | null
    taskType: string | null
    interactionState: string | null
    finalText: string
  }
  assertions: {
    inspectDispatched: boolean
    aiAnalyzeDispatched: boolean
    pipelineNotDispatched: boolean
    toolPolicyRefreshed: boolean
  }
  modelAllowedToolSnapshots: string[][]
  dispatchedTools: string[]
  statusEvents: Array<Record<string, unknown>>
  outputEvents: Array<Record<string, unknown>>
  metrics: AgentMetricEvent[]
  logExcerpt: string[]
}

function parseArgs(argv: string[]): ProbeOptions {
  const options: ProbeOptions = {
    json: false,
    fixture: false,
    runStatePath: null,
    message: null,
  }
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]
    if (arg === '--json') {
      options.json = true
      continue
    }
    if (arg === '--fixture') {
      options.fixture = true
      continue
    }
    if (arg === '--run-state') {
      options.runStatePath = argv[index + 1] || null
      index += 1
      continue
    }
    if (arg === '--message') {
      options.message = argv[index + 1] || null
      index += 1
      continue
    }
    if (arg === '--help' || arg === '-h') {
      printHelp()
      process.exit(0)
    }
  }
  return options
}

function printHelp(): void {
  console.log([
    'Usage: npm run agent:probe:vea-resume -- --fixture [--json]',
    '       npm run agent:probe:vea-resume -- --run-state /abs/path/run_state.json [--json]',
    '',
    'Runs an in-process DirectChatEngine/TurnEngine probe for VEA resume routing.',
  ].join('\n'))
}

function createFixture(): ProbeFixture {
  const outputDir = mkdtempSync(join(tmpdir(), 'ready-agent-vea-resume-probe-'))
  const runStatePath = join(outputDir, 'run_state.json')
  const sceneScoresPath = join(outputDir, 'scene_scores.json')
  writeFileSync(runStatePath, JSON.stringify({
    version: 'vnext',
    status: 'blocked',
    current_stage: 'score_batches',
    scores_path: 'scene_scores.json',
    total_scenes: 97,
    completed_scenes: 0,
    coverage_ratio: 0,
  }), 'utf8')
  return {
    outputDir,
    runStatePath,
    sceneScoresPath,
    createdSceneScoresDuringInspect: false,
  }
}

function fixtureFromRunState(runStatePath: string): ProbeFixture {
  if (!runStatePath || basename(runStatePath) !== 'run_state.json') {
    throw new Error('--run-state must point to an absolute run_state.json file')
  }
  const outputDir = dirname(runStatePath)
  return {
    outputDir,
    runStatePath,
    sceneScoresPath: join(outputDir, 'scene_scores.json'),
    createdSceneScoresDuringInspect: existsSync(join(outputDir, 'scene_scores.json')),
  }
}

function buildProbeMessage(fixture: ProbeFixture, rawMessage: string | null): string {
  const userLine = rawMessage || '继续，用 mimo-v2.5，输出到同一目录'
  return [
    userLine,
    '',
    '--- 引用文件: run_state.json ---',
    `- 路径: ${fixture.runStatePath}`,
    '- 类型: application/json',
    '--- 文档内容开始 ---',
    readFileSync(fixture.runStatePath, 'utf8'),
    '--- 文档内容结束 ---',
  ].join('\n')
}

function installProbeSkillToolDefinitions(defaultToolRegistry: unknown): () => void {
  const registry = defaultToolRegistry as {
    getToolDefinitionForExecution: (name: string) => ToolDefinition | null
  }
  const original = registry.getToolDefinitionForExecution.bind(defaultToolRegistry)
  registry.getToolDefinitionForExecution = (name: string): ToolDefinition | null => {
    const base = original(name)
    if (name !== 'skill_video_expert_pipeline' && name !== 'skill_video_expert_ai_analyze') return base
    return {
      ...(base || {
        name,
        groupId: 'skills',
        domain: 'skill',
        kind: 'interactive',
        concurrency: 'serialized',
        interruptBehavior: 'host_managed',
        timeoutProfile: 'skill',
        supportsTextBridge: true,
        projectionHint: { emitsProjectionPatch: true },
        description: name,
        schema: null,
        resultShape: 'projection_patch',
      }),
      executionTimeoutMs: 30 * 60 * 1000,
      requiresExplicitAllowlist: true,
    }
  }
  return () => {
    registry.getToolDefinitionForExecution = original
  }
}

function installProbeSkillContext(engine: Record<string, unknown>): void {
  let armedHint: { id: string; name: string } | null = null
  engine.skillContextOrchestrator = {
    shouldKeepToolsWithVideo: () => false,
    findExplicitlyRequestedSkills: () => [],
    hasActiveSkillExecution: () => false,
    getCurrentReferenceSkillHint: () => armedHint,
    rememberReferenceSkillFromRunStateResource: (skillId: string) => {
      if (skillId !== 'video-expert-analyzer') return { armed: false }
      armedHint = { id: 'video-expert-analyzer', name: 'Video Expert Analyzer (VNext)' }
      return { armed: true, skillId: armedHint.id, skillName: armedHint.name }
    },
    rememberExplicitReferenceSkillHint: () => Boolean(armedHint),
    buildPreferredSkillToolNames: () => armedHint
      ? [
          'skill_video_expert_pipeline',
          'skill_inspect_run_state',
          'skill_read_artifact',
          'skill_patch_config',
          'skill_start_detached',
          'skill_ask_user',
        ]
      : [],
    maybeInjectExplicitSkillContext: async () => {},
    listRegisteredSkillTokens: () => ['video-expert-analyzer', 'Video Expert Analyzer'],
  }
}

function buildAIConfig(): AIModelConfig {
  return {
    provider: 'openai',
    model: 'probe-model',
    apiKey: 'probe-key',
    baseUrl: 'https://api.openai.com/v1',
  }
}

function stringifyMetric(event: AgentMetricEvent): string {
  return `${event.metric} ${JSON.stringify(event)}`
}

function tailLog(path: string, maxLines = 30): string[] {
  try {
    const raw = readFileSync(path, 'utf8')
    return raw.trim().split(/\r?\n/).slice(-maxLines)
  } catch {
    return []
  }
}

export async function runAgentVeaResumeProbe(options: ProbeOptions): Promise<ProbeReport> {
  const [
    { ClaudeSdkOrchestrator },
    { buildRequestEnvelope },
    { __setMetricSinkForTests },
    { _resetLastReferenceSkillHintsForTests },
    { defaultToolRegistry },
  ] = await Promise.all([
    import('../src/main/modules/agent-control/orchestrator'),
    import('../src/main/modules/agent-control/request-envelope'),
    import('../src/main/modules/agent-control/metrics'),
    import('../src/main/modules/agent-control/skill-reference-hints'),
    import('../src/main/modules/agent-control/tool-registry'),
  ])
  const fixture = options.fixture || !options.runStatePath
    ? createFixture()
    : fixtureFromRunState(options.runStatePath)
  const message = buildProbeMessage(fixture, options.message)
  const requestEnvelope = buildRequestEnvelope({ userText: message })
  const orchestrator = new ClaudeSdkOrchestrator()
  const engine = (orchestrator as unknown as { engine: Record<string, unknown> }).engine
  const metrics: AgentMetricEvent[] = []
  const modelAllowedToolSnapshots: string[][] = []
  const dispatchedTools: string[] = []
  const statusEvents: Array<Record<string, unknown>> = []
  const outputEvents: Array<Record<string, unknown>> = []
  const restoreToolDefinitions = installProbeSkillToolDefinitions(defaultToolRegistry)

  __setMetricSinkForTests((event) => metrics.push(event))
  _resetLastReferenceSkillHintsForTests()
  installProbeSkillContext(engine)
  engine.getAIConfig = () => buildAIConfig()
  // Commit cfb4369 added DirectChat.getAIConfigDetailed which bypasses the
  // legacy getAIConfig() path inside sendMessage() (direct-chat.ts:856). The
  // probe must override it too — otherwise the detailed call falls through
  // to settingsRepository.getSetting → database.ts which uses CommonJS
  // require('electron') and bypasses the ESM electron stub registered above,
  // surfacing as `ai_config_db_error: app.getPath is unavailable`.
  engine.getAIConfigDetailed = () => ({
    ok: true,
    config: buildAIConfig(),
    reason: 'present',
  })
  engine.requestSimpleText = async () => {
    throw new Error('probe expected tool-loop path, but DirectChat requested simple text')
  }
  engine.requestToolLoopResponse = async (params: { allowedToolNames?: string[] | null }) => {
    const allowed = [...(params.allowedToolNames || [])]
    modelAllowedToolSnapshots.push(allowed)
    if (modelAllowedToolSnapshots.length === 1) {
      return {
        text: 'probe inspect run_state',
        toolCalls: [{
          id: `probe_inspect_${randomUUID().slice(0, 8)}`,
          name: 'skill_inspect_run_state',
          input: { runStatePath: fixture.runStatePath },
        }],
        stopReason: 'tool_calls',
      }
    }
    if (allowed.includes('skill_video_expert_pipeline') && !allowed.includes('skill_video_expert_ai_analyze')) {
      return {
        text: 'probe stale policy would call pipeline',
        toolCalls: [{
          id: `probe_pipeline_${randomUUID().slice(0, 8)}`,
          name: 'skill_video_expert_pipeline',
          input: { url: 'https://www.youtube.com/watch?v=4qkyxm4jppc', outputDir: fixture.outputDir },
        }],
        stopReason: 'tool_calls',
      }
    }
    return {
      text: 'probe complete',
      toolCalls: [],
      stopReason: 'stop',
    }
  }

  const executionLoop = engine.executionLoopOrchestrator as {
    executeToolCalls: (params: {
      toolCalls: Array<{ id: string; name: string; input: Record<string, unknown> }>
    }) => Promise<unknown>
  }
  executionLoop.executeToolCalls = async (params) => {
    dispatchedTools.push(...params.toolCalls.map((toolCall) => toolCall.name))
    return {
      results: params.toolCalls.map((toolCall) => {
        if (toolCall.name === 'skill_inspect_run_state') {
          if (!existsSync(fixture.sceneScoresPath)) {
            writeFileSync(fixture.sceneScoresPath, JSON.stringify({ scenes: [] }), 'utf8')
            fixture.createdSceneScoresDuringInspect = true
          }
          return {
            id: toolCall.id,
            name: toolCall.name,
            input: toolCall.input,
            result: {
              text: 'score_batches: 0/97',
              framePatch: {
                activeArtifactRoots: [fixture.outputDir],
                livenessHint: 'blocked',
                skillStatusUpdates: {
                  status: 'blocked',
                  action: 'score_batches',
                  outputDir: fixture.outputDir,
                  runStatePath: fixture.runStatePath,
                  artifactPaths: {
                    sceneScoresPath: fixture.sceneScoresPath,
                    deliveryReportPath: null,
                  },
                  staleBlockerReason: null,
                },
                runContract: {
                  skillId: 'video-expert-analyzer',
                  action: 'score_batches',
                  outputDir: fixture.outputDir,
                  runStatePath: fixture.runStatePath,
                  artifactPaths: {
                    sceneScoresPath: fixture.sceneScoresPath,
                    deliveryReportPath: null,
                  },
                  status: 'blocked',
                  liveness: 'blocked',
                  progress: {
                    stage: 'score_batches',
                    totalUnits: 97,
                    completedUnits: 0,
                    coverageRatio: 0,
                    fingerprint: 'score_batches:0/97',
                  },
                },
              },
            },
          }
        }
        if (toolCall.name === 'skill_video_expert_ai_analyze') {
          return {
            id: toolCall.id,
            name: toolCall.name,
            input: toolCall.input,
            result: {
              text: 'ai_analyze dispatched',
              framePatch: {
                activeArtifactRoots: [fixture.outputDir],
                livenessHint: 'done',
                skillStatusUpdates: {
                  status: 'completed',
                  action: 'video_expert_ai_analyze',
                  outputDir: fixture.outputDir,
                  runStatePath: fixture.runStatePath,
                  artifactPaths: {
                    sceneScoresPath: fixture.sceneScoresPath,
                    deliveryReportPath: null,
                  },
                  staleBlockerReason: null,
                },
                runContract: {
                  skillId: 'video-expert-analyzer',
                  action: 'video_expert_ai_analyze',
                  outputDir: fixture.outputDir,
                  runStatePath: fixture.runStatePath,
                  artifactPaths: {
                    sceneScoresPath: fixture.sceneScoresPath,
                    deliveryReportPath: null,
                  },
                  status: 'completed',
                  liveness: 'done',
                  progress: {
                    stage: 'score_batches',
                    totalUnits: 97,
                    completedUnits: 97,
                    coverageRatio: 1,
                    fingerprint: 'score_batches:97/97',
                  },
                },
              },
            },
          }
        }
        return {
          id: toolCall.id,
          name: toolCall.name,
          input: toolCall.input,
          result: {
            text: `${toolCall.name} dispatched unexpectedly`,
            errorKind: 'unexpected_tool',
            framePatch: null,
          },
        }
      }),
      budgetLimited: false,
      recoveryHistory: [],
    }
  }

  orchestrator.on('status', (payload) => statusEvents.push(payload))
  orchestrator.on('output', (payload) => outputEvents.push(payload))

  try {
    const result = await orchestrator.sendAndCollect(
      '管家',
      message,
      'agent-probe-vea-resume',
      `probe-${randomUUID().replace(/-/g, '').slice(0, 12)}`,
      'task-agent-probe-vea-resume',
      undefined,
      requestEnvelope,
      {
        primaryDomain: 'skill',
        mentionedDomains: ['skill'],
        excludedDomains: [],
        objectSignals: ['skill-object'],
        actionSignals: ['skill-action'],
        crossDomain: false,
        confidence: 'high',
      },
    )
    const assertions = {
      inspectDispatched: dispatchedTools.includes('skill_inspect_run_state'),
      aiAnalyzeDispatched: dispatchedTools.includes('skill_video_expert_ai_analyze'),
      pipelineNotDispatched: !dispatchedTools.includes('skill_video_expert_pipeline'),
      toolPolicyRefreshed: metrics.some((event) =>
        event.metric === 'turn_frame_tool_policy_refreshed'
        && Array.isArray(event.preferredToolNames)
        && event.preferredToolNames.includes('skill_video_expert_ai_analyze')
        && Array.isArray(event.allowedToolNames)
        && event.allowedToolNames.includes('skill_video_expert_ai_analyze')
        && !event.allowedToolNames.includes('skill_video_expert_pipeline'),
      ),
    }
    const success = result.success
      && result.terminalReason === 'done'
      && assertions.inspectDispatched
      && assertions.aiAnalyzeDispatched
      && assertions.pipelineNotDispatched
      && assertions.toolPolicyRefreshed

    return {
      success,
      scenario: 'vea_resume_score_batches',
      agentEntrypoint: 'ClaudeSdkOrchestrator.sendAndCollect',
      fixture: {
        outputDir: fixture.outputDir,
        runStatePath: fixture.runStatePath,
        sceneScoresPath: fixture.sceneScoresPath,
      },
      result: {
        success: result.success,
        terminalReason: result.terminalReason || null,
        taskType: result.taskType || null,
        interactionState: result.interactionState || null,
        finalText: result.finalText || '',
      },
      assertions,
      modelAllowedToolSnapshots,
      dispatchedTools,
      statusEvents,
      outputEvents,
      metrics,
      logExcerpt: metrics.map(stringifyMetric).filter((line) =>
        line.includes('turn_frame')
        || line.includes('skill_')
        || line.includes('force_tool'),
      ).slice(-40),
    }
  } finally {
    restoreToolDefinitions()
    __setMetricSinkForTests(null)
    _resetLastReferenceSkillHintsForTests()
  }
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2))
  const report = await runAgentVeaResumeProbe(options)
  if (options.json) {
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`)
  } else {
    console.log(`Agent VEA resume probe: ${report.success ? 'PASS' : 'FAIL'}`)
    console.log(`Dispatched tools: ${report.dispatchedTools.join(', ') || 'none'}`)
    console.log(`Terminal reason: ${report.result.terminalReason || 'none'}`)
    console.log(JSON.stringify(report.assertions, null, 2))
    if (!report.success) {
      console.log('\nMetric excerpt:')
      console.log(report.logExcerpt.join('\n') || '(empty)')
      const metricTail = tailLog(join(tmpdir(), 'ready-agent-metrics.log'), 20)
      const directTail = tailLog(join(tmpdir(), 'ready-directchat.log'), 20)
      console.log('\nready-agent-metrics tail:')
      console.log(metricTail.join('\n') || '(empty)')
      console.log('\nready-directchat tail:')
      console.log(directTail.join('\n') || '(empty)')
    }
  }
  if (!report.success) process.exitCode = 1
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    const message = error instanceof Error ? error.stack || error.message : String(error)
    console.error(message)
    process.exitCode = 1
  })
}
