import { createHash, randomUUID, type Hash } from 'node:crypto'
import {
  closeSync,
  constants,
  existsSync,
  fchmodSync,
  fstatSync,
  fsyncSync,
  lstatSync,
  linkSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  readSync,
  realpathSync,
  renameSync,
  rmSync,
  unlinkSync,
  writeSync,
} from 'node:fs'
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'

const MAX_SEGMENTS = 256
const MAX_LOGICAL_BYTES = 50 * 1024 * 1024
const MAX_ARTIFACTS_PER_RUN = 8
const DEFAULT_STORAGE_BUDGET_BYTES = MAX_LOGICAL_BYTES * MAX_ARTIFACTS_PER_RUN * 2
const EXPORT_OPERATION_RECEIPT_RESERVE_BYTES = 16 * 1024

type SegmentRef = Readonly<{ sha256: string; bytes: number }>

type ArtifactManifest = Readonly<{
  contract: 'ready_artifact_manifest_v1'
  logicalArtifactRef: string
  readyRunId: string
  itemId: string
  segments: readonly SegmentRef[]
  logicalBytes: number
}>

export type ArtifactVersionReceipt = Readonly<{
  logicalArtifactRef: string
  actionId: string
  expectedVersion: string | null
  mode: 'replace' | 'append'
  version: string
  segmentBytes: number
  segmentSha256: string
  logicalBytes: number
  manifestDigest: string
  logicalSha256: string
}>

export type ArtifactDirectoryIdentity = Readonly<{
  logicalResourceId: string
  path: string
  device: string
  inode: string
  mode: number
  policyEpoch: number
}>

export type ArtifactExportReceipt = Readonly<{
  logicalArtifactRef: string
  version: string
  destinationResourceId: string
  targetRelativePath: string
  bytes: number
  sha256: string
  targetDevice: string
  targetInode: string
  result: 'created' | 'replaced' | 'same_hash_idempotent'
  readbackVerified: true
}>

export type ArtifactStorageRetention = Readonly<{
  protectedRunIds: readonly string[]
  collectibleRunIds: readonly string[]
}>

export type ArtifactMaterializerOptions = Readonly<{
  maxStorageBytes?: number
  readStorageRetention?: () => ArtifactStorageRetention
}>

export class ArtifactMaterializerError extends Error {
  constructor(readonly code: string) {
    super(code)
    this.name = 'ArtifactMaterializerError'
  }
}

function sha256(value: string | Buffer): string {
  return createHash('sha256').update(value).digest('hex')
}

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`
  if (value && typeof value === 'object') {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, child]) => `${JSON.stringify(key)}:${canonical(child)}`)
      .join(',')}}`
  }
  return JSON.stringify(value)
}

function token(value: string): string {
  if (!value.trim()) throw new ArtifactMaterializerError('artifact_identity_invalid')
  return sha256(value)
}

function writeImmutable(path: string, bytes: Buffer): boolean {
  const parent = dirname(path)
  mkdirSync(parent, { recursive: true })
  const tempPath = join(parent, `.${basename(path)}.${process.pid}.${randomUUID()}.tmp`)
  let fd: number | null = null
  try {
    fd = openSync(tempPath, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY, 0o600)
    let offset = 0
    while (offset < bytes.length) offset += writeSync(fd, bytes, offset)
    fsyncSync(fd)
    closeSync(fd)
    fd = null
    try {
      linkSync(tempPath, path)
      const directoryFd = openSync(parent, 'r')
      try { fsyncSync(directoryFd) } finally { closeSync(directoryFd) }
      return true
    } catch (error) {
      if (!error || typeof error !== 'object' || !('code' in error) || error.code !== 'EEXIST') throw error
      ensureRegularFile(path, 'artifact_immutable_conflict')
      const existing = readFileSync(path)
      if (!existing.equals(bytes)) throw new ArtifactMaterializerError('artifact_immutable_conflict')
      return false
    }
  } finally {
    if (fd !== null) closeSync(fd)
    if (existsSync(tempPath)) unlinkSync(tempPath)
  }
}

