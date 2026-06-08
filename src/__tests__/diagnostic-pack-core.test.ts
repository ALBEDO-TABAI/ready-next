import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import JSZip from 'jszip'

import {
  createDiagnosticPack,
  type DiagnosticRawDb,
} from '../main/modules/app-control/diagnostic-pack-core'

type Row = Record<string, unknown>

function rowsFor(sql: string): Row[] {
  if (sql.includes('FROM settings')) {
    return [
      { key: 'ai_api_key', value: 'sk-supersecretreadydiagnostic123' },
      {
        key: 'agent_profile',
        value: JSON.stringify({
          model: 'k2.6-code-preview',
          nested: { token: 'token-supersecretreadydiagnostic123' },
        }),
      },
    ]
  }
  if (sql.includes('FROM chat_conversations')) {
    return [{
      id: 'conv-1',
      agent: 'butler',
      title: '旧会话',
      source_kind: 'local',
      source_id: 'local',
      thread_key: 'thread-1',
      lineage_root_id: 'conv-1',
      resume_title: '继续旧会话',
      created_at: '2026-06-08T01:00:00.000Z',
      updated_at: '2026-06-08T02:00:00.000Z',
      meta_json: JSON.stringify({ authorization: 'Bearer secretreadydiagnostic123' }),
    }]
  }
  if (sql.includes('FROM chat_messages')) {
    return [
      {
        id: 'msg-system',
        conversation_id: 'conv-1',
        role: 'system',
        content: 'Ready 跟丢了这次请求，Bearer secretreadydiagnostic123',
        timestamp: '2026-06-08T02:01:00.000Z',
        meta_json: '{}',
      },
      {
        id: 'msg-user',
        conversation_id: 'conv-1',
        role: 'user',
        content: '帮我写一段客户方案正文，不应该进入诊断包',
        timestamp: '2026-06-08T02:00:00.000Z',
        meta_json: '{}',
      },
    ]
  }
  if (sql.includes('FROM task_projections')) {
    return [{
      task_id: 'task-1',
      scope_id: 'conv-1',
      run_id: 'run-1',
      parent_task_id: null,
      task_type: 'agent',
      module: 'agent',
      task_title: '继续旧会话',
      task_summary: 'old session resume',
      status: 'blocked',
      interaction_state: 'none',
      waiting_for: null,
      degradation_reason: null,
      blocked_reason: 'infra_error stale_request',
      resumable_actions_json: '[]',
      continuation_ref_json: '{}',
      progress_json: '{}',
      recent_artifacts_json: '[]',
      created_at: '2026-06-08T02:00:00.000Z',
      updated_at: '2026-06-08T02:01:00.000Z',
    }]
  }
  if (sql.includes('FROM agent_channels')) {
    return [{
      id: 'local',
      type: 'local-debug',
      name: '本机',
      enabled: 1,
      last_seen_at: '2026-06-08T02:00:00.000Z',
      last_error: 'timeout',
      updated_at: '2026-06-08T02:01:00.000Z',
    }]
  }
  return []
}

function makeRawDb(): DiagnosticRawDb {
  return {
    prepare(sql: string) {
      return {
        get<T = unknown>(): T | undefined {
          if (sql.includes('COUNT(1)')) return { count: 1 } as T
          return rowsFor(sql)[0] as T | undefined
        },
        all<T = unknown>(): T[] {
          return rowsFor(sql) as T[]
        },
      }
    },
  }
}

test('diagnostic pack exports logs and redacted state summaries', async () => {
  const root = await mkdtemp(join(tmpdir(), 'ready-diagnostic-pack-'))
  try {
    const logDir = join(root, 'logs')
    const outputDir = join(root, 'out')
    await mkdir(logDir)
    await writeFile(
      join(logDir, 'ready-agent-sdk.log'),
      'request failed with sk-supersecretreadydiagnostic123 and Bearer secretreadydiagnostic123',
    )
    await writeFile(join(logDir, 'not-ready.log'), 'ignored')

    const result = await createDiagnosticPack({
      outputDir,
      logDir,
      rawDb: makeRawDb(),
      now: new Date('2026-06-08T03:04:05.000Z'),
      appInfo: {
        appName: 'Ready',
        appVersion: '0.1.0',
        isPackaged: true,
        appPath: '/Applications/Ready.app',
        userDataPath: '/tmp/Ready',
        logsPath: logDir,
        platform: 'darwin',
        arch: 'arm64',
        versions: { node: '22.0.0' } as NodeJS.ProcessVersions,
      },
    })

    const archive = await JSZip.loadAsync(await readFile(result.path))
    assert.ok(archive.file('manifest.json'))
    assert.ok(archive.file('state/database-summary.json'))
    assert.ok(archive.file('state/package-result.json'))
    assert.ok(archive.file('logs/ready-agent-sdk.log'))
    assert.equal(archive.file('logs/not-ready.log'), null)

    const log = await archive.file('logs/ready-agent-sdk.log')!.async('string')
    assert.doesNotMatch(log, /sk-supersecretreadydiagnostic123/)
    assert.doesNotMatch(log, /Bearer secretreadydiagnostic123/)
    assert.match(log, /sk-\[REDACTED\]/)
    assert.match(log, /Bearer \[REDACTED\]/)

    const summary = JSON.parse(await archive.file('state/database-summary.json')!.async('string'))
    assert.equal(summary.settings.ai_api_key, '[REDACTED]')
    assert.equal(summary.settings.agent_profile.nested.token, '[REDACTED]')
    assert.equal(summary.recentMessageMarkers[0].content_preview, 'Ready 跟丢了这次请求，Bearer [REDACTED]')
    assert.equal(summary.recentMessageMarkers[1].content_preview, '[user message omitted]')
    assert.equal(summary.recentTaskProjections[0].blocked_reason, 'infra_error stale_request')
    assert.deepEqual(result.skippedLogs, [])
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
