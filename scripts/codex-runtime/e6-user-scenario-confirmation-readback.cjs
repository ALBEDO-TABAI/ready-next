'use strict'

const { digestJson } = require('./contract-lib.cjs')
const {
  SHEET_APPEND_POLICY,
  columnNameForNumber,
  projectSheetStructureRead,
  projectSingleSheetCellRead,
} = require('./e6-user-scenario-authority.cjs')

function fail(code) {
  throw new Error(code)
}

function collectValuesForKey(value, key, output = []) {
  if (Array.isArray(value)) {
    value.forEach((child) => collectValuesForKey(child, key, output))
  } else if (value && typeof value === 'object') {
    for (const [candidateKey, child] of Object.entries(value)) {
      if (candidateKey === key) output.push(child)
      collectValuesForKey(child, key, output)
    }
  }
  return output
}

function exactOption(args, name, optional = false) {
  const values = []
  for (let index = 0; index < args.length; index += 1) {
    const token = args[index]
    if (token === name) {
      const value = args[index + 1]
      if (typeof value === 'string' && !value.startsWith('--')) values.push(value)
    } else if (typeof token === 'string' && token.startsWith(`${name}=`)) {
      values.push(token.slice(name.length + 1))
    }
  }
  if (optional && values.length === 0) return null
  if (values.length !== 1 || values[0].length === 0) fail('e6_user_scenario_confirmation_preread_invalid')
  return values[0]
}

function selectorDigest(args) {
  const sheetId = exactOption(args, '--sheet-id', true)
  const sheetName = exactOption(args, '--sheet-name', true)
  if (Boolean(sheetId) === Boolean(sheetName)) fail('e6_user_scenario_confirmation_preread_invalid')
  return digestJson(sheetId
    ? { key: 'sheet_id', value: sheetId }
    : { key: 'title', value: sheetName })
}

function safeCommand(result, expectedPath, cliIdentity) {
  const data = result?.data
  const args = data?.command?.args
  const authority = data?.requiredMethod
  if (data?.ok !== true || data.exitCode !== 0 || data.stdoutTruncated !== false
    || data.stderrTruncated !== false || data.command?.bin !== 'lark-cli'
    || !Array.isArray(args) || args[0] !== expectedPath[0] || args[1] !== expectedPath[1]
    || args.some((token) => token === '--jq' || token.startsWith('--jq=')
      || token === '-q' || (token.startsWith('-q') && token.length > 2)
      || token === '--format' || token.startsWith('--format=')
      || token === '--output' || token.startsWith('--output='))
    || authority?.authorityDigest !== cliIdentity.authorityDigest
    || authority?.payloadSha256 !== cliIdentity.payloadSha256
    || authority?.version !== cliIdentity.version) {
    fail('e6_user_scenario_confirmation_preread_invalid')
  }
  let value
  try { value = JSON.parse(String(data.stdout || '').trim()) } catch {
    fail('e6_user_scenario_confirmation_preread_invalid')
  }
  return { args, value }
}

function uniqueRevision(value) {
  const revisions = collectValuesForKey(value, 'revision')
    .concat(collectValuesForKey(value, 'revision_id'))
    .concat(collectValuesForKey(value, 'revisionId'))
    .map(Number).filter(Number.isSafeInteger)
  const unique = [...new Set(revisions)]
  if (unique.length !== 1 || unique[0] < 1) fail('e6_user_scenario_confirmation_preread_invalid')
  return unique[0]
}

function workbookColumnCount(value, selector) {
  const sheets = collectValuesForKey(value, 'sheets')
    .flat().filter((candidate) => candidate && typeof candidate === 'object')
  const matches = sheets.filter((candidate) => (
    selector.key === 'sheet_id'
      ? String(candidate.sheet_id ?? candidate.sheetId ?? '') === selector.value
      : String(candidate.sheet_name ?? candidate.sheetName ?? '') === selector.value
  ))
  const counts = matches.map((candidate) => Number(candidate.column_count ?? candidate.columnCount))
    .filter(Number.isSafeInteger)
  if (counts.length !== 1 || counts[0] < 1) fail('e6_user_scenario_confirmation_preread_invalid')
  return counts[0]
}

function collectReads(results, allowedPaths, cliIdentity, sheetUrl, selectorDigestValue) {
  const reads = new Map()
  for (const result of results) {
    const args = result?.data?.command?.args
    if (!Array.isArray(args) || args[0] !== 'sheets' || !allowedPaths.has(args[1])) continue
    if (reads.has(args[1])) fail('e6_user_scenario_confirmation_preread_invalid')
    const command = safeCommand(result, ['sheets', args[1]], cliIdentity)
    const selectorCommand = ['+sheet-info', '+cells-get'].includes(args[1])
    if (exactOption(command.args, '--url') !== sheetUrl
      || exactOption(command.args, '--as') !== 'user'
      || (selectorCommand
        ? selectorDigest(command.args) !== selectorDigestValue
        : exactOption(command.args, '--sheet-id', true) !== null
          || exactOption(command.args, '--sheet-name', true) !== null)) {
      fail('e6_user_scenario_confirmation_preread_invalid')
    }
    reads.set(args[1], command)
  }
  if (reads.size !== allowedPaths.size) fail('e6_user_scenario_confirmation_preread_invalid')
  return reads
}

