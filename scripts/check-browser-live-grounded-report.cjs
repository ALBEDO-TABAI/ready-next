#!/usr/bin/env node

const { readFileSync } = require('node:fs')
const { resolve } = require('node:path')
const { buildSourceManifest, sha256File } = require('./browser-live-proof-manifest.cjs')

function validateBrowserLiveGroundedReport(report, options = {}) {
  const errors = []
  const currentManifest = buildSourceManifest(options.root || process.cwd())
  const handshake = report?.handshake || {}
  if (report?.ok !== true) errors.push('report.ok must be true')
  if (!report?.proofNonce || report.proofNonce !== handshake.proofNonce) errors.push('proof nonce mismatch')
  if (options.expectedNonce && report.proofNonce !== options.expectedNonce) errors.push('unexpected proof nonce')
  if (report?.sourceManifest?.digest !== currentManifest.digest) errors.push('source drift after proof')
  if (handshake.sourceManifestDigest !== currentManifest.digest) errors.push('embedded source manifest mismatch')
  if (!handshake.execPath || handshake.execSha256 !== sha256File(handshake.execPath)) errors.push('executable drift')
  if (!handshake.asarPath || handshake.asarSha256 !== sha256File(handshake.asarPath)) errors.push('asar drift')
  if (!report?.paths?.userData || report.paths.userData !== handshake.userDataPath) errors.push('userData drift')
  if (!report?.paths?.database || report.paths.database !== handshake.databasePath) errors.push('database drift')
  if (!report?.paths?.database || report.paths.database === `${report.paths.userData}/ready.db`) errors.push('database is not isolated from the acceptance profile')
  if (!Array.isArray(report?.acceptanceMatrix) || report.acceptanceMatrix.length !== 12) errors.push('A1-A12 matrix missing')
  for (let number = 1; number <= 12; number += 1) {
    const item = report?.acceptanceMatrix?.find((candidate) => candidate.id === `A${number}`)
    if (!item || item.ok !== true || !Array.isArray(item.evidence) || item.evidence.length === 0) {
      errors.push(`A${number} is not proven`)
    }
  }
  const threeRuns = report?.realSite?.xhsRuns
  if (!Array.isArray(threeRuns) || threeRuns.length !== 3 || threeRuns.some((run) => run.ok !== true)) {
    errors.push('three successful Xiaohongshu runs missing')
  }
  if (!Array.isArray(report?.realSite?.otherSites) || report.realSite.otherSites.length < 2 || report.realSite.otherSites.some((site) => site.ok !== true)) {
    errors.push('two successful public-site shapes missing')
  }
  if (report?.profilePolicy?.dailyProfileReads !== 0 || report?.profilePolicy?.dailyProfileWrites !== 0) {
    errors.push('daily profile access must be zero')
  }
  return { ok: errors.length === 0, errors }
}

function main() {
  const reportPath = resolve(process.argv[2] || '')
  if (!reportPath) throw new Error('report path is required')
  const report = JSON.parse(readFileSync(reportPath, 'utf8'))
  const result = validateBrowserLiveGroundedReport(report, { expectedNonce: process.env.READY_BROWSER_LIVE_PROOF_NONCE })
  if (!result.ok) {
    console.error('[browser-live-grounded] report rejected:')
    for (const error of result.errors) console.error(`  - ${error}`)
    process.exit(1)
  }
  console.log(`[browser-live-grounded] OK ${reportPath}`)
}

if (require.main === module) main()

module.exports = { validateBrowserLiveGroundedReport }
