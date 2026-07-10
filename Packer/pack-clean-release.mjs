#!/usr/bin/env node

import {
  chmodSync,
  closeSync,
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  openSync,
  readSync,
  realpathSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { basename, delimiter, join, relative, resolve, sep } from 'node:path'
import YAML from 'yaml'

const projectRoot = fileURLToPath(new URL('../', import.meta.url))
const packerRoot = fileURLToPath(new URL('./', import.meta.url))
const stagingRoot = join(packerRoot, '.staging', 'clean-package')
const exportsDir = join(projectRoot, 'exports')
const cleanSeedPath = join(stagingRoot, 'build', 'runtime-seeds', 'ai-settings.seed.json')
const cleanPythonRoot = join(stagingRoot, 'src', 'python')
const cleanEmbeddedSkillsRoot = join(stagingRoot, 'assets', 'embedded-skills')
const cleanPackagedRuntimeRoot = join(stagingRoot, 'release-runtime', 'skill-runtime')
const dmgVerifyMountPoint = join(stagingRoot, 'dmg-verify-mount')
const builderConfigPath = join(projectRoot, 'electron-builder.yml')
const tempBuilderConfigPath = join(stagingRoot, 'electron-builder.clean.yml')
const manifestPath = join(exportsDir, 'clean-package-manifest.json')

const argv = new Set(process.argv.slice(2))
const dirOnly = argv.has('--dir-only')
const skipCleanExports = argv.has('--skip-clean-exports')
const keepStaging = argv.has('--keep-staging')
const allowNetworkRuntime = argv.has('--allow-network-runtime')
const releaseRuntimeSource = String(process.env.READY_RELEASE_SKILL_RUNTIME_ROOT || '').trim()

// Opt-in personalized-seed injection (used by the web packer in Packer/server.mjs,
// mirroring the reference packer's *_PACKER_SEED_CONFIG env). When set, the bundled
// ai-settings seed is the provided config instead of an empty object. Baking an API
// key is only allowed together with READY_PACKER_ALLOW_BAKED_KEY=1, so the default
// clean-release behavior (empty seed + no-credential assertion) is unchanged.
const packerSeedConfigPath = String(process.env.READY_PACKER_SEED_CONFIG || '').trim()
const allowBakedKey = String(process.env.READY_PACKER_ALLOW_BAKED_KEY || '').trim() === '1'

const CLEAN_EXPORT_FILENAMES = new Set([
  'builder-debug.yml',
  'builder-effective-config.yaml',
  'latest-mac.yml',
  'clean-package-manifest.json',
])

const SKIP_DIR_NAMES = new Set([
  '__pycache__',
  '.pytest_cache',
  '.mypy_cache',
])

const SKIP_FILE_SUFFIXES = ['.pyc', '.pyo']
const SKIP_FILE_NAMES = new Set(['.DS_Store'])

const FORBIDDEN_RESOURCE_SEGMENTS = [
  'ready.db',
  'agent-memory',
  'agent-sidecar-runtime',
  'channel-attachments',
  'rss-artifacts',
  'rsshub-runtime',
  'puppeteer-cache',
  '__pycache__',
  '.pytest_cache',
  '.mypy_cache',
]

const PACKAGED_RUNTIME_MANIFEST = 'runtime-manifest.json'
const REQUIRED_RUNTIME_SKILLS = [
  'video-expert-analyzer',
  'video-copy-analyzer',
  'lets-go-rss',
  'deep-research',
  'systematic-literature-review',
  'github-deep-research',
  'academic-paper-review',
  'web-design-guidelines',
  'find-skills',
  'obsidian-web-clip',
  'study-notes',
  'image-analysis-router',
  'image-reverse-descriptor',
  'context-compact',
  'fastnote',
]
const REQUIRED_RUNTIME_TOOLS = ['ffmpeg', 'ffprobe', 'yt-dlp']
const REQUIRED_RUNTIME_MODULES = [
  'anthropic',
  'apscheduler',
  'browser_cookie3',
  'cv2',
  'dateutil',
  'dotenv',
  'fastapi',
  'ffmpeg',
  'funasr',
  'huggingface_hub',
  'humanfriendly',
  'httpx',
  'lark_oapi',
  'modelscope',
  'numpy',
  'openai',
  'PIL',
  'pydantic',
  'pysrt',
  'reportlab',
  'requests',
  'scenedetect',
  'torch',
  'torchaudio',
  'transformers',
  'tiktoken',
  'safetensors',
  'tokenizers',
  'uvicorn',
  'yt_dlp',
  'rapidocr_onnxruntime',
]
// 仅 fsmn-vad 随运行时内置（体积小）。ASR/标点权重改为按需下载，因此这里只做
// 轻量文件存在性校验，不再用 funasr.AutoModel 实际加载重权重。
const REQUIRED_RUNTIME_ASR_MODELS = [
  {
    name: 'FunASR fsmn-vad (bundled)',
    dir: ['cache', 'modelscope', 'models', 'iic', 'speech_fsmn_vad_zh-cn-16k-common-pytorch'],
    requiredFiles: ['model.pt', 'config.yaml'],
  },
]
const OPTIONAL_FUNASR_NANO_MODEL_ID = 'FunAudioLLM/Fun-ASR-Nano-2512'
// 初始安装包绝不内置的按需权重：Nano 在 source/staged 两处都不应出现；
// 兜底 ASR + 各标点模型仅在「已 staged」的树中断言缺席（source 合法保留）。
const ALWAYS_FORBIDDEN_BUNDLED_WEIGHTS = [
  { label: OPTIONAL_FUNASR_NANO_MODEL_ID, fragments: ['fun-asr-nano-2512', 'funasr-nano-2512'] },
]
const STAGED_FORBIDDEN_BUNDLED_WEIGHTS = [
  { label: 'iic/speech_seaco_paraformer_large_asr_nat-zh-cn-16k-common-vocab8404-pytorch', fragments: ['speech_seaco_paraformer_large_asr_nat-zh-cn-16k-common-vocab8404-pytorch'] },
  { label: 'iic/punc_ct-transformer_cn-en-common-vocab471067-large', fragments: ['punc_ct-transformer_cn-en-common-vocab471067-large'] },
  { label: 'iic/punc_ct-transformer_zh-cn-common-vocab272727-pytorch', fragments: ['punc_ct-transformer_zh-cn-common-vocab272727-pytorch'] },
]
const RUNTIME_SKIP_DIR_NAMES = new Set([
  ...SKIP_DIR_NAMES,
  'skills',
  'custom-skills',
  'outputs',
  'results',
  '.ready',
])
const MODELSCOPE_MODEL_PREFIX = `cache${sep}modelscope${sep}models${sep}iic`
// 兜底 ASR/标点权重改为按需下载（设置 › 模型与运行时），不随安装包内置；
// fsmn-vad 体积小，仍随运行时保留。
const RUNTIME_SKIP_RELATIVE_PREFIXES = [
  `cache${sep}pip`,
  `cache${sep}whisper`,
  `${MODELSCOPE_MODEL_PREFIX}${sep}speech_seaco_paraformer_large_asr_nat-zh-cn-16k-common-vocab8404-pytorch`,
  `${MODELSCOPE_MODEL_PREFIX}${sep}punc_ct-transformer_cn-en-common-vocab471067-large`,
  `${MODELSCOPE_MODEL_PREFIX}${sep}punc_ct-transformer_zh-cn-common-vocab272727-pytorch`,
]

function logStep(title, detail) {
  process.stdout.write(`\n[packer] ${title}${detail ? `: ${detail}` : ''}\n`)
}

function toPosixRelative(targetPath) {
  return relative(projectRoot, targetPath).split(sep).join('/')
}

function ensureDir(path) {
  mkdirSync(path, { recursive: true })
}

function cleanDir(path) {
  rmSync(path, { recursive: true, force: true })
}

function copyFilteredTree(src, dst) {
  const stat = lstatSync(src)
  const name = basename(src)
  if (stat.isDirectory()) {
    if (SKIP_DIR_NAMES.has(name)) return
    ensureDir(dst)
    for (const child of readdirSync(src)) {
      copyFilteredTree(join(src, child), join(dst, child))
    }
    return
  }

  if (SKIP_FILE_NAMES.has(name)) return
  if (SKIP_FILE_SUFFIXES.some((suffix) => name.endsWith(suffix))) return

  ensureDir(resolve(dst, '..'))
  copyFileSync(src, dst)
  chmodSync(dst, stat.mode)
}

function copyReleaseRuntimeTree(src, dst, root = src) {
  const stat = lstatSync(src)
  const name = basename(src)
  const rel = relative(root, src)

  if (stat.isSymbolicLink()) {
    const resolved = realpathSync(src)
    const resolvedRoot = realpathSync(root)
    if (!resolved.startsWith(`${resolvedRoot}${sep}`)) {
      throw new Error(`Release runtime contains external symlink: ${src} -> ${resolved}`)
    }
  }

  if (stat.isDirectory()) {
    if (RUNTIME_SKIP_DIR_NAMES.has(name)) return
    if (RUNTIME_SKIP_RELATIVE_PREFIXES.some((prefix) => rel === prefix || rel.startsWith(`${prefix}${sep}`))) return
    ensureDir(dst)
    chmodSync(dst, stat.mode)
    for (const child of readdirSync(src)) {
      copyReleaseRuntimeTree(join(src, child), join(dst, child), root)
    }
    return
  }

  if (SKIP_FILE_NAMES.has(name)) return
  if (SKIP_FILE_SUFFIXES.some((suffix) => name.endsWith(suffix))) return

  ensureDir(resolve(dst, '..'))
  copyFileSync(src, dst)
  chmodSync(dst, stat.mode)
}

function readShebang(file) {
  const header = Buffer.alloc(512)
  let bytesRead = 0
  const fd = openSync(file, 'r')
  try {
    bytesRead = readSync(fd, header, 0, header.length, 0)
  } finally {
    closeSync(fd)
  }
  if (bytesRead < 2 || header[0] !== 0x23 || header[1] !== 0x21) return null
  const activeHeader = header.subarray(0, bytesRead)
  const newlineIndex = activeHeader.indexOf(0x0a)
  const endIndex = newlineIndex === -1 ? bytesRead : newlineIndex
  const line = activeHeader.subarray(0, endIndex).toString('utf8')
  const content = readFileSync(file)
  const contentNewlineIndex = content.indexOf(0x0a)
  return {
    content,
    line,
    rest: contentNewlineIndex === -1 ? Buffer.from('\n') : content.subarray(contentNewlineIndex),
  }
}

function collectRuntimeLauncherFiles(runtimeRoot) {
  return [join(runtimeRoot, 'bin'), runtimePythonBinDir(runtimeRoot)]
    .filter((dir) => existsSync(dir))
    .flatMap((dir) => collectFiles(dir))
}

function rewriteRuntimePythonShebangs(runtimeRoot) {
  if (process.platform === 'win32') return []
  const rewritten = []
  for (const file of collectRuntimeLauncherFiles(runtimeRoot)) {
    const stat = lstatSync(file)
    if (!stat.isFile()) continue
    const shebang = readShebang(file)
    if (!shebang || !/python/i.test(shebang.line)) continue
    const replacement = '#!/usr/bin/env python3'
    if (shebang.line === replacement) continue
    writeFileSync(file, Buffer.concat([Buffer.from(replacement, 'utf8'), shebang.rest]))
    chmodSync(file, stat.mode)
    rewritten.push(relative(runtimeRoot, file).split(sep).join('/'))
  }
  return rewritten
}

function assertRuntimePythonShebangsAreRelocatable(runtimeRoot) {
  if (process.platform === 'win32') return
  for (const file of collectRuntimeLauncherFiles(runtimeRoot)) {
    const stat = lstatSync(file)
    if (!stat.isFile()) continue
    const shebang = readShebang(file)
    if (!shebang || !/python/i.test(shebang.line)) continue
    if (!/^#!\/usr\/bin\/env\s+python3(?:\s|$)/u.test(shebang.line)) {
      throw new Error(`Packaged runtime Python launcher is not relocatable: ${file} (${shebang.line})`)
    }
  }
}

function runCommand(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: projectRoot,
    stdio: 'inherit',
    env: {
      ...process.env,
      DISABLE_AUTO_UPDATE: 'true',
    },
    ...options,
  })
  if (result.status !== 0) {
    process.exit(result.status || 1)
  }
}

