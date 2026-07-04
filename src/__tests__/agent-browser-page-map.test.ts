import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import {
  buildPageMap,
  parseTargetId,
  type RawAxNode,
} from '../main/modules/browser-engine/agent-browser-page-map'

const viewport = { width: 1280, height: 800 }

describe('agent-browser page map', () => {
  it('drops unnamed img nodes and lifts generic/listitem/group wrappers (Matrix denoise)', () => {
    const roots: RawAxNode[] = [
      {
        role: 'generic',
        children: [
          { role: 'img', backendDOMNodeId: 1 }, // unnamed image → dropped
          { role: 'img', name: 'Logo', backendDOMNodeId: 2 }, // named image → kept
          {
            role: 'listitem',
            children: [{ role: 'link', name: 'Open', backendDOMNodeId: 3 }],
          },
        ],
      },
    ]
    const map = buildPageMap(roots, { generation: 1, viewport })
    assert.ok(!map.text.includes('- img\n') && !/- img$/m.test(map.text), 'unnamed img must be gone')
    assert.ok(map.text.includes('img "Logo"'))
    assert.ok(map.text.includes('link "Open"'))
    // generic and listitem wrappers must not appear as their own lines
    assert.ok(!map.text.includes('- generic'))
    assert.ok(!map.text.includes('- listitem'))
  })

  it('assigns stable targetIds as generation:frame:backendNode and keeps only truthy states', () => {
    const roots: RawAxNode[] = [
      { role: 'button', name: '更多', backendDOMNodeId: 42, frameId: '0', states: { expanded: true, disabled: false } },
    ]
    const map = buildPageMap(roots, { generation: 7, viewport })
    assert.equal(map.targets.length, 1)
    assert.equal(map.targets[0].targetId, '7:0:42')
    // truthy state kept, false state dropped (denoise)
    assert.deepEqual(map.targets[0].states, { expanded: true })
  })

  it('distinguishes multiple same-name buttons by their stable node id (multi-button case)', () => {
    const roots: RawAxNode[] = [
      { role: 'group', children: [{ role: 'button', name: '更多', backendDOMNodeId: 10 }] },
      { role: 'group', children: [{ role: 'button', name: '更多', backendDOMNodeId: 20 }] },
    ]
    const map = buildPageMap(roots, { generation: 3, viewport })
    const ids = map.targets.map((t) => t.targetId)
    assert.deepEqual(ids, ['3:0:10', '3:0:20'])
    assert.notEqual(ids[0], ids[1], 'same-name buttons must get distinct ids')
  })

  it('marks targets without a backendDOMNodeId as unstable with a structural fallback id', () => {
    const roots: RawAxNode[] = [{ role: 'button', name: 'Ghost' }]
    const map = buildPageMap(roots, { generation: 2, viewport })
    assert.equal(map.targets[0].unstable, true)
    assert.match(map.targets[0].targetId, /^2:0:p/)
  })

  it('truncates to the byte budget on a line boundary and never returns raw HTML', () => {
    const children: RawAxNode[] = Array.from({ length: 500 }, (_, i) => ({
      role: 'button',
      name: `Item number ${i} with some padding text to inflate the line length`,
      backendDOMNodeId: 1000 + i,
    }))
    const map = buildPageMap([{ role: 'generic', children }], { generation: 1, viewport, maxBytes: 2_000 })
    assert.equal(map.truncated, true)
    assert.ok(Buffer.byteLength(map.text, 'utf8') <= 2_100)
    assert.ok(map.text.includes('… (truncated)'))
    assert.ok(!map.text.includes('<'), 'must not contain HTML angle brackets')
  })

  it('clickable role（cursor:pointer 委托型控件）进入目标列表且带 frameKey（D10-c）', () => {
    const map = buildPageMap([
      { role: 'generic', children: [
        { role: 'clickable', name: '写长文', backendDOMNodeId: 3, frameId: '0' },
        { role: 'clickable', name: '', backendDOMNodeId: 4, frameId: '0' },
      ] },
    ], { generation: 5, viewport })
    const target = map.targets.find((t) => t.name === '写长文')
    assert.ok(target, 'cursor:pointer 控件必须成为可行动目标')
    assert.equal(target!.targetId, '5:0:3')
    assert.equal(map.targets.length, 1, '无名 clickable 不进目标')
    assert.match(map.text, /- clickable "写长文"/)
  })

  it('parseTargetId round-trips and rejects malformed ids', () => {
    assert.deepEqual(parseTargetId('7:0:42'), { generation: 7, frameId: '0', node: '42' })
    assert.deepEqual(parseTargetId('2:0:p1.3'), { generation: 2, frameId: '0', node: 'p1.3' })
    assert.equal(parseTargetId('garbage'), null)
  })
})
