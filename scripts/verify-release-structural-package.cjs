#!/usr/bin/env node
'use strict'

const { execFileSync, spawnSync } = require('node:child_process')
const { createHash, createPrivateKey, createSecretKey, randomUUID } = require('node:crypto')
const { builtinModules, createRequire } = require('node:module')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const {
  RUNTIME_MANIFEST_REL,
  assertPathChain,
  buildReleaseSourceManifest,
  captureRegularFile,
  captureOpenDescriptor,
  loadVerifiedStructuralReceipt,
  packagingContract,
  receiptRelForArtifactSha,
  sameFileIdentity,
  sha256File,
} = require('./release-package-identity.cjs')
const { buildOutputManifest, buildSourceManifest } = require('./browser-live-proof-manifest.cjs')

const ROOT = path.resolve(__dirname, '..')
const MAX_SLIM_DMG_BYTES = 350 * 1024 * 1024
const SYSTEM_TOOLS = Object.freeze({
  codesign: '/usr/bin/codesign',
  hdiutil: '/usr/bin/hdiutil',
  diskutil: '/usr/sbin/diskutil',
  lipo: '/Library/Developer/CommandLineTools/usr/bin/lipo',
  plutil: '/usr/bin/plutil',
})

function structuralEnvironment(env = {}) {
  return {
    HOME: '/var/empty',
    LANG: 'C',
    LC_ALL: 'C',
    PATH: '/usr/bin:/bin:/usr/sbin:/sbin',
    TMPDIR: os.tmpdir(),
    ...env,
  }
}

function run(command, args, { root = ROOT, capture = false, env, inheritedDescriptor } = {}) {
  const executable = SYSTEM_TOOLS[command] || command
  return execFileSync(executable, args, {
    cwd: root,
    encoding: 'utf8',
    stdio: inheritedDescriptor === undefined
      ? (capture ? 'pipe' : 'inherit')
      : ['ignore', capture ? 'pipe' : 'inherit', capture ? 'pipe' : 'inherit', inheritedDescriptor],
    env: structuralEnvironment(env),
  })
}

function scalarPlistValue(plistPath, key, root) {
  return String(run('plutil', ['-extract', key, 'raw', '-o', '-', plistPath], {
    root,
    capture: true,
  })).trim()
}

function singleArchitecture(binaryPath, root, label) {
  const arches = String(run('lipo', ['-archs', binaryPath], { root, capture: true }))
    .trim()
    .split(/\s+/)
    .filter(Boolean)
  if (arches.length !== 1) throw new Error(`${label} must contain exactly one architecture`)
  return arches[0]
}

function resolvedInside(root, targetPath, label) {
  const resolvedRoot = fs.realpathSync(root)
  const resolved = fs.realpathSync(targetPath)
  if (resolved !== resolvedRoot && !resolved.startsWith(`${resolvedRoot}${path.sep}`)) {
    throw new Error(`${label} resolves outside the mounted package`)
  }
  return resolved
}

function lockVersion(root, packageName) {
  const lock = JSON.parse(fs.readFileSync(path.join(root, 'package-lock.json'), 'utf8'))
  const version = lock?.packages?.[`node_modules/${packageName}`]?.version
  if (!version) throw new Error(`package-lock is missing ${packageName}`)
  return String(version)
}

function relativeFileInventory(root, filter = () => true) {
  const files = []
  const visit = (directory) => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const absolutePath = path.join(directory, entry.name)
      const relativePath = path.relative(root, absolutePath).split(path.sep).join('/')
      const stat = fs.lstatSync(absolutePath)
      if (stat.isSymbolicLink()) throw new Error(`packaged resource symlink is not allowed: ${relativePath}`)
      if (entry.isDirectory()) {
        visit(absolutePath)
      } else if (entry.isFile() && filter(relativePath)) {
        const identity = captureRegularFile(absolutePath, root)
        files.push({ path: relativePath, mode: identity.mode, bytes: identity.bytes, sha256: identity.sha256 })
      }
    }
  }
  visit(root)
  return files.sort((left, right) => left.path.localeCompare(right.path))
}

function assertResourceTree(sourceRoot, mountedRoot, {
  filter = () => true,
  label,
  allowedMountedExtras = new Set(),
}) {
  const expected = relativeFileInventory(sourceRoot, filter)
  const actual = relativeFileInventory(mountedRoot)
  const expectedByPath = new Map(expected.map((file) => [file.path, file]))
  const actualByPath = new Map(actual.map((file) => [file.path, file]))
  for (const file of expected) {
    const mounted = actualByPath.get(file.path)
    if (!mounted || mounted.mode !== file.mode
      || mounted.bytes !== file.bytes || mounted.sha256 !== file.sha256) {
      throw new Error(`${label} resource mismatch: ${file.path}`)
    }
  }
  for (const file of actual) {
    if (!expectedByPath.has(file.path) && !allowedMountedExtras.has(file.path)) {
      throw new Error(`${label} has unexpected resource: ${file.path}`)
    }
  }
  return actual
}

function isSensitivePayloadPath(relativePath) {
  const normalized = String(relativePath).replace(/\\/g, '/').toLowerCase()
  const segments = normalized.split('/').filter(Boolean)
  const base = segments.at(-1) || ''
  const sensitiveDirectorySegments = new Set([
    'agent-memory',
    'agent-sidecar-runtime',
    'channel-attachments',
    'rss-artifacts',
    'rsshub-runtime',
    'puppeteer-cache',
    '__pycache__',
    '.pytest_cache',
    '.mypy_cache',
  ])
  return segments.some((segment) => sensitiveDirectorySegments.has(segment))
    || base === '.env'
    || base.startsWith('.env.')
    || base === 'cookies.sqlite'
    || base === 'token.json'
    || base === 'credentials.json'
    || base.startsWith('.npmrc')
    || base === '.netrc'
    || base === 'id_rsa'
    || base === 'id_ed25519'
    || base.endsWith('.p12')
    || base.endsWith('.pfx')
    || base.endsWith('.key')
    || base.endsWith('.pem')
    || base.endsWith('.db')
    || base.endsWith('.db-shm')
    || base.endsWith('.db-wal')
}

function assertAdHocSignature(appPath, root) {
  const inspected = spawnSync(SYSTEM_TOOLS.codesign, ['-d', '--verbose=4', appPath], {
    cwd: root,
    encoding: 'utf8',
    env: structuralEnvironment(),
  })
  if (inspected.error || inspected.status !== 0) {
    throw new Error('packaged application signing identity could not be inspected')
  }
  const detail = `${inspected.stdout || ''}\n${inspected.stderr || ''}`
  if (!/^Signature=adhoc$/m.test(detail) || !/^TeamIdentifier=not set$/m.test(detail)) {
    throw new Error('local structural package must use an ad-hoc signing identity')
  }
}

function assertNoSensitiveFilesUnder(root) {
  const visit = (directory) => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const absolute = path.join(directory, entry.name)
      const relative = path.relative(root, absolute).split(path.sep).join('/')
      const stat = fs.lstatSync(absolute)
      if (stat.isSymbolicLink()) {
        if (isSensitivePayloadPath(relative)) {
          throw new Error(`packaged application contains forbidden credential carrier: ${relative}`)
        }
        resolvedInside(root, absolute, `packaged symlink ${relative}`)
        continue
      }
      if (stat.isDirectory()) visit(absolute)
      else if (stat.isFile() && isSensitivePayloadPath(relative)) {
        throw new Error(`packaged application contains forbidden credential carrier: ${relative}`)
      }
    }
  }
  visit(root)
}

function assertNoSensitivePayload(label, files) {
  const sensitive = files.find((file) => isSensitivePayloadPath(file.path))
  if (sensitive) throw new Error(`${label} contains forbidden credential carrier: ${sensitive.path}`)
}

function decodedSecretViews(content) {
  const views = [content.toString('utf8')]
  if (!content.includes(0)) return views
  for (const offset of [0, 1]) {
    const byteLength = content.length - offset - ((content.length - offset) % 2)
    if (byteLength <= 0) continue
    const aligned = content.subarray(offset, offset + byteLength)
    views.push(aligned.toString('utf16le'))
    const swapped = Buffer.from(aligned)
    swapped.swap16()
    views.push(swapped.toString('utf16le'))
  }
  return [...new Set(views)]
}

function decodeQuotedLiteral(text, start) {
  const quote = text[start]
  if (quote !== '"' && quote !== "'" && quote !== '`') return null
  let cursor = start + 1
  let value = ''
  let dynamic = false
  while (cursor < text.length) {
    const character = text[cursor]
    if (character === quote) return { value, literal: !dynamic, end: cursor + 1 }
    if (quote === '`' && character === '$' && text[cursor + 1] === '{') dynamic = true
    if (character === '\\' && cursor + 1 < text.length) {
      const escaped = text[cursor + 1]
      if (escaped === 'u' && /^[0-9a-f]{4}$/i.test(text.slice(cursor + 2, cursor + 6))) {
        value += String.fromCodePoint(Number.parseInt(text.slice(cursor + 2, cursor + 6), 16))
        cursor += 6
        continue
      }
      if (escaped === 'x' && /^[0-9a-f]{2}$/i.test(text.slice(cursor + 2, cursor + 4))) {
        value += String.fromCodePoint(Number.parseInt(text.slice(cursor + 2, cursor + 4), 16))
        cursor += 4
        continue
      }
      value += ({ n: '\n', r: '\r', t: '\t' })[escaped] ?? escaped
      cursor += 2
      continue
    }
    value += character
    cursor += 1
  }
  return null
}

