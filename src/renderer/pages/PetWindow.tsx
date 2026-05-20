import { useEffect, useMemo, useRef, useState } from 'react'
import { DEFAULT_PET_SETTINGS, PET_ANIMATION_FRAME_COUNTS } from '../../shared/pet'
import type {
  PetActivitySnapshot,
  PetAnimationState,
  PetDefinition,
  PetSettings,
  PetStickyNote,
  PetWindowSnapshot,
} from '../../shared/pet'

const PET_ROW: Record<PetAnimationState, number> = {
  idle: 0,
  'running-right': 1,
  'running-left': 2,
  waving: 3,
  jumping: 4,
  failed: 5,
  waiting: 6,
  running: 7,
  review: 8,
}

const EMPTY_ACTIVITY: PetActivitySnapshot = {
  busy: false,
  state: 'idle',
  title: '空闲',
  summary: '',
  events: [],
  updatedAt: null,
}

function pickSelectedPet(pets: PetDefinition[], selectedPetId: string): PetDefinition | null {
  return pets.find((pet) => pet.id === selectedPetId && pet.available)
    || pets.find((pet) => pet.available)
    || pets[0]
    || null
}

export default function PetWindow() {
  const [settings, setSettings] = useState<PetSettings>(DEFAULT_PET_SETTINGS)
  const [pets, setPets] = useState<PetDefinition[]>([])
  const [activity, setActivity] = useState<PetActivitySnapshot>(EMPTY_ACTIVITY)
  const [stickyNotes, setStickyNotes] = useState<PetStickyNote[]>([])
  const [expandedStickyIds, setExpandedStickyIds] = useState<Set<string>>(() => new Set())
  const [expanded, setExpanded] = useState(false)
  const [dragState, setDragState] = useState<PetAnimationState | null>(null)
  const lastPointerRef = useRef<{ x: number; y: number } | null>(null)

  useEffect(() => {
    document.documentElement.classList.add('pet-window-root')
    document.documentElement.setAttribute('data-skin', 'liquid-glass')
    document.body.classList.add('pet-window-body')
    return () => {
      document.documentElement.classList.remove('pet-window-root')
      document.body.classList.remove('pet-window-body')
    }
  }, [])

  useEffect(() => {
    const visibleIds = new Set(stickyNotes.map((note) => note.id))
    setExpandedStickyIds((current) => new Set([...current].filter((id) => visibleIds.has(id))))
  }, [stickyNotes])

  useEffect(() => {
    let cancelled = false
    const applyTheme = (resolved: 'light' | 'dark') => {
      if (cancelled) return
      document.documentElement.setAttribute('data-theme', resolved)
      document.documentElement.setAttribute('data-skin', 'liquid-glass')
    }
    const syncTheme = async () => {
      const result = await window.electronAPI.theme.get().catch(() => null)
      if (cancelled || !result?.success || !result.data) return
      applyTheme(result.data.resolved)
    }
    void syncTheme()
    const unsubscribe = window.electronAPI.theme.onChanged((snapshot) => {
      applyTheme(snapshot.resolved)
    })
    return () => {
      cancelled = true
      unsubscribe()
    }
  }, [])

  useEffect(() => {
    let mounted = true
    const applySnapshot = (snapshot: PetWindowSnapshot) => {
      setSettings(snapshot.settings)
      setPets(snapshot.pets)
      setActivity(snapshot.activity)
      setStickyNotes(snapshot.stickyNotes || [])
    }

    // fire-and-forget: pet snapshot bootstrap fetch; the onSnapshot subscription below will deliver the next pet update so a missed initial fetch self-heals.
    window.electronAPI.pet.getSnapshot()
      .then((result) => {
        if (mounted && result.success && result.data) applySnapshot(result.data)
      })
      .catch(() => undefined)

    const unsubscribe = window.electronAPI.pet.onSnapshot(applySnapshot)
    return () => {
      mounted = false
      unsubscribe()
    }
  }, [])

  const selectedPet = useMemo(() => pickSelectedPet(pets, settings.selectedPetId), [pets, settings.selectedPetId])
  const visibleActivity = settings.bubbleEnabled && activity.busy ? activity : null
  const hasBubbleStack = Boolean(visibleActivity) || stickyNotes.length > 0
  const petState = dragState || visibleActivity?.state || 'idle'
  const frameCount = PET_ANIMATION_FRAME_COUNTS[petState]

  const updateSettings = async (patch: Partial<PetSettings>) => {
    const result = await window.electronAPI.pet.updateSettings(patch)
    if (result.success && result.data) setSettings(result.data)
  }

  const dismissStickyNote = async (id: string) => {
    const result = await window.electronAPI.pet.dismissStickyNote(id)
    if (result.success) {
      setStickyNotes((notes) => notes.filter((note) => note.id !== id))
    }
  }

  const toggleStickyNote = (id: string) => {
    setExpandedStickyIds((current) => {
      const next = new Set(current)
      if (next.has(id)) {
        next.delete(id)
      } else {
        next.add(id)
      }
      return next
    })
  }

  const onPointerDown = (event: React.PointerEvent<HTMLDivElement>) => {
    lastPointerRef.current = { x: event.screenX, y: event.screenY }
    event.currentTarget.setPointerCapture(event.pointerId)
  }

  const onPointerMove = (event: React.PointerEvent<HTMLDivElement>) => {
    const previous = lastPointerRef.current
    if (!previous) return
    const dx = event.screenX - previous.x
    const dy = event.screenY - previous.y
    if (Math.abs(dx) < 1 && Math.abs(dy) < 1) return
    setDragState(dx < 0 ? 'running-left' : 'running-right')
    lastPointerRef.current = { x: event.screenX, y: event.screenY }
    void window.electronAPI.pet.moveBy({ dx, dy })
  }

  const endDrag = (event: React.PointerEvent<HTMLDivElement>) => {
    lastPointerRef.current = null
    setDragState(null)
    try {
      event.currentTarget.releasePointerCapture(event.pointerId)
    } catch {
      // Pointer capture may already be released by the OS drag boundary.
    }
  }

  return (
    <div className={`pet-window pet-window-${settings.size}`}>
      {hasBubbleStack && (
        <div className={`pet-bubble-stack ${visibleActivity ? 'has-activity' : 'is-sticky-only'}`}>
          {stickyNotes.length > 0 && (
            <div className="pet-sticky-stack" aria-label="宠物便利贴">
              {stickyNotes.map((note) => {
                const stickyExpanded = expandedStickyIds.has(note.id)
                return (
                <article
                  key={note.id}
                  className={`pet-sticky ready-floating-menu pet-sticky-${note.tone} ${stickyExpanded ? 'is-expanded' : ''}`}
                  tabIndex={0}
                  aria-expanded={stickyExpanded}
                  onClick={() => toggleStickyNote(note.id)}
                  onKeyDown={(event) => {
                    if (event.key === 'Enter' || event.key === ' ') {
                      event.preventDefault()
                      toggleStickyNote(note.id)
                    }
                  }}
                >
                  <div className="pet-sticky-content">
                    {note.title && <strong>{note.title}</strong>}
                    <span>{note.body}</span>
                  </div>
                  <button
                    type="button"
                    className="pet-sticky-close"
                    title="关闭便利贴"
                    aria-label="关闭便利贴"
                    onClick={(event) => {
                      event.stopPropagation()
                      void dismissStickyNote(note.id)
                    }}
                  >
                    ×
                  </button>
                </article>
                )
              })}
            </div>
          )}

          {visibleActivity && (
            <section className={`pet-bubble ready-floating-menu ${expanded ? 'is-expanded' : ''}`}>
              <button
                type="button"
                className="pet-bubble-main"
                onClick={() => setExpanded((current) => !current)}
              >
                <span className={`pet-status-dot pet-status-${visibleActivity.state}`} />
                <span className="pet-bubble-copy">
                  <strong>{visibleActivity.title}</strong>
                  <span>{visibleActivity.summary}</span>
                </span>
              </button>
              {expanded && visibleActivity.events.length > 0 && (
                <div className="pet-bubble-events">
                  {visibleActivity.events.map((event) => (
                    <div key={event.id} className="pet-bubble-event">
                      {event.text}
                    </div>
                  ))}
                </div>
              )}
            </section>
          )}
        </div>
      )}

      <div className="pet-controls">
        <button
          type="button"
          title={settings.bubbleEnabled ? '关闭气泡' : '开启气泡'}
          onClick={() => { void updateSettings({ bubbleEnabled: !settings.bubbleEnabled }) }}
        >
          气
        </button>
        <button type="button" title="关闭宠物" onClick={() => { void updateSettings({ enabled: false }) }}>×</button>
      </div>

      <div
        className="pet-sprite-hitbox"
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={endDrag}
        onPointerCancel={endDrag}
      >
        {selectedPet?.spritesheetUrl ? (
          <div
            className={`pet-sprite pet-sprite-frames-${frameCount}`}
            title={selectedPet.displayName}
            style={{
              backgroundImage: `url("${selectedPet.spritesheetUrl}")`,
              '--pet-row': PET_ROW[petState],
            } as React.CSSProperties}
          />
        ) : (
          <div className="pet-sprite-missing">?</div>
        )}
      </div>
    </div>
  )
}