function removeOldExports() {
  if (!existsSync(exportsDir)) return
  for (const name of readdirSync(exportsDir)) {
    const fullPath = join(exportsDir, name)
    if (CLEAN_EXPORT_FILENAMES.has(name)) {
      rmSync(fullPath, { recursive: true, force: true })
      continue
    }
    if (name === 'mac-arm64') {
      rmSync(fullPath, { recursive: true, force: true })
      continue
    }
    if (/^Ready-.*\.(dmg|blockmap)$/u.test(name)) {
      rmSync(fullPath, { recursive: true, force: true })
    }
  }
}

function removeGeneratedDebugFiles() {
  for (const name of CLEAN_EXPORT_FILENAMES) {
    rmSync(join(exportsDir, name), { recursive: true, force: true })
  }
}

function buildCleanBuilderConfig() {
  const parsed = YAML.parse(readFileSync(builderConfigPath, 'utf8'))
  const extraResources = Array.isArray(parsed.extraResources) ? parsed.extraResources : []

  parsed.directories = {
    ...(parsed.directories || {}),
    output: 'exports',
  }

  parsed.extraResources = extraResources.map((entry) => {
    if (entry?.from === 'build/runtime-seeds/ai-settings.seed.json') {
      return {
        ...entry,
        from: toPosixRelative(cleanSeedPath),
      }
    }
    if (entry?.from === 'src/python') {
      return {
        ...entry,
        from: toPosixRelative(cleanPythonRoot),
      }
    }
    if (entry?.from === 'assets/embedded-skills') {
      return {
        ...entry,
        from: toPosixRelative(cleanEmbeddedSkillsRoot),
      }
    }
    return entry
  })

  if (!allowNetworkRuntime) {
    parsed.extraResources.push({
      from: toPosixRelative(cleanPackagedRuntimeRoot),
      to: 'skill-runtime',
      filter: ['**/*'],
    })
  }

  writeFileSync(tempBuilderConfigPath, YAML.stringify(parsed), 'utf8')
}

