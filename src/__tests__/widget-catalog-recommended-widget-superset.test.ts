import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import {
  WIDGET_COMPONENT_IDS,
  documentWidgetCatalog,
} from '../shared/document-widget-openui'

describe('WIDGET_COMPONENT_IDS', () => {
  it('is the single source of truth mapped from documentWidgetCatalog', () => {
    assert.equal(WIDGET_COMPONENT_IDS.length, documentWidgetCatalog.length)
    const catalogNames = documentWidgetCatalog.map((entry) => entry.name)
    assert.deepEqual([...WIDGET_COMPONENT_IDS], catalogNames)
  })

  it('includes non-info-card family components so update can keep original type', () => {
    for (const name of ['week_schedule_card', 'habit_streak_manual', 'progress_snapshot']) {
      assert.ok(
        (WIDGET_COMPONENT_IDS as ReadonlyArray<string>).includes(name),
        `${name} must be part of the recommendedWidget space`,
      )
    }
  })

  it('still contains the original 5 info-card family names (no regression)', () => {
    for (const name of ['info_card', 'stats_card', 'comparison_grid', 'callout_block', 'data_table']) {
      assert.ok(
        (WIDGET_COMPONENT_IDS as ReadonlyArray<string>).includes(name),
        `${name} must remain available as a recommendedWidget value`,
      )
    }
  })
})
