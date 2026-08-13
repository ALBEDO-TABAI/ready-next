const assert = require('node:assert/strict')
const { mkdtempSync, mkdirSync, rmSync, writeFileSync } = require('node:fs')
const { join } = require('node:path')
const { tmpdir } = require('node:os')
const test = require('node:test')

const {
  checkCoordinatorIsolation,
} = require('../check-coordinator-isolation.cjs')

test('check-coordinator-isolation accepts adapter-owned product behavior', () => {
  const root = makeFixture()
  try {
    writeFile(root, 'src/main/modules/agent-control/turn-engine.ts', [
      "import { selectDomainAdapter } from './domain-adapter'",
      'const selected = selectDomainAdapter([], {} as never)',
      'void selected',
      '',
    ].join('\n'))
    writeFile(root, 'src/main/modules/agent-control/prompt-assembly.ts', [
      'const TRIGGERS = [',
      "  { id: 'system', module: 'system' },",
      '  { id: "ambient" },',
      ']',
      '',
    ].join('\n'))

    const result = checkCoordinatorIsolation({ root })

    assert.equal(result.ok, true)
    assert.deepEqual(result.errors, [])
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('check-coordinator-isolation rejects product prompt triggers after turn-engine retirement', () => {
  const root = makeFixture()
  try {
    writeFile(root, 'src/main/modules/agent-control/turn-engine.ts', [
      "import { runBrowserTool } from './tools/browser-tools'",
      "if (adapter.id === 'browser') runBrowserTool()",
      "if (selected.id !== 'document') runBrowserTool()",
      '',
    ].join('\n'))
    writeFile(root, 'src/main/modules/agent-control/prompt-assembly.ts', [
      'const TRIGGERS = [',
      "  { id: 'rss-analysis', module: 'rss' },",
      ']',
      '',
    ].join('\n'))

    const result = checkCoordinatorIsolation({ root })

    assert.equal(result.ok, false)
    assert.equal(result.errors.length, 1)
    assert.match(result.errors.join('\n'), /product trigger module "rss"/)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

function makeFixture() {
  return mkdtempSync(join(tmpdir(), 'ready-coordinator-isolation-'))
}

function writeFile(root, file, content) {
  const abs = join(root, file)
  mkdirSync(join(abs, '..'), { recursive: true })
  writeFileSync(abs, content)
}
