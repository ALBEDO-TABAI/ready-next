/**
 * Stage V V3.4a — visible session tab strip for multi-session chat.
 *
 * Renders a horizontal row of session chips driven by `useAgent`'s
 * `sessionOrder` + `sessions` Record + `activeSessionId`. Behavior:
 *
 *  - One chip per session id in `sessionOrder`; chip label is "会话 N"
 *    (1-indexed) plus a status dot (live=green / running=blue /
 *    done/error/cancelled/closed=gray) derived from `SessionSlice.state`
 *    and `pendingSendCount` (pending coalesced sends are interpreted as
 *    "running" for the dot color).
 *  - Click a chip → `setActiveSessionId(id)`.
 *  - "+ 新建" button appended to the right; disabled when
 *    `sessionOrder.length >= 3` (the renderer-side hard limit from plan
 *    §4 V3.4). Click → `createNewSession()`.
 *  - Empty state (`sessionOrder.length === 0`): the entire strip renders
 *    `null`, so the V6 fixture (`chat-panel-baseline.test.ts`) sees no
 *    new semantic markers. Once the first session is created the strip
 *    appears with the "+ 新建" button alongside the new chip.
 *
 * The component reads `useAgent` directly — no props, no IPC. SessionTabs
 * is mounted inside `ChatPanel.tsx` above the existing chrome but inside
 * the chat-panel root so click handlers route through React's normal
 * delegation.
 *
 * Plan: docs/superpowers/plans/2026-05-21-V-stage-v-comprehensive-implementation.md
 *   §4 V3.4
 */

import { useAgent, type SessionSliceState } from '../../../../stores/useAgent'

/** Max concurrent sessions enforced renderer-side (plan §4 V3.4 + V3.5). */
const MAX_CONCURRENT_SESSIONS = 3

type StatusDotColor = 'live' | 'running' | 'done'

function classifyStatus(
  sliceState: SessionSliceState,
  pendingSendCount: number,
): StatusDotColor {
  // Terminal states collapse onto the gray "done" dot regardless of how the
  // session ended (done/error/cancelled/closed). UI doesn't differentiate
  // these in the tab strip — finer status lives in the task projection card.
  if (sliceState !== 'live') return 'done'
  // A live session with buffered coalesced sends is treated as "running"
  // (blue dot) so the user sees activity even before the next request fires.
  if (pendingSendCount > 0) return 'running'
  return 'live'
}

function statusDotColorVar(status: StatusDotColor): string {
  switch (status) {
    case 'live':
      return '#22c55e' // green-500
    case 'running':
      return '#3b82f6' // blue-500
    case 'done':
      return '#9ca3af' // gray-400
  }
}

export default function SessionTabs() {
  const sessionOrder = useAgent((state) => state.sessionOrder)
  const sessions = useAgent((state) => state.sessions)
  const activeSessionId = useAgent((state) => state.activeSessionId)
  const setActiveSessionId = useAgent((state) => state.setActiveSessionId)
  const createNewSession = useAgent((state) => state.createNewSession)

  // V6 fixture compatibility: cold-start state renders nothing. The strip
  // only appears once the user has explicitly created a session.
  if (sessionOrder.length === 0) return null

  const createDisabled = sessionOrder.length >= MAX_CONCURRENT_SESSIONS

  return (
    <div
      data-testid="session-tabs-strip"
      style={{
        display: 'flex',
        flexDirection: 'row',
        alignItems: 'center',
        gap: 6,
        padding: '4px 8px',
        flexWrap: 'nowrap',
        overflowX: 'auto',
      }}
    >
      {sessionOrder.map((sessionId, index) => {
        const slice = sessions[sessionId]
        const status = classifyStatus(
          slice?.state ?? 'live',
          slice?.pendingSendCount ?? 0,
        )
        const isActive = sessionId === activeSessionId
        return (
          <button
            type="button"
            key={sessionId}
            data-testid="session-tab-chip"
            data-session-tab-id={sessionId}
            data-session-tab-active={isActive ? 'true' : 'false'}
            data-session-tab-status={status}
            onClick={() => setActiveSessionId(sessionId)}
            style={{
              display: 'inline-flex',
              alignItems: 'center',
              gap: 6,
              padding: '3px 10px',
              borderRadius: 12,
              border: '1px solid var(--border-light, #e5e7eb)',
              background: isActive
                ? 'var(--surface-active, rgba(59,130,246,0.08))'
                : 'transparent',
              fontSize: 12,
              color: 'var(--text-body, #1f2937)',
              cursor: 'pointer',
              whiteSpace: 'nowrap',
            }}
          >
            <span
              aria-hidden="true"
              style={{
                width: 8,
                height: 8,
                borderRadius: '50%',
                background: statusDotColorVar(status),
                flexShrink: 0,
              }}
            />
            <span>{`会话 ${index + 1}`}</span>
          </button>
        )
      })}
      <button
        type="button"
        data-testid="session-tab-new"
        data-session-tab-new-disabled={createDisabled ? 'true' : 'false'}
        disabled={createDisabled}
        onClick={() => {
          if (createDisabled) return
          createNewSession()
        }}
        title={createDisabled ? '已达到 3 个会话上限' : '新建会话'}
        style={{
          display: 'inline-flex',
          alignItems: 'center',
          gap: 4,
          padding: '3px 10px',
          borderRadius: 12,
          border: '1px dashed var(--border-light, #d1d5db)',
          background: 'transparent',
          fontSize: 12,
          color: createDisabled
            ? 'var(--text-disabled, #9ca3af)'
            : 'var(--text-body, #1f2937)',
          cursor: createDisabled ? 'not-allowed' : 'pointer',
          opacity: createDisabled ? 0.5 : 1,
          whiteSpace: 'nowrap',
        }}
      >
        + 新建
      </button>
    </div>
  )
}
