/**
 * EP2-Q3 — five proof sources, rolling governance, response digest semantics,
 * and the bridge listener. The finalizer ordering (digest proof lands before
 * the verdict) is asserted in Q4a's run-finalizer-checkin tests; here we
 * prove the collector primitives those tests build on.
 */

import assert from 'node:assert/strict'
import test from 'node:test'

import {
  collectToolResultProof,
  collectArtifactProof,
  collectToolOutputProofs,
  collectTaskEventProof,
  collectRunStateProof,
  collectResponseDigestProof,
  appendProofRefs,
  isValidProofRef,
  isSuccessfulToolOutput,
  createTaskProofSink,
  createTaskEventProofListener,
  type ProofRef,
} from '../main/modules/agent-control/quality/proof-collector'
import { createToolExecutionOutput } from '../main/modules/agent-control/tools-runtime/tool-result-types'
import { __setMetricSinkForTests, type AgentMetricEvent } from '../main/modules/agent-control/metrics'

const NOW = new Date('2026-06-12T12:00:00.000Z')

test('each of the five sources produces a structurally valid proof row', () => {
  const proofs = [
    collectToolResultProof('web_search', 'results=3', NOW),
    collectArtifactProof('outputs/report.md', NOW),
    collectTaskEventProof({ taskId: 'task-1', status: 'completed' }, NOW),
    collectRunStateProof('outputs/run_state.json', NOW),
    collectResponseDigestProof('这是最终回复全文，应当只存摘要与哈希。', NOW),
  ]
  const kinds = proofs.map((row) => row && row.kind)
  assert.deepEqual(kinds, ['tool_result', 'artifact', 'task_event', 'run_state', 'assistant_response'])
  for (const row of proofs) {
    assert.ok(row && isValidProofRef(row), `${row?.kind} row must validate`)
    assert.equal(row!.ts, NOW.toISOString())
  }
})

test('response digest: sha256 + truncated excerpt, never the full text; empty reply yields null', () => {
  const long = '答'.repeat(500)
  const row = collectResponseDigestProof(long, NOW)
  assert.ok(row)
  assert.equal(row!.ref.length, 120, 'excerpt truncated to 120 chars')
  assert.match(row!.digest, /^[0-9a-f]{64}$/)
  assert.equal(collectResponseDigestProof('', NOW), null)
  assert.equal(collectResponseDigestProof('   \n', NOW), null)
  assert.equal(collectResponseDigestProof(null, NOW), null)
})

test('tool output proofs include successful tool results and saved artifact paths only', () => {
  const saved = collectToolOutputProofs('document_save_tab', createToolExecutionOutput('已保存文档：/tmp/report.md', {
    shape: 'json',
    data: { documentSaved: true, path: '/tmp/report.md' },
  }), NOW)
  assert.deepEqual(saved.map((row) => row.kind), ['tool_result', 'artifact'])
  assert.equal(saved[0].ref, 'document_save_tab:/tmp/report.md')
  assert.equal(saved[1].ref, '/tmp/report.md')

  const artifactPatch = collectToolOutputProofs('present_file', createToolExecutionOutput('已呈现文件', {
    projectionPatch: {
      recentArtifacts: [{ path: '/tmp/presented.md', label: 'presented' }],
    },
  }), NOW)
  assert.equal(artifactPatch.some((row) => row.kind === 'artifact' && row.ref === '/tmp/presented.md'), true)

  const failed = collectToolOutputProofs('document_save_tab', createToolExecutionOutput('保存失败：权限不足', {
    shape: 'json',
    data: { ok: false },
  }), NOW)
  assert.deepEqual(failed, [])
})

test('research source receipts use structured output when the visible text omits the URL', () => {
  const proofs = collectToolOutputProofs('web_fetch', createToolExecutionOutput('已抓取正文，正文未重复网址', {
    shape: 'json',
    data: {
      url: 'https://example.com/source',
      title: '真实来源',
      content: '可核验正文',
    },
  }), NOW)

  assert.deepEqual(proofs[0].sourceReceipt?.urls, ['https://example.com/source'])
  assert.equal(proofs[0].sourceReceipt?.acquisitionTool, 'web_fetch')
  assert.ok(proofs[0].sourceReceipt?.excerpt.includes('可核验正文'))
})

test('plain text tool failures never count as successful progress', () => {
  assert.equal(isSuccessfulToolOutput(createToolExecutionOutput('Error: upstream failed')), false)
  assert.equal(isSuccessfulToolOutput(createToolExecutionOutput('Document action failed: path missing')), false)
  assert.equal(isSuccessfulToolOutput(createToolExecutionOutput('已读取正文', {
    shape: 'json',
    data: { ok: true, content: '正文' },
  })), true)
})

