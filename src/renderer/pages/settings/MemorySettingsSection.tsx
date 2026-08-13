import { useState, useCallback } from 'react'
import { ChevronRight } from 'lucide-react'
import {
  SETTINGS_CARD_STYLE,
  SETTINGS_SUBTLE_CARD_STYLE,
} from '../../components/settings/settings-theme'
import { MemoryListPanel, TriggerManager, MemoryStatsCard, MemoryCreator, BeliefCardsPanel, RunQualityPanel } from '../../components/memory'
import { useBeliefCards, useMemories, useMemoryLifecycle, useMemoryStats } from '../../hooks/useMemory'
import type { MemoryQueryFilters } from '../../types/electron'

export function MemorySettingsSection() {
  const [filters, setFilters] = useState<MemoryQueryFilters>({ limit: 50 })
  const [advancedOpen, setAdvancedOpen] = useState(false)
  const memories = useMemories(filters)
  const stats = useMemoryStats()
  const lifecycle = useMemoryLifecycle()
  const beliefCards = useBeliefCards()

  const refreshMemorySection = useCallback(async () => {
    await Promise.all([memories.refresh(), stats.refresh()])
  }, [memories.refresh, stats.refresh])

  const handleRunMaintenance = useCallback(async () => {
    const result = await lifecycle.runMaintenance()
    await refreshMemorySection()
    return result
  }, [lifecycle.runMaintenance, refreshMemorySection])

  const handleDeleteMemory = useCallback(async (id: string) => {
    await memories.deleteMemory(id)
    await stats.refresh()
  }, [memories.deleteMemory, stats.refresh])

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 24 }}>
      <div
        className="glass-surface-card border"
        style={{
          ...SETTINGS_CARD_STYLE,
          padding: '18px 22px'
        }}
      >
        <div className="flex items-start justify-between gap-4">
          <div>
            <h3 className="text-[15px] font-semibold" style={{ color: 'var(--text-title)', margin: 0 }}>
              最近记住了什么
            </h3>
            <p className="text-[12px] leading-5" style={{ color: 'var(--text-muted)', margin: '6px 0 0' }}>
              Agent 自动沉淀的偏好、任务经验和长期事实会出现在这里。
            </p>
          </div>
          {stats.stats && (
            <div
              className="text-[12px] rounded-xl"
              style={{
                color: 'var(--text-body)',
                background: 'color-mix(in srgb, var(--surface-panel-bg) 66%, transparent)',
                padding: '8px 12px'
              }}
            >
              共 {stats.stats.totalMemories} 条
            </div>
          )}
        </div>
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: 'minmax(300px, 340px) minmax(0, 1fr)', gap: 24, alignItems: 'start' }}>
        <MemoryStatsCard
          stats={stats.stats}
          statsLoading={stats.loading}
          statsError={stats.error}
          status={lifecycle.status}
          lifecycleLoading={lifecycle.loading}
          lifecycleError={lifecycle.error}
          maintenanceRunning={lifecycle.maintenanceRunning}
          onRunMaintenance={handleRunMaintenance}
        />
        <div style={{ display: 'flex', flexDirection: 'column', gap: 20, minWidth: 0 }}>
          <BeliefCardsPanel
            snapshot={beliefCards.snapshot}
            loading={beliefCards.loading}
            error={beliefCards.error}
            actionRunning={beliefCards.actionRunning}
            onRefresh={beliefCards.refresh}
            onTransition={beliefCards.transitionCard}
          />
          <RunQualityPanel />
          <div
            className="glass-surface-card border"
            style={{
              ...SETTINGS_CARD_STYLE,
              minHeight: 520,
              overflow: 'hidden'
            }}
          >
            <MemoryListPanel
              memories={memories.memories}
              loading={memories.loading}
              error={memories.error}
              filters={filters}
              onFiltersChange={setFilters}
              onDeleteMemory={handleDeleteMemory}
            />
          </div>
        </div>
      </div>

      <section
        className="glass-surface-card border"
        style={{
          ...SETTINGS_CARD_STYLE,
          overflow: 'hidden'
        }}
      >
        <button
          type="button"
          onClick={() => setAdvancedOpen((current) => !current)}
          className="w-full flex items-center justify-between gap-3 text-left transition-colors duration-150 hover:bg-[var(--bg-hover)]"
          style={{ padding: '16px 20px' }}
          aria-expanded={advancedOpen}
        >
          <div>
            <h3 className="text-[15px] font-medium" style={{ color: 'var(--text-title)', margin: 0 }}>
              高级记忆工具
            </h3>
            <p className="text-[12px] leading-5" style={{ color: 'var(--text-muted)', margin: '4px 0 0' }}>
              手动创建、原始详情和触发规则放在这里。
            </p>
          </div>
          <ChevronRight
            className="w-4 h-4 transition-transform"
            style={{
              color: 'var(--text-muted)',
              transform: advancedOpen ? 'rotate(90deg)' : 'rotate(0deg)'
            }}
          />
        </button>
        {advancedOpen && (
          <div
            className="border-t"
            style={{ borderColor: 'var(--border-default)', padding: 20 }}
          >
            <div style={{ display: 'grid', gridTemplateColumns: 'minmax(300px, 340px) minmax(0, 1fr)', gap: 20, alignItems: 'start' }}>
              <MemoryCreator onCreated={refreshMemorySection} />
              <div
                className="border"
                style={{
                  ...SETTINGS_SUBTLE_CARD_STYLE,
                  minHeight: 420,
                  overflow: 'hidden'
                }}
              >
                <MemoryListPanel
                  memories={memories.memories}
                  loading={memories.loading}
                  error={memories.error}
                  filters={filters}
                  onFiltersChange={setFilters}
                  onDeleteMemory={handleDeleteMemory}
                  showAdvancedDetails
                />
              </div>
            </div>
            <div
              className="border"
              style={{
                ...SETTINGS_SUBTLE_CARD_STYLE,
                marginTop: 20,
                minHeight: 360,
                overflow: 'hidden'
              }}
            >
              <TriggerManager />
            </div>
          </div>
        )}
      </section>
    </div>
  )
}