function readJson<T>(path: string, code: string): T {
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as T
  } catch {
    throw new ArtifactMaterializerError(code)
  }
}

function normalizeVersion(value: string | null | undefined): string | null {
  if (value === null || value === undefined || value === '' || value === 'empty') return null
  if (!/^sha256:[a-f0-9]{64}$/.test(value)) {
    throw new ArtifactMaterializerError('artifact_expected_version_invalid')
  }
  return value
}

function normalizeRelativeTarget(value: string): string {
  const normalized = value.replace(/\\/g, '/').trim()
  if (!normalized || isAbsolute(normalized) || normalized.startsWith('~/')) {
    throw new ArtifactMaterializerError('artifact_target_relative_path_invalid')
  }
  const parts = normalized.split('/').filter(Boolean)
  if (parts.length === 0 || parts.some((part) => part === '.' || part === '..' || part.includes('\0'))) {
    throw new ArtifactMaterializerError('artifact_target_relative_path_invalid')
  }
  return parts.join('/')
}

function hashStableRegularFile(path: string): {
  sha256: string
  bytes: number
  device: string
  inode: string
} {
  const pathBefore = lstatSync(path)
  if (pathBefore.isSymbolicLink() || !pathBefore.isFile()) {
    throw new ArtifactMaterializerError('artifact_target_conflict')
  }
  const fd = openSync(path, constants.O_RDONLY | (constants.O_NOFOLLOW || 0))
  const hash = createHash('sha256')
  const buffer = Buffer.allocUnsafe(64 * 1024)
  let bytes = 0
  try {
    const before = fstatSync(fd)
    if (!before.isFile() || before.dev !== pathBefore.dev || before.ino !== pathBefore.ino) {
      throw new ArtifactMaterializerError('artifact_target_readback_mismatch')
    }
    while (true) {
      const count = readSync(fd, buffer, 0, buffer.length, null)
      if (count === 0) break
      hash.update(buffer.subarray(0, count))
      bytes += count
    }
    const after = fstatSync(fd)
    const pathAfter = lstatSync(path)
    if (before.dev !== after.dev || before.ino !== after.ino
      || before.size !== after.size || before.mtimeMs !== after.mtimeMs
      || before.ctimeMs !== after.ctimeMs || before.mode !== after.mode
      || pathAfter.isSymbolicLink() || !pathAfter.isFile()
      || pathAfter.dev !== after.dev || pathAfter.ino !== after.ino) {
      throw new ArtifactMaterializerError('artifact_target_readback_mismatch')
    }
    return {
      sha256: hash.digest('hex'),
      bytes,
      device: String(after.dev),
      inode: String(after.ino),
    }
  } finally {
    closeSync(fd)
  }
}

function ensureRegularFile(path: string, code: string): void {
  const metadata = lstatSync(path)
  if (metadata.isSymbolicLink() || !metadata.isFile()) throw new ArtifactMaterializerError(code)
}

export class ArtifactMaterializer {
  private readonly queues = new Map<string, Promise<unknown>>()
  private readonly headHashes = new Map<string, { version: string; hash: Hash }>()
  private readonly maxStorageBytes: number
  private storageBytes: number

  constructor(
    private readonly baseDir: string,
    private readonly options: ArtifactMaterializerOptions = {},
  ) {
    if (!isAbsolute(baseDir)) throw new ArtifactMaterializerError('artifact_base_dir_invalid')
    this.maxStorageBytes = options.maxStorageBytes ?? DEFAULT_STORAGE_BUDGET_BYTES
    if (!Number.isSafeInteger(this.maxStorageBytes) || this.maxStorageBytes <= 0) {
      throw new ArtifactMaterializerError('artifact_storage_budget_invalid')
    }
    mkdirSync(baseDir, { recursive: true })
    this.storageBytes = this.directoryBytes(baseDir)
  }

