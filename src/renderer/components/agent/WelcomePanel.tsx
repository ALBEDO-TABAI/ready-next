import { useEffect, useMemo, useState } from 'react'

import {
  readFileEmergenceProjectContextSignature,
  selectFileEmergenceProjectContextSignature,
} from '../../modules/file-emergence/fileEmergenceTabContext'
import {
  buildWelcomeSuggestions,
  DEFAULT_WELCOME_SUGGESTIONS,
  type WelcomeSuggestion,
} from '../../modules/agent/welcomeSuggestions'
import { useDocTabs } from '../../stores/useDocTabs'
import { computeDesiredRoots, useWorkspace } from '../../stores/useWorkspace'

// Exact 5 × 6 topology of the R at the start of ready-wordmark.svg. Keeping
// the compact mark here avoids loading the full five-letter SVG into chat.
const READY_R_DOTS = [
  [0, 0], [1, 0], [2, 0], [3, 0],
  [0, 1], [1, 1], [3, 1], [4, 1],
  [0, 2], [1, 2], [4, 2],
  [0, 3], [1, 3], [2, 3], [3, 3],
  [0, 4], [1, 4], [3, 4], [4, 4],
  [0, 5], [1, 5], [4, 5],
] as const

interface WelcomePanelProps {
  onSetInputSuggestion: (value: string) => void
}

interface WelcomePanelViewProps extends WelcomePanelProps {
  suggestions: readonly WelcomeSuggestion[]
}

export function ReadyDotRMark(): React.ReactElement {
  return (
    <svg
      data-ready-dot-r="true"
      viewBox="-0.2 -0.2 5.4 6.4"
      preserveAspectRatio="xMidYMid meet"
      role="img"
      aria-label="Ready"
      style={{
        width: 40,
        height: 40,
        display: 'block',
        color: 'var(--rn-accent)',
      }}
    >
      {READY_R_DOTS.map(([column, row]) => (
        <circle
          key={`${column}-${row}`}
          cx={column + 0.5}
          cy={row + 0.5}
          r={0.37}
          fill="currentColor"
        />
      ))}
    </svg>
  )
}

export function WelcomePanelView({
  suggestions,
  onSetInputSuggestion,
}: WelcomePanelViewProps): React.ReactElement {
  return (
    <div
      data-ready-welcome="true"
      className="flex w-full flex-col items-center"
      style={{ padding: '12px 16px' }}
    >
      {/* The wordmark face (V12) stands alone: the dot mark above it was removed (user, 2026-11-13). Instrument Serif
          has a smaller x-height than the UI face, so it is set 1.1× the title size; 24 above the cards. */}
      <span
        data-typography-role="wordmark"
        style={{
          fontFamily: 'var(--rn-font-wordmark)',
          fontWeight: 400,
          fontSize: 'calc(var(--rn-t-title) * 1.1)',
          lineHeight: 'var(--rn-lh-title)',
          letterSpacing: '-0.01em',
          color: 'var(--rn-ink)',
          textAlign: 'center',
        }}
      >
        Ready for work , Ready for life.
      </span>

      <div
        className="grid w-full grid-cols-2"
        style={{ gap: 8, marginTop: 24 }}
        aria-live="polite"
        aria-label="根据文件涌现生成的下一步建议"
      >
        {suggestions.map((suggestion) => (
          <button
            key={suggestion.id}
            type="button"
            data-welcome-suggestion={suggestion.id}
            onClick={() => onSetInputSuggestion(suggestion.prompt)}
            aria-label={`将建议填入输入框：${suggestion.label}`}
            title={`${suggestion.label}：${suggestion.description}`}
            className="group min-w-0 text-left transition-[background-color,transform] duration-(--rn-d-1) ease-out bg-[var(--rn-inlay)] hover:-translate-y-px hover:bg-[var(--rn-inlay-hover)] active:translate-y-0 active:scale-[0.99]"
            style={{
              minHeight: 68,
              padding: 12,
              borderRadius: 'var(--rn-r-card)',
              border: 0,
              boxShadow: 'inset 0 1px 0 var(--rn-glass-inner-hi), inset 0 0 0 .5px var(--rn-hair-2)',
              display: 'flex',
              alignItems: 'flex-start',
              gap: 8,
            }}
          >
            <span
              aria-hidden="true"
              style={{
                width: 5,
                height: 5,
                marginTop: 5,
                borderRadius: '50%',
                flex: '0 0 auto',
                // A bullet, not a signal (DL5): the signal colour stays with the brand mark above.
                background: 'var(--rn-ink-3)',
              }}
            />
            <span className="flex min-w-0 flex-1 flex-col" style={{ gap: 5 }}>
              <span
                className="t-ui"
                data-typography-role="ui"
                style={{
                  color: 'var(--rn-ink)',
                  overflow: 'hidden',
                  textOverflow: 'ellipsis',
                  whiteSpace: 'nowrap',
                }}
              >
                {suggestion.label}
              </span>
              <span
                className="t-meta"
                data-typography-role="meta"
                style={{
                  color: 'var(--rn-ink-3)',
                  overflow: 'hidden',
                  textOverflow: 'ellipsis',
                  whiteSpace: 'nowrap',
                }}
              >
                {suggestion.description}
              </span>
            </span>
          </button>
        ))}
      </div>
    </div>
  )
}

export default function WelcomePanel({ onSetInputSuggestion }: WelcomePanelProps): React.ReactElement {
  const workspaceRoot = useWorkspace((state) => state.workspaceRoot)
  const pinnedFolders = useWorkspace((state) => state.pinnedFolders)
  const projectContextSignature = useDocTabs(selectFileEmergenceProjectContextSignature)
  const workspaceRoots = useMemo(
    () => computeDesiredRoots({ workspaceRoot, pinnedFolders }),
    [pinnedFolders, workspaceRoot],
  )
  const projectContext = useMemo(
    () => readFileEmergenceProjectContextSignature(projectContextSignature),
    [projectContextSignature],
  )
  const [suggestions, setSuggestions] = useState<readonly WelcomeSuggestion[]>(DEFAULT_WELCOME_SUGGESTIONS)

  useEffect(() => {
    let disposed = false
    setSuggestions(DEFAULT_WELCOME_SUGGESTIONS)
    if (workspaceRoots.length === 0 || !window.electronAPI?.fileEmergence?.getSnapshot) {
      return () => { disposed = true }
    }

    void window.electronAPI.fileEmergence.getSnapshot({
      workspaceRoots,
      projectContext,
    }).then((result) => {
      if (disposed) return
      if (!result.success || !result.data) {
        console.warn('[welcome] file emergence suggestions unavailable', result.error)
        return
      }
      setSuggestions(buildWelcomeSuggestions(result.data))
    }).catch((error) => {
      console.warn('[welcome] file emergence suggestions failed', error)
    })

    return () => { disposed = true }
  }, [projectContext, workspaceRoots])

  return (
    <WelcomePanelView
      suggestions={suggestions}
      onSetInputSuggestion={onSetInputSuggestion}
    />
  )
}
