import { randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync } from 'node:fs'
import { writeFile } from 'node:fs/promises'
import { homedir, tmpdir } from 'node:os'
import { dirname, isAbsolute, join, resolve } from 'node:path'
import { createRequire, registerHooks } from 'node:module'
import { pathToFileURL } from 'node:url'
import { markSkillHandoffOutputCompleted } from '../src/main/modules/agent-control/skill-agent-handoff'

const require = createRequire(import.meta.url)
const { inspectVeaArtifacts } = require('./vea-assert-artifacts.cjs') as {
  inspectVeaArtifacts: (outputDir: string) => VeaAssertReport
}

registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === 'electron') {
      const userData = `${homedir()}/Library/Application Support/ready`
      const source = [
        'const noop=()=>{};',
        `const userData=${JSON.stringify(userData)};`,
        'class StubWindow{',
        'static getAllWindows(){return []}',
        'static fromWebContents(){return null}',
        'static getFocusedWindow(){return null}',
        'constructor(){this.webContents={send:noop,on:noop,once:noop,off:noop,isDestroyed:()=>false};}',
        'isDestroyed(){return false}',
        'on(){return this} once(){return this} off(){return this}',
        'show(){} hide(){} close(){} setBounds(){} loadURL(){return Promise.resolve()}',
        '}',
        'export const app={getPath:(name)=>name==="userData"?userData:"/tmp/ready-agent-live-acceptance",whenReady:()=>Promise.resolve(),isReady:()=>true,on:noop,once:noop,quit:noop,exit:noop,getName:()=>"Ready"};',
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

type Mode = 'resume' | 'fresh' | 'both' | 'fresh-resume'
type HandoffMode = 'observe' | 'complete'
type Phase = 'resume' | 'fresh'

interface AgentSpawnContextLike {
  provider: string
  model_id: string
  base_url: string
  api_key: string
  api_kind: 'openai-completions' | 'openai-responses' | 'anthropic-messages'
  fallback_chain: string[]
  input_modes: Array<'text' | 'image'>
}

interface Options {
  mode: Mode
  handoffMode: HandoffMode
  url: string
  outputDir: string
  runStatePath: string
  runtimeRoot: string
  modelsJsonPath: string
  preferredModel: string
  json: boolean
  cleanBeforeFresh: boolean
  maxRounds: number
  waitMs: number
}

interface ChildRunSummary {
  round: number
  action: string
  childRunId: string
  launchStatus: string
  waitKind: string
  eventLogPath: string
  outputDir: string | null
  runStatePath: string | null
  sceneScoresPath: string | null
  closeStatus: string | null
  terminalReason: string | null
  errorMessage: string | null
  pendingHandoffs?: string[]
  handoffCompletions?: HandoffCompletionSummary[]
}

interface HandoffTask {
  name: string
  taskPath: string
  outputPath: string
  receiptPath: string
  validationErrorsPath?: string
}

interface HandoffCompletionSummary {
  name: string
  taskPath: string
  outputPath: string
  bytesWritten: number
  model: string
  repairedValidation?: boolean
}

interface ArtifactSummary {
  outputDir: string
  runStateStatus: string
  runStateStage: string
  totalScenes: number
  completeScenes: number
  incompleteSceneNumbers: number[]
  hostBatches: {
    total: number
    completed: number
    blocked: number
    pending: number
    inProgress: number
  }
  deliveryStatus: string
  requiredOutputsOk: boolean
  requiredOutputProblems: string[]
  storyboardMd: { path: string; exists: boolean; size: number }
  storyboardPdf: { path: string; exists: boolean; size: number }
  audiovisualMd: { path: string; exists: boolean; size: number }
  audiovisualPdf: { path: string; exists: boolean; size: number }
  complete: boolean
  problems: string[]
}

interface VeaAssertFileInfo {
  path: string
  exists: boolean
  size: number
  ok: boolean
}

interface VeaAssertReport {
  ok: boolean
  outputDir: string
  problems: string[]
  summary: {
    videoId: string
    runStateStatus: string | null
    runStateStage?: string | null
    deliveryStatus: string | null
    totalScenes: number
    completeScenes: number
    incompleteScenes: Array<{ sceneNumber: number; missing: string[] }>
    hostBatches: ArtifactSummary['hostBatches']
    requiredOutputs: Record<string, VeaAssertFileInfo>
  }
}

interface PhaseResult {
  phase: Phase
  success: boolean
  runs: ChildRunSummary[]
  artifacts: ArtifactSummary
  observedPendingHandoff?: boolean
}

interface AcceptanceReport {
  success: boolean
  startedAt: string
  finishedAt: string
  mode: Mode
  handoffMode: HandoffMode
  url: string
  outputDir: string
  runtimeRoot: string
  agentContext: Record<string, unknown>
  results: PhaseResult[]
  freshResume?: {
    expectedOutputDir: string
    freshOutputDir: string | null
    resumeOutputDir: string | null
    sameOutputDir: boolean
  }
  debug: Record<string, unknown>
}

interface AcceptanceDeps {
  makeAgentContext: (opts: Options) => AgentSpawnContextLike
  createRunner: (opts: Options) => Promise<Awaited<ReturnType<typeof createRunner>>>
  completePendingHandoffs: (outputDir: string, agentContext: AgentSpawnContextLike) => Promise<HandoffCompletionSummary[]>
  repairHandoffValidationErrors: (outputDir: string, agentContext: AgentSpawnContextLike) => Promise<HandoffCompletionSummary[]>
  cleanOutputDir: (outputDir: string) => void
}

const DEFAULT_URL = 'https://www.youtube.com/watch?v=4qkyxm4jppc'
const DEFAULT_OUTPUT_DIR = `${homedir()}/Documents/实验田/测试/4qkyxm4jppc`
const DEFAULT_RUNTIME_ROOT = `${homedir()}/Library/Application Support/ready/skill-runtime`
const DEFAULT_MODELS_JSON = `${homedir()}/.config/video-expert-analyzer-vnext/models.multi.json`
const DEFAULT_CONFIG = `${homedir()}/.config/video-expert-analyzer-vnext/config.json`

const REQUIRED_SCORE_KEYS = [
  'aesthetic_beauty',
  'credibility',
  'impact',
  'memorability',
  'fun_interest',
] as const

const REQUIRED_STORYBOARD_KEYS = [
  'shot_size',
  'lighting',
  'camera_movement',
  'visual_style',
  'technique',
] as const

export function parseArgs(argv: string[]): Options {
  const config = readJson(DEFAULT_CONFIG)
  const autoScoring = objectValue(config?.auto_scoring)
  const opts: Options = {
    mode: 'resume',
    handoffMode: 'complete',
    url: DEFAULT_URL,
    outputDir: DEFAULT_OUTPUT_DIR,
    runStatePath: join(DEFAULT_OUTPUT_DIR, 'run_state.json'),
    runtimeRoot: DEFAULT_RUNTIME_ROOT,
    modelsJsonPath: stringValue(autoScoring?.models_json_path) || DEFAULT_MODELS_JSON,
    preferredModel: stringValue(autoScoring?.preferred_model) || 'xiaomi/mimo-v2.5',
    json: false,
    cleanBeforeFresh: false,
    maxRounds: 8,
    waitMs: 45 * 60_000,
  }
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]
    if (arg === '--mode') {
      const mode = argv[index + 1] as Mode | undefined
      if (mode !== 'resume' && mode !== 'fresh' && mode !== 'both' && mode !== 'fresh-resume') {
        throw new Error(`Invalid --mode: ${mode}`)
      }
      opts.mode = mode
      index += 1
      continue
    }
    if (arg === '--handoff' || arg === '--handoff-mode') {
      const handoffMode = argv[index + 1] as HandoffMode | undefined
      if (handoffMode !== 'observe' && handoffMode !== 'complete') {
        throw new Error(`Invalid ${arg}: ${handoffMode}`)
      }
      opts.handoffMode = handoffMode
      index += 1
      continue
    }
    if (arg === '--url') {
      opts.url = argv[index + 1] || opts.url
      index += 1
      continue
    }
    if (arg === '--output-dir') {
      opts.outputDir = argv[index + 1] || opts.outputDir
      opts.runStatePath = join(opts.outputDir, 'run_state.json')
      index += 1
      continue
    }
    if (arg === '--run-state') {
      opts.runStatePath = argv[index + 1] || opts.runStatePath
      opts.outputDir = dirname(opts.runStatePath)
      index += 1
      continue
    }
    if (arg === '--models-json') {
      opts.modelsJsonPath = argv[index + 1] || opts.modelsJsonPath
      index += 1
      continue
    }
    if (arg === '--preferred-model') {
      opts.preferredModel = argv[index + 1] || opts.preferredModel
      index += 1
      continue
    }
    if (arg === '--runtime-root') {
      opts.runtimeRoot = argv[index + 1] || opts.runtimeRoot
      index += 1
      continue
    }
    if (arg === '--wait-ms') {
      opts.waitMs = Number(argv[index + 1] || opts.waitMs)
      index += 1
      continue
    }
    if (arg === '--max-rounds') {
      opts.maxRounds = Number(argv[index + 1] || opts.maxRounds)
      index += 1
      continue
    }
    if (arg === '--clean-before-fresh') {
      opts.cleanBeforeFresh = true
      continue
    }
    if (arg === '--json') {
      opts.json = true
      continue
    }
    if (arg === '--help' || arg === '-h') {
      printHelp()
      process.exit(0)
    }
  }
  opts.outputDir = resolve(expandHome(opts.outputDir))
  opts.runStatePath = resolve(expandHome(opts.runStatePath))
  opts.runtimeRoot = resolve(expandHome(opts.runtimeRoot))
  opts.modelsJsonPath = resolve(expandHome(opts.modelsJsonPath))
  opts.maxRounds = Math.max(1, Number.isFinite(opts.maxRounds) ? opts.maxRounds : 3)
  opts.waitMs = Math.max(1_000, Number.isFinite(opts.waitMs) ? opts.waitMs : 45 * 60_000)
  return opts
}

