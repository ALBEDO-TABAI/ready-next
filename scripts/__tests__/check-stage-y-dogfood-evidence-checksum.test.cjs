'use strict'

const assert = require('node:assert/strict')
const crypto = require('node:crypto')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { test } = require('node:test')

const {
  CHECKSUM_JSON_REL,
  CHECKSUM_TXT_REL,
  validateChecksumBundle,
} = require('../check-stage-y-dogfood-evidence.cjs')

function sha256(text) {
  return crypto.createHash('sha256').update(Buffer.from(text)).digest('hex')
}

function makeRoot() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ready-stage-y-checksum-'))
  fs.mkdirSync(path.dirname(path.join(root, CHECKSUM_JSON_REL)), { recursive: true })
  fs.writeFileSync(path.join(root, CHECKSUM_JSON_REL), '{}\n')
  return root
}

test('validateChecksumBundle accepts matching repository-relative checksum entries', () => {
  const root = makeRoot()
  const rel = 'docs/superpowers/audits/2026-05-23-stage-y-closeout/dogfood/evidence/sample.txt'
  fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true })
  fs.writeFileSync(path.join(root, rel), 'sample evidence\n')
  fs.writeFileSync(path.join(root, CHECKSUM_TXT_REL), `${sha256('sample evidence\n')}  ${rel}\n`)

  const result = validateChecksumBundle(root)

  assert.equal(result.ok, true)
  assert.deepEqual(result.errors, [])
  assert.match(result.notes.join('\n'), /validated 1 checksum entry/)
})

test('validateChecksumBundle rejects stale checksum entries', () => {
  const root = makeRoot()
  const rel = 'docs/superpowers/audits/2026-05-23-stage-y-closeout/dogfood/evidence/sample.txt'
  fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true })
  fs.writeFileSync(path.join(root, rel), 'new evidence\n')
  fs.writeFileSync(path.join(root, CHECKSUM_TXT_REL), `${sha256('old evidence\n')}  ${rel}\n`)

  const result = validateChecksumBundle(root)

  assert.equal(result.ok, false)
  assert.match(result.errors.join('\n'), /sha256 mismatch/)
  assert.match(result.errors.join('\n'), /sample\.txt/)
})

test('validateChecksumBundle rejects a missing companion checksum file', () => {
  const root = makeRoot()

  const result = validateChecksumBundle(root)

  assert.equal(result.ok, false)
  assert.match(result.errors.join('\n'), /companion .*evidence-checksums\.txt missing/)
})
