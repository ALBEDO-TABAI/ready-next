import { Search } from 'lucide-react'

interface SearchPanelProps {
  query: string
  onQueryChange: (q: string) => void
  hasResults?: boolean
}

export default function SearchPanel({ query, onQueryChange, hasResults = true }: SearchPanelProps) {
  return (
    <div>
      <div
        className="flex items-center gap-[6px] rounded-[10px]"
        style={{ padding: '6px 10px', border: '1px solid var(--border-input)' }}
      >
        <Search className="w-3 h-3 text-[var(--text-light)] flex-shrink-0" />
        <input
          type="text"
          value={query}
          onChange={(e) => onQueryChange(e.target.value)}
          placeholder="搜索文件..."
          className="flex-1 bg-transparent border-none outline-none text-[12px] text-[var(--text-body)] placeholder:text-[var(--text-placeholder)]"
        />
      </div>

      {/* No results empty state */}
      {query.trim().length > 0 && !hasResults && (
        <div className="flex flex-col items-center justify-center py-8 px-4">
          <Search style={{ width: 32, height: 32 }} className="text-[var(--text-light)] mb-3 opacity-40" strokeWidth={1.5} />
          <span style={{ fontSize: 15, fontWeight: 600 }} className="text-[var(--text-muted)] mb-1">没有找到匹配的文件</span>
          <span style={{ fontSize: 13 }} className="text-[var(--text-light)] text-center">尝试使用不同的关键词搜索</span>
        </div>
      )}
    </div>
  )
}