function printHelp(): void {
  console.log([
    'Usage:',
    '  npm run agent:acceptance:vea-live -- --mode resume --run-state /abs/run_state.json',
    '  npm run agent:acceptance:vea-live -- --mode fresh --clean-before-fresh --url https://www.youtube.com/watch?v=4qkyxm4jppc --output-dir /abs/output',
    '  npm run agent:acceptance:vea-live -- --mode fresh-resume --url https://www.youtube.com/watch?v=4qkyxm4jppc --output-dir /abs/output',
    '  npm run agent:acceptance:vea-live -- --mode both --clean-before-fresh',
    '',
    'Options:',
    '  --handoff observe   Report pending audiovisual handoffs without completing them.',
    '  --handoff complete  Complete pending handoffs before continuing artifact validation. (default)',
    '',
    'Runs the real Ready agent child-runner + skill runtime and validates VEA artifacts.',
  ].join('\n'))
}

function expandHome(path: string): string {
  if (path === '~') return homedir()
  if (path.startsWith('~/')) return join(homedir(), path.slice(2))
  return path
}

function stringValue(value: unknown): string {
  return typeof value === 'string' ? value.trim() : ''
}

function objectValue(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null
}

function readJson(path: string): Record<string, unknown> | null {
  try {
    const parsed = JSON.parse(readFileSync(expandHome(path), 'utf8')) as unknown
    return objectValue(parsed)
  } catch {
    return null
  }
}

