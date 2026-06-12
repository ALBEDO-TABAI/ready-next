/**
 * EP3-C4 — user-picture CAS merge on DB truth: interleaved writers commit
 * exactly one merge (loser = benign skip, no half-state); audit rows; the
 * 40-line cap; the code decision gate (纯项目工作不进画像 + 不为了写而抢锁:
 * zero DB access); and the redline — after a merge the DB-first loadUSER
 * path must READ the result.
 */

import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  runUserPictureCasMerge,
  filterPictureObservations,
  mergePictureLines,
  renderMirrorDocument,
  createUserMdMirrorPort,
  userPictureContentKey,
  PICTURE_LINE_CAP,
  type CasMergeDb,
  type PictureObservation,
} from '../main/modules/agent-control/maintenance/cas-merge'
import { PromptAssemblyService } from '../main/modules/agent-control/prompt-assembly'
import type { ConversationScope } from '../main/modules/agent-control/contracts/types'
import { __setMetricSinkForTests, type AgentMetricEvent } from '../main/modules/agent-control/metrics'

const NOW = new Date('2026-06-12T12:00:00.000Z')
const pref = (text: string): PictureObservation => ({ text, kind: 'preference' })

class FakeDb implements CasMergeDb {
  knowledge = new Map<string, { value: string }>()
  metadata = new Map<string, Record<string, unknown>>()
  profiles = new Map<string, { id: string }>()
  txDepth = 0
  rollbacks = 0
  commits = 0
  onBegin: (() => void) | null = null

  exec(sql: string): void {
    const normalized = sql.trim()
    if (normalized === 'BEGIN IMMEDIATE') {
      this.txDepth += 1
      this.onBegin?.()
      return
    }
    if (normalized === 'COMMIT') { this.txDepth -= 1; this.commits += 1; return }
    if (normalized === 'ROLLBACK') { this.txDepth -= 1; this.rollbacks += 1; return }
    throw new Error(`unexpected exec: ${normalized}`)
  }

  prepare(sql: string) {
    const normalized = sql.replace(/\s+/g, ' ').trim()
    if (normalized === 'SELECT value FROM agent_knowledge WHERE key = ?') {
      return { get: <R>(key: unknown) => this.knowledge.get(String(key)) as R | undefined, run: () => undefined, all: () => [] }
    }
    if (normalized.startsWith('INSERT INTO agent_knowledge')) {
      return {
        run: (...params: unknown[]) => { this.knowledge.set(String(params[2]), { value: String(params[3]) }) },
        get: () => undefined, all: () => [],
      }
    }
    if (normalized === 'SELECT id FROM agent_memory_metadata WHERE id = ?') {
      return { get: <R>(id: unknown) => this.metadata.get(String(id)) as R | undefined, run: () => undefined, all: () => [] }
    }
    if (normalized.startsWith('UPDATE agent_memory_metadata SET summary')) {
      return {
        run: (...params: unknown[]) => {
          const row = this.metadata.get(String(params[2]))
          if (row) { row.summary = params[0]; row.updated_at = params[1] }
        },
        get: () => undefined, all: () => [],
      }
    }
    if (normalized.startsWith('INSERT INTO agent_memory_metadata')) {
      return {
        run: (...params: unknown[]) => {
          this.metadata.set(String(params[0]), {
            id: params[0], layer: params[1], user_id: params[3], source_type: params[4],
            title: params[6], summary: params[7], content_key: params[8],
          })
        },
        get: () => undefined, all: () => [],
      }
    }
    if (normalized === 'SELECT id FROM user_profiles WHERE id = ?') {
      return { get: <R>(id: unknown) => this.profiles.get(String(id)) as R | undefined, run: () => undefined, all: () => [] }
    }
    throw new Error(`unexpected SQL: ${normalized}`)
  }
}

