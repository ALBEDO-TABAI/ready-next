import { Clock } from 'lucide-react'
import { useEffect, useState } from 'react'
import { WORKBENCH_EDGE_ICON_INSET, WORKBENCH_STATUSBAR_HEIGHT } from '../../modules/workbench/chrome'

export default function StatusBar() {
  const [time, setTime] = useState(new Date())

  useEffect(() => {
    const timer = setInterval(() => setTime(new Date()), 60000)
    return () => clearInterval(timer)
  }, [])

  return (
    <div
      data-liquid-shell="statusbar"
      className="flex shrink-0 items-center justify-between text-[11px] text-[var(--text-light)] select-none"
      style={{
        height: WORKBENCH_STATUSBAR_HEIGHT,
        paddingLeft: WORKBENCH_EDGE_ICON_INSET,
        paddingRight: WORKBENCH_EDGE_ICON_INSET,
        background: 'transparent',
        borderTop: '1px solid transparent',
        boxShadow: 'none',
      }}
    >
      <span>Ready v0.1.0</span>
      <div className="flex items-center gap-3">
        <div className="flex items-center gap-1">
          <Clock className="w-3 h-3" />
          <span>{time.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })}</span>
        </div>
      </div>
    </div>
  )
}
