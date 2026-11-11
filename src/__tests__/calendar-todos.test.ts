import assert from 'node:assert/strict'
import test from 'node:test'
import { parseTodos, datedTasks } from '../shared/calendar-layers'

test('todos parse nested GFM tasks, headings, completed items and exact UTF-8 byte ranges', () => {
  const content = '\uFEFF---\r\ntitle: 中文😀\r\nfake: "- [ ] hidden"\r\n---\r\n# 项目\r\n- [ ] 父项\r\n  - [X] 子项 📅 2026-11-12\r\n## 下一步\r\n1. [x] 已完成 [日期](ready://calendar/day/2026-11-13)\r\n'
  const tasks = parseTodos(content)
  assert.deepEqual(tasks.map(t => [t.title, t.heading, t.checked, t.date?.source]), [
    ['父项', '项目', false, undefined], ['子项 📅 2026-11-12', '项目', true, 'obsidian'], ['已完成 日期', '下一步', true, 'ready'],
  ])
  for (const { checkbox } of tasks) {
    assert.equal(content.slice(checkbox.start, checkbox.end), checkbox.text)
    assert.equal(Buffer.from(content).subarray(checkbox.byteStart, checkbox.byteEnd).toString(), checkbox.text)
    assert.equal(checkbox.byteEnd - checkbox.byteStart, 3)
  }
  assert.equal(tasks[0].date, null)
  assert.equal(tasks[1].date?.value, '2026-11-12')
})

test('todos exclude frontmatter, fenced and indented code; inline code dates are not dates', () => {
  const content = '---\nexample: |\n  - [ ] frontmatter\n---\n```md\n- [ ] fenced\n```\n\n    - [ ] indented\n\n- [ ] `📅 2026-11-12` and `ready://calendar/day/2026-11-13`\n'
  const tasks = parseTodos(content)
  assert.equal(tasks.length, 1)
  assert.equal(tasks[0].date, null)
  assert.equal(tasks[0].heading, null)
})

test('Ready links take priority over Obsidian dates, nested dates belong only to their task', () => {
  const content = '- [ ] parent 📅 2026-11-11 [date](ready://calendar/day/2026-11-12?at=09:00)\n  - [ ] child [day](ready://calendar/day/2026-11-13)\n- [ ] invalid 📅 2026-02-30\n'
  const tasks = parseTodos(content)
  assert.deepEqual(tasks.map(t => t.date?.value), ['2026-11-12', '2026-11-13', undefined])
  assert.equal(tasks[0].date?.source, 'ready')
  assert.deepEqual(datedTasks(content).map(t => t.date), ['2026-11-12', '2026-11-13'])
})

test('todos retain first-line insertion position for multiline items, CRLF and no final newline', () => {
  const content = '## Section\r\n- [ ] first 😀\r\n  continuation\r\n- [ ] final'
  assert.deepEqual(parseTodos(content).map(t => content.slice(0, t.firstLineEnd).split('\r\n').at(-1)), ['- [ ] first 😀', '- [ ] final'])
})


test('date edit points at the link destination even when its label repeats the URL', () => {
  const url = 'ready://calendar/day/2026-11-12'
  const content = `- [ ] [${url}](${url}?at=09:00)\n`
  const date = parseTodos(content)[0].date!
  assert.equal(date.range.start, content.lastIndexOf('2026-11-12'))
  assert.equal(content.slice(date.range.start, date.range.end), date.value)
})
