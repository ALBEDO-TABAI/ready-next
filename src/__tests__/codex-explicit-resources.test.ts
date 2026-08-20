import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdtemp, mkdir, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import {
  recoverCodexRetryLocalResourceSelections,
  recoverCodexRetrySkillSelection,
  resolveCodexExplicitResources,
} from '../main/modules/agent-control/codex-runtime/codex-explicit-resources'
import {
  executeFileManagementTool,
  resolveFileToolExplicitReadableResources,
} from '../main/modules/tools/file-management-tools'
import type { SearchEngine } from '../main/modules/search-engine/indexer'

test('Main revalidates selected files and emits body-free native/resource contracts', async () => {
  const root = await mkdtemp(join(tmpdir(), 'ready-codex-resources-'))
  try {
    const imagePath = join(root, 'image.png')
    const textPath = join(root, 'notes.txt')
    const directoryPath = join(root, '资料')
    await writeFile(imagePath, Buffer.from('png-bytes'))
    await writeFile(textPath, 'body stays on disk')
    await mkdir(directoryPath)
    const canonicalImagePath = await realpath(imagePath)
    const canonicalTextPath = await realpath(textPath)
    const canonicalDirectoryPath = await realpath(directoryPath)
    const result = await resolveCodexExplicitResources({
      selections: [
        {
          kind: 'local_file', id: 'image', name: 'image.png', path: imagePath,
          size: 1, ext: '.forged', rendererType: 'text',
        },
        {
          kind: 'local_file', id: 'text', name: 'notes.txt', path: textPath,
          size: 99, ext: '.txt', rendererType: 'image',
        },
        { kind: 'local_directory', id: 'folder', name: '资料', path: directoryPath },
      ],
      resolveSkill: () => null,
    })
    assert.deepEqual(result.input, [
      { type: 'localImage', path: canonicalImagePath, detail: null },
      { type: 'mention', name: 'notes.txt', path: canonicalTextPath },
      { type: 'mention', name: '资料', path: canonicalDirectoryPath },
    ])
    assert.equal(result.requestResources.every((resource) => (
      resource.text === '' && resource.summary === null && resource.canWrite === false
    )), true)
    assert.equal(JSON.stringify(result.requestResources).includes('body stays on disk'), false)
    assert.deepEqual(result.authorities.map((authority) => ({
      path: authority.path,
      allowedToolNames: authority.allowedToolNames,
    })), [
      { path: canonicalTextPath, allowedToolNames: ['file_extract_text', 'file_read_excerpt'] },
      { path: canonicalDirectoryPath, allowedToolNames: ['file_inventory'] },
    ])
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('explicit retry recovers the predecessor local targets and revalidates their current bytes', async () => {
  const root = await mkdtemp(join(tmpdir(), 'ready-codex-retry-resources-'))
  try {
    const markdownPath = join(root, 'target.md')
    const imagePath = join(root, 'reference.png')
    const directoryPath = join(root, '输出')
    await writeFile(markdownPath, '# before')
    await writeFile(imagePath, Buffer.from('image-before'))
    await mkdir(directoryPath)
    const predecessor = await resolveCodexExplicitResources({
      selections: [
        {
          kind: 'local_file', id: 'markdown', name: 'target.md', path: markdownPath,
          size: 8, ext: '.md', rendererType: 'text',
        },
        {
          kind: 'local_file', id: 'image', name: 'reference.png', path: imagePath,
          size: 12, ext: '.png', rendererType: 'image',
        },
        { kind: 'local_directory', id: 'folder', name: '输出', path: directoryPath },
      ],
      resolveSkill: () => null,
    })
    const recovered = recoverCodexRetryLocalResourceSelections({
      explicitInput: predecessor.input,
      authorities: predecessor.authorities,
    })
    assert.deepEqual(recovered.map((entry) => entry.selection.kind), [
      'local_file', 'local_file', 'local_directory',
    ])
    assert.deepEqual(recovered.map((entry) => entry.logicalResourceId), predecessor.resourceRefs.map(
      (reference) => reference.logicalResourceId,
    ))

    await writeFile(markdownPath, '# current')
    const retry = await resolveCodexExplicitResources({
      selections: recovered.map((entry) => entry.selection),
      resolveSkill: () => null,
    })
    assert.deepEqual(retry.resourceRefs.map((reference) => reference.logicalResourceId), recovered.map(
      (entry) => entry.logicalResourceId,
    ))
    assert.notEqual(retry.resourceRefs[0]?.currentDigest, predecessor.resourceRefs[0]?.currentDigest)
    assert.equal(retry.input.some((entry) => entry.type === 'mention' && entry.name === 'target.md'), true)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('explicit retry recovers skill identity and applicability candidates for current manifest validation', async () => {
  const selected = recoverCodexRetrySkillSelection({
    mode: 'selected',
    skillId: 'tag-forge',
    allowedTypedActions: ['tag_forge_prepare_batch'],
    allowedPrimitives: ['tag_forge_apply_batch'],
  })
  assert.deepEqual(selected, {
    selection: {
      kind: 'skill',
      id: 'retry-skill:tag-forge',
      name: 'tag-forge',
      path: '',
      skillId: 'tag-forge',
    },
    applicableToolNames: ['tag_forge_prepare_batch', 'tag_forge_apply_batch'],
  })
  assert.equal(recoverCodexRetrySkillSelection({ mode: 'none' }), null)

  const skillPath = join(process.cwd(), 'assets', 'embedded-skills', 'tag-forge')
  const resolved = await resolveCodexExplicitResources({
    selections: [selected!.selection],
    resolveSkill: (selection) => (
      selection.skillId === 'tag-forge' ? { name: 'tag-forge', path: skillPath } : null
    ),
  })
  assert.equal(resolved.input[0]?.type, 'skill')
  assert.equal(resolved.requestResources[0]?.kind, 'skill_reference')
  assert.equal(resolved.requestResources[0]?.name, 'tag-forge')
})

test('explicit and selected skill inputs are Main-validated and deduplicated by canonical path', async () => {
  const root = await mkdtemp(join(tmpdir(), 'ready-codex-skill-'))
  try {
    const skillPath = join(root, 'summary')
    await mkdir(skillPath)
    await writeFile(join(skillPath, 'SKILL.md'), '# Summary\n')
    const canonicalSkillPath = await realpath(skillPath)
    const resolvedSkill = { name: 'summary', path: skillPath }
    const result = await resolveCodexExplicitResources({
      selections: [{
        kind: 'skill', id: 'skill-1', name: 'forged renderer name',
        path: '/forged/path', skillId: 'summary',
      }],
      resolveSkill: () => resolvedSkill,
      selectedSkill: resolvedSkill,
    })
    assert.deepEqual(result.input, [{ type: 'skill', name: 'summary', path: canonicalSkillPath }])
    assert.equal(result.resourceRefs.length, 1)
    assert.equal(result.requestResources.length, 1)
    await writeFile(join(skillPath, 'SKILL.md'), '# Changed summary\n')
    const changed = await resolveCodexExplicitResources({
      selections: [],
      resolveSkill: () => null,
      selectedSkill: resolvedSkill,
    })
    assert.notEqual(changed.resourceRefs[0]?.currentDigest, result.resourceRefs[0]?.currentDigest)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('browser, calendar and document-quote references use Main-resolved or explicit-user text without widening file authority', async () => {
  const result = await resolveCodexExplicitResources({
    selections: [
      { kind: 'browser_tab', id: 'browser-1', name: 'forged title', tabId: 'tab-1' },
      { kind: 'calendar_event', id: 'calendar-1', name: 'forged event', eventId: 'event-1' },
      {
        kind: 'quoted_text', id: 'quote-1', name: '方案.md', text: '用户选中的准确原文',
        documentTitle: '方案.md', sectionTitle: '结论', lineStart: 8, lineEnd: 9,
      },
    ],
    resolveSkill: () => null,
    resolveBrowser: async () => ({
      name: 'Main read title',
      path: 'https://example.com/main-read',
      text: 'MAIN_BROWSER_CONTEXT',
      digest: 'a'.repeat(64),
    }),
    resolveCalendar: () => ({
      name: 'Main calendar title',
      path: 'calendar-event://event-1',
      text: 'MAIN_CALENDAR_CONTEXT',
      digest: 'b'.repeat(64),
    }),
  })

  assert.deepEqual(result.input.map((entry) => entry.type === 'text' ? entry.text : entry.type), [
    'MAIN_BROWSER_CONTEXT',
    'MAIN_CALENDAR_CONTEXT',
    '用户明确引用的文档摘录（只读材料）：方案.md\n章节：结论\n位置：第 8-9 行\n\n用户选中的准确原文',
  ])
  assert.deepEqual(result.requestResources.map((resource) => ({
    kind: resource.kind,
    source: resource.source,
    name: resource.name,
    path: resource.path,
    text: resource.text,
    canWrite: resource.canWrite,
  })), [
    {
      kind: 'browser_reference', source: 'browser_context', name: 'Main read title',
      path: 'https://example.com/main-read', text: '', canWrite: false,
    },
    {
      kind: 'calendar_event', source: 'calendar_context', name: 'Main calendar title',
      path: 'calendar-event://event-1', text: '', canWrite: false,
    },
    {
      kind: 'document_quote', source: 'document_quote', name: '方案.md',
      path: null, text: '', canWrite: false,
    },
  ])
  assert.deepEqual(result.authorities, [])
  assert.equal(result.resourceRefs.length, 3)
})

test('legacy DOC/RTF/ODT selections remain explicitly unsupported', async () => {
  const root = await mkdtemp(join(tmpdir(), 'ready-codex-unsupported-'))
  try {
    for (const extension of ['.doc', '.rtf', '.odt']) {
      const path = join(root, `legacy${extension}`)
      await writeFile(path, 'unsupported')
      await assert.rejects(resolveCodexExplicitResources({
        selections: [{
          kind: 'local_file', id: extension, name: `legacy${extension}`, path,
          size: 11, ext: extension, rendererType: 'text',
        }],
        resolveSkill: () => null,
      }), /codex_explicit_resource_unsupported/)
    }
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('file tools read the exact selected file and fail closed for an unselected sibling', async () => {
  const root = await mkdtemp(join(tmpdir(), 'ready-codex-file-authority-'))
  try {
    const selectedPath = join(root, 'selected.txt')
    const siblingPath = join(root, 'sibling.txt')
    await writeFile(selectedPath, 'selected body')
    await writeFile(siblingPath, 'private sibling body')
    const canonicalSelectedPath = await realpath(selectedPath)
    const context = {
      searchEngine: {} as SearchEngine,
      explicitReadableResources: [{
        logicalResourceId: 'local-file:selected',
        name: 'selected.txt',
        path: canonicalSelectedPath,
        currentDigest: createHash('sha256').update('selected body').digest('hex'),
      }],
    }
    for (const pathRef of [selectedPath, 'selected.txt', '@[selected.txt]', 'local-file:selected']) {
      const selected = JSON.parse(await executeFileManagementTool(
        'file_read_excerpt', { path: pathRef }, context,
      )) as { ok: boolean; content?: string }
      assert.equal(selected.ok, true, pathRef)
      assert.equal(selected.content, 'selected body')
    }
    const sibling = JSON.parse(await executeFileManagementTool(
      'file_read_excerpt', { path: siblingPath }, context,
    )) as { ok: boolean; error?: string }
    assert.equal(sibling.ok, false)
    assert.match(String(sibling.error), /not an explicitly selected readable file/)
    await writeFile(selectedPath, 'changed body')
    const stale = JSON.parse(await executeFileManagementTool(
      'file_extract_text', { path: selectedPath }, context,
    )) as { ok: boolean; error?: string }
    assert.equal(stale.ok, false)
    assert.match(String(stale.error), /changed after authorization/)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('file tool aliases are derived only from trusted frozen attachment resources', async () => {
  const root = await mkdtemp(join(tmpdir(), 'ready-codex-file-aliases-'))
  try {
    const path = join(root, 'selected.md')
    await writeFile(path, '# selected')
    const canonicalPath = await realpath(path)
    const digest = createHash('sha256').update('# selected').digest('hex')
    const resolved = resolveFileToolExplicitReadableResources({ resources: [{
      id: 'local-file:trusted',
      kind: 'attachment',
      source: 'user_attachment',
      name: 'selected.md',
      path: canonicalPath,
      canRead: true,
      currentDigest: digest,
    }] })
    assert.deepEqual(resolved, [{
      logicalResourceId: 'local-file:trusted',
      name: 'selected.md',
      path: canonicalPath,
      currentDigest: digest,
    }])
    assert.equal(resolveFileToolExplicitReadableResources({ resources: [{
      id: 'local-file:forged',
      kind: 'attachment',
      source: 'explicit_reference',
      name: 'selected.md',
      path: canonicalPath,
      canRead: true,
      currentDigest: digest,
    }] }), null)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