  async write(input: Readonly<{
    readyRunId: string
    itemId: string
    actionId: string
    expectedVersion?: string | null
    mode: 'replace' | 'append'
    content: Buffer | string
  }>): Promise<ArtifactVersionReceipt> {
    return this.serial(`${input.readyRunId}\0${input.itemId}`, () => this.writeNow(input))
  }

  readVersion(input: Readonly<{
    readyRunId: string
    itemId: string
    version: string
  }>): Buffer {
    const manifest = this.readManifest(input.readyRunId, input.itemId, input.version)
    const chunks = manifest.segments.map((segment) => {
      const path = this.segmentPath(input.readyRunId, input.itemId, segment.sha256)
      ensureRegularFile(path, 'artifact_segment_missing')
      const bytes = readFileSync(path)
      if (bytes.length !== segment.bytes || sha256(bytes) !== segment.sha256) {
        throw new ArtifactMaterializerError('artifact_segment_readback_mismatch')
      }
      return bytes
    })
    const content = Buffer.concat(chunks)
    if (content.length !== manifest.logicalBytes) {
      throw new ArtifactMaterializerError('artifact_manifest_readback_mismatch')
    }
    return content
  }

  readVersionPrefix(input: Readonly<{
    readyRunId: string
    itemId: string
    version: string
    maxBytes: number
  }>): { content: Buffer; logicalBytes: number } {
    if (!Number.isSafeInteger(input.maxBytes) || input.maxBytes <= 0) {
      throw new ArtifactMaterializerError('artifact_read_limit_invalid')
    }
    const manifest = this.readManifest(input.readyRunId, input.itemId, input.version)
    const chunks: Buffer[] = []
    let remaining = input.maxBytes
    for (const segment of manifest.segments) {
      if (remaining === 0) break
      const path = this.segmentPath(input.readyRunId, input.itemId, segment.sha256)
      ensureRegularFile(path, 'artifact_segment_missing')
      const fd = openSync(path, constants.O_RDONLY | (constants.O_NOFOLLOW || 0))
      try {
        const metadata = fstatSync(fd)
        if (!metadata.isFile() || metadata.size !== segment.bytes) {
          throw new ArtifactMaterializerError('artifact_segment_readback_mismatch')
        }
        const length = Math.min(remaining, segment.bytes)
        const chunk = Buffer.allocUnsafe(length)
        let offset = 0
        while (offset < length) {
          const count = readSync(fd, chunk, offset, length - offset, offset)
          if (count === 0) throw new ArtifactMaterializerError('artifact_segment_readback_mismatch')
          offset += count
        }
        chunks.push(chunk)
        remaining -= length
      } finally {
        closeSync(fd)
      }
    }
    return { content: Buffer.concat(chunks), logicalBytes: manifest.logicalBytes }
  }

  streamVersion(input: Readonly<{
    readyRunId: string
    itemId: string
    version: string
  }>, consume: (chunk: Buffer) => void): { bytes: number; sha256: string } {
    const manifest = this.readManifest(input.readyRunId, input.itemId, input.version)
    const hash = createHash('sha256')
    let total = 0
    for (const segment of manifest.segments) {
      const path = this.segmentPath(input.readyRunId, input.itemId, segment.sha256)
      ensureRegularFile(path, 'artifact_segment_missing')
      const bytes = readFileSync(path)
      if (bytes.length !== segment.bytes || sha256(bytes) !== segment.sha256) {
        throw new ArtifactMaterializerError('artifact_segment_readback_mismatch')
      }
      consume(bytes)
      hash.update(bytes)
      total += bytes.length
    }
    if (total !== manifest.logicalBytes) {
      throw new ArtifactMaterializerError('artifact_manifest_readback_mismatch')
    }
    return { bytes: total, sha256: hash.digest('hex') }
  }

