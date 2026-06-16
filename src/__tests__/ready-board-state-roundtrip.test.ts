import assert from 'node:assert/strict'
import test from 'node:test'

import {
  buildReadyBoardHtml,
  createEmptyReadyBoardState,
  createReadyBoardTemplate,
  extractReadyBoardStateFromHtml,
  renderReadyBoardHtmlFromTemplate,
} from '../shared/ready-board'

function stateScriptText(html: string): string {
  const match = html.match(/<script[^>]*id=["']ready-board-state["'][^>]*>([\s\S]*?)<\/script>/i)
  assert.ok(match)
  return match[1]
}

test('board state embedding escapes script-breaking text and roundtrips', () => {
  const state = createEmptyReadyBoardState('unsafe </script><!-- \u2028 title')
  state.nodes.push({
    id: 'text-1',
    type: 'text',
    text: 'hello </script><!-- \u2028 \u2029 & world',
    x: 1,
    y: 2,
    width: 120,
    height: 60,
    fontSize: 24,
    color: '#111',
  })

  const html = buildReadyBoardHtml(state)
  const script = stateScriptText(html)

  assert.equal(script.includes('</script>'), false)
  assert.equal(script.includes('<!--'), false)
  assert.equal(script.includes('\u2028'), false)
  assert.equal(script.includes('\u2029'), false)
  assert.match(script, /\\u003C\/script\\u003E/)
  assert.match(script, /\\u0026/)

  const roundtrip = extractReadyBoardStateFromHtml(html)
  assert.equal(roundtrip.title, state.title)
  assert.equal(roundtrip.nodes.length, 1)
  assert.equal(roundtrip.nodes[0]?.type, 'text')
  assert.equal(roundtrip.nodes[0]?.type === 'text' ? roundtrip.nodes[0].text : '', state.nodes[0].type === 'text' ? state.nodes[0].text : '')
})

test('board template contains exactly one state placeholder', () => {
  const template = createReadyBoardTemplate()
  assert.equal((template.match(/__READY_BOARD_STATE__/g) || []).length, 1)
  const html = renderReadyBoardHtmlFromTemplate(template, createEmptyReadyBoardState())
  assert.equal(html.includes('__READY_BOARD_STATE__'), false)
})
