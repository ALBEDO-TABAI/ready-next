#!/usr/bin/env node
import { spawn, spawnSync } from 'node:child_process'
import { randomUUID, createHash } from 'node:crypto'
import {
  chmodSync,
  copyFileSync,
  createReadStream,
  existsSync,
  lstatSync,
  mkdtempSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  renameSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { createServer } from 'node:http'
import { homedir, tmpdir } from 'node:os'
import { basename, delimiter, dirname, extname, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { isDeepStrictEqual } from 'node:util'
import { createRequire } from 'node:module'
import YAML from 'yaml'

export const packerRoot = dirname(fileURLToPath(import.meta.url))
export const repoRoot = resolve(packerRoot, '..')

const publicRoot = join(packerRoot, 'public')
const stagingRoot = join(packerRoot, '.staging')
const outputRoot = join(packerRoot, 'output')
const cleanPackerScript = join(packerRoot, 'pack-clean-release.mjs')
const readyPackSeedPath = join(repoRoot, 'build', 'runtime-seeds', 'ai-settings.seed.json')
const nodeModulesPath = join(repoRoot, 'node_modules')
const stagedSymlinkPath = join(stagingRoot, 'node_modules.symlink')

export function derivePackagingContract(builderConfig, packageJson) {
  const productName = String(builderConfig?.productName || packageJson?.productName || packageJson?.name || '').trim()
  const version = String(packageJson?.version || '').trim()
  const output = String(builderConfig?.directories?.output || 'dist').trim()
  const targets = Array.isArray(builderConfig?.mac?.target) ? builderConfig.mac.target : [builderConfig?.mac?.target]
  const dmgTarget = targets.find((target) => target === 'dmg' || target?.target === 'dmg')
  const arches = Array.isArray(dmgTarget?.arch) ? dmgTarget.arch.map(String) : []
  const arch = arches.length === 1 ? arches[0] : ''

  if (!productName || !version) throw new Error('主项目缺少 productName 或 version，无法确定打包产物')
  if (!dmgTarget || !arch) throw new Error('主项目必须配置唯一的 macOS DMG 架构，打包器才能确定产物')

  const artifactTemplate = String(builderConfig?.mac?.artifactName || '${productName}-${version}-${arch}.${ext}')
  const artifactName = artifactTemplate.replace(/\$\{(productName|version|arch|ext)\}/g, (_match, key) => ({
    productName,
    version,
    arch,
    ext: 'dmg',
  })[key])

  return {
    productName,
    version,
    arch,
    output,
    artifactName,
    appOutputDir: arch === 'arm64' ? 'mac-arm64' : 'mac',
  }
}

export function assertPackagingInputs(builderConfig, packageJson) {
  if (!packageJson?.scripts?.['build:dist']) {
    throw new Error('主项目缺少 build:dist 命令，打包器无法复用正式构建链')
  }
  const resources = Array.isArray(builderConfig?.extraResources) ? builderConfig.extraResources : []
  const resourceSources = new Set(resources.map((entry) => String(entry?.from || '')))
  for (const required of ['build/runtime-seeds/ai-settings.seed.json', 'assets/embedded-skills', 'src/python']) {
    if (!resourceSources.has(required)) {
      throw new Error(`主项目打包清单缺少 ${required}，打包器不能保证专属配置或技能资源完整`)
    }
  }
}

export function readPackagingContract() {
  const builderConfig = YAML.parse(readFileSync(join(repoRoot, 'electron-builder.yml'), 'utf8'))
  const packageJson = JSON.parse(readFileSync(join(repoRoot, 'package.json'), 'utf8'))
  assertPackagingInputs(builderConfig, packageJson)
  return derivePackagingContract(builderConfig, packageJson)
}

const packagingContract = readPackagingContract()
const exportsDir = resolve(repoRoot, packagingContract.output)

const jobs = new Map()

const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
}

export const DEFAULT_NOVACODE_BASE_URL = 'https://cn-novacode.i0yu.cn/v1'
export const DEFAULT_NOVACODE_MODEL = 'gpt-5.6-terra'
export const DEFAULT_NOVACODE_DISPLAY_NAME = 'NovaCode'

function readAppVersion() {
  return readPackagingContract().version
}

// The normal Ready package stays slim and lets Settings provision skill-runtime
// after install. This detector is only for the explicit full-package path.
export function isValidRuntimeRoot(dir) {
  return Boolean(dir) && existsSync(join(dir, 'runtime-manifest.json'))
}

export function detectRuntimeRoot() {
  const fromEnv = String(process.env.READY_RELEASE_SKILL_RUNTIME_ROOT || '').trim()
  if (fromEnv) return fromEnv
  const candidates = [join(homedir(), 'ready-release-runtime-src')]
  for (const candidate of candidates) {
    if (isValidRuntimeRoot(candidate)) return candidate
  }
  return ''
}

export function normalizeBaseUrl(value) {
  const raw = String(value || '').trim()
  if (!raw) throw new Error('请填写 Base URL')
  let parsed
  try {
    parsed = new URL(raw)
  } catch {
    throw new Error('Base URL 格式不正确')
  }
  const privateHttpHost = (() => {
    const host = parsed.hostname.replace(/^\[|\]$/g, '').toLowerCase()
    if (host === 'localhost' || host === '::1') return true
    const match = host.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/)
    if (!match) return /^(?:fc|fd)[0-9a-f]{2}:/i.test(host)
    const octets = match.slice(1).map(Number)
    if (octets.some((part) => part > 255)) return false
    return octets[0] === 127
      || octets[0] === 10
      || (octets[0] === 172 && octets[1] >= 16 && octets[1] <= 31)
      || (octets[0] === 192 && octets[1] === 168)
  })()
  if (parsed.protocol !== 'https:' && !(parsed.protocol === 'http:' && privateHttpHost)) {
    throw new Error('Base URL 必须是 HTTPS；只有本机或私有网段允许 HTTP')
  }
  if (parsed.username || parsed.password) {
    throw new Error('Base URL 不能包含用户名或密码，请只填写接口地址')
  }
  if (parsed.search || parsed.hash) {
    throw new Error('Base URL 不能包含查询参数或锚点，请只填写接口地址')
  }
  if (parsed.pathname === '/') parsed.pathname = '/v1'
  return parsed.toString().replace(/\/+$/, '')
}

