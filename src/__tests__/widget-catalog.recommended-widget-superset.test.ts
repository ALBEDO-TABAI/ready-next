import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, it } from 'node:test'

import {
  WIDGET_COMPONENT_IDS,
  documentWidgetCatalog,
} from '../shared/document-widget-openui'

const OPENUI_PATH = resolve(process.cwd(), 'src/shared/document-widget-openui.ts')
const PIPELINE_PATH = resolve(
  process.cwd(),
  'src/main/modules/document-engine/pipeline/document-task-pipeline.ts',
)
const EXECUTOR_PATH = resolve(
  process.cwd(),
  'src/main/modules/document-engine/pipeline/document-task-pipeline-executor.ts',
)

describe('widget catalog & DocumentInsight.recommendedWidget are a superset of the 5 legacy components (P3 T5)', () => {
  it('WIDGET_COMPONENT_IDS matches documentWidgetCatalog exactly (no duplicates, no drift)', () => {
    const catalogNames = documentWidgetCatalog.map((entry) => entry.name)
    assert.deepStrictEqual(
      [...WIDGET_COMPONENT_IDS].sort(),
      [...catalogNames].sort(),
      'WIDGET_COMPONENT_IDS must stay in lockstep with documentWidgetCatalog',
    )
    assert.equal(
      new Set(WIDGET_COMPONENT_IDS).size,
      WIDGET_COMPONENT_IDS.length,
      'WIDGET_COMPONENT_IDS must have no duplicates',
    )
  })

  it('catalog includes the 5 legacy info-card-family components (backwards-compatible)', () => {
    const names = new Set(documentWidgetCatalog.map((entry) => entry.name))
    for (const legacy of ['info_card', 'stats_card', 'comparison_grid', 'callout_block', 'data_table']) {
      assert.ok(names.has(legacy as never), `legacy component ${legacy} missing from catalog`)
    }
  })

  it('catalog is strictly a superset (more than the legacy 5)', () => {
    assert.ok(
      documentWidgetCatalog.length > 5,
      `P1 fix (Gap D/E) expands the recommended-widget space past the legacy 5; catalog has ${documentWidgetCatalog.length} entries`,
    )
  })

  it('DocumentWidgetComponentName is defined as keyof typeof componentSchemas (not a hand-rolled 5-item union)', () => {
    const openuiSource = readFileSync(OPENUI_PATH, 'utf8')
    assert.match(
      openuiSource,
      /export type DocumentWidgetComponentName = keyof typeof componentSchemas/,
    )
  })

  it('DocumentInsight.recommendedWidget uses the DocumentWidgetComponentName union (not a narrow literal set)', () => {
    const pipelineSource = readFileSync(PIPELINE_PATH, 'utf8')
    assert.match(
      pipelineSource,
      /export interface DocumentInsight \{[\s\S]*?recommendedWidget: DocumentWidgetComponentName/,
      'DocumentInsight.recommendedWidget must reference the catalog-derived union, not a hardcoded 5-item literal',
    )
  })

  it('executor approves the full catalog for widget drafting', () => {
    const executorSource = readFileSync(EXECUTOR_PATH, 'utf8')
    assert.match(
      executorSource,
      /private readonly approvedWidgetComponentNames: DocumentWidgetComponentName\[\]\s*=\s*\[\.\.\.WIDGET_COMPONENT_IDS\]/,
    )
  })

  it('every catalog entry ships a propsSchema (no catalog hole)', () => {
    for (const entry of documentWidgetCatalog) {
      assert.ok(entry.propsSchema, `catalog entry ${entry.name} is missing propsSchema`)
    }
  })
})