function secretTextDialect(sourcePath) {
  const extension = path.extname(String(sourcePath || '')).toLowerCase()
  if (['.md', '.txt', '.csv', '.log'].includes(extension)) return 'plain'
  if (['.py', '.yaml', '.yml', '.toml', '.ini', '.conf', '.env'].includes(extension)) return 'hash-comment'
  if (['.html', '.htm', '.xml', '.plist', '.svg'].includes(extension)) return 'markup'
  if (extension === '.json') return 'json'
  return 'javascript'
}

function lexicalSecretStructure(text, dialect = 'javascript') {
  const code = new Uint8Array(text.length)
  code.fill(1)
  const strings = []
  const stringRanges = []
  if (dialect === 'plain') return { code, strings, stringRanges }
  let cursor = 0
  let previousCodeCharacter = ''
  while (cursor < text.length) {
    const character = text[cursor]
    const next = text[cursor + 1]
    if (dialect === 'markup' && text.startsWith('<!--', cursor)) {
      const start = cursor
      const end = text.indexOf('-->', cursor + 4)
      cursor = end === -1 ? text.length : end + 3
      code.fill(0, start, cursor)
      continue
    }
    if (dialect === 'hash-comment' && character === '#') {
      const start = cursor
      while (cursor < text.length && text[cursor] !== '\n') cursor += 1
      code.fill(0, start, cursor)
      continue
    }
    if (dialect === 'javascript' && character === '/' && next === '/') {
      const start = cursor
      cursor += 2
      while (cursor < text.length && text[cursor] !== '\n') cursor += 1
      code.fill(0, start, cursor)
      continue
    }
    if (dialect === 'javascript' && character === '/' && next === '*') {
      const start = cursor
      cursor += 2
      while (cursor < text.length && !(text[cursor] === '*' && text[cursor + 1] === '/')) cursor += 1
      cursor = Math.min(text.length, cursor + 2)
      code.fill(0, start, cursor)
      continue
    }
    if (character === '"' || character === "'" || character === '`') {
      const literal = decodeQuotedLiteral(text, cursor)
      if (!literal) break
      code.fill(0, cursor + 1, literal.end - 1)
      if (literal.literal) {
        strings.push(literal.value)
        stringRanges.push({ start: cursor + 1, end: literal.end - 1 })
      }
      cursor = literal.end
      previousCodeCharacter = character
      continue
    }
    if (dialect === 'javascript' && character === '/' && /^(?:|[=([{,:;!&|?])$/.test(previousCodeCharacter)) {
      const start = cursor
      cursor += 1
      let inClass = false
      while (cursor < text.length) {
        if (text[cursor] === '\\') cursor += 2
        else if (text[cursor] === '[') { inClass = true; cursor += 1 }
        else if (text[cursor] === ']') { inClass = false; cursor += 1 }
        else if (text[cursor] === '/' && !inClass) {
          cursor += 1
          while (/[a-z]/i.test(text[cursor] || '')) cursor += 1
          break
        } else cursor += 1
      }
      code.fill(0, start, cursor)
      continue
    }
    if (!/\s/.test(character)) previousCodeCharacter = character
    cursor += 1
  }
  return { code, strings, stringRanges }
}

function decodedStaticValue(text, start, key) {
  const maxValueLength = 64 * 1024
  let cursor = start
  while (text[cursor] === ' ' || text[cursor] === '\t') cursor += 1
  const quote = text[cursor]
  if (quote === '"' || quote === "'" || quote === '`') {
    const literal = decodeQuotedLiteral(text, cursor)
    return literal ? { value: literal.value, literal: literal.literal } : null
  }
  if (quote === '|' || quote === '>') {
    const indicator = text.slice(cursor).match(/^[|>](?:[1-9])?[+-]?\s*\r?\n/)?.[0]
    if (!indicator) return null
    const block = []
    let lineStart = cursor + indicator.length
    let length = 0
    while (lineStart < text.length && length <= maxValueLength) {
      const lineEnd = text.indexOf('\n', lineStart)
      const end = lineEnd === -1 ? text.length : lineEnd
      const line = text.slice(lineStart, end).replace(/\r$/, '')
      if (!/^\s+/.test(line)) break
      block.push(line.trim())
      length += line.length
      lineStart = end + 1
    }
    return block.length > 0 ? { value: block.join(quote === '|' ? '\n' : ' '), literal: true } : null
  }
  if (/^authorization$/i.test(key)) {
    const authorization = text.slice(cursor).match(/^(?:Bearer\s+eyJ[A-Za-z0-9._-]{20,}|Basic\s+[A-Za-z0-9+/=]{20,})/i)?.[0]
    if (authorization) return { value: authorization, literal: true }
  }
  const structuredBare = text.slice(cursor).match(/^(?:\d{6,12}:[A-Za-z0-9_-]{20,}|(?:postgres(?:ql)?|mysql|mongodb(?:\+srv)?|redis):\/\/[^\s,;}\]]+)/i)?.[0]
  if (structuredBare) return { value: structuredBare, literal: false }
  const valueStart = cursor
  while (cursor < text.length && !/[\s,;:}\]=]/.test(text[cursor])
    && cursor - valueStart <= maxValueLength) cursor += 1
  if (cursor === valueStart || cursor - valueStart > maxValueLength) return null
  return { value: text.slice(valueStart, cursor), literal: false }
}