function makeAgentContext(opts: Options): AgentSpawnContextLike {
  const catalog = readJson(opts.modelsJsonPath)
  const providers = objectValue(catalog?.providers)
  if (!providers) throw new Error(`models catalog has no providers: ${opts.modelsJsonPath}`)
  const slash = opts.preferredModel.indexOf('/')
  if (slash <= 0) throw new Error(`preferred model must be provider/model: ${opts.preferredModel}`)
  const providerName = opts.preferredModel.slice(0, slash)
  const modelId = opts.preferredModel.slice(slash + 1)
  const provider = objectValue(providers[providerName])
  if (!provider) throw new Error(`models catalog missing provider: ${providerName}`)
  const models = Array.isArray(provider.models) ? provider.models.map(objectValue).filter(Boolean) as Record<string, unknown>[] : []
  const model = models.find((item) => item.id === modelId)
  if (!model) throw new Error(`provider ${providerName} missing model: ${modelId}`)
  const apiKind = stringValue(model.api) || stringValue(provider.api)
  if (apiKind !== 'openai-completions' && apiKind !== 'openai-responses' && apiKind !== 'anthropic-messages') {
    throw new Error(`unsupported model api style: ${apiKind}`)
  }
  const inputModes = Array.isArray(model.input)
    ? model.input.map((item) => String(item).trim()).filter((item) => item === 'text' || item === 'image') as Array<'text' | 'image'>
    : ['text']
  if (!inputModes.includes('image')) {
    throw new Error(`${opts.preferredModel} is not declared image-capable`)
  }
  const config = readJson(DEFAULT_CONFIG)
  const autoScoring = objectValue(config?.auto_scoring)
  const fallbackRaw = Array.isArray(autoScoring?.fallback_models) ? autoScoring.fallback_models : []
  return {
    provider: providerName,
    model_id: modelId,
    base_url: stringValue(provider.baseUrl),
    api_key: stringValue(provider.apiKey),
    api_kind: apiKind,
    fallback_chain: fallbackRaw.map((item) => String(item).trim()).filter(Boolean),
    input_modes: inputModes,
  }
}

function numberValue(value: unknown): number | null {
  const n = Number(value)
  return Number.isFinite(n) ? n : null
}

function nonEmptyText(value: unknown): boolean {
  const text = typeof value === 'string' ? value.trim() : ''
  return text.length > 0 && !text.startsWith('TODO')
}

function sceneComplete(scene: unknown): boolean {
  const rec = objectValue(scene)
  if (!rec) return false
  const scores = objectValue(rec.scores)
  if (!scores || !REQUIRED_SCORE_KEYS.every((key) => (numberValue(scores[key]) || 0) > 0)) return false
  const storyboard = objectValue(rec.storyboard)
  if (!storyboard || !REQUIRED_STORYBOARD_KEYS.every((key) => nonEmptyText(storyboard[key]))) return false
  return nonEmptyText(rec.type_classification)
    && nonEmptyText(rec.description)
    && nonEmptyText(rec.selection_reasoning)
    && nonEmptyText(rec.edit_suggestion)
    && (numberValue(rec.weighted_score) || 0) > 0
    && String(rec.selection || '').trim().startsWith('[')
}

function fileInfo(path: string): { path: string; exists: boolean; size: number } {
  try {
    const stat = statSync(path)
    return { path, exists: stat.isFile(), size: stat.isFile() ? stat.size : 0 }
  } catch {
    return { path, exists: false, size: 0 }
  }
}

function deliveryOutputPath(report: Record<string, unknown> | null, key: string, fallback: string): string {
  const required = objectValue(report?.required_outputs)
  const entry = objectValue(required?.[key])
  return stringValue(entry?.path) || fallback
}

function inspectArtifacts(outputDir: string): ArtifactSummary {
  const assertion = inspectVeaArtifacts(outputDir)
  const requiredOutputs = assertion.summary.requiredOutputs
  const requiredOutputProblems = assertion.problems.filter((problem) => problem.includes('required output')
    || problem.includes('required_outputs'))
  const storyboardMd = requiredOutputs.storyboard_md || fileInfo(join(outputDir, `${assertion.summary.videoId}_storyboard.md`))
  const storyboardPdf = requiredOutputs.storyboard_pdf || fileInfo(join(outputDir, `${assertion.summary.videoId}_storyboard.pdf`))
  const audiovisualMd = requiredOutputs.audiovisual_md || fileInfo(join(outputDir, `${assertion.summary.videoId}_audiovisual_analysis.md`))
  const audiovisualPdf = requiredOutputs.audiovisual_pdf || fileInfo(join(outputDir, `${assertion.summary.videoId}_audiovisual_analysis.pdf`))

  return {
    outputDir: assertion.outputDir,
    runStateStatus: assertion.summary.runStateStatus || '',
    runStateStage: assertion.summary.runStateStage || '',
    totalScenes: assertion.summary.totalScenes,
    completeScenes: assertion.summary.completeScenes,
    incompleteSceneNumbers: assertion.summary.incompleteScenes.map((scene) => scene.sceneNumber),
    hostBatches: assertion.summary.hostBatches,
    deliveryStatus: assertion.summary.deliveryStatus || '',
    requiredOutputsOk: requiredOutputProblems.length === 0,
    requiredOutputProblems,
    storyboardMd,
    storyboardPdf,
    audiovisualMd,
    audiovisualPdf,
    complete: assertion.ok,
    problems: assertion.problems,
  }
}

function inspectHostBatches(outputDir: string): ArtifactSummary['hostBatches'] {
  const hostDir = join(outputDir, 'host_batches')
  const index = readJson(join(hostDir, 'index.json'))
  const batches = Array.isArray(index?.batches) ? index.batches : []
  let completed = 0
  let blocked = 0
  let pending = 0
  let inProgress = 0
  for (const batch of batches) {
    const rec = objectValue(batch)
    const output = rec ? stringValue(rec.output) : ''
    const payload = output ? readJson(join(hostDir, output)) : null
    const receipt = objectValue(payload?.receipt)
    const status = stringValue(receipt?.status || rec?.status).toLowerCase()
    if (status === 'completed') completed += 1
    else if (status === 'blocked') blocked += 1
    else if (status === 'in_progress') inProgress += 1
    else pending += 1
  }
  return { total: batches.length, completed, blocked, pending, inProgress }
}