function createCleanSeed() {
  ensureDir(resolve(cleanSeedPath, '..'))
  if (packerSeedConfigPath) {
    if (!existsSync(packerSeedConfigPath)) {
      throw new Error(`READY_PACKER_SEED_CONFIG not found: ${packerSeedConfigPath}`)
    }
    const raw = readFileSync(packerSeedConfigPath, 'utf8')
    const parsed = JSON.parse(raw)
    if (hasSensitiveAIConfig(parsed) && !allowBakedKey) {
      throw new Error('READY_PACKER_SEED_CONFIG contains an API key; set READY_PACKER_ALLOW_BAKED_KEY=1 to bake it in')
    }
    writeFileSync(cleanSeedPath, raw.endsWith('\n') ? raw : `${raw}\n`, 'utf8')
    return
  }
  writeFileSync(cleanSeedPath, '{}\n', 'utf8')
}

function prepareSanitizedPython() {
  const sourcePythonRoot = join(projectRoot, 'src', 'python')
  copyFilteredTree(sourcePythonRoot, cleanPythonRoot)
}

function prepareSanitizedEmbeddedSkills() {
  const sourceEmbeddedSkillsRoot = join(projectRoot, 'assets', 'embedded-skills')
  copyFilteredTree(sourceEmbeddedSkillsRoot, cleanEmbeddedSkillsRoot)
}

