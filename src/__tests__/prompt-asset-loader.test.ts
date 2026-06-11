import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { PromptAssetLoader } from '../main/modules/agent-control/prompt-assets/loader'

function makeRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'ready-prompt-assets-'))
  mkdirSync(join(root, 'reminders'), { recursive: true })
  writeFileSync(
    join(root, 'reminders', 'budget-steer-90.md'),
    [
      '---',
      'name: budget-steer-90',
      'version: 1',
      'description: budget steer',
      'variables: [used, total]',
      '---',
      '',
      '已用 {{used}}/{{total}}，开始收尾。',
      '',
    ].join('\n'),
  )
  writeFileSync(
    join(root, 'no-vars.md'),
    ['---', 'name: no-vars', 'version: 2', '---', '', '固定文案，无变量。', ''].join('\n'),
  )
  return root
}

test('loads frontmatter + body and parses variables', () => {
  const root = makeRoot()
  try {
    const loader = new PromptAssetLoader({ roots: [root] })
    const asset = loader.load('reminders/budget-steer-90')
    assert.equal(asset.name, 'budget-steer-90')
    assert.equal(asset.version, '1')
    assert.deepEqual(asset.variables, ['used', 'total'])
    assert.ok(asset.body.includes('{{used}}'))
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('renders with variable substitution', () => {
  const root = makeRoot()
  try {
    const loader = new PromptAssetLoader({ roots: [root] })
    const out = loader.render('reminders/budget-steer-90', { used: '198', total: '220' })
    assert.equal(out, '已用 198/220，开始收尾。')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('render throws on missing variable value (never half-rendered)', () => {
  const root = makeRoot()
  try {
    const loader = new PromptAssetLoader({ roots: [root] })
    assert.throws(() => loader.render('reminders/budget-steer-90', { used: '198' }), /missing value/)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('render throws on undeclared placeholder', () => {
  const root = mkdtempSync(join(tmpdir(), 'ready-prompt-assets-'))
  try {
    writeFileSync(
      join(root, 'bad.md'),
      ['---', 'name: bad', 'version: 1', 'variables: [a]', '---', '', '{{a}} 和 {{undeclared}}', ''].join('\n'),
    )
    const loader = new PromptAssetLoader({ roots: [root] })
    assert.throws(() => loader.render('bad', { a: 'x', undeclared: 'y' }), /not declared/)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('version-stable render is byte-for-byte deterministic', () => {
  const root = makeRoot()
  try {
    const loader = new PromptAssetLoader({ roots: [root] })
    const a = loader.render('reminders/budget-steer-90', { used: '1', total: '2' })
    loader.clearCache()
    const b = loader.render('reminders/budget-steer-90', { used: '1', total: '2' })
    assert.equal(a, b)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('falls back to hardcoded body when file missing', () => {
  const loader = new PromptAssetLoader({
    roots: ['/nonexistent-root'],
    fallbacks: { 'reminders/x': 'hardcoded fallback' },
  })
  const asset = loader.load('reminders/x')
  assert.equal(asset.version, 'fallback')
  assert.equal(asset.body, 'hardcoded fallback')
})

test('throws when no file and no fallback', () => {
  const loader = new PromptAssetLoader({ roots: ['/nonexistent-root'] })
  assert.throws(() => loader.load('reminders/missing'), /not found and no fallback/)
})

test('first existing root wins (dev/prod parity)', () => {
  const root = makeRoot()
  try {
    const loader = new PromptAssetLoader({ roots: ['/nonexistent-root', root] })
    assert.equal(loader.load('no-vars').version, '2')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('shipped first-batch assets parse and render', () => {
  // Real assets under assets/prompts/ must be well-formed.
  const loader = new PromptAssetLoader({ roots: [join(process.cwd(), 'assets', 'prompts')] })
  const rules = loader.load('rules-defaults/RULES.global')
  assert.equal(rules.name, 'rules-global')
  assert.deepEqual(rules.variables, [])
  assert.ok(rules.body.includes('索引命中必读卡'))
  const steer = loader.render('reminders/budget-steer-90', { used: '198', total: '220' })
  assert.ok(steer.includes('198/220'))
  assert.ok(!steer.includes('{{'))
})
