import assert from 'node:assert/strict'
import test from 'node:test'
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  assertFrozenDesktopExecutableAuthority,
  classifyDesktopExecutableFailure,
  executeFrozenDesktopExecutable,
  materializeFrozenDesktopExecutableSnapshot,
  resolveFrozenDesktopExecutableAuthority,
} from '../main/modules/skills-runtime/desktop-executable-authority'

function makeExecutableFixture() {
  const root = mkdtempSync(join(tmpdir(), 'ready-executable-authority-'))
  const path = join(root, 'fixture-cli')
  writeFileSync(path, '#!/bin/sh\nif [ "$1" = "--version" ]; then echo "fixture 1.0"; exit 0; fi\necho "$@"\n', 'utf8')
  chmodSync(path, 0o755)
  return { root, path, cleanup: () => rmSync(root, { recursive: true, force: true }) }
}

test('resolves a Finder-style executable without relying on PATH and freezes its launcher chain', async () => {
  const fixture = makeExecutableFixture()
  try {
    const authority = await resolveFrozenDesktopExecutableAuthority({
      program: 'fixture-cli',
      env: { PATH: '/usr/bin:/bin' },
      additionalSearchDirectories: [fixture.root],
    })
    assert.equal(authority.outerPath, fixture.path)
    assert.equal(authority.realPath, realpathSync.native(fixture.path))
    assert.equal(authority.version, 'fixture 1.0')
    assert.equal(authority.launcherChain.length, 2)
    assert.equal(authority.launcherChain[0].kind, 'payload')
    assert.equal(authority.launcherChain[1].kind, 'interpreter')
    assert.deepEqual(authority.launchPrefixArgs, [realpathSync.native(fixture.path)])
    assert.doesNotThrow(() => assertFrozenDesktopExecutableAuthority(authority))
  } finally {
    fixture.cleanup()
  }
})

test('rejects executable content drift before execution', async () => {
  const fixture = makeExecutableFixture()
  try {
    const authority = await resolveFrozenDesktopExecutableAuthority({ program: fixture.path })
    const original = readFileSync(fixture.path, 'utf8')
    writeFileSync(fixture.path, `${original}\n# drift\n`, 'utf8')
    chmodSync(fixture.path, 0o755)
    assert.throws(
      () => assertFrozenDesktopExecutableAuthority(authority),
      (error: unknown) => (error as { code?: string }).code === 'dependency_identity_drift',
    )
  } finally {
    fixture.cleanup()
  }
})

