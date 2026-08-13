'use strict'

const {
  closeSync,
  existsSync,
  fsyncSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} = require('node:fs')
const { dirname } = require('node:path')

const RAW_CAPTURE_KEYS = [
  'bodyBytes',
  'capturedAt',
  'inputDigest',
  'inputItems',
  'instructionDigest',
  'proofSentinelDigest',
  'proofSentinelOccurrences',
  'proofSentinels',
  'readyResourceReferenceCount',
  'readyRunId',
  'requestDigest',
  'requestKind',
  'threadId',
  'toolCount',
  'toolNames',
  'toolsDigest',
  'turnId',
]
const RETAINED_CAPTURE_KEYS = [
  'inputDigest',
  'proofSentinels',
  'readyResourceReferenceCount',
  'readyRunId',
  'requestDigest',
  'requestKind',
  'threadId',
  'toolCount',
  'toolNames',
  'toolsDigest',
  'turnId',
]
const INPUT_ITEM_KEYS = [
  'digest',
  'id',
  'index',
  'maxStringCharacters',
  'role',
  'stringCount',
  'totalStringCharacters',
  'type',
]
const SENTINEL_KEYS = ['digest', 'occurrences']
const SHA256 = /^[a-f0-9]{64}$/

function sameKeys(value, expected) {
  return value && typeof value === 'object' && !Array.isArray(value)
    && JSON.stringify(Object.keys(value).sort()) === JSON.stringify(expected)
}

function nonemptyString(value) {
  return typeof value === 'string' && value.length > 0
}

function nullableString(value) {
  return value === null || typeof value === 'string'
}

function nonnegativeInteger(value) {
  return Number.isSafeInteger(value) && value >= 0
}

function validateRetainedE6GatewayCapture(captures) {
  if (!Array.isArray(captures)) throw new Error('e6_gateway_capture_schema_invalid')
  return captures.map((capture) => {
    if (!sameKeys(capture, RETAINED_CAPTURE_KEYS)
      || capture.requestKind !== 'product'
      || !nonemptyString(capture.readyRunId)
      || !nonemptyString(capture.threadId)
      || !nonemptyString(capture.turnId)
      || !SHA256.test(capture.requestDigest)
      || !SHA256.test(capture.inputDigest)
      || !SHA256.test(capture.toolsDigest)
      || !nonnegativeInteger(capture.readyResourceReferenceCount)
      || !Array.isArray(capture.toolNames)
      || capture.toolNames.some((name) => !nonemptyString(name))
      || new Set(capture.toolNames).size !== capture.toolNames.length
      || !nonnegativeInteger(capture.toolCount)
      || capture.toolCount !== capture.toolNames.length
      || !Array.isArray(capture.proofSentinels)) {
      throw new Error('e6_gateway_capture_schema_invalid')
    }
    const proofSentinels = capture.proofSentinels.map((sentinel) => {
      if (!sameKeys(sentinel, SENTINEL_KEYS)
        || !SHA256.test(sentinel.digest)
        || !nonnegativeInteger(sentinel.occurrences)) {
        throw new Error('e6_gateway_capture_schema_invalid')
      }
      return { digest: sentinel.digest, occurrences: sentinel.occurrences }
    })
    return { ...capture, toolNames: [...capture.toolNames], proofSentinels }
  })
}