function inspectPendingAudiovisualHandoffs(outputDir: string): string[] {
  const receiptPath = join(outputDir, 'audiovisual_handoff', 'receipt.json')
  const receipt = readJson(receiptPath)
  const tasks = objectValue(receipt?.tasks)
  if (!tasks) return []
  const pending: string[] = []
  for (const [name, rawTask] of Object.entries(tasks)) {
    const task = objectValue(rawTask)
    if (stringValue(task?.status) !== 'pending') continue
    pending.push(name)
  }
  return pending
}

function isSafeRelativePath(path: string): boolean {
  if (!path || isAbsolute(path)) return false
  const parts = path.replace(/\\/g, '/').split('/').filter(Boolean)
  return parts.length > 0 && parts.every((part) => part !== '.' && part !== '..')
}

function listPendingHandoffTasks(outputDir: string): HandoffTask[] {
  const handoffDir = join(outputDir, 'audiovisual_handoff')
  const receipt = readJson(join(handoffDir, 'receipt.json'))
  const tasks = objectValue(receipt?.tasks)
  if (!tasks) return []
  const pending: HandoffTask[] = []
  for (const [name, rawTask] of Object.entries(tasks)) {
    const task = objectValue(rawTask)
    if (stringValue(task?.status).toLowerCase() !== 'pending') continue
    const taskRel = stringValue(task?.task) || `audiovisual_handoff/${name}/task.md`
    const outputRelRaw = stringValue(task?.output)
    if (!isSafeRelativePath(taskRel) || !isSafeRelativePath(outputRelRaw)) continue
    const outputRel = outputRelRaw.startsWith('audiovisual_handoff/')
      ? outputRelRaw
      : `audiovisual_handoff/${outputRelRaw}`
    pending.push({
      name,
      taskPath: join(outputDir, taskRel),
      outputPath: join(outputDir, outputRel),
      receiptPath: join(handoffDir, 'receipt.json'),
    })
  }
  return pending
}

function listHandoffValidationRepairTasks(outputDir: string): HandoffTask[] {
  const receipt = readJson(join(outputDir, 'audiovisual_handoff', 'receipt.json'))
  const tasks = objectValue(receipt?.tasks)
  if (!tasks) return []
  const repairs: HandoffTask[] = []
  for (const [name, rawTask] of Object.entries(tasks)) {
    const task = objectValue(rawTask)
    const taskRel = stringValue(task?.task) || `audiovisual_handoff/${name}/task.md`
    const outputRelRaw = stringValue(task?.output)
    if (!isSafeRelativePath(taskRel) || !isSafeRelativePath(outputRelRaw)) continue
    const outputRel = outputRelRaw.startsWith('audiovisual_handoff/')
      ? outputRelRaw
      : `audiovisual_handoff/${outputRelRaw}`
    const validationErrorsPath = join(outputDir, 'audiovisual_handoff', name, 'validation_errors.json')
    const outputPath = join(outputDir, outputRel)
    if (!existsSync(validationErrorsPath) || !existsSync(outputPath)) continue
    try {
      const validationMtime = statSync(validationErrorsPath).mtimeMs
      const outputMtime = statSync(outputPath).mtimeMs
      if (validationMtime <= outputMtime) continue
    } catch {
      continue
    }
    repairs.push({
      name,
      taskPath: join(outputDir, taskRel),
      outputPath,
      receiptPath: join(outputDir, 'audiovisual_handoff', 'receipt.json'),
      validationErrorsPath,
    })
  }
  return repairs
}

function stripCodeFence(text: string): string {
  const trimmed = text.trim()
  const match = trimmed.match(/^```(?:[a-zA-Z0-9_-]+)?\s*\n([\s\S]*?)\n```$/)
  return match ? match[1].trim() : trimmed
}

function normalizeHeadingText(value: string): string {
  return value
    .replace(/[“”]/g, '"')
    .replace(/[‘’]/g, "'")
    .replace(/\s+/g, ' ')
    .trim()
}

function stripTrailingParenthetical(value: string): string {
  return value.replace(/\s*[（(][^）)]*[）)]\s*$/u, '').trim()
}

function headingKey(value: string): string {
  return stripTrailingParenthetical(normalizeHeadingText(value))
}

