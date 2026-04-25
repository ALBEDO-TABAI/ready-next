/**
 * workspace-validation tests.
 *
 * Guards the post-bb529f1 fix where the FTS5 indexer would happily scan a
 * 681K-file home directory if the user's chosen workspace root was too broad.
 *
 * Coverage:
 *   - empty / non-absolute inputs → reason: 'empty' / 'not_absolute'
 *   - exact forbidden roots (/, /Users, /Users/alice, /home/x, /tmp, /var, ...)
 *   - whole-drive roots (Windows C:\, /Volumes/Drive)
 *   - top-level personal dirs (~/Library, ~/Desktop, ~/Documents) via homeDir
 *     and via structural /Users/<x>/<leaf> matching when no homeDir is supplied
 *   - too-short paths (< 4 segments)
 *   - safe roots (~/Documents/MyProject, /Users/alice/Documents/X)
 *   - accessCheck failure → 'no_read_permission'
 *   - error messages always present + non-empty
 */

import assert from 'node:assert/strict'
import test from 'node:test'

import { validateWorkspaceRoot } from '../shared/workspace-validation'

test('empty input rejected', () => {
  for (const input of [null, undefined, '', '   ']) {
    const r = validateWorkspaceRoot(input as string)
    assert.equal(r.ok, false)
    assert.equal(r.reason, 'empty')
    assert.ok(r.message && r.message.length > 0)
  }
})

test('non-absolute path rejected', () => {
  const r = validateWorkspaceRoot('relative/path')
  assert.equal(r.ok, false)
  assert.equal(r.reason, 'not_absolute')
  assert.ok(r.message && r.message.length > 0)
})

test('literal ~ rejected', () => {
  for (const input of ['~', '~/']) {
    const r = validateWorkspaceRoot(input)
    assert.equal(r.ok, false)
    assert.equal(r.reason, 'forbidden_user_root')
  }
})

test('forbidden system roots rejected (exact match)', () => {
  const forbiddenSystemRoots = [
    '/',
    '/Users',
    '/Users/Shared',
    '/home',
    '/root',
    '/tmp',
    '/var',
    '/etc',
    '/usr',
    '/opt',
    '/private',
    '/System',
    '/Library',
    '/Applications',
    '/bin',
    '/sbin',
  ]
  for (const root of forbiddenSystemRoots) {
    const r = validateWorkspaceRoot(root)
    assert.equal(r.ok, false, `expected ${root} to be rejected`)
    assert.equal(r.reason, 'forbidden_system_root', `wrong reason for ${root}`)
    assert.ok(r.message && r.message.length > 0)
  }
})

test('exact match also handles trailing slashes', () => {
  // '/Users/' should normalize to '/Users' and still be rejected
  const r = validateWorkspaceRoot('/Users/')
  assert.equal(r.ok, false)
  assert.equal(r.reason, 'forbidden_system_root')
})

test('user home directory rejected', () => {
  const r = validateWorkspaceRoot('/Users/alice')
  assert.equal(r.ok, false)
  assert.equal(r.reason, 'forbidden_user_root')
  assert.ok(r.message && r.message.length > 0)
})

test('linux-style /home/<x> rejected', () => {
  const r = validateWorkspaceRoot('/home/bob')
  assert.equal(r.ok, false)
  assert.equal(r.reason, 'forbidden_user_root')
})

test('Windows drive roots rejected', () => {
  for (const root of ['C:\\', 'C:/', 'D:\\']) {
    const r = validateWorkspaceRoot(root)
    assert.equal(r.ok, false, `expected ${root} to be rejected`)
    assert.equal(r.reason, 'forbidden_drive_root')
  }
})

test('whole /Volumes drives rejected', () => {
  for (const root of ['/Volumes', '/Volumes/MyExternalDrive']) {
    const r = validateWorkspaceRoot(root)
    assert.equal(r.ok, false, `expected ${root} to be rejected`)
    assert.equal(r.reason, 'forbidden_drive_root')
  }
})