test('completed structured output is not failed merely because its counters include failed: 0', () => {
  const output = createToolExecutionOutput(
    JSON.stringify({ status: 'completed', progress: { completed: 34, failed: 0 } }),
    {
      shape: 'json',
      data: { status: 'completed', progress: { completed: 34, failed: 0 } },
    },
  )
  assert.equal(isSuccessfulToolOutput(output), true)
  assert.ok(collectToolOutputProofs('browser_task', output, NOW).length > 0)
})

test('browser task handles never mint research evidence without a verified observation receipt', () => {
  const completed = createToolExecutionOutput('https://example.com/item', {
    shape: 'json',
    data: { kind: 'browser_workflow', status: 'completed', result: { essentialOutputSatisfied: true } },
  })
  const proofs = collectToolOutputProofs('browser_task', completed, NOW)
  assert.ok(proofs.length > 0)
  assert.equal(proofs[0]?.sourceReceipt, undefined)
})

test('waiting Tag Forge batches never mint completion proof or successful progress', () => {
  const output=createToolExecutionOutput('Tag Forge waiting for review',{
    shape:'json',data:{ok:true,status:'waiting_review',done:false,remaining:1,reviewRequired:true},
  })
  assert.equal(isSuccessfulToolOutput(output),false)
  assert.deepEqual(collectToolOutputProofs('tag_forge_apply_batch',output,NOW),[])
})

test('successful JSON text is not failed by ordinary words inside document content', () => {
  assert.equal(isSuccessfulToolOutput(createToolExecutionOutput(JSON.stringify({
    ok: true,
    batchId: 'tfb-proof',
    documents: [{ content: '这里讨论失败原因，以及暂时无法完成的情况。' }],
  }))), true)
})

test('tool output proofs mint transaction_confirmed only from explicit confirmation signal', () => {
  const proofs = collectToolOutputProofs('browser_network', createToolExecutionOutput('发布 API 成功', {
    shape: 'json',
    data: {
      ok: true,
      transactionConfirmed: {
        confirmed: true,
        source: 'network',
        signal: 'success_response',
        statusCode: 200,
        observedAt: NOW.toISOString(),
      },
    },
  }), NOW)

  assert.ok(proofs.some((row) => row.kind === 'tool_result'))
  assert.ok(proofs.some((row) => row.kind === 'transaction_confirmed'))

  const ordinary = collectToolOutputProofs('browser_network', createToolExecutionOutput('普通 2xx', {
    shape: 'json',
    data: { ok: true, statusCode: 200 },
  }), NOW)
  assert.equal(ordinary.some((row) => row.kind === 'transaction_confirmed'), false)
})

test('unsaved document mutations do not mint artifact delivery proof from documentPath', () => {
  const proofs = collectToolOutputProofs('document_set_content', createToolExecutionOutput('已写入内容，尚未保存', {
    shape: 'json',
    data: {
      documentSaved: false,
      documentDirty: true,
      documentPath: '/tmp/unsaved.md',
    },
  }), NOW)

  assert.deepEqual(proofs.map((row) => row.kind), ['tool_result'])
  assert.equal(proofs.some((row) => row.kind === 'artifact' && row.ref === '/tmp/unsaved.md'), false)
})

test('structured document mutation proofs ignore benign failure words in titles', () => {
  const proofs = collectToolOutputProofs('document_rewrite_section', createToolExecutionOutput('已重写章节（失败复盘）', {
    shape: 'json',
    data: {
      documentTabId: 'doc-1',
      documentTitle: '失败复盘.md',
      documentDirty: true,
      documentSaveState: 'dirty',
    },
  }), NOW)

  assert.equal(proofs.some((row) => row.kind === 'tool_result' && row.ref === 'document_rewrite_section'), true)
})

