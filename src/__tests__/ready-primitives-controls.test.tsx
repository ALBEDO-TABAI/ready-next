import assert from 'node:assert/strict'
import test from 'node:test'
import React, { act, useState } from 'react'
import { mountPrimitives, ui } from './utils/primitives-ui-harness'

const { Button, IconButton, Input, Textarea, Select, Slider, Switch, Checkbox, Segmented, Tabs, ListRow, ResizeHandle,
  Chip, Kbd, SectionHeader, EmptyState, Skeleton, Toolbar, ToolbarSeparator, ScrollArea } = ui

test('Button and IconButton expose names, pressed state, focus and disabled clicks', async t => {
  const h = await mountPrimitives(t)
  let clicks = 0
  const render = (disabled = false) => h.render(<>
    <Button disabled={disabled} onClick={() => clicks++}>保存</Button>
    <IconButton title="加粗" icon={<svg aria-hidden="true" />} active disabled={disabled} onClick={() => clicks++} />
    <IconButton title="斜体" icon={null} active={false} />
    <IconButton title="更多" icon={null} />
  </>)
  await render()
  const button = h.get<HTMLButtonElement>('button')
  const icon = h.get<HTMLButtonElement>('[aria-label="加粗"]')
  assert.equal(button.textContent, '保存')
  assert.equal(icon.title, '加粗')
  assert.equal(icon.getAttribute('aria-pressed'), 'true')
  assert.equal(h.get('[aria-label="斜体"]').getAttribute('aria-pressed'), 'false')
  assert.equal(h.get('[aria-label="更多"]').hasAttribute('aria-pressed'), false)
  button.focus(); assert.equal(h.dom.window.document.activeElement, button)
  icon.focus(); assert.equal(h.dom.window.document.activeElement, icon)
  await h.click(button); await h.click(icon)
  assert.equal(clicks, 2)
  await render(true)
  assert.equal(button.disabled, true); assert.equal(icon.disabled, true)
  await h.click(button); await h.click(icon)
  assert.equal(clicks, 2)
})

test('Input, Textarea and Select preserve names, invalid and disabled states and focus', async t => {
  const h = await mountPrimitives(t)
  for (const disabled of [false, true]) {
    await h.render(<>
      <Input aria-label="标题" aria-invalid disabled={disabled} />
      <Textarea aria-label="备注" aria-invalid disabled={disabled} />
      <Select aria-label="排序" aria-invalid disabled={disabled} options={[{ value: 'recent', label: '最近' }]} />
    </>)
    h.body.focus()
    for (const [tag, name] of [['input', '标题'], ['textarea', '备注'], ['select', '排序']]) {
      const field = h.get<HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement>(tag)
      assert.equal(field.getAttribute('aria-label'), name)
      assert.equal(field.getAttribute('aria-invalid'), 'true')
      assert.equal(field.disabled, disabled)
      field.focus()
      assert.equal(h.dom.window.document.activeElement === field, !disabled)
      field.blur()
    }
  }
})

test('Select renders options and delivers the new controlled value', async t => {
  const h = await mountPrimitives(t)
  const changes: string[] = []
  function Example() {
    const [value, setValue] = useState('recent')
    return <Select aria-label="排序" value={value} options={[{ value: 'recent', label: '最近编辑' }, { value: 'title', label: '标题' }]}
      onChange={event => { changes.push(event.target.value); setValue(event.target.value) }} />
  }
  await h.render(<Example />)
  const select = h.get<HTMLSelectElement>('select')
  assert.deepEqual([...select.options].map(option => [option.value, option.text]), [['recent', '最近编辑'], ['title', '标题']])
  assert.equal(select.value, 'recent')
  await act(async () => { select.value = 'title'; select.dispatchEvent(new h.dom.window.Event('change', { bubbles: true })) })
  assert.deepEqual(changes, ['title']); assert.equal(select.value, 'title')
})

test('Switch toggles on click and native button Space/Enter activation, never when disabled', async t => {
  const h = await mountPrimitives(t)
  const changes: boolean[] = []
  function Example({ disabled = false }: { disabled?: boolean }) {
    const [checked, setChecked] = useState(false)
    return <Switch label="减少透明" checked={checked} disabled={disabled} onChange={value => { changes.push(value); setChecked(value) }} />
  }
  await h.render(<Example />)
  const control = h.get<HTMLButtonElement>('[role="switch"]')
  assert.equal(control.getAttribute('aria-label'), '减少透明')
  assert.equal(control.getAttribute('aria-checked'), 'false')
  await h.click(control); assert.equal(control.getAttribute('aria-checked'), 'true')
  await h.activateButton(control, ' '); assert.equal(control.getAttribute('aria-checked'), 'false')
  await h.activateButton(control, 'Enter'); assert.equal(control.getAttribute('aria-checked'), 'true')
  assert.equal(h.dom.window.document.activeElement, control)
  await h.render(<Example disabled />)
  assert.equal(control.disabled, true)
  await h.click(control); await h.activateButton(control, ' '); await h.activateButton(control, 'Enter')
  assert.deepEqual(changes, [true, false, true]); assert.equal(control.getAttribute('aria-checked'), 'true')
})