function preparePackagedRuntime() {
  if (allowNetworkRuntime) return null
  if (!releaseRuntimeSource) {
    throw new Error('READY_RELEASE_SKILL_RUNTIME_ROOT is required for release packaging. Pass --allow-network-runtime only for non-release developer builds.')
  }
  if (!existsSync(releaseRuntimeSource)) {
    throw new Error(`READY_RELEASE_SKILL_RUNTIME_ROOT does not exist: ${releaseRuntimeSource}`)
  }
  verifyRuntimeSource(releaseRuntimeSource)
  copyReleaseRuntimeTree(releaseRuntimeSource, cleanPackagedRuntimeRoot)
  const rewrittenPythonLaunchers = rewriteRuntimePythonShebangs(cleanPackagedRuntimeRoot)
  assertRuntimePythonShebangsAreRelocatable(cleanPackagedRuntimeRoot)
  verifyRuntimeSource(cleanPackagedRuntimeRoot)
  // 仅对已 staged 的树断言重权重缺席：source 仍合法保留这些权重，staged 已剔除，
  // 以此证明安装包确实瘦身（兜底 ASR + 各标点权重不再内置）。
  verifyNoBundledModelWeights(cleanPackagedRuntimeRoot, STAGED_FORBIDDEN_BUNDLED_WEIGHTS)
  return {
    source: releaseRuntimeSource,
    staged: cleanPackagedRuntimeRoot,
    rewrittenPythonLaunchers,
  }
}

function collectFiles(rootDir) {
  const results = []
  if (!existsSync(rootDir)) return results

  const visit = (currentPath) => {
    const stat = lstatSync(currentPath)
    if (stat.isDirectory()) {
      for (const child of readdirSync(currentPath)) {
        visit(join(currentPath, child))
      }
      return
    }
    results.push(currentPath)
  }

  visit(rootDir)
  return results
}

function hasSensitiveAIConfig(seed) {
  const queue = [seed]
  while (queue.length > 0) {
    const current = queue.shift()
    if (!current || typeof current !== 'object') continue
    for (const [key, value] of Object.entries(current)) {
      if (key === 'apiKey' && typeof value === 'string' && value.trim()) {
        return true
      }
      if (value && typeof value === 'object') queue.push(value)
    }
  }
  return false
}

function readRuntimeManifest(runtimeRoot) {
  const manifestPath = join(runtimeRoot, PACKAGED_RUNTIME_MANIFEST)
  if (!existsSync(manifestPath)) {
    throw new Error(`Missing packaged runtime manifest: ${manifestPath}`)
  }
  return JSON.parse(readFileSync(manifestPath, 'utf8'))
}