test('P0-1 regression: skill_write_artifact (data.absolutePath) yields both a tool_result AND an artifact proof', () => {
  // Exact shape returned by skill_write_artifact (write-artifact.ts): text
  // "Wrote N bytes to <abs>" + data.absolutePath. The collector's keyed path
  // extraction (proof-collector.ts:101-106) must mint an `artifact` proof from
  // absolutePath so a skill-written document can satisfy artifact criteria — this
  // locks that behavior against regression (the earlier diagnosis wrongly assumed
  // it was missing).
  const proofs = collectToolOutputProofs('skill_write_artifact', createToolExecutionOutput(
    'Wrote 2048 bytes to /Users/user/Library/Application Support/ready/skill-runtime/outputs/hfp-space-design/方案.md',
    { shape: 'json', data: { absolutePath: '/Users/user/Library/Application Support/ready/skill-runtime/outputs/hfp-space-design/方案.md', bytesWritten: 2048, encoding: 'utf8', artifactRoot: '/Users/user/Library/Application Support/ready/skill-runtime/outputs/hfp-space-design' } },
  ), NOW)
  assert.ok(proofs.some((row) => row.kind === 'tool_result'), 'tool_result proof present')
  assert.ok(
    proofs.some((row) => row.kind === 'artifact' && row.ref.endsWith('/hfp-space-design/方案.md')),
    'absolutePath is minted as an artifact proof',
  )
})

test('A1: a bare runStatePath is NOT a run_state COMPLETION proof at tool-output level (skill emits it at START)', () => {
  const proofs = collectToolOutputProofs('skill_video_expert_pipeline', createToolExecutionOutput('技能已启动', {
    shape: 'json',
    data: { runStatePath: '/tmp/out/run_state.json' },
  }), NOW)
  const kinds = proofs.map((row) => row.kind)
  // the path is a file artifact, but NOT a run_state-kind completion proof —
  // that is minted only in run-finalizer after validating terminal done + delivery.
  assert.ok(!kinds.includes('run_state'), 'no run_state proof from a bare path')
  assert.ok(proofs.some((row) => row.kind === 'artifact' && row.ref === '/tmp/out/run_state.json'))
})

test('appendProofRefs: malformed additions rejected loudly; overflow rolls oldest into the archive', () => {
  assert.throws(
    () => appendProofRefs([], [{ kind: 'tool_result', ref: '', ts: 'bad', digest: 'nope' } as ProofRef]),
    /malformed proof ref/,
  )

  const mk = (i: number) => collectToolResultProof(`tool_${i}`, String(i), NOW)
  const archived: ProofRef[][] = []
  let rows: ProofRef[] = []
  for (let i = 0; i < 7; i += 1) {
    rows = appendProofRefs(rows, [mk(i)], { limit: 5, archive: (overflow) => archived.push(overflow) })
  }
  assert.equal(rows.length, 5, 'kept at the limit')
  assert.equal(rows[0].ref, 'tool_2', 'newest survive, oldest rolled')
  assert.deepEqual(archived.flat().map((row) => row.ref), ['tool_0', 'tool_1'])
})

test('store sink appends through the repository path and never throws into the caller', () => {
  const records = new Map<string, { proofRefs?: unknown[] }>()
  records.set('task-1', { proofRefs: [] })
  const sink = createTaskProofSink({
    get: (taskId) => (records.get(taskId) ?? null) as never,
    update: (taskId, patch) => {
      records.set(taskId, { ...records.get(taskId)!, ...patch as object })
    },
  })
  assert.equal(sink.append('task-1', [collectArtifactProof('a.md', NOW)]), true)
  assert.equal((records.get('task-1')!.proofRefs as ProofRef[]).length, 1)
  assert.equal(sink.append('missing-task', [collectArtifactProof('a.md', NOW)]), false)
  assert.equal(sink.append(null, [collectArtifactProof('a.md', NOW)]), false)

  // a throwing store degrades to a metric, not an exception
  const events: AgentMetricEvent[] = []
  __setMetricSinkForTests((event) => events.push(event))
  try {
    const broken = createTaskProofSink({
      get: () => { throw new Error('db gone') },
      update: () => {},
    })
    assert.equal(broken.append('task-1', [collectArtifactProof('a.md', NOW)]), false)
    assert.ok(events.some((event) => event.metric === 'proof_collect_failed'))
  } finally {
    __setMetricSinkForTests(null)
  }
})

test('bridge listener turns terminal task events into task_event proofs (additive, bridge untouched)', () => {
  const records = new Map<string, { proofRefs?: unknown[] }>()
  records.set('task-9', { proofRefs: [] })
  const sink = createTaskProofSink({
    get: (taskId) => (records.get(taskId) ?? null) as never,
    update: (taskId, patch) => { records.set(taskId, { ...records.get(taskId)!, ...patch as object }) },
  })
  const listener = createTaskEventProofListener(sink, () => NOW)
  listener({ taskId: 'task-9', status: 'completed' })
  const rows = records.get('task-9')!.proofRefs as ProofRef[]
  assert.equal(rows.length, 1)
  assert.equal(rows[0].kind, 'task_event')
  assert.equal(rows[0].ref, 'task-9|completed')
})
