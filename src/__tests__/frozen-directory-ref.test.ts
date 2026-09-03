import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import {
  resolveFrozenDirectoryRef,
  resolveFrozenFileRef,
  resolveFrozenResourceRef,
  authorizeRoot,
} from '../main/modules/tools/file-management-runtime'
import { executeFileManagementTool, resolveFileToolDirectoryAliases } from '../main/modules/tools/file-management-tools'
import { executeExportArtifact } from '../main/modules/tools/skill-primitives'

function tmpRoot(): string {
  return mkdtempSync(join(tmpdir(), 'ready-frozen-dir-'))
}

test('frozen directory aliases resolve mention, logical id, and nested file targets', () => {
  const alias = {
    logicalResourceId: 'local-directory:0990e072e69d96c50d49a94eafbc8105',
    name: '工作内容',
    path: '/Users/user/实验田/测试/lib-a/工作内容',
  }
  assert.deepEqual(resolveFrozenDirectoryRef('@[工作内容]', [alias]), { kind: 'resolved', path: alias.path })
  assert.deepEqual(resolveFrozenDirectoryRef('/@[工作内容]', [alias]), { kind: 'resolved', path: alias.path })
  assert.deepEqual(
    resolveFrozenDirectoryRef(alias.logicalResourceId, [alias]),
    { kind: 'resolved', path: alias.path },
  )
  assert.deepEqual(
    resolveFrozenDirectoryRef(`/${alias.logicalResourceId}`, [alias]),
    { kind: 'resolved', path: alias.path },
  )
  assert.deepEqual(
    resolveFrozenDirectoryRef('@[工作内容]/西村贵教.md', [alias]),
    { kind: 'resolved', path: join(alias.path, '西村贵教.md') },
  )
  assert.deepEqual(
    resolveFrozenDirectoryRef(`${alias.logicalResourceId}/西村贵教.md`, [alias]),
    { kind: 'resolved', path: join(alias.path, '西村贵教.md') },
  )
  assert.deepEqual(resolveFrozenDirectoryRef(alias.path, [alias]), { kind: 'resolved', path: alias.path })
})

test('frozen file aliases resolve exact mentions and reject ambiguous names or child paths', () => {
  const first = {
    logicalResourceId: 'local-file:first',
    name: 'note.md',
    path: '/Users/user/Documents/first/note.md',
    currentDigest: 'a'.repeat(64),
  }
  const second = {
    logicalResourceId: 'local-file:second',
    name: 'note.md',
    path: '/Users/user/Documents/second/note.md',
    currentDigest: 'b'.repeat(64),
  }
  assert.equal(resolveFrozenFileRef(first.path, [first]), first)
  assert.equal(resolveFrozenFileRef(first.logicalResourceId, [first]), first)
  assert.equal(resolveFrozenFileRef(`/${first.logicalResourceId}`, [first]), first)
  assert.equal(resolveFrozenFileRef('@[note.md]', [first]), first)
  assert.equal(resolveFrozenFileRef('note.md', [first]), first)
  assert.equal(resolveFrozenFileRef('note.md/child', [first]), null)
  assert.equal(resolveFrozenFileRef('note.md', [first, second]), null)
  assert.equal(resolveFrozenFileRef(first.logicalResourceId, [first, second]), first)
})

