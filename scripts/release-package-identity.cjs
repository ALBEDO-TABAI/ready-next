'use strict'

const { createHash } = require('node:crypto')
const fs = require('node:fs')
const path = require('node:path')
const { sourcePaths } = require('./browser-live-proof-manifest.cjs')

const RECEIPT_DIR_REL = 'exports/release-structural-receipts'
const RUNTIME_MANIFEST_REL = 'assets/codex-runtime/runtime-manifest.json'
const RELEASE_EVIDENCE_PREFIX = 'exports/release-evidence/'
const RELEASE_SOURCE_EXCLUDED_PREFIXES = Object.freeze([])

function sha256(value) {
  return createHash('sha256').update(value).digest('hex')
}

function sha256File(filePath) {
  return sha256(fs.readFileSync(filePath))
}

function safeRelativePath(root, relativePath, { prefix } = {}) {
  const text = String(relativePath || '').replaceAll('\\', '/')
  if (!text || path.posix.isAbsolute(text) || path.posix.normalize(text) !== text || text.startsWith('../')) {
    throw new Error(`unsafe relative path: ${relativePath}`)
  }
  if (prefix && !text.startsWith(prefix)) {
    throw new Error(`path must be inside ${prefix}: ${relativePath}`)
  }
  const absoluteRoot = path.resolve(root)
  const absolutePath = path.resolve(absoluteRoot, text)
  if (absolutePath !== absoluteRoot && !absolutePath.startsWith(`${absoluteRoot}${path.sep}`)) {
    throw new Error(`path escapes release root: ${relativePath}`)
  }
  return { relativePath: text, absolutePath }
}

function assertPathChain(root, targetPath, { allowLeafSymlink = false } = {}) {
  const requestedRoot = path.resolve(root)
  const absoluteRoot = fs.realpathSync(requestedRoot)
  const requestedTarget = path.resolve(targetPath)
  const absoluteTarget = requestedTarget === requestedRoot || requestedTarget.startsWith(`${requestedRoot}${path.sep}`)
    ? path.join(absoluteRoot, path.relative(requestedRoot, requestedTarget))
    : requestedTarget
  if (absoluteTarget !== absoluteRoot && !absoluteTarget.startsWith(`${absoluteRoot}${path.sep}`)) {
    throw new Error(`path escapes trusted root: ${targetPath}`)
  }
  const rootStat = fs.lstatSync(absoluteRoot)
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) {
    throw new Error(`trusted root must be a physical directory: ${absoluteRoot}`)
  }
  const relative = path.relative(absoluteRoot, absoluteTarget)
  let cursor = absoluteRoot
  for (const [index, segment] of relative.split(path.sep).filter(Boolean).entries()) {
    cursor = path.join(cursor, segment)
    const stat = fs.lstatSync(cursor)
    const isLeaf = index === relative.split(path.sep).filter(Boolean).length - 1
    if (stat.isSymbolicLink() && !(allowLeafSymlink && isLeaf)) {
      throw new Error(`symlink is not allowed in trusted path: ${cursor}`)
    }
  }
  return absoluteTarget
}

function ensureTrustedDirectory(root, directoryPath) {
  const absoluteRoot = path.resolve(root)
  const absoluteDirectory = path.resolve(directoryPath)
  if (absoluteDirectory !== absoluteRoot && !absoluteDirectory.startsWith(`${absoluteRoot}${path.sep}`)) {
    throw new Error(`directory escapes trusted root: ${directoryPath}`)
  }
  const rootStat = fs.lstatSync(absoluteRoot)
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) {
    throw new Error(`trusted root must be a physical directory: ${absoluteRoot}`)
  }
  let cursor = absoluteRoot
  for (const segment of path.relative(absoluteRoot, absoluteDirectory).split(path.sep).filter(Boolean)) {
    cursor = path.join(cursor, segment)
    try {
      const stat = fs.lstatSync(cursor)
      if (!stat.isDirectory() || stat.isSymbolicLink()) {
        throw new Error(`trusted output directory is not physical: ${cursor}`)
      }
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error
      fs.mkdirSync(cursor, { mode: 0o755 })
      const created = fs.lstatSync(cursor)
      if (!created.isDirectory() || created.isSymbolicLink()) {
        throw new Error(`trusted output directory was replaced: ${cursor}`)
      }
    }
  }
  return absoluteDirectory
}