function extractValidationHeadingLiterals(validationErrorsText: string): string[] {
  const headings: string[] = []
  const parsed = validationErrorsText.trim() ? readJsonText(validationErrorsText) : null
  const requiredSections = Array.isArray(parsed?.required_sections) ? parsed.required_sections : []
  for (const section of requiredSections) {
    const text = stringValue(section)
    if (text.startsWith('## ')) headings.push(text)
  }
  const error = stringValue(parsed?.error)
  const missingChildPattern = /缺子条目\s+(#{2,6}\s+[^；;\n]+)/gu
  let match: RegExpExecArray | null
  while ((match = missingChildPattern.exec(error)) !== null) {
    const raw = stringValue(match[1])
    for (const heading of raw.split(/[、,，]/u).map((item) => item.trim()).filter(Boolean)) {
      if (heading.startsWith('#')) headings.push(heading)
    }
  }
  return Array.from(new Set(headings))
}

function readJsonText(text: string): Record<string, unknown> | null {
  try {
    return objectValue(JSON.parse(text) as unknown)
  } catch {
    return null
  }
}

function applyValidationHeadingLiterals(output: string, validationErrorsText: string): string {
  const expectedHeadings = extractValidationHeadingLiterals(validationErrorsText)
  if (expectedHeadings.length === 0) return output
  const lines = output.split(/\r?\n/)
  for (const expected of expectedHeadings) {
    const expectedMatch = expected.match(/^(#{2,6})\s+(.+)$/u)
    if (!expectedMatch) continue
    const expectedLevel = expectedMatch[1]
    const expectedTitle = expectedMatch[2]
    const expectedKey = headingKey(expectedTitle)
    if (lines.some((line) => line.trim() === expected)) continue
    const index = lines.findIndex((line) => {
      const match = line.trim().match(/^(#{2,6})\s+(.+)$/u)
      if (!match || match[1] !== expectedLevel) return false
      return headingKey(match[2]) === expectedKey
    })
    if (index >= 0) lines[index] = expected
  }
  return lines.join('\n')
}

async function fetchWithTimeout(url: string, init: RequestInit, timeoutMs: number): Promise<Response> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    return await fetch(url, { ...init, signal: controller.signal })
  } finally {
    clearTimeout(timer)
  }
}

function extractOpenAIChatText(payload: unknown): string {
  const rec = objectValue(payload)
  const choices = Array.isArray(rec?.choices) ? rec.choices : []
  for (const choice of choices) {
    const message = objectValue(objectValue(choice)?.message)
    const content = message?.content
    if (typeof content === 'string' && content.trim()) return content
    if (Array.isArray(content)) {
      const text = content.map((part) => stringValue(objectValue(part)?.text)).filter(Boolean).join('\n')
      if (text.trim()) return text
    }
  }
  return ''
}

function extractResponsesText(payload: unknown): string {
  const rec = objectValue(payload)
  const direct = stringValue(rec?.output_text)
  if (direct) return direct
  const output = Array.isArray(rec?.output) ? rec.output : []
  const parts: string[] = []
  for (const item of output) {
    const content = Array.isArray(objectValue(item)?.content) ? objectValue(item)?.content as unknown[] : []
    for (const part of content) {
      const text = stringValue(objectValue(part)?.text)
      if (text) parts.push(text)
    }
  }
  return parts.join('\n')
}

function extractAnthropicText(payload: unknown): string {
  const rec = objectValue(payload)
  const content = Array.isArray(rec?.content) ? rec.content : []
  return content.map((part) => stringValue(objectValue(part)?.text)).filter(Boolean).join('\n')
}

async function requestHandoffCompletion(agentContext: AgentSpawnContextLike, taskText: string, taskName: string): Promise<string> {
  const system = [
    'You are the hosting Ready agent completing a skill handoff task packet.',
    'Read the task packet exactly and return only the requested output file content.',
    'Do not wrap the answer in code fences. Do not add explanations outside the requested artifact.',
  ].join('\n')
  const user = [
    `Pending handoff task: ${taskName}`,
    '',
    taskText,
  ].join('\n')
  const baseUrl = agentContext.base_url.replace(/\/+$/, '')
  const headers = {
    'content-type': 'application/json',
    authorization: `Bearer ${agentContext.api_key}`,
  }
  if (agentContext.api_kind === 'openai-responses') {
    const resp = await fetchWithTimeout(`${baseUrl}/responses`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        model: agentContext.model_id,
        input: [
          { role: 'system', content: system },
          { role: 'user', content: user },
        ],
        max_output_tokens: 16000,
      }),
    }, 240_000)
    const raw = await resp.text()
    if (!resp.ok) throw new Error(`handoff model failed (${resp.status}): ${raw.slice(0, 500)}`)
    const text = extractResponsesText(JSON.parse(raw))
    if (!text.trim()) throw new Error('handoff model returned empty output')
    return stripCodeFence(text)
  }
  if (agentContext.api_kind === 'anthropic-messages') {
    const resp = await fetchWithTimeout(`${baseUrl}/v1/messages`, {
      method: 'POST',
      headers: {
        ...headers,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: agentContext.model_id,
        system,
        messages: [{ role: 'user', content: user }],
        max_tokens: 16000,
      }),
    }, 240_000)
    const raw = await resp.text()
    if (!resp.ok) throw new Error(`handoff model failed (${resp.status}): ${raw.slice(0, 500)}`)
    const text = extractAnthropicText(JSON.parse(raw))
    if (!text.trim()) throw new Error('handoff model returned empty output')
    return stripCodeFence(text)
  }
  const resp = await fetchWithTimeout(`${baseUrl}/chat/completions`, {
    method: 'POST',
    headers,
    body: JSON.stringify({
      model: agentContext.model_id,
      messages: [
        { role: 'system', content: system },
        { role: 'user', content: user },
      ],
      temperature: 0.2,
      max_tokens: 16000,
    }),
  }, 240_000)
  const raw = await resp.text()
  if (!resp.ok) throw new Error(`handoff model failed (${resp.status}): ${raw.slice(0, 500)}`)
  const text = extractOpenAIChatText(JSON.parse(raw))
  if (!text.trim()) throw new Error('handoff model returned empty output')
  return stripCodeFence(text)
}

async function requestHandoffRepair(agentContext: AgentSpawnContextLike, task: HandoffTask): Promise<string> {
  const taskText = readFileSync(task.taskPath, 'utf8')
  const currentOutput = readFileSync(task.outputPath, 'utf8')
  const validationErrors = task.validationErrorsPath ? readFileSync(task.validationErrorsPath, 'utf8') : ''
  return requestHandoffCompletion(
    agentContext,
    [
      taskText,
      '',
      '--- Current output that failed validation ---',
      currentOutput,
      '',
      '--- validation_errors.json ---',
      validationErrors,
      '',
      'Repair instructions:',
      '- Return the complete corrected output file, not a patch.',
      '- Preserve useful existing analysis, but satisfy every validation error exactly.',
      '- Headings named in validation errors must appear literally, without parenthetical suffixes, typographic quote variants, or renamed wording.',
    ].join('\n'),
    `${task.name}:validation_repair`,
  )
}

