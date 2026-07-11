import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { materializeDeliveryArtifacts } from '../main/modules/agent-control/runtime-core/dynamic-delivery/delivery-artifact-readback'
import {
  collectArtifactProof,
  collectToolOutputProofs,
  collectToolResultProof,
} from '../main/modules/agent-control/quality/proof-collector'
import { createToolExecutionOutput } from '../main/modules/agent-control/tools-runtime/tool-result-types'

const NOW = new Date('2026-07-12T00:00:00.000Z')

function folderEnvelope(name: string, path: string) {
  return {
    resources: [{
      id: `folder-${name}`,
      kind: 'folder_reference',
      source: 'folder_reference',
      name,
      path,
      text: '',
      summary: null,
      order: 0,
      canRead: true,
      canWrite: false,
    }],
  }
}

test('delivery artifact readback opens the real target files and validates a linked index', () => {
  const root = mkdtempSync(join(tmpdir(), 'ready-dd-readback-ok-'))
  try {
    const target = join(root, '宝矿力')
    mkdirSync(target)
    const timeline = join(target, '01-时间线.md')
    const people = join(target, '02-人物.md')
    const index = join(target, '00-总索引.md')
    writeFileSync(timeline, '# 时间线\n\n可追溯正文', 'utf-8')
    writeFileSync(people, '# 人物\n\n可追溯正文', 'utf-8')
    writeFileSync(index, '[时间线](./01-时间线.md)\n[人物](./02-人物.md)', 'utf-8')

    const result = materializeDeliveryArtifacts({
      proofRefs: [
        collectArtifactProof(index, NOW),
        collectArtifactProof(timeline, NOW),
        collectArtifactProof(people, NOW),
        collectToolResultProof('web_search', 'https://example.com/search', NOW),
        collectToolResultProof('web_fetch', 'https://example.com/source 正文', NOW),
      ],
      recentArtifacts: [],
      expectedOutputs: ['00-总索引.md', '01-时间线.md', '02-人物.md'],
      userRequestVerbatim: '分别整理成多份文件并做好索引，存到@[宝矿力]',
      requestEnvelope: folderEnvelope('宝矿力', target),
    })

    assert.deepEqual(result.mechanicalIssues, [])
    assert.equal(result.items.filter((item) => item.kind === 'artifact').length, 3)
    assert.equal(result.items.filter((item) => item.kind === 'resource').length, 2)
    assert.ok(result.items.some((item) => item.refId.endsWith('/01-时间线.md') && item.excerpt.includes('可追溯正文')))
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('delivery artifact readback does not count stale target files as current-run delivery', () => {
  const root = mkdtempSync(join(tmpdir(), 'ready-dd-readback-stale-'))
  try {
    const target = join(root, '宝矿力')
    mkdirSync(target)
    const index = join(target, '总索引.md')
    const stale = join(target, '旧人物.md')
    writeFileSync(index, '[旧人物](./旧人物.md)', 'utf-8')
    writeFileSync(stale, '# 上一轮留下的旧文件', 'utf-8')

    const result = materializeDeliveryArtifacts({
      proofRefs: [collectArtifactProof(index, NOW)],
      expectedOutputs: ['总索引.md', '旧人物.md'],
      userRequestVerbatim: '整理成多份文件并做好索引，存到@[宝矿力]',
      requestEnvelope: folderEnvelope('宝矿力', target),
    })

    const codes = new Set(result.mechanicalIssues?.map((issue) => issue.code))
    assert.ok(codes.has('artifact_bundle_incomplete'))
    assert.ok(codes.has('expected_output_missing'))
    assert.ok(codes.has('index_link_unproven'))
    assert.equal(result.items.filter((item) => item.kind === 'artifact').length, 1)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('successful skill auto-export mints target proof and passes current-run target readback', () => {
  const root = mkdtempSync(join(tmpdir(), 'ready-dd-readback-auto-export-'))
  try {
    const skillRoot = join(root, 'skill-output')
    const target = join(root, '宝矿力')
    mkdirSync(skillRoot)
    mkdirSync(target)
    const source = join(skillRoot, '01-时间线.md')
    const exported = join(target, '01-时间线.md')
    writeFileSync(source, '# 时间线\n\n技能中间产物', 'utf-8')
    writeFileSync(exported, '# 时间线\n\n已导出正文', 'utf-8')
    const proofs = collectToolOutputProofs('skill_write_artifact', createToolExecutionOutput(
      `Wrote 20 bytes to ${source}\n已保存到目标文件夹：${exported}`,
      {
        shape: 'json',
        data: {
          absolutePath: source,
          bytesWritten: 20,
          autoExport: {
            absolutePath: exported,
            targetPath: exported,
            bytesWritten: 22,
          },
        },
      },
    ), NOW, { runId: 'run-auto-export' })

    assert.ok(proofs.some((proof) => proof.kind === 'artifact' && proof.ref === exported))
    const result = materializeDeliveryArtifacts({
      proofRefs: proofs,
      expectedOutputs: ['01-时间线.md'],
      userRequestVerbatim: '存到@[宝矿力]',
      requestEnvelope: folderEnvelope('宝矿力', target),
      currentRunId: 'run-auto-export',
      runStartedAtMs: NOW.getTime() - 1_000,
    })
    assert.deepEqual(result.mechanicalIssues, [])
    assert.equal(result.items.filter((item) => item.kind === 'artifact').length, 1)
    assert.equal(result.items.find((item) => item.kind === 'artifact')?.refId, realpathSync(exported))
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('old proof from the same task cannot satisfy a newer run', () => {
  const root = mkdtempSync(join(tmpdir(), 'ready-dd-readback-run-scope-'))
  try {
    const target = join(root, '宝矿力')
    mkdirSync(target)
    const stale = join(target, '旧报告.md')
    writeFileSync(stale, '# 旧报告', 'utf-8')
    const result = materializeDeliveryArtifacts({
      proofRefs: [collectArtifactProof(stale, new Date('2020-01-01T00:00:00.000Z'), 'run-old')],
      expectedOutputs: ['旧报告.md'],
      userRequestVerbatim: '存到@[宝矿力]',
      requestEnvelope: folderEnvelope('宝矿力', target),
      currentRunId: 'run-new',
      runStartedAtMs: NOW.getTime(),
    })
    const codes = new Set(result.mechanicalIssues?.map((issue) => issue.code))
    assert.ok(codes.has('output_target_empty'))
    assert.ok(codes.has('expected_output_missing'))
    assert.equal(result.items.filter((item) => item.kind === 'artifact').length, 0)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('delivery artifact readback rejects an empty target even when intermediate skill artifacts exist', () => {
  const root = mkdtempSync(join(tmpdir(), 'ready-dd-readback-target-'))
  try {
    const target = join(root, '宝矿力')
    const intermediate = join(root, 'skill-output')
    mkdirSync(target)
    mkdirSync(intermediate)
    const draft = join(intermediate, '草稿.md')
    writeFileSync(draft, '# 只在临时目录', 'utf-8')

    const result = materializeDeliveryArtifacts({
      proofRefs: [collectArtifactProof(draft, NOW)],
      userRequestVerbatim: '整理成多份文件和索引，存到@[宝矿力]',
      requestEnvelope: folderEnvelope('宝矿力', target),
    })

    const codes = new Set(result.mechanicalIssues?.map((issue) => issue.code))
    assert.ok(codes.has('output_target_empty'))
    assert.ok(codes.has('artifact_bundle_incomplete'))
    assert.ok(codes.has('index_missing'))
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('delivery artifact readback rejects empty files and broken local index links', () => {
  const root = mkdtempSync(join(tmpdir(), 'ready-dd-readback-broken-'))
  try {
    const target = join(root, '宝矿力')
    mkdirSync(target)
    const index = join(target, '总索引.md')
    const empty = join(target, '人物.md')
    writeFileSync(index, '[缺失文件](./缺失.md)', 'utf-8')
    writeFileSync(empty, '', 'utf-8')

    const result = materializeDeliveryArtifacts({
      proofRefs: [collectArtifactProof(target, NOW)],
      userRequestVerbatim: '多份文件与索引，存到@[宝矿力]',
      requestEnvelope: folderEnvelope('宝矿力', target),
    })

    const codes = new Set(result.mechanicalIssues?.map((issue) => issue.code))
    assert.ok(codes.has('artifact_empty'))
    assert.ok(codes.has('artifact_bundle_incomplete'))
    assert.ok(codes.has('index_link_missing'))
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
