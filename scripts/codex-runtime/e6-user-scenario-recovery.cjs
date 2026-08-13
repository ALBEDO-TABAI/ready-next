'use strict'

function classifyE6UserScenarioRecoveryIntent(intent, observation) {
  if (intent.stage === 'sheet_insert') {
    if (observation.columnCount === intent.columnCountBefore
      && observation.revision === intent.revisionBefore) return 'absent'
    if (observation.columnCount === intent.columnCountBefore + 1
      && observation.revision > intent.revisionBefore) return 'completed'
    return 'unknown'
  }
  if (intent.stage === 'sheet_write') {
    if (observation.columnCount !== intent.columnCountAfterInsert) return 'unknown'
    if (observation.cellValue === null
      && observation.revision === intent.revisionAfterInsert) return 'absent'
    if (observation.cellValue === observation.expectedCellValue
      && observation.revision > intent.revisionAfterInsert) return 'completed'
    return 'unknown'
  }
  if (intent.stage === 'docx_write') {
    if (observation.contentDigest === intent.beforeContentDigest
      && observation.revision === intent.revisionBefore) return 'absent'
    if (observation.contentDigest === intent.expectedAfterContentDigest
      && observation.revision > intent.revisionBefore) return 'completed'
    return 'unknown'
  }
  return 'unknown'
}

function summarizeE6UserScenarioRecovery(outcomes) {
  if (outcomes.every((outcome) => outcome.state === 'absent')) return 'proven_absent'
  if (outcomes.some((outcome) => outcome.state === 'completed')) {
    return 'completed_partial_effect'
  }
  return 'effect_unknown'
}

module.exports = {
  classifyE6UserScenarioRecoveryIntent,
  summarizeE6UserScenarioRecovery,
}