function verifyRuntimeManifest(runtimeRoot) {
  const manifest = readRuntimeManifest(runtimeRoot)
  const skills = Array.isArray(manifest.embeddedSkillIds) ? manifest.embeddedSkillIds : []
  const tools = Array.isArray(manifest.tools) ? manifest.tools : []
  const modules = Array.isArray(manifest.pythonModules) ? manifest.pythonModules : []

  for (const skill of REQUIRED_RUNTIME_SKILLS) {
    if (!skills.includes(skill)) throw new Error(`Packaged runtime manifest does not cover embedded skill: ${skill}`)
  }
  for (const tool of REQUIRED_RUNTIME_TOOLS) {
    if (!tools.includes(tool)) throw new Error(`Packaged runtime manifest does not declare tool: ${tool}`)
  }
  for (const moduleName of REQUIRED_RUNTIME_MODULES) {
    if (!modules.includes(moduleName)) throw new Error(`Packaged runtime manifest does not declare Python module: ${moduleName}`)
  }
  return manifest
}

function runtimePythonPath(runtimeRoot) {
  return process.platform === 'win32'
    ? join(runtimeRoot, 'python', 'Scripts', 'python.exe')
    : join(runtimeRoot, 'python', 'bin', 'python3')
}

function runtimeToolCandidates(runtimeRoot, tool) {
  const suffixes = process.platform === 'win32' ? ['', '.exe', '.cmd'] : ['']
  return [
    ...suffixes.map((suffix) => join(runtimeRoot, 'bin', `${tool}${suffix}`)),
    ...suffixes.map((suffix) => join(runtimeRoot, 'python', process.platform === 'win32' ? 'Scripts' : 'bin', `${tool}${suffix}`)),
  ]
}

function verifyRuntimeTool(runtimeRoot, tool) {
  const candidates = runtimeToolCandidates(runtimeRoot, tool)
  const failures = []
  const versionArgs = tool === 'ffmpeg' || tool === 'ffprobe' ? ['-version'] : ['--version']
  for (const candidate of candidates) {
    if (!existsSync(candidate)) continue
    const result = spawnSync(candidate, versionArgs, {
      cwd: runtimeRoot,
      encoding: 'utf8',
      timeout: 30_000,
      env: buildRuntimeProbeEnv(runtimeRoot),
    })
    if (result.status === 0) return candidate
    failures.push(`${candidate}: ${result.error?.message || collectProbeOutput(result) || `exit ${result.status}`}`)
  }
  throw new Error(`Packaged runtime tool ${tool} is missing or not runnable:\n${failures.length > 0 ? failures.join('\n') : `checked ${candidates.join(', ')}`}`)
}

function parsePythonVersionText(value) {
  const match = String(value || '').match(/Python\s+(\d+)\.(\d+)(?:\.(\d+))?/i)
  if (!match) return null
  return {
    major: Number(match[1]),
    minor: Number(match[2]),
  }
}

function isSupportedReadyPythonVersion(version) {
  return Boolean(version)
    && version.major === 3
    && version.minor >= 9
    && version.minor <= 12
}

function parseOpenSslVersionText(value) {
  const match = String(value || '').match(/OpenSSL\s+(\d+)\.(\d+)\.(\d+)/i)
  if (!match) return null
  return {
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: Number(match[3]),
  }
}

function isSupportedReadyPythonSslVersion(value) {
  const version = parseOpenSslVersionText(value || '')
  if (!version) return false
  if (version.major > 1) return true
  if (version.major < 1) return false
  if (version.minor > 1) return true
  if (version.minor < 1) return false
  return version.patch >= 1
}

function runtimePythonBinDir(runtimeRoot) {
  return join(runtimeRoot, 'python', process.platform === 'win32' ? 'Scripts' : 'bin')
}

function buildRuntimeProbeEnv(runtimeRoot) {
  const env = { ...process.env }
  for (const key of [
    'PYTHONHOME',
    'PYTHONPATH',
    'PYTHONUSERBASE',
    'VIRTUAL_ENV',
    'CONDA_DEFAULT_ENV',
    'CONDA_PREFIX',
  ]) {
    delete env[key]
  }
  return {
    ...env,
    PATH: [join(runtimeRoot, 'bin'), runtimePythonBinDir(runtimeRoot), env.PATH || ''].join(delimiter),
    XDG_CACHE_HOME: join(runtimeRoot, 'cache'),
    MODELSCOPE_CACHE: join(runtimeRoot, 'cache', 'modelscope'),
    HF_HOME: join(runtimeRoot, 'cache', 'huggingface'),
    PIP_NO_INDEX: '1',
    PYTHONNOUSERSITE: '1',
    PYTHONDONTWRITEBYTECODE: '1',
    MODELSCOPE_OFFLINE: '1',
    HF_HUB_OFFLINE: '1',
    TRANSFORMERS_OFFLINE: '1',
  }
}

