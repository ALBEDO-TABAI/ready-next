import assert from 'node:assert/strict'
import test from 'node:test'
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { resolveGlobalLarkCliExecutableAuthority } from '../main/modules/skills-runtime/lark-cli-executable-authority'

function makeLarkCli(root: string, label: string): string {
  const path = join(root, 'lark-cli')
  writeFileSync(path, `#!/bin/sh\nif [ "$1" = "--version" ]; then echo "${label} 1.0"; exit 0; fi\necho "${label}"\n`, 'utf8')
  chmodSync(path, 0o755)
  return path
}

test('global Lark CLI authority ignores ambient PATH and freezes the trusted installation', async () => {
  const trustedRoot = mkdtempSync(join(tmpdir(), 'ready-lark-trusted-'))
  const maliciousRoot = mkdtempSync(join(tmpdir(), 'ready-lark-malicious-'))
  try {
    const trustedPath = makeLarkCli(trustedRoot, 'trusted')
    makeLarkCli(maliciousRoot, 'malicious')
    const authority = await resolveGlobalLarkCliExecutableAuthority({
      env: { PATH: maliciousRoot },
      platform: process.platform,
      searchDirectories: [trustedRoot],
    })
    assert.equal(authority.outerPath, trustedPath)
    assert.equal(authority.version, 'trusted 1.0')
    assert.notEqual(authority.outerPath, join(maliciousRoot, 'lark-cli'))
  } finally {
    rmSync(trustedRoot, { recursive: true, force: true })
    rmSync(maliciousRoot, { recursive: true, force: true })
  }
})

test('production Lark CLI authority fails closed when only a global wrapper remains', async () => {
  const fakeAppData = mkdtempSync(join(tmpdir(), 'ready-lark-wrapper-only-'))
  try {
    const npmBin = join(fakeAppData, 'npm')
    mkdirSync(npmBin, { recursive: true })
    makeLarkCli(npmBin, 'wrapper-only')
    await assert.rejects(
      resolveGlobalLarkCliExecutableAuthority({
        env: { APPDATA: fakeAppData, LOCALAPPDATA: fakeAppData, PATH: npmBin },
        platform: 'win32',
      }),
      (error: unknown) => (
        error instanceof Error
        && 'code' in error
        && error.code === 'dependency_unavailable'
      ),
    )
  } finally {
    rmSync(fakeAppData, { recursive: true, force: true })
  }
})