function packagingContract(root = path.resolve(__dirname, '..'), {
  parseYaml = (text) => require('yaml').parse(text),
} = {}) {
  const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'))
  const builder = parseYaml(fs.readFileSync(path.join(root, 'electron-builder.yml'), 'utf8'))
  const assertBuilderInput = (value, label) => {
    const input = String(value || '').replace(/^!/, '')
    if (!input || path.posix.isAbsolute(input) || path.win32.isAbsolute(input)
      || input.replaceAll('\\', '/').split('/').includes('..')) {
      throw new Error(`${label} must stay inside the release source root`)
    }
  }
  for (const entry of Array.isArray(builder?.files) ? builder.files : []) {
    assertBuilderInput(typeof entry === 'string' ? entry : entry?.from, 'electron-builder files input')
  }
  for (const entry of Array.isArray(builder?.extraResources) ? builder.extraResources : []) {
    assertBuilderInput(entry?.from, 'electron-builder extraResources input')
  }
  const dmgTargets = (Array.isArray(builder?.mac?.target) ? builder.mac.target : [])
    .filter((entry) => entry?.target === 'dmg')
  if (dmgTargets.length !== 1) {
    throw new Error('release packaging contract must contain exactly one DMG target')
  }
  const [dmgTarget] = dmgTargets
  const arch = dmgTarget?.arch?.[0]
  if (arch !== 'arm64' || dmgTarget.arch.length !== 1) {
    throw new Error('release packaging contract must contain exactly one arm64 DMG architecture')
  }
  const values = {
    productName: String(builder.productName || ''),
    version: String(pkg.version || ''),
    arch,
    ext: 'dmg',
  }
  if (!values.productName || !values.version) throw new Error('release packaging identity is incomplete')
  const artifactName = String(builder?.mac?.artifactName || '').replace(
    /\$\{(productName|version|arch|ext)\}/g,
    (_match, key) => values[key],
  )
  if (!artifactName || artifactName.includes('${')) throw new Error('release artifact name is unresolved')
  const outputDir = String(builder?.directories?.output || '')
  const artifactRel = path.posix.join(outputDir, artifactName)
  safeRelativePath(root, artifactRel)
  return {
    appVersion: values.version,
    productName: values.productName,
    arch,
    outputDir,
    artifactName,
    artifactRel,
  }
}

function buildReleaseSourceManifest(root = path.resolve(__dirname, '..')) {
  const absoluteRoot = path.resolve(root)
  const files = sourcePaths(absoluteRoot, { includeDatabases: true })
    .filter((relativePath) => !RELEASE_SOURCE_EXCLUDED_PREFIXES.some((prefix) => relativePath.startsWith(prefix)))
    .map((relativePath) => {
      const { absolutePath } = safeRelativePath(absoluteRoot, relativePath)
      assertPathChain(absoluteRoot, absolutePath)
      const identity = readStableRegularFile(absolutePath, absoluteRoot)
      return {
        path: relativePath,
        type: 'file',
        mode: identity.mode,
        bytes: identity.bytes,
        sha256: identity.sha256,
      }
    })
  const digest = sha256(files.map((file) => `${JSON.stringify(file)}\n`).join(''))
  const pkg = JSON.parse(fs.readFileSync(path.join(absoluteRoot, 'package.json'), 'utf8'))
  const browserManifest = require('./browser-live-proof-manifest.cjs').buildSourceManifest(absoluteRoot)
  return {
    version: 2,
    head: browserManifest.head,
    branch: browserManifest.branch,
    appVersion: String(pkg.version || ''),
    digest,
    files,
  }
}

function readStableRegularFile(filePath, trustedRoot = path.dirname(filePath), { includeContent = false } = {}) {
  const stablePath = assertPathChain(trustedRoot, filePath)
  const pathBefore = fs.lstatSync(stablePath)
  const flags = fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0)
  const descriptor = fs.openSync(stablePath, flags)
  try {
    const before = fs.fstatSync(descriptor)
    assertPathChain(trustedRoot, stablePath)
    const pathAfterOpen = fs.lstatSync(stablePath)
    if (!before.isFile() || pathBefore.dev !== before.dev || pathBefore.ino !== before.ino
      || pathAfterOpen.dev !== before.dev || pathAfterOpen.ino !== before.ino) {
      throw new Error(`release artifact path changed before it was read: ${filePath}`)
    }
    const identity = captureOpenDescriptor(descriptor, { includeContent })
    const after = fs.fstatSync(descriptor)
    assertPathChain(trustedRoot, stablePath)
    const pathAfterRead = fs.lstatSync(stablePath)
    if (before.dev !== after.dev || before.ino !== after.ino || before.size !== after.size
      || before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs
      || before.mode !== after.mode || before.nlink !== after.nlink
      || pathAfterRead.dev !== after.dev || pathAfterRead.ino !== after.ino) {
      throw new Error(`release artifact changed while it was being read: ${filePath}`)
    }
    return identity
  } finally {
    fs.closeSync(descriptor)
  }
}

