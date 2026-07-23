#!/usr/bin/env node
'use strict'

const { existsSync, readFileSync } = require('node:fs')
const { resolve } = require('node:path')

const reportPath = resolve(process.argv[2] || '')
if (!process.argv[2] || !existsSync(reportPath)) throw new Error('provider transfer report path is required')
const report = JSON.parse(readFileSync(reportPath, 'utf8'))
const handshake = report.handshake || {}
const projection = report.projection || {}
const runMeta = report.runMeta || {}
const canonical = report.canonical || {}
const counts = report.metrics?.counts || {}
const allMetricsZero = [
  'owner_local_runner_session_rebased',
  'owner_local_session_source_cursor_mismatch',
  'renderer_done_without_canonical_terminal',
  'renderer_send_success_without_canonical_terminal',
].every((name) => counts[name] === 0)
const ok = report.ok === true && report.live?.ok === true
  && handshake.ok === true && handshake.nonce && handshake.executablePath && handshake.executableSha256
  && handshake.asarPath && handshake.asarSha256 && handshake.manifestDigest
  && handshake.profilePath === report.paths?.profilePath && handshake.databasePath === report.paths?.databasePath
  && handshake.metricsPath === report.metrics?.sourcePath && existsSync(handshake.metricsPath)
  && report.fixture?.toolBoundaryDelivered === true
  && report.fixture?.requestCount >= 3
  && report.fixture.requests?.filter((request) => request.status === 200 && request.kind === 'browser_tool_boundary').length === 1
  && report.fixture.requests?.filter((request) => request.status === 502).length >= 2
  && report.scopeId && report.runId && report.taskId && report.sendResult
  && projection.task_id === report.taskId && projection.run_id === report.runId
  && projection.status === 'recoverable_paused' && projection.waiting_for === 'none'
  && projection.blocked_reason === 'browser_provider_transfer_checkpoint'
  && runMeta.run_id === report.runId && runMeta.status === 'checkpoint'
  && canonical.id && canonical.doneMessageId === canonical.id && canonical.doneDigest
  && report.visibleCanonical?.length === 1 && report.taskCards?.length > 0
  && allMetricsZero
if (!ok) throw new Error('provider transfer report failed fail-closed checks')
process.stdout.write(`${JSON.stringify({ ok: true, reportPath })}\n`)
