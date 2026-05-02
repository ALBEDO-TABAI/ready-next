const assert = require('node:assert/strict')
const { spawnSync } = require('node:child_process')
const { mkdirSync, mkdtempSync, rmSync, writeFileSync } = require('node:fs')
const { tmpdir } = require('node:os')
const { dirname, join, resolve } = require('node:path')
const test = require('node:test')

const {
  checkSilentCatch,
  scanSilentCatches,
} = require('../check-silent-catch.cjs')

const SCRIPT_PATH = resolve(__dirname, '../check-silent-catch.cjs')

test('accepts catch blocks that log, emit metrics, throw, or carry a reason comment', () => {
  withFixture(
    {
      'src/main/modules/agent-control/example.ts': [
        'try { work() } catch (error) { console.warn(error) }',
        'try { work() } catch (error) { logAgentMetric("sample_failed", {}) }',
        'try { work() } catch (error) { emitProjectionPartial("parse", path, error) }',
        'try { work() } catch (error) { throw error }',
        'try { work() } catch (error) {',
        '  // silent-catch: optional cleanup best effort',
        '}',
        '',
      ].join('\n'),
    },
    (root) => {
      const result = checkSilentCatch({ root, baselinePath: null })
      assert.equal(result.ok, true, result.violations.map(formatViolation).join('\n'))
    },
  )
})

test('rejects a new bare silent catch', () => {
  withFixture(
    {
      'src/main/modules/tools/example.ts': [
        'try { work() } catch (error) {',
        '  cleanup = true',
        '}',
        '',
      ].join('\n'),
    },
    (root) => {
      const result = checkSilentCatch({ root, baselinePath: null })
      assert.equal(result.ok, false)
      assert.equal(result.violations.length, 1)
      assert.match(result.violations[0].message, /silent catch without metric/)
    },
  )
})

test('rejects a new renderer silent catch', () => {
  withFixture(
    {
      'src/renderer/example.tsx': [
        'try { work() } catch (error) {',
        '  cleanup = true',
        '}',
        '',
      ].join('\n'),
    },
    (root) => {
      const result = checkSilentCatch({ root, baselinePath: null })
      assert.equal(result.ok, false)
      assert.equal(result.violations.length, 1)
      assert.equal(result.violations[0].file, 'src/renderer/example.tsx')
    },
  )
})

test('accepts a silent catch pinned by baseline snippetHash', () => {
  withFixture(
    {
      'src/main/modules/skills-runtime/example.ts': [
        'try { work() } catch (error) {',
        '  cleanup = true',
        '}',
        '',
      ].join('\n'),
    },
    (root) => {
      const [entry] = scanSilentCatches({ root })
      write(
        root,
        'scripts/snapshots/silent-catch-baseline.json',
        JSON.stringify({ version: 1, entries: [entry] }, null, 2),
      )

      const result = checkSilentCatch({ root })
      assert.equal(result.ok, true, result.violations.map(formatViolation).join('\n'))
    },
  )
})

test('rejects malformed baseline entries without snippetHash', () => {
  withFixture(
    {
      'scripts/snapshots/silent-catch-baseline.json': JSON.stringify({
        version: 1,
        entries: [{ file: 'src/main/modules/tools/example.ts', line: 1 }],
      }),
      'src/main/modules/tools/example.ts': 'export {}\n',
    },
    (root) => {
      const result = checkSilentCatch({ root })
      assert.equal(result.ok, false)
      assert.match(result.violations[0].message, /baseline entry must include file, line, and snippetHash/)
    },
  )
})

test('supports CLI --root', () => {
  withFixture(
    {
      'src/main/modules/agent-control/example.ts': [
        'try { work() } catch (error) {',
        '  // silent-catch: optional cleanup best effort',
        '}',
        '',
      ].join('\n'),
    },
    (root) => {
      const result = spawnSync(process.execPath, [SCRIPT_PATH, '--root', root], {
        encoding: 'utf8',
      })
      assert.equal(result.status, 0, result.stderr)
      assert.match(result.stdout, /silent catch: ok/)
    },
  )
})

function withFixture(files, callback) {
  const root = mkdtempSync(join(tmpdir(), 'ready-silent-catch-'))
  try {
    for (const [file, text] of Object.entries(files)) {
      write(root, file, text)
    }
    return callback(root)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
}

function write(root, file, text) {
  const path = join(root, file)
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, text)
}

function formatViolation(violation) {
  return `${violation.file}:${violation.line} ${violation.message}`
}