async function completePendingHandoffs(outputDir: string, agentContext: AgentSpawnContextLike): Promise<HandoffCompletionSummary[]> {
  const tasks = listPendingHandoffTasks(outputDir)
  const completed: HandoffCompletionSummary[] = []
  for (const task of tasks) {
    console.error(`[vea-live] completing handoff ${task.name}`)
    const taskText = readFileSync(task.taskPath, 'utf8')
    const output = await requestHandoffCompletion(agentContext, taskText, task.name)
    mkdirSync(dirname(task.outputPath), { recursive: true })
    await writeFile(task.outputPath, output, 'utf8')
    markSkillHandoffOutputCompleted({
      receiptPath: task.receiptPath,
      taskName: task.name,
      outputPath: task.outputPath,
    })
    completed.push({
      name: task.name,
      taskPath: task.taskPath,
      outputPath: task.outputPath,
      bytesWritten: Buffer.byteLength(output, 'utf8'),
      model: `${agentContext.provider}/${agentContext.model_id}`,
    })
  }
  return completed
}

async function repairHandoffValidationErrors(outputDir: string, agentContext: AgentSpawnContextLike): Promise<HandoffCompletionSummary[]> {
  const tasks = listHandoffValidationRepairTasks(outputDir)
  const repaired: HandoffCompletionSummary[] = []
  for (const task of tasks) {
    const validationErrors = task.validationErrorsPath ? readFileSync(task.validationErrorsPath, 'utf8') : ''
    const currentOutput = readFileSync(task.outputPath, 'utf8')
    const literalFixed = applyValidationHeadingLiterals(currentOutput, validationErrors)
    const output = literalFixed !== currentOutput
      ? literalFixed
      : applyValidationHeadingLiterals(
        await requestHandoffRepair(agentContext, task),
        validationErrors,
      )
    console.error(`[vea-live] repaired handoff ${task.name}${literalFixed !== currentOutput ? ' via heading literals' : ' via model'}`)
    await writeFile(task.outputPath, output, 'utf8')
    markSkillHandoffOutputCompleted({
      receiptPath: task.receiptPath,
      taskName: task.name,
      outputPath: task.outputPath,
    })
    repaired.push({
      name: task.name,
      taskPath: task.taskPath,
      outputPath: task.outputPath,
      bytesWritten: Buffer.byteLength(output, 'utf8'),
      model: `${agentContext.provider}/${agentContext.model_id}`,
      repairedValidation: true,
    })
  }
  return repaired
}

function findUniqueNestedRunStateDir(outputDir: string): string | null {
  try {
    const candidates = readdirSync(outputDir)
      .map((name) => join(outputDir, name))
      .filter((path) => statSync(path).isDirectory())
      .filter((path) => existsSync(join(path, 'run_state.json')))
    return candidates.length === 1 ? candidates[0] : null
  } catch {
    return null
  }
}

function resolveEffectiveOutputDir(outputDir: string): string {
  if (existsSync(join(outputDir, 'run_state.json'))) return outputDir
  return findUniqueNestedRunStateDir(outputDir) || outputDir
}

function mapChildStatusToRowStatus(status: string): string {
  if (status === 'queued' || status === 'running') return status
  if (status === 'completed') return 'done'
  if (status === 'failed') return 'failed'
  if (status === 'killed') return 'cancelled'
  return 'blocked'
}

function childPayload(input: Record<string, unknown>): Record<string, unknown> {
  return {
    version: 1,
    childRunId: input.childRunId,
    kind: String(input.childRunId || '').startsWith('v') ? 'vea' : 'skill',
    parentScopeId: input.scopeId,
    parentSessionId: input.sessionId,
    skillId: input.skillId,
    skillName: input.skillName,
    requestedAction: input.action,
    requestedInput: input.requestedInput,
    singleFlightKey: input.singleFlightKey,
    parentNextHint: input.parentNextHint,
    outputDir: input.outputDir,
    runStatePath: input.runStatePath,
    eventLogPath: input.eventLogPath,
    status: input.status || 'queued',
    closeEvent: null,
    legacy: { taskRunId: null, detachedTaskId: null, projectionTaskId: null },
  }
}

class MemoryChildRunRepository {
  private readonly records = new Map<string, Record<string, unknown>>()

  createChildRun(input: Record<string, unknown>): Record<string, unknown> {
    const now = new Date().toISOString()
    const payload = childPayload(input)
    const record: Record<string, unknown> = {
      id: input.childRunId,
      scopeId: input.scopeId,
      sessionId: input.sessionId,
      agent: null,
      runId: null,
      skillId: input.skillId,
      skillName: input.skillName,
      action: input.action,
      toolName: null,
      runKind: 'child_run',
      status: mapChildStatusToRowStatus(String(payload.status)),
      interactionState: 'running',
      goalText: null,
      resourceRefs: [],
      params: input.requestedInput,
      steps: [],
      currentStepId: null,
      artifacts: [],
      outputDir: input.outputDir,
      runStatePath: input.runStatePath,
      sceneScoresPath: null,
      deliveryReportPath: null,
      failureKind: null,
      failureDetail: null,
      jobId: null,
      detachedTaskId: null,
      resumePayload: { childRun: payload },
      createdAt: now,
      startedAt: null,
      updatedAt: now,
      finishedAt: null,
    }
    this.records.set(String(input.childRunId), record)
    return record
  }

  updateChildRun(childRunId: string, patch: Record<string, unknown>): void {
    const record = this.records.get(childRunId)
    if (!record) throw new Error(`No child run: ${childRunId}`)
    const resumePayload = objectValue(record.resumePayload) || {}
    const current = objectValue(resumePayload.childRun) || {}
    const next = { ...current, ...patch }
    record.resumePayload = { ...resumePayload, childRun: next }
    record.updatedAt = new Date().toISOString()
    if (patch.status !== undefined) {
      record.status = mapChildStatusToRowStatus(String(patch.status))
      if (['completed', 'failed', 'killed'].includes(String(patch.status))) {
        record.finishedAt = record.updatedAt
      }
    }
    if (patch.outputDir !== undefined) record.outputDir = patch.outputDir
    if (patch.runStatePath !== undefined) record.runStatePath = patch.runStatePath
  }

  get(childRunId: string): Record<string, unknown> | null {
    return this.records.get(childRunId) || null
  }

