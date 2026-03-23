import {
  Bookmark,
  Download,
  ExternalLink,
  History,
  Printer,
  Shield,
  ShieldOff,
} from 'lucide-react'
import type { PanelType } from '../../modules/browser/types'

interface HeaderUtilityActionsProps {
  adblockEnabled: boolean
  adblockDomainWhitelisted: boolean
  currentDomain?: string
  activePanel: PanelType
  onToggleAdblock: () => void
  onToggleCurrentSiteAdblock: () => void
  onTogglePanel: (panel: 'bookmarks' | 'downloads' | 'history') => void
  onPrint: () => void
  onOpenExternal: () => void
}

export default function HeaderUtilityActions({
  adblockEnabled,
  adblockDomainWhitelisted,
  currentDomain,
  activePanel,
  onToggleAdblock,
  onToggleCurrentSiteAdblock,
  onTogglePanel,
  onPrint,
  onOpenExternal,
}: HeaderUtilityActionsProps) {
  const toolbarBtn = (active: boolean) =>
    `flex h-[28px] w-[28px] items-center justify-center rounded-lg transition-colors flex-shrink-0 ${active ? '' : 'hover:bg-[var(--bg-hover)]'}`

  return (
    <div className="flex items-center flex-shrink-0" style={{ gap: 2 }}>
      <button
        type="button"
        onClick={onToggleAdblock}
        className={toolbarBtn(!adblockEnabled)}
        title={adblockEnabled ? '关闭广告拦截' : '开启广告拦截'}
      >
        {adblockEnabled ? (
          <Shield style={{ width: 14, height: 14 }} className="text-[var(--text-light)]" strokeWidth={2} />
        ) : (
          <ShieldOff style={{ width: 14, height: 14 }} className="text-[var(--color-orange)]" strokeWidth={2} />
        )}
      </button>

      <button
        type="button"
        onClick={onToggleCurrentSiteAdblock}
        disabled={!currentDomain}
        className={toolbarBtn(adblockDomainWhitelisted)}
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
        type="button"
        onClick={() => onTogglePanel('bookmarks')}
        className={toolbarBtn(activePanel === 'bookmarks')}
        title="收藏夹"
      >
        <Bookmark
          style={{ width: 14, height: 14 }}
          className={activePanel === 'bookmarks' ? 'text-[var(--color-blue)]' : 'text-[var(--text-light)]'}
          strokeWidth={2}
        />
      </button>

      <button
        type="button"
        onClick={() => onTogglePanel('downloads')}
        className={toolbarBtn(activePanel === 'downloads')}
        title="下载"
      >
        <Download
          style={{ width: 14, height: 14 }}
          className={activePanel === 'downloads' ? 'text-[var(--color-blue)]' : 'text-[var(--text-light)]'}
          strokeWidth={2}
        />
      </button>

      <button
        type="button"
        onClick={() => onTogglePanel('history')}
        className={toolbarBtn(activePanel === 'history')}
        title="历史记录"
      >
        <History
          style={{ width: 14, height: 14 }}
          className={activePanel === 'history' ? 'text-[var(--color-blue)]' : 'text-[var(--text-light)]'}
          strokeWidth={2}
        />
      </button>

      <button
        type="button"
        onClick={onPrint}
        className="flex h-[28px] w-[28px] flex-shrink-0 items-center justify-center rounded-lg transition-colors hover:bg-[var(--bg-hover)]"
        title="打印"
      >
        <Printer style={{ width: 14, height: 14 }} className="text-[var(--text-light)]" strokeWidth={2} />
      </button>

      <button
        type="button"
        onClick={onOpenExternal}
        className="flex h-[28px] w-[28px] flex-shrink-0 items-center justify-center rounded-lg transition-colors hover:bg-[var(--bg-hover)]"
        title="在外部浏览器打开"
      >
        <ExternalLink style={{ width: 14, height: 14 }} className="text-[var(--text-light)]" strokeWidth={2} />
      </button>
    </div>
  )
}
