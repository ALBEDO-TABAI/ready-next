#!/usr/bin/env node
/**
 * Stage T (W7.2) — verify read-artifact.ts and write-artifact.ts both:
 *   (A) call `lstatSync(...)` on the resolved path and reject when
 *       `isSymbolicLink()` is true (regardless of whether the realpath
 *       still lands inside the sandbox).
 *   (B) preserve the existing size caps:
 *         - read-artifact.ts: `HARD_CAP_BYTES = 1_048_576`  (1 MB)
 *         - write-artifact.ts: `WRITE_ARTIFACT_HARD_CAP_BYTES = 50 * 1024 * 1024`
 *
 * Round-5 fix — gate must NOT raise the caps to 100 MB; we keep §6.12 contract.
 */

const fs = require('fs')
const path = require('path')

const READ_FILE = path.join(
  __dirname,
  '..',
  'src/main/modules/tools/skill-primitives/read-artifact.ts',
)
const WRITE_FILE = path.join(
  __dirname,
  '..',
  'src/main/modules/tools/skill-primitives/write-artifact.ts',
)

function fail(msg) {
  console.error('[check-skill-primitives-symlink-rejected] FAIL: ' + msg)
  process.exit(1)
}

function readOrFail(file) {
  if (!fs.existsSync(file)) fail(`missing file: ${path.relative(process.cwd(), file)}`)
  return fs.readFileSync(file, 'utf8')
}

function checkSymlinkGate(source, tag) {
  if (!/\blstatSync\b/.test(source)) {
    fail(`${tag} must call lstatSync to detect symlinks (path-sandbox realpathSync alone does not reject in-sandbox symlinks)`)
  }
  if (!/isSymbolicLink\s*\(\s*\)/.test(source)) {
    fail(`${tag} must check linkStats.isSymbolicLink()`)
  }
  if (!/symlink_rejected/.test(source)) {
    fail(`${tag} must throw ToolDomainError with errorKind=symlink_rejected on hit`)
  }
}

function checkReadCapPreserved(source) {
  // §6.12 contract — read 1 MB. Accept either bare 1_048_576 or 1048576.
  const re = /HARD_CAP_BYTES\s*=\s*(1_?048_?576)\b/
  const match = source.match(re)
  if (!match) {
    fail('read-artifact.ts must keep HARD_CAP_BYTES = 1_048_576 (1 MB) — do not raise to 100 MB (§6.12)')
  }
}

function checkWriteCapPreserved(source) {
  // §6.12 contract — write 50 MB. Accept the canonical multiplicative form.
  if (!/WRITE_ARTIFACT_HARD_CAP_BYTES\s*=\s*50\s*\*\s*1024\s*\*\s*1024\b/.test(source)) {
    fail('write-artifact.ts must keep WRITE_ARTIFACT_HARD_CAP_BYTES = 50 * 1024 * 1024 (50 MB) — do not raise to 100 MB (§6.12)')
  }
}

function main() {
  const readSource = readOrFail(READ_FILE)
  const writeSource = readOrFail(WRITE_FILE)
  checkSymlinkGate(readSource, 'read-artifact.ts')
  checkSymlinkGate(writeSource, 'write-artifact.ts')
  checkReadCapPreserved(readSource)
  checkWriteCapPreserved(writeSource)
  console.log('[check-skill-primitives-symlink-rejected] OK')
}

if (require.main === module) {
  main()
}

module.exports = {
  checkSymlinkGate,
  checkReadCapPreserved,
  checkWriteCapPreserved,
}
