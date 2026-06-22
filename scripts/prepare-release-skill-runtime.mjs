#!/usr/bin/env node

import {
  chmodSync,
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { spawnSync } from 'node:child_process'
import { basename, delimiter, dirname, join, resolve, sep } from 'node:path'
import { homedir } from 'node:os'
import { fileURLToPath } from 'node:url'

const projectRoot = resolve(fileURLToPath(new URL('../', import.meta.url)))
const REQUIRED_SKILLS = [
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
const REQUIRED_TOOLS = ['ffmpeg', 'ffprobe', 'yt-dlp']
const REQUIRED_MODULES = [
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

function parseArgs(argv) {
  const out = {
    source: join(homedir(), 'Library', 'Application Support', 'ready', 'skill-runtime'),
    output: join(projectRoot, 'build', 'release-skill-runtime', 'skill-runtime'),
  }
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]
    if (arg === '--source') {
      out.source = argv[index + 1] || ''
      index += 1
    } else if (arg === '--output') {
      out.output = argv[index + 1] || ''
      index += 1
    }
  }
  out.source = resolve(out.source)
  out.output = resolve(out.output)
  return out
}

function fail(message) {
  console.error(`[release-runtime] ${message}`)
  process.exit(1)
}

function ensureDir(path) {
  mkdirSync(path, { recursive: true })
}

function copyTree(src, dst) {
  cpSync(src, dst, {
    recursive: true,
    dereference: true,
    force: true,
    verbatimSymlinks: false,
    filter(source) {
      const name = basename(source)
      if (name === '.DS_Store' || name === '__pycache__') return false
      if (name.endsWith('.pyc') || name.endsWith('.pyo')) return false
      return true
    },
  })
}

function readPyvenv(sourceRuntime) {
  const cfgPath = join(sourceRuntime, 'python', 'pyvenv.cfg')
  if (!existsSync(cfgPath)) fail(`missing source pyvenv.cfg: ${cfgPath}`)
  const entries = new Map()
  for (const line of readFileSync(cfgPath, 'utf8').split(/\r?\n/u)) {
    const match = line.match(/^([^=]+)=(.*)$/u)
    if (match) entries.set(match[1].trim(), match[2].trim())
  }
  return entries
}

function pythonVersion(sourceRuntime) {
  const version = readPyvenv(sourceRuntime).get('version') || ''
  const match = version.match(/^(\d+\.\d+)/u)
  return match ? match[1] : '3.11'
}

function sourcePythonDistributionRoot(sourceRuntime) {
  const cfg = readPyvenv(sourceRuntime)
  const executable = cfg.get('executable') || realpathSync(join(sourceRuntime, 'python', 'bin', 'python3'))
  const resolvedExecutable = realpathSync(executable)
  return dirname(dirname(resolvedExecutable))
}

function rewritePythonShebang(file) {
  const content = readFileSync(file)
  if (content[0] !== 0x23 || content[1] !== 0x21) return
  const newline = content.indexOf(0x0a)
  const firstLine = content.subarray(0, newline === -1 ? content.length : newline).toString('utf8')
  if (!/python/i.test(firstLine)) return
  const rest = newline === -1 ? Buffer.from('\n') : content.subarray(newline)
  const stat = statSync(file)
  writeFileSync(file, Buffer.concat([Buffer.from('#!/usr/bin/env python3', 'utf8'), rest]))
  chmodSync(file, stat.mode)
}

function copyLaunchers(sourceRuntime, outputRuntime) {
  const sourceBin = join(sourceRuntime, 'python', 'bin')
  const destBin = join(outputRuntime, 'python', 'bin')
  for (const name of readdirSync(sourceBin)) {
    if (/^python(?:3(?:\.\d+)?)?$/u.test(name)) continue
    if (/^activate(?:\.|$)|^Activate\.ps1$/u.test(name)) continue
    const src = join(sourceBin, name)
    const dst = join(destBin, name)
    const stat = lstatSync(src)
    if (!stat.isFile() && !stat.isSymbolicLink()) continue
    cpSync(src, dst, { dereference: true, force: true })
    chmodSync(dst, stat.mode)
    rewritePythonShebang(dst)
  }
}

function copyRuntimeTools(sourceRuntime, outputRuntime) {
  const outBin = join(outputRuntime, 'bin')
  ensureDir(outBin)
  for (const tool of ['ffmpeg', 'ffprobe']) {
    const source = join(sourceRuntime, 'bin', tool)
    if (!existsSync(source)) fail(`missing source tool: ${source}`)
    const dest = join(outBin, tool)
    cpSync(realpathSync(source), dest, { force: true })
    chmodSync(dest, 0o755)
  }
}

function copyLightModelCaches(sourceRuntime, outputRuntime) {
  const rel = join('cache', 'modelscope', 'models', 'iic', 'speech_fsmn_vad_zh-cn-16k-common-pytorch')
  const src = join(sourceRuntime, rel)
  if (!existsSync(src)) return false
  copyTree(src, join(outputRuntime, rel))
  return true
}

function assertNoExternalSymlinks(root) {
  const rootReal = realpathSync(root)
  const visit = (current) => {
    const stat = lstatSync(current)
    if (stat.isSymbolicLink()) {
      const target = realpathSync(current)
      if (!target.startsWith(`${rootReal}${sep}`)) {
        fail(`external symlink in release runtime: ${current} -> ${target}`)
      }
      return
    }
    if (!stat.isDirectory()) return
    for (const child of readdirSync(current)) visit(join(current, child))
  }
  visit(root)
}

function runtimeEnv(root) {
  return {
    ...process.env,
    PATH: [join(root, 'bin'), join(root, 'python', 'bin'), process.env.PATH || ''].join(delimiter),
    XDG_CACHE_HOME: join(root, 'cache'),
    MODELSCOPE_CACHE: join(root, 'cache', 'modelscope'),
    HF_HOME: join(root, 'cache', 'huggingface'),
    PYTHONNOUSERSITE: '1',
    PYTHONDONTWRITEBYTECODE: '1',
    PIP_NO_INDEX: '1',
    MODELSCOPE_OFFLINE: '1',
    HF_HUB_OFFLINE: '1',
    TRANSFORMERS_OFFLINE: '1',
  }
}

function runProbe(file, args, root) {
  const result = spawnSync(file, args, {
    cwd: root,
    encoding: 'utf8',
    env: runtimeEnv(root),
    timeout: 60_000,
  })
  if (result.status !== 0) {
    fail(`probe failed: ${file} ${args.join(' ')}\n${result.stdout || ''}${result.stderr || ''}`)
  }
  return `${result.stdout || ''}${result.stderr || ''}`.trim()
}

function writeManifest(root) {
  const python = join(root, 'python', 'bin', 'python3')
  const pythonVersionText = runProbe(python, ['--version'], root)
  const sslVersionText = runProbe(python, ['-c', 'import ssl; print(ssl.OPENSSL_VERSION)'], root)
  const manifest = {
    runtimeId: `ready-release-runtime-${new Date().toISOString().replace(/[:.]/gu, '-')}`,
    createdAt: new Date().toISOString(),
    pythonVersion: pythonVersionText,
    pythonSslVersion: sslVersionText,
    embeddedSkillIds: REQUIRED_SKILLS,
    tools: REQUIRED_TOOLS,
    pythonModules: REQUIRED_MODULES,
  }
  writeFileSync(join(root, 'runtime-manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`, 'utf8')
}

function verifyRuntime(root) {
  const python = join(root, 'python', 'bin', 'python3')
  runProbe(python, ['-c', [
    'import importlib.util, json',
    `mods=${JSON.stringify(REQUIRED_MODULES)}`,
    'missing=[m for m in mods if importlib.util.find_spec(m) is None]',
    'raise SystemExit("missing modules: "+",".join(missing) if missing else 0)',
  ].join(';')], root)
  for (const tool of REQUIRED_TOOLS) {
    const toolPath = tool === 'yt-dlp' ? join(root, 'python', 'bin', 'yt-dlp') : join(root, 'bin', tool)
    runProbe(toolPath, tool === 'yt-dlp' ? ['--version'] : ['-version'], root)
  }
}

function main() {
  const options = parseArgs(process.argv.slice(2))
  if (!existsSync(options.source)) fail(`source runtime does not exist: ${options.source}`)
  const version = pythonVersion(options.source)
  const sourceDist = sourcePythonDistributionRoot(options.source)
  const sourceSitePackages = join(options.source, 'python', 'lib', `python${version}`, 'site-packages')
  if (!existsSync(sourceDist)) fail(`source Python distribution does not exist: ${sourceDist}`)
  if (!existsSync(sourceSitePackages)) fail(`source site-packages missing: ${sourceSitePackages}`)

  rmSync(options.output, { recursive: true, force: true })
  ensureDir(options.output)
  copyTree(sourceDist, join(options.output, 'python'))
  copyTree(sourceSitePackages, join(options.output, 'python', 'lib', `python${version}`, 'site-packages'))
  copyLaunchers(options.source, options.output)
  copyRuntimeTools(options.source, options.output)
  const hasVad = copyLightModelCaches(options.source, options.output)
  writeManifest(options.output)
  assertNoExternalSymlinks(options.output)
  verifyRuntime(options.output)
  console.log(JSON.stringify({
    ok: true,
    output: options.output,
    source: options.source,
    copiedPythonDistribution: sourceDist,
    hasBundledVadModel: hasVad,
  }, null, 2))
}

main()