export function normalizePackageSuffix(value) {
  const raw = String(value || '').trim()
  if (!raw) return ''
  const withoutExtension = raw.replace(/\.dmg$/i, '').trim()
  const safe = withoutExtension
    .normalize('NFKC')
    .replace(/[/\\:]+/g, '-')
    .replace(/[^\p{L}\p{N}._-]+/gu, '-')
    .replace(/^-+|-+$/g, '')
  if (!safe || safe === '.' || safe === '..') throw new Error('打包名后缀不能只包含特殊字符')
  return safe
}

// A personalized package bakes in exactly one custom AI preset (NovaCode is an
// OpenAI-compatible relay). Base URL + model are prefilled; the API key is
// optional. When every AI field is blank we bake an empty seed (clean build).
export function validatePackageRequest(payload) {
  const rawBaseUrl = String(payload?.baseUrl || '').trim()
  const apiKey = String(payload?.apiKey || '').trim()
  const model = String(payload?.model || '').trim()
  const displayName = String(payload?.displayName || '').trim() || DEFAULT_NOVACODE_DISPLAY_NAME
  const packageSuffix = normalizePackageSuffix(payload?.packageSuffix)
  const allowSlim = payload?.allowSlim !== false
  const requestedRuntimeRoot = String(payload?.runtimeRoot || '').trim()
  const runtimeRoot = allowSlim ? '' : requestedRuntimeRoot

  const wantsAI = Boolean(rawBaseUrl || apiKey || model)
  let baseUrl = ''
  if (wantsAI) {
    baseUrl = normalizeBaseUrl(rawBaseUrl)
    if (!model) throw new Error('请填写模型名称（例如 gpt-5.6-terra）')
  }

  if (!runtimeRoot && !allowSlim) {
    throw new Error('未提供技能运行时目录：请填写 skill-runtime 路径，或显式勾选“生成精简包（不含技能运行时）”')
  }
  if (runtimeRoot && !isValidRuntimeRoot(runtimeRoot)) {
    throw new Error(`技能运行时目录无效（缺少 runtime-manifest.json）：${runtimeRoot}`)
  }

  return { wantsAI, baseUrl, apiKey, model, displayName, packageSuffix, runtimeRoot, allowSlim }
}