test('top-level personal dirs rejected via homeDir', () => {
  const homeDir = '/Users/alice'
  const personalDirs = [
    '/Users/alice/Library',
    '/Users/alice/Desktop',
    '/Users/alice/Documents',
    '/Users/alice/Downloads',
    '/Users/alice/Movies',
    '/Users/alice/Music',
    '/Users/alice/Pictures',
  ]
  for (const dir of personalDirs) {
    const r = validateWorkspaceRoot(dir, { homeDir })
    assert.equal(r.ok, false, `expected ${dir} to be rejected`)
    assert.equal(r.reason, 'forbidden_personal_dir', `wrong reason for ${dir}`)
  }
})

test('top-level personal dirs rejected structurally without homeDir', () => {
  // Without homeDir, we still catch /Users/<anyone>/<personal-leaf>
  const r = validateWorkspaceRoot('/Users/bob/Library')
  assert.equal(r.ok, false)
  assert.equal(r.reason, 'forbidden_personal_dir')
})

test('homeDir itself rejected when path equals it', () => {
  const r = validateWorkspaceRoot('/Users/alice', { homeDir: '/Users/alice' })
  assert.equal(r.ok, false)
  // Could be 'forbidden_user_root' (caught by /Users/<x> rule first)
  assert.ok(r.reason === 'forbidden_user_root' || r.reason === 'forbidden_personal_dir')
})

test('paths shorter than 4 components rejected as too_short', () => {
  // /opt/foo → 2 segs (after /opt is in exact list, try /custom/foo)
  // Use a path that isn't in FORBIDDEN_EXACT_ROOTS
  const r = validateWorkspaceRoot('/custom/foo')
  assert.equal(r.ok, false)
  assert.equal(r.reason, 'too_short')
})

test('3-segment path rejected as too_short', () => {
  // /Users/alice/Projects — 3 segs (Projects isn't in FORBIDDEN_HOME_LEAVES)
  const r = validateWorkspaceRoot('/Users/alice/Projects')
  assert.equal(r.ok, false)
  assert.equal(r.reason, 'too_short')
})

test('safe roots accepted (4+ components, not personal-dir leaves)', () => {
  const safeRoots = [
    '/Users/alice/Documents/MyProject',
    '/Users/alice/Documents/实验田/Y',
    '/Users/alice/Code/some-app/src',
    '/Volumes/MyDrive/projects/app',
    '/home/bob/work/repo',
    '/var/www/sites/example',
  ]
  for (const root of safeRoots) {
    const r = validateWorkspaceRoot(root)
    assert.equal(r.ok, true, `expected ${root} to be accepted, got ${r.reason}: ${r.message}`)
  }
})

test('safe root with homeDir context still accepted', () => {
  const r = validateWorkspaceRoot('/Users/alice/Documents/projects/web', {
    homeDir: '/Users/alice',
  })
  assert.equal(r.ok, true)
})

test('accessCheck failure rejected as no_read_permission', () => {
  const r = validateWorkspaceRoot('/Users/alice/Documents/MyProject', {
    accessCheck: () => false,
  })
  assert.equal(r.ok, false)
  assert.equal(r.reason, 'no_read_permission')
  assert.ok(r.message && r.message.length > 0)
})

test('accessCheck throwing is treated as no_read_permission', () => {
  const r = validateWorkspaceRoot('/Users/alice/Documents/MyProject', {
    accessCheck: () => {
      throw new Error('EACCES')
    },
  })
  assert.equal(r.ok, false)
  assert.equal(r.reason, 'no_read_permission')
})

test('accessCheck succeeding allows safe path', () => {
  const r = validateWorkspaceRoot('/Users/alice/Documents/MyProject', {
    accessCheck: () => true,
  })
  assert.equal(r.ok, true)
})

test('all rejection reasons emit a user-facing message', () => {
  const cases: Array<[string | null | undefined, string]> = [
    [null, 'empty'],
    ['relative/x/y/z', 'not_absolute'],
    ['/Users', 'forbidden_system_root'],
    ['/Users/alice', 'forbidden_user_root'],
    ['/Volumes/SSD', 'forbidden_drive_root'],
    ['/Users/alice/Library', 'forbidden_personal_dir'],
    ['/a/b/c', 'too_short'],
  ]
  for (const [input, expectedReason] of cases) {
    const r = validateWorkspaceRoot(input as string)
    assert.equal(r.ok, false, `${input} should reject`)
    assert.equal(r.reason, expectedReason, `${input} reason mismatch`)
    assert.ok(
      r.message && r.message.length > 0,
      `${input} (${expectedReason}) missing user-facing message`,
    )
  }
})