function collectProbeOutput(result) {
  return `${result.stdout || ''}${result.stderr || ''}`.trim()
}

function verifyPythonRuntimeGate(python, runtimeRoot) {
  const versionResult = spawnSync(python, ['--version'], {
    cwd: runtimeRoot,
    encoding: 'utf8',
    env: buildRuntimeProbeEnv(runtimeRoot),
  })
  if (versionResult.status !== 0) {
    throw new Error(`Packaged runtime Python version probe failed:\n${collectProbeOutput(versionResult)}`)
  }
  const versionText = collectProbeOutput(versionResult)
  if (!isSupportedReadyPythonVersion(parsePythonVersionText(versionText))) {
    throw new Error(`Packaged runtime Python has unsupported version: ${versionText || 'unknown'}`)
  }

  const sslResult = spawnSync(python, ['-c', 'import ssl; print(ssl.OPENSSL_VERSION)'], {
    cwd: runtimeRoot,
    encoding: 'utf8',
    env: buildRuntimeProbeEnv(runtimeRoot),
  })
  if (sslResult.status !== 0) {
    throw new Error(`Packaged runtime Python OpenSSL probe failed:\n${collectProbeOutput(sslResult)}`)
  }
  const sslText = collectProbeOutput(sslResult)
  if (!isSupportedReadyPythonSslVersion(sslText)) {
    throw new Error(`Packaged runtime Python has unsupported OpenSSL: ${sslText || 'unknown'}`)
  }
}

function verifyAsrModelCaches(runtimeRoot) {
  // funasr 可导入性已由 import 探针覆盖；这里只确认内置 VAD 权重在场。
  // 兜底 ASR/标点权重不再内置（按需下载），故不做 AutoModel 实际加载。
  for (const model of REQUIRED_RUNTIME_ASR_MODELS) {
    const baseDir = join(runtimeRoot, ...model.dir)
    for (const file of model.requiredFiles) {
      const filePath = join(baseDir, file)
      if (!existsSync(filePath)) {
        throw new Error(
          `Packaged runtime missing bundled model file (${model.name}): ${relative(runtimeRoot, filePath).split(sep).join('/')}`,
        )
      }
    }
  }
}

function verifyNoBundledModelWeights(runtimeRoot, specs) {
  const files = collectFiles(runtimeRoot)
  for (const spec of specs) {
    const forbidden = files.filter((file) => {
      const normalized = relative(runtimeRoot, file).split(sep).join('/').toLowerCase()
      return spec.fragments.some((fragment) => normalized.includes(fragment))
        && (normalized.endsWith('/model.pt') || normalized.endsWith('/model.safetensors'))
    })
    if (forbidden.length > 0) {
      throw new Error(
        `Model weights must not be bundled in the initial app package (${spec.label}). Remove: ${forbidden.slice(0, 5).map((file) => relative(runtimeRoot, file).split(sep).join('/')).join(', ')}`,
      )
    }
  }
}

function verifyNoEscapingSymlinks(runtimeRoot) {
  const rootReal = realpathSync(runtimeRoot)
  for (const file of collectFiles(runtimeRoot)) {
    const stat = lstatSync(file)
    if (!stat.isSymbolicLink()) continue
    const target = realpathSync(file)
    if (!target.startsWith(`${rootReal}${sep}`)) {
      throw new Error(`Packaged runtime contains external symlink: ${file} -> ${target}`)
    }
  }
}

function verifyRuntimeSource(runtimeRoot) {
  verifyRuntimeManifest(runtimeRoot)
  verifyNoEscapingSymlinks(runtimeRoot)
  verifyNoBundledModelWeights(runtimeRoot, ALWAYS_FORBIDDEN_BUNDLED_WEIGHTS)

  const python = runtimePythonPath(runtimeRoot)
  if (!existsSync(python)) throw new Error(`Packaged runtime missing Python: ${python}`)
  verifyPythonRuntimeGate(python, runtimeRoot)
  for (const tool of REQUIRED_RUNTIME_TOOLS) {
    verifyRuntimeTool(runtimeRoot, tool)
  }

  const importProbe = [
    'import importlib.util',
    `mods=${JSON.stringify(REQUIRED_RUNTIME_MODULES)}`,
    'missing=[m for m in mods if importlib.util.find_spec(m) is None]',
    'raise SystemExit("missing modules: "+",".join(missing) if missing else 0)',
  ].join(';')
  const result = spawnSync(python, ['-c', importProbe], {
    cwd: runtimeRoot,
    encoding: 'utf8',
    env: buildRuntimeProbeEnv(runtimeRoot),
  })
  if (result.status !== 0) {
    throw new Error(`Packaged runtime Python import probe failed:\n${result.stdout || ''}${result.stderr || ''}`)
  }
  verifyAsrModelCaches(runtimeRoot)
}

