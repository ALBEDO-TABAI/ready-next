import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
  describeApprovedWidgetProps,
  documentWidgetCatalog,
} from '../shared/document-widget-openui'

describe('describeApprovedWidgetProps', () => {
  it('marks required fields with ! and optional with ?', () => {
    const text = describeApprovedWidgetProps(['info_card'])
    assert.match(text, /- info_card:/)
    assert.match(text, /body!\(/)
    assert.match(text, /heading\?\(/)
  })

  it('expands array-of-object props into a nested element line', () => {
    const text = describeApprovedWidgetProps([
      'stats_card',
      'data_table',
      'comparison_grid',
      'progress_snapshot',
    ])
    assert.match(text, /metrics\[\] = \{[^}]*label!\(string\)[^}]*value!\(string\)/)
    assert.match(text, /columns\[\] = \{[^}]*title!\(string\)[^}]*points!\(string\[\]\)/)
    assert.match(text, /items\[\] = \{[^}]*label!\(string\)[^}]*value!\(number\)/)
  })

  it('renders enum unions inline', () => {
    const text = describeApprovedWidgetProps(['callout_block'])
    assert.match(text, /tone\?\(enum: info\|success\|warning\|danger\|neutral\)/)
  })

  it('walks every catalog component without throwing', () => {
    const names = documentWidgetCatalog.map((entry) => entry.name)
    assert.ok(names.length >= 20)
    const text = describeApprovedWidgetProps(names)
    for (const name of names) {
      assert.ok(text.includes(`- ${name}:`), `missing entry for ${name}`)
    }
  })

  it('skips unknown names silently', () => {
    const text = describeApprovedWidgetProps(['not_a_component' as never])
    assert.equal(text, '')
  })
})
