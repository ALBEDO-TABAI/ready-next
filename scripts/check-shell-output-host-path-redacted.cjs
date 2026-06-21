#!/usr/bin/env node
/**
 * Stage T (W7.3) — verify run-shell.ts redacts host paths in ALL three sites:
 *   1. before stdout is returned to the model
 *   2. before stderr is returned to the model
 *   3. before the overflow log is persisted to disk (round-12 fix — without
 *      this the file under <artifactRoot>/.logs/shell-*.txt would still leak
 *      `/Users/<name>`)
 *
 * Implementation — count `redactHostPaths(` invocations inside run-shell.ts
 * and assert >= 3 (1 import line is excluded by the open-paren requirement).
 * Also assert host-path-redactor.ts exports the helper.
 */

const fs = require('fs')
const path = require('path')

const RUN_SHELL_FILE = path.join(
  __dirname,
  '..',
  'src/main/modules/tools/skill-primitives/run-shell.ts',
)
const REDACTOR_FILE = path.join(
  __dirname,
  '..',
  'src/main/modules/tools/skill-primitives/host-path-redactor.ts',
)

function fail(msg) {
  console.error('[check-shell-output-host-path-redacted] FAIL: ' + msg)
  process.exit(1)
}

function readOrFail(file) {
  if (!fs.existsSync(file)) fail(`missing file: ${path.relative(process.cwd(), file)}`)
  return fs.readFileSync(file, 'utf8')
}

function checkRedactor(source) {
  if (!/export\s+function\s+redactHostPaths\b/.test(source)) {
    fail('host-path-redactor.ts must export redactHostPaths')
  }
  // Sanity — must redact at least the three expected forms.
  if (!/HOME/.test(source)) fail('redactor must reference HOME')
  if (!/\\\/Users\\\/|\/Users\\\//.test(source) && !/\/Users\\\//.test(source)) {
    // Looser fallback — just look for the literal /Users/.
    if (!/\/Users\//.test(source)) fail('redactor must redact /Users/<name>')
  }
  if (!/\/home\//.test(source)) fail('redactor must redact /home/<name>')
  if (!/USERPROFILE/.test(source)) fail('redactor must reference USERPROFILE')
  if (!/\\\\Users\\\\/.test(source)) fail('redactor must redact Windows \\\\Users\\\\<name> paths')
  if (!/WINDOWS_USERS_DRIVE_ESCAPED_PATTERN/.test(source)) fail('redactor must define JSON-escaped Windows drive path handling')
  if (!/\\\\\\\\Users\\\\\\\\/.test(source)) fail('redactor must redact JSON-escaped Windows \\\\\\\\Users paths')
}

function countInvocations(source) {
  // Count call sites — `redactHostPaths(` followed by anything except an
  // import statement context. The import line uses the same identifier but
  // without an open-paren, so this regex naturally excludes it.
  const matches = source.match(/redactHostPaths\s*\(/g)
  return matches ? matches.length : 0
}

function checkRunShellInvocations(source) {
  if (!/from\s+['"]\.\/host-path-redactor['"]/.test(source)) {
    fail('run-shell.ts must import from ./host-path-redactor')
  }
  const count = countInvocations(source)
  if (count < 3) {
    fail(
      `run-shell.ts must invoke redactHostPaths >= 3 times (stdout / stderr / overflow log); found ${count}. ` +
        'Round-12 fix requires the overflow log write site to redact too — otherwise persisted shell-*.txt leaks /Users/<name>.',
    )
  }
}

function main() {
  const redactor = readOrFail(REDACTOR_FILE)
  const runShell = readOrFail(RUN_SHELL_FILE)
  checkRedactor(redactor)
  checkRunShellInvocations(runShell)
  console.log('[check-shell-output-host-path-redacted] OK')
}

if (require.main === module) {
  main()
}

module.exports = {
  countInvocations,
  checkRunShellInvocations,
  checkRedactor,
}
