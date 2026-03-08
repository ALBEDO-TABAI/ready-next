import { useCallback, useState } from 'react'
import {
  ArrowLeft, ArrowRight, RefreshCw, Loader2, Lock, Globe, ExternalLink,
  Star, Bookmark, Download, History, Printer, Shield, ShieldOff
} from 'lucide-react'
import { WORKBENCH_TOOLBAR_ROW_HEIGHT } from '../../modules/workbench/chrome'

type PanelType = 'bookmarks' | 'downloads' | 'history' | null

interface AddressBarProps {
  url: string
  urlInput: string
  loading: boolean
  canGoBack: boolean
  canGoForward: boolean
  isBookmarked: boolean
  adblockEnabled: boolean
  adblockDomainWhitelisted: boolean
  currentDomain?: string
  activePanel: PanelType
  onUrlChange: (val: string) => void
  onNavigate: (url?: string) => void
  onGoBack: () => void
  onGoForward: () => void
  onRefresh: () => void
  onFocus: () => void
  onBlur: () => void
  onEditStart: () => void
  onEditEnd: () => void
  onOpenExternal: () => void
  onToggleBookmark: () => void
  onToggleAdblock: () => void
  onToggleCurrentSiteAdblock: () => void
  onTogglePanel: (panel: 'bookmarks' | 'downloads' | 'history') => void
  onPrint: () => void
}

