/**
 * 梯队三 (2026-07-03) — emergence feed 面（TaskPanel 顶部段）。
 *
 * 只消费 `agent:emergence:feed` 组装结果；卡片必带证据与行动出口（合同
 * CLAUDE.md §2）。resume/adjudicate/supply 出口 = 打开宿主 scope；
 * adopt/review 出口 = 跳设置页确认面（涌现卡永不一键采纳，本组件不做
 * 任何直接采纳写入）。空 feed / API 缺失时整段隐藏（零噪声）。
 */
import { useCallback, useEffect, useState } from 'react'
import { IconRefresh, IconSparkles } from '@tabler/icons-react'
import type { EmergenceFeedEntryData } from '../../types/electron'

const ACTION_LABELS: Record<EmergenceFeedEntryData['card']['action']['kind'], string> = {
  resume_task: '继续',
  adjudicate_task: '去裁决',
  supply_input: '去补充',
  adopt_candidate: '去确认',
  review_duplicate: '去裁决',
  open_project: '打开',
  open_artifact: '打开',
  open_project_group: '打开',
}

const SCOPE_ACTIONS = new Set(['resume_task', 'adjudicate_task', 'supply_input'])
const SETTINGS_ACTIONS = new Set(['adopt_candidate', 'review_duplicate'])

export function EmergenceFeedSection({
  onOpenScope,
  onOpenSettings,
}: {
  onOpenScope: (scopeId: string) => void
  onOpenSettings: () => void
}) {
  const [entries, setEntries] = useState<EmergenceFeedEntryData[]>([])
  const [refreshing, setRefreshing] = useState(false)

  const api = typeof window !== 'undefined' ? window.electronAPI?.emergence : undefined

  const refresh = useCallback(async () => {
    if (!api) return
    setRefreshing(true)
    try {
      const result = await api.feed()
      setEntries(result.success && Array.isArray(result.data) ? result.data : [])
    } catch {
      setEntries([])
    } finally {
      setRefreshing(false)
    }
  }, [api])

  useEffect(() => {
    void refresh()
  }, [refresh])

  if (!api || entries.length === 0) return null

  const activate = (entry: EmergenceFeedEntryData) => {
    const kind = entry.card.action.kind
    if (SCOPE_ACTIONS.has(kind)) {
      if (entry.scopeId) onOpenScope(entry.scopeId)
      return
    }
    if (SETTINGS_ACTIONS.has(kind)) onOpenSettings()
  }

  return (
    <div
      data-ready-emergence-feed="true"
      style={{
        padding: '10px 12px',
        borderBottom: '1px solid var(--border-default)',
        // 作为 flex 列兄弟节点时不侵占消息区：自限高 + 内滚。
        flexShrink: 0,
        maxHeight: 220,
        overflowY: 'auto',
      }}
    >
      <div className="flex items-center justify-between" style={{ marginBottom: 6 }}>
        <div className="flex items-center gap-1.5">
          <IconSparkles style={{ width: 12, height: 12, color: 'var(--text-light)' }} />
          <span style={{ fontSize: 12, fontWeight: 600, color: 'var(--text-title)' }}>涌现</span>
        </div>
        <button
          type="button"
          aria-label="刷新涌现卡"
          onClick={() => void refresh()}
          className="flex items-center justify-center rounded-md hover:bg-black/5 transition-colors"
          style={{ width: 20, height: 20, border: 'none', background: 'transparent', cursor: 'pointer' }}
        >
          <IconRefresh
            style={{
              width: 11,
              height: 11,
              color: 'var(--text-light)',
              animation: refreshing ? 'spin 1s linear infinite' : undefined,
            }}
          />
        </button>
      </div>
      <div className="flex flex-col" style={{ gap: 6 }}>
        {entries.map((entry) => {
          const disabled = SCOPE_ACTIONS.has(entry.card.action.kind) && !entry.scopeId
          return (
            <div
              key={entry.card.id}
              data-ready-emergence-card={entry.card.type}
              style={{
                borderRadius: 10,
                border: '1px solid var(--border-default)',
                padding: '7px 8px',
                display: 'flex',
                flexDirection: 'column',
                gap: 4,
              }}
            >
              <div style={{ fontSize: 12, color: 'var(--text-body)', lineHeight: 1.4 }}>
                {entry.card.title}
              </div>
              {entry.card.evidence[0] ? (
                <div
                  style={{
                    fontSize: 11,
                    color: 'var(--text-light)',
                    overflow: 'hidden',
                    textOverflow: 'ellipsis',
                    whiteSpace: 'nowrap',
                  }}
                >
                  {entry.card.evidence[0].fact}
                </div>
              ) : null}
              <div className="flex justify-end">
                <button
                  type="button"
                  data-ready-emergence-action={entry.card.action.kind}
                  disabled={disabled}
                  onClick={() => activate(entry)}
                  className="hover:bg-black/5 transition-colors"
                  style={{
                    padding: '2px 8px',
                    borderRadius: 6,
                    border: '1px solid var(--border-default)',
                    background: 'transparent',
                    fontSize: 11,
                    color: disabled ? 'var(--text-light)' : 'var(--text-body)',
                    cursor: disabled ? 'default' : 'pointer',
                  }}
                >
                  {ACTION_LABELS[entry.card.action.kind]}
                </button>
              </div>
            </div>
          )
        })}
      </div>
    </div>
  )
}