function validateSheetConfirmationPreReadResults(input) {
  const reads = collectReads(input.results, new Set([
    '+workbook-info', '+revision-get', '+sheet-info', '+cells-get',
  ]), input.cliIdentity, input.sheetUrl, input.proof.sheetSelectorDigest)
  const columnCount = workbookColumnCount(
    reads.get('+workbook-info').value, input.proof.sheetSelector,
  )
  const revision = uniqueRevision(reads.get('+revision-get').value)
  const previousColumn = columnNameForNumber(columnCount)
  const expectedPosition = columnNameForNumber(columnCount + 1)
  const structureCommand = reads.get('+sheet-info')
  const templateCommand = reads.get('+cells-get')
  const structure = projectSheetStructureRead(
    structureCommand.value, input.proof.sheetSelector,
  )
  const template = projectSingleSheetCellRead(templateCommand.value, `${previousColumn}1`)
  if (!previousColumn || input.proof.position !== expectedPosition
    || exactOption(structureCommand.args, '--include') !== SHEET_APPEND_POLICY.structureInclude
    || exactOption(structureCommand.args, '--range', true) !== null
    || exactOption(templateCommand.args, '--range') !== `${previousColumn}1`
    || exactOption(templateCommand.args, '--include') !== SHEET_APPEND_POLICY.templateInclude
    || !structure || structure.revision !== revision
    || !new RegExp(`^A1:${previousColumn}[1-9][0-9]*$`).test(structure.range)
    || !template || template.revision !== revision) {
    fail('e6_user_scenario_confirmation_preread_invalid')
  }
  return {
    columnCount,
    preInsertStructureContentDigest: digestJson(structureCommand.value),
    preInsertTemplateContentDigest: digestJson(templateCommand.value),
    revision,
    templateStyleDigest: template.styleDigest,
  }
}

function validateSheetPostInsertReadResults(input) {
  const formalInserts = input.results.filter((result) => {
    const args = result?.data?.command?.args
    return Array.isArray(args) && args[0] === 'sheets' && args[1] === '+dim-insert'
      && !args.some((token) => token === '--dry-run' || token.startsWith('--dry-run='))
  })
  if (formalInserts.length !== 1) fail('e6_user_scenario_confirmation_sequence_invalid')
  const insert = safeCommand(formalInserts[0], ['sheets', '+dim-insert'], input.cliIdentity)
  if (exactOption(insert.args, '--url') !== input.sheetUrl
    || exactOption(insert.args, '--as') !== 'user'
    || selectorDigest(insert.args) !== input.state.sheetSelectorDigest
    || exactOption(insert.args, '--position') !== input.state.position
    || exactOption(insert.args, '--count') !== '1'
    || exactOption(insert.args, '--inherit-style') !== SHEET_APPEND_POLICY.inheritStyle) {
    fail('e6_user_scenario_confirmation_sequence_invalid')
  }
  const insertIndex = input.results.indexOf(formalInserts[0])
  const reads = collectReads(input.results.slice(insertIndex + 1), new Set([
    '+workbook-info', '+revision-get', '+cells-get',
  ]), input.cliIdentity, input.sheetUrl, input.state.sheetSelectorDigest)
  const columnCount = workbookColumnCount(
    reads.get('+workbook-info').value, input.state.sheetSelector,
  )
  const revision = uniqueRevision(reads.get('+revision-get').value)
  const templateCommand = reads.get('+cells-get')
  const template = projectSingleSheetCellRead(
    templateCommand.value, `${input.state.position}1`,
  )
  if (columnCount !== input.state.columnCountBefore + 1
    || revision <= input.state.revisionBefore
    || exactOption(templateCommand.args, '--range') !== `${input.state.position}1`
    || exactOption(templateCommand.args, '--include') !== SHEET_APPEND_POLICY.templateInclude
    || !template || template.revision !== revision || !template.empty
    || template.styleDigest !== input.state.templateStyleDigest) {
    fail('e6_user_scenario_confirmation_sequence_invalid')
  }
  return {
    columnCountAfterInsert: columnCount,
    postInsertTemplateContentDigest: digestJson(templateCommand.value),
    revisionAfterInsert: revision,
  }
}

module.exports = {
  validateSheetConfirmationPreReadResults,
  validateSheetPostInsertReadResults,
}