export default function BrowserAddressBar({
  url,
  urlInput,
  loading,
  canGoBack,
  canGoForward,
  isBookmarked,
  adblockEnabled,
  adblockDomainWhitelisted,
  currentDomain,
  activePanel,
  onUrlChange,
  onNavigate,
  onGoBack,
  onGoForward,
  onRefresh,
  onFocus,
  onBlur,
  onEditStart,
  onEditEnd,
  onOpenExternal,
  onToggleBookmark,
  onToggleAdblock,
  onToggleCurrentSiteAdblock,
  onTogglePanel,
  onPrint,
}: AddressBarProps) {
  const [isComposing, setIsComposing] = useState(false)

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      // Avoid duplicate submit when IME composition is still active.
      if (e.key === 'Enter' && !isComposing && !e.nativeEvent.isComposing) {
        e.preventDefault()
        onNavigate()
      }
    },
    [isComposing, onNavigate]
  )

  const isHttps = url.startsWith('https://')

  const toolbarBtn = (active: boolean) =>
    `flex items-center justify-center rounded-lg transition-colors flex-shrink-0 ${active ? '' : 'hover:bg-[var(--bg-hover)]'}`

  return (
    <div
      className="glass-surface-panel flex items-center no-drag"
      style={{
        height: WORKBENCH_TOOLBAR_ROW_HEIGHT,
        padding: '0 12px',
        gap: 6,
        background: 'var(--surface-toolbar-bg)',
        borderBottom: '1px solid var(--border-default)',
      }}
    >
      {/* Navigation buttons */}
      <button
        onClick={onGoBack}
        disabled={!canGoBack}
        className="flex items-center justify-center rounded-lg hover:bg-[var(--bg-hover)] transition-colors disabled:opacity-30 flex-shrink-0"
        style={{ width: 28, height: 28 }}
        title="Back"
      >
        <ArrowLeft style={{ width: 14, height: 14 }} className="text-[var(--text-light)]" strokeWidth={2} />
      </button>
      <button
        onClick={onGoForward}
        disabled={!canGoForward}
        className="flex items-center justify-center rounded-lg hover:bg-[var(--bg-hover)] transition-colors disabled:opacity-30 flex-shrink-0"
        style={{ width: 28, height: 28 }}
        title="Forward"
      >
        <ArrowRight style={{ width: 14, height: 14 }} className="text-[var(--text-light)]" strokeWidth={2} />
      </button>
      <button
        onClick={onRefresh}
        className="flex items-center justify-center rounded-lg hover:bg-[var(--bg-hover)] transition-colors flex-shrink-0"
        style={{ width: 28, height: 28 }}
        title="Reload"
      >
        {loading ? (
          <Loader2 style={{ width: 14, height: 14 }} className="text-[var(--color-blue)] animate-spin" strokeWidth={2} />
        ) : (
          <RefreshCw style={{ width: 14, height: 14 }} className="text-[var(--text-light)]" strokeWidth={2} />
        )}
      </button>

      {/* URL input with lock/globe prefix and 10px corner radius */}
      <div
        className="browser-address-shell glass-surface-card flex-1 flex items-center text-[12px] border border-[var(--border-input)] relative overflow-hidden"
        style={{
          background: 'var(--surface-card-bg)',
          borderRadius: 10,
          height: 28,
          paddingLeft: 10,
          paddingRight: 4,
        }}
      >
        {/* Lock / Globe prefix icon */}
        <div className="flex-shrink-0 mr-2 flex items-center">
          {isHttps ? (
            <Lock style={{ width: 12, height: 12 }} className="text-[var(--color-green)]" strokeWidth={2} />
          ) : (
            <Globe style={{ width: 12, height: 12 }} className="text-[var(--text-gray)]" strokeWidth={2} />
          )}
        </div>

        <input
          type="text"
          value={urlInput}
          onChange={(e) => onUrlChange(e.target.value)}
          onKeyDown={handleKeyDown}
          onCompositionStart={() => setIsComposing(true)}
          onCompositionEnd={() => setIsComposing(false)}
          onFocus={() => {
            onEditStart()
            onFocus()
          }}
          onBlur={() => {
            onEditEnd()
            onBlur()
          }}
          placeholder="Enter URL or search..."
          className="browser-address-input flex-1 bg-transparent border-none outline-none text-[12px] text-[var(--text-body)]"
          style={{ height: '100%', outline: 'none', boxShadow: 'none', caretColor: 'var(--text-body)' }}
        />

        {/* Bookmark star — inside address bar, rightmost */}
        <button
          onClick={onToggleBookmark}
          className="flex-shrink-0 flex items-center justify-center rounded hover:bg-[var(--bg-hover)] transition-colors"
          style={{ width: 22, height: 22 }}
          title={isBookmarked ? '取消收藏' : '收藏此页面'}
        >
          <Star
            style={{ width: 13, height: 13 }}
            className={isBookmarked ? 'text-[var(--color-orange)]' : 'text-[var(--text-gray)]'}
            strokeWidth={2}
            fill={isBookmarked ? 'var(--color-orange)' : 'none'}
          />
        </button>

      </div>

      {/* Toolbar buttons — outside address bar, right side */}
      <button
        onClick={onToggleAdblock}
        className={toolbarBtn(!adblockEnabled)}
        style={{
          width: 28, height: 28,
          background: adblockEnabled ? undefined : 'var(--color-orange-light)',
        }}
        title={adblockEnabled ? '关闭广告拦截' : '开启广告拦截'}
      >
        {adblockEnabled ? (
          <Shield style={{ width: 14, height: 14 }} className="text-[var(--text-light)]" strokeWidth={2} />
        ) : (
          <ShieldOff style={{ width: 14, height: 14 }} className="text-[var(--color-orange)]" strokeWidth={2} />
        )}
      </button>

      <button
        onClick={onToggleCurrentSiteAdblock}
        disabled={!currentDomain}
        className={toolbarBtn(adblockDomainWhitelisted)}
        style={{
          width: 28, height: 28,
          background: adblockDomainWhitelisted ? 'var(--color-blue-light)' : undefined,
        }}
        title={
          currentDomain
            ? adblockDomainWhitelisted
              ? `恢复 ${currentDomain} 的广告拦截`
              : `当前站点关闭拦截：${currentDomain}`
            : '当前页面没有可识别域名'
        }
      >
        <ShieldOff
          style={{ width: 14, height: 14 }}
          className={adblockDomainWhitelisted ? 'text-[var(--color-blue)]' : 'text-[var(--text-light)]'}
          strokeWidth={2}
        />
      </button>

      <button
        onClick={() => onTogglePanel('bookmarks')}
        className={toolbarBtn(activePanel === 'bookmarks')}
        style={{
          width: 28, height: 28,
          background: activePanel === 'bookmarks' ? 'var(--color-blue-light)' : undefined,
        }}
        title="收藏夹"
      >
        <Bookmark
          style={{ width: 14, height: 14 }}
          className={activePanel === 'bookmarks' ? 'text-[var(--color-blue)]' : 'text-[var(--text-light)]'}
          strokeWidth={2}
        />
      </button>
      <button
        onClick={() => onTogglePanel('downloads')}
        className={toolbarBtn(activePanel === 'downloads')}
        style={{
          width: 28, height: 28,
          background: activePanel === 'downloads' ? 'var(--color-blue-light)' : undefined,
        }}
        title="下载"
      >
        <Download
          style={{ width: 14, height: 14 }}
          className={activePanel === 'downloads' ? 'text-[var(--color-blue)]' : 'text-[var(--text-light)]'}
          strokeWidth={2}
        />
      </button>
      <button
        onClick={() => onTogglePanel('history')}
        className={toolbarBtn(activePanel === 'history')}
        style={{
          width: 28, height: 28,
          background: activePanel === 'history' ? 'var(--color-blue-light)' : undefined,
        }}
        title="历史记录"
      >
        <History
          style={{ width: 14, height: 14 }}
          className={activePanel === 'history' ? 'text-[var(--color-blue)]' : 'text-[var(--text-light)]'}
          strokeWidth={2}
        />
      </button>
      <button
        onClick={onPrint}
        className="flex items-center justify-center rounded-lg hover:bg-[var(--bg-hover)] transition-colors flex-shrink-0"
        style={{ width: 28, height: 28 }}
        title="打印"
      >
        <Printer style={{ width: 14, height: 14 }} className="text-[var(--text-light)]" strokeWidth={2} />
      </button>

      {/* Open in external browser */}
      <button
        onClick={onOpenExternal}
        className="flex items-center justify-center rounded-lg hover:bg-[var(--bg-hover)] transition-colors flex-shrink-0"
        style={{ width: 28, height: 28 }}
        title="在外部浏览器打开"
      >
        <ExternalLink style={{ width: 14, height: 14 }} className="text-[var(--text-light)]" strokeWidth={2} />
      </button>

    </div>
  )
}
