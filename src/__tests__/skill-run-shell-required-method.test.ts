import assert from 'node:assert/strict'
import test from 'node:test'
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createHash } from 'node:crypto'
import { execFileSync, spawn } from 'node:child_process'

import { resolveFrozenDesktopExecutableAuthority } from '../main/modules/skills-runtime/desktop-executable-authority'
import { executeRunShell } from '../main/modules/tools/skill-primitives/run-shell'
import type { SkillRootSet } from '../main/modules/tools/skill-primitives/root-resolver'

function makeFixture() {
  const root = mkdtempSync(join(tmpdir(), 'ready-required-method-'))
  const assetRoot = join(root, 'asset')
  const artifactRoot = join(root, 'output')
  const executable = join(root, 'fixture-cli')
  const effectMarker = join(root, 'effect.txt')
  mkdirSync(assetRoot)
  mkdirSync(artifactRoot)
  writeFileSync(executable, [
    '#!/bin/sh',
    'if [ "$1" = "--version" ]; then echo "fixture 1.0"; exit 0; fi',
    `echo invoked > "${effectMarker}"`,
    'if [ "$1" = "large" ]; then i=0; while [ "$i" -lt 9001 ]; do printf x; i=$((i + 1)); done; exit 0; fi',
    'if [ "$1" = "needs-confirmation" ]; then echo "confirmation required" >&2; exit 10; fi',
    'if [ "$1" = "report-pgid" ]; then ps -o pgid= -p $$ | tr -d " "; exit 0; fi',
    'printf \'{"ok":true,"identity":"user"}\\n\'',
  ].join('\n'), 'utf8')
  chmodSync(executable, 0o755)
  const lookup = (skillId: string): SkillRootSet | null => skillId === 'lark-doc'
    ? { skillId, assetRoot, artifactRoot }
    : null
  return {
    root,
    assetRoot,
    artifactRoot,
    executable,
    effectMarker,
    lookup,
    cleanup: () => rmSync(root, { recursive: true, force: true }),
  }
}

test('required method executes only exact argv through the frozen absolute launcher', async () => {
  const fixture = makeFixture()
  try {
    const authority = await resolveFrozenDesktopExecutableAuthority({ program: fixture.executable })
    const out = await executeRunShell(
      { command: 'lark-cli docs +fetch --doc fixture-token' },
      {
        skillId: 'lark-doc',
        lookupSkillRoots: fixture.lookup,
        effectiveAllowlist: new Set(['lark-cli']),
        requiredMethod: {
          methodId: 'lark-doc-fetch',
          commandName: 'lark-cli',
          executableAuthority: authority,
          allowedArgv: [['docs', '+fetch', '--doc', 'fixture-token']],
          expectedStdoutSha256: createHash('sha256').update('{"ok":true,"identity":"user"}\n').digest('hex'),
        },
      },
    )
    assert.equal(out.data?.ok, true)
    assert.equal(out.data?.exitCode, 0)
    assert.equal((out.data?.requiredMethod as Record<string, unknown>).authorityDigest, authority.authorityDigest)
    assert.equal('launchPath' in (out.data?.requiredMethod as Record<string, unknown>), false)
    assert.equal(JSON.stringify(out.data).includes(fixture.executable), false)
    assert.equal(existsSync(fixture.effectMarker), true)
  } finally {
    fixture.cleanup()
  }
})

test('required method inherits the Ready process group instead of creating an unleased group', {
  skip: process.platform === 'win32',
}, async () => {
  const fixture = makeFixture()
  try {
    const authority = await resolveFrozenDesktopExecutableAuthority({ program: fixture.executable })
    const expectedProcessGroup = execFileSync('/bin/ps', [
      '-o', 'pgid=', '-p', String(process.pid),
    ], { encoding: 'utf8' }).trim()
    const expectedStdout = `${expectedProcessGroup}\n`
    const out = await executeRunShell(
      { command: 'lark-cli report-pgid' },
      {
        skillId: 'lark-doc',
        lookupSkillRoots: fixture.lookup,
        effectiveAllowlist: new Set(['lark-cli']),
        requiredMethod: {
          methodId: 'lark-doc-fetch',
          commandName: 'lark-cli',
          executableAuthority: authority,
          allowedArgv: [['report-pgid']],
          expectedStdoutSha256: createHash('sha256').update(expectedStdout).digest('hex'),
        },
      },
    )
    assert.equal(out.data?.stdout, expectedStdout)
  } finally {
    fixture.cleanup()
  }
})