  async exportVersion(input: Readonly<{
    actionReadyRunId: string
    sourceReadyRunId: string
    itemId: string
    actionId: string
    version: string
    expectedSha256: string
    destination: ArtifactDirectoryIdentity
    targetRelativePath: string
    /** The user confirmed replacing a different file already at the target. */
    replaceExisting?: boolean
  }>): Promise<ArtifactExportReceipt> {
    return this.serial(`${input.actionReadyRunId}\0${input.itemId}`, () => this.exportNow(input))
  }

  async copyOnWrite(input: Readonly<{
    sourceReadyRunId: string
    sourceItemId: string
    sourceVersion: string
    targetReadyRunId: string
    targetItemId: string
    actionId: string
  }>): Promise<ArtifactVersionReceipt> {
    const bytes = this.readVersion({
      readyRunId: input.sourceReadyRunId,
      itemId: input.sourceItemId,
      version: input.sourceVersion,
    })
    return this.write({
      readyRunId: input.targetReadyRunId,
      itemId: input.targetItemId,
      actionId: input.actionId,
      expectedVersion: null,
      mode: 'replace',
      content: bytes,
    })
  }

  private writeNow(input: Readonly<{
    readyRunId: string
    itemId: string
    actionId: string
    expectedVersion?: string | null
    mode: 'replace' | 'append'
    content: Buffer | string
  }>): ArtifactVersionReceipt {
    const expectedVersion = normalizeVersion(input.expectedVersion)
    if (input.mode === 'append' && expectedVersion === null) {
      throw new ArtifactMaterializerError('artifact_append_expected_version_required')
    }
    const content = Buffer.isBuffer(input.content) ? input.content : Buffer.from(input.content, 'utf8')
    const actionDigest = sha256(canonical({
      contract: 'ready_artifact_write_action_v1',
      readyRunId: input.readyRunId,
      itemId: input.itemId,
      actionId: input.actionId,
      expectedVersion,
      mode: input.mode,
      contentSha256: sha256(content),
      contentBytes: content.length,
    }))
    const operationPath = this.operationPath(input.readyRunId, input.itemId, input.actionId)
    if (existsSync(operationPath)) {
      const stored = readJson<{ actionDigest: string; receipt: ArtifactVersionReceipt }>(
        operationPath,
        'artifact_operation_receipt_invalid',
      )
      if (stored.actionDigest !== actionDigest) {
        throw new ArtifactMaterializerError('artifact_action_replay_conflict')
      }
      return stored.receipt
    }
    const previous = expectedVersion
      ? this.readManifest(input.readyRunId, input.itemId, expectedVersion)
      : null
    const segment: SegmentRef = { sha256: sha256(content), bytes: content.length }
    const segments = input.mode === 'append' && previous
      ? [...previous.segments, segment]
      : [segment]
    const logicalBytes = segments.reduce((total, entry) => total + entry.bytes, 0)
    if (segments.length > MAX_SEGMENTS) throw new ArtifactMaterializerError('artifact_segment_limit_exceeded')
    if (logicalBytes > MAX_LOGICAL_BYTES) throw new ArtifactMaterializerError('artifact_size_limit_exceeded')
    const logicalArtifactRef = `artifact:${sha256(`${input.readyRunId}\0${input.itemId}`)}`
    const manifest: ArtifactManifest = {
      contract: 'ready_artifact_manifest_v1',
      logicalArtifactRef,
      readyRunId: input.readyRunId,
      itemId: input.itemId,
      segments,
      logicalBytes,
    }
    const manifestBytes = Buffer.from(canonical(manifest), 'utf8')
    const manifestDigest = sha256(manifestBytes)
    const version = `sha256:${manifestDigest}`
    const headKey = `${input.readyRunId}\0${input.itemId}`
    let logicalHash: Hash
    if (input.mode === 'append' && previous) {
      const cached = this.headHashes.get(headKey)
      if (cached?.version === expectedVersion) {
        logicalHash = cached.hash.copy()
      } else {
        logicalHash = createHash('sha256')
        this.streamVersion({
          readyRunId: input.readyRunId,
          itemId: input.itemId,
          version: expectedVersion as string,
        }, (chunk) => logicalHash.update(chunk))
      }
    } else {
      logicalHash = createHash('sha256')
    }
    logicalHash.update(content)
    const logicalSha256 = logicalHash.copy().digest('hex')
    const receipt: ArtifactVersionReceipt = Object.freeze({
      logicalArtifactRef,
      actionId: input.actionId,
      expectedVersion,
      mode: input.mode,
      version,
      segmentBytes: segment.bytes,
      segmentSha256: segment.sha256,
      logicalBytes,
      manifestDigest,
      logicalSha256,
    })
    const operationBytes = Buffer.from(canonical({ actionDigest, receipt }), 'utf8')
    this.ensureStorageCapacity(
      input.readyRunId,
      (existsSync(this.segmentPath(input.readyRunId, input.itemId, segment.sha256)) ? 0 : content.length)
        + (existsSync(this.manifestPath(input.readyRunId, input.itemId, version)) ? 0 : manifestBytes.length)
        + operationBytes.length,
    )
    try {
      let addedBytes = 0
      if (writeImmutable(this.segmentPath(input.readyRunId, input.itemId, segment.sha256), content)) {
        addedBytes += content.length
      }
      if (writeImmutable(this.manifestPath(input.readyRunId, input.itemId, version), manifestBytes)) {
        addedBytes += manifestBytes.length
      }
      if (writeImmutable(operationPath, operationBytes)) addedBytes += operationBytes.length
      this.storageBytes += addedBytes
      this.headHashes.set(headKey, { version, hash: logicalHash })
    } catch (error) {
      this.storageBytes = this.directoryBytes(this.baseDir)
      throw error
    }
    return receipt
  }

