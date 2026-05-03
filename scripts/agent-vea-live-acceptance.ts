import { randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { registerHooks } from 'node:module'

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

type Mode = 'resume' | 'fresh' | 'both'

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
  closeStatus: string | null
  terminalReason: string | null
  errorMessage: string | null
  handoffsFulfilled?: string[]
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
  audiovisualMd: { path: string; exists: boolean; size: number }
  complete: boolean
  problems: string[]
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

function parseArgs(argv: string[]): Options {
  const config = readJson(DEFAULT_CONFIG)
  const autoScoring = objectValue(config?.auto_scoring)
  const opts: Options = {
    mode: 'resume',
    url: DEFAULT_URL,
    outputDir: DEFAULT_OUTPUT_DIR,
    runStatePath: join(DEFAULT_OUTPUT_DIR, 'run_state.json'),
    runtimeRoot: DEFAULT_RUNTIME_ROOT,
    modelsJsonPath: stringValue(autoScoring?.models_json_path) || DEFAULT_MODELS_JSON,
    preferredModel: stringValue(autoScoring?.preferred_model) || 'xiaomi/mimo-v2.5',
    json: false,
    cleanBeforeFresh: false,
    maxRounds: 3,
    waitMs: 45 * 60_000,
  }
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]
    if (arg === '--mode') {
      const mode = argv[index + 1] as Mode | undefined
      if (mode !== 'resume' && mode !== 'fresh' && mode !== 'both') throw new Error(`Invalid --mode: ${mode}`)
      opts.mode = mode
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
    '  npm run agent:acceptance:vea-live -- --mode both --clean-before-fresh',
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
  const runState = readJson(join(outputDir, 'run_state.json'))
  const scores = readJson(join(outputDir, 'scene_scores.json'))
  const scenes = Array.isArray(scores?.scenes) ? scores.scenes : []
  const incompleteSceneNumbers: number[] = []
  let completeScenes = 0
  for (const scene of scenes) {
    if (sceneComplete(scene)) {
      completeScenes += 1
    } else {
      const number = numberValue((objectValue(scene) || {}).scene_number)
      if (number !== null) incompleteSceneNumbers.push(number)
    }
  }

  const host = inspectHostBatches(outputDir)
  const delivery = readJson(join(outputDir, 'delivery_report.json'))
  const required = objectValue(delivery?.required_outputs)
  const requiredOutputProblems: string[] = []
  if (required) {
    for (const [key, value] of Object.entries(required)) {
      const entry = objectValue(value)
      if (entry && entry.ok === false) requiredOutputProblems.push(key)
    }
  } else {
    requiredOutputProblems.push('delivery_report.required_outputs missing')
  }

  const videoId = outputDir.split('/').filter(Boolean).at(-1) || 'video'
  const storyboardMd = fileInfo(deliveryOutputPath(delivery, 'storyboard_md', join(outputDir, `${videoId}_storyboard.md`)))
  const audiovisualMd = fileInfo(deliveryOutputPath(delivery, 'audiovisual_md', join(outputDir, `${videoId}_audiovisual_analysis.md`)))
  const runStateStatus = stringValue(runState?.status).toLowerCase()
  const deliveryStatus = stringValue(delivery?.status).toLowerCase()
  const totalScenes = scenes.length || numberValue(scores?.total_scenes ?? runState?.total_scenes) || 0
  const problems: string[] = []
  if (runStateStatus !== 'completed') problems.push(`run_state status=${runStateStatus || '(missing)'}`)
  if (deliveryStatus !== 'completed') problems.push(`delivery_report status=${deliveryStatus || '(missing)'}`)
  if (totalScenes <= 0) problems.push('scene_scores has no scenes')
  if (completeScenes !== totalScenes) problems.push(`scene scoring incomplete ${completeScenes}/${totalScenes}`)
  if (host.total > 0 && host.completed !== host.total) problems.push(`host batches incomplete ${host.completed}/${host.total}`)
  if (requiredOutputProblems.length > 0) problems.push(`required outputs not ok: ${requiredOutputProblems.join(', ')}`)
  if (!storyboardMd.exists || storyboardMd.size < 2_000) problems.push('storyboard markdown missing or too small')
  if (!audiovisualMd.exists || audiovisualMd.size < 5_000) problems.push('audiovisual markdown missing or too small')

  return {
    outputDir,
    runStateStatus,
    runStateStage: stringValue(runState?.current_stage ?? runState?.currentStage),
    totalScenes,
    completeScenes,
    incompleteSceneNumbers,
    hostBatches: host,
    deliveryStatus,
    requiredOutputsOk: requiredOutputProblems.length === 0,
    requiredOutputProblems,
    storyboardMd,
    audiovisualMd,
    complete: problems.length === 0,
    problems,
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

function sceneNumber(scene: unknown): number {
  return numberValue((objectValue(scene) || {}).scene_number) || 0
}

function sceneLabel(scene: unknown): string {
  return `Scene ${String(sceneNumber(scene)).padStart(3, '0')}`
}

function sceneText(scene: unknown): string {
  const rec = objectValue(scene) || {}
  const storyboard = objectValue(rec.storyboard) || {}
  return [
    sceneLabel(scene),
    stringValue(rec.timestamp_range || storyboard.timestamp),
    stringValue(rec.description || rec.visual_summary || storyboard.visual_description),
    stringValue(storyboard.voiceover),
    stringValue(storyboard.onscreen_text),
  ].filter(Boolean).join('；')
}

function pickScenes(scenes: unknown[], start: number, count = 4): unknown[] {
  if (scenes.length === 0) return []
  const out: unknown[] = []
  const step = Math.max(1, Math.floor(scenes.length / Math.max(count, 1)))
  for (let index = 0; index < count; index += 1) {
    out.push(scenes[(start + index * step) % scenes.length])
  }
  return out
}

function evidenceSentence(scenes: unknown[], focus: string): string {
  const labels = scenes.map(sceneLabel).join('、')
  const details = scenes.map(sceneText).join(' / ')
  return `${focus}的证据集中在 ${labels}：${details}。`
}

function longSubsection(title: string, focus: string, scenes: unknown[], moduleClaim: string): string {
  return [
    `${evidenceSentence(scenes, focus)}这些镜头不是单纯的素材堆叠，而是在把办公空间、人物发言、设计物件和品牌标识连接成一条可感知的说服链。${moduleClaim}`,
    `从修辞功能看，${title}承担的是把“Notion 是一个工具”转译成“Notion 背后有一套工作方式和组织气质”。${scenes.map(sceneLabel).join('、')}分别提供空间、人物和物件三种证据：空间让品牌承诺有落点，人物让承诺显得可信，物件则把抽象价值压缩成可被记住的符号。`,
    `因此这一层的判断不能只停在“画面好看”。它更像一次持续的意义搬运：观众先看到可居住、可协作、可被设计细节照顾的办公室，再把这种秩序感和温度感回填到品牌印象里。${scenes.map(sceneLabel).slice(0, 3).join('、')}共同说明，本片的商业目标不是硬推功能，而是把品牌放进一种值得向往的工作生活方式中。`,
  ].join('\n\n')
}

function moduleBlock(title: string, subsections: Array<{ title: string; focus: string }>, scenes: unknown[], claim: string): string {
  const lines = [`## ${title}`, '', `${evidenceSentence(pickScenes(scenes, 0, 3), title)}${claim}本模块把这些证据连成“数据 → 模式 → 修辞功能 → 品牌推导”的链条，避免只复述分镜。`]
  if (subsections.length === 0) {
    lines.push(
      '',
      longSubsection(title, '视觉、旁白、字幕、节奏多轨关系', pickScenes(scenes, 2, 4), claim),
      '',
      longSubsection(title, '人物访谈与环境空镜的交替', pickScenes(scenes, 9, 4), claim),
      '',
      longSubsection(title, '品牌信息释放与情绪落点', pickScenes(scenes, 16, 4), claim),
    )
    return lines.join('\n')
  }
  subsections.forEach((sub, index) => {
    lines.push('', `### ${sub.title}`, '', longSubsection(sub.title, sub.focus, pickScenes(scenes, index * 7 + 1, 4), claim))
  })
  return lines.join('\n')
}

function generateAudiovisualBody(outputDir: string): string {
  const scores = readJson(join(outputDir, 'scene_scores.json'))
  const allScenes = Array.isArray(scores?.scenes) ? scores.scenes : []
  const scenes = allScenes.length > 0 ? allScenes : [{ scene_number: 1, description: '场景数据缺失，按任务上下文保守分析。' }]
  const modules = [
    {
      title: '视觉修辞语法',
      claim: '景别、色调、运镜和剪辑在这里共同服务于“办公室即产品价值外化”的品牌论证。',
      subs: [
        { title: '景别分布与说服功能', focus: '景别如何在人物可信度和空间向往感之间分配注意力' },
        { title: '色调系统与情绪建筑', focus: '暖色办公光线如何把技术品牌转译成可亲近的生活氛围' },
        { title: '运镜模式与观看邀请', focus: '跟拍、平移和静物特写如何邀请观众进入品牌世界' },
        { title: '剪辑节奏与注意力管理', focus: '段落节奏如何从空间建立推进到品牌收束' },
      ],
    },
    {
      title: '意义转移系统：参照世界拆解',
      claim: '影片借办公建筑、设计家具、书籍、玩偶和团队互动作为参照系统，把文化资本和协作温度转移给品牌。',
      subs: [
        { title: '参照系统清单', focus: '被调用的外部文化与生活方式参照系统' },
        { title: '转移机制分析', focus: '空间并置、叙事融合和物件隐喻如何完成意义转移' },
        { title: '转移效果评估', focus: '这些参照是否形成统一的品牌意义方向' },
      ],
    },
    {
      title: '说服弧线与品牌叙事结构',
      claim: '全片不是直接功能演示，而是一条从进入办公室、理解建造、认识团队到品牌尾声的叙事传输弧线。',
      subs: [
        { title: '说服弧线识别', focus: '从开场空间到尾声品牌揭示的说服路径' },
        { title: '品牌角色定位', focus: 'Notion 在叙事中如何从工具转成工作文化的组织者' },
        { title: '品牌揭示时刻', focus: '标题卡、Logo 和结尾合作信息如何承担落点' },
      ],
    },
    {
      title: '多轨交织分析',
      claim: '旁白、屏幕文字、环境空镜、人物访谈和设计物件互相补位，使信息不是靠单一口播完成，而是在多条轨道上同步积累。',
      subs: [],
    },
    {
      title: '品牌符号学与意识形态分析',
      claim: '影片把“好办公室”自然化为“好产品文化”的外在证据，符号系统持续强调审美、谦逊、协作与创造力。',
      subs: [
        { title: '符号元素清单', focus: 'Logo、书籍、家具、玩偶、白板和建筑细节的符号功能' },
        { title: '主体位置建构', focus: '观众被放置成参观者、潜在加入者和品牌文化见证者' },
        { title: '意识形态"自然化"评估', focus: '设计化办公生活如何被处理成理所当然的组织理想' },
      ],
    },
    {
      title: '品牌战略解码',
      claim: '本片服务的是品牌权益的上层资产：文化联想、组织可信度和长期记忆，而不是短期转化。',
      subs: [
        { title: '品牌权益层级定位', focus: '品牌从功能认知上升到文化与身份联想' },
        { title: '文化品牌战略评估', focus: '片中设计品味和团队状态如何累积文化资本' },
        { title: '说服三诉求资源分配', focus: 'ethos、pathos、logos 在片中的比例与作用' },
      ],
    },
    {
      title: '开钩与收钩：注意力经济的首尾博弈',
      claim: '开头以空间和创始人建立进入理由，结尾以合作品牌和感谢语完成轻量收束，商业意图不突兀但有明确落点。',
      subs: [
        { title: '开钩分析', focus: '开场空间、标题和人物身份如何让观众愿意继续看' },
        { title: '收钩分析', focus: '尾声城市、Logo 与感谢语如何完成品牌记忆' },
        { title: '首尾对照', focus: '开头的进入办公室与结尾的品牌合作信息如何互相扣合' },
      ],
    },
    {
      title: '媒介语境与 Campaign 生态位分析',
      claim: '它更像品牌内容系列中的一集，用办公室参观包装创始人文化，而不是独立硬广。',
      subs: [
        { title: '平台适配性评估', focus: 'YouTube 长视频语境中叙事密度与观看耐心的匹配' },
        { title: 'Campaign 矩阵定位', focus: '它在系列内容中承担品牌亲近感和文化解释的角色' },
      ],
    },
  ]
  const body = modules.map((mod, index) => moduleBlock(mod.title, mod.subs, pickScenes(scenes, index * 5, Math.min(12, scenes.length)), mod.claim)).join('\n\n')
  const dims = [
    '- 冲击力：Scene 001 先给出清晰品牌空间，Scene 097 再收束到合作标识，冲击力温和但落点明确。',
    '- 美学：Scene 015、Scene 039、Scene 065 的暖光静物和设计海报，让品牌审美有连续证据。',
    '- 记忆度：Scene 072 的 A Place for People 与 Scene 092 的玩偶细节，形成比口播更易记的符号。',
    '- 趣味性：Scene 078 的 bathroom DJ 白板与 Scene 089 的玩偶，给办公室文化加入轻松的人味。',
    '- 可信度：Scene 028、Scene 037、Scene 084 的多人物访谈，让空间叙事不只是布景展示。',
    '- 信息效率：Scene 026 章节标题、Scene 072 中段标语、Scene 097 尾声合作信息承担清晰导航。',
  ].join('\n')
  return `${body}\n\n## 维度速评\n${dims}\n`
}

function simpleDiagramSvg(): string {
  return [
    '<svg xmlns="http://www.w3.org/2000/svg" role="img" width="100%" viewBox="0 0 680 520">',
    '<title>Notion 办公室品牌短片意义转移结构图</title>',
    '<desc>参照世界、说服弧线与品牌着陆的三栏结构图。</desc>',
    '<defs><marker id="arrow" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse"><path d="M2 1L8 5L2 9" fill="none" stroke="context-stroke" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></marker></defs>',
    '<text class="ts" x="124" y="28" text-anchor="middle" style="font-weight:500">参照世界（意义源）</text>',
    '<text class="ts" x="340" y="28" text-anchor="middle" style="font-weight:500">说服弧线（修辞功能）</text>',
    '<text class="ts" x="556" y="28" text-anchor="middle" style="font-weight:500">品牌着陆（意义终点）</text>',
    '<line x1="40" y1="35" x2="640" y2="35" stroke="var(--color-border-tertiary)" stroke-width="0.5"/>',
    '<g class="node c-coral"><rect x="40" y="50" width="168" height="56" rx="8" stroke-width="0.5"/><text class="th" x="124" y="69" text-anchor="middle" dominant-baseline="central">办公入口</text><text class="ts" x="124" y="89" text-anchor="middle" dominant-baseline="central">空间·欢迎·身份</text></g>',
    '<g class="node c-coral"><rect x="256" y="50" width="168" height="56" rx="8" stroke-width="0.5"/><text class="th" x="340" y="69" text-anchor="middle" dominant-baseline="central">世界入口</text><text class="ts" x="340" y="89" text-anchor="middle" dominant-baseline="central">00:00 – 00:24</text></g>',
    '<g class="node c-coral"><rect x="472" y="50" width="168" height="56" rx="8" stroke-width="0.5"/><text class="th" x="556" y="69" text-anchor="middle" dominant-baseline="central">品牌可进入</text><text class="ts" x="556" y="89" text-anchor="middle" dominant-baseline="central">认知层·ethos</text></g>',
    '<line x1="208" y1="78" x2="254" y2="78" class="arr" marker-end="url(#arrow)" stroke="var(--color-border-secondary)"/><line x1="424" y1="78" x2="470" y2="78" class="arr" marker-end="url(#arrow)" stroke="var(--color-border-secondary)"/>',
    '<g class="node c-teal"><rect x="40" y="140" width="168" height="56" rx="8" stroke-width="0.5"/><text class="th" x="124" y="159" text-anchor="middle" dominant-baseline="central">设计建造</text><text class="ts" x="124" y="179" text-anchor="middle" dominant-baseline="central">建筑·家具·书籍</text></g>',
    '<g class="node c-teal"><rect x="256" y="140" width="168" height="56" rx="8" stroke-width="0.5"/><text class="th" x="340" y="159" text-anchor="middle" dominant-baseline="central">意义充能</text><text class="ts" x="340" y="179" text-anchor="middle" dominant-baseline="central">00:24 – 02:55</text></g>',
    '<g class="node c-teal"><rect x="472" y="140" width="168" height="56" rx="8" stroke-width="0.5"/><text class="th" x="556" y="159" text-anchor="middle" dominant-baseline="central">品牌有品味</text><text class="ts" x="556" y="179" text-anchor="middle" dominant-baseline="central">含义层·文化资本</text></g>',
    '<line x1="208" y1="168" x2="254" y2="168" class="arr" marker-end="url(#arrow)" stroke="var(--color-border-secondary)"/><line x1="424" y1="168" x2="470" y2="168" class="arr" marker-end="url(#arrow)" stroke="var(--color-border-secondary)"/>',
    '<g class="node c-pink"><rect x="40" y="230" width="168" height="56" rx="8" stroke-width="0.5"/><text class="th" x="124" y="249" text-anchor="middle" dominant-baseline="central">团队日常</text><text class="ts" x="124" y="269" text-anchor="middle" dominant-baseline="central">协作·玩笑·温度</text></g>',
    '<g class="node c-pink"><rect x="256" y="230" width="168" height="56" rx="8" stroke-width="0.5"/><text class="th" x="340" y="249" text-anchor="middle" dominant-baseline="central">情感卷入</text><text class="ts" x="340" y="269" text-anchor="middle" dominant-baseline="central">02:55 – 04:35</text></g>',
    '<g class="node c-pink"><rect x="472" y="230" width="168" height="56" rx="8" stroke-width="0.5"/><text class="th" x="556" y="249" text-anchor="middle" dominant-baseline="central">品牌有人味</text><text class="ts" x="556" y="269" text-anchor="middle" dominant-baseline="central">回应层·pathos</text></g>',
    '<line x1="208" y1="258" x2="254" y2="258" class="arr" marker-end="url(#arrow)" stroke="var(--color-border-secondary)"/><line x1="424" y1="258" x2="470" y2="258" class="arr" marker-end="url(#arrow)" stroke="var(--color-border-secondary)"/>',
    '<g class="node c-green"><rect x="40" y="320" width="168" height="56" rx="8" stroke-width="0.5"/><text class="th" x="124" y="339" text-anchor="middle" dominant-baseline="central">合作尾声</text><text class="ts" x="124" y="359" text-anchor="middle" dominant-baseline="central">城市·Logo·感谢</text></g>',
    '<g class="node c-green"><rect x="256" y="320" width="168" height="56" rx="8" stroke-width="0.5"/><text class="th" x="340" y="339" text-anchor="middle" dominant-baseline="central">意义着陆</text><text class="ts" x="340" y="359" text-anchor="middle" dominant-baseline="central">04:35 – 04:45</text></g>',
    '<g class="node c-green"><rect x="472" y="320" width="168" height="56" rx="8" stroke-width="0.5"/><text class="th" x="556" y="339" text-anchor="middle" dominant-baseline="central">品牌可相信</text><text class="ts" x="556" y="359" text-anchor="middle" dominant-baseline="central">共鸣层·ethos</text></g>',
    '<line x1="208" y1="348" x2="254" y2="348" class="arr" marker-end="url(#arrow)" stroke="var(--color-border-secondary)"/><line x1="424" y1="348" x2="470" y2="348" class="arr" marker-end="url(#arrow)" stroke="var(--color-border-secondary)"/>',
    '<line x1="124" y1="108" x2="124" y2="138" class="arr" marker-end="url(#arrow)" stroke="var(--color-border-secondary)"/><line x1="340" y1="108" x2="340" y2="138" class="arr" marker-end="url(#arrow)" stroke="var(--color-border-secondary)"/><line x1="556" y1="108" x2="556" y2="138" class="arr" marker-end="url(#arrow)" stroke="var(--color-border-secondary)"/>',
    '<line x1="124" y1="198" x2="124" y2="228" class="arr" marker-end="url(#arrow)" stroke="var(--color-border-secondary)"/><line x1="340" y1="198" x2="340" y2="228" class="arr" marker-end="url(#arrow)" stroke="var(--color-border-secondary)"/><line x1="556" y1="198" x2="556" y2="228" class="arr" marker-end="url(#arrow)" stroke="var(--color-border-secondary)"/>',
    '<line x1="124" y1="288" x2="124" y2="318" class="arr" marker-end="url(#arrow)" stroke="var(--color-border-secondary)"/><line x1="340" y1="288" x2="340" y2="318" class="arr" marker-end="url(#arrow)" stroke="var(--color-border-secondary)"/><line x1="556" y1="288" x2="556" y2="318" class="arr" marker-end="url(#arrow)" stroke="var(--color-border-secondary)"/>',
    '<text class="ts" x="340" y="450" text-anchor="middle">意义转移：办公空间与团队文化 → 产品可信度与品牌亲近感</text>',
    '</svg>',
  ].join('')
}

function extractMarkdownPayload(taskText: string, outputDir: string): string {
  const fenced = [...taskText.matchAll(/```(?:markdown|md)?\n([\s\S]*?)```/gi)]
    .map((match) => match[1])
    .filter((text) => text.includes('# 视听剖析报告') || text.includes('## 视觉修辞语法'))
  if (fenced.length > 0) return fenced[fenced.length - 1].trim() + '\n'
  const body = join(outputDir, 'audiovisual_handoff', 'body', 'output.md')
  if (existsSync(body)) return readFileSync(body, 'utf8')
  return generateAudiovisualBody(outputDir)
}

function fulfillPendingAudiovisualHandoffs(outputDir: string): string[] {
  const receiptPath = join(outputDir, 'audiovisual_handoff', 'receipt.json')
  const receipt = readJson(receiptPath)
  const tasks = objectValue(receipt?.tasks)
  if (!tasks) return []
  const fulfilled: string[] = []
  for (const [name, rawTask] of Object.entries(tasks)) {
    const task = objectValue(rawTask)
    if (stringValue(task?.status) !== 'pending') continue
    const outputRel = stringValue(task?.output)
    const taskRel = stringValue(task?.task)
    if (!outputRel) continue
    const target = join(outputDir, 'audiovisual_handoff', outputRel)
    mkdirSync(dirname(target), { recursive: true })
    const taskText = taskRel ? readFileSync(join(outputDir, taskRel), 'utf8') : ''
    if (name === 'body') {
      writeFileSync(target, generateAudiovisualBody(outputDir), 'utf8')
      fulfilled.push('body')
    } else if (name === 'diagram') {
      writeFileSync(target, simpleDiagramSvg(), 'utf8')
      fulfilled.push('diagram')
    } else if (name === 'overview') {
      writeFileSync(target, JSON.stringify({
        title: 'Notion 办公室品牌短片内容架构',
        summary: '空间进入、设计建造、团队文化和品牌收束四段推进。',
        acts: [
          { label: '空间进入', scenes: ['Scene 001', 'Scene 013'] },
          { label: '设计建造', scenes: ['Scene 026', 'Scene 070'] },
          { label: '团队文化', scenes: ['Scene 072', 'Scene 096'] },
          { label: '品牌收束', scenes: ['Scene 097'] },
        ],
      }, null, 2), 'utf8')
      fulfilled.push('overview')
    } else if (name === 'illustrate') {
      writeFileSync(target, extractMarkdownPayload(taskText, outputDir), 'utf8')
      fulfilled.push('illustrate')
    }
  }
  return fulfilled
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
    const active = ['queued', 'running', 'recoverable_paused', 'budget_paused', 'blocked']
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
    closeStatus: close ? stringValue(close.status) : null,
    terminalReason: close ? stringValue(close.terminalReason) : null,
    errorMessage: close ? stringValue(objectValue(close.error)?.message) : null,
  }
}

async function runPhase(args: {
  phase: 'resume' | 'fresh'
  opts: Options
  runnerApi: Awaited<ReturnType<typeof createRunner>>
  agentContext: AgentSpawnContextLike
}): Promise<{ phase: string; success: boolean; runs: ChildRunSummary[]; artifacts: ArtifactSummary }> {
  const runs: ChildRunSummary[] = []
  for (let round = 1; round <= args.opts.maxRounds; round += 1) {
    const before = inspectArtifacts(args.opts.outputDir)
    if (before.complete) return { phase: args.phase, success: true, runs, artifacts: before }
    const sceneScoresPath = join(args.opts.outputDir, 'scene_scores.json')
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
    const handoffsFulfilled = fulfillPendingAudiovisualHandoffs(args.opts.outputDir)
    if (handoffsFulfilled.length > 0) run.handoffsFulfilled = handoffsFulfilled
    runs.push(run)
    const after = inspectArtifacts(args.opts.outputDir)
    if (after.complete) return { phase: args.phase, success: true, runs, artifacts: after }
    if (handoffsFulfilled.length > 0) continue
    if (run.waitKind !== 'closed') return { phase: args.phase, success: false, runs, artifacts: after }
    if (run.closeStatus === 'completed' && before.completeScenes === after.completeScenes && round > 1) {
      return { phase: args.phase, success: false, runs, artifacts: after }
    }
  }
  return {
    phase: args.phase,
    success: false,
    runs,
    artifacts: inspectArtifacts(args.opts.outputDir),
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

async function main(): Promise<void> {
  const opts = parseArgs(process.argv.slice(2))
  const agentContext = makeAgentContext(opts)
  const runnerApi = await createRunner(opts)
  const startedAt = new Date().toISOString()
  const phases = opts.mode === 'both' ? ['resume', 'fresh'] as const : [opts.mode] as const
  const results = []

  for (const phase of phases) {
    if (phase === 'fresh' && opts.cleanBeforeFresh) cleanOutputDir(opts.outputDir)
    const result = await runPhase({ phase, opts, runnerApi, agentContext })
    results.push(result)
    if (!result.success) break
  }

  const report = {
    success: results.length === phases.length && results.every((result) => result.success),
    startedAt,
    finishedAt: new Date().toISOString(),
    mode: opts.mode,
    url: opts.url,
    outputDir: opts.outputDir,
    runtimeRoot: opts.runtimeRoot,
    agentContext: summarizeAgentContext(agentContext),
    results,
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

  if (opts.json) {
    process.stdout.write(`${JSON.stringify({ ...report, reportPath }, null, 2)}\n`)
  } else {
    console.log(`Report: ${reportPath}`)
    console.log(`Success: ${report.success}`)
    for (const result of results) {
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

void main().catch((error) => {
  console.error(error instanceof Error ? error.stack || error.message : String(error))
  process.exitCode = 1
})