function verifyPackagedRuntime(runtimeRoot) {
  verifyRuntimeSource(runtimeRoot)
  const manifest = readRuntimeManifest(runtimeRoot)
  return {
    mode: 'packaged-runtime',
    runtimeRoot,
    runtimeId: manifest.runtimeId || null,
    skills: manifest.embeddedSkillIds,
    tools: manifest.tools,
  }
}

function verifyPackagedResources() {
  const resourcesDir = join(exportsDir, 'mac-arm64', 'Ready.app', 'Contents', 'Resources')
  if (!existsSync(resourcesDir)) {
    throw new Error(`Packaged resources not found: ${resourcesDir}`)
  }

  const seedRaw = readFileSync(join(resourcesDir, 'ai-settings.seed.json'), 'utf8')
  const seed = JSON.parse(seedRaw)
  if (hasSensitiveAIConfig(seed) && !allowBakedKey) {
    throw new Error('Packaged ai-settings.seed.json still contains API credentials')
  }

  const files = collectFiles(resourcesDir)
  const violations = files.filter((file) =>
    FORBIDDEN_RESOURCE_SEGMENTS.some((segment) => file.includes(segment))
  )

  if (violations.length > 0) {
    throw new Error(`Forbidden runtime artifacts found in bundle:\n${violations.join('\n')}`)
  }

  const runtime = allowNetworkRuntime
    ? { mode: 'network-runtime-allowed' }
    : verifyPackagedRuntime(join(resourcesDir, 'skill-runtime'))

  return {
    resourcesDir,
    checkedFiles: files.length,
    aiSeedPath: join(resourcesDir, 'ai-settings.seed.json'),
    runtime,
  }
}

function writeManifest(verification, runtime) {
  const artifacts = existsSync(exportsDir)
    ? readdirSync(exportsDir).sort()
    : []

  const manifest = {
    createdAt: new Date().toISOString(),
    projectRoot,
    outputDir: exportsDir,
    mode: dirOnly ? 'dir-only' : 'dist',
    artifacts,
    sanitized: {
      aiSeed: 'empty-object',
      strippedPythonCaches: Array.from(SKIP_DIR_NAMES),
      strippedPythonBytecode: SKIP_FILE_SUFFIXES,
      forbiddenRuntimeSegments: FORBIDDEN_RESOURCE_SEGMENTS,
      packagedSkillRuntime: runtime,
      allowNetworkRuntime,
    },
    verification,
  }

  writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8')
}

function getElectronBuilderBin() {
  return process.platform === 'win32'
    ? join(projectRoot, 'node_modules', '.bin', 'electron-builder.cmd')
    : join(projectRoot, 'node_modules', '.bin', 'electron-builder')
}

function getAppBuilderBin() {
  if (process.platform === 'darwin') {
    return join(projectRoot, 'node_modules', 'app-builder-bin', 'mac', process.arch === 'arm64' ? 'app-builder_arm64' : 'app-builder_amd64')
  }
  if (process.platform === 'win32') {
    return join(projectRoot, 'node_modules', 'app-builder-bin', 'win', process.arch === 'arm64' ? 'arm64' : process.arch === 'ia32' ? 'ia32' : 'x64', 'app-builder.exe')
  }
  return join(projectRoot, 'node_modules', 'app-builder-bin', 'linux', process.arch === 'arm64' ? 'arm64' : process.arch === 'ia32' ? 'ia32' : 'x64', 'app-builder')
}

function appBundlePath(root = exportsDir) {
  return join(root, 'mac-arm64', 'Ready.app')
}

function findDmgArtifact() {
  const dmgNames = existsSync(exportsDir)
    ? readdirSync(exportsDir).filter((name) => /^Ready-.*-arm64\.dmg$/u.test(name)).sort()
    : []
  if (dmgNames.length !== 1) {
    throw new Error(`Expected exactly one Ready arm64 DMG artifact, found ${dmgNames.length}: ${dmgNames.join(', ')}`)
  }
  return join(exportsDir, dmgNames[0])
}

function verifyElectronFramework(appPath) {
  const frameworkBinary = join(appPath, 'Contents', 'Frameworks', 'Electron Framework.framework', 'Versions', 'A', 'Electron Framework')
  if (!existsSync(frameworkBinary)) {
    throw new Error(`Packaged app is missing Electron Framework binary: ${frameworkBinary}`)
  }
  const stat = statSync(frameworkBinary)
  if (!stat.isFile() || stat.size < 100 * 1024 * 1024) {
    throw new Error(`Packaged Electron Framework binary looks invalid: ${frameworkBinary} (${stat.size} bytes)`)
  }
  return { frameworkBinary, frameworkBinarySize: stat.size }
}

