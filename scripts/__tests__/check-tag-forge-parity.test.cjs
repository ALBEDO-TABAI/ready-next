const assert = require('node:assert/strict')
const { mkdirSync, mkdtempSync, rmSync, writeFileSync } = require('node:fs')
const { tmpdir } = require('node:os')
const { join } = require('node:path')
const test = require('node:test')
const { checkTagForgeBundle } = require('../check-tag-forge-parity.cjs')

function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'ready-tag-forge-parity-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  for (const dir of ['bundled', 'author']) {
    mkdirSync(join(root, dir))
    writeFileSync(join(root, dir, 'SKILL.md'), '[guide](./guide.md)\n')
    writeFileSync(join(root, dir, 'guide.md'), 'fixture guide\n')
  }
  return { bundled: join(root, 'bundled'), author: join(root, 'author') }
}

test('bundle verification needs no personal author workspace and rejects broken references', (t) => {
  const { bundled, author } = fixture(t)
  rmSync(author, { recursive: true })
  assert.equal(checkTagForgeBundle(bundled), 2)
  rmSync(join(bundled, 'guide.md'))
  assert.throws(() => checkTagForgeBundle(bundled), /Broken Tag Forge relative link/)
})

test('explicit author parity detects content drift, missing files, and a missing source', (t) => {
  const { bundled, author } = fixture(t)
  assert.equal(checkTagForgeBundle(bundled, author), 2)
  writeFileSync(join(author, 'guide.md'), 'changed')
  assert.throws(() => checkTagForgeBundle(bundled, author), /content parity failed/)
  rmSync(join(author, 'guide.md'))
  assert.throws(() => checkTagForgeBundle(bundled, author), /file parity failed/)
  assert.throws(() => checkTagForgeBundle(bundled, join(author, 'missing')), /author source missing/)
})

test('bundle verification still rejects unimplemented commands and lexicon writes', (t) => {
  const { bundled } = fixture(t)
  for (const text of ['Use `tf`', '写回 tag-lexicon.yaml']) {
    writeFileSync(join(bundled, 'SKILL.md'), text)
    assert.throws(() => checkTagForgeBundle(bundled), /alias remains advertised|advertised as writable/)
  }
})