test('file_inventory accepts the live mention and logical-id aliases', async () => {
  const root = tmpRoot()
  try {
    const folder = join(root, '工作内容')
    mkdirSync(folder)
    writeFileSync(join(folder, 'note.md'), '# note', 'utf-8')
    const canonical = realpathSync(folder)
    const alias = {
      logicalResourceId: 'local-directory:0990e072e69d96c50d49a94eafbc8105',
      name: '工作内容',
      path: canonical,
    }
    const engine = {
      findWorkspaceRootForPath: (path: string) => (
        path === canonical || path.startsWith(`${canonical}/`) ? canonical : null
      ),
    }
    const context = {
      searchEngine: engine as never,
      workspaceRoots: [canonical],
      directoryAliases: [alias],
    }
    for (const rootPath of ['@[工作内容]', alias.logicalResourceId, `/${alias.logicalResourceId}`]) {
      const inventory = JSON.parse(await executeFileManagementTool('file_inventory', {
        rootPath,
      }, context))
      assert.equal(inventory.ok, true, rootPath)
      assert.equal(inventory.rootPath, canonical)
      assert.equal(inventory.items[0].name, 'note.md')
    }
    const denied = await authorizeRoot('@[工作内容]', engine as never, [canonical], null)
    assert.equal(denied.ok, false)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('same-name directory references fail closed while logical ids remain precise', async () => {
  const root = tmpRoot()
  try {
    const first = join(root, 'first', '共享目录')
    const second = join(root, 'second', '共享目录')
    mkdirSync(first, { recursive: true })
    mkdirSync(second, { recursive: true })
    writeFileSync(join(first, 'first.md'), '# first', 'utf-8')
    writeFileSync(join(second, 'second.md'), '# second', 'utf-8')
    const aliases = [
      { logicalResourceId: 'local-directory:first', name: '共享目录', path: realpathSync(first) },
      { logicalResourceId: 'local-directory:second', name: '共享目录', path: realpathSync(second) },
    ]
    const engine = {
      findWorkspaceRootForPath: (path: string) => aliases.find((alias) => (
        path === alias.path || path.startsWith(`${alias.path}/`)
      ))?.path ?? null,
    }
    const context = {
      searchEngine: engine as never,
      workspaceRoots: aliases.map((alias) => alias.path),
      directoryAliases: aliases,
    }
    const ambiguous = JSON.parse(await executeFileManagementTool(
      'file_inventory', { rootPath: '@[共享目录]' }, context,
    ))
    assert.equal(ambiguous.ok, false)
    assert.equal(ambiguous.errorKind, 'selected_resource_ambiguous')
    for (const alias of aliases) {
      const inventory = JSON.parse(await executeFileManagementTool(
        'file_inventory', { rootPath: alias.logicalResourceId }, context,
      ))
      assert.equal(inventory.ok, true, alias.logicalResourceId)
      assert.equal(inventory.rootPath, alias.path)
    }

    const cwdDocs = realpathSync(join(process.cwd(), 'docs'))
    const secondDocs = join(root, 'second-docs', 'docs')
    mkdirSync(secondDocs, { recursive: true })
    const cwdAliases = [
      { logicalResourceId: 'local-directory:cwd-docs', name: 'docs', path: cwdDocs },
      { logicalResourceId: 'local-directory:other-docs', name: 'docs', path: realpathSync(secondDocs) },
    ]
    const cwdCollision = await authorizeRoot(
      'docs',
      engine as never,
      cwdAliases.map((alias) => alias.path),
      cwdAliases,
    )
    assert.equal(cwdCollision.ok, false)
    if (!cwdCollision.ok) assert.equal(cwdCollision.output.errorKind, 'selected_resource_ambiguous')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('same-name file and directory require a typed logical id', () => {
  const directory = {
    logicalResourceId: 'local-directory:docs',
    name: 'docs.md',
    path: '/Users/user/Documents/folder/docs.md',
  }
  const file = {
    logicalResourceId: 'local-file:docs',
    name: 'docs.md',
    path: '/Users/user/Documents/file/docs.md',
    currentDigest: 'a'.repeat(64),
  }
  assert.equal(resolveFrozenResourceRef('@[docs.md]', [directory], [file])?.kind, 'ambiguous')
  assert.equal(resolveFrozenResourceRef(directory.logicalResourceId, [directory], [file])?.kind, 'directory')
  assert.equal(resolveFrozenResourceRef(file.logicalResourceId, [directory], [file])?.kind, 'file')
})

test('skill_export_artifact accepts mention-prefixed targetPath', async () => {
  const root = tmpRoot()
  try {
    const artifactRoot = join(root, 'artifacts')
    const folder = join(root, '工作内容')
    mkdirSync(artifactRoot, { recursive: true })
    mkdirSync(folder, { recursive: true })
    writeFileSync(join(artifactRoot, 'report.md'), 'hello', 'utf-8')
    const canonical = realpathSync(folder)
    const output = await executeExportArtifact({
      relativePath: 'report.md',
      targetPath: '@[工作内容]/西村贵教.md',
    }, {
      skillId: 'surf-pro',
      lookupSkillRoots: () => ({ skillId: 'surf-pro', assetRoot: join(root, 'asset'), artifactRoot }),
      allowedExportRoots: [canonical],
      directoryAliases: [{
        logicalResourceId: 'local-directory:0990e072e69d96c50d49a94eafbc8105',
        name: '工作内容',
        path: canonical,
      }],
    })
    const exportedPath = (output.data as Record<string, unknown>).absolutePath as string
    assert.equal(exportedPath, join(canonical, '西村贵教.md'))
    assert.match(output.text, /Exported/)

    const secondFolder = join(root, 'other', '工作内容')
    mkdirSync(secondFolder, { recursive: true })
    const secondCanonical = realpathSync(secondFolder)
    await assert.rejects(
      executeExportArtifact({
        relativePath: 'report.md',
        targetPath: '@[工作内容]/ambiguous.md',
      }, {
        skillId: 'surf-pro',
        lookupSkillRoots: () => ({ skillId: 'surf-pro', assetRoot: join(root, 'asset'), artifactRoot }),
        allowedExportRoots: [canonical, secondCanonical],
        directoryAliases: [
          { logicalResourceId: 'local-directory:first', name: '工作内容', path: canonical },
          { logicalResourceId: 'local-directory:second', name: '工作内容', path: secondCanonical },
        ],
      }),
      /more than one selected folder/,
    )
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('request envelope folder_reference becomes a directory alias', () => {
  const aliases = resolveFileToolDirectoryAliases({
    resources: [{
      id: 'local-directory:0990e072e69d96c50d49a94eafbc8105',
      kind: 'folder_reference',
      source: 'folder_reference',
      name: '工作内容',
      path: process.cwd(),
      canRead: true,
    }],
  })
  assert.deepEqual(aliases, [{
    logicalResourceId: 'local-directory:0990e072e69d96c50d49a94eafbc8105',
    name: '工作内容',
    path: process.cwd(),
  }])
})