function sanitizeE6GatewayCapture(captures) {
  if (!Array.isArray(captures)) throw new Error('e6_gateway_capture_schema_invalid')
  return captures.map((capture) => {
    if (!sameKeys(capture, RAW_CAPTURE_KEYS)
      || typeof capture.capturedAt !== 'string'
      || Number.isNaN(Date.parse(capture.capturedAt))
      || new Date(capture.capturedAt).toISOString() !== capture.capturedAt
      || capture.requestKind !== 'product'
      || !nonemptyString(capture.readyRunId)
      || !nonemptyString(capture.threadId)
      || !nonemptyString(capture.turnId)
      || !SHA256.test(capture.requestDigest)
      || !nonnegativeInteger(capture.bodyBytes)
      || !SHA256.test(capture.instructionDigest)
      || !SHA256.test(capture.inputDigest)
      || !SHA256.test(capture.toolsDigest)
      || !nonnegativeInteger(capture.readyResourceReferenceCount)
      || !Array.isArray(capture.toolNames)
      || capture.toolNames.some((name) => !nonemptyString(name))
      || new Set(capture.toolNames).size !== capture.toolNames.length
      || !nonnegativeInteger(capture.toolCount)
      || capture.toolCount !== capture.toolNames.length
      || (capture.proofSentinelDigest !== null && !SHA256.test(capture.proofSentinelDigest))
      || !nonnegativeInteger(capture.proofSentinelOccurrences)
      || !Array.isArray(capture.proofSentinels)
      || !Array.isArray(capture.inputItems)) {
      throw new Error('e6_gateway_capture_schema_invalid')
    }
    const proofSentinels = capture.proofSentinels.map((sentinel) => {
      if (!sameKeys(sentinel, SENTINEL_KEYS)
        || !SHA256.test(sentinel.digest)
        || !Number.isSafeInteger(sentinel.occurrences)
        || sentinel.occurrences < 0) {
        throw new Error('e6_gateway_capture_schema_invalid')
      }
      return { digest: sentinel.digest, occurrences: sentinel.occurrences }
    })
    if (capture.proofSentinelDigest !== (proofSentinels[0]?.digest ?? null)
      || capture.proofSentinelOccurrences !== (proofSentinels[0]?.occurrences ?? 0)) {
      throw new Error('e6_gateway_capture_schema_invalid')
    }
    for (const [index, item] of capture.inputItems.entries()) {
      if (!sameKeys(item, INPUT_ITEM_KEYS)
        || item.index !== index
        || !nullableString(item.type)
        || !nullableString(item.role)
        || !nullableString(item.id)
        || !nonnegativeInteger(item.stringCount)
        || !nonnegativeInteger(item.totalStringCharacters)
        || !nonnegativeInteger(item.maxStringCharacters)
        || item.maxStringCharacters > item.totalStringCharacters
        || (item.stringCount === 0
          && (item.totalStringCharacters !== 0 || item.maxStringCharacters !== 0))
        || !SHA256.test(item.digest)) {
        throw new Error('e6_gateway_capture_schema_invalid')
      }
    }
    return validateRetainedE6GatewayCapture([{
      requestKind: capture.requestKind,
      readyRunId: capture.readyRunId,
      threadId: capture.threadId,
      turnId: capture.turnId,
      requestDigest: capture.requestDigest,
      inputDigest: capture.inputDigest,
      readyResourceReferenceCount: capture.readyResourceReferenceCount,
      toolsDigest: capture.toolsDigest,
      toolNames: [...capture.toolNames],
      toolCount: capture.toolCount,
      proofSentinels,
    }])[0]
  })
}

function readJsonLinesStrict(path) {
  return readFileSync(path, 'utf8')
    .split(/\r?\n/)
    .filter((line) => line.trim())
    .map((line) => JSON.parse(line))
}

function retainValidatedE6GatewayCapture(options) {
  if (existsSync(options.targetPath)) throw new Error('e6_gateway_capture_target_not_fresh')
  const temporaryPath = `${options.targetPath}.${process.pid}.tmp`
  rmSync(temporaryPath, { force: true })
  try {
    const gatewayCapture = sanitizeE6GatewayCapture(readJsonLinesStrict(options.sourcePath))
    const validationResult = options.validate(gatewayCapture)
    const payload = gatewayCapture.map((row) => JSON.stringify(row)).join('\n') + '\n'
    writeFileSync(temporaryPath, payload, { mode: 0o600 })
    const fileDescriptor = openSync(temporaryPath, 'r')
    try { fsyncSync(fileDescriptor) } finally { closeSync(fileDescriptor) }
    renameSync(temporaryPath, options.targetPath)
    const directoryDescriptor = openSync(dirname(options.targetPath), 'r')
    try { fsyncSync(directoryDescriptor) } finally { closeSync(directoryDescriptor) }
    return { gatewayCapture, validationResult }
  } catch (error) {
    rmSync(temporaryPath, { force: true })
    rmSync(options.targetPath, { force: true })
    throw error
  }
}

module.exports = {
  retainValidatedE6GatewayCapture,
  sanitizeE6GatewayCapture,
  validateRetainedE6GatewayCapture,
}
