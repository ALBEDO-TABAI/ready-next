import type { ComponentType, DragEvent, ReactNode, RefObject } from 'react'
import { ChevronLeft, ChevronRight, Info, Plus } from 'lucide-react'

import MiniCalendar from './MiniCalendar'
import CalendarSources, { type CalendarSource } from './CalendarSources'
import CalendarViewSelector from './CalendarViewSelector'
import { NewEventCard, NewEventMenu } from './NewEventMenu'
import type { ViewType } from './schedule-x-utils'
import {
  WORKBENCH_CANVAS_OUTER_PADDING_BOTTOM,
  WORKBENCH_CANVAS_OUTER_PADDING_TOP,
  WORKBENCH_CANVAS_OUTER_PADDING_X,
  WORKBENCH_HEADER_EDGE_X,
  WORKBENCH_SUPPORT_PANEL_WIDTH,
  WORKBENCH_TOOLBAR_ROW_HEIGHT,
} from '../../modules/workbench/chrome'

export interface CalendarPortalDescriptor {
  component: ComponentType<any>
  props: any
  wrapper: HTMLElement
}

interface CalendarWorkbenchShellProps {
  isMock: boolean
  loadError: string | null
  currentDate: Date
  selectedDate: Date | null
  eventsForMiniCalendar: { startTime: Date; color: string }[]
  sources: CalendarSource[]
  headerTitle: string
  viewType: ViewType
  calendarDropActive: boolean
  sxError: string | null
  sxContainerRef: RefObject<HTMLDivElement | null>
  mainViewRef: RefObject<HTMLDivElement | null>
  createButtonRef: RefObject<HTMLButtonElement | null>
  customPortalNodes: ReactNode
  newEventMenuPos: { top: number; left: number } | null
  newEventCardPos: { top: number; left: number } | null
  newEventCardDay: Date
  newEventCardHour: number
  newEventCardType: string
  newEventCardDesc?: string
  sourcesForView: { id: string; name: string; color: string }[]
  onDateChange: (date: Date) => void
  onSelectDate: (date: Date) => void
  onToggleSource: (id: string) => void
  onAddSource: (source: CalendarSource) => void
  onUpdateSource: (id: string, updates: Partial<CalendarSource>) => void
  onDeleteSource: (id: string) => void
  onOpenCreateMenu: () => void
  onViewTypeChange: (viewType: ViewType) => void
  onGoToToday: () => void
  onNavigateDate: (offset: number) => void
  onCalendarDragOver: (event: DragEvent<HTMLDivElement>) => void
  onCalendarDragLeave: () => void
  onCalendarDrop: (event: DragEvent<HTMLDivElement>) => void
  onQuickMenuSelect: (type: string) => void
  onCloseQuickCreate: () => void
  onQuickCardSubmit: (payload: {
    title: string
    startTime: Date
    endTime: Date
    calendarId: string
    color: string
    description?: string
    location?: string
  }) => void
  onCloseQuickCard: () => void
}