test('required method rejects unread guidance and changed auth before executable effect', async (t) => {
  for (const fixtureCase of [
    {
      name: 'required guidance unread',
      deps: { assertRequiredResourcesRead: () => { throw new Error('unread') } },
      expected: 'required_method_violation',
    },
    {
      name: 'auth identity changed',
      deps: { requiredMethodPreflight: async () => { throw new Error('changed') } },
      expected: 'dependency_identity_drift',
    },
  ]) {
    await t.test(fixtureCase.name, async () => {
      const fixture = makeFixture()
      try {
        const authority = await resolveFrozenDesktopExecutableAuthority({ program: fixture.executable })
        await assert.rejects(
          executeRunShell(
            { command: 'lark-cli docs +fetch --doc fixture-token' },
            {
              skillId: 'lark-doc',
              lookupSkillRoots: fixture.lookup,
              effectiveAllowlist: new Set(['lark-cli']),
              requiredMethod: {
                methodId: 'lark-doc-fetch',
                commandName: 'lark-cli',
                executableAuthority: authority,
                allowedArgv: [['docs', '+fetch', '--doc', 'fixture-token']],
              },
              ...fixtureCase.deps,
            },
          ),
          (error: unknown) => (error as { errorKind?: string }).errorKind === fixtureCase.expected,
        )
        assert.equal(existsSync(fixture.effectMarker), false)
      } finally {
        fixture.cleanup()
      }
    })
  }
})

test('required method rejects a different confirmation authority before spawn', async () => {
  const fixture = makeFixture()
  const alternate = join(fixture.root, 'alternate-cli')
  try {
    writeFileSync(alternate, '#!/bin/sh\necho alternate\n', 'utf8')
    chmodSync(alternate, 0o755)
    const requiredAuthority = await resolveFrozenDesktopExecutableAuthority({ program: fixture.executable })
    const confirmationAuthority = await resolveFrozenDesktopExecutableAuthority({ program: alternate })
    await assert.rejects(
      executeRunShell(
        { command: 'lark-cli docs +fetch --doc fixture-token' },
        {
          skillId: 'lark-doc',
          lookupSkillRoots: fixture.lookup,
          effectiveAllowlist: new Set(['lark-cli']),
          executableAuthority: confirmationAuthority,
          requiredMethod: {
            methodId: 'lark-doc-fetch',
            commandName: 'lark-cli',
            executableAuthority: requiredAuthority,
            allowedArgv: [['docs', '+fetch', '--doc', 'fixture-token']],
          },
        },
      ),
      (error: unknown) => (error as { errorKind?: string }).errorKind === 'dependency_identity_drift',
    )
    assert.equal(existsSync(fixture.effectMarker), false)
  } finally {
    fixture.cleanup()
  }
})

test('required method rejects output that does not match the authorized resource digest', async () => {
  const fixture = makeFixture()
  try {
    const authority = await resolveFrozenDesktopExecutableAuthority({ program: fixture.executable })
    await assert.rejects(
      executeRunShell(
        { command: 'lark-cli docs +fetch --doc fixture-token' },
        {
          skillId: 'lark-doc',
          lookupSkillRoots: fixture.lookup,
          effectiveAllowlist: new Set(['lark-cli']),
          requiredMethod: {
            methodId: 'lark-doc-fetch',
            commandName: 'lark-cli',
            executableAuthority: authority,
            allowedArgv: [['docs', '+fetch', '--doc', 'fixture-token']],
            expectedStdoutSha256: 'f'.repeat(64),
          },
        },
      ),
      (error: unknown) => (error as { errorKind?: string }).errorKind === 'dependency_identity_drift',
    )
  } finally {
    fixture.cleanup()
  }
})

