import { ChevronDown, ChevronUp, Search } from 'lucide-react'
import { Button, IconButton } from '../ui'

// ⌘F in the browser (W7 §4.10): a find bar in the frame above the page, so the page moves down instead of being covered
// and its highlights stay visible. Main finds in the tab and reports matches; ⌘G / ⇧⌘G (or Enter / ⇧Enter in the field)
// step through them; Esc or 完成 clears. Switching tabs closes the bar (Main has already cleared the old page's find).

export type BrowserFindResult = { matches: number; active: number } | null

export function BrowserFindBar({ text, result, inputRef, onText, onStep, onClose }: {
  text: string
  result: BrowserFindResult
  inputRef: React.RefObject<HTMLInputElement | null>
  onText: (text: string) => void
  onStep: (forward: boolean) => void
  onClose: () => void
}) {
  const count = !text ? '' : !result ? '查找中…' : result.matches === 0 ? '无结果' : `${result.active}/${result.matches}`
  return (
    // A row of the browser panel's frame, the page's width, a frame pad above the page (browser-shell.css).
    <div className="rn-find-bar rn-ui" role="search" aria-label="在网页中查找" data-browser-find-bar="">
      {/* The field is a pill well, as the address field is; ready-input-slot-inner keeps the shell's global input slot off it. */}
      <label className="rn-find-bar__field">
        <Search className="rn-find-bar__icon" aria-hidden="true" />
        <input
          ref={inputRef}
          className="rn-find-bar__input ready-input-slot-inner"
          value={text}
          placeholder="在网页中查找"
          aria-label="在网页中查找"
          spellCheck={false}
          onChange={event => onText(event.target.value)}
          onKeyDown={event => {
            if (event.nativeEvent.isComposing) return
            if (event.key === 'Enter') { event.preventDefault(); onStep(!event.shiftKey) }
            if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); onClose() }
          }}
        />
        <span className="rn-find-bar__count" aria-live="polite" data-numeric={Boolean(result?.matches) || undefined}
          data-empty={result?.matches === 0 || undefined}>{count}</span>
      </label>
      <IconButton title="上一个 ⇧⌘G" icon={<ChevronUp />} disabled={!result?.matches} onClick={() => onStep(false)} />
      <IconButton title="下一个 ⌘G" icon={<ChevronDown />} disabled={!result?.matches} onClick={() => onStep(true)} />
      <Button size="sm" variant="ghost" onClick={onClose}>完成</Button>
    </div>
  )
}