test('Checkbox has a native associated label and changes mixed to true, then false', async t => {
  const h = await mountPrimitives(t)
  function Example({ disabled = false }: { disabled?: boolean }) {
    const [checked, setChecked] = useState<boolean | 'mixed'>('mixed')
    return <Checkbox label="全部页面" checked={checked} onChange={setChecked} disabled={disabled} />
  }
  await h.render(<Example />)
  const box = h.get<HTMLButtonElement>('[role="checkbox"]')
  assert.equal(box.labels?.[0]?.textContent, '全部页面')
  assert.equal(box.labels?.[0]?.control, box)
  assert.equal(box.getAttribute('aria-checked'), 'mixed')
  await h.click(box); assert.equal(box.getAttribute('aria-checked'), 'true')
  await h.activateButton(box, ' '); assert.equal(box.getAttribute('aria-checked'), 'false')
  await h.render(<Example disabled />)
  await h.click(box); assert.equal(box.getAttribute('aria-checked'), 'false')
})

test('Segmented has one tab stop and arrows select, focus and wrap in both directions', async t => {
  const h = await mountPrimitives(t)
  function Example() {
    const [value, setValue] = useState('list')
    return <Segmented label="视图" value={value} onChange={setValue} options={[{ value: 'list', label: '列表' }, { value: 'board', label: '看板' }, { value: 'calendar', label: '日历' }]} />
  }
  await h.render(<Example />)
  assert.equal(h.get('[role="radiogroup"]').getAttribute('aria-label'), '视图')
  const items = [...h.body.querySelectorAll<HTMLButtonElement>('[role="radio"]')]
  const check = (selected: number) => items.forEach((item, index) => {
    assert.equal(item.tabIndex, index === selected ? 0 : -1)
    assert.equal(item.getAttribute('aria-checked'), String(index === selected))
  })
  assert.deepEqual(items.map(item => item.textContent), ['列表', '看板', '日历'])
  check(0); items[0].focus()
  for (const [key, at] of [['ArrowLeft', 2], ['ArrowRight', 0], ['ArrowRight', 1]] as const) {
    await h.key(h.dom.window.document.activeElement as HTMLElement, key)
    check(at); assert.equal(h.dom.window.document.activeElement, items[at])
  }
  await h.click(items[2]); check(2)
})

test('Segmented slides one capsule to the chosen item, and the item draws its own until the capsule can be placed', async t => {
  const h = await mountPrimitives(t)
  function Example() {
    const [value, setValue] = useState('list')
    return <Segmented label="视图" value={value} onChange={setValue} options={[{ value: 'list', label: '列表' }, { value: 'board', label: '看板' }, { value: 'calendar', label: '日历' }]} />
  }
  await h.render(<Example />)
  const track = h.get<HTMLElement>('[role="radiogroup"]')
  const thumb = h.get<HTMLElement>('.rn-seg__thumb')
  const items = [...h.body.querySelectorAll<HTMLButtonElement>('[role="radio"]')]
  // Not laid out (JSDOM): nothing is placed, so the chosen item keeps its own capsule.
  assert.equal(track.hasAttribute('data-seg-placed'), false)
  assert.equal(thumb.getAttribute('aria-hidden'), 'true')

  // Lay the items out: 40px wide, 2px padding and gaps.
  const proto = h.dom.window.HTMLElement.prototype
  const saved = (['offsetWidth', 'offsetHeight', 'offsetLeft', 'offsetTop'] as const).map(name => [name, Object.getOwnPropertyDescriptor(proto, name)] as const)
  t.after(() => { for (const [name, descriptor] of saved) if (descriptor) Object.defineProperty(proto, name, descriptor) })
  const at = (element: HTMLElement) => items.indexOf(element as HTMLButtonElement)
  const metric = (value: (index: number) => number) => ({ configurable: true, get(this: HTMLElement) { const index = at(this); return index < 0 ? 0 : value(index) } })
  Object.defineProperty(proto, 'offsetWidth', metric(() => 40))
  Object.defineProperty(proto, 'offsetHeight', metric(() => 28))
  Object.defineProperty(proto, 'offsetLeft', metric(index => 2 + index * 42))
  Object.defineProperty(proto, 'offsetTop', metric(() => 2))

  const styleWrites: string[] = []
  // Each record's old value is the style before that write, so a passing `transition: none` shows up.
  const observer = new h.dom.window.MutationObserver(records => { for (const record of records) styleWrites.push(record.oldValue ?? '') })
  observer.observe(thumb, { attributes: true, attributeFilter: ['style'], attributeOldValue: true })
  t.after(() => observer.disconnect())
  const flush = () => act(async () => { await new Promise(resolve => setTimeout(resolve, 0)) })

  // The first placement is put there without travelling.
  await h.click(items[1]); await flush()
  assert.equal(track.hasAttribute('data-seg-placed'), true)
  assert.equal(track.style.getPropertyValue('--rn-seg-x'), '44px')
  assert.equal(track.style.getPropertyValue('--rn-seg-w'), '40px')
  assert.ok(styleWrites.some(style => /transition:\s*none/.test(style)), 'the first placement does not travel')
  assert.equal(thumb.style.transition, '')

  // A later choice travels: the thumb's transition is left alone.
  styleWrites.length = 0
  await h.click(items[2]); await flush()
  assert.equal(track.style.getPropertyValue('--rn-seg-x'), '86px')
  assert.deepEqual(styleWrites, [])
  // The label reserves its chosen weight, and its text is read once.
  assert.equal(items[2].querySelector('.rn-seg__label')?.getAttribute('data-reserve'), '日历')
  assert.equal(items[2].textContent, '日历')
})