  private exportNow(input: Readonly<{
    actionReadyRunId: string
    sourceReadyRunId: string
    itemId: string
    actionId: string
    version: string
    expectedSha256: string
    destination: ArtifactDirectoryIdentity
    targetRelativePath: string
    replaceExisting?: boolean
  }>): ArtifactExportReceipt {
    if (!/^[a-f0-9]{64}$/.test(input.expectedSha256)) {
      throw new ArtifactMaterializerError('artifact_expected_hash_invalid')
    }
    const targetRelativePath = normalizeRelativeTarget(input.targetRelativePath)
    const actionDigest = sha256(canonical({
      contract: 'ready_artifact_export_action_v1',
      actionReadyRunId: input.actionReadyRunId,
      sourceReadyRunId: input.sourceReadyRunId,
      itemId: input.itemId,
      actionId: input.actionId,
      version: input.version,
      expectedSha256: input.expectedSha256,
      destinationResourceId: input.destination.logicalResourceId,
      destinationPolicyEpoch: input.destination.policyEpoch,
      targetRelativePath,
      ...(input.replaceExisting ? { replaceExisting: true } : {}),
    }))
    const operationPath = this.operationPath(input.actionReadyRunId, input.itemId, input.actionId)
    if (existsSync(operationPath)) {
      const stored = readJson<{ actionDigest: string; receipt: ArtifactExportReceipt }>(
        operationPath,
        'artifact_operation_receipt_invalid',
      )
      if (stored.actionDigest !== actionDigest) {
        throw new ArtifactMaterializerError('artifact_action_replay_conflict')
      }
      this.verifyExportReadback(stored.receipt, input.destination)
      return stored.receipt
    }
    const sourceManifest = this.readManifest(
      input.sourceReadyRunId,
      input.itemId,
      input.version,
    )
    this.ensureStorageCapacity(input.actionReadyRunId, EXPORT_OPERATION_RECEIPT_RESERVE_BYTES)
    const root = this.verifyDestination(input.destination)
    const targetPath = this.createTargetParent(root, targetRelativePath)
    const existing = this.readExistingTarget(targetPath, input.expectedSha256, input.replaceExisting === true)
    if (existing?.sha256 === input.expectedSha256) {
      const receipt = this.exportReceipt(
        input,
        sourceManifest.logicalArtifactRef,
        targetRelativePath,
        existing,
        'same_hash_idempotent',
      )
      this.writeReservedOperationReceipt(
        operationPath,
        Buffer.from(canonical({ actionDigest, receipt }), 'utf8'),
      )
      return receipt
    }
    const tempPath = join(dirname(targetPath), `.${basename(targetPath)}.${process.pid}.${randomUUID()}.tmp`)
    let fd: number | null = null
    let committed = false
    try {
      fd = openSync(tempPath, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY, 0o600)
      const streamed = this.streamVersion({
        readyRunId: input.sourceReadyRunId,
        itemId: input.itemId,
        version: input.version,
      }, (chunk) => {
        let offset = 0
        while (offset < chunk.length) offset += writeSync(fd as number, chunk, offset)
      })
      if (streamed.sha256 !== input.expectedSha256) {
        throw new ArtifactMaterializerError('artifact_staged_hash_mismatch')
      }
      if (existing) fchmodSync(fd, lstatSync(targetPath).mode & 0o777)
      fsyncSync(fd)
      closeSync(fd)
      fd = null
      if (existing) {
        // Replace only the file the confirmation was about: anything that changed it since is a conflict.
        const current = hashStableRegularFile(targetPath)
        if (current.sha256 !== existing.sha256 || current.inode !== existing.inode) {
          throw new ArtifactMaterializerError('artifact_target_conflict')
        }
        renameSync(tempPath, targetPath)
      } else {
        try {
          linkSync(tempPath, targetPath)
        } catch (error) {
          if (!error || typeof error !== 'object' || !('code' in error) || error.code !== 'EEXIST') throw error
          const raced = this.readExistingTarget(targetPath, input.expectedSha256)
          if (!raced) throw new ArtifactMaterializerError('artifact_target_conflict')
          const receipt = this.exportReceipt(
            input,
            sourceManifest.logicalArtifactRef,
            targetRelativePath,
            raced,
            'same_hash_idempotent',
          )
          writeImmutable(operationPath, Buffer.from(canonical({ actionDigest, receipt }), 'utf8'))
          return receipt
        }
      }
      committed = true
      const directoryFd = openSync(dirname(targetPath), 'r')
      try { fsyncSync(directoryFd) } finally { closeSync(directoryFd) }
      const readback = this.readExistingTarget(targetPath, input.expectedSha256)
      if (!readback) throw new ArtifactMaterializerError('artifact_target_readback_mismatch')
      const receipt = this.exportReceipt(
        input,
        sourceManifest.logicalArtifactRef,
        targetRelativePath,
        readback,
        existing ? 'replaced' : 'created',
      )
      this.writeReservedOperationReceipt(
        operationPath,
        Buffer.from(canonical({ actionDigest, receipt }), 'utf8'),
      )
      return receipt
    } finally {
      if (fd !== null) closeSync(fd)
      if (existsSync(tempPath)) unlinkSync(tempPath)
      if (!committed) this.verifyDestination(input.destination)
    }
  }

