import { useEffect, useMemo, useState, type ChangeEvent, type KeyboardEvent } from 'react'
import { Eye, EyeOff, RotateCcw } from 'lucide-react'
import type { PetDefinition, PetSettings } from '../../../shared/pet'
import { DEFAULT_PET_SETTINGS } from '../../../shared/pet'
import {
  SETTINGS_CARD_STYLE,
  SETTINGS_FLAT_BUTTON_STYLE,
  SETTINGS_INPUT_STYLE,
  SETTINGS_PRIMARY_BUTTON_STYLE,
  SETTINGS_SUBTLE_CARD_STYLE,
} from './settings-theme'

function Toggle({
  checked,
  onChange,
}: {
  checked: boolean
  onChange: (checked: boolean) => void
}) {
  return (
    <button
      type="button"
      onClick={() => onChange(!checked)}
      className="flex-shrink-0 transition-colors duration-200"
      style={{
        width: 48,
        height: 28,
        borderRadius: 999,
        position: 'relative',
        border: `1px solid ${checked
          ? 'color-mix(in srgb, var(--color-blue) 34%, transparent)'
          : 'color-mix(in srgb, var(--lg-border-soft) 88%, transparent)'}`,
        background: checked
          ? 'color-mix(in srgb, var(--color-blue) 82%, var(--surface-floating-bg) 18%)'
          : 'var(--surface-floating-bg)',
        boxShadow: checked
          ? '0 10px 22px color-mix(in srgb, var(--color-blue) 16%, transparent), inset 0 1px 0 rgba(255,255,255,0.35)'
          : 'inset 0 1px 0 rgba(255,255,255,0.18)',
      }}
    >
      <span
        className="absolute top-[3px] h-5 w-5 rounded-full transition-transform duration-200"
        style={{
          left: 3,
          transform: checked ? 'translateX(20px)' : 'translateX(0)',
          background: '#fff',
          boxShadow: '0 4px 10px rgba(15,23,42,0.16)',
        }}
      />
    </button>
  )
}

function EditableText({
  value,
  placeholder,
  multiline = false,
  onSave,
}: {
  value: string
  placeholder: string
  multiline?: boolean
  onSave: (value: string) => void
}) {
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState(value)

  useEffect(() => {
    if (!editing) setDraft(value)
  }, [editing, value])

  const commit = () => {
    const next = draft.trim()
    setEditing(false)
    if (next && next !== value) onSave(next)
  }

  if (editing) {
    const sharedProps = {
      value: draft,
      autoFocus: true,
      onChange: (event: ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) => setDraft(event.target.value),
      onBlur: commit,
      onKeyDown: (event: KeyboardEvent<HTMLInputElement | HTMLTextAreaElement>) => {
        if (event.key === 'Enter' && !event.shiftKey) {
          event.preventDefault()
          commit()
        }
        if (event.key === 'Escape') {
          setDraft(value)
          setEditing(false)
        }
      },
      style: { ...SETTINGS_INPUT_STYLE, width: '100%', padding: multiline ? '9px 10px' : '7px 10px' },
    }
    return multiline
      ? <textarea {...sharedProps} rows={2} />
      : <input {...sharedProps} />
  }

  return (
    <button
      type="button"
      onClick={() => setEditing(true)}
      className="block w-full rounded-lg text-left transition-colors hover:bg-[var(--bg-hover)]"
      style={{ padding: '3px 4px', color: multiline ? 'var(--text-light)' : 'var(--text-title)' }}
      title="点击编辑"
    >
      {value || placeholder}
    </button>
  )
}

function PetThumb({ pet }: { pet: PetDefinition }) {
  if (!pet.available || !pet.spritesheetUrl) {
    return (
      <div className="grid h-[52px] w-12 place-items-center rounded-xl border text-[13px]" style={SETTINGS_SUBTLE_CARD_STYLE}>
        ?
      </div>
    )
  }
  return (
    <div
      className="h-[52px] w-12 rounded-xl border"
      style={{
        ...SETTINGS_SUBTLE_CARD_STYLE,
        backgroundImage: `url("${pet.spritesheetUrl}")`,
        backgroundRepeat: 'no-repeat',
        backgroundSize: '384px 468px',
        backgroundPosition: '0 0',
        imageRendering: 'pixelated',
      }}
    />
  )
}

