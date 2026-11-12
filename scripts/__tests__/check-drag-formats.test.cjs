const test = require('node:test')
const assert = require('node:assert/strict')
const { mkdtempSync, writeFileSync, rmSync } = require('node:fs')
const { tmpdir } = require('node:os')
const { join } = require('node:path')
const { check } = require('../check-drag-formats.cjs')
test('reject retired formats, including browser injection templates; allow the one format and comments', () => {
  const root = mkdtempSync(join(tmpdir(), 'drag-'))
  try {
    writeFileSync(join(root, 'ok.ts'), "const mime = 'application/x-ready-ref'; // application/x-ready-drag")
    assert.deepEqual(check(root), [])
    for (const mime of ['drag', 'fastcard', 'file', 'database-row', 'calendar-layer']) {
      writeFileSync(join(root, 'bad.ts'), `const code = \`data.getData('application/x-ready-${mime}')\``)
      assert.equal(check(root).length, 1)
    }
  } finally { rmSync(root, { recursive: true, force: true }) }
})