  private exportReceipt(
    input: Readonly<{
      itemId: string
      version: string
      expectedSha256: string
      destination: ArtifactDirectoryIdentity
    }>,
    logicalArtifactRef: string,
    targetRelativePath: string,
    readback: { sha256: string; bytes: number; device: string; inode: string },
    result: ArtifactExportReceipt['result'],
  ): ArtifactExportReceipt {
    return Object.freeze({
      logicalArtifactRef,
      version: input.version,
      destinationResourceId: input.destination.logicalResourceId,
      targetRelativePath,
      bytes: readback.bytes,
      sha256: readback.sha256,
      targetDevice: readback.device,
      targetInode: readback.inode,
      result,
      readbackVerified: true,
    })
  }

  private verifyExportReadback(receipt: ArtifactExportReceipt, destination: ArtifactDirectoryIdentity): void {
    const root = this.verifyDestination(destination)
    if (receipt.destinationResourceId !== destination.logicalResourceId) {
      throw new ArtifactMaterializerError('artifact_destination_identity_mismatch')
    }
    const target = join(root, ...receipt.targetRelativePath.split('/'))
    const readback = this.readExistingTarget(target, receipt.sha256)
    if (!readback || readback.bytes !== receipt.bytes
      || readback.device !== receipt.targetDevice || readback.inode !== receipt.targetInode) {
      throw new ArtifactMaterializerError('artifact_target_readback_mismatch')
    }
  }

