import assert from 'node:assert/strict'
import test from 'node:test'

import {
  inspectE6UserScenarioFrozenCall,
  type E6UserScenarioConfirmationExpectation,
} from '../main/modules/browser-engine/e6-user-scenario-confirmation-proof'

const SHEET_URL = 'https://ji3jaf9ul0l.feishu.cn/sheets/GfPlsXKO2hI3Sqtoh82c1i45nhf?from=from_copylink'
const DOCX_URL = 'https://ji3jaf9ul0l.feishu.cn/docx/GedDd3EATovEz9xILmbcCTk5n4e?from=from_copylink'
const BASE = {
  sheetUrl: SHEET_URL,
  docxUrl: DOCX_URL,
  sheetSentinel: 'E6-READY-0123456789abcdef',
  docxTaskMarker: 'E6-POLISH-0123456789ab',
} as const

function inspect(
  stage: E6UserScenarioConfirmationExpectation['stage'],
  command: string,
) {
  return inspectE6UserScenarioFrozenCall('skill_run_shell', { command }, { ...BASE, stage })
}

test('E6 user scenario confirmation proof admits only the exact three planned writes', () => {
  const insert = inspect(
    'sheet_insert',
    `lark-cli sheets +dim-insert --url '${SHEET_URL}' --sheet-name Sheet1 --position V --count 1 --inherit-style before --as user --json`,
  )
  assert.equal(insert?.stage, 'sheet_insert')
  assert.equal(insert?.position, 'V')
  assert.deepEqual(insert?.sheetSelector, { key: 'title', value: 'Sheet1' })
  assert.ok(insert?.sheetSelectorDigest)

  const write = inspect(
    'sheet_write',
    `lark-cli sheets +cells-set --url '${SHEET_URL}' --sheet-name Sheet1 --range V1 --cells '[[{"value":"E6-READY-0123456789abcdef"}]]' --allow-overwrite=false --as user --json`,
  )
  assert.equal(write?.stage, 'sheet_write')
  assert.equal(write?.range, 'V1')
  assert.equal(write?.sheetSelectorDigest, insert?.sheetSelectorDigest)

  const docx = inspect(
    'docx_write',
    `lark-cli docs +update --doc '${DOCX_URL}' --command str_replace --revision-id 7 --pattern '本季度工作逐步发展为稳定方法，推动内容生产在协作方式上形成阶段性能力。' --content '<p>本季度工作逐步沉淀为稳定方法，使内容生产在协作方式上形成阶段性能力。</p>' --as user --json`,
  )
  assert.equal(docx?.stage, 'docx_write')
  assert.equal(docx?.revisionId, '7')
  assert.equal(docx?.patternLength, 35)
  assert.ok(docx?.patternDigest)
  assert.ok(docx?.visibleContentDigest)
})

test('E6 user scenario confirmation proof rejects destructive or broadened writes', () => {
  assert.equal(inspect(
    'docx_write',
    `lark-cli docs +update --doc '${DOCX_URL}' --command overwrite --revision-id 7 --content '<p>覆盖全文</p>' --as user`,
  ), null)
  assert.equal(inspect(
    'sheet_write',
    `lark-cli sheets +cells-set --url '${SHEET_URL}' --sheet-name Sheet1 --range V1 --cells '[[{"value":"E6-READY-0123456789abcdef"}]]' --allow-overwrite=true --as user`,
  ), null)
  assert.equal(inspect(
    'sheet_insert',
    `lark-cli sheets +dim-insert --url '${SHEET_URL}' --sheet-name Sheet1 --position V --count 2 --inherit-style before --as user`,
  ), null)
  assert.equal(inspect(
    'sheet_insert',
    `lark-cli sheets +dim-insert --url '${SHEET_URL}' --sheet-name Sheet1 --position V --count 1 --as user`,
  ), null)
})

test('E6 user scenario confirmation proof rejects wrong targets and extra arguments', () => {
  assert.equal(inspect(
    'sheet_insert',
    'lark-cli sheets +dim-insert --url https://example.test/wrong --sheet-name Sheet1 --position V --count 1 --as user',
  ), null)
  assert.equal(inspect(
    'docx_write',
    `lark-cli docs +update --doc '${DOCX_URL}' --command str_replace --revision-id 7 --pattern '本季度工作逐步发展为稳定方法，推动内容生产在协作方式上形成阶段性能力。' --content '<p>本季度工作逐步沉淀为稳定方法，使内容生产在协作方式上形成阶段性能力。</p>' --as user --overwrite`,
  ), null)
})

test('E6 user scenario confirmation proof rejects task-marker and remote-resource content', () => {
  assert.equal(inspect(
    'docx_write',
    `lark-cli docs +update --doc '${DOCX_URL}' --command str_replace --revision-id 7 --pattern '本季度工作逐步发展为稳定方法，推动内容生产在协作方式上形成阶段性能力。' --content '<p>E6-POLISH-0123456789ab 本季度工作逐步沉淀为稳定方法，使内容生产在协作方式上形成阶段性能力。</p>' --as user`,
  ), null)
  assert.equal(inspect(
    'docx_write',
    `lark-cli docs +update --doc '${DOCX_URL}' --command str_replace --revision-id 7 --pattern '本季度工作逐步发展为稳定方法，推动内容生产在协作方式上形成阶段性能力。' --content '<p>本季度工作逐步沉淀为稳定方法，使内容生产在 https://example.test 协作方式上形成阶段性能力。</p>' --as user`,
  ), null)
  assert.equal(inspect(
    'docx_write',
    `lark-cli docs +update --doc '${DOCX_URL}' --command str_replace --revision-id 7 --pattern '本季度工作逐步发展为稳定方法，推动内容生产在协作方式上形成阶段性能力。' --content '<p>本季度工作逐步沉淀为稳定方法，使内容生产在 &#104;&#116;&#116;&#112;&#115;&#58;//evil.example/ 协作方式上形成阶段性能力。</p>' --as user`,
  ), null)
})