function captureOpenDescriptor(descriptor, { includeContent = false } = {}) {
  const before = fs.fstatSync(descriptor)
  if (!before.isFile()) throw new Error('release descriptor must reference a regular file')
  const hash = createHash('sha256')
  const chunks = []
  const buffer = Buffer.allocUnsafe(1024 * 1024)
  let bytes = 0
  while (bytes < before.size) {
    const count = fs.readSync(descriptor, buffer, 0, Math.min(buffer.length, before.size - bytes), bytes)
    if (count === 0) break
    const chunk = buffer.subarray(0, count)
    hash.update(chunk)
    if (includeContent) chunks.push(Buffer.from(chunk))
    bytes += count
  }
  const after = fs.fstatSync(descriptor)
  if (before.dev !== after.dev || before.ino !== after.ino || before.size !== after.size
    || before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs
    || before.mode !== after.mode || before.nlink !== after.nlink || bytes !== before.size) {
    throw new Error('release descriptor changed while it was being read')
  }
  return {
    bytes,
    sha256: hash.digest('hex'),
    mode: (after.mode & 0o777).toString(8).padStart(3, '0'),
    ...(includeContent ? { content: Buffer.concat(chunks) } : {}),
  }
}

function captureRegularFile(filePath, trustedRoot = path.dirname(filePath)) {
  return readStableRegularFile(filePath, trustedRoot)
}

function sameFileIdentity(left, right) {
  return left?.bytes === right?.bytes && left?.sha256 === right?.sha256
}

function receiptIdentity(receipt) {
  return {
    receiptId: receipt?.receiptId,
    appVersion: receipt?.appVersion,
    sourceTreeDigest: receipt?.source?.digest,
    runtimeManifestSha256: receipt?.runtimeManifestSha256,
    packageSha256: receipt?.artifact?.sha256,
  }
}

function receiptRelForArtifactSha(sha256) {
  if (!/^[0-9a-f]{64}$/.test(String(sha256 || ''))) throw new Error('artifact sha256 is invalid')
  return `${RECEIPT_DIR_REL}/${sha256}.json`
}

function validateReceiptShape(receipt, contract, errors) {
  if (receipt?.schemaVersion !== 2) errors.push(`${RECEIPT_DIR_REL}: schemaVersion must be 2`)
  if (!/^[0-9a-f-]{36}$/i.test(String(receipt?.receiptId || ''))) {
    errors.push(`${RECEIPT_DIR_REL}: receiptId is missing or invalid`)
  }
  if (receipt?.status !== 'STRUCTURAL_PACKAGE_PASS') {
    errors.push(`${RECEIPT_DIR_REL}: status must be STRUCTURAL_PACKAGE_PASS`)
  }
  if (receipt?.distributionEligible !== false || receipt?.signingIdentity !== 'ad-hoc-local') {
    errors.push(`${RECEIPT_DIR_REL}: local structural package must remain distributionEligible=false and ad-hoc signed`)
  }
  if (receipt?.liveAcceptance !== 'DEFERRED') {
    errors.push(`${RECEIPT_DIR_REL}: liveAcceptance must remain DEFERRED until current-package manual evidence exists`)
  }
  if (!Number.isFinite(Date.parse(String(receipt?.createdAt || '')))) {
    errors.push(`${RECEIPT_DIR_REL}: createdAt is missing or invalid`)
  }
  if (receipt?.appVersion !== contract.appVersion) {
    errors.push(`${RECEIPT_DIR_REL}: app version does not match the packaging contract`)
  }
  if (receipt?.artifact?.path !== contract.artifactRel) {
    errors.push(`${RECEIPT_DIR_REL}: artifact path is not the current packaging-contract DMG`)
  }
  if (receipt?.artifact?.architecture !== contract.arch || receipt?.artifact?.packageShape !== 'slim') {
    errors.push(`${RECEIPT_DIR_REL}: artifact architecture or package shape is invalid`)
  }
  const requiredVerification = {
    signature: 'verified',
    signingIdentity: 'ad-hoc-local',
    dmg: 'verified',
    mount: 'read-only',
    applicationsLink: '/Applications',
    aiSeed: 'empty-object',
    packageShape: 'slim',
    architecture: contract.arch,
    appVersion: contract.appVersion,
    bundleVersion: contract.appVersion,
  }
  for (const [key, value] of Object.entries(requiredVerification)) {
    if (receipt?.verification?.[key] !== value) {
      errors.push(`${RECEIPT_DIR_REL}: verification.${key} must equal ${value}`)
    }
  }
  for (const key of [
    'appExecutableSha256',
    'appExecutableBytes',
    'appAsarSha256',
    'appAsarBytes',
    'applicationInventoryDigest',
    'applicationInventoryFileCount',
    'browserSourceManifestDigest',
    'browserSourceManifestVersion',
    'outputManifestDigest',
    'outputManifestFileCount',
    'packageJsonSha256',
    'asarRequiredEntrypoints',
    'resourceInventories',
    'sensitivePayloadScan',
    'sensitiveContentScan',
    'runtimeDependencyRootCount',
    'runtimeDependencyRootDigest',
    'electronVersion',
    'electronArchitecture',
    'electronFrameworkSha256',
    'electronFrameworkBytes',
    'betterSqliteVersion',
    'betterSqliteSha256',
    'betterSqliteBytes',
    'betterSqliteNativeSmoke',
    'codexBinarySha256',
    'codexBinaryBytes',
    'codexVersion',
    'codexArchitecture',
    'runtimeManifestSha256',
  ]) {
    if (receipt?.verification?.[key] === undefined || receipt?.verification?.[key] === '') {
      errors.push(`${RECEIPT_DIR_REL}: verification.${key} is required`)
    }
  }
  if (!/^v\d+\.\d+\.\d+$/.test(String(receipt?.toolchain?.node || ''))
    || !/^\d+\.\d+\.\d+$/.test(String(receipt?.toolchain?.npm || ''))) {
    errors.push(`${RECEIPT_DIR_REL}: exact Node/npm toolchain identity is required`)
  }
}