  findLatestChildRunByKey(singleFlightKey: string): Record<string, unknown> | null {
    const active = ['queued', 'running', 'recoverable_paused', 'budget_paused']
    return [...this.records.values()]
      .filter((record) => {
        const child = objectValue(objectValue(record.resumePayload)?.childRun)
        return child?.singleFlightKey === singleFlightKey && active.includes(String(child.status))
      })
      .sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)))[0] || null
  }
}

async function createRunner(opts: Options) {
  const [
    runtime,
    runner,
    _driver,
  ] = await Promise.all([
    import('../src/main/modules/skills-runtime/runtime-manager'),
    import('../src/main/modules/agent-control/skill-child-runner'),
    import('../src/main/modules/agent-control/video-expert-child-driver'),
  ])
  runner.__resetSkillChildRunnerForTests?.()
  const manager = new runtime.SkillsRuntimeManager({
    runtimeRoot: opts.runtimeRoot,
    embeddedSkillsRoot: join(process.cwd(), 'assets', 'embedded-skills'),
    startBackgroundTasks: false,
  })
  runner.configureSkillChildRunner({
    runtimeManager: manager,
    repository: new MemoryChildRunRepository() as never,
  })
  return {
    startSkillChildRun: runner.startSkillChildRun as Function,
    waitForSkillChildRunClose: runner.waitForSkillChildRunClose as Function,
  }
}

async function runOneChildAction(args: {
  runnerApi: Awaited<ReturnType<typeof createRunner>>
  opts: Options
  agentContext: AgentSpawnContextLike
  round: number
  action: string
  input: Record<string, unknown>
}): Promise<ChildRunSummary> {
  const launch = await args.runnerApi.startSkillChildRun({
    scopeId: 'agent-vea-live-acceptance',
    sessionId: 'agent-vea-live-acceptance',
    skillId: 'video-expert-analyzer',
    action: args.action,
    requestedInput: args.input,
    parentNextHint: 'wait_for_close_event',
    triggerType: 'agent',
    agentContext: args.agentContext,
  })
  let wait: { kind: string; closeEvent?: Record<string, unknown> } = {
    kind: launch.closeEvent ? 'closed' : 'not_waited',
    closeEvent: launch.closeEvent || undefined,
  }
  if (!launch.closeEvent) {
    wait = await args.runnerApi.waitForSkillChildRunClose(launch.childRunId, { timeoutMs: args.opts.waitMs })
  }
  const close = wait.closeEvent || launch.closeEvent || null
  return {
    round: args.round,
    action: args.action,
    childRunId: launch.childRunId,
    launchStatus: launch.status,
    waitKind: wait.kind,
    eventLogPath: launch.eventLogPath,
    outputDir: close ? stringValue(close.outputDir) : stringValue(launch.outputDir),
    runStatePath: close ? stringValue(close.runStatePath) : stringValue(launch.runStatePath),
    sceneScoresPath: close ? stringValue(close.sceneScoresPath) : stringValue(launch.sceneScoresPath),
    closeStatus: close ? stringValue(close.status) : null,
    terminalReason: close ? stringValue(close.terminalReason) : null,
    errorMessage: close ? stringValue(objectValue(close.error)?.message) : null,
  }
}

async function runPhase(args: {
  phase: Phase
  opts: Options
  runnerApi: Awaited<ReturnType<typeof createRunner>>
  agentContext: AgentSpawnContextLike
  deps: AcceptanceDeps
}): Promise<PhaseResult> {
  const runs: ChildRunSummary[] = []
  for (let round = 1; round <= args.opts.maxRounds; round += 1) {
    const beforeOutputDir = resolveEffectiveOutputDir(args.opts.outputDir)
    const before = inspectArtifacts(beforeOutputDir)
    if (before.complete) return { phase: args.phase, success: true, runs, artifacts: before }
    const sceneScoresPath = join(beforeOutputDir, 'scene_scores.json')
    const action = args.phase === 'fresh' && round === 1 && !existsSync(sceneScoresPath)
      ? 'video_expert_pipeline'
      : 'video_expert_ai_analyze'
    const input = action === 'video_expert_pipeline'
      ? { url: args.opts.url, outputDir: args.opts.outputDir, exactOutputDir: true }
      : { sceneScoresPath, outputDir: args.opts.outputDir }
    const run = await runOneChildAction({
      runnerApi: args.runnerApi,
      opts: args.opts,
      agentContext: args.agentContext,
      round,
      action,
      input,
    })
    const afterOutputDir = run.outputDir || resolveEffectiveOutputDir(args.opts.outputDir)
    const pendingHandoffs = inspectPendingAudiovisualHandoffs(afterOutputDir)
    if (pendingHandoffs.length > 0) run.pendingHandoffs = pendingHandoffs
    const handoffCompletions: HandoffCompletionSummary[] = []
    if (pendingHandoffs.length > 0) {
      if (args.opts.handoffMode === 'observe') {
        runs.push(run)
        const after = inspectArtifacts(afterOutputDir)
        return {
          phase: args.phase,
          success: run.waitKind === 'closed' && run.closeStatus === 'completed',
          runs,
          artifacts: after,
          observedPendingHandoff: true,
        }
      }
      handoffCompletions.push(...await args.deps.completePendingHandoffs(afterOutputDir, args.agentContext))
    }
    handoffCompletions.push(...await args.deps.repairHandoffValidationErrors(afterOutputDir, args.agentContext))
    if (handoffCompletions.length > 0) run.handoffCompletions = handoffCompletions
    runs.push(run)
    const after = inspectArtifacts(afterOutputDir)
    if (after.complete) return { phase: args.phase, success: true, runs, artifacts: after }
    if (run.waitKind !== 'closed') return { phase: args.phase, success: false, runs, artifacts: after }
    if (run.closeStatus === 'completed' && before.completeScenes === after.completeScenes && round > 1) {
      return { phase: args.phase, success: false, runs, artifacts: after }
    }
  }
  return {
    phase: args.phase,
    success: false,
    runs,
    artifacts: inspectArtifacts(resolveEffectiveOutputDir(args.opts.outputDir)),
  }
}