test('interleaved writers: exactly one merge commits, the loser benign-skips with NO half-state', () => {
  const db = new FakeDb()
  db.profiles.set('u1', { id: 'u1' })
  // writer B commits between A's snapshot read and A's transaction
  db.onBegin = () => {
    db.onBegin = null
    db.knowledge.set(userPictureContentKey('u1'), { value: '- [habit] B_WRITER_LINE' })
  }
  const loser = runUserPictureCasMerge({ db, userId: 'u1', observations: [pref('喜欢简洁中文回复 A_LINE')], now: NOW })
  assert.equal(loser.decision, 'cas_skip', 'hash moved → benign skip, never a throw')
  assert.equal(db.knowledge.get(userPictureContentKey('u1'))?.value, '- [habit] B_WRITER_LINE', 'B 的写入完好，A 零半态')
  assert.equal(db.metadata.size, 0, 'loser leaves no metadata row')
  assert.equal(db.rollbacks, 1)
  assert.equal(db.commits, 0)

  // retried against fresh truth, A succeeds and MERGES with B's line
  const winner = runUserPictureCasMerge({ db, userId: 'u1', observations: [pref('喜欢简洁中文回复 A_LINE')], now: NOW })
  assert.equal(winner.decision, 'merged')
  const merged = db.knowledge.get(userPictureContentKey('u1'))!.value
  assert.ok(merged.includes('B_WRITER_LINE') && merged.includes('A_LINE'), 'merge appends, never clobbers')
  assert.equal(db.metadata.get('mem-user-picture-u1')?.source_type, 'resident_user')
  assert.equal(db.txDepth, 0, 'transaction closed')
})

test('audit rows carry the decision; gate skip touches ZERO db state (不为了写而抢锁)', () => {
  const events: AgentMetricEvent[] = []
  __setMetricSinkForTests((event) => events.push(event))
  try {
    const untouchable = new Proxy({}, {
      get() { throw new Error('db must not be touched on gate skip') },
    }) as CasMergeDb
    const report = runUserPictureCasMerge({
      db: untouchable, userId: 'u1', now: NOW,
      observations: [
        { text: '修了 src/main/modules/x.ts 的 bug', kind: 'preference' },
        { text: 'EP3-C4 工单提交 92b9eb11', kind: 'habit' },
        { text: '今天跑了 npm run typecheck', kind: 'identity' },
        { text: '完成迁移评审', kind: 'project_work' },
      ],
    })
    assert.equal(report.decision, 'gate_skip')
    assert.equal(report.rejected, 4, '纯项目内容全部被代码门拒绝')
    const audit = events.filter((event) => event.metric === 'cas_merge_audit')
    assert.equal(audit.length, 1)
    assert.equal((audit[0] as unknown as { decision: string }).decision, 'gate_skip')

    // gate itself: picture-worthy kinds pass, project signals reject regardless of kind
    const gate = filterPictureObservations([
      pref('偏好直接给结论再给细节'),
      { text: '说话喜欢用中文', kind: 'communication_style' },
      { text: '提交了 abcdef1234 修复', kind: 'preference' },
    ])
    assert.equal(gate.accepted.length, 2)
    assert.equal(gate.rejected[0].reason, 'project_work_signal')
  } finally {
    __setMetricSinkForTests(null)
  }
})

test('40-line hard cap: overflow drops and is reported; duplicates never re-append', () => {
  const existing = Array.from({ length: PICTURE_LINE_CAP - 2 }, (_, index) => `- [habit] 既有习惯 ${index}`).join('\n')
  const merged = mergePictureLines(existing, [
    pref('新增一'), pref('新增二'), pref('新增三'), pref('新增四'),
  ])
  assert.equal(merged.text.split('\n').length, PICTURE_LINE_CAP)
  assert.equal(merged.addedCount, 2)
  assert.equal(merged.droppedCount, 2)
  const again = mergePictureLines(merged.text, [pref('新增一')])
  assert.equal(again.addedCount, 0, 'exact duplicate lines never re-append')
})

