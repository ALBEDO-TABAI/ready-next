/**
 * B Phase 1 PR1 — path-sandbox.ts unit tests. Pure module; no electron deps.
 */

import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  PathSandboxError,
  RESERVED_FILE_NAMES,
  assertNotReservedPath,
  resolveWritableWithinRoot,
  resolveWithinRoot,
} from '../main/modules/tools/skill-primitives/path-sandbox'

// macOS `/tmp` is a symlink to `/private/tmp`; resolveWithinRoot canonicalizes
// the sandbox root before use so startsWith checks work. Tests must compare
// against the canonical form too.
function createSandboxRoot(): string {
  return realpathSync.native(mkdtempSync(join(tmpdir(), 'skill-prim-sandbox-')))
}

test('resolveWithinRoot accepts a plain relative path under the root', () => {
  const root = createSandboxRoot()
  try {
    const abs = resolveWithinRoot(root, 'output/result.json')
    assert.ok(abs.startsWith(root))
    assert.ok(abs.endsWith('output/result.json'))
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('resolveWithinRoot rejects absolute paths', () => {
  const root = createSandboxRoot()
  try {
    assert.throws(
      () => resolveWithinRoot(root, '/etc/passwd'),
      (error: unknown) => error instanceof PathSandboxError && error.reason === 'absolute_path',
    )
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('resolveWritableWithinRoot accepts an absolute path inside the root', () => {
  const root = createSandboxRoot()
  try {
    const abs = resolveWritableWithinRoot(root, join(root, 'output', 'result.json'))
    assert.equal(abs, join(root, 'output', 'result.json'))
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('resolveWritableWithinRoot rejects an absolute path outside the root', () => {
  const root = createSandboxRoot()
  const outside = createSandboxRoot()
  try {
    assert.throws(
      () => resolveWritableWithinRoot(root, join(outside, 'result.json')),
      (error: unknown) => error instanceof PathSandboxError && error.reason === 'path_escape',
    )
  } finally {
    rmSync(root, { recursive: true, force: true })
    rmSync(outside, { recursive: true, force: true })
  }
})

test('resolveWithinRoot rejects home-directory shorthand paths', () => {
  const root = createSandboxRoot()
  try {
    assert.throws(
      () => resolveWithinRoot(root, '~/result.json'),
      (error: unknown) => error instanceof PathSandboxError && error.reason === 'home_path',
    )
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('resolveWithinRoot rejects empty and non-string paths', () => {
  const root = createSandboxRoot()
  try {
    assert.throws(
      () => resolveWithinRoot(root, ''),
      (error: unknown) => error instanceof PathSandboxError && error.reason === 'empty_path',
    )
    assert.throws(
      () => resolveWithinRoot(root, '   '),
      (error: unknown) => error instanceof PathSandboxError && error.reason === 'empty_path',
    )
    assert.throws(
      () => resolveWithinRoot(root, null as unknown as string),
      (error: unknown) => error instanceof PathSandboxError && error.reason === 'empty_path',
    )
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('resolveWithinRoot rejects `..` escapes even when the resolved path happens to stay inside', () => {
  const root = createSandboxRoot()
  try {
    assert.throws(
      () => resolveWithinRoot(root, '../../etc/passwd'),
      (error: unknown) => error instanceof PathSandboxError && error.reason === 'path_escape',
    )
    // `a/../b` normalizes to `b` under the root — that's allowed (no escape).
    const ok = resolveWithinRoot(root, 'a/../b/c.json')
    assert.ok(ok.startsWith(root))
    assert.ok(ok.endsWith('b/c.json'))
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('resolveWithinRoot rejects a symlink whose target lives outside the sandbox', () => {
  const root = createSandboxRoot()
  const outside = createSandboxRoot()
  try {
    // Create a file outside the sandbox, then symlink it into the sandbox.
    const outsideFile = join(outside, 'secret.txt')
    writeFileSync(outsideFile, 'hunter2', 'utf-8')
    const linkInside = join(root, 'link-to-secret')
    symlinkSync(outsideFile, linkInside)
    assert.throws(
      () => resolveWithinRoot(root, 'link-to-secret'),
      (error: unknown) => error instanceof PathSandboxError && error.reason === 'symlink_escape',
    )
  } finally {
    rmSync(root, { recursive: true, force: true })
    rmSync(outside, { recursive: true, force: true })
  }
})

test('resolveWithinRoot rejects writing through a symlinked parent directory', () => {
  const root = createSandboxRoot()
  const outside = createSandboxRoot()
  try {
    // Symlink `<root>/evil-parent` → outside dir; writing
    // `<root>/evil-parent/secret.txt` would escape.
    const linkInside = join(root, 'evil-parent')
    symlinkSync(outside, linkInside)
    assert.throws(
      () => resolveWithinRoot(root, 'evil-parent/secret.txt'),
      (error: unknown) => error instanceof PathSandboxError && error.reason === 'symlink_escape',
    )
  } finally {
    rmSync(root, { recursive: true, force: true })
    rmSync(outside, { recursive: true, force: true })
  }
})

test('assertNotReservedPath refuses reserved filenames regardless of subdirectory depth', () => {
  assert.throws(
    () => assertNotReservedPath('/tmp/anything/SKILL.md'),
    (error: unknown) => error instanceof PathSandboxError && error.reason === 'reserved_path',
  )
  assert.throws(
    () => assertNotReservedPath('/tmp/ready-skill.json'),
    (error: unknown) => error instanceof PathSandboxError && error.reason === 'reserved_path',
  )
  // Non-reserved names pass through
  assertNotReservedPath('/tmp/output/result.json')
  assertNotReservedPath('/tmp/data/SKILL.md.bak')
})

test('RESERVED_FILE_NAMES covers the expected B-Phase-1 set', () => {
  assert.ok(RESERVED_FILE_NAMES.has('SKILL.md'))
  assert.ok(RESERVED_FILE_NAMES.has('ready-skill.json'))
  assert.ok(RESERVED_FILE_NAMES.has('skill.workflow.json'))
  assert.ok(RESERVED_FILE_NAMES.has('MANIFEST.json'))
})
