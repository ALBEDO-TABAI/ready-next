#!/usr/bin/env node
'use strict'

const { existsSync, readFileSync } = require('node:fs')
const { resolve } = require('node:path')

const reportPath = resolve(process.argv[2] || '')
if (!process.argv[2] || !existsSync(reportPath)) throw new Error('XHS report path is required')
const report = JSON.parse(readFileSync(reportPath, 'utf8'))
const projection = report.projection || {}
const child = report.browserChild || {}
const run = report.runMeta || {}
const canonical = report.canonicalRows || []
const receipt = canonical[0]?.meta_json ? JSON.parse(canonical[0].meta_json).completionVerifierReceipt : null
const metrics = report.metrics?.counts || {}
const zeroMetrics = ['owner_local_runner_session_rebased', 'owner_local_session_source_cursor_mismatch',
  'renderer_done_without_canonical_terminal', 'renderer_send_success_without_canonical_terminal']
  .every((name) => metrics[name] === 0)
const artifactsOk = report.artifacts?.length === 2 && report.artifacts.every((artifact) => artifact.exists === true
  && artifact.size > 0 && artifact.sha256 && artifact.declares18of18 === true && artifact.containsPartialClaim === false)
const research = report.artifacts?.[0]
const ok = report.ok === true && report.live?.ok === true
  && report.handshake?.ok === true && report.handshake.nonce && report.handshake.manifestDigest
  && report.handshake.profilePath === report.paths?.profilePath && report.handshake.databasePath === report.paths?.databasePath
  && report.handshake.metricsPath === report.metrics?.sourcePath && existsSync(report.handshake.metricsPath)
  && report.profilePolicy?.dailyProfileReads === 0 && report.profilePolicy?.dailyProfileWrites === 0
  && report.profilePolicy?.seedDatabaseShaBefore === report.profilePolicy?.seedDatabaseShaAfter
  && report.provider?.provider === 'openai-compatible' && /novacode/i.test(report.provider?.baseUrl || '')
  && report.prompt?.keywordCount === 18 && report.prompt.keywords?.length === 18
  && projection.status === 'completed' && projection.waiting_for === 'none' && !projection.blocked_reason
  && child.status === 'completed' && child.progress_completed === child.progress_total && child.progress_total >= 18 && child.finished_at
  && run.status === 'done' && canonical.length === 1 && report.doneEvent?.canonicalMessageId === canonical[0].id
  && report.doneEvent?.canonicalMessageDigest && report.visibleMessages?.length === 1
  && receipt?.verdict === 'accept' && receipt.ownerRunId === report.finalRunId && receipt.workflowCloseoutSealDigest
  && artifactsOk && research.keywordCoverage?.length === 18
  && report.metrics?.runClose?.filter((event) => event.runId === report.finalRunId || event.requestId === report.finalRunId).length === 1
  && zeroMetrics
if (!ok) throw new Error('XHS 18-keyword report failed fail-closed checks')
process.stdout.write(`${JSON.stringify({ ok: true, reportPath })}\n`)
