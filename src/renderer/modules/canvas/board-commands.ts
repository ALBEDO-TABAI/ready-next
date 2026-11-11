import { useEffect, useRef } from 'react'
import { registerCommands } from '../workbench/commands/registry'

// The board's tools in ⌘K (W4 §2.2: keys live in tooltips and ⌘K). One registration serves every mounted board;
// the commands act on the board that was focused last.

export interface BoardActions { text(): void; note(): void; fit(): void; zoom100(): void; search(): void; bin(): void }
const boards: Array<{ current: BoardActions }> = []
let unregister: (() => void) | null = null
const top = () => boards.at(-1)?.current

function ensureRegistered() {
  if (unregister) return
  unregister = registerCommands('canvas', [
    { id: 'canvas.text', title: '画板：新建文字卡（T）', keywords: ['board', 'canvas', 'text', 'huaban'], when: { mode: 'document' }, run: () => top()?.text() },
    { id: 'canvas.note', title: '画板：新建便签（N）', keywords: ['board', 'note', 'bianqian'], when: { mode: 'document' }, run: () => top()?.note() },
    { id: 'canvas.fit', title: '画板：适应内容（⇧1）', keywords: ['board', 'fit', 'zoom'], when: { mode: 'document' }, run: () => top()?.fit() },
    { id: 'canvas.zoom100', title: '画板：缩放到 100%', keywords: ['board', 'zoom', 'reset'], when: { mode: 'document' }, run: () => top()?.zoom100() },
    { id: 'canvas.search', title: '画板：搜索卡片（⌘F）', keywords: ['board', 'search', 'find'], when: { mode: 'document' }, run: () => top()?.search() },
    { id: 'canvas.bin', title: '画板：回收站', keywords: ['board', 'trash', 'bin'], when: { mode: 'document' }, run: () => top()?.bin() },
  ])
}

/** Registers this board for the shared ⌘K commands; `focus()` makes it the one they act on. */
export function useBoardCommands(actions: BoardActions): { focus(): void } {
  const ref = useRef(actions)
  ref.current = actions
  useEffect(() => {
    const entry = ref
    boards.push(entry); ensureRegistered()
    return () => {
      boards.splice(boards.indexOf(entry), 1)
      if (!boards.length) { unregister?.(); unregister = null }
    }
  }, [])
  return { focus: () => { const index = boards.indexOf(ref); if (index >= 0 && index !== boards.length - 1) { boards.splice(index, 1); boards.push(ref) } } }
}