test('redline: after merge the DB-first loadUSER path READS the result', async () => {
  const root = mkdtempSync(join(tmpdir(), 'ready-c4-'))
  try {
    const db = new FakeDb()
    db.profiles.set('u1', { id: 'u1' })
    const report = runUserPictureCasMerge({
      db, userId: 'u1', now: NOW,
      observations: [pref('喜欢先结论后细节 PICTURE_MARKER')],
    })
    assert.equal(report.decision, 'merged')

    const svc = new PromptAssemblyService({
      getMemoryRoot: () => root,
      getScopeMessages: () => [],
      enableDatabaseMemory: true,
      userProfileRepository: {
        getProfile: async (userId: string) =>
          db.profiles.has(userId) ? { name: '白', preferredLanguage: 'zh', communicationStyle: null } : null,
      },
      memoryRepository: {
        queryMemories: async (filters: { sourceType?: string; userId?: string }) =>
          [...db.metadata.values()]
            .filter((row) => row.source_type === filters.sourceType && (!filters.userId || row.user_id === filters.userId))
            .map((row) => ({
              id: row.id, title: row.title, summary: row.summary, contentKey: row.content_key,
            })),
        incrementAccessCount: async () => undefined,
      } as never,
      loadMemoryContentByKey: (contentKey: string) => db.knowledge.get(contentKey)?.value ?? null,
    })
    const scope: ConversationScope = {
      id: 's1', agent: 'butler', userId: 'u1', title: '会话', sourceKind: 'local', sourceId: 'app',
      threadKey: 's1', meta: {}, createdAt: NOW.toISOString(), updatedAt: NOW.toISOString(),
    } as ConversationScope
    const result = await svc.buildForScopedRun({ scope, message: '你好', coordinators: [] })
    const injected = [result.systemPrompt, ...result.bootstrapMessages].join('\n')
    assert.ok(injected.includes('PICTURE_MARKER'), '写了但主路径不读 = 违约——DB 优先 loadUSER 必须读到合并结果')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('mirror fallback fires ONLY without a profile row, replaces its marked section, keeps user content', () => {
  const db = new FakeDb()
  let mirrorText = '用户手写的内容 KEEP_ME\n'
  const mirror = {
    read: () => mirrorText,
    writeAtomic: (text: string) => { mirrorText = text },
  }
  // no profile row → mirror syncs
  const first = runUserPictureCasMerge({ db, userId: 'u2', now: NOW, observations: [pref('第一条')], mirror })
  assert.equal(first.mirrorSynced, true)
  assert.ok(mirrorText.includes('KEEP_ME') && mirrorText.includes('第一条'))
  const second = runUserPictureCasMerge({ db, userId: 'u2', now: NOW, observations: [pref('第二条')], mirror })
  assert.equal(second.mirrorSynced, true)
  assert.equal(mirrorText.match(/READY:USER-PICTURE:BEGIN/g)?.length, 1, 'marked section replaced, not duplicated')
  assert.ok(mirrorText.includes('第一条') && mirrorText.includes('第二条'))

  // with a profile row → DB path renders, mirror untouched
  db.profiles.set('u3', { id: 'u3' })
  const withProfile = runUserPictureCasMerge({ db, userId: 'u3', now: NOW, observations: [pref('第三条')], mirror })
  assert.equal(withProfile.mirrorSynced, false, 'mirror is a fallback substep, never the main path')
})

test('fs mirror port uses temp→rename and leaves no temp files', () => {
  const root = mkdtempSync(join(tmpdir(), 'ready-c4-mirror-'))
  try {
    writeFileSync(join(root, 'USER.md'), '已有内容\n', 'utf-8')
    const port = createUserMdMirrorPort(root)
    port.writeAtomic(renderMirrorDocument(port.read(), '- [preference] 镜像行'))
    const text = readFileSync(join(root, 'USER.md'), 'utf-8')
    assert.ok(text.includes('已有内容') && text.includes('镜像行'))
    assert.ok(!readdirSync(root).some((name) => name.includes('.tmp-')), 'temp file renamed away')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