test('required method validates a large result before persistence and returns the complete authorized body', async () => {
  const fixture = makeFixture()
  try {
    const authority = await resolveFrozenDesktopExecutableAuthority({ program: fixture.executable })
    const body = 'x'.repeat(9001)
    const requiredMethod = {
      methodId: 'lark-doc-fetch',
      commandName: 'lark-cli',
      executableAuthority: authority,
      allowedArgv: [['large']],
      expectedStdoutSha256: createHash('sha256').update(body).digest('hex'),
    }
    const output = await executeRunShell(
      { command: 'lark-cli large' },
      {
        skillId: 'lark-doc',
        lookupSkillRoots: fixture.lookup,
        effectiveAllowlist: new Set(['lark-cli']),
        requiredMethod,
      },
    )
    assert.equal(output.data?.stdout, body)
    assert.equal(output.data?.stdoutTruncated, false)
    assert.equal(output.data?.stdoutArtifactPath, null)
    assert.deepEqual(readdirSync(fixture.artifactRoot), [])

    await assert.rejects(
      executeRunShell(
        { command: 'lark-cli large' },
        {
          skillId: 'lark-doc',
          lookupSkillRoots: fixture.lookup,
          effectiveAllowlist: new Set(['lark-cli']),
          requiredMethod: { ...requiredMethod, expectedStdoutSha256: 'f'.repeat(64) },
        },
      ),
      (error: unknown) => (error as { errorKind?: string }).errorKind === 'dependency_identity_drift',
    )
    assert.deepEqual(readdirSync(fixture.artifactRoot), [])
  } finally {
    fixture.cleanup()
  }
})

test('required method rejects alternate argv before any executable effect', async () => {
  const fixture = makeFixture()
  try {
    const authority = await resolveFrozenDesktopExecutableAuthority({ program: fixture.executable })
    await assert.rejects(
      executeRunShell(
        { command: 'lark-cli docs +fetch --doc wrong-token' },
        {
          skillId: 'lark-doc',
          lookupSkillRoots: fixture.lookup,
          effectiveAllowlist: new Set(['lark-cli']),
          requiredMethod: {
            methodId: 'lark-doc-fetch',
            commandName: 'lark-cli',
            executableAuthority: authority,
            allowedArgv: [['docs', '+fetch', '--doc', 'fixture-token']],
          },
        },
      ),
      (error: unknown) => (error as { errorKind?: string }).errorKind === 'required_method_violation',
    )
    assert.equal(existsSync(fixture.effectMarker), false)
  } finally {
    fixture.cleanup()
  }
})

test('required method rejects non-empty stdin before any executable effect', async () => {
  const fixture = makeFixture()
  try {
    const authority = await resolveFrozenDesktopExecutableAuthority({ program: fixture.executable })
    await assert.rejects(
      executeRunShell(
        {
          command: 'lark-cli docs +fetch --doc fixture-token',
          stdin: 'unexpected input',
        },
        {
          skillId: 'lark-doc',
          lookupSkillRoots: fixture.lookup,
          effectiveAllowlist: new Set(['lark-cli']),
          requiredMethod: {
            methodId: 'lark-doc-fetch',
            commandName: 'lark-cli',
            executableAuthority: authority,
            allowedArgv: [['docs', '+fetch', '--doc', 'fixture-token']],
          },
        },
      ),
      (error: unknown) => (error as { errorKind?: string }).errorKind === 'required_method_violation',
    )
    assert.equal(existsSync(fixture.effectMarker), false)
  } finally {
    fixture.cleanup()
  }
})

test('required method reports exit 10 as confirmation_required without retrying', async () => {
  const fixture = makeFixture()
  try {
    const authority = await resolveFrozenDesktopExecutableAuthority({ program: fixture.executable })
    const out = await executeRunShell(
      { command: 'lark-cli needs-confirmation' },
      {
        skillId: 'lark-doc',
        lookupSkillRoots: fixture.lookup,
        effectiveAllowlist: new Set(['lark-cli']),
        requiredMethod: {
          methodId: 'lark-doc-fetch',
          commandName: 'lark-cli',
          executableAuthority: authority,
          allowedArgv: [['needs-confirmation']],
        },
      },
    )
    assert.equal(out.data?.ok, false)
    assert.equal(out.data?.exitCode, 10)
    assert.equal(out.data?.errorKind, 'confirmation_required')
  } finally {
    fixture.cleanup()
  }
})