test('executes a private snapshot when the verified program replaces its installed path', async () => {
  const root = mkdtempSync(join(tmpdir(), 'ready-executable-snapshot-run-'))
  const path = join(root, 'fixture-cli')
  const replacement = join(root, 'replacement-cli')
  const maliciousMarker = join(root, 'malicious.txt')
  try {
    writeFileSync(path, [
      '#!/bin/sh',
      'if [ "$1" = "--version" ]; then echo "fixture 1.0"; exit 0; fi',
      `mv "${replacement}" "${path}"`,
      'echo trusted',
    ].join('\n'), 'utf8')
    writeFileSync(replacement, [
      '#!/bin/sh',
      `echo malicious > "${maliciousMarker}"`,
      'echo malicious',
    ].join('\n'), 'utf8')
    chmodSync(path, 0o755)
    chmodSync(replacement, 0o755)
    const authority = await resolveFrozenDesktopExecutableAuthority({ program: path })
    const result = await executeFrozenDesktopExecutable({ authority, args: ['run'] })
    assert.equal(result.exitCode, 0)
    assert.equal(result.stdout.trim(), 'trusted')
    assert.equal(result.executableReadbackDigest, authority.authorityDigest)
    assert.equal(existsSync(maliciousMarker), false)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('a snapshot root emptied by the OS temp sweep is marked again; one that still holds something is not', async () => {
  const fixture = makeExecutableFixture()
  try {
    const authority = await resolveFrozenDesktopExecutableAuthority({ program: fixture.path })
    // What the nightly sweep leaves behind: the private directory, without its marker.
    const swept = join(fixture.root, 'swept-authority')
    mkdirSync(swept, { mode: 0o700 })
    const snapshot = materializeFrozenDesktopExecutableSnapshot({ authority, authorityRoot: swept })
    assert.equal(existsSync(snapshot.spawnPath), true)
    assert.equal(existsSync(join(swept, '.ready-owner')), true)

    // A markerless directory with content was not made empty by Ready or the sweep: it stays refused.
    const occupied = join(fixture.root, 'occupied-authority')
    mkdirSync(occupied, { mode: 0o700 })
    writeFileSync(join(occupied, 'someone-elses-file'), 'x')
    assert.throws(
      () => materializeFrozenDesktopExecutableSnapshot({ authority, authorityRoot: occupied }),
      /dependency_snapshot_unavailable/,
    )
    // So does an empty one other users could have written into.
    const open = join(fixture.root, 'open-authority')
    mkdirSync(open, { mode: 0o755 })
    chmodSync(open, 0o755)
    assert.throws(
      () => materializeFrozenDesktopExecutableSnapshot({ authority, authorityRoot: open }),
      /dependency_snapshot_unavailable/,
    )
  } finally {
    const swept = join(fixture.root, 'swept-authority')
    for (const name of existsSync(swept) ? readdirSync(swept) : []) chmodSync(join(swept, name), 0o700)
    fixture.cleanup()
  }
})

test('dead snapshot cleanup requires the private root marker and exact Ready-owned shape', async () => {
  const fixture = makeExecutableFixture()
  const authorityRoot = join(fixture.root, 'snapshot-authority')
  try {
    const authority = await resolveFrozenDesktopExecutableAuthority({ program: fixture.path })
    const first = materializeFrozenDesktopExecutableSnapshot({ authority, authorityRoot })
    const firstName = readdirSync(authorityRoot).find((name) => name.startsWith('.ready-executable-'))
    assert.ok(firstName)
    const firstPath = join(authorityRoot, firstName)
    const deadName = '.ready-executable-999999-deadowner'
    const deadPath = join(authorityRoot, deadName)
    chmodSync(firstPath, 0o700)
    writeFileSync(join(firstPath, '.ready-owner'), '{"pid":999999,"schema":1}\n', { mode: 0o600 })
    renameSync(firstPath, deadPath)
    chmodSync(deadPath, 0o500)
    first.release()

    const lookalike = join(authorityRoot, '.ready-executable-999999-useroutput')
    mkdirSync(lookalike, { mode: 0o700 })
    writeFileSync(join(lookalike, 'sentinel'), 'keep')
    chmodSync(lookalike, 0o500)
    const currentOwner = join(authorityRoot, `.ready-executable-${process.pid}-liveowner`)
    mkdirSync(currentOwner, { mode: 0o500 })
    const symlink = join(authorityRoot, '.ready-executable-999999-symlink')
    symlinkSync(lookalike, symlink)
    const emptyStaging = join(authorityRoot, '.ready-executable-staging-999999-empty')
    mkdirSync(emptyStaging, { mode: 0o700 })
    const markerStaging = join(authorityRoot, '.ready-executable-staging-999999-marker')
    mkdirSync(markerStaging, { mode: 0o700 })
    writeFileSync(join(markerStaging, '.ready-owner'), '{"pid":999999,"schema":1}\n', { mode: 0o600 })
    const payloadStaging = join(authorityRoot, '.ready-executable-staging-999999-payload')
    mkdirSync(payloadStaging, { mode: 0o700 })
    writeFileSync(join(payloadStaging, '.ready-owner'), '{"pid":999999,"schema":1}\n', { mode: 0o600 })
    writeFileSync(join(payloadStaging, '0-payload'), '#!/bin/sh\nexit 0\n', { mode: 0o755 })
    const invalidStaging = join(authorityRoot, '.ready-executable-staging-999999-useroutput')
    mkdirSync(invalidStaging, { mode: 0o700 })
    writeFileSync(join(invalidStaging, 'sentinel'), 'keep')

    const second = materializeFrozenDesktopExecutableSnapshot({ authority, authorityRoot })
    assert.equal(existsSync(deadPath), false)
    assert.equal(existsSync(emptyStaging), false)
    assert.equal(existsSync(markerStaging), false)
    assert.equal(existsSync(payloadStaging), false)
    assert.equal(readFileSync(join(invalidStaging, 'sentinel'), 'utf8'), 'keep')
    assert.equal(readFileSync(join(lookalike, 'sentinel'), 'utf8'), 'keep')
    assert.equal(existsSync(currentOwner), true)
    assert.equal(existsSync(symlink), true)
    second.release()
  } finally {
    if (existsSync(authorityRoot)) {
      for (const name of readdirSync(authorityRoot)) {
        try {
          chmodSync(join(authorityRoot, name), 0o700)
        } catch {
          // Symlink or already-removed fixture entry.
        }
      }
    }
    fixture.cleanup()
  }
})

test('a frozen executable reports whether it exited, was killed or never started', async () => {
  const root = mkdtempSync(join(tmpdir(), 'ready-executable-outcome-'))
  const path = join(root, 'fixture-cli')
  try {
    writeFileSync(path, '#!/bin/sh\nif [ "$1" = "--version" ]; then echo "fixture 1.0"; exit 0; fi\nif [ "$1" = "hang" ]; then sleep 5; fi\nexit 3\n', 'utf8')
    chmodSync(path, 0o755)
    const authority = await resolveFrozenDesktopExecutableAuthority({ program: path })
    const exited = await executeFrozenDesktopExecutable({ authority, args: ['fail'] })
    assert.equal(exited.outcome, 'exited')
    assert.equal(exited.exitCode, 3)
    const killed = await executeFrozenDesktopExecutable({ authority, args: ['hang'], timeoutMs: 200 })
    assert.equal(killed.outcome, 'killed')
    assert.equal(killed.exitCode, -1)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
  // execFile rejects a program that cannot start with a string errno code and no exit status.
  assert.equal(classifyDesktopExecutableFailure(Object.assign(new Error('spawn ENOENT'), { code: 'ENOENT' })), 'launch_failed')
  assert.equal(classifyDesktopExecutableFailure(Object.assign(new Error('spawn EACCES'), { code: 'EACCES' })), 'launch_failed')
})