  private verifyDestination(destination: ArtifactDirectoryIdentity): string {
    const requestedRoot = resolve(destination.path)
    const requestedMetadata = lstatSync(requestedRoot)
    const root = realpathSync(requestedRoot)
    if (requestedMetadata.isSymbolicLink() || !requestedMetadata.isDirectory()) {
      throw new ArtifactMaterializerError('artifact_destination_identity_mismatch')
    }
    const metadata = lstatSync(root)
    if (String(metadata.dev) !== destination.device
      || String(metadata.ino) !== destination.inode
      || metadata.mode !== destination.mode) {
      throw new ArtifactMaterializerError('artifact_destination_identity_mismatch')
    }
    return root
  }

  private createTargetParent(root: string, targetRelativePath: string): string {
    const parts = targetRelativePath.split('/')
    let parent = root
    for (const part of parts.slice(0, -1)) {
      const candidate = join(parent, part)
      if (existsSync(candidate)) {
        const metadata = lstatSync(candidate)
        if (metadata.isSymbolicLink() || !metadata.isDirectory()) {
          throw new ArtifactMaterializerError('artifact_target_parent_invalid')
        }
      } else {
        mkdirSync(candidate, { mode: 0o700 })
      }
      parent = realpathSync(candidate)
      const rel = relative(root, parent)
      if (rel.startsWith(`..${sep}`) || rel === '..' || isAbsolute(rel)) {
        throw new ArtifactMaterializerError('artifact_target_path_escape')
      }
    }
    const target = resolve(parent, parts.at(-1) as string)
    const rel = relative(root, target)
    if (rel.startsWith(`..${sep}`) || rel === '..' || isAbsolute(rel)) {
      throw new ArtifactMaterializerError('artifact_target_path_escape')
    }
    return target
  }

  private readExistingTarget(
    path: string,
    expectedSha256: string,
    replaceable = false,
  ): { sha256: string; bytes: number; device: string; inode: string } | null {
    if (!existsSync(path)) return null
    const digest = hashStableRegularFile(path)
    if (digest.sha256 !== expectedSha256 && !replaceable) throw new ArtifactMaterializerError('artifact_target_conflict')
    return digest
  }

  private readManifest(readyRunId: string, itemId: string, version: string): ArtifactManifest {
    const normalized = normalizeVersion(version)
    if (!normalized) throw new ArtifactMaterializerError('artifact_version_invalid')
    const path = this.manifestPath(readyRunId, itemId, normalized)
    const bytes = readFileSync(path)
    if (`sha256:${sha256(bytes)}` !== normalized) {
      throw new ArtifactMaterializerError('artifact_manifest_digest_mismatch')
    }
    const manifest = JSON.parse(bytes.toString('utf8')) as ArtifactManifest
    if (manifest.contract !== 'ready_artifact_manifest_v1'
      || manifest.readyRunId !== readyRunId || manifest.itemId !== itemId
      || manifest.logicalArtifactRef !== `artifact:${sha256(`${readyRunId}\0${itemId}`)}`
      || !Array.isArray(manifest.segments)
      || manifest.segments.length === 0 || manifest.segments.length > MAX_SEGMENTS
      || manifest.segments.some((entry) => !/^[a-f0-9]{64}$/.test(entry.sha256)
        || !Number.isSafeInteger(entry.bytes) || entry.bytes < 0)
      || manifest.logicalBytes !== manifest.segments.reduce((total, entry) => total + entry.bytes, 0)) {
      throw new ArtifactMaterializerError('artifact_manifest_invalid')
    }
    return manifest
  }

