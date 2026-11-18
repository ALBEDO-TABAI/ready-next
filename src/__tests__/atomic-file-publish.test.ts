import assert from 'node:assert/strict'
import {
  access,
  chmod,
  copyFile,
  link,
  lstat,
  mkdtemp,
  open,
  realpath,
  readFile,
  readdir,
  rename,
  rm,
  stat,
  symlink,
  unlink,
  writeFile,
} from 'node:fs/promises'
import { execFile } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import test from 'node:test'

import {
  publishFileAtomically,
  type AtomicPublishFileOps,
} from '../main/modules/document-engine/atomic-file-publish'

const execFileAsync = promisify(execFile)

test('atomic publish replaces the target and leaves no temporary file', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'ready-atomic-publish-'))
  try {
    const target = join(directory, 'note.md')
    await writeFile(target, 'old')
    await publishFileAtomically(target, 'new')
    assert.equal(await readFile(target, 'utf8'), 'new')
    assert.deepEqual((await readdir(directory)).sort(), ['note.md'])
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

test('atomic publish preserves target permission bits', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'ready-atomic-mode-'))
  try {
    const target = join(directory, 'note.md')
    await writeFile(target, 'old')
    await chmod(target, 0o660)
    const originalMode = (await stat(target)).mode & 0o777
    await publishFileAtomically(target, 'new')
    assert.equal((await stat(target)).mode & 0o777, originalMode)
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

if (process.platform === 'darwin') {
  test('atomic publish preserves macOS extended attributes, ACLs, and ownership', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'ready-atomic-metadata-'))
    const target = join(directory, 'note.md')
    try {
      await writeFile(target, 'old')
      await execFileAsync('xattr', ['-w', 'com.ready.audit', 'kept', target])
      await execFileAsync('chmod', ['+a', 'everyone deny delete', target])
      const before = await stat(target)

      await publishFileAtomically(target, 'new')

      const after = await stat(target)
      const { stdout: attribute } = await execFileAsync('xattr', ['-p', 'com.ready.audit', target], { encoding: 'utf8' })
      const { stdout: acl } = await execFileAsync('ls', ['-le', target], { encoding: 'utf8' })
      assert.equal(await readFile(target, 'utf8'), 'new')
      assert.equal(attribute.trim(), 'kept')
      assert.match(acl, /deny delete/)
      assert.equal(after.uid, before.uid)
      assert.equal(after.gid, before.gid)
    } finally {
      await execFileAsync('chmod', ['-a#', '0', target]).catch(() => undefined)
      await rm(directory, { recursive: true, force: true })
    }
  })
}

