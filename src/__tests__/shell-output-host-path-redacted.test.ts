/**
 * Stage T (PR-T2 / W7.3) — host-path redaction in run-shell.ts outputs.
 *
 * Asserts:
 *   - redactHostPaths removes `/Users/<name>` and `/home/<name>`.
 *   - executeRunShell's stdout / stderr surfaced to the model are redacted.
 *   - The persisted overflow log under `<artifactRoot>/.logs/shell-*.txt` is
 *     also redacted (round-12 fix — without this the file would still leak
 *     `/Users/<name>` even after redacting the in-memory return value).
 */

import assert from 'node:assert/strict'
import test from 'node:test'
import { existsSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { redactHostPaths } from '../main/modules/tools/skill-primitives/host-path-redactor'
import { executeRunShell } from '../main/modules/tools/skill-primitives/run-shell'
import type { SkillRootSet } from '../main/modules/tools/skill-primitives/root-resolver'

function makeFixture() {
  const artifactRoot = realpathSync.native(mkdtempSync(join(tmpdir(), 'shell-redact-art-')))
  const assetRoot = realpathSync.native(mkdtempSync(join(tmpdir(), 'shell-redact-asset-')))
  const lookup = (id: string): SkillRootSet | null =>
    id === 'test-skill' ? { skillId: 'test-skill', assetRoot, artifactRoot } : null
  return {
    artifactRoot,
    assetRoot,
    lookup,
    cleanup: () => {
      rmSync(artifactRoot, { recursive: true, force: true })
      rmSync(assetRoot, { recursive: true, force: true })
    },
  }
}

test('redactHostPaths replaces /Users/<name> with /Users/<redacted>', () => {
  const out = redactHostPaths('error in /Users/alice/code/foo.ts')
  assert.match(out, /\/Users\/<redacted>\/code\/foo\.ts/)
  assert.doesNotMatch(out, /\/Users\/alice/)
})

test('redactHostPaths replaces /home/<name> with /home/<redacted>', () => {
  const out = redactHostPaths('log: /home/bob/.config/foo')
  assert.match(out, /\/home\/<redacted>\//)
  assert.doesNotMatch(out, /\/home\/bob/)
})

test('redactHostPaths replaces Windows drive-letter user home paths', () => {
  const out = redactHostPaths('error in C:\\Users\\alice\\Ready\\secret.txt')
  assert.match(out, /C:\\Users\\<redacted>\\Ready\\secret\.txt/)
  assert.doesNotMatch(out, /C:\\Users\\alice/)

  const lowerDrive = redactHostPaths('error in c:\\Users\\erin\\Ready\\secret.txt')
  assert.match(lowerDrive, /c:\\Users\\<redacted>\\Ready\\secret\.txt/)
  assert.doesNotMatch(lowerDrive, /c:\\Users\\erin/)
})

test('redactHostPaths replaces Windows root-backslash user home paths', () => {
  const out = redactHostPaths('log: \\Users\\carol\\.ready\\state.json')
  assert.match(out, /\\Users\\<redacted>\\\.ready\\state\.json/)
  assert.doesNotMatch(out, /\\Users\\carol/)

  const assigned = redactHostPaths('path=\\Users\\frank\\.ready\\state.json')
  assert.match(assigned, /path=\\Users\\<redacted>\\\.ready\\state\.json/)
  assert.doesNotMatch(assigned, /\\Users\\frank/)
})

test('redactHostPaths replaces JSON-escaped Windows user home paths', () => {
  const drive = redactHostPaths('{"path":"C:\\\\Users\\\\alice\\\\Ready\\\\secret.txt"}')
  assert.ok(drive.includes('C:\\\\Users\\\\<redacted>\\\\Ready\\\\secret.txt'))
  assert.doesNotMatch(drive, /Users\\\\alice/)

  const root = redactHostPaths('{"path":"\\\\Users\\\\carol\\\\.ready\\\\state.json"}')
  assert.ok(root.includes('\\\\Users\\\\<redacted>\\\\.ready\\\\state.json'))
  assert.doesNotMatch(root, /Users\\\\carol/)
})

test('redactHostPaths replaces USERPROFILE literal and runtime values', () => {
  const previous = process.env.USERPROFILE
  process.env.USERPROFILE = 'D:\\Profiles\\dana'
  try {
    const literal = redactHostPaths('path=%USERPROFILE%\\Ready\\secret')
    assert.match(literal, /<userprofile>\\Ready\\secret/)
    assert.doesNotMatch(literal, /%USERPROFILE%/)

    const runtime = redactHostPaths('path=D:\\Profiles\\dana\\Ready\\secret')
    assert.match(runtime, /<userprofile>\\Ready\\secret/)
    assert.doesNotMatch(runtime, /D:\\Profiles\\dana/)

    const escapedRuntime = redactHostPaths('{"path":"D:\\\\Profiles\\\\dana\\\\Ready\\\\secret"}')
    assert.ok(escapedRuntime.includes('<userprofile>\\\\Ready\\\\secret'))
    assert.doesNotMatch(escapedRuntime, /D:\\\\Profiles\\\\dana/)
  } finally {
    if (previous === undefined) delete process.env.USERPROFILE
    else process.env.USERPROFILE = previous
  }
})

test('redactHostPaths is a no-op for paths that contain no host-style segments', () => {
  assert.equal(redactHostPaths('hello world'), 'hello world')
  assert.equal(redactHostPaths(''), '')
  assert.equal(redactHostPaths('relative\\Users\\alice\\file.txt'), 'relative\\Users\\alice\\file.txt')
})

test('executeRunShell redacts stdout before returning to the caller', async () => {
  const fx = makeFixture()
  try {
    // Use `echo` (in SHELL_ALLOWLIST) to emit a /Users/ path.
    const out = await executeRunShell(
      { command: 'echo "leak /Users/alice/secret"' },
      { skillId: 'test-skill', lookupSkillRoots: fx.lookup },
    )
    const stdout = (out.data as { stdout?: string }).stdout || ''
    assert.match(stdout, /\/Users\/<redacted>\/secret/)
    assert.doesNotMatch(stdout, /\/Users\/alice/)
  } finally {
    fx.cleanup()
  }
})

test('overflow log on disk is redacted (round-12 fix)', async () => {
  const fx = makeFixture()
  try {
    // Generate >8K stdout containing a /Users/<name> string. echo of a long
    // string is the cheapest path that lands a single allow-listed bin. Use
    // bash -c for the python-style `*` expansion fallback would not be in
    // allowlist; echo handles it directly.
    const longLine = 'X'.repeat(9000)
    const command = `echo "${longLine} /Users/alice/sensitive"`
    const out = await executeRunShell(
      { command },
      { skillId: 'test-skill', lookupSkillRoots: fx.lookup },
    )
    // stdout truncated => overflow log written.
    assert.equal((out.data as { stdoutTruncated?: boolean }).stdoutTruncated, true)
    const artifactPath = (out.data as { stdoutArtifactPath?: string | null }).stdoutArtifactPath
    assert.ok(artifactPath, 'expected stdoutArtifactPath to be set')
    // The path itself is redacted on the structured payload, so we cannot
    // open it directly via that string. Walk the .logs dir and inspect.
    const logsDir = join(fx.artifactRoot, '.logs')
    assert.ok(existsSync(logsDir), 'expected .logs dir to exist')
    const entries = readdirSync(logsDir).filter((n) => n.endsWith('-stdout.txt'))
    assert.ok(entries.length > 0, 'expected at least one stdout overflow file')
    const fullText = readFileSync(join(logsDir, entries[0]), 'utf-8')
    // Round-12 — the persisted file must not leak /Users/<name>.
    assert.doesNotMatch(fullText, /\/Users\/alice/)
    // It SHOULD contain the redacted form so we know we redacted, not stripped.
    assert.match(fullText, /\/Users\/<redacted>\/sensitive/)
  } finally {
    fx.cleanup()
  }
})