test('Tabs support arrows, Home/End, Enter/Space and close without selecting the closed tab', async t => {
  const h = await mountPrimitives(t)
  const changes: string[] = [], closed: string[] = []
  function Example() {
    const [value, setValue] = useState('a')
    return <Tabs label="页面" value={value} onChange={id => { changes.push(id); setValue(id) }} onClose={id => closed.push(id)}
      items={[{ id: 'a', label: '甲' }, { id: 'b', label: '乙', closable: true }, { id: 'c', label: '丙' }]} />
  }
  await h.render(<Example />)
  assert.equal(h.get('[role="tablist"]').getAttribute('aria-label'), '页面')
  const tabs = [...h.body.querySelectorAll<HTMLElement>('[role="tab"]')]
  const check = (at: number) => tabs.forEach((tab, index) => {
    assert.equal(tab.getAttribute('aria-selected'), String(index === at))
    assert.equal(tab.tabIndex, index === at ? 0 : -1)
  })
  check(0); tabs[0].focus()
  for (const [key, at] of [['ArrowLeft', 2], ['ArrowRight', 0], ['ArrowRight', 1], ['End', 2], ['Home', 0]] as const) {
    await h.key(h.dom.window.document.activeElement as HTMLElement, key)
    check(at); assert.equal(h.dom.window.document.activeElement, tabs[at])
  }
  tabs[1].focus(); await h.key(tabs[1], 'Enter'); check(1)
  tabs[0].focus(); await h.key(tabs[0], ' '); check(0)
  const before = [...changes]
  await h.click(h.get('[role="button"][aria-label="关闭 乙"]'))
  assert.deepEqual(closed, ['b']); assert.deepEqual(changes, before); check(0)
})

test('ListRow exposes current page and invokes its action', async t => {
  const h = await mountPrimitives(t)
  let clicks = 0
  await h.render(<><ListRow label="主页" current onClick={() => clicks++} /><ListRow label="其他" /></>)
  const rows = [...h.body.querySelectorAll('button')]
  assert.equal(rows[0].textContent, '主页'); assert.equal(rows[0].getAttribute('aria-current'), 'page')
  assert.equal(rows[1].hasAttribute('aria-current'), false)
  await h.click(rows[0]); assert.equal(clicks, 1)
})

for (const orientation of ['vertical', 'horizontal'] as const) {
  test(`ResizeHandle ${orientation} has a name, focus and axis-specific 8px steps`, async t => {
    const h = await mountPrimitives(t)
    const deltas: number[] = []
    await h.render(<ResizeHandle label="调整区域" orientation={orientation} onResize={delta => deltas.push(delta)} />)
    const handle = h.get('[role="separator"]')
    assert.equal(handle.getAttribute('aria-label'), '调整区域')
    assert.equal(handle.getAttribute('aria-orientation'), orientation)
    assert.equal(handle.tabIndex, 0); handle.focus(); assert.equal(h.dom.window.document.activeElement, handle)
    for (const key of ['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Enter']) await h.key(handle, key)
    assert.deepEqual(deltas, [-8, 8])
  })
}