function* assignedCredentialValues(text, structure = lexicalSecretStructure(text)) {
  const assignments = [
    /\b([A-Za-z_$][\w$]{0,127})\b\s*(?::|(?<![=!<>])=(?!=|>))\s*/g,
    /(?:^|[\s,{])([A-Za-z_$][\w$-]*-[\w$-]+)\s*:\s*/gm,
    /(?:^|[\s,{])["']([A-Za-z_$][\w$-]{0,127})["']\s*:\s*/gm,
  ]
  let match
  for (const assignment of assignments) {
    while ((match = assignment.exec(text))) {
      const contextOffset = match.index + Math.max(0, match[0].search(/\S/))
      if (!structure.code[contextOffset]) continue
      const candidate = decodedStaticValue(text, assignment.lastIndex, match[1])
      if (candidate) yield { key: match[1], ...candidate }
    }
  }
  const plist = /<key>\s*([^<]+)\s*<\/key>\s*<string>\s*([^<]+)\s*<\/string>/gi
  while ((match = plist.exec(text))) {
    if (structure.code[match.index]) yield { key: match[1], value: match[2].trim(), literal: true }
  }
}

function knownCredentialMatches(value) {
  const jwt = 'eyJ[A-Za-z0-9_-]{8,}\\.eyJ[A-Za-z0-9_-]{8,}\\.[A-Za-z0-9_-]{8,}'
  const pattern = new RegExp(`(?<![A-Za-z0-9])(?:`
    + `(?:sk|ghp|github_pat|glpat|whsec)[-_][A-Za-z0-9._-]{12,}`
    + `|npm_[A-Za-z0-9]{36,}`
    + `|rk_(?:live|test)_[A-Za-z0-9._-]{12,}`
    + `|xox[A-Za-z]?-[A-Za-z0-9-]{12,}`
    + `|xapp-[A-Za-z0-9-]{12,}`
    + `|SG\\.[A-Za-z0-9_-]{10,}\\.[A-Za-z0-9_-]{10,}`
    + `|AIza[A-Za-z0-9_-]{20,}`
    + `|(?:AKIA|ASIA)[A-Z0-9]{12,}`
    + `|IQoJ[A-Za-z0-9+/=]{20,}`
    + `|${jwt}`
    + `|Bearer\\s+(?:[A-Za-z0-9._~+/=-]|%[0-9A-Fa-f]{2}){20,}`
    + `|Basic\\s+[A-Za-z0-9+/=]{20,}`
    + `|\\d{8,12}:AA[A-Za-z0-9_-]{30,}`
    + `|(?:postgres(?:ql)?|mysql|mongodb(?:\\+srv)?|redis):\\/\\/[^:\\s/@]+:[^\\s/@]+@[^\\s"'<>]+`
    + `)(?![A-Za-z0-9])`, 'gi')
  return String(value).matchAll(pattern)
}

function knownCredentialShape(value) {
  for (const match of knownCredentialMatches(value)) {
    if (match.index === 0 && match[0].length === value.length) return true
  }
  return false
}

function isDynamicCredentialExpression(value) {
  return /^[A-Za-z_$][\w$]*(?:(?:\?\.|\.)[A-Za-z_$][\w$]*|\[[^\]]+\])*!?$/.test(value)
    || /^[A-Za-z_$][\w$]*\s*\(/.test(value)
    || /^\(?\s*process\.env\.[A-Z0-9_]+/i.test(value)
    || /\$\{[^}]+\}/.test(value)
    || /[()[\]{}]/.test(value)
}

function readDerTlv(buffer, offset) {
  if (offset >= buffer.length) return null
  const tag = buffer[offset]
  const firstLength = buffer[offset + 1]
  if (firstLength === undefined) return null
  let length = firstLength
  let headerBytes = 2
  if ((firstLength & 0x80) !== 0) {
    const count = firstLength & 0x7f
    if (count === 0 || count > 4 || offset + 2 + count > buffer.length) return null
    length = 0
    for (let index = 0; index < count; index += 1) length = (length * 256) + buffer[offset + 2 + index]
    headerBytes += count
  }
  const valueStart = offset + headerBytes
  const end = valueStart + length
  if (end > buffer.length) return null
  return { tag, valueStart, end }
}

function isEncryptedPkcs8Der(content) {
  const outer = readDerTlv(content, 0)
  if (!outer || outer.tag !== 0x30 || outer.end !== content.length) return false
  const algorithm = readDerTlv(content, outer.valueStart)
  if (!algorithm || algorithm.tag !== 0x30) return false
  const oid = readDerTlv(content, algorithm.valueStart)
  const encryptedPrivateKeyOids = [
    Buffer.from('2a864886f70d01050d', 'hex'), // PBES2
    Buffer.from('2a864886f70d010c0103', 'hex'), // PBE-SHA1-3DES
  ]
  if (!oid || oid.tag !== 0x06
    || !encryptedPrivateKeyOids.some((value) => (
      content.subarray(oid.valueStart, oid.end).equals(value)
    ))) return false
  const parameters = readDerTlv(content, oid.end)
  if (!parameters || parameters.end !== algorithm.end) return false
  const encrypted = readDerTlv(content, algorithm.end)
  return Boolean(encrypted && encrypted.tag === 0x04
    && encrypted.end === outer.end && encrypted.end > encrypted.valueStart)
}

function encryptedPrivateKeyContainer(content) {
  if (isEncryptedPkcs8Der(content)) return true
  const text = content.toString('utf8')
  const encryptedPkcs8 = text.match(
    /-----BEGIN ENCRYPTED PRIVATE KEY-----\s+([A-Za-z0-9+/=\r\n]+)-----END ENCRYPTED PRIVATE KEY-----/,
  )
  if (encryptedPkcs8) {
    const der = Buffer.from(encryptedPkcs8[1].replace(/\s/g, ''), 'base64')
    if (isEncryptedPkcs8Der(der)) return true
  }
  const traditional = text.match(
    /-----BEGIN (RSA|EC) PRIVATE KEY-----\s+Proc-Type:\s*4,ENCRYPTED\s+DEK-Info:[^\r\n]+\r?\n\r?\n([A-Za-z0-9+/=\r\n]+)-----END \1 PRIVATE KEY-----/,
  )
  if (traditional) {
    const der = Buffer.from(traditional[2].replace(/\s/g, ''), 'base64')
    const detail = traditional[0].match(/DEK-Info:\s*(AES-(?:128|192|256)-CBC|DES-EDE3-CBC),([0-9A-F]+)\r?\n/i)
    const cipher = String(detail?.[1] || '').toUpperCase()
    const iv = detail?.[2] || ''
    const blockBytes = cipher === 'DES-EDE3-CBC' ? 8 : 16
    if (cipher && iv.length === blockBytes * 2
      && der.length >= blockBytes && der.length % blockBytes === 0) return true
  }
  const openssh = text.match(
    /-----BEGIN OPENSSH PRIVATE KEY-----\s+([A-Za-z0-9+/=\r\n]+)-----END OPENSSH PRIVATE KEY-----/,
  )
  if (openssh) {
    const key = Buffer.from(openssh[1].replace(/\s/g, ''), 'base64')
    const magic = Buffer.from('openssh-key-v1\0')
    if (key.length > magic.length + 4 && key.subarray(0, magic.length).equals(magic)) return true
  }
  return false
}

function highConfidenceSecretKind(content, { thirdPartyDependency = false, sourcePath = '' } = {}) {
  if (!Buffer.isBuffer(content)) return null
  if (encryptedPrivateKeyContainer(content)) return 'private-key'
  for (const type of ['pkcs8', 'pkcs1', 'sec1']) {
    try {
      createPrivateKey({ key: content, format: 'der', type })
      return 'private-key'
    } catch (error) {
      void error
    }
  }
  const jsonText = content.toString('utf8').trim()
  if ((jsonText.startsWith('{') && jsonText.endsWith('}'))
    || (jsonText.startsWith('[') && jsonText.endsWith(']'))) {
    let parsed = null
    try {
      parsed = JSON.parse(jsonText)
    } catch (error) {
      void error
    }
    if (parsed) {
      const queue = [{ value: parsed, depth: 0 }]
      let visited = 0
      while (queue.length > 0 && visited < 10_000) {
        const { value: candidate, depth } = queue.shift()
        visited += 1
        if (typeof candidate === 'string') {
          if (encryptedPrivateKeyContainer(Buffer.from(candidate))) return 'private-key'
          continue
        }
        if (!candidate || typeof candidate !== 'object') continue
        if (candidate.kty === 'oct' && typeof candidate.k === 'string') {
          try {
            const key = Buffer.from(candidate.k, 'base64url')
            if (key.length >= 16 && createSecretKey(key)) return 'private-key'
          } catch (error) {
            void error
          }
        }
        if (candidate.kty && candidate.d) {
          try {
            createPrivateKey({ key: candidate, format: 'jwk' })
            return 'private-key'
          } catch (error) {
            void error
          }
        }
        if (depth >= 16) continue
        for (const nested of Array.isArray(candidate) ? candidate : Object.values(candidate)) {
          if (nested && (typeof nested === 'object' || typeof nested === 'string')) {
            queue.push({ value: nested, depth: depth + 1 })
          }
        }
      }
    }
  }
  const publishedNonSecretValues = new Set([
    'AIzaSyAO_FJ2SlqU8Q4STEHLGCilw_Y9_11qcW8',
    'sk-kimi-preview-1234567890',
    'sk-openai-preview',
    'sk-ant-preview',
    'AIza-preview',
    'secret_preview_feishu',
    'verify_preview',
    '123456:preview_telegram_token',
  ])
  const publishedThirdPartyValueDigests = new Set([
    // Public constants shipped by the pinned RSSHub dependency. Store only hashes
    // so the release gate never prints or republishes credential-shaped values.
    '46881cb163daf8357f0a20b0005ccb812f798dc9685845ea29f3c938c84c6d19',
    '8eff6ee9fc2c6142c0fcb3721f0c7ffa441233554739588dd1b6445f3098cf98',
    '3edf5fa78df458e7172889dd53f9949ee252906f1a4a5829bbe28bfe6042a3dd',
    '9fcf8cddbbfbb3a935db874f4ba3fb884b593d22b5fa2be4017f0cc2adeb3714',
    '649a93ba2684ce1486c67e6a29dec642fc198fd149679481081652ab93c9f2b8',
  ])
  const credentialKeySuffix = /(?:API_KEY|APP_SECRET|CLIENT_SECRET|ACCESS_TOKEN|REFRESH_TOKEN|SESSION_TOKEN|AUTH_TOKEN|BOT_TOKEN|APP_TOKEN|GITHUB_TOKEN|NPM_TOKEN|GITLAB_TOKEN|PRIVATE_KEY|PASSWORD|ACCESS_KEY_ID|SECRET_ACCESS_KEY|SECRET_KEY|DATABASE_URL)$/
  for (const text of decodedSecretViews(content)) {
    for (const pemText of [text, text.replace(/\\r\\n|\\n/g, '\n').replace(/\\r/g, '\r')]) {
      const pem = pemText.match(/-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----[\s\S]+?-----END (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/i)?.[0]
      if (!pem) continue
      try {
        createPrivateKey(pem)
        return 'private-key'
      } catch (error) {
        void error
      }
    }
    const structure = lexicalSecretStructure(text, secretTextDialect(sourcePath))
    let stringRangeIndex = 0
    for (const match of knownCredentialMatches(text)) {
      const start = match.index
      const end = start + match[0].length
      while (stringRangeIndex < structure.stringRanges.length
        && structure.stringRanges[stringRangeIndex].end < start) stringRangeIndex += 1
      const range = structure.stringRanges[stringRangeIndex]
      const eligible = structure.code[start]
        || (range && start >= range.start && end <= range.end)
      if (!eligible) continue
      const value = match[0]
      if (publishedNonSecretValues.has(value)) continue
      if (thirdPartyDependency
        && publishedThirdPartyValueDigests.has(createHash('sha256').update(value).digest('hex'))) continue
      return 'credential-value'
    }
    for (const string of structure.strings) {
      for (const match of knownCredentialMatches(string)) {
        const value = match[0]
        if (publishedNonSecretValues.has(value)) continue
        if (thirdPartyDependency
          && publishedThirdPartyValueDigests.has(createHash('sha256').update(value).digest('hex'))) continue
        return 'credential-value'
      }
    }
    for (const candidate of assignedCredentialValues(text, structure)) {
      const value = String(candidate.value || '').trim()
      if (!value || value.length < 12 || publishedNonSecretValues.has(value)) continue
      if (thirdPartyDependency
        && publishedThirdPartyValueDigests.has(createHash('sha256').update(value).digest('hex'))) continue
      const normalizedKey = String(candidate.key || '')
        .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
        .replace(/-/g, '_')
        .toUpperCase()
      const recognizedKey = credentialKeySuffix.test(normalizedKey)
      if (knownCredentialShape(value)
        || (recognizedKey && /^(?:pat|key|token)[-_][A-Za-z0-9._-]{12,}$/i.test(value))) {
        return 'credential-value'
      }
      const staticValue = candidate.literal || !isDynamicCredentialExpression(value)
      if (!staticValue) continue
      if (/\s/.test(value)
        || /^(?:x+|test|example|dummy|placeholder|changeme|replace[-_ ]?me|your[-_ ].*|preview|mock|fake|sample|demo|sensitive|process\.env(?:\.[A-Z0-9_]+)?|\$\{[^}]+\}|<[^>]+>)$/i.test(value)) continue
      const strictCredentialKey = /(?:^|_)(?:SECRET_ACCESS_KEY|SECRET_KEY|SESSION_TOKEN|AUTH_TOKEN|BOT_TOKEN|APP_TOKEN|GITHUB_TOKEN|NPM_TOKEN|GITLAB_TOKEN|DATABASE_URL)$/.test(normalizedKey)
      const explicitAppSecret = !thirdPartyDependency
        && recognizedKey
        && /(?:^|_)(?:PASSWORD|APP_SECRET|CLIENT_SECRET|PRIVATE_KEY|SECRET_KEY)$/.test(normalizedKey)
        && staticValue
      if (!explicitAppSecret
        && !(recognizedKey && value.length >= 20 && (!thirdPartyDependency || strictCredentialKey) && staticValue && /^[A-Za-z0-9._~+/=-]+$/.test(value) && /[a-z]/i.test(value) && /\d/.test(value))
        && !(recognizedKey && /(?:real|prod)[-_].*(?:secret|token|key)|(?:secret|token|key)[-_].*(?:real|prod)/i.test(value))) continue
      return 'credential-value'
    }
  }
  return null
}

function assertNoHighConfidenceSecretsInTree(label, root, files) {
  for (const file of files) {
    const descriptor = fs.openSync(path.join(root, file.path), 'r')
    try {
      const chunk = Buffer.alloc(1024 * 1024)
      let carry = Buffer.alloc(0)
      let offset = 0
      while (offset < file.bytes) {
        const bytesRead = fs.readSync(descriptor, chunk, 0, chunk.length, offset)
        if (bytesRead === 0) break
        const content = Buffer.concat([carry, chunk.subarray(0, bytesRead)])
        const kind = highConfidenceSecretKind(content, { sourcePath: file.path })
        if (kind) throw new Error(`${label} contains ${kind}: ${file.path}`)
        carry = content.subarray(Math.max(0, content.length - 64 * 1024))
        offset += bytesRead
      }
    } finally {
      fs.closeSync(descriptor)
    }
  }
}

function collectRuntimeExternalPackageRoots(root, {
  parse = createRequire(path.join(root, 'package.json'))('@babel/parser').parse,
  traverse = require('@babel/traverse').default,
  sources,
} = {}) {
  const builtins = new Set([
    ...builtinModules,
    ...builtinModules.map((name) => `node:${name}`),
    'electron',
    'original-fs',
  ])
  const roots = new Set()
  const outputRoots = [path.join(root, 'out', 'main'), path.join(root, 'out', 'preload')]
  const packageRoot = (specifier) => specifier.startsWith('@')
    ? specifier.split('/').slice(0, 2).join('/')
    : specifier.split('/')[0]
  const collectSpecifier = (specifier) => {
    if (typeof specifier !== 'string' || specifier.startsWith('.') || specifier.startsWith('/')
      || builtins.has(specifier) || specifier.startsWith('node:')) return
    roots.add(packageRoot(specifier))
  }
  const sourceTexts = sources || outputRoots.flatMap((outputRoot) => {
    const texts = []
    const stack = [outputRoot]
    while (stack.length > 0) {
      const directory = stack.pop()
      for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
        const absolute = path.join(directory, entry.name)
        if (entry.isDirectory()) stack.push(absolute)
        else if (entry.isFile() && /\.(?:m?js)$/.test(entry.name)) texts.push(fs.readFileSync(absolute, 'utf8'))
      }
    }
    return texts
  })
  const asts = sourceTexts.map((text) => parse(text, {
    sourceType: 'unambiguous',
    plugins: ['dynamicImport', 'importAttributes'],
  }))
  for (const ast of asts) {
    for (const specifier of collectStaticModuleSpecifiers(ast, traverse)) collectSpecifier(specifier)
  }
  return [...roots].sort()
}

function collectStaticModuleSpecifiers(ast, traverse) {
  const found = []
  const staticValue = (argument) => {
    if (argument?.type === 'StringLiteral') return argument.value
    if (argument?.type === 'TemplateLiteral' && argument.expressions?.length === 0) {
      return argument.quasis?.[0]?.value?.cooked
    }
    return undefined
  }
  const importedCreateRequire = (binding) => binding?.path?.isImportSpecifier?.()
    && binding.path.node.imported?.name === 'createRequire'
    && binding.path.parentPath?.node?.source?.value === 'node:module'
  const isNativeRequire = (name, scope) => name === 'require' && !scope.getBinding(name)
  const isNodeModuleRequireCall = (node, scope) => node?.type === 'CallExpression'
    && node.callee?.type === 'Identifier'
    && isNativeRequire(node.callee.name, scope)
    && staticValue(node.arguments?.[0]) === 'node:module'
  const bindingIsNodeModuleObject = (binding) => {
    if (binding?.path?.isImportNamespaceSpecifier?.()) {
      return binding.path.parentPath?.node?.source?.value === 'node:module'
    }
    return binding?.path?.isVariableDeclarator?.()
      && isNodeModuleRequireCall(binding.path.node.init, binding.path.scope)
  }
  const bindingIsCreateRequire = (binding) => {
    if (importedCreateRequire(binding)) return true
    if (!binding?.path?.isVariableDeclarator?.()) return false
    const { id, init } = binding.path.node
    if (id?.type === 'ObjectPattern' && isNodeModuleRequireCall(init, binding.path.scope)) {
      return id.properties.some((property) => property.type === 'ObjectProperty'
        && property.key?.name === 'createRequire'
        && property.value?.name === binding.identifier?.name)
    }
    if (id?.type !== 'Identifier' || init?.type !== 'MemberExpression'
      || init.property?.name !== 'createRequire') return false
    return isNodeModuleRequireCall(init.object, binding.path.scope)
      || (init.object?.type === 'Identifier'
        && bindingIsNodeModuleObject(binding.path.scope.getBinding(init.object.name)))
  }
  const isCreateRequireCallee = (node, scope) => {
    if (node?.type === 'Identifier') return bindingIsCreateRequire(scope.getBinding(node.name))
    if (node?.type !== 'MemberExpression' || node.property?.name !== 'createRequire') return false
    return isNodeModuleRequireCall(node.object, scope)
      || (node.object?.type === 'Identifier'
        && bindingIsNodeModuleObject(scope.getBinding(node.object.name)))
  }
  const isCreateRequireCall = (node, scope) => {
    if (node?.type !== 'CallExpression') return false
    return isCreateRequireCallee(node.callee, scope)
  }
  const bindingIsRequireAlias = (binding) => binding?.path?.isVariableDeclarator?.()
    && isCreateRequireCall(binding.path.node.init, binding.path.scope)
  const isRequireIdentifier = (name, scope) => isNativeRequire(name, scope)
    || bindingIsRequireAlias(scope.getBinding(name))
  traverse(ast, {
    ImportDeclaration(nodePath) {
      found.push(nodePath.node.source.value)
    },
    ExportNamedDeclaration(nodePath) {
      if (nodePath.node.source?.value) found.push(nodePath.node.source.value)
    },
    ExportAllDeclaration(nodePath) {
      if (nodePath.node.source?.value) found.push(nodePath.node.source.value)
    },
    CallExpression(nodePath) {
      const { node, scope } = nodePath
      const callable = node.callee?.type === 'Import'
        || (node.callee?.type === 'Identifier' && isRequireIdentifier(node.callee.name, scope))
        || (node.callee?.type === 'MemberExpression'
          && ((node.callee.object?.type === 'Identifier'
            && isRequireIdentifier(node.callee.object.name, scope)
            && node.callee.property?.name === 'resolve')
            || (node.callee.object?.type === 'Identifier'
              && node.callee.object.name === 'module'
              && !scope.getBinding('module')
              && node.callee.property?.name === 'require')))
        || isCreateRequireCall(node.callee, scope)
      if (!callable) return
      const value = staticValue(node.arguments?.[0])
      if (typeof value === 'string') found.push(value)
    },
  })
  return found
}

function resolvePackagedRuntimeDependencyClosure(appExecutable, appAsar, roots, root) {
  const script = [
    "const fs=require('node:fs')",
    "const path=require('node:path')",
    "const {createRequire}=require('node:module')",
    'const archive=fs.realpathSync(process.argv[1])',
    "const queue=JSON.parse(process.argv[2]).map(name=>({name,parent:path.join(archive,'out/main/index.js'),optional:false}))",
    'const seen=new Set();const entries=[];const identities=[]',
    "const hostModules=new Set(['electron','original-fs'])",
    "const packagePath=name=>name.startsWith('@')?name.split('/').slice(0,2).join('/'):name.split('/')[0]",
    "const findManifest=(name,parent)=>{let cursor=path.dirname(parent);const relative=path.join('node_modules',packagePath(name),'package.json');while(cursor.startsWith(archive)){const candidate=path.join(cursor,relative);if(fs.existsSync(candidate))return candidate;const next=path.dirname(cursor);if(next===cursor)break;cursor=next}return null}",
    "const exportTarget=value=>{if(typeof value==='string')return value;if(Array.isArray(value)){for(const item of value){const target=exportTarget(item);if(target)return target}return null}if(!value||typeof value!=='object')return null;if(value['.'])return exportTarget(value['.']);for(const condition of ['node','import','require','default']){const target=exportTarget(value[condition]);if(target)return target}return null}",
    'while(queue.length){',
    'const item=queue.shift()',
    'if(hostModules.has(item.name))continue',
    "if(!/^(?:@[a-z0-9._-]+\\/)?[a-z0-9._-]+$/i.test(item.name))throw new Error('unsafe package name '+item.name)",
    'const req=createRequire(item.parent)',
    'let resolved;let manifestPath=null;try{resolved=req.resolve(item.name)}catch(error){manifestPath=findManifest(item.name,item.parent);if(!manifestPath){if(item.optional)continue;throw error}const fallbackPackage=JSON.parse(fs.readFileSync(manifestPath,\'utf8\'));const target=exportTarget(fallbackPackage.exports)||fallbackPackage.main;if(!target){if(item.optional)continue;throw error}const candidate=path.join(path.dirname(manifestPath),target);if(!fs.existsSync(candidate)||!fs.statSync(candidate).isFile()){if(item.optional)continue;throw error}resolved=candidate}',
    "if(!resolved.startsWith(archive+'/node_modules/')&&!resolved.startsWith(archive+'.unpacked/node_modules/'))throw new Error('package escaped app.asar '+item.name)",
    "let cursor=path.dirname(resolved);while(!manifestPath&&cursor.startsWith(archive)){const candidate=path.join(cursor,'package.json');if(fs.existsSync(candidate)){manifestPath=candidate;break}const parent=path.dirname(cursor);if(parent===cursor)break;cursor=parent}",
    "if(!manifestPath)throw new Error('package manifest missing for '+item.name)",
    'if(seen.has(manifestPath))continue;seen.add(manifestPath)',
    "identities.push('package:'+item.name+':'+manifestPath.slice(archive.length));entries.push(resolved.slice(archive.length).replace(/^\\.unpacked\\//,'').replace(/^\\//,''))",
    '}',
    "process.stdout.write(JSON.stringify({entries:[...new Set(entries)].sort(),identities:identities.sort()}))",
  ].join(';')
  const output = String(run(appExecutable, ['-e', script, appAsar, JSON.stringify(roots)], {
    root,
    capture: true,
    env: { ELECTRON_RUN_AS_NODE: '1' },
  })).trim()
  const resolved = JSON.parse(output)
  const asar = createRequire(path.join(root, 'package.json'))('@electron/asar')
  const parser = createRequire(path.join(root, 'package.json'))('@babel/parser')
  const traverse = createRequire(path.join(root, 'package.json'))('@babel/traverse').default
  const entrySet = new Set(asar.listPackage(appAsar).map((entry) => entry.replace(/^\//, '')))
  const visited = new Set()
  const queue = [...resolved.entries]
  const isPackagedFile = (candidate) => {
    if (!entrySet.has(candidate)) return false
    try {
      return !asar.statFile(appAsar, candidate).files
    } catch {
      return false
    }
  }
  const resolveRelative = (from, specifier) => {
    const base = path.posix.normalize(path.posix.join(path.posix.dirname(from), specifier))
    const candidates = [
      base,
      `${base}.js`, `${base}.cjs`, `${base}.mjs`, `${base}.json`, `${base}.node`,
      `${base}/index.js`, `${base}/index.cjs`, `${base}/index.mjs`, `${base}/index.json`, `${base}/index.node`,
    ]
    const manifestPath = `${base}/package.json`
    if (isPackagedFile(manifestPath)) {
      const manifest = JSON.parse(asar.extractFile(appAsar, manifestPath).toString('utf8'))
      if (typeof manifest.main === 'string') {
        const main = path.posix.normalize(path.posix.join(base, manifest.main))
        candidates.unshift(main, `${main}.js`, `${main}.cjs`, `${main}.mjs`, `${main}.json`, `${main}.node`)
      }
    }
    const matched = candidates.find(isPackagedFile)
    if (!matched) throw new Error(`missing packaged module ${specifier} from ${from}`)
    return matched
  }
  const staticRelativeSpecifiers = (source) => {
    const ast = parser.parse(source, {
      sourceType: 'unambiguous',
      plugins: ['dynamicImport', 'importAttributes'],
    })
    return collectStaticModuleSpecifiers(ast, traverse)
      .filter((specifier) => specifier.startsWith('.') || path.posix.isAbsolute(specifier))
  }
  while (queue.length > 0) {
    const file = queue.shift()
    if (visited.has(file)) continue
    visited.add(file)
    resolved.identities.push(`file:${file}`)
    if (!/[.](?:c?js|mjs)$/i.test(file)) continue
    const source = asar.extractFile(appAsar, file).toString('utf8')
    for (const specifier of staticRelativeSpecifiers(source)) {
      queue.push(resolveRelative(file, specifier))
    }
  }
  return [...new Set(resolved.identities)].sort()
}

function assertPackagedRuntimeDependencies(root, asarEntries, {
  sources,
  parse,
  resolveRuntimeClosure,
} = {}) {
  const roots = collectRuntimeExternalPackageRoots(root, { sources, parse })
  const entrySet = new Set(asarEntries)
  for (const dependency of roots) {
    if (!entrySet.has(`node_modules/${dependency}/package.json`)) {
      throw new Error(`packaged app is missing external runtime dependency: ${dependency}`)
    }
  }
  if (typeof resolveRuntimeClosure !== 'function') {
    throw new Error('packaged runtime dependency closure resolver is required')
  }
  const closure = resolveRuntimeClosure(roots)
  return {
    count: closure.length,
    digest: createHash('sha256').update(`${closure.join('\n')}\n`).digest('hex'),
    files: closure.filter((entry) => entry.startsWith('file:')).map((entry) => entry.slice(5)),
  }
}

function packagedSourceManifest(appAsar, root) {
  const asar = createRequire(path.join(root, 'package.json'))('@electron/asar')
  const relativePath = 'build/browser-live-proof/source-manifest.json'
  let contents
  try {
    contents = asar.extractFile(appAsar, relativePath)
  } catch {
    throw new Error(`packaged app.asar is missing ${relativePath}`)
  }
  const manifest = JSON.parse(contents.toString('utf8'))
  if (!manifest || typeof manifest.digest !== 'string' || typeof manifest.appVersion !== 'string') {
    throw new Error('packaged browser source manifest is invalid')
  }
  const expected = buildSourceManifest(root)
  if (JSON.stringify(manifest) !== JSON.stringify(expected)) {
    throw new Error('packaged browser source manifest does not match the current checkout')
  }
  return manifest
}

function sha256JsonLines(entries) {
  return createHash('sha256').update(entries.map((entry) => `${JSON.stringify(entry)}\n`).join('')).digest('hex')
}

function applicationInventory(appRoot) {
  const entries = []
  const visit = (directory) => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const absolute = path.join(directory, entry.name)
      const relative = path.relative(appRoot, absolute).split(path.sep).join('/')
      const stat = fs.lstatSync(absolute)
      if (stat.isSymbolicLink()) {
        resolvedInside(appRoot, absolute, `packaged application symlink ${relative}`)
        entries.push({ path: relative, type: 'symlink', target: fs.readlinkSync(absolute) })
      } else if (stat.isDirectory()) {
        visit(absolute)
      } else if (stat.isFile()) {
        const identity = captureRegularFile(absolute, appRoot)
        entries.push({ path: relative, type: 'file', mode: identity.mode, bytes: identity.bytes, sha256: identity.sha256 })
      }
    }
  }
  visit(appRoot)
  entries.sort((left, right) => left.path.localeCompare(right.path))
  return { digest: sha256JsonLines(entries), fileCount: entries.length }
}

function packagedOutputManifest(asar, appAsar, asarEntries) {
  const files = asarEntries.filter((entry) => (
    entry.startsWith('out/') && !asar.statFile(appAsar, entry).files
  )).map((entry) => {
    const content = asar.extractFile(appAsar, entry)
    return {
      path: entry,
      bytes: content.length,
      sha256: createHash('sha256').update(content).digest('hex'),
    }
  }).sort((left, right) => left.path.localeCompare(right.path))
  return {
    version: 1,
    digest: createHash('sha256')
      .update(files.map((file) => `${file.path}\0${file.bytes}\0${file.sha256}\n`).join(''))
      .digest('hex'),
    files,
  }
}

function inspectMountedPackage(root, contract, dmgPath, {
  inheritedDmgDescriptor,
  expectedUnpackedAppPath,
} = {}) {
  const mountPoint = fs.mkdtempSync(path.join(os.tmpdir(), 'ready-structural-dmg-'))
  const dmgInput = inheritedDmgDescriptor === undefined ? dmgPath : '/dev/fd/3'
  let mounted = false
  let result = null
  let inspectionError = null
  let detachError = null
  try {
    run('hdiutil', ['verify', dmgInput], { root, inheritedDescriptor: inheritedDmgDescriptor })
    if (inheritedDmgDescriptor === undefined) {
      run('hdiutil', ['attach', '-nobrowse', '-readonly', '-mountpoint', mountPoint, dmgInput], { root })
    } else {
      try {
        run('diskutil', [
          'image', 'attach', '--mountOptions', 'nobrowse', '--readOnly', '--mountPoint', mountPoint, dmgInput,
        ], { root, inheritedDescriptor: inheritedDmgDescriptor })
      } catch {
        run('hdiutil', ['attach', '-nobrowse', '-readonly', '-mountpoint', mountPoint, dmgInput], {
          root,
          inheritedDescriptor: inheritedDmgDescriptor,
        })
      }
    }
    mounted = true

    const allowedDmgRootEntries = new Set([
      '.background.tiff', '.DS_Store', '.VolumeIcon.icns',
      'Applications', `${contract.productName}.app`,
    ])
    for (const entry of fs.readdirSync(mountPoint)) {
      if (!allowedDmgRootEntries.has(entry)) throw new Error(`mounted DMG has unexpected root entry: ${entry}`)
    }

    const appPath = path.join(mountPoint, `${contract.productName}.app`)
    const contents = path.join(appPath, 'Contents')
    const resources = path.join(contents, 'Resources')
    const applicationsLink = path.join(mountPoint, 'Applications')
    const infoPlist = path.join(contents, 'Info.plist')
    assertPathChain(mountPoint, appPath)
    assertPathChain(appPath, contents)
    assertPathChain(appPath, resources)
    assertPathChain(appPath, infoPlist)
    const bundleExecutable = scalarPlistValue(infoPlist, 'CFBundleExecutable', root)
    if (bundleExecutable !== contract.productName || path.basename(bundleExecutable) !== bundleExecutable) {
      throw new Error(`packaged launch executable mismatch: ${bundleExecutable}`)
    }
    const appExecutable = path.join(contents, 'MacOS', bundleExecutable)
    const appAsar = path.join(resources, 'app.asar')
    const runtimeDir = path.join(resources, 'codex-runtime')
    const packagedRuntimeManifest = path.join(runtimeDir, 'runtime-manifest.json')
    const codexBinary = path.join(runtimeDir, 'aarch64-apple-darwin', 'codex')

    if (!fs.existsSync(appPath)) throw new Error('mounted DMG is missing Ready.app')
    if (!fs.lstatSync(applicationsLink).isSymbolicLink()
      || fs.readlinkSync(applicationsLink) !== '/Applications') {
      throw new Error('mounted DMG is missing the /Applications link')
    }
    run('codesign', ['--verify', '--deep', '--strict', '--verbose=1', appPath], { root })
    assertAdHocSignature(appPath, root)
    assertNoSensitiveFilesUnder(appPath)

    for (const targetPath of [appExecutable, appAsar, packagedRuntimeManifest, codexBinary]) {
      assertPathChain(appPath, targetPath)
    }

    const appVersion = scalarPlistValue(infoPlist, 'CFBundleShortVersionString', root)
    const bundleVersion = scalarPlistValue(infoPlist, 'CFBundleVersion', root)
    if (appVersion !== contract.appVersion || bundleVersion !== contract.appVersion) {
      throw new Error(`packaged app version mismatch: ${appVersion}/${bundleVersion}`)
    }

    const seedPath = path.join(resources, 'ai-settings.seed.json')
    assertPathChain(appPath, seedPath)
    const seed = JSON.parse(fs.readFileSync(seedPath, 'utf8'))
    if (!seed || Array.isArray(seed) || Object.keys(seed).length !== 0) {
      throw new Error('packaged AI settings seed is not empty')
    }
    const skillRuntimePath = path.join(resources, 'skill-runtime')
    try {
      fs.lstatSync(skillRuntimePath)
      throw new Error('slim package unexpectedly contains skill-runtime')
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error
    }

    const sourceManifestPath = path.join(root, RUNTIME_MANIFEST_REL)
    if (sha256File(packagedRuntimeManifest) !== sha256File(sourceManifestPath)) {
      throw new Error('packaged Codex runtime manifest differs from the verified source manifest')
    }
    const runtimeManifest = JSON.parse(fs.readFileSync(packagedRuntimeManifest, 'utf8'))
    const codexIdentity = captureRegularFile(codexBinary, appPath)
    if ((fs.statSync(codexBinary).mode & 0o111) === 0) {
      throw new Error('packaged Codex runtime is not executable')
    }
    if (codexIdentity.bytes !== runtimeManifest.binarySizeBytes
      || codexIdentity.sha256 !== runtimeManifest.binarySha256) {
      throw new Error('packaged Codex runtime binary does not match its manifest')
    }
    const codexArchitecture = singleArchitecture(codexBinary, root, 'packaged Codex runtime')
    if (codexArchitecture !== contract.arch || runtimeManifest.architecture !== contract.arch) {
      throw new Error(`packaged Codex architecture mismatch: ${codexArchitecture}`)
    }
    const codexVersionOutput = String(run(codexBinary, ['--version'], { root, capture: true })).trim()
    if (codexVersionOutput !== `codex-cli ${runtimeManifest.codexVersion}`) {
      throw new Error('packaged Codex runtime version does not match its manifest')
    }

    const appArchitecture = singleArchitecture(appExecutable, root, 'packaged app executable')
    if (appArchitecture !== contract.arch) {
      throw new Error(`packaged app architecture mismatch: ${appArchitecture}`)
    }
    const appExecutableIdentity = captureRegularFile(appExecutable, appPath)
    const appAsarIdentity = captureRegularFile(appAsar, appPath)
    const browserSourceManifest = packagedSourceManifest(appAsar, root)
    const asar = createRequire(path.join(root, 'package.json'))('@electron/asar')
    const asarEntries = asar.listPackage(appAsar)
      .map((entry) => entry.replace(/^\//, ''))
    const liveProofEntries = asarEntries.filter((entry) => (
      entry.startsWith('build/browser-live-proof/')
    ))
    if (liveProofEntries.length !== 1
      || liveProofEntries[0] !== 'build/browser-live-proof/source-manifest.json') {
      throw new Error('packaged browser live-proof carrier contains unexpected entries')
    }
    for (const requiredEntry of [
      'out/main/index.js',
      'out/preload/index.mjs',
      'out/renderer/index.html',
      'build/browser-live-proof/source-manifest.json',
    ]) {
      if (!asarEntries.includes(requiredEntry)) throw new Error(`packaged app.asar is missing ${requiredEntry}`)
    }
    assertNoSensitivePayload('packaged app-owned payload', asarEntries.map((entry) => ({ path: entry })))
    const packagedFiles = asarEntries.filter((entry) => !asar.statFile(appAsar, entry).files)
    const packagedRuntimeSources = packagedFiles
      .filter((entry) => /^(?:out\/main|out\/preload)\/.*\.(?:m?js)$/.test(entry))
      .map((entry) => asar.extractFile(appAsar, entry).toString('utf8'))
    const runtimeDependencies = assertPackagedRuntimeDependencies(root, asarEntries, {
      sources: packagedRuntimeSources,
      resolveRuntimeClosure: (roots) => resolvePackagedRuntimeDependencyClosure(
        appExecutable, appAsar, roots, root,
      ),
    })
    const actualOutputManifest = packagedOutputManifest(asar, appAsar, asarEntries)
    if (expectedUnpackedAppPath) {
      const expectedOutputManifest = buildOutputManifest(root)
      if (JSON.stringify(actualOutputManifest) !== JSON.stringify(expectedOutputManifest)) {
        throw new Error('packaged app output does not match the isolated build output')
      }
    }
    const packagedPackageJson = asar.extractFile(appAsar, 'package.json')
    const sourcePackage = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'))
    assertPackagedPackageJsonMatchesSource(packagedPackageJson, sourcePackage)

    const resourceInventories = []
    const resourceContracts = [
      ['assets/codex-runtime', 'codex-runtime', (name) => !/^evidence(?:\/|$)/i.test(name), 'Codex runtime assets', new Set(['aarch64-apple-darwin/codex'])],
      ['assets/embedded-skills', 'embedded-skills', (name) => !/__pycache__|\.py[co]$|(?:^|\/)\.env(?:\.|$)/i.test(name), 'embedded skills'],
      ['assets/pets', 'pets', () => true, 'pets'],
      ['assets/prompts', 'prompts', () => true, 'prompts'],
      ['assets/site-cards', 'site-cards', () => true, 'site cards'],
      ['src/python', 'sidecar', (name) => !/__pycache__|\.py[co]$/i.test(name), 'Python sidecar'],
    ]
    for (const [sourceRel, mountedRel, filter, label, allowedMountedExtras] of resourceContracts) {
      const files = assertResourceTree(
        path.join(root, sourceRel),
        path.join(resources, mountedRel),
        { filter, label, allowedMountedExtras },
      )
      assertNoSensitivePayload(label, files)
      resourceInventories.push({ label, fileCount: files.length })
    }
    const rssSource = path.join(root, 'src/main/modules/rss-engine/rsshub-worker.mjs')
    const rssMounted = path.join(resources, 'rsshub-worker.mjs')
    if (!sameFileIdentity(
      captureRegularFile(rssSource, root),
      captureRegularFile(rssMounted, appPath),
    )) throw new Error('packaged RSS worker does not match source')
    const unexpectedCredentialCarrier = relativeFileInventory(resources)
      .find((file) => isSensitivePayloadPath(file.path))
    if (unexpectedCredentialCarrier) {
      throw new Error(`packaged resources contain forbidden credential carrier: ${unexpectedCredentialCarrier.path}`)
    }

    const electronFrameworkDir = path.join(contents, 'Frameworks', 'Electron Framework.framework')
    const electronFramework = resolvedInside(
      appPath,
      path.join(electronFrameworkDir, 'Versions', 'Current', 'Electron Framework'),
      'Electron Framework',
    )
    const electronInfoPlist = resolvedInside(
      appPath,
      path.join(electronFrameworkDir, 'Resources', 'Info.plist'),
      'Electron Framework Info.plist',
    )
    const electronVersion = scalarPlistValue(electronInfoPlist, 'CFBundleVersion', root)
    if (electronVersion !== lockVersion(root, 'electron')) {
      throw new Error(`packaged Electron version mismatch: ${electronVersion}`)
    }
    const electronArchitecture = singleArchitecture(electronFramework, root, 'packaged Electron Framework')
    if (electronArchitecture !== contract.arch) {
      throw new Error(`packaged Electron architecture mismatch: ${electronArchitecture}`)
    }
    const electronFrameworkIdentity = captureRegularFile(electronFramework, appPath)

    const sqliteUnpacked = path.join(
      resources,
      'app.asar.unpacked',
      'node_modules',
      'better-sqlite3',
      'build',
      'Release',
      'better_sqlite3.node',
    )
    const sqliteResource = path.join(
      resources,
      'better-sqlite3',
      'build',
      'Release',
      'better_sqlite3.node',
    )
    for (const sqlitePath of [sqliteUnpacked, sqliteResource]) {
      assertPathChain(appPath, sqlitePath)
      if (singleArchitecture(sqlitePath, root, 'packaged better-sqlite3') !== contract.arch) {
        throw new Error('packaged better-sqlite3 architecture mismatch')
      }
      run(appExecutable, [
        '-e',
        "require(process.argv[1]); process.stdout.write('sqlite-native-ok')",
        sqlitePath,
      ], {
        root,
        capture: true,
        env: { ELECTRON_RUN_AS_NODE: '1' },
      })
    }
    const sqliteUnpackedIdentity = captureRegularFile(sqliteUnpacked, appPath)
    const sqliteResourceIdentity = captureRegularFile(sqliteResource, appPath)
    if (!sameFileIdentity(sqliteUnpackedIdentity, sqliteResourceIdentity)) {
      throw new Error('packaged better-sqlite3 copies do not match')
    }
    const sqliteSmoke = String(run(appExecutable, [
      '-e',
      [
        "const DB=require(process.argv[1])",
        "const db=new DB(':memory:')",
        "db.exec('CREATE TABLE t(v INTEGER); INSERT INTO t VALUES (7)')",
        "if(db.prepare('SELECT v FROM t').get().v!==7)process.exit(9)",
        'db.close()',
        "process.stdout.write('sqlite-wrapper-ok')",
      ].join(';'),
      path.join(resources, 'app.asar', 'node_modules', 'better-sqlite3'),
    ], {
      root,
      capture: true,
      env: { ELECTRON_RUN_AS_NODE: '1' },
    })).trim()
    if (sqliteSmoke !== 'sqlite-wrapper-ok') throw new Error('packaged better-sqlite3 wrapper smoke failed')

    const mountedApplicationInventory = applicationInventory(appPath)
    if (expectedUnpackedAppPath) {
      const expectedApplicationInventory = applicationInventory(expectedUnpackedAppPath)
      if (JSON.stringify(mountedApplicationInventory) !== JSON.stringify(expectedApplicationInventory)) {
        throw new Error('mounted application does not match the isolated packaged application')
      }
    }

    result = {
      signature: 'verified',
      signingIdentity: 'ad-hoc-local',
      dmg: 'verified',
      mount: 'read-only',
      applicationsLink: '/Applications',
      aiSeed: 'empty-object',
      packageShape: 'slim',
      architecture: appArchitecture,
      appVersion,
      bundleVersion,
      appExecutableSha256: appExecutableIdentity.sha256,
      appExecutableBytes: appExecutableIdentity.bytes,
      appAsarSha256: appAsarIdentity.sha256,
      appAsarBytes: appAsarIdentity.bytes,
      applicationInventoryDigest: mountedApplicationInventory.digest,
      applicationInventoryFileCount: mountedApplicationInventory.fileCount,
      browserSourceManifestDigest: browserSourceManifest.digest,
      browserSourceManifestVersion: browserSourceManifest.version,
      outputManifestDigest: actualOutputManifest.digest,
      outputManifestFileCount: actualOutputManifest.files.length,
      packageJsonSha256: createHash('sha256').update(packagedPackageJson).digest('hex'),
      asarRequiredEntrypoints: 'verified',
      resourceInventories,
      sensitivePayloadScan: 'verified',
      sensitiveContentScan: 'not-in-structural-scope',
      runtimeDependencyRootCount: runtimeDependencies.count,
      runtimeDependencyRootDigest: runtimeDependencies.digest,
      electronVersion,
      electronArchitecture,
      electronFrameworkSha256: electronFrameworkIdentity.sha256,
      electronFrameworkBytes: electronFrameworkIdentity.bytes,
      betterSqliteVersion: lockVersion(root, 'better-sqlite3'),
      betterSqliteSha256: sqliteUnpackedIdentity.sha256,
      betterSqliteBytes: sqliteUnpackedIdentity.bytes,
      betterSqliteNativeSmoke: 'verified',
      codexBinarySha256: codexIdentity.sha256,
      codexBinaryBytes: codexIdentity.bytes,
      codexVersion: runtimeManifest.codexVersion,
      codexArchitecture,
      runtimeManifestSha256: sha256File(packagedRuntimeManifest),
    }
  } catch (error) {
    inspectionError = error
  } finally {
    if (mounted) {
      const result = spawnSync(SYSTEM_TOOLS.hdiutil, ['detach', mountPoint, '-quiet'], {
        stdio: 'ignore',
        env: structuralEnvironment(),
      })
      if (result.status !== 0) detachError = new Error('failed to detach verified DMG mount')
    }
    fs.rmSync(mountPoint, { recursive: true, force: true })
  }
  if (inspectionError) throw inspectionError
  if (detachError) throw detachError
  if (!result) throw new Error('mounted package inspection produced no result')
  return result
}

function assertPackagedPackageJsonMatchesSource(packagedPackageJson, sourcePackage) {
  const packagedPackage = JSON.parse(Buffer.isBuffer(packagedPackageJson)
    ? packagedPackageJson.toString('utf8')
    : String(packagedPackageJson))
  for (const key of [
    'name', 'version', 'description', 'main', 'author', 'license', 'private', 'type', 'dependencies', 'engines',
  ]) {
    if (sourcePackage[key] === undefined) continue
    if (JSON.stringify(packagedPackage[key]) !== JSON.stringify(sourcePackage[key])) {
      throw new Error(`packaged package.json field does not match the isolated source: ${key}`)
    }
  }
}

function assertStableIdentity(label, before, after) {
  if (!sameFileIdentity(before, after)) {
    throw new Error(`${label} changed while structural verification was running`)
  }
}

function verifyAndWriteReceipt({
  root = ROOT,
  expectedSourceDigest,
  sourceManifest = buildReleaseSourceManifest,
  contractFactory = packagingContract,
  inspectPackage = inspectMountedPackage,
  captureIdentity = captureRegularFile,
  now = () => new Date().toISOString(),
  createReceiptId = randomUUID,
  receiptWriter = (request) => execFileSync('/usr/bin/python3', [
    path.join(__dirname, 'release-output-transaction.py'),
  ], {
    input: JSON.stringify(request),
    encoding: 'utf8',
    env: structuralEnvironment(),
  }),
  toolchain = {
    node: process.version,
    npm: String(run('npm', ['--version'], { root, capture: true })).trim(),
    platform: process.platform,
    architecture: process.arch,
  },
} = {}) {
  const contract = contractFactory(root)
  const source = sourceManifest(root)
  if (expectedSourceDigest && source.digest !== expectedSourceDigest) {
    throw new Error('source tree changed while structural package verification was running')
  }
  const artifactPath = path.join(root, contract.artifactRel)
  const runtimeManifestPath = path.join(root, RUNTIME_MANIFEST_REL)
  const artifactBefore = captureIdentity(artifactPath, root)
  const runtimeBefore = captureIdentity(runtimeManifestPath, root)
  if (artifactBefore.bytes >= MAX_SLIM_DMG_BYTES) {
    throw new Error(`slim DMG exceeds 350 MiB: ${artifactBefore.bytes} bytes`)
  }

  const snapshotDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'ready-structural-inspect-'))
  const artifactSnapshot = path.join(snapshotDirectory, path.basename(artifactPath))
  let verification
  let snapshotDescriptor = null
  try {
    fs.copyFileSync(artifactPath, artifactSnapshot, fs.constants.COPYFILE_EXCL)
    snapshotDescriptor = fs.openSync(artifactSnapshot, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0))
    const snapshotIdentity = captureOpenDescriptor(snapshotDescriptor)
    assertStableIdentity('packaged DMG snapshot', artifactBefore, snapshotIdentity)
    const expectedUnpackedAppPath = contract.outputDir && contract.productName
      ? path.join(root, contract.outputDir, 'mac-arm64', `${contract.productName}.app`)
      : undefined
    verification = inspectPackage(root, contract, '/dev/fd/3', {
      inheritedDmgDescriptor: snapshotDescriptor,
      expectedUnpackedAppPath,
    })
    const snapshotAfter = captureOpenDescriptor(snapshotDescriptor)
    assertStableIdentity('packaged DMG snapshot', snapshotIdentity, snapshotAfter)
    const artifactAfter = captureIdentity(artifactPath, root)
    const runtimeAfter = captureIdentity(runtimeManifestPath, root)
    assertStableIdentity('packaged DMG', artifactBefore, artifactAfter)
    assertStableIdentity('runtime manifest', runtimeBefore, runtimeAfter)
    if (verification.runtimeManifestSha256 !== runtimeBefore.sha256) {
      throw new Error('mounted runtime manifest does not match the inspected source manifest')
    }
    const sourceAfter = sourceManifest(root)
    if (sourceAfter.digest !== source.digest || sourceAfter.head !== source.head
      || sourceAfter.branch !== source.branch || sourceAfter.files.length !== source.files.length
      || sourceAfter.version !== source.version) {
      throw new Error('source tree changed while structural package verification was running')
    }
  } finally {
    if (snapshotDescriptor !== null) fs.closeSync(snapshotDescriptor)
    fs.rmSync(snapshotDirectory, { recursive: true, force: true })
  }

  const receipt = {
    schemaVersion: 2,
    receiptId: createReceiptId(),
    status: 'STRUCTURAL_PACKAGE_PASS',
    liveAcceptance: 'DEFERRED',
    distributionEligible: false,
    signingIdentity: verification.signingIdentity,
    createdAt: now(),
    appVersion: contract.appVersion,
    source: {
      head: source.head,
      branch: source.branch,
      digest: source.digest,
      fileCount: source.files.length,
      manifestVersion: source.version,
    },
    runtimeManifestSha256: runtimeBefore.sha256,
    toolchain,
    artifact: {
      path: contract.artifactRel,
      bytes: artifactBefore.bytes,
      sha256: artifactBefore.sha256,
      architecture: contract.arch,
      packageShape: 'slim',
    },
    verification,
  }
  const receiptPath = path.join(root, receiptRelForArtifactSha(artifactBefore.sha256))
  const receiptText = `${JSON.stringify(receipt, null, 2)}\n`
  const receiptStagingDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'ready-structural-receipt-'))
  const stagedReceipt = path.join(receiptStagingDirectory, path.basename(receiptPath))
  try {
    fs.writeFileSync(stagedReceipt, receiptText, { mode: 0o644, flag: 'wx' })
    const receiptIdentity = captureRegularFile(stagedReceipt, receiptStagingDirectory)
    const receiptRel = path.relative(root, receiptPath).split(path.sep).join('/')
    receiptWriter({
      action: 'write-receipt',
      root: fs.realpathSync(root),
      receiptSource: stagedReceipt,
      receiptDirectory: path.posix.dirname(receiptRel),
      receiptLeaf: path.posix.basename(receiptRel),
      receiptIdentity: { bytes: receiptIdentity.bytes, sha256: receiptIdentity.sha256 },
    })
  } finally {
    fs.rmSync(receiptStagingDirectory, { recursive: true, force: true })
  }
  return receipt
}

