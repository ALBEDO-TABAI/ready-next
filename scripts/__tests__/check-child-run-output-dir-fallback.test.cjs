const assert = require('node:assert/strict')
const { spawnSync } = require('node:child_process')
const { mkdirSync, mkdtempSync, rmSync, writeFileSync } = require('node:fs')
const { tmpdir } = require('node:os')
const { join, resolve } = require('node:path')
const test = require('node:test')

const {
  checkChildRunOutputDirFallback,
} = require('../check-child-run-output-dir-fallback.cjs')

const SCRIPT_PATH = resolve(__dirname, '../check-child-run-output-dir-fallback.cjs')

function withRunnerSource(source, callback) {
  const root = mkdtempSync(join(tmpdir(), 'ready-child-output-dir-gate-'))
  try {
    const file = join(root, 'src/main/modules/agent-control/skills/skill-child-runner.ts')
    mkdirSync(resolve(file, '..'), { recursive: true })
    writeFileSync(file, source)
    return callback(root)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
}

test('accepts canonical handle guard before runtime outputDir fallback', () => {
  withRunnerSource(
    [
      'const canonicalHandle = resolveCanonicalChildRunHandle({ requestedInput: params.requestedInput })',
      'if (!canonicalHandle.ok && isResumeOnlySkillAction(params.skillId, params.action)) return blocked',
      'const requestedInput = canonicalHandle.ok ? canonicalHandle.input : params.requestedInput',
      'const requestedOutputDir = canonicalHandle.ok ? trim(canonicalHandle.outputDir) : trim(requestedInput.outputDir)',
      'const outputDir = requestedOutputDir || join(runtimeInfo.outputsRoot, params.skillId, childRunId)',
      '',
    ].join('\n'),
    (root) => {
      const result = checkChildRunOutputDirFallback({ root })
      assert.deepEqual(result.violations, [])
    },
  )
})

test('rejects direct requestedInput outputDir fallback without canonical handle', () => {
  withRunnerSource(
    [
      'const requestedOutputDir = trim(params.requestedInput.outputDir as unknown)',
      'const outputDir = requestedOutputDir || join(runtimeInfo.outputsRoot, params.skillId, childRunId)',
      '',
    ].join('\n'),
    (root) => {
      const result = checkChildRunOutputDirFallback({ root })
      assert.equal(result.violations.length >= 1, true)
      assert.match(result.violations.map((v) => v.message).join('\\n'), /canonical|directly|resume-only/)
    },
  )
})

test('supports CLI --root', () => {
  withRunnerSource(
    [
      'const canonicalHandle = resolveCanonicalChildRunHandle({ requestedInput: params.requestedInput })',
      'if (!canonicalHandle.ok && isResumeOnlySkillAction(params.skillId, params.action)) return blocked',
      'const requestedInput = canonicalHandle.ok ? canonicalHandle.input : params.requestedInput',
      'const requestedOutputDir = canonicalHandle.ok ? trim(canonicalHandle.outputDir) : trim(requestedInput.outputDir)',
      'const outputDir = requestedOutputDir || join(runtimeInfo.outputsRoot, params.skillId, childRunId)',
      '',
    ].join('\n'),
    (root) => {
      const result = spawnSync(process.execPath, [SCRIPT_PATH, '--root', root], { encoding: 'utf8' })
      assert.equal(result.status, 0, result.stderr)
      assert.match(result.stdout, /child-run outputDir fallback: ok/)
    },
  )
})