export function buildAIConfig(request) {
  const parsedBaseUrl = new URL(request.baseUrl)
  const verifiedNovaCode = parsedBaseUrl.hostname === 'cn-novacode.i0yu.cn'
    && request.model === DEFAULT_NOVACODE_MODEL
  return {
    provider: 'openai-compatible',
    baseUrl: request.baseUrl,
    apiKey: request.apiKey,
    model: request.model,
    agentProtocol: 'openai',
    wireApi: 'chat/completions',
    toolUseMode: verifiedNovaCode ? 'on' : 'off',
    visionMode: 'off',
    nativeVideoMode: 'off',
    capabilityModes: {},
    modelIds: [request.model],
    displayName: request.displayName,
  }
}

// The seed only needs `ai_model_config` + `ai_saved_configs`; the app migrates
// those into an active custom workspace profile on first launch (see
// migrateLegacyAISettingsToWorkspace / applyBundledAISettingsSeed).
export function buildSeed(request) {
  if (!request.wantsAI) return {}
  const config = buildAIConfig(request)
  return {
    ai_model_config: config,
    ai_saved_configs: { 'openai-compatible': config },
  }
}

export function safeOutputName(contract, packageSuffix) {
  if (packageSuffix) return `${contract.productName}-${packageSuffix}.dmg`
  return contract.artifactName
}

function redactText(value, redactions = []) {
  let text = String(value || '')
  for (const secret of redactions) {
    if (!secret || String(secret).length < 3) continue
    text = text.split(String(secret)).join('••••••')
  }
  return text
}

function sendJson(res, status, body) {
  const text = JSON.stringify(body)
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(text),
  })
  res.end(text)
}

function readJsonBody(req) {
  return new Promise((resolveBody, reject) => {
    let body = ''
    req.setEncoding('utf8')
    req.on('data', (chunk) => {
      body += chunk
      if (body.length > 1024 * 1024) {
        reject(new Error('请求内容过大'))
        req.destroy()
      }
    })
    req.on('end', () => {
      try {
        resolveBody(body ? JSON.parse(body) : {})
      } catch {
        reject(new Error('请求 JSON 格式不正确'))
      }
    })
    req.on('error', reject)
  })
}

function publicJob(job) {
  return {
    id: job.id,
    status: job.status,
    createdAt: job.createdAt,
    updatedAt: job.updatedAt,
    outputPath: job.outputPath || '',
    error: job.error || '',
    logs: job.logs.slice(-400),
  }
}

function writeEvent(res, event, data) {
  res.write(`event: ${event}\n`)
  res.write(`data: ${JSON.stringify(data)}\n\n`)
}

function emitJob(job, message) {
  const item = { time: new Date().toISOString(), message: redactText(message, job.redactions) }
  job.logs.push(item)
  job.updatedAt = item.time
  for (const res of job.listeners) writeEvent(res, 'log', item)
}

function finishJob(job, status, payload = {}) {
  job.status = status
  job.updatedAt = new Date().toISOString()
  if (payload.outputPath) job.outputPath = payload.outputPath
  if (payload.error) job.error = redactText(payload.error, job.redactions)
  const snapshot = publicJob(job)
  for (const res of job.listeners) {
    writeEvent(res, 'status', snapshot)
    res.end()
  }
  job.listeners.clear()
}

function ensureDir(path) {
  mkdirSync(path, { recursive: true })
}

export function ensurePrivateDir(path) {
  ensureDir(path)
  chmodSync(path, 0o700)
}

function lexists(path) {
  try {
    lstatSync(path)
    return true
  } catch {
    return false
  }
}

// Node's rmSync(recursive) can throw ENOTEMPTY on large macOS trees (a
// node_modules clone is 100k+ entries); the system rm -rf is reliable.
function removeTree(path) {
  const r = spawnSync('rm', ['-rf', path], { encoding: 'utf8' })
  if (r.status !== 0 && existsSync(path)) {
    throw new Error(`rm -rf failed for ${path}: ${String(r.stderr || r.error?.message || `exit ${r.status}`).slice(0, 200)}`)
  }
}

