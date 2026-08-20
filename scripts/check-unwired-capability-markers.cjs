#!/usr/bin/env node
const fs = require('node:fs')
const path = require('node:path')

const REPO_ROOT = path.resolve(__dirname, '..')

// Dynamic Delivery was retired from the Codex production graph by E1. Its
// historical packet modules are not listed here because this registry only
// governs the older P5c unwired cluster; the Codex retirement boundary has a
// dedicated negative gate.
const UNWIRED_PACKET_FILES = Object.freeze([])

const UNWIRED_MAINTENANCE_FILES = Object.freeze([])

const LIVE_PACKET_FIELDS_REL = 'src/main/modules/agent-control/quality/packet-fields.ts'
const P5C_DOC_REL = 'docs/superpowers/plans/2026-06-20-p5c-packet-trio-disabled-implementation.md'
const P5D_DOC_REL = 'docs/superpowers/plans/2026-06-20-p5d-maintenance-emergence-status-implementation.md'
const DOC_REL = P5C_DOC_REL

const INTRA_CLUSTER_ALLOW = Object.freeze([
  [
    'src/main/modules/agent-control/quality/packet-failure.ts',
    'src/main/modules/agent-control/quality/packet-compiler.ts',
  ],
  [
    'src/main/modules/agent-control/quality/packet-dispatch.ts',
    'src/main/modules/agent-control/quality/packet-compiler.ts',
  ],
])

function normalizeRel(file) {
  return file.split(path.sep).join('/')
}

function read(root, rel) {
  return fs.readFileSync(path.join(root, rel), 'utf8')
}

function walk(dir, out = []) {
  if (!fs.existsSync(dir)) return out
  for (const entry of fs.readdirSync(dir)) {
    const abs = path.join(dir, entry)
    const stat = fs.statSync(abs)
    if (stat.isDirectory()) {
      walk(abs, out)
      continue
    }
    if (/\.(ts|tsx|js|cjs|mjs)$/.test(entry)) out.push(abs)
  }
  return out
}

function isTestRel(rel) {
  return rel.includes('/__tests__/') || /\.test\.[^.]+$/.test(rel) || rel.startsWith('scripts/__tests__/')
}

function isAllowedIntraCluster(fromRel, toRel) {
  return INTRA_CLUSTER_ALLOW.some(([from, to]) => from === fromRel && to === toRel)
}

function candidateRelativeTargets(root, fromAbs, specifier) {
  if (!specifier.startsWith('.')) return []
  const base = path.resolve(path.dirname(fromAbs), specifier)
  const candidates = [
    base,
    `${base}.ts`,
    `${base}.tsx`,
    `${base}.js`,
    `${base}.cjs`,
    `${base}.mjs`,
    path.join(base, 'index.ts'),
    path.join(base, 'index.tsx'),
    path.join(base, 'index.js'),
  ]
  return candidates.map((abs) => normalizeRel(path.relative(root, abs)))
}

function extractSpecifiers(source) {
  const specs = []
  const patterns = [
    /\bimport\s+(?:type\s+)?(?:[^'"]+\s+from\s+)?['"]([^'"]+)['"]/g,
    /\bexport\s+(?:type\s+)?[^'"]+\s+from\s+['"]([^'"]+)['"]/g,
    /\brequire\s*\(\s*['"]([^'"]+)['"]\s*\)/g,
    /\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)/g,
  ]
  for (const pattern of patterns) {
    let match
    while ((match = pattern.exec(source))) specs.push(match[1])
  }
  return specs
}

function check({ root = REPO_ROOT } = {}) {
  const errors = []
  const unwiredSet = new Set([...UNWIRED_PACKET_FILES, ...UNWIRED_MAINTENANCE_FILES])

  if (unwiredSet.has(LIVE_PACKET_FIELDS_REL)) {
    errors.push(`${LIVE_PACKET_FIELDS_REL} must not be in an unwired capability list.`)
  }

  for (const rel of UNWIRED_PACKET_FILES) {
    const abs = path.join(root, rel)
    if (!fs.existsSync(abs)) {
      errors.push(`missing unwired packet file: ${rel}`)
      continue
    }
    const source = fs.readFileSync(abs, 'utf8')
    if (!/unwired/i.test(source) || !/not in production path/i.test(source)) {
      errors.push(`${rel} must contain P5c/C22 markers "unwired" and "not in production path".`)
    }
  }

  for (const rel of UNWIRED_MAINTENANCE_FILES) {
    const abs = path.join(root, rel)
    if (!fs.existsSync(abs)) {
      errors.push(`missing unwired maintenance/emergence file: ${rel}`)
      continue
    }
    const source = fs.readFileSync(abs, 'utf8')
    if (!/unwired/i.test(source) || !/not in production driver path/i.test(source)) {
      errors.push(`${rel} must contain P5d/C26 markers "unwired" and "not in production driver path".`)
    }
  }

  const packetFieldsAbs = path.join(root, LIVE_PACKET_FIELDS_REL)
  if (fs.existsSync(packetFieldsAbs)) {
    const packetFields = fs.readFileSync(packetFieldsAbs, 'utf8')
    if (/unwired/i.test(packetFields) && /not in production path/i.test(packetFields)) {
      errors.push(`${LIVE_PACKET_FIELDS_REL} is live validation code and must not carry unwired/not-in-production markers.`)
    }
  }

  const docRules = [
    { rel: P5D_DOC_REL, label: 'P5d', phrase: '自动模型维护回合已退役' },
  ]
  for (const rule of docRules) {
    const docAbs = path.join(root, rule.rel)
    if (!fs.existsSync(docAbs)) {
      errors.push(`missing ${rule.label} enforce doc: ${rule.rel}`)
      continue
    }
    const doc = fs.readFileSync(docAbs, 'utf8')
    if (!doc.includes(rule.phrase)) {
      errors.push(`${rule.rel} must explicitly state "${rule.phrase}".`)
    }
  }

  const srcMain = path.join(root, 'src/main')
  for (const abs of walk(srcMain)) {
    const fromRel = normalizeRel(path.relative(root, abs))
    if (isTestRel(fromRel)) continue
    const source = fs.readFileSync(abs, 'utf8')
    for (const specifier of extractSpecifiers(source)) {
      const targets = candidateRelativeTargets(root, abs, specifier)
      const targetRel = targets.find((candidate) => unwiredSet.has(candidate))
      if (!targetRel) continue
      if (fromRel === targetRel) continue
      if (isAllowedIntraCluster(fromRel, targetRel)) continue
      errors.push(`${fromRel} must not import unwired module ${targetRel}.`)
    }
  }

  return { ok: errors.length === 0, errors }
}

if (require.main === module) {
  const result = check()
  if (!result.ok) {
    console.error('[check-unwired-capability-markers] failed')
    for (const error of result.errors) console.error(`- ${error}`)
    process.exit(1)
  }
  console.log('[check-unwired-capability-markers] ok')
}

module.exports = {
  check,
  UNWIRED_PACKET_FILES,
  UNWIRED_MAINTENANCE_FILES,
  LIVE_PACKET_FIELDS_REL,
  INTRA_CLUSTER_ALLOW,
  DOC_REL,
  P5C_DOC_REL,
  P5D_DOC_REL,
}