function detachDmgVerifyMount() {
  spawnSync('hdiutil', ['detach', dmgVerifyMountPoint, '-quiet'], { stdio: 'ignore' })
}

function verifyDmgArtifact(dmgPath) {
  if (process.platform !== 'darwin') return null
  cleanDir(dmgVerifyMountPoint)
  ensureDir(dmgVerifyMountPoint)
  detachDmgVerifyMount()
  try {
    runCommand('hdiutil', ['attach', '-nobrowse', '-readonly', '-mountpoint', dmgVerifyMountPoint, dmgPath])
    const appPath = join(dmgVerifyMountPoint, 'Ready.app')
    if (!existsSync(appPath)) throw new Error(`Mounted DMG does not contain Ready.app: ${dmgPath}`)
    const framework = verifyElectronFramework(appPath)
    runCommand('codesign', ['--verify', '--deep', '--strict', '--verbose=1', appPath])
    return {
      dmgPath,
      mountedAppPath: appPath,
      ...framework,
    }
  } finally {
    detachDmgVerifyMount()
    cleanDir(dmgVerifyMountPoint)
  }
}

function rebuildDmgWithHdiutil() {
  if (process.platform !== 'darwin' || dirOnly) return null
  const appPath = appBundlePath()
  if (!existsSync(appPath)) throw new Error(`Packaged app not found: ${appPath}`)
  verifyElectronFramework(appPath)

  const dmgPath = findDmgArtifact()
  const blockmapPath = `${dmgPath}.blockmap`
  const macOutputDir = join(exportsDir, 'mac-arm64')
  const applicationsLink = join(macOutputDir, 'Applications')

  rmSync(dmgPath, { force: true })
  rmSync(blockmapPath, { force: true })
  rmSync(applicationsLink, { recursive: true, force: true })
  symlinkSync('/Applications', applicationsLink)
  try {
    runCommand('hdiutil', [
      'create',
      '-volname',
      basename(dmgPath, '.dmg'),
      '-srcfolder',
      macOutputDir,
      '-ov',
      '-format',
      'UDZO',
      '-fs',
      'HFS+',
      dmgPath,
    ])
  } finally {
    rmSync(applicationsLink, { recursive: true, force: true })
  }

  runCommand(getAppBuilderBin(), ['blockmap', '--input', dmgPath, '--output', blockmapPath])
  return verifyDmgArtifact(dmgPath)
}

function main() {
  logStep('prepare', 'clean staging')
  cleanDir(stagingRoot)
  ensureDir(stagingRoot)

  if (!skipCleanExports) {
    logStep('prepare', 'clean previous exports')
    removeOldExports()
  }

  logStep('sanitize', packerSeedConfigPath
    ? `write injected ai-settings seed${allowBakedKey ? ' (baked key allowed)' : ''}`
    : 'write empty ai-settings seed')
  createCleanSeed()

  logStep('sanitize', 'copy sidecar without caches')
  prepareSanitizedPython()

  logStep('sanitize', 'copy embedded skills without caches')
  prepareSanitizedEmbeddedSkills()

  logStep('sanitize', allowNetworkRuntime ? 'skip packaged skill runtime (developer mode)' : 'copy packaged skill runtime')
  const runtime = preparePackagedRuntime()

  logStep('sanitize', 'generate clean electron-builder config')
  buildCleanBuilderConfig()

  logStep('build', 'npm run build')
  runCommand('npm', ['run', 'build'])

  const electronBuilderBin = getElectronBuilderBin()
  const builderArgs = ['--config', tempBuilderConfigPath, '--publish', 'never']
  if (dirOnly) builderArgs.push('--dir')

  logStep('build', `electron-builder ${builderArgs.join(' ')}`)
  runCommand(electronBuilderBin, builderArgs)

  logStep('build', 'rebuild DMG with hdiutil and verify mounted app')
  const dmgVerification = rebuildDmgWithHdiutil()

  logStep('cleanup', 'remove builder debug helpers')
  removeGeneratedDebugFiles()

  logStep('verify', 'inspect packaged resources')
  const verification = verifyPackagedResources()
  if (dmgVerification) verification.dmg = dmgVerification
  writeManifest(verification, runtime)

  if (!keepStaging) {
    logStep('cleanup', 'remove staging')
    cleanDir(stagingRoot)
  }

  logStep('done', `artifacts updated in ${exportsDir}`)
  process.stdout.write(`[packer] manifest: ${manifestPath}\n`)
}

try {
  main()
} catch (error) {
  console.error('[packer] failed:', error instanceof Error ? error.message : String(error))
  process.exit(1)
}