function nodeModulesIsSymlink() {
  try {
    return lstatSync(nodeModulesPath).isSymbolicLink()
  } catch {
    return false
  }
}

// Root cause of the too-small (and broken) package: when `node_modules` is a
// symlink (this repo shares ready-cowork's install to save disk), electron-builder's
// dependency collector resolves the full tree BUT its file walker won't descend the
// symlinked root, so only ~93 of ~1188 production packages land in app.asar —
// dropping transitive runtime deps like bindings/ws/undici. Materialize node_modules
// as a real APFS clone (`cp -Rc` = clonefile: ~15s, copy-on-write, near-zero disk)
// for the build, then restore the symlink. Returns a restore() for the finally block.
function materializeNodeModulesForBuild(job) {
  if (!nodeModulesIsSymlink()) return () => {}
  const target = readlinkSync(nodeModulesPath)
  ensureDir(stagingRoot)
  emitJob(job, 'node_modules 是符号链接：临时物化为真实目录（APFS clone）以确保依赖完整打包')
  // Move the symlink itself aside (tiny) so a crash mid-build can self-heal on restart.
  rmSync(stagedSymlinkPath, { force: true })
  renameSync(nodeModulesPath, stagedSymlinkPath)
  const cloned = spawnSync('cp', ['-Rc', target, nodeModulesPath], { encoding: 'utf8' })
  if (cloned.status !== 0) {
    removeTree(nodeModulesPath)
    renameSync(stagedSymlinkPath, nodeModulesPath)
    throw new Error(`物化 node_modules 失败：${String(cloned.stderr || cloned.error?.message || 'cp -Rc').slice(0, 200)}`)
  }
  let restored = false
  // Never throws: a restore failure logs and defers to the startup self-heal,
  // so it can't crash the server from runPackerJob's finally block.
  return () => {
    if (restored) return
    restored = true
    try {
      if (nodeModulesIsSymlink()) {
        rmSync(stagedSymlinkPath, { force: true })
        return
      }
      removeTree(nodeModulesPath)
      if (lexists(stagedSymlinkPath)) renameSync(stagedSymlinkPath, nodeModulesPath)
      else symlinkSync(target, nodeModulesPath)
      emitJob(job, 'node_modules 符号链接已还原')
    } catch (err) {
      emitJob(job, `⚠️ 还原 node_modules 符号链接失败（下次启动会自愈）：${err && err.message ? err.message : String(err)}`)
    }
  }
}

// Self-heal: if a prior build was killed after moving the symlink aside, the real
// clone is sitting at node_modules and the original symlink is parked in staging.
// Restore the symlink so the developer's shared-install setup is intact.
function restoreOrphanedNodeModulesSymlink() {
  if (!lexists(stagedSymlinkPath)) return
  if (nodeModulesIsSymlink()) {
    rmSync(stagedSymlinkPath, { force: true })
    return
  }
  removeTree(nodeModulesPath)
  renameSync(stagedSymlinkPath, nodeModulesPath)
  console.log('[packer] restored orphaned node_modules symlink from a prior interrupted build')
}

export function replaceFileSecure(sourcePath, destinationPath) {
  ensureDir(dirname(destinationPath))
  const temporaryPath = `${destinationPath}.packer-${randomUUID()}.tmp`
  try {
    copyFileSync(sourcePath, temporaryPath)
    chmodSync(temporaryPath, 0o600)
    renameSync(temporaryPath, destinationPath)
  } finally {
    rmSync(temporaryPath, { force: true })
  }
}