function loadVerifiedStructuralReceipt(
  root = path.resolve(__dirname, '..'),
  { sourceManifest = buildReleaseSourceManifest, contractFactory = packagingContract } = {},
) {
  const errors = []
  let contract
  let artifactPath = null
  let artifactIdentity = null
  try {
    contract = contractFactory(root)
    artifactPath = safeRelativePath(root, contract.artifactRel).absolutePath
    artifactIdentity = captureRegularFile(artifactPath, root)
  } catch (error) {
    return { ok: false, errors: [`${RECEIPT_DIR_REL}: packaged DMG is missing or invalid: ${error.message}`], receipt: null }
  }
  const receiptRel = receiptRelForArtifactSha(artifactIdentity.sha256)
  const receiptPath = path.join(root, receiptRel)
  let receipt = null
  try {
    receipt = JSON.parse(readStableRegularFile(receiptPath, root, { includeContent: true }).content.toString('utf8'))
  } catch {
    return { ok: false, errors: [`${receiptRel}: missing or invalid structural package receipt`], receipt: null }
  }

  try {
    validateReceiptShape(receipt, contract, errors)
  } catch (error) {
    errors.push(`${receiptRel}: unable to verify packaging contract: ${error.message}`)
  }

  let currentSource = null
  try {
    currentSource = sourceManifest(root)
    if (receipt?.source?.digest !== currentSource.digest) {
      errors.push(`${receiptRel}: source tree digest does not match the current checkout`)
    }
    if (receipt?.source?.head !== currentSource.head) {
      errors.push(`${receiptRel}: source HEAD does not match the current checkout`)
    }
    if (receipt?.source?.branch !== currentSource.branch) {
      errors.push(`${receiptRel}: source branch does not match the current checkout`)
    }
    if (receipt?.source?.fileCount !== currentSource.files?.length) {
      errors.push(`${receiptRel}: source file count does not match the current checkout`)
    }
    if (receipt?.source?.manifestVersion !== currentSource.version) {
      errors.push(`${receiptRel}: source manifest version does not match the current checkout`)
    }
    if (receipt?.appVersion !== currentSource.appVersion) {
      errors.push(`${receiptRel}: app version does not match package.json`)
    }
  } catch (error) {
    errors.push(`${receiptRel}: unable to verify current source identity: ${error.message}`)
  }

  const runtimeManifestPath = path.join(root, RUNTIME_MANIFEST_REL)
  try {
    if (receipt?.runtimeManifestSha256 !== captureRegularFile(runtimeManifestPath, root).sha256) {
      errors.push(`${receiptRel}: runtime manifest digest does not match the current checkout`)
    }
  } catch {
    errors.push(`${RUNTIME_MANIFEST_REL}: missing or invalid runtime manifest`)
  }

  if (receipt?.artifact?.bytes !== artifactIdentity.bytes) {
    errors.push(`${receiptRel}: packaged DMG size does not match receipt`)
  }
  if (receipt?.artifact?.sha256 !== artifactIdentity.sha256) {
    errors.push(`${receiptRel}: packaged DMG digest does not match receipt`)
  }

  return {
    ok: errors.length === 0,
    errors,
    receipt,
    currentSource,
    contract,
    artifactPath,
    receiptPath,
    receiptRel,
  }
}

module.exports = {
  RECEIPT_DIR_REL,
  RELEASE_EVIDENCE_PREFIX,
  RUNTIME_MANIFEST_REL,
  assertPathChain,
  buildReleaseSourceManifest,
  captureOpenDescriptor,
  captureRegularFile,
  ensureTrustedDirectory,
  loadVerifiedStructuralReceipt,
  packagingContract,
  receiptIdentity,
  receiptRelForArtifactSha,
  readStableRegularFile,
  safeRelativePath,
  sameFileIdentity,
  sha256File,
}