test('atomic publish rejects a read-only target without replacing it', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'ready-atomic-readonly-'))
  try {
    const target = join(directory, 'note.md')
    await writeFile(target, 'old')
    await chmod(target, 0o444)
    await assert.rejects(publishFileAtomically(target, 'new'), /目标文件不可写/)
    assert.equal(await readFile(target, 'utf8'), 'old')
    assert.deepEqual((await readdir(directory)).sort(), ['note.md'])
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

test('atomic publish follows a symbolic link without replacing the link', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'ready-atomic-symlink-'))
  try {
    const target = join(directory, 'note.md')
    const linkedPath = join(directory, 'linked.md')
    await writeFile(target, 'old')
    await symlink(target, linkedPath)
    await publishFileAtomically(linkedPath, 'new')
    assert.equal(await readFile(target, 'utf8'), 'new')
    assert.equal((await lstat(linkedPath)).isSymbolicLink(), true)
    assert.deepEqual((await readdir(directory)).sort(), ['linked.md', 'note.md'])
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

test('atomic publish rejects multiply-linked files rather than silently breaking link identity', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'ready-atomic-hardlink-'))
  try {
    const target = join(directory, 'note.md')
    const linkedPath = join(directory, 'linked.md')
    await writeFile(target, 'old')
    await link(target, linkedPath)
    await assert.rejects(publishFileAtomically(target, 'new'), /多重硬链接/)
    assert.equal(await readFile(target, 'utf8'), 'old')
    assert.equal(await readFile(linkedPath, 'utf8'), 'old')
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

test('Windows backup-swap restores the original target when replacement fails', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'ready-atomic-rollback-'))
  try {
    const target = join(directory, 'note.md')
    await writeFile(target, 'original')
    const ops: AtomicPublishFileOps = {
      access,
      copyFile,
      lstat,
      open,
      realpath,
      stat,
      unlink,
      rename: async (from, to) => {
        if (from.includes('.ready-tmp-') && to === target) throw new Error('injected replace failure')
        await rename(from, to)
      },
    }

    await assert.rejects(
      publishFileAtomically(target, 'replacement', { platform: 'win32', ops }),
      /injected replace failure/,
    )
    assert.equal(await readFile(target, 'utf8'), 'original')
    assert.deepEqual((await readdir(directory)).sort(), ['note.md'])
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

test('Windows backup-swap exposes and preserves the backup when replacement and restore both fail', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'ready-atomic-windows-double-failure-'))
  try {
    const target = join(directory, 'note.md')
    await writeFile(target, 'original')
    const ops: AtomicPublishFileOps = {
      access,
      copyFile,
      lstat,
      open,
      realpath,
      stat,
      unlink,
      rename: async (from, to) => {
        if (to === target && (from.includes('.ready-tmp-') || from.includes('.ready-swap-'))) {
          throw new Error(from.includes('.ready-tmp-') ? 'injected replacement failure' : 'injected restore failure')
        }
        await rename(from, to)
      },
    }

    let backupPath = ''
    await assert.rejects(
      publishFileAtomically(target, 'replacement', { platform: 'win32', ops }),
      (error: AggregateError & { backupPath?: string }) => {
        backupPath = error.backupPath || ''
        assert.match(error.message, /原文件备份保留在/)
        assert.equal(error.errors.length, 2)
        return true
      },
    )
    assert.ok(backupPath)
    assert.equal(await readFile(backupPath, 'utf8'), 'original')
    assert.deepEqual(
      (await readdir(directory)).filter((name) => name.includes('.ready-tmp-')),
      [],
    )
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

test('atomic publish does not treat permission and IO errors as a missing target', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'ready-atomic-errors-'))
  try {
    const target = join(directory, 'note.md')
    await writeFile(target, 'old')
    const denied = Object.assign(new Error('denied'), { code: 'EACCES' })
    const broken = Object.assign(new Error('io failure'), { code: 'EIO' })
    const base: AtomicPublishFileOps = { access, copyFile, lstat, open, realpath, rename, stat, unlink }

    await assert.rejects(
      publishFileAtomically(target, 'new', {
        ops: { ...base, lstat: async () => { throw denied } },
      }),
      (error: NodeJS.ErrnoException) => error.code === 'EACCES',
    )
    await assert.rejects(
      publishFileAtomically(target, 'new', {
        ops: { ...base, stat: async () => { throw broken } },
      }),
      (error: NodeJS.ErrnoException) => error.code === 'EIO',
    )
    assert.equal(await readFile(target, 'utf8'), 'old')
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

test('in-place replacement keeps the original backup when replacement and restore both fail', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'ready-atomic-double-failure-'))
  try {
    const target = join(directory, 'note.md')
    await writeFile(target, 'original')
    let targetWriteCount = 0
    const base: AtomicPublishFileOps = { access, copyFile, lstat, open, realpath, rename, stat, unlink }
    const ops: AtomicPublishFileOps = {
      ...base,
      cloneFilePreservingMetadata: async () => { throw new Error('force in-place replacement') },
      copyFile: async (from, to) => {
        if (to === target) {
          targetWriteCount += 1
          await writeFile(target, 'partial')
          throw new Error(targetWriteCount === 1 ? 'injected replacement failure' : 'injected restore failure')
        }
        await copyFile(from, to)
      },
    }

    let backupPath = ''
    await assert.rejects(
      publishFileAtomically(target, 'replacement', { platform: 'darwin', ops }),
      (error: AggregateError & { backupPath?: string }) => {
        backupPath = error.backupPath || ''
        assert.match(error.message, /原文件备份保留在/)
        assert.equal(error.errors.length, 2)
        return true
      },
    )

    assert.equal(await readFile(target, 'utf8'), 'partial')
    assert.ok(backupPath)
    assert.equal(await readFile(backupPath, 'utf8'), 'original')
    assert.deepEqual(
      (await readdir(directory)).filter((name) => name.includes('.ready-tmp-')),
      [],
    )
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})