function verifyExistingStructuralReceipt({
  root = ROOT,
  inspectPackage = inspectMountedPackage,
  captureIdentity = captureRegularFile,
  receiptLoader = loadVerifiedStructuralReceipt,
  sourceManifest = buildReleaseSourceManifest,
  copyFile = fs.copyFileSync,
} = {}) {
  const loaded = receiptLoader(root)
  if (!loaded.ok) throw new Error(loaded.errors.join('; '))
  const artifactBefore = captureIdentity(loaded.artifactPath, root)
  const runtimePath = path.join(root, RUNTIME_MANIFEST_REL)
  const runtimeBefore = captureIdentity(runtimePath, root)
  if (!sameFileIdentity(artifactBefore, loaded.receipt.artifact)) {
    throw new Error('packaged DMG no longer matches the structural receipt before readback')
  }
  if (runtimeBefore.sha256 !== loaded.receipt.runtimeManifestSha256) {
    throw new Error('runtime manifest no longer matches the structural receipt before readback')
  }
  const snapshotDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'ready-structural-recheck-'))
  const artifactSnapshot = path.join(snapshotDirectory, path.basename(loaded.artifactPath))
  let snapshotDescriptor = null
  try {
    copyFile(loaded.artifactPath, artifactSnapshot, fs.constants.COPYFILE_EXCL)
    snapshotDescriptor = fs.openSync(artifactSnapshot, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0))
    const snapshotBefore = captureOpenDescriptor(snapshotDescriptor)
    assertStableIdentity('packaged DMG snapshot', artifactBefore, snapshotBefore)
    const verification = inspectPackage(root, loaded.contract, '/dev/fd/3', {
      inheritedDmgDescriptor: snapshotDescriptor,
    })
    const snapshotAfter = captureOpenDescriptor(snapshotDescriptor)
    const artifactAfter = captureIdentity(loaded.artifactPath, root)
    const runtimeAfter = captureIdentity(runtimePath, root)
    assertStableIdentity('packaged DMG snapshot', snapshotBefore, snapshotAfter)
    assertStableIdentity('packaged DMG', artifactBefore, artifactAfter)
    assertStableIdentity('runtime manifest', runtimeBefore, runtimeAfter)
    if (JSON.stringify(verification) !== JSON.stringify(loaded.receipt.verification)) {
      throw new Error('mounted package readback no longer matches the structural receipt')
    }
    const sourceAfter = sourceManifest(root)
    const sourceBefore = loaded.currentSource
    if (!sourceBefore
      || sourceAfter.version !== sourceBefore.version
      || sourceAfter.head !== sourceBefore.head
      || sourceAfter.branch !== sourceBefore.branch
      || sourceAfter.appVersion !== sourceBefore.appVersion
      || sourceAfter.digest !== sourceBefore.digest
      || sourceAfter.files.length !== sourceBefore.files.length) {
      throw new Error('source tree changed while existing structural package was being revalidated')
    }
  } finally {
    if (snapshotDescriptor !== null) fs.closeSync(snapshotDescriptor)
    fs.rmSync(snapshotDirectory, { recursive: true, force: true })
  }
  return loaded.receipt
}

