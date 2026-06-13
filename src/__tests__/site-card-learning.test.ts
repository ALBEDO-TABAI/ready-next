import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { skipIfSqliteUnavailable } from './utils/sqlite-skip'
import { BeliefCardStore, type BeliefCardFrontmatter } from '../main/modules/agent-control/knowledge/belief-card-store'
import {
  learnSiteCardFromFailure,
  siteCardLearningSignalFromToolFailure,
  siteCardLearningSignalsFromCheckIn,
} from '../main/modules/agent-control/knowledge/site-card-learning'
import { visibleCollectFailureLearningSignal } from '../main/modules/browser-engine/content-task-runner'
import { finalizeRunOutcome } from '../main/modules/agent-control/runtime-core/run-finalizer'

test('site-card-learning declares transitive sqlite ABI guard', (t) => {
  skipIfSqliteUnavailable(t, 'site-card-learning transitive sqlite load')
})

const NOW = new Date('2026-06-13T12:00:00.000Z')

function makeRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'ready-site-learning-'))
  mkdirSync(join(root, 'knowledge', 'sites'), { recursive: true })
  return root
}

function siteFm(over: Partial<BeliefCardFrontmatter> = {}): BeliefCardFrontmatter {
  return {
    title: '站点经验',
    description: '已有经验',
    confidence: 'H',
    tag: 'knowledge',
    created: '2026-06-01',
    status: 'active',
    site: 'example.com',
    ...over,
  }
}

test('visible collect empty diagnostics map to site-card learning signals conservatively', () => {
  assert.deepEqual(visibleCollectFailureLearningSignal('https://Example.com/u/1', {
    reason: 'login_wall',
    evidence: ['login_modal_visible'],
  }), {
    domain: 'example.com',
    failureKind: 'login_wall',
    detail: 'login_modal_visible',
  })
  assert.deepEqual(visibleCollectFailureLearningSignal('https://example.com/list', {
    reason: 'selector_mismatch',
    evidence: ['item_selector:.card'],
  }), {
    domain: 'example.com',
    failureKind: 'selector_missing',
    detail: 'item_selector:.card',
  })
  assert.equal(visibleCollectFailureLearningSignal('https://example.com/list', { reason: 'empty_list', evidence: [] }), null)
  assert.equal(visibleCollectFailureLearningSignal('https://example.com/list', { reason: 'still_loading', evidence: [] }), null)
})

test('CheckIn blockers map to site-card learning signals only when a domain and closed failure kind are present', () => {
  assert.deepEqual(siteCardLearningSignalsFromCheckIn({
    url: 'https://Example.com/feed',
    blockers: [
      'site_failure:login_wall: 页面要求先登录',
      'site_failure:selector_missing: 列表项选择器失效',
      'ordinary proof missing',
      'site_failure:selector_missing: 同类重复不应写两张',
    ],
    now: NOW,
  }), [
    {
      domain: 'example.com',
      failureKind: 'login_wall',
      detail: 'checkin blocker: site_failure:login_wall: 页面要求先登录',
      now: NOW,
    },
    {
      domain: 'example.com',
      failureKind: 'selector_missing',
      detail: 'checkin blocker: site_failure:selector_missing: 列表项选择器失效',
      now: NOW,
    },
  ])
  assert.deepEqual(siteCardLearningSignalsFromCheckIn({
    url: 'https://example.com/feed',
    blockers: ['learning_refs_missing', 'zero_proof_done', 'criteria_unsatisfied:collection_verdict'],
  }), [])
  assert.deepEqual(siteCardLearningSignalsFromCheckIn({
    blockers: ['https://example.com/feed site_failure:login_wall: 页面要求先登录'],
    now: NOW,
  }), [{
    domain: 'example.com',
    failureKind: 'login_wall',
    detail: 'checkin blocker: https://example.com/feed site_failure:login_wall: 页面要求先登录',
    now: NOW,
  }])
})