export function recoverInterruptedReadyPackSeed(
  recoveryStagingRoot = stagingRoot,
  targetSeedPath = readyPackSeedPath,
) {
  ensureDir(recoveryStagingRoot)
  const entries = readdirSync(recoveryStagingRoot, { withFileTypes: true })
  const backups = entries
    .filter((entry) => entry.isFile() && /^ready-pack-seed-backup-.+\.json$/.test(entry.name))
    .map((entry) => {
      const path = join(recoveryStagingRoot, entry.name)
      return { path, name: entry.name, mtimeMs: statSync(path).mtimeMs }
    })
    .sort((left, right) => left.mtimeMs - right.mtimeMs || left.name.localeCompare(right.name))
  const transientSeeds = entries
    .filter((entry) => entry.isFile() && /^packer-seed-.+\.json$/.test(entry.name))
    .map((entry) => join(recoveryStagingRoot, entry.name))

  // Repeated interrupted runs can leave a chain of backups. The oldest one is
  // the last known developer seed before any temporary package seed replaced it.
  if (backups.length > 0) replaceFileSecure(backups[0].path, targetSeedPath)

  for (const backup of backups) rmSync(backup.path, { force: true })
  for (const seedPath of transientSeeds) rmSync(seedPath, { force: true })

  return {
    restored: backups.length > 0,
    removedBackups: backups.length,
    removedTransientSeeds: transientSeeds.length,
  }
}