function main() {
  try {
    const existingOnly = process.argv.includes('--existing')
    const receipt = existingOnly
      ? verifyExistingStructuralReceipt()
      : verifyAndWriteReceipt({
        expectedSourceDigest: String(process.env.READY_RELEASE_SOURCE_DIGEST || '').trim() || undefined,
      })
    console.log('[release-structural-package] STRUCTURAL_PACKAGE_PASS')
    console.log(`[release-structural-package] ${existingOnly ? 'EXISTING_PACKAGE_REVERIFIED' : 'LIVE_ACCEPTANCE_DEFERRED'}`)
    console.log(`  artifact: ${receipt.artifact.path}`)
    console.log(`  sha256: ${receipt.artifact.sha256}`)
    return 0
  } catch (error) {
    console.error(`[release-structural-package] FAIL: ${error instanceof Error ? error.message : String(error)}`)
    return 1
  }
}

if (require.main === module) process.exit(main())

module.exports = {
  MAX_SLIM_DMG_BYTES,
  inspectMountedPackage,
  assertPackagedPackageJsonMatchesSource,
  assertPackagedRuntimeDependencies,
  assertResourceTree,
  assertNoHighConfidenceSecretsInTree,
  collectRuntimeExternalPackageRoots,
  highConfidenceSecretKind,
  isSensitivePayloadPath,
  resolvePackagedRuntimeDependencyClosure,
  verifyAndWriteReceipt,
  verifyExistingStructuralReceipt,
}