export default function CalendarWorkbenchShell(props: CalendarWorkbenchShellProps) {
  const {
    isMock,
    loadError,
    currentDate,
    selectedDate,
    eventsForMiniCalendar,
    sources,
    headerTitle,
    viewType,
    calendarDropActive,
    sxError,
    sxContainerRef,
    mainViewRef,
    createButtonRef,
    customPortalNodes,
    newEventMenuPos,
    newEventCardPos,
    newEventCardDay,
    newEventCardHour,
    newEventCardType,
    newEventCardDesc,
    sourcesForView,
    onDateChange,
    onSelectDate,
    onToggleSource,
    onAddSource,
    onUpdateSource,
    onDeleteSource,
    onOpenCreateMenu,
    onViewTypeChange,
    onGoToToday,
    onNavigateDate,
    onCalendarDragOver,
    onCalendarDragLeave,
    onCalendarDrop,
    onQuickMenuSelect,
    onCloseQuickCreate,
    onQuickCardSubmit,
    onCloseQuickCard,
  } = props

  return (
    <div className="workbench-mode-root calendar-mode-shell">
      {isMock && (
        <div className="flex items-center gap-2 px-4 py-2 bg-[var(--color-orange-light)] border-b border-[var(--color-orange)] flex-shrink-0">
          <Info className="w-4 h-4 text-[var(--color-orange)]" />
          <span className="text-[12px] text-[var(--color-orange)]">
            当前处于演示模式，数据为模拟数据
          </span>
        </div>
      )}

      {loadError && (
        <div
          className="glass-surface-floating mx-3 mt-2 flex items-center rounded-[12px] px-3 py-2 text-[12px]"
          style={{
            border: '1px solid var(--color-orange)',
            color: 'var(--text-secondary)',
            background: 'color-mix(in srgb, var(--surface-floating-bg) 34%, transparent)',
          }}
        >
          {loadError}
        </div>
      )}

      <div
        className="flex-1 min-h-0"
        style={{
          padding: `${WORKBENCH_CANVAS_OUTER_PADDING_TOP}px ${WORKBENCH_CANVAS_OUTER_PADDING_X}px ${WORKBENCH_CANVAS_OUTER_PADDING_BOTTOM}px`,
        }}
      >
        <div
          className="workbench-canvas-shell flex h-full min-h-0 overflow-hidden"
          style={{
            gap: 0,
            background: 'rgba(241, 244, 249, 0.94)',
            backdropFilter: 'blur(20px) saturate(0%)',
            WebkitBackdropFilter: 'blur(20px) saturate(0%)',
            position: 'relative',
          }}
        >
          <div
            className="panel-hover-scrollbar flex-shrink-0 overflow-auto flex flex-col"
            style={{
              width: WORKBENCH_SUPPORT_PANEL_WIDTH,
              minWidth: WORKBENCH_SUPPORT_PANEL_WIDTH,
              background: 'transparent',
              padding: '0 14px 12px',
            }}
          >
            <MiniCalendar
              currentDate={currentDate}
              selectedDate={selectedDate}
              events={eventsForMiniCalendar}
              onDateChange={onDateChange}
              onSelectDate={onSelectDate}
            />

            <div style={{ height: 8 }} />

            <CalendarSources
              sources={sources}
              onToggleSource={onToggleSource}
              onAddSource={onAddSource}
              onUpdateSource={onUpdateSource}
              onDeleteSource={onDeleteSource}
            />
          </div>

          <div
            className="flex flex-1 min-h-0 min-w-0 overflow-hidden"
            style={{
              background: 'transparent',
              boxShadow: 'none',
              marginLeft: -2,
            }}
          >
            <div
              ref={mainViewRef}
              className="flex-1 flex flex-col"
              style={{
                background: 'transparent',
                position: 'relative',
              }}
            >
              <div
                className="flex items-center justify-between flex-shrink-0"
                style={{
                  height: WORKBENCH_TOOLBAR_ROW_HEIGHT,
                  padding: `0 ${WORKBENCH_HEADER_EDGE_X}px`,
                  background: 'transparent',
                  boxSizing: 'border-box',
                }}
              >
                <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                  <button
                    ref={createButtonRef}
                    onClick={onOpenCreateMenu}
                    className="glass-surface-card"
                    style={{
                      height: 28,
                      borderRadius: 8,
                      border: '1px solid var(--border-default)',
                      background: 'color-mix(in srgb, var(--surface-card-bg) 28%, transparent)',
                      color: 'var(--text-title)',
                      display: 'inline-flex',
                      alignItems: 'center',
                      gap: 5,
                      padding: '0 10px',
                      cursor: 'pointer',
                      fontSize: 12,
                      fontWeight: 500,
                    }}
                  >
                    <Plus style={{ width: 13, height: 13, color: 'var(--color-red)' }} />
                    新建
                  </button>
                  <span style={{ fontSize: 12, fontWeight: 600, color: 'var(--text-title)' }}>
                    {headerTitle}
                  </span>
                </div>
                <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
                  <CalendarViewSelector viewType={viewType} onViewTypeChange={onViewTypeChange} />
                  <button
                    onClick={onGoToToday}
                    style={{
                      padding: '4px 12px', borderRadius: 10,
                      border: '1px solid var(--border-input)', background: 'transparent',
                      fontSize: 12, fontWeight: 500, color: 'var(--text-body)',
                      cursor: 'pointer',
                    }}
                  >
                    今天
                  </button>
                  <ChevronLeft
                    onClick={() => onNavigateDate(-1)}
                    style={{ width: 16, height: 16, color: 'var(--text-muted)', cursor: 'pointer' }}
                  />
                  <ChevronRight
                    onClick={() => onNavigateDate(1)}
                    style={{ width: 16, height: 16, color: 'var(--text-muted)', cursor: 'pointer' }}
                  />
                </div>
              </div>

              <div
                className="flex-1 overflow-hidden relative"
                onDragOver={onCalendarDragOver}
                onDragLeave={onCalendarDragLeave}
                onDrop={onCalendarDrop}
                style={{
                  background: calendarDropActive ? 'var(--color-blue-light)' : 'transparent',
                  transition: 'background 0.15s ease',
                }}
              >
                {sxError ? (
                  <div className="flex items-center justify-center h-full">
                    <div style={{ textAlign: 'center', color: 'var(--color-red)', fontSize: 13 }}>
                      <p style={{ fontWeight: 600, marginBottom: 8 }}>日历初始化失败</p>
                      <pre style={{ fontSize: 11, color: 'var(--text-muted)', whiteSpace: 'pre-wrap', maxWidth: 400 }}>{sxError}</pre>
                    </div>
                  </div>
                ) : (
                  <>
                    <div
                      ref={sxContainerRef}
                      className="sx-react-calendar-wrapper"
                      style={{ width: '100%', height: '100%' }}
                    />
                    {customPortalNodes}
                    {calendarDropActive && (
                      <div
                        className="absolute inset-0 flex items-center justify-center pointer-events-none"
                        style={{ zIndex: 30 }}
                      >
                        <div
                          className="glass-surface-floating"
                          style={{
                            padding: '8px 14px',
                            borderRadius: 12,
                            border: '1px dashed var(--color-blue)',
                            background: 'color-mix(in srgb, var(--surface-floating-bg) 32%, transparent)',
                            color: 'var(--color-blue)',
                            fontSize: 12,
                            fontWeight: 600,
                          }}
                        >
                          松开后创建带附件备注的新日程
                        </div>
                      </div>
                    )}
                  </>
                )}
              </div>

              {newEventMenuPos && (
                <NewEventMenu
                  position={newEventMenuPos}
                  onSelect={onQuickMenuSelect}
                  onClose={onCloseQuickCreate}
                />
              )}

              {newEventCardPos && (
                <NewEventCard
                  day={newEventCardDay}
                  hour={newEventCardHour}
                  position={newEventCardPos}
                  sources={sourcesForView}
                  eventType={newEventCardType}
                  defaultDescription={newEventCardDesc}
                  onSubmit={onQuickCardSubmit}
                  onClose={onCloseQuickCard}
                />
              )}
            </div>
          </div>
        </div>
      </div>
    </div>
  )
}
