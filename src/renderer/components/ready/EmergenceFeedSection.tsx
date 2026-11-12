/**
 * 梯队三 (2026-07-03) — emergence feed 面（TaskPanel 顶部段）。
 *
 * 只消费 `agent:emergence:feed` 组装结果；卡片必带证据与行动出口（合同
 * CLAUDE.md §2）。adjudicate/supply 出口 = 打开宿主 scope；
 * review 出口 = 跳设置页确认面（涌现卡永不一键采纳，本组件不做
 * 任何直接采纳写入）。空 feed / API 缺失时整段隐藏（零噪声）。
 */
import { useCallback, useEffect, useState } from 'react'
import { IconRefresh, IconSparkles } from '@tabler/icons-react'
import type { EmergenceFeedEntryData } from '../../types/electron'
import { executeFileEmergenceAction } from '../../modules/file-emergence/emergenceAction'
import { Button, IconButton } from '../ui'

const ACTION_LABELS: Record<EmergenceFeedEntryData['card']['action']['kind'], string> = {
  adjudicate_task: '去裁决',
  supply_input: '去补充',
  review_duplicate: '去裁决',
  open_project: '打开',
  open_artifact: '打开',
  open_project_group: '打开',
}

const SCOPE_ACTIONS = new Set(['adjudicate_task', 'supply_input'])
const SETTINGS_ACTIONS = new Set(['review_duplicate'])
const FILE_ACTIONS = new Set(['open_project','open_artifact','open_project_group'])

export function EmergenceFeedSection({
  onOpenScope,
  onOpenSettings,
}: {
  onOpenScope: (scopeId: string) => void
  onOpenSettings: () => void
}) {
  const [entries, setEntries] = useState<EmergenceFeedEntryData[]>([])
  const [refreshing, setRefreshing] = useState(false)
  const [actionError,setActionError]=useState<string|null>(null)

  const api = typeof window !== 'undefined' ? window.electronAPI?.emergence : undefined

  const refresh = useCallback(async () => {
    if (!api) return
    setRefreshing(true)
    try {
      const result = await api.feed()
      setEntries(result.success && Array.isArray(result.data) ? result.data : [])
    } catch {
      // silent-catch: feed probe failure renders the empty ambient feed
      setEntries([])
    } finally {
      setRefreshing(false)
    }
  }, [api])

  useEffect(() => {
    void refresh()
  }, [refresh])

  if (!api || entries.length === 0) return null

  const activate = async (entry: EmergenceFeedEntryData) => {
    setActionError(null)
    const kind = entry.card.action.kind
    if (SCOPE_ACTIONS.has(kind)) {
      if (entry.scopeId) onOpenScope(entry.scopeId)
      return
    }
    if (SETTINGS_ACTIONS.has(kind)) onOpenSettings()
    if (FILE_ACTIONS.has(kind)) {
      const result=await executeFileEmergenceAction(entry.card.action as Parameters<typeof executeFileEmergenceAction>[0])
      if(!result.success)setActionError(result.error)
    }
  }

  return (
    <div
      data-ready-emergence-feed="true"
      style={{
        padding: '10px 12px',
        borderBottom: '1px solid var(--rn-hair)',
        // 作为 flex 列兄弟节点时不侵占消息区：自限高 + 内滚。
        flexShrink: 0,
        maxHeight: 220,
        overflowY: 'auto',
      }}
    >
      <div className="flex items-center justify-between" style={{ marginBottom: 6 }}>
        <div className="flex items-center gap-1.5">
          <IconSparkles style={{ width: 12, height: 12, color: 'var(--rn-ink-3)' }} />
          <span style={{ fontSize: 12, fontWeight: 600, color: 'var(--rn-ink)' }}>涌现</span>
        </div>
        <IconButton
          size="sm"
          title="刷新涌现卡"
          onClick={() => void refresh()}
          style={{ width: 20, height: 20 }}
          icon={
            <IconRefresh
              style={{
                width: 11,
                height: 11,
                animation: refreshing ? 'spin 1s linear infinite' : undefined,
              }}
            />
          }
        />
      </div>
      <div className="flex flex-col" style={{ gap: 6 }}>
        {actionError?<div role="alert" data-ready-emergence-action-error style={{fontSize:11,color:'var(--rn-bad)',padding:'2px 4px'}}>{actionError}</div>:null}
        {entries.map((entry) => {
          const disabled = SCOPE_ACTIONS.has(entry.card.action.kind) && !entry.scopeId
          return (
            <div
              key={entry.card.id}
              data-ready-emergence-card={entry.card.type}
              style={{
                borderRadius: 10,
                border: '1px solid var(--rn-hair-2)',
                padding: '7px 8px',
                display: 'flex',
                flexDirection: 'column',
                gap: 4,
              }}
            >
              <div style={{ fontSize: 12, color: 'var(--rn-ink)', lineHeight: 1.4 }}>
                {entry.card.title}
              </div>
              {entry.card.evidence[0] ? (
                <div
                  style={{
                    fontSize: 11,
                    color: 'var(--rn-ink-3)',
                    overflow: 'hidden',
                    textOverflow: 'ellipsis',
                    whiteSpace: 'nowrap',
                  }}
                >
                  {entry.card.evidence[0].fact}
                </div>
              ) : null}
              <div className="flex justify-end">
                <Button
                  size="sm"
                  variant="secondary"
                  data-ready-emergence-action={entry.card.action.kind}
                  disabled={disabled}
                  onClick={() => { void activate(entry) }}
                >
                  {ACTION_LABELS[entry.card.action.kind]}
                </Button>
              </div>
            </div>
          )
        })}
      </div>
    </div>
  )
}