test('required method rejects payload drift before executing it', async () => {
  const fixture = makeFixture()
  try {
    const authority = await resolveFrozenDesktopExecutableAuthority({ program: fixture.executable })
    writeFileSync(fixture.executable, '#!/bin/sh\necho changed\n', 'utf8')
    chmodSync(fixture.executable, 0o755)
    await assert.rejects(
      executeRunShell(
        { command: 'lark-cli docs +fetch --doc fixture-token' },
        {
          skillId: 'lark-doc',
          lookupSkillRoots: fixture.lookup,
          effectiveAllowlist: new Set(['lark-cli']),
          requiredMethod: {
            methodId: 'lark-doc-fetch',
            commandName: 'lark-cli',
            executableAuthority: authority,
            allowedArgv: [['docs', '+fetch', '--doc', 'fixture-token']],
          },
        },
      ),
      (error: unknown) => (error as { errorKind?: string }).errorKind === 'dependency_identity_drift',
    )
    assert.equal(existsSync(fixture.effectMarker), false)
  } finally {
    fixture.cleanup()
  }
})

test('required method keeps the verified result when the installed path is atomically replaced before spawn', async () => {
  const fixture = makeFixture()
  const maliciousMarker = join(fixture.root, 'malicious.txt')
  try {
    const authority = await resolveFrozenDesktopExecutableAuthority({ program: fixture.executable })
    const replacement = join(fixture.root, 'replacement-cli')
    const replacingSpawn = ((bin: string, args: string[], options: Parameters<typeof spawn>[2]) => {
      writeFileSync(replacement, [
        '#!/bin/sh',
        `echo malicious > "${maliciousMarker}"`,
      ].join('\n'), 'utf8')
      chmodSync(replacement, 0o755)
      renameSync(replacement, fixture.executable)
      return spawn(bin, args, options)
    }) as typeof spawn

    const out = await executeRunShell(
      { command: 'lark-cli docs +fetch --doc fixture-token' },
      {
        skillId: 'lark-doc',
        lookupSkillRoots: fixture.lookup,
        effectiveAllowlist: new Set(['lark-cli']),
        spawnFn: replacingSpawn,
        requiredMethod: {
          methodId: 'lark-doc-fetch',
          commandName: 'lark-cli',
          executableAuthority: authority,
          allowedArgv: [['docs', '+fetch', '--doc', 'fixture-token']],
        },
      },
    )
    assert.equal(out.data?.ok, true)
    assert.equal(out.data?.exitCode, 0)
    assert.equal(existsSync(fixture.effectMarker), true)
    assert.equal(existsSync(maliciousMarker), false)
    assert.deepEqual(readdirSync(fixture.artifactRoot), [])
  } finally {
    fixture.cleanup()
  }
})

test('required method never scans or removes user output that resembles an executable snapshot', async () => {
  const fixture = makeFixture()
  const userOutput = join(fixture.artifactRoot, '.ready-executable-999999-report')
  try {
    mkdirSync(userOutput)
    writeFileSync(join(userOutput, 'sentinel'), 'keep')
    const authority = await resolveFrozenDesktopExecutableAuthority({ program: fixture.executable })
    const out = await executeRunShell(
      { command: 'lark-cli docs +fetch --doc fixture-token' },
      {
        skillId: 'lark-doc',
        lookupSkillRoots: fixture.lookup,
        effectiveAllowlist: new Set(['lark-cli']),
        requiredMethod: {
          methodId: 'lark-doc-fetch',
          commandName: 'lark-cli',
          executableAuthority: authority,
          allowedArgv: [['docs', '+fetch', '--doc', 'fixture-token']],
        },
      },
    )
    assert.equal(out.data?.ok, true)
    assert.equal(readFileSync(join(userOutput, 'sentinel'), 'utf8'), 'keep')
  } finally {
    fixture.cleanup()
  }
})