test('finalizer forwards CheckIn blockers to the site-card learning hook without changing closeout', async () => {
  const projection = {
    taskId: 'task-site-learning',
    scopeId: 'scope-site-learning',
    runId: 'run-site-learning',
    taskType: 'multi_step_task',
    module: 'browser',
    status: 'running',
    interactionState: 'running',
    steps: [],
    continuationRef: { targetUrl: 'https://example.com/feed' },
    checkins: [],
    proofRefs: [],
    createdAt: '2026-06-13T00:00:00.000Z',
    updatedAt: '2026-06-13T00:00:00.000Z',
  }
  const learned: unknown[] = []
  const metrics: unknown[] = []

  await finalizeRunOutcome({
    kind: 'done',
    runId: 'run-site-learning',
    taskId: 'task-site-learning',
    durationMs: 1,
    toolCallsUsed: 0,
    initiator: 'done',
    finalText: '完成',
  }, {
    taskProjectionStore: {
      get: () => projection as never,
      update: (_taskId, patch) => Object.assign(projection, patch),
    },
    now: () => NOW,
    learnFromCheckIn: (input) => learned.push(input),
    writeRunCloseMetric: (metric) => metrics.push(metric),
  })

  assert.equal(learned.length, 1)
  const input = learned[0] as {
    checkIn: { blockers: string[] }
    projection: { continuationRef?: { targetUrl?: string | null } | null }
  }
  assert.equal(input.projection.continuationRef?.targetUrl, 'https://example.com/feed')
  assert.ok(input.checkIn.blockers.length > 0)
  assert.equal(metrics.length, 1, 'learning hook must not suppress close metric')
})

test('browser tool error envelopes map to site-card learning signals conservatively', () => {
  assert.deepEqual(siteCardLearningSignalFromToolFailure({
    toolName: 'browser_collect_visible',
    args: { targetUrl: 'https://example.com/u/1' },
    data: { reason: 'captcha_required' },
    text: '页面出现验证码',
    now: NOW,
  }), {
    domain: 'example.com',
    failureKind: 'captcha_or_risk_challenge',
    detail: 'browser_collect_visible structured_failure: 页面出现验证码 reason captcha_required',
    now: NOW,
  })
  assert.deepEqual(siteCardLearningSignalFromToolFailure({
    toolName: 'browser_collect_visible',
    errorKind: 'rate_limited',
    args: { url: 'https://example.com/list' },
    now: NOW,
  }), {
    domain: 'example.com',
    failureKind: 'rate_limited',
    detail: 'browser_collect_visible rate_limited: rate_limited',
    now: NOW,
  })
  assert.equal(siteCardLearningSignalFromToolFailure({
    toolName: 'skill_run_shell',
    errorKind: 'rate_limited',
    args: { url: 'https://example.com/list' },
  }), null)
  assert.equal(siteCardLearningSignalFromToolFailure({
    toolName: 'browser_collect_visible',
    errorKind: 'tool_failed',
    args: { url: 'https://example.com/list' },
    text: 'missing 风控 blocked but no closed code',
  }), null)
  assert.equal(siteCardLearningSignalFromToolFailure({
    toolName: 'browser_collect_notes',
    errorKind: 'high_control_url_batch_denied',
    args: { target_profile_url: 'https://example.com/list' },
    data: { errorCode: 'high_control_url_batch_denied', message: '高风控平台需要用户确认' },
    text: '风控确认缺失',
  }), null)
  assert.equal(siteCardLearningSignalFromToolFailure({
    toolName: 'browser_collect_notes',
    args: { notes: [{ url: 'https://example.com/note/1' }] },
    data: { ok: false, errorCode: 'url_provenance_required', message: 'missing URL provenance' },
    text: 'missing provenance',
  }), null)
  assert.equal(siteCardLearningSignalFromToolFailure({
    toolName: 'browser_collect_visible',
    errorKind: 'host_unavailable',
    args: {},
  }), null)
})

