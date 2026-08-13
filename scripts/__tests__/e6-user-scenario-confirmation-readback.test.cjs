'use strict'

const assert = require('node:assert/strict')
const test = require('node:test')

const { digestJson } = require('../codex-runtime/contract-lib.cjs')
const {
  validateSheetConfirmationPreReadResults,
  validateSheetPostInsertReadResults,
} = require('../codex-runtime/e6-user-scenario-confirmation-readback.cjs')

const sheetUrl = 'https://ji3jaf9ul0l.feishu.cn/sheets/GfPlsXKO2hI3Sqtoh82c1i45nhf?from=from_copylink'
const cliIdentity = {
  authorityDigest: 'a'.repeat(64),
  payloadSha256: 'b'.repeat(64),
  version: 'lark-cli version 1.0.76',
}
const selector = { key: 'sheet_id', value: 'sheet-1' }
const style = { font_size: 13, vertical_alignment: 'middle' }

function command(args, stdout) {
  return {
    data: {
      ok: true,
      exitCode: 0,
      stdoutTruncated: false,
      stderrTruncated: false,
      stdout: `${JSON.stringify(stdout)}\n`,
      command: { bin: 'lark-cli', args },
      requiredMethod: cliIdentity,
    },
  }
}

function workbook(columnCount) {
  return command(
    ['sheets', '+workbook-info', '--url', sheetUrl, '--as', 'user'],
    { data: { sheets: [{ sheet_id: 'sheet-1', column_count: columnCount }] } },
  )
}

function revision(value) {
  return command(
    ['sheets', '+revision-get', '--url', sheetUrl, '--as', 'user'],
    { data: { revision: value } },
  )
}

function cellRead(range, revisionValue, cell = { cell_styles: style }) {
  return command([
    'sheets', '+cells-get', '--url', sheetUrl, '--sheet-id', 'sheet-1',
    '--as', 'user', '--range', range,
    '--include', 'value,formula,style,data_validation',
  ], {
    data: {
      has_more: false,
      warning_message: 'The actual cell range is also returned.',
      revision: revisionValue,
      ranges: [{
        actual_range: `${range}:${range}`,
        range,
        row_indices: [1],
        col_indices: [range.replace(/1$/, '')],
        truncated: false,
        cells: [[cell]],
      }],
    },
  })
}

function preReadResults() {
  return [
    workbook(3),
    revision(10),
    command([
      'sheets', '+sheet-info', '--url', sheetUrl, '--sheet-id', 'sheet-1',
      '--as', 'user', '--include', 'merges',
    ], { data: { sheet_id: 'sheet-1', range: 'A1:C200', merged_cells: [], revision: 10 } }),
    cellRead('C1', 10),
  ]
}

function proof(position = 'D') {
  return { sheetSelector: selector, sheetSelectorDigest: digestJson(selector), position }
}

test('sheet confirmation pre-read admits only an append after exact structure and template reads', () => {
  const result = validateSheetConfirmationPreReadResults({
    results: preReadResults(), proof: proof(), cliIdentity, sheetUrl,
  })
  assert.equal(result.columnCount, 3)
  assert.equal(result.revision, 10)
  assert.match(result.templateStyleDigest, /^[a-f0-9]{64}$/)

  assert.throws(() => validateSheetConfirmationPreReadResults({
    results: preReadResults(), proof: proof('C'), cliIdentity, sheetUrl,
  }), /e6_user_scenario_confirmation_preread_invalid/)

  assert.throws(() => validateSheetConfirmationPreReadResults({
    results: preReadResults().filter((row) => row.data.command.args[1] !== '+sheet-info'),
    proof: proof(), cliIdentity, sheetUrl,
  }), /e6_user_scenario_confirmation_preread_invalid/)
})

test('sheet confirmation post-insert read rejects style drift and occupied cells before release', () => {
  const preRead = validateSheetConfirmationPreReadResults({
    results: preReadResults(), proof: proof(), cliIdentity, sheetUrl,
  })
  const insert = command([
    'sheets', '+dim-insert', '--url', sheetUrl, '--sheet-id', 'sheet-1',
    '--as', 'user', '--position', 'D', '--count', '1', '--inherit-style', 'before',
  ], { data: { inserted: 1 } })
  const state = {
    sheetSelector: selector,
    sheetSelectorDigest: digestJson(selector),
    position: 'D',
    columnCountBefore: 3,
    revisionBefore: 10,
    templateStyleDigest: preRead.templateStyleDigest,
  }
  const valid = [insert, workbook(4), revision(11), cellRead('D1', 11)]
  const result = validateSheetPostInsertReadResults({
    results: valid, state, cliIdentity, sheetUrl,
  })
  assert.equal(result.columnCountAfterInsert, 4)
  assert.equal(result.revisionAfterInsert, 11)

  const styleDrift = [insert, workbook(4), revision(11), cellRead('D1', 11, {
    cell_styles: { font_size: 14, vertical_alignment: 'middle' },
  })]
  assert.throws(() => validateSheetPostInsertReadResults({
    results: styleDrift, state, cliIdentity, sheetUrl,
  }), /e6_user_scenario_confirmation_sequence_invalid/)

  const occupied = [insert, workbook(4), revision(11), cellRead('D1', 11, {
    value: 'existing', cell_styles: style,
  })]
  assert.throws(() => validateSheetPostInsertReadResults({
    results: occupied, state, cliIdentity, sheetUrl,
  }), /e6_user_scenario_confirmation_sequence_invalid/)
})
