'use strict'

const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { test } = require('node:test')

const {
  DOGFOOD_DIR_REL,
  evaluateLiveEvidence,
  main,
} = require('../check-release-live-evidence.cjs')

function record(fileName, fm) {
  return { fileName, fm }
}

test('accepts release-ready pass records with required Bai spotcheck fields', () => {
  const records = Array.from({ length: 20 }, (_, i) =>
	    record(`surface-${String(i + 1).padStart(2, '0')}-x.md`, {
	      surface_id: i + 1,
	      status: 'pass',
	      operator_class: i === 1 ? 'agent-with-bai-spotcheck' : 'agent-only',
      bai_spotcheck:
        i === 1
          ? {
              performed_by: '白',
              performed_at: '2026-05-24T12:00:00+08:00',
              spotcheck_evidence: 'evidence/surface-02.mp4',
              spotcheck_sha256: 'abc123',
              spotcheck_signoff_text: 'looks good',
            }
          : undefined,
    }),
  )

  const result = evaluateLiveEvidence(records)

  assert.equal(result.ok, true)
  assert.equal(result.passCount, 19)
  assert.equal(result.total, 19)
  assert.deepEqual(result.outOfScopeSurfaceIds, [11])
  assert.deepEqual(result.statusCounts, { pass: 20 })
})

test('allows out-of-scope remote surface 11 to remain deferred', () => {
  const records = Array.from({ length: 20 }, (_, i) =>
	    record(`surface-${String(i + 1).padStart(2, '0')}-x.md`, {
	      surface_id: i + 1,
	      status: i === 10 ? 'deferred-with-owner' : 'pass',
	      operator_class: 'agent-only',
      deferred_owner: i === 10 ? '白' : undefined,
    }),
  )

  const result = evaluateLiveEvidence(records)

  assert.equal(result.ok, true)
  assert.equal(result.passCount, 19)
  assert.equal(result.total, 19)
  assert.deepEqual(result.outOfScopeSurfaceIds, [11])
  assert.deepEqual(result.statusCounts, { pass: 19, 'deferred-with-owner': 1 })
})

test('rejects deferred records for release readiness', () => {
  const records = Array.from({ length: 20 }, (_, i) =>
	    record(`surface-${String(i + 1).padStart(2, '0')}-x.md`, {
	      surface_id: i + 1,
	      status: i === 0 ? 'deferred-with-owner' : 'pass',
	      operator_class: 'agent-only',
      deferred_owner: i === 0 ? '白' : undefined,
    }),
  )

  const result = evaluateLiveEvidence(records)

  assert.equal(result.ok, false)
  assert.equal(result.passCount, 18)
  assert.equal(result.total, 19)
  assert.match(
    result.errors.join('\n'),
    /surface-01-x\.md: release requires status=pass, got deferred-with-owner owner=白/,
  )
})

test('rejects mandatory Bai pass records without complete spotcheck fields', () => {
  const records = Array.from({ length: 20 }, (_, i) =>
	    record(`surface-${String(i + 1).padStart(2, '0')}-x.md`, {
	      surface_id: i + 1,
	      status: 'pass',
	      operator_class: i === 1 ? 'agent-with-bai-spotcheck' : 'agent-only',
      bai_spotcheck: i === 1 ? { performed_by: '白' } : undefined,
    }),
  )

  const result = evaluateLiveEvidence(records)

  assert.equal(result.ok, false)
  assert.match(result.errors.join('\n'), /bai_spotcheck missing performed_at/)
	  assert.match(result.errors.join('\n'), /bai_spotcheck missing spotcheck_evidence/)
	})

test('rejects duplicate or missing surface id coverage even when 20 records pass', () => {
  const records = Array.from({ length: 20 }, (_, i) => {
    const id = i === 19 ? 1 : i + 1
    return record(`surface-${String(id).padStart(2, '0')}-x-${i}.md`, {
      surface_id: id,
      status: 'pass',
      operator_class: 'agent-only',
    })
  })

  const result = evaluateLiveEvidence(records)

  assert.equal(result.ok, false)
  assert.equal(result.passCount, 19)
  assert.equal(result.total, 19)
  assert.match(result.errors.join('\n'), /filename: missing surface id\(s\) 20/)
  assert.match(result.errors.join('\n'), /filename: duplicate surface id\(s\) 1/)
  assert.match(
    result.errors.join('\n'),
    /frontmatter surface_id: missing surface id\(s\) 20/,
  )
  assert.match(
    result.errors.join('\n'),
    /frontmatter surface_id: duplicate surface id\(s\) 1/,
  )
})

test('main requires full Stage Y evidence lint, not only pass status', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ready-release-live-'))
  const dogfoodDir = path.join(root, DOGFOOD_DIR_REL)
  fs.mkdirSync(dogfoodDir, { recursive: true })
  for (let i = 1; i <= 20; i += 1) {
    fs.writeFileSync(
      path.join(dogfoodDir, `surface-${String(i).padStart(2, '0')}-x.md`),
      [
        '---',
        'status: pass',
        'operator_class: agent-only',
        '---',
        '',
      ].join('\n'),
    )
  }

  const result = main({ root })

  assert.equal(result.ok, false)
  assert.equal(result.passCount, 19)
  assert.match(result.errors.join('\n'), /frontmatter missing key "surface"/)
})