function cleanOutputDir(outputDir: string): void {
  if (!outputDir.startsWith(`${homedir()}/Documents/实验田/测试/`)) {
    throw new Error(`Refusing to clean output outside test root: ${outputDir}`)
  }
  rmSync(outputDir, { recursive: true, force: true })
  mkdirSync(outputDir, { recursive: true })
}

function summarizeAgentContext(agentContext: AgentSpawnContextLike): Record<string, unknown> {
  return {
    provider: agentContext.provider,
    model_id: agentContext.model_id,
    base_url: agentContext.base_url,
    api_kind: agentContext.api_kind,
    input_modes: agentContext.input_modes,
    fallback_chain: agentContext.fallback_chain,
    api_key_present: Boolean(agentContext.api_key),
  }
}

const defaultDeps: AcceptanceDeps = {
  makeAgentContext,
  createRunner,
  completePendingHandoffs,
  repairHandoffValidationErrors,
  cleanOutputDir,
}

function resolveDeps(deps: Partial<AcceptanceDeps> = {}): AcceptanceDeps {
  return { ...defaultDeps, ...deps }
}

export function phasesForMode(mode: Mode): readonly Phase[] {
  if (mode === 'both') return ['resume', 'fresh']
  if (mode === 'fresh-resume') return ['fresh', 'resume']
  return [mode]
}

function shouldCleanBeforePhase(opts: Options, phase: Phase): boolean {
  return phase === 'fresh' && (opts.cleanBeforeFresh || opts.mode === 'fresh-resume')
}

function buildFreshResumeCheck(opts: Options, results: PhaseResult[]): AcceptanceReport['freshResume'] {
  if (opts.mode !== 'fresh-resume') return undefined
  const fresh = results.find((result) => result.phase === 'fresh')
  const resume = results.find((result) => result.phase === 'resume')
  const expectedOutputDir = resolve(opts.outputDir)
  const freshOutputDir = fresh?.artifacts.outputDir ? resolve(fresh.artifacts.outputDir) : null
  const resumeOutputDir = resume?.artifacts.outputDir ? resolve(resume.artifacts.outputDir) : null
  return {
    expectedOutputDir,
    freshOutputDir,
    resumeOutputDir,
    sameOutputDir: freshOutputDir === expectedOutputDir && resumeOutputDir === expectedOutputDir,
  }
}

export async function runAcceptance(
  opts: Options,
  depsInput: Partial<AcceptanceDeps> = {},
): Promise<{ report: AcceptanceReport; reportPath: string }> {
  const deps = resolveDeps(depsInput)
  const agentContext = deps.makeAgentContext(opts)
  const runnerApi = await deps.createRunner(opts)
  const startedAt = new Date().toISOString()
  const phases = phasesForMode(opts.mode)
  const results: PhaseResult[] = []

  for (const phase of phases) {
    if (shouldCleanBeforePhase(opts, phase)) deps.cleanOutputDir(opts.outputDir)
    const result = await runPhase({ phase, opts, runnerApi, agentContext, deps })
    results.push(result)
    if (!result.success) break
  }

  const freshResume = buildFreshResumeCheck(opts, results)
  const report: AcceptanceReport = {
    success: results.length === phases.length
      && results.every((result) => result.success)
      && (!freshResume || freshResume.sameOutputDir),
    startedAt,
    finishedAt: new Date().toISOString(),
    mode: opts.mode,
    handoffMode: opts.handoffMode,
    url: opts.url,
    outputDir: opts.outputDir,
    runtimeRoot: opts.runtimeRoot,
    agentContext: summarizeAgentContext(agentContext),
    results,
    freshResume,
    debug: {
      directChatLog: '/tmp/ready-directchat.log',
      toolsLog: '/tmp/ready-tools.log',
      runtimeChildRunLogDir: join(opts.runtimeRoot, '.ready', 'child-runs'),
      latestRuntimeChildRunLogs: latestFiles(join(opts.runtimeRoot, '.ready', 'child-runs'), 8),
    },
  }

  const reportDir = join(tmpdir(), `ready-vea-live-acceptance-${Date.now()}-${randomUUID().slice(0, 8)}`)
  mkdirSync(reportDir, { recursive: true })
  const reportPath = join(reportDir, 'report.json')
  await import('node:fs/promises').then((fs) => fs.writeFile(reportPath, JSON.stringify(report, null, 2), 'utf8'))
  return { report, reportPath }
}

async function main(): Promise<void> {
  const opts = parseArgs(process.argv.slice(2))
  const { report, reportPath } = await runAcceptance(opts)

  if (opts.json) {
    process.stdout.write(`${JSON.stringify({ ...report, reportPath }, null, 2)}\n`)
  } else {
    console.log(`Report: ${reportPath}`)
    console.log(`Success: ${report.success}`)
    for (const result of report.results) {
      console.log(`${result.phase}: ${result.success ? 'PASS' : 'FAIL'} ${result.artifacts.completeScenes}/${result.artifacts.totalScenes} scenes`)
      if (result.artifacts.problems.length) {
        for (const problem of result.artifacts.problems) console.log(`  - ${problem}`)
      }
    }
  }
  if (!report.success) process.exitCode = 1
}

function latestFiles(dir: string, limit: number): string[] {
  try {
    return readdirSync(dir)
      .map((name) => join(dir, name))
      .filter((file) => statSync(file).isFile())
      .sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs)
      .slice(0, limit)
  } catch {
    return []
  }
}

function isMainModule(): boolean {
  const entry = process.argv[1]
  return Boolean(entry) && import.meta.url === pathToFileURL(resolve(entry)).href
}

if (isMainModule()) {
  void main().catch((error) => {
    console.error(error instanceof Error ? error.stack || error.message : String(error))
    process.exitCode = 1
  })
}
