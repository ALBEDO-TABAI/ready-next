import { useEffect, useMemo, useState, type ChangeEvent, type KeyboardEvent } from 'react'
import { Cat, Check, Eye, EyeOff, RotateCcw } from 'lucide-react'
import type { PetDefinition, PetSettings, PetSize } from '../../../shared/pet'
import { DEFAULT_PET_SETTINGS } from '../../../shared/pet'
import {
  SettingsCard,
  SettingsGroup,
  SettingsNotice,
  SettingsRow,
} from '../../pages/settings/settings-shared'
import { Button, Input, Segmented, Switch, Textarea } from '../ui'

const PET_SIZE_OPTIONS: { value: PetSize; label: string }[] = [
  { value: 'small', label: '小' },
  { value: 'medium', label: '中' },
  { value: 'large', label: '大' },
]

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
      onClick: (event: React.MouseEvent) => event.stopPropagation(),
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
    }
    return multiline
      ? <Textarea {...sharedProps} rows={2} style={{ minHeight: 0, fontSize: 12 }} />
      : <Input {...sharedProps} style={{ height: 30 }} />
  }

  return (
    <button
      type="button"
      onClick={(event) => {
        event.stopPropagation()
        setEditing(true)
      }}
      className={`block w-full rounded-[7px] text-left transition-colors hover:bg-[var(--rn-fill)] ${multiline ? 'text-[12px] leading-[1.55]' : 'text-[13px] font-medium'}`}
      style={{ padding: '2px 6px', margin: '0 -6px', width: 'calc(100% + 12px)', color: multiline ? 'var(--rn-ink-2)' : 'var(--rn-ink)' }}
      title="点击编辑"
    >
      {value || placeholder}
    </button>
  )
}

function PetThumb({ pet }: { pet: PetDefinition }) {
  const frame = { background: 'var(--rn-fill)' }
  if (!pet.available || !pet.spritesheetUrl) {
    return (
      <div className="grid h-[52px] w-12 shrink-0 place-items-center rounded-[10px]" style={frame}>
        <Cat size={20} strokeWidth={1.6} style={{ color: pet.available ? 'var(--rn-ink-2)' : 'var(--rn-ink-3)' }} />
      </div>
    )
  }
  return (
    <div
      className="h-[52px] w-12 shrink-0 rounded-[10px]"
      style={{
        ...frame,
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
    <div className="sx-stack">
      {error && <SettingsNotice tone="danger" title={error} />}

      <SettingsGroup label="显示">
        <SettingsCard>
          <SettingsRow label="启用桌面宠物" description="默认关闭，打开后显示系统级悬浮猫">
            <Switch label="启用桌面宠物" checked={settings.enabled} onChange={(checked) => { void updateSettings({ enabled: checked }) }} />
          </SettingsRow>
          <SettingsRow label="工作气泡" description="Agent 工作时显示平衡摘要">
            <Switch label="工作气泡" checked={settings.bubbleEnabled} onChange={(checked) => { void updateSettings({ bubbleEnabled: checked }) }} />
          </SettingsRow>
          <SettingsRow label="置顶显示" description="Ready 后台时也留在最前">
            <Switch label="置顶显示" checked={settings.alwaysOnTop} onChange={(checked) => { void updateSettings({ alwaysOnTop: checked }) }} />
          </SettingsRow>
          <SettingsRow label="显示尺寸" description="尺寸改变后会同步调整悬浮窗大小">
            <Button
              variant="ghost"
              size="sm"
              icon={<RotateCcw />}
              onClick={() => { void window.electronAPI.pet.resetPosition().then((result) => result.success && result.data && setSettings(result.data)) }}
            >
              重置位置
            </Button>
            <Segmented
              label="显示尺寸"
              value={settings.size}
              options={PET_SIZE_OPTIONS}
              onChange={(size) => { void updateSettings({ size }) }}
            />
          </SettingsRow>
        </SettingsCard>
      </SettingsGroup>

      <SettingsCard
        title="选择猫猫"
        description={`已找到 ${availablePets.length} 只可用宠物，名称和描述可点击编辑`}
        actions={(
          <Button
            size="sm"
            icon={settings.enabled ? <EyeOff /> : <Eye />}
            onClick={() => { void (settings.enabled ? window.electronAPI.pet.hide() : window.electronAPI.pet.show()) }}
          >
            {settings.enabled ? '临时隐藏' : '显示一次'}
          </Button>
        )}
      >
        {pets.length > 0 && (
          <div className="sx-card__body grid gap-3 md:grid-cols-2">
            {pets.map((pet) => {
              const active = pet.id === settings.selectedPetId
              return (
                <div
                  key={pet.id}
                  className={`sx-option items-start ${active ? 'is-active' : ''}`}
                  style={{ padding: 12, cursor: pet.available ? 'pointer' : 'default', opacity: pet.available ? 1 : 0.6 }}
                  onClick={() => { if (pet.available && !active) void setPet(pet.id) }}
                >
                  <PetThumb pet={pet} />
                  <div className="min-w-0 flex-1 pr-5">
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
                      <span className="sx-meta">
                        {pet.source === 'builtin' ? '内置' : 'Codex'} · {pet.available ? '可用' : '不可用'}
                      </span>
                      {active ? (
                        <span className="sx-badge sx-badge--ink">已选择</span>
                      ) : (
                        <Button
                          variant="ghost"
                          size="sm"
                          disabled={!pet.available}
                          aria-pressed={false}
                          onClick={(event) => {
                            event.stopPropagation()
                            void setPet(pet.id)
                          }}
                        >
                          选择
                        </Button>
                      )}
                    </div>
                  </div>
                  <span className="sx-option__tick" aria-hidden>
                    <Check />
                  </span>
                </div>
              )
            })}
          </div>
        )}
      </SettingsCard>
    </div>
  )
}
