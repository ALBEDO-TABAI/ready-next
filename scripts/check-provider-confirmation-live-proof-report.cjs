#!/usr/bin/env node
'use strict'

const { readFileSync } = require('node:fs')
const path = require('node:path')

// R0 captures the current acceptance policy before P13 hardens it. This helper
// is intentionally not wired into a public gate yet.
const reportPath = path.resolve(process.argv[2] || '')
if (!process.argv[2]) throw new Error('report path is required')
const report = JSON.parse(readFileSync(reportPath, 'utf8'))
const metrics = report.metrics || {}
const handshake = report.handshake || {}
const restart = report.restart || {}
const canonicalVisible = Array.isArray(report.visibleMessages)
  && report.visibleMessages.some((message) => (
    message?.id === report.canonical?.id
    && (!message.digest || message.digest === report.canonical?.digest)
  ))
const buttons = Array.isArray(report.confirmationCard?.buttons) ? report.confirmationCard.buttons : []
if (report.ok !== true
  || report.live?.ok !== true
  || handshake.ok !== true
  || !handshake.nonce
  || !handshake.executablePath
  || !handshake.executableSha256
  || !handshake.asarPath
  || !handshake.asarSha256
  || !handshake.manifestDigest
  || !handshake.profilePath
  || !handshake.databasePath
  || !handshake.metricsPath
  || handshake.metricsFilePresent !== true
  || !report.scopeId
  || !report.runId
  || !report.taskId
  || !report.sendResult
  || (report.sendResult.success !== true && report.sendResult.observed !== true)
  || !report.canonical?.id
  || !report.canonical?.digest
  || !canonicalVisible
  || !report.confirmationCard?.requestId
  || !report.confirmationCard?.target
  || !buttons.includes('allow')
  || !buttons.includes('deny')
  || report.decisions?.allow?.accepted !== true
  || report.decisions?.deny?.accepted !== true
  || metrics.runId !== report.runId
  || metrics.sourcePath !== handshake.metricsPath
  || metrics.renderer_done_without_canonical_terminal !== 0
  || metrics.renderer_send_success_without_canonical_terminal !== 0
  || restart.handshake?.ok !== true
  || restart.handshake?.nonce === handshake.nonce
  || restart.handshake?.profilePath !== handshake.profilePath
  || restart.expired !== true
  || restart.pendingRequestCleared !== true
  || restart.oldButtonUnableToRelease !== true) {
  throw new Error('provider confirmation report failed summary checks')
}
process.stdout.write(`${JSON.stringify({ ok: true, reportPath })}\n`)
