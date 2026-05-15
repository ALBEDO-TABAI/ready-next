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
    sdkCheckpointRecovered: boolean
    veaTypedActionsExcludedFromAllowed: boolean
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
    'Runs an in-process Ready Agent SDK probe for VEA resume routing.',
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
    { ReadyAgentOrchestrator },
    { buildRequestEnvelope },
    { __setMetricSinkForTests },
    { _resetLastReferenceSkillHintsForTests },
    { __setSkillsRuntimeManagerForTests },
  ] = await Promise.all([
    import('../src/main/modules/agent-control/orchestrator'),
    import('../src/main/modules/agent-control/request-envelope'),
    import('../src/main/modules/agent-control/metrics'),
    import('../src/main/modules/agent-control/skill-reference-hints'),
    import('../src/main/modules/skills-runtime/runtime-manager'),
  ])
  const fixture = options.fixture || !options.runStatePath
    ? createFixture()
    : fixtureFromRunState(options.runStatePath)
  const message = buildProbeMessage(fixture, options.message)
  const requestEnvelope = buildRequestEnvelope({ userText: message })
  const metrics: AgentMetricEvent[] = []
  const modelAllowedToolSnapshots: string[][] = []
  const dispatchedTools: string[] = []
  const statusEvents: Array<Record<string, unknown>> = []
  const outputEvents: Array<Record<string, unknown>> = []
  const inspectTool: ToolDefinition = {
    name: 'skill_inspect_run_state',
    groupId: 'skills',
    domain: 'skill',
    kind: 'interactive',
    concurrency: 'serialized',
    interruptBehavior: 'host_managed',
    timeoutProfile: 'skill',
    supportsTextBridge: true,
    projectionHint: { emitsProjectionPatch: true },
    description: 'Inspect a VEA run_state file and project resume state.',
    schema: {
      type: 'object',
      properties: {
        runStatePath: { type: 'string' },
      },
      required: ['runStatePath'],
      additionalProperties: false,
    },
    executionVisibility: 'model',
    resultShape: 'projection_patch',
  }

  __setMetricSinkForTests((event) => metrics.push(event))
  _resetLastReferenceSkillHintsForTests()
  __setSkillsRuntimeManagerForTests({
    listSkills: () => [{
      id: 'video-expert-analyzer',
      name: 'Video Expert Analyzer (VNext)',
      description: 'Probe skill runtime fixture',
      executionMode: 'advisory',
      hostRequirements: {
        default_action_timeout_ms: 60 * 60 * 1000,
        expose_when_hint_armed: ['video_expert_pipeline', 'video_expert_ai_analyze'],
      },
      childLoop: {
        version: 1,
        actions: ['video_expert_pipeline', 'video_expert_ai_analyze'],
      },
      actions: [
        {
          name: 'video_expert_pipeline',
          description: 'Probe pipeline action',
          runtime: 'python',
          visibility: 'internal',
          params: [
            { name: 'url', type: 'string', description: 'Video URL', required: true },
            { name: 'outputDir', type: 'string', description: 'Output directory', required: false },
          ],
        },
        {
          name: 'video_expert_ai_analyze',
          description: 'Probe scoring action',
          runtime: 'python',
          visibility: 'internal',
          params: [
            { name: 'sceneScoresPath', type: 'string', description: 'scene_scores.json path', required: true },
            { name: 'outputDir', type: 'string', description: 'Output directory', required: false },
          ],
        },
      ],
    }],
  })
  const orchestrator = new ReadyAgentOrchestrator({
    agentSdkRuntimeDeps: {
      loadAIConfig: () => ({
        ok: true,
        config: buildAIConfig(),
        reason: 'present',
      }),
      listToolDefinitions: () => [inspectTool],
      executeToolCall: async (toolName, args) => {
        dispatchedTools.push(toolName)
        if (toolName !== 'skill_inspect_run_state') {
          return {
            text: `${toolName} dispatched unexpectedly`,
            shape: 'json',
            data: { errorKind: 'unexpected_tool' },
            projectionPatch: null,
            interactionHint: null,
            framePatch: null,
          }
        }
        if (!existsSync(fixture.sceneScoresPath)) {
          writeFileSync(fixture.sceneScoresPath, JSON.stringify({ scenes: [] }), 'utf8')
          fixture.createdSceneScoresDuringInspect = true
        }
        return {
          text: 'score_batches: 0/97',
          shape: 'projection_patch',
          data: {
            status: 'child_paused',
            skillId: 'video-expert-analyzer',
            action: 'score_batches',
            childRunId: 'probe-child-run',
            outputDir: fixture.outputDir,
            runStatePath: String(args.runStatePath || fixture.runStatePath),
            closeEvent: { terminalReason: 'checkpoint_budget' },
          },
          projectionPatch: {
            taskTitle: 'VEA 续跑探针',
            taskSummary: 'score_batches: 0/97',
            status: 'waiting',
            runContract: {
              skillId: 'video-expert-analyzer',
              action: 'score_batches',
              outputDir: fixture.outputDir,
              runStatePath: fixture.runStatePath,
              status: 'blocked',
              liveness: 'blocked',
            },
          },
          interactionHint: null,
          framePatch: null,
        }
      },
      runAgent: async ({ tools }) => {
        modelAllowedToolSnapshots.push(tools.map((tool) => tool.name))
        const inspect = tools.find((tool) => tool.name === 'skill_inspect_run_state') as
          | { invoke: (context: unknown, input: string) => Promise<string> }
          | undefined
        if (!inspect) throw new Error('skill_inspect_run_state is not visible to the SDK agent')
        await inspect.invoke({}, JSON.stringify({ runStatePath: fixture.runStatePath }))
        throw new Error('Max turns (10) exceeded')
      },
      skillContextOrchestrator: {
        findExplicitlyRequestedSkills: () => [],
        buildPreferredSkillToolNames: () => ['skill_inspect_run_state'],
        getCurrentReferenceSkillHint: () => ({ id: 'video-expert-analyzer', name: 'Video Expert Analyzer (VNext)' }),
        rememberExplicitReferenceSkillHint: () => true,
      },
    },
  })

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
      sdkCheckpointRecovered: result.terminalReason === 'checkpoint_budget',
      veaTypedActionsExcludedFromAllowed: modelAllowedToolSnapshots.every((snapshot) =>
        !snapshot.includes('skill_video_expert_pipeline')
        && !snapshot.includes('skill_video_expert_ai_analyze'),
      ),
    }
    // Stage N — success means the manifest fence held and VEA never
    // reached parent-force dispatch. ai_analyze MUST NOT be dispatched
    // (legacy probe asserted the opposite — that contract is retired).
    const success = result.success
      && (result.terminalReason === 'checkpoint_budget'
        || result.terminalReason === 'checkpoint_user_input'
        || result.terminalReason === 'checkpoint_background')
      && assertions.pipelineNotDispatched
      && !assertions.aiAnalyzeDispatched
      && assertions.sdkCheckpointRecovered
      && assertions.veaTypedActionsExcludedFromAllowed

    return {
      success,
      scenario: 'vea_resume_score_batches',
      agentEntrypoint: 'ReadyAgentOrchestrator.sendAndCollect',
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
    __setMetricSinkForTests(null)
    _resetLastReferenceSkillHintsForTests()
    __setSkillsRuntimeManagerForTests(null)
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
      const sdkTail = tailLog(join(tmpdir(), 'ready-agent-sdk.log'), 20)
      console.log('\nready-agent-metrics tail:')
      console.log(metricTail.join('\n') || '(empty)')
      console.log('\nready-agent-sdk tail:')
      console.log(sdkTail.join('\n') || '(empty)')
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