function runCommand(command, args, env, onLine) {
  return new Promise((resolveRun, reject) => {
    const child = spawn(command, args, {
      cwd: repoRoot,
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let tail = ''
    function handleChunk(chunk) {
      const text = tail + chunk.toString('utf8')
      const lines = text.split(/\r?\n/)
      tail = lines.pop() || ''
      for (const line of lines) {
        if (line.trim()) onLine(line)
      }
    }
    child.stdout.on('data', handleChunk)
    child.stderr.on('data', handleChunk)
    child.on('error', reject)
    child.on('close', (code) => {
      if (tail.trim()) onLine(tail)
      if (code === 0) resolveRun()
      else reject(new Error(`${command} ${args.join(' ')} 退出码 ${code}`))
    })
  })
}

async function withTemporaryReadyPackSeed(seedFile, runBuild) {
  ensureDir(dirname(readyPackSeedPath))
  const backupPath = join(stagingRoot, `ready-pack-seed-backup-${randomUUID()}.json`)
  const hadSeed = existsSync(readyPackSeedPath)
  if (hadSeed) replaceFileSecure(readyPackSeedPath, backupPath)
  replaceFileSecure(seedFile, readyPackSeedPath)
  try {
    await runBuild()
  } finally {
    if (hadSeed) {
      replaceFileSecure(backupPath, readyPackSeedPath)
      rmSync(backupPath, { force: true })
    } else {
      rmSync(readyPackSeedPath, { force: true })
    }
  }
}

function sha256File(path) {
  return createHash('sha256').update(readFileSync(path)).digest('hex')
}

// Forward the build owner's receipt; copying a package is not another build.
const releasePackageIdentity = createRequire(import.meta.url)(
  join(repoRoot, 'scripts', 'release-package-identity.cjs'),
)

export function cleanReadyPackOutputs(contract, targetDir = exportsDir) {
  const artifactStem = contract.artifactName.replace(/\.dmg$/i, '')
  const paths = [
    contract.appOutputDir,
    `${artifactStem}.dmg`,
    `${artifactStem}.dmg.receipt.json`,
    `${artifactStem}.dmg.blockmap`,
    `${artifactStem}.zip`,
    `${artifactStem}.zip.blockmap`,
    'latest-mac.yml',
    'builder-effective-config.yaml',
    'builder-debug.yml',
    'clean-package-manifest.json',
  ]
  for (const path of paths) {
    rmSync(join(targetDir, path), { recursive: true, force: true })
  }
}

function assertNoPackagedRuntime(contract) {
  const runtimePath = join(exportsDir, contract.appOutputDir, `${contract.productName}.app`, 'Contents', 'Resources', 'skill-runtime')
  if (existsSync(runtimePath)) {
    throw new Error(`精简包不应内置技能运行时，但发现了：${runtimePath}`)
  }
}

export function assertPackagedApp(appPath, contract, expectedSeed, expectRuntime) {
  if (!existsSync(appPath)) throw new Error(`安装包缺少 ${contract.productName}.app：${appPath}`)

  const frameworkPath = join(
    appPath,
    'Contents',
    'Frameworks',
    'Electron Framework.framework',
    'Versions',
    'A',
    'Electron Framework',
  )
  if (!existsSync(frameworkPath) || !statSync(frameworkPath).isFile()) {
    throw new Error(`安装包缺少 Electron Framework：${frameworkPath}`)
  }

  const resourcesPath = join(appPath, 'Contents', 'Resources')
  const packagedSeedPath = join(resourcesPath, 'ai-settings.seed.json')
  if (!existsSync(packagedSeedPath)) throw new Error(`安装包缺少 AI seed：${packagedSeedPath}`)
  let packagedSeed
  try {
    packagedSeed = JSON.parse(readFileSync(packagedSeedPath, 'utf8'))
  } catch {
    throw new Error(`安装包内 AI seed 不是有效 JSON：${packagedSeedPath}`)
  }
  if (!isDeepStrictEqual(packagedSeed, expectedSeed)) {
    throw new Error('安装包内 AI 配置与本次打包请求不一致')
  }

  const runtimePath = join(resourcesPath, 'skill-runtime')
  if (expectRuntime && !existsSync(runtimePath)) throw new Error(`完整包缺少技能运行时：${runtimePath}`)
  if (!expectRuntime && existsSync(runtimePath)) throw new Error(`精简包不应内置技能运行时：${runtimePath}`)

  return { frameworkPath, packagedSeedPath, runtimePath }
}

async function verifyFinalDmg(job, dmgPath, contract, request, env) {
  const expectedSeed = buildSeed(request)
  const expectRuntime = Boolean(request.runtimeRoot)
  const mountPoint = mkdtempSync(join(tmpdir(), 'ready-packer-dmg-'))
  let mounted = false

  try {
    emitJob(job, '校验 DMG 完整性与只读挂载内容')
    await runCommand('hdiutil', ['verify', dmgPath], env, (line) => emitJob(job, line))
    await runCommand('hdiutil', [
      'attach',
      '-readonly',
      '-nobrowse',
      '-mountpoint',
      mountPoint,
      dmgPath,
    ], env, (line) => emitJob(job, line))
    mounted = true

    const mountedAppPath = join(mountPoint, `${contract.productName}.app`)
    assertPackagedApp(mountedAppPath, contract, expectedSeed, expectRuntime)
    const applicationsLink = join(mountPoint, 'Applications')
    if (!lexists(applicationsLink) || !lstatSync(applicationsLink).isSymbolicLink() || readlinkSync(applicationsLink) !== '/Applications') {
      throw new Error('DMG 缺少指向 /Applications 的安装链接')
    }
    await runCommand('codesign', ['--verify', '--deep', '--strict', mountedAppPath], env, (line) => emitJob(job, line))
  } finally {
    if (mounted) spawnSync('hdiutil', ['detach', mountPoint, '-quiet'], { stdio: 'ignore' })
    rmSync(mountPoint, { recursive: true, force: true })
  }
}

// Slim packages intentionally follow the ready-pack skill path:
// write the seed, run `npm run build:dist`, then restore the local seed file.
// Full packages keep using clean-release because that path stages and verifies
// the explicit skill-runtime bundle.
async function runPackerJob(job, request) {
  ensurePrivateDir(stagingRoot)
  ensurePrivateDir(outputRoot)
  ensurePrivateDir(exportsDir)
  const contract = readPackagingContract()
  const producedDmg = join(resolve(repoRoot, contract.output), contract.artifactName)
  const seedFile = join(stagingRoot, `packer-seed-${job.id}.json`)
  let restoreNodeModules = () => {}
  let finalStatus = 'failed'
  let finalPayload = { error: '打包任务未完成' }

  try {
    writeFileSync(seedFile, `${JSON.stringify(buildSeed(request), null, 2)}\n`, { mode: 0o600 })

    emitJob(job, '开始生成专属 macOS DMG（默认精简包，不内置技能运行时）')
    if (request.wantsAI) {
      emitJob(job, `已内置 AI 配置：${request.displayName}（openai-compatible）`)
      emitJob(job, `接口地址：${request.baseUrl} · 模型：${request.model}`)
      emitJob(job, request.apiKey ? '已内置 API Key（日志中已脱敏）' : '未内置 API Key，首次启动需在设置中填写')
    } else {
      emitJob(job, '未配置 AI，本次生成的是空 seed 干净包')
    }
    if (request.packageSuffix) emitJob(job, `打包名后缀：${request.packageSuffix}`)

    // Must run before any electron-builder invocation (both slim and full paths).
    restoreNodeModules = materializeNodeModulesForBuild(job)

    const env = {
      ...process.env,
      DISABLE_AUTO_UPDATE: 'true',
      READY_ALLOW_BAKED_AI_SEED: '1',
      PATH: [join(repoRoot, 'node_modules', '.bin'), process.env.PATH || ''].join(delimiter),
    }
    cleanReadyPackOutputs(contract)
    if (request.runtimeRoot) {
      const args = [cleanPackerScript]
      env.READY_PACKER_SEED_CONFIG = seedFile
      env.READY_PACKER_ALLOW_BAKED_KEY = '1'
      env.READY_RELEASE_SKILL_RUNTIME_ROOT = request.runtimeRoot
      emitJob(job, `内置技能运行时：${request.runtimeRoot}`)
      await runCommand(process.execPath, args, env, (line) => emitJob(job, line))
    } else {
      emitJob(job, '精简包：使用 ready-pack 同一路径 npm run build:dist，不内置技能运行时')
      await withTemporaryReadyPackSeed(seedFile, async () => {
        await runCommand('npm', ['run', 'build:dist'], env, (line) => emitJob(job, line))
      })
      assertNoPackagedRuntime(contract)
    }

    if (!existsSync(producedDmg)) {
      const dmgs = existsSync(exportsDir)
        ? readdirSync(exportsDir).filter((name) => name.toLowerCase().endsWith('.dmg'))
        : []
      throw new Error(`没有找到生成的 DMG：${producedDmg}（exports 内 DMG：${dmgs.join(', ') || '无'}）`)
    }

    const appPath = join(exportsDir, contract.appOutputDir, `${contract.productName}.app`)
    assertPackagedApp(appPath, contract, buildSeed(request), Boolean(request.runtimeRoot))
    await runCommand('codesign', ['--verify', '--deep', '--strict', appPath], env, (line) => emitJob(job, line))

    const outputPath = join(outputRoot, safeOutputName(contract, request.packageSuffix))
    const pendingOutputPath = join(outputRoot, `.${safeOutputName(contract, request.packageSuffix)}.${job.id}.tmp.dmg`)
    releasePackageIdentity.readVerifiedReleasePackageReceipt(producedDmg)
    rmSync(pendingOutputPath, { force: true })
    copyFileSync(producedDmg, pendingOutputPath)
    chmodSync(pendingOutputPath, 0o600)
    try {
      await verifyFinalDmg(job, pendingOutputPath, contract, request, env)
      renameSync(pendingOutputPath, outputPath)
      chmodSync(outputPath, 0o600)
    } finally {
      rmSync(pendingOutputPath, { force: true })
    }
    const receiptPath = releasePackageIdentity.forwardReleasePackageReceipt(producedDmg, outputPath)
    const sizeMB = (statSync(outputPath).size / (1024 * 1024)).toFixed(1)
    emitJob(job, `专属 DMG 已输出：${outputPath}（${sizeMB} MB）`)
    emitJob(job, `发布回执已输出：${receiptPath}`)
    finalStatus = 'done'
    finalPayload = { outputPath, receiptPath }
  } catch (error) {
    finalPayload = { error: error && error.message ? error.message : String(error) }
  } finally {
    restoreNodeModules()
    rmSync(seedFile, { force: true })
    try {
      cleanReadyPackOutputs(contract)
    } catch (error) {
      finalStatus = 'failed'
      finalPayload = {
        error: `打包中间产物清理失败：${error && error.message ? error.message : String(error)}`,
      }
    }
    finishJob(job, finalStatus, finalPayload)
  }
}

function hasRunningJob() {
  for (const job of jobs.values()) {
    if (job.status === 'running') return true
  }
  return false
}

function createJob(request) {
  const now = new Date().toISOString()
  const job = {
    id: randomUUID(),
    status: 'running',
    createdAt: now,
    updatedAt: now,
    logs: [],
    listeners: new Set(),
    redactions: [request.apiKey].filter(Boolean),
  }
  jobs.set(job.id, job)
  runPackerJob(job, request)
  return job
}

function serveStatic(req, res, pathname) {
  const requested = pathname === '/' ? '/index.html' : pathname
  const target = resolve(publicRoot, `.${requested}`)
  const relativeTarget = relative(publicRoot, target)
  if (relativeTarget.startsWith('..') || relativeTarget.startsWith('/') || relativeTarget === '') {
    res.writeHead(403)
    res.end('Forbidden')
    return
  }
  if (!existsSync(target) || !statSync(target).isFile()) {
    res.writeHead(404)
    res.end('Not found')
    return
  }
  res.writeHead(200, { 'content-type': MIME_TYPES[extname(target)] || 'application/octet-stream' })
  createReadStream(target).pipe(res)
}

async function handleRequest(req, res) {
  const url = new URL(req.url || '/', 'http://127.0.0.1')

  if (req.method === 'GET' && url.pathname === '/api/defaults') {
    const runtimeRoot = detectRuntimeRoot()
    sendJson(res, 200, {
      baseUrl: DEFAULT_NOVACODE_BASE_URL,
      model: DEFAULT_NOVACODE_MODEL,
      displayName: DEFAULT_NOVACODE_DISPLAY_NAME,
      version: readAppVersion(),
      productName: packagingContract.productName,
      arch: packagingContract.arch,
      artifactName: packagingContract.artifactName,
      runtimeRoot,
      runtimeReady: isValidRuntimeRoot(runtimeRoot),
    })
    return
  }

  if (req.method === 'POST' && url.pathname === '/api/package') {
    try {
      // The clean packer writes to shared exports/ and staging, so builds must
      // run one at a time.
      if (hasRunningJob()) {
        sendJson(res, 409, { error: '已有打包任务在进行中，请等待完成后再试' })
        return
      }
      const payload = await readJsonBody(req)
      const request = validatePackageRequest(payload)
      const job = createJob(request)
      sendJson(res, 202, publicJob(job))
    } catch (error) {
      sendJson(res, 400, { error: error && error.message ? error.message : String(error) })
    }
    return
  }

  const jobMatch = url.pathname.match(/^\/api\/jobs\/([^/]+)(?:\/events)?$/)
  if (jobMatch) {
    const job = jobs.get(jobMatch[1])
    if (!job) {
      sendJson(res, 404, { error: '任务不存在' })
      return
    }
    if (url.pathname.endsWith('/events')) {
      res.writeHead(200, {
        'content-type': 'text/event-stream; charset=utf-8',
        'cache-control': 'no-cache',
        connection: 'keep-alive',
      })
      for (const log of job.logs) writeEvent(res, 'log', log)
      writeEvent(res, 'status', publicJob(job))
      if (job.status === 'running') {
        job.listeners.add(res)
        req.on('close', () => job.listeners.delete(res))
      } else {
        res.end()
      }
      return
    }
    sendJson(res, 200, publicJob(job))
    return
  }

  if (req.method !== 'GET' && req.method !== 'HEAD') {
    res.writeHead(405)
    res.end('Method not allowed')
    return
  }
  serveStatic(req, res, decodeURIComponent(url.pathname))
}

export async function startServer(port = Number(process.env.PORT || 4291)) {
  ensurePrivateDir(outputRoot)
  ensurePrivateDir(stagingRoot)
  ensurePrivateDir(exportsDir)
  const recoveredSeed = recoverInterruptedReadyPackSeed()
  if (recoveredSeed.restored || recoveredSeed.removedTransientSeeds > 0) {
    console.log('[packer] restored the developer AI seed and removed interrupted package seed files')
  }
  restoreOrphanedNodeModulesSymlink()
  const server = createServer((req, res) => {
    handleRequest(req, res).catch((error) => {
      sendJson(res, 500, { error: error && error.message ? error.message : String(error) })
    })
  })

  for (let candidate = port; candidate < port + 100; candidate += 1) {
    try {
      await new Promise((resolveListen, reject) => {
        server.once('error', reject)
        server.listen(candidate, '127.0.0.1', resolveListen)
      })
      console.log(`Ready Packer running at http://127.0.0.1:${candidate}/`)
      return { server, port: candidate }
    } catch (error) {
      server.removeAllListeners('error')
      if (error && error.code === 'EADDRINUSE') continue
      throw error
    }
  }
  throw new Error(`No free port found starting at ${port}`)
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  startServer().catch((error) => {
    console.error(error && error.stack ? error.stack : error)
    process.exit(1)
  })
}