test('login-wall failure creates a new staged site card with dated evidence', () => {
  const root = makeRoot()
  try {
    const store = new BeliefCardStore({ memoryRoot: root })
    const result = learnSiteCardFromFailure(store, {
      domain: 'example.com',
      failureKind: 'login_wall',
      detail: '未登录时只能看到登录墙',
      now: NOW,
    })
    assert.deepEqual(result, { status: 'written', relPath: 'knowledge/sites/example.com.md', mode: 'new-card' })
    const card = store.readCard('knowledge/sites/example.com.md', { includeStaged: true })
    assert.equal(card?.frontmatter.status, 'staged')
    assert.equal(card?.frontmatter.site, 'example.com')
    assert.ok(card?.body.includes('2026-06-13 login_wall'))
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('same-day duplicate skips after the first newly created site card', () => {
  const root = makeRoot()
  try {
    const store = new BeliefCardStore({ memoryRoot: root })
    assert.equal(learnSiteCardFromFailure(store, {
      domain: 'example.com',
      failureKind: 'login_wall',
      detail: '第一次登录墙',
      now: NOW,
    }).status, 'written')
    const duplicate = learnSiteCardFromFailure(store, {
      domain: 'example.com',
      failureKind: 'login_wall',
      detail: '同一天第二次登录墙',
      now: NOW,
    })
    assert.deepEqual(duplicate, {
      status: 'skipped',
      reason: 'same_day_duplicate',
      relPath: 'knowledge/sites/example.com.md',
    })
    assert.equal(store.readCard('knowledge/sites/example.com-login_wall-2026-06-13.md', { includeStaged: true }), null)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('existing active card is never auto-edited; learning creates a staged sidecar', () => {
  const root = makeRoot()
  try {
    const store = new BeliefCardStore({ memoryRoot: root })
    assert.ok(store.writeCard({
      relPath: 'knowledge/sites/example.com.md',
      frontmatter: siteFm(),
      body: '原卡正文',
    }).ok)
    const before = readFileSync(join(root, 'knowledge', 'sites', 'example.com.md'), 'utf-8')
    const result = learnSiteCardFromFailure(store, {
      domain: 'example.com',
      failureKind: 'selector_missing',
      detail: '列表项 selector 失效',
      now: NOW,
    })
    assert.equal(result.status, 'written')
    assert.equal(result.mode, 'sidecar-update')
    assert.equal(readFileSync(join(root, 'knowledge', 'sites', 'example.com.md'), 'utf-8'), before)
    const sidecar = store.readCard('knowledge/sites/example.com-selector_missing-2026-06-13.md', { includeStaged: true })
    assert.equal(sidecar?.frontmatter.status, 'staged')
    assert.equal(sidecar?.frontmatter.source, 'possible-update-of:knowledge/sites/example.com.md')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('risk-changing failures create risk suggestion sidecars; duplicates skip; unknown and hard-blocked reject', () => {
  const root = makeRoot()
  try {
    const store = new BeliefCardStore({ memoryRoot: root })
    assert.ok(store.writeCard({
      relPath: 'knowledge/sites/example.com.md',
      frontmatter: siteFm(),
      body: '原卡正文',
    }).ok)
    const risk = learnSiteCardFromFailure(store, {
      domain: 'example.com',
      failureKind: 'risk_control_or_waf',
      detail: '触发风控',
      now: NOW,
    })
    assert.equal(risk.status, 'written')
    assert.equal(risk.mode, 'risk-suggestion')
    const card = store.readCard('knowledge/sites/example.com-risk_control_or_waf-2026-06-13.md', { includeStaged: true })
    assert.equal(card?.frontmatter.source, 'possible-risk-update-of:knowledge/sites/example.com.md')

    const duplicate = learnSiteCardFromFailure(store, {
      domain: 'example.com',
      failureKind: 'risk_control_or_waf',
      detail: '重复风控',
      now: NOW,
    })
    assert.equal(duplicate.status, 'skipped')
    assert.equal(duplicate.reason, 'same_day_duplicate')

    assert.equal(learnSiteCardFromFailure(store, {
      domain: 'example.com',
      failureKind: 'mystery',
      detail: '未知',
      now: NOW,
    }).status, 'rejected')
    assert.deepEqual(learnSiteCardFromFailure(store, {
      domain: 'xiaohongshu.com',
      failureKind: 'login_wall',
      detail: '硬拦',
      hardBlocked: true,
      now: NOW,
    }), { status: 'rejected', reason: 'hard_blocked_site_is_read_only' })
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