export default function PetSettingsPanel() {
  const [settings, setSettings] = useState<PetSettings>(DEFAULT_PET_SETTINGS)
  const [pets, setPets] = useState<PetDefinition[]>([])
  const [error, setError] = useState<string | null>(null)
  const availablePets = useMemo(() => pets.filter((pet) => pet.available), [pets])

  const reload = async () => {
    const [settingsResult, petsResult] = await Promise.all([
      window.electronAPI.pet.getSettings(),
      window.electronAPI.pet.listPets(),
    ])
    if (settingsResult.success && settingsResult.data) setSettings(settingsResult.data)
    if (petsResult.success && petsResult.data) setPets(petsResult.data)
    if (!settingsResult.success || !petsResult.success) {
      setError(settingsResult.error || petsResult.error || '宠物设置读取失败')
    } else {
      setError(null)
    }
  }

  useEffect(() => {
    void reload()
  }, [])

  const updateSettings = async (patch: Partial<PetSettings>) => {
    const result = await window.electronAPI.pet.updateSettings(patch)
    if (!result.success || !result.data) {
      setError(result.error || '宠物设置保存失败')
      return
    }
    setSettings(result.data)
    setError(null)
  }

  const setPet = async (petId: string) => {
    const result = await window.electronAPI.pet.setPet(petId)
    if (result.success && result.data) {
      setSettings(result.data)
      setError(null)
    } else {
      setError(result.error || '宠物切换失败')
    }
  }

  const updatePetMeta = async (petId: string, patch: { displayName?: string; description?: string }) => {
    const nextMeta = {
      ...settings.customPetMeta,
      [petId]: {
        ...(settings.customPetMeta[petId] || {}),
        ...patch,
      },
    }
    await updateSettings({ customPetMeta: nextMeta })
    await reload()
  }

  return (
    <div className="flex flex-col gap-5">
      {error && (
        <div className="rounded-2xl border px-4 py-3 text-[12px]" style={{ ...SETTINGS_SUBTLE_CARD_STYLE, color: 'var(--color-red)' }}>
          {error}
        </div>
      )}

      <section className="glass-surface-card rounded-2xl border" style={{ ...SETTINGS_CARD_STYLE, padding: '18px 20px' }}>
        <div className="grid gap-4 md:grid-cols-3">
          <div className="flex items-center justify-between gap-4">
            <div>
              <div className="text-[14px] font-semibold" style={{ color: 'var(--text-title)' }}>启用桌面宠物</div>
              <div className="text-[12px] leading-5" style={{ color: 'var(--text-light)' }}>默认关闭，打开后显示系统级悬浮猫</div>
            </div>
            <Toggle checked={settings.enabled} onChange={(checked) => { void updateSettings({ enabled: checked }) }} />
          </div>

          <div className="flex items-center justify-between gap-4">
            <div>
              <div className="text-[14px] font-semibold" style={{ color: 'var(--text-title)' }}>工作气泡</div>
              <div className="text-[12px] leading-5" style={{ color: 'var(--text-light)' }}>Agent 工作时显示平衡摘要</div>
            </div>
            <Toggle checked={settings.bubbleEnabled} onChange={(checked) => { void updateSettings({ bubbleEnabled: checked }) }} />
          </div>

          <div className="flex items-center justify-between gap-4">
            <div>
              <div className="text-[14px] font-semibold" style={{ color: 'var(--text-title)' }}>置顶显示</div>
              <div className="text-[12px] leading-5" style={{ color: 'var(--text-light)' }}>Ready 后台时也留在最前</div>
            </div>
            <Toggle checked={settings.alwaysOnTop} onChange={(checked) => { void updateSettings({ alwaysOnTop: checked }) }} />
          </div>
        </div>
      </section>

      <section className="glass-surface-card rounded-2xl border" style={{ ...SETTINGS_CARD_STYLE, padding: '18px 20px' }}>
        <div className="mb-4 flex items-center justify-between gap-3">
          <div>
            <h3 className="text-[15px] font-semibold" style={{ color: 'var(--text-title)' }}>显示尺寸</h3>
            <p className="text-[12px] leading-5" style={{ color: 'var(--text-light)' }}>尺寸改变后会同步调整悬浮窗大小</p>
          </div>
          <button
            type="button"
            className="inline-flex items-center gap-1.5 rounded-xl px-3 py-2 text-[12px]"
            style={SETTINGS_FLAT_BUTTON_STYLE}
            onClick={() => { void window.electronAPI.pet.resetPosition().then((result) => result.success && result.data && setSettings(result.data)) }}
          >
            <RotateCcw className="h-3.5 w-3.5" />
            重置位置
          </button>
        </div>
        <div className="flex gap-2">
          {(['small', 'medium', 'large'] as const).map((size) => {
            const active = settings.size === size
            return (
              <button
                key={size}
                type="button"
                className="rounded-xl px-4 py-2 text-[12px] font-semibold transition-colors"
                style={active ? SETTINGS_PRIMARY_BUTTON_STYLE : SETTINGS_FLAT_BUTTON_STYLE}
                onClick={() => { void updateSettings({ size }) }}
              >
                {size === 'small' ? '小' : size === 'large' ? '大' : '中'}
              </button>
            )
          })}
        </div>
      </section>

      <section className="glass-surface-card rounded-2xl border" style={{ ...SETTINGS_CARD_STYLE, padding: '18px 20px' }}>
        <div className="mb-4 flex items-center justify-between gap-3">
          <div>
            <h3 className="text-[15px] font-semibold" style={{ color: 'var(--text-title)' }}>选择猫猫</h3>
            <p className="text-[12px] leading-5" style={{ color: 'var(--text-light)' }}>
              已找到 {availablePets.length} 只可用宠物，名称和描述可点击编辑
            </p>
          </div>
          <button
            type="button"
            className="inline-flex items-center gap-1.5 rounded-xl px-3 py-2 text-[12px]"
            style={SETTINGS_FLAT_BUTTON_STYLE}
            onClick={() => { void (settings.enabled ? window.electronAPI.pet.hide() : window.electronAPI.pet.show()) }}
          >
            {settings.enabled ? <EyeOff className="h-3.5 w-3.5" /> : <Eye className="h-3.5 w-3.5" />}
            {settings.enabled ? '临时隐藏' : '显示一次'}
          </button>
        </div>

        <div className="grid gap-3 md:grid-cols-2">
          {pets.map((pet) => {
            const active = pet.id === settings.selectedPetId
            return (
              <div
                key={pet.id}
                className="glass-surface-card rounded-2xl border transition-[background-color,border-color,box-shadow]"
                style={{
                  ...SETTINGS_SUBTLE_CARD_STYLE,
                  padding: 12,
                  borderColor: active
                    ? 'color-mix(in srgb, var(--color-blue) 44%, var(--lg-border-soft) 56%)'
                    : SETTINGS_SUBTLE_CARD_STYLE.borderColor,
                }}
              >
                <div className="flex gap-3">
                  <button type="button" onClick={() => { void setPet(pet.id) }} disabled={!pet.available}>
                    <PetThumb pet={pet} />
                  </button>
                  <div className="min-w-0 flex-1">
                    <EditableText
                      value={pet.displayName}
                      placeholder="未命名宠物"
                      onSave={(value) => { void updatePetMeta(pet.id, { displayName: value }) }}
                    />
                    <EditableText
                      value={pet.description}
                      placeholder={pet.available ? '添加描述' : '资源不可用'}
                      multiline
                      onSave={(value) => { void updatePetMeta(pet.id, { description: value }) }}
                    />
                    <div className="mt-2 flex items-center justify-between gap-2">
                      <span className="text-[10px]" style={{ color: 'var(--text-light)' }}>
                        {pet.source === 'builtin' ? '内置' : 'Codex'} · {pet.available ? '可用' : '不可用'}
                      </span>
                      <button
                        type="button"
                        className="rounded-lg px-2.5 py-1.5 text-[11px]"
                        style={active ? SETTINGS_PRIMARY_BUTTON_STYLE : SETTINGS_FLAT_BUTTON_STYLE}
                        disabled={!pet.available}
                        onClick={() => { void setPet(pet.id) }}
                      >
                        {active ? '已选择' : '选择'}
                      </button>
                    </div>
                  </div>
                </div>
              </div>
            )
          })}
        </div>
      </section>
    </div>
  )
}
