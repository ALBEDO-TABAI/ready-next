import { useSyncExternalStore } from 'react'
import { AppWindow, Clock3, Search, Star } from 'lucide-react'
import type { AddressSuggestion, AddressSuggestionStore } from '../../modules/browser/useAddressSuggestions'

// Address-bar suggestions (W7 §4.10): open tabs, bookmarks and history from this computer, and — only when 设置 ›
// 浏览器 › 搜索建议 is on — the chosen engine's suggestions (Main asks it; off by default). The list is a float under the
// address field: like every float it makes the native page step aside while it is open, and focus stays in the field.

const GROUP_LABEL: Record<AddressSuggestion['kind'], string> = { tab: '已打开的标签', bookmark: '收藏', history: '历史', search: '搜索建议' }

const displayUrl = (url: string) => url.replace(/^https?:\/\/(www\.)?/, '').replace(/\/$/, '')

function SuggestionIcon({ kind }: { kind: AddressSuggestion['kind'] }) {
  if (kind === 'tab') return <AppWindow aria-hidden="true" />
  if (kind === 'bookmark') return <Star aria-hidden="true" />
  if (kind === 'history') return <Clock3 aria-hidden="true" />
  return <Search aria-hidden="true" />
}

export function AddressSuggestionList({ store, onPick }: { store: AddressSuggestionStore; onPick: (item: AddressSuggestion) => void }) {
  const { items, selected } = useSyncExternalStore(store.subscribe, store.get)
  return (
    <div className="rn-menu rn-address-suggestions" id="browser-address-suggestions" role="listbox" aria-label="地址建议">
      {items.map((item, index) => (
        <div key={item.key}>
          {(index === 0 || items[index - 1].kind !== item.kind) && <div className="rn-menu__group" role="presentation">{GROUP_LABEL[item.kind]}</div>}
          <div
            id={`browser-address-suggestion-${index}`}
            role="option"
            aria-selected={index === selected}
            className="rn-menu__item"
            data-highlighted={index === selected || undefined}
            data-suggestion-kind={item.kind}
            data-tab-id={item.kind === 'tab' ? item.tabId : undefined}
            // Keep the address field focused: the pick happens on click, the field keeps the keyboard.
            onMouseDown={event => event.preventDefault()}
            onMouseEnter={() => store.set({ items, selected: index })}
            onClick={() => onPick(item)}
          >
            <SuggestionIcon kind={item.kind} />
            <span className="rn-menu__label">{item.title}</span>
            {item.kind === 'tab'
              ? <span className="rn-menu__hint rn-address-suggestions__meta">{item.assistant ? '助手的标签' : '切换'}</span>
              : item.kind !== 'search' && <span className="rn-menu__hint rn-address-suggestions__meta">{displayUrl(item.url)}</span>}
          </div>
        </div>
      ))}
    </div>
  )
}