  private itemRoot(readyRunId: string, itemId: string): string {
    return join(this.baseDir, 'runs', token(readyRunId), 'items', token(itemId))
  }

  private segmentPath(readyRunId: string, itemId: string, digest: string): string {
    return join(this.itemRoot(readyRunId, itemId), 'segments', `${digest}.bin`)
  }

  private manifestPath(readyRunId: string, itemId: string, version: string): string {
    return join(this.itemRoot(readyRunId, itemId), 'manifests', `${version.slice(7)}.json`)
  }

  private operationPath(readyRunId: string, itemId: string, actionId: string): string {
    return join(this.itemRoot(readyRunId, itemId), 'operations', `${token(actionId)}.json`)
  }

  private ensureStorageCapacity(currentRunId: string, requiredBytes: number): void {
    if (!Number.isSafeInteger(requiredBytes) || requiredBytes < 0) {
      throw new ArtifactMaterializerError('artifact_storage_reservation_invalid')
    }
    if (this.storageBytes + requiredBytes <= this.maxStorageBytes) return
    const retention = this.options.readStorageRetention?.() ?? {
      protectedRunIds: [],
      collectibleRunIds: [],
    }
    const protectedIds = new Set([...retention.protectedRunIds, currentRunId])
    for (const readyRunId of retention.collectibleRunIds) {
      if (protectedIds.has(readyRunId)) continue
      const root = join(this.baseDir, 'runs', token(readyRunId))
      if (!existsSync(root)) continue
      const collectibleBytes = this.directoryBytes(root)
      rmSync(root, { recursive: true, force: true })
      this.storageBytes = Math.max(0, this.storageBytes - collectibleBytes)
      if (this.storageBytes + requiredBytes <= this.maxStorageBytes) return
    }
    throw new ArtifactMaterializerError('artifact_storage_budget_exhausted')
  }

  private directoryBytes(path: string): number {
    if (!existsSync(path)) return 0
    const metadata = lstatSync(path)
    if (metadata.isSymbolicLink()) throw new ArtifactMaterializerError('artifact_storage_identity_invalid')
    if (metadata.isFile()) return metadata.size
    if (!metadata.isDirectory()) throw new ArtifactMaterializerError('artifact_storage_identity_invalid')
    return readdirSync(path).reduce((total, name) => total + this.directoryBytes(join(path, name)), 0)
  }

  private writeReservedOperationReceipt(path: string, bytes: Buffer): void {
    if (bytes.length > EXPORT_OPERATION_RECEIPT_RESERVE_BYTES) {
      throw new ArtifactMaterializerError('artifact_operation_receipt_too_large')
    }
    try {
      if (writeImmutable(path, bytes)) this.storageBytes += bytes.length
    } catch (error) {
      this.storageBytes = this.directoryBytes(this.baseDir)
      throw error
    }
  }

  private async serial<T>(key: string, work: () => T | Promise<T>): Promise<T> {
    const previous = this.queues.get(key) || Promise.resolve()
    const current = previous.catch(() => undefined).then(work)
    this.queues.set(key, current)
    try {
      return await current
    } finally {
      if (this.queues.get(key) === current) this.queues.delete(key)
    }
  }
}