test('Display and structure primitives retain content, semantics and actionable controls', async t => {
  const h = await mountPrimitives(t)
  let actions = 0
  await h.render(<>
    <SectionHeader title="资料" /><Toolbar label="编辑"><Chip onClick={() => actions++}>筛选</Chip><ToolbarSeparator /></Toolbar>
    <Chip>静态标签</Chip><Kbd>⌘K</Kbd><Skeleton width={80} height={14} />
    <ScrollArea aria-label="资料列表" tabIndex={0}><p>第一条资料</p></ScrollArea>
    <EmptyState title="暂无资料" body="先创建一个页面" action={<Button onClick={() => actions++}>创建</Button>} />
  </>)
  assert.equal(h.get('[role="heading"]').textContent, '资料')
  assert.equal(h.get('[role="heading"]').getAttribute('aria-level'), '3')
  assert.equal(h.get('[role="toolbar"]').getAttribute('aria-label'), '编辑')
  assert.equal(h.get('[role="separator"]').getAttribute('aria-orientation'), 'vertical')
  assert.equal(h.get('kbd').textContent, '⌘K')
  assert.ok([...h.body.querySelectorAll('span')].some(span => span.textContent === '静态标签'))
  assert.equal(h.get('[aria-hidden="true"]').style.width, '80px')
  const scroll = h.get('[aria-label="资料列表"]'); scroll.focus()
  assert.equal(h.dom.window.document.activeElement, scroll); assert.equal(scroll.textContent, '第一条资料')
  assert.match(h.body.textContent!, /暂无资料.*先创建一个页面/)
  for (const button of h.body.querySelectorAll('button')) await h.click(button)
  assert.equal(actions, 2)
})

for (const key of ['Enter', ' '] as const) {
  test(`Tabs close control activates with ${key === ' ' ? 'Space' : key} without selecting its tab`, async t => {
    const h = await mountPrimitives(t)
    const changed: string[] = [], closed: string[] = []
    await h.render(<Tabs label="页面" value="a" items={[{ id: 'a', label: '甲' }, { id: 'b', label: '乙', closable: true }]}
      onChange={id => changed.push(id)} onClose={id => closed.push(id)} />)
    const close = h.get('[role="button"][aria-label="关闭 乙"]')
    close.focus()
    await h.key(close, key)
    assert.deepEqual({ closed, changed }, { closed: ['b'], changed: [] })
  })
}

test('Tabs close a closable tab with Delete, and leave a fixed tab open', async t => {
  const h = await mountPrimitives(t)
  const changed: string[] = [], closed: string[] = []
  await h.render(<Tabs label="页面" value="b" items={[{ id: 'a', label: '甲' }, { id: 'b', label: '乙', closable: true }]}
    onChange={id => changed.push(id)} onClose={id => closed.push(id)} />)
  const closable = h.get('[role="tab"][data-tab-id="b"]')
  closable.focus()
  await h.key(closable, 'Delete')
  const fixed = h.get('[role="tab"][data-tab-id="a"]')
  fixed.focus()
  await h.key(fixed, 'Delete')
  assert.deepEqual({ closed, changed }, { closed: ['b'], changed: [] })
})

test('Slider is a named range that reports its value and draws the part up to the knob', async t => {
  const h = await mountPrimitives(t)
  const values: number[] = []
  function Example({ disabled = false }) {
    const [size, setSize] = useState(18)
    return <Slider aria-label="字号" min="13" max="33" value={size} disabled={disabled} onChange={event => { values.push(Number(event.target.value)); setSize(Number(event.target.value)) }} />
  }
  await h.render(<Example />)
  const slider = h.get<HTMLInputElement>('input[aria-label="字号"]')
  assert.equal(slider.type, 'range')
  assert.equal(slider.style.getPropertyValue('--rn-range-at'), '25%')
  await act(async () => {
    Object.getOwnPropertyDescriptor(h.dom.window.HTMLInputElement.prototype, 'value')!.set!.call(slider, '23')
    slider.dispatchEvent(new h.dom.window.Event('input', { bubbles: true }))
  })
  assert.deepEqual(values, [23])
  assert.equal(slider.style.getPropertyValue('--rn-range-at'), '50%')
  await h.render(<Example disabled />)
  assert.equal(h.get<HTMLInputElement>('input[aria-label="字号"]').disabled, true)
})

test('IconButton with a spread tooltip keeps its accessible name and drops the native title', async t => {
  const h = await mountPrimitives(t)
  await h.render(<>
    <IconButton title="页面选项" icon={null} {...ui.tooltip('导出、阅读方式、样式与源码')} />
    <IconButton title="更多" icon={null} />
  </>)
  const hinted = h.get<HTMLButtonElement>('[aria-label="页面选项"]')
  assert.equal(hinted.hasAttribute('title'), false, 'the tooltip is the only hover hint')
  assert.equal(h.get<HTMLButtonElement>('[aria-label="更多"]').title, '更多', 'without a tooltip the native title stays')
})
