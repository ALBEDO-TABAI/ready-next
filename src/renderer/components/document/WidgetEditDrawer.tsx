import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Loader2, X } from 'lucide-react'
import {
  compileWidgetSkeletonSpec,
  getWidgetSkeleton,
  RAMP_IDS,
  type WidgetBackgroundMode,
  type WidgetRampId,
  type WidgetSize,
  type WidgetSkeletonId,
  type WidgetSkeletonSpec,
} from '../../../shared/document-widget-skeletons'
import { mapComponentSpecToSkeletonSpec } from '../../../shared/document-widget-skeleton-mapping'
import type {
  DocumentWidgetComponentSpecSummary,
  DocumentWidgetSkeletonSpecSummary,
} from '../../../shared/document-widget-parse'
import { getFieldMap, type FieldDescriptor } from './widget-edit-drawer-field-map'

const BASE64_SOFT_LIMIT_BYTES = 5 * 1024 * 1024

export interface WidgetEditDrawerSave {
  skeletonSpec: DocumentWidgetSkeletonSpecSummary
  widgetCode: string
}

export interface WidgetEditDrawerInput {
  title: string
  widgetCode: string
  skeletonSpec?: DocumentWidgetSkeletonSpecSummary | null
  componentSpec?: DocumentWidgetComponentSpecSummary | null
}

export interface WidgetEditDrawerProps {
  open: boolean
  input: WidgetEditDrawerInput | null
  onClose: () => void
  onSave: (result: WidgetEditDrawerSave) => void
}

function deriveInitialSpec(input: WidgetEditDrawerInput | null): WidgetSkeletonSpec | null {
  if (!input) return null
  if (input.skeletonSpec?.skeleton) {
    return {
      skeleton: input.skeletonSpec.skeleton,
      size: input.skeletonSpec.size as WidgetSize | undefined,
      background_mode: input.skeletonSpec.background_mode as WidgetBackgroundMode | undefined,
      props: (input.skeletonSpec.props as Record<string, unknown> | undefined) ?? {},
    }
  }
  if (input.componentSpec) {
    const mapped = mapComponentSpecToSkeletonSpec(input.componentSpec)
    if (mapped) return mapped
  }
  return null
}

function getAtPath(target: Record<string, unknown>, path: string): unknown {
  const segments = path.split('.')
  let cursor: unknown = target
  for (const seg of segments) {
    if (!cursor || typeof cursor !== 'object' || Array.isArray(cursor)) return undefined
    cursor = (cursor as Record<string, unknown>)[seg]
  }
  return cursor
}

function setAtPath(target: Record<string, unknown>, path: string, value: unknown): Record<string, unknown> {
  const segments = path.split('.')
  const next: Record<string, unknown> = { ...target }
  let cursor: Record<string, unknown> = next
  for (let index = 0; index < segments.length - 1; index += 1) {
    const seg = segments[index]
    const existing = cursor[seg]
    const cloned = existing && typeof existing === 'object' && !Array.isArray(existing)
      ? { ...(existing as Record<string, unknown>) }
      : {}
    cursor[seg] = cloned
    cursor = cloned
  }
  const last = segments[segments.length - 1]
  if (value === undefined) {
    delete cursor[last]
  } else {
    cursor[last] = value
  }
  return next
}

function estimateBase64Size(spec: WidgetSkeletonSpec): number {
  try {
    const serialized = JSON.stringify(spec.props ?? {})
    return serialized.length
  } catch {
    return 0
  }
}

function readFileAsDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onerror = () => reject(reader.error || new Error('file read failed'))
    reader.onload = () => {
      const result = typeof reader.result === 'string' ? reader.result : ''
      resolve(result)
    }
    reader.readAsDataURL(file)
  })
}

export default function WidgetEditDrawer({ open, input, onClose, onSave }: WidgetEditDrawerProps) {
  const [spec, setSpec] = useState<WidgetSkeletonSpec | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [sizeWarning, setSizeWarning] = useState<string | null>(null)
  const panelRef = useRef<HTMLDivElement | null>(null)

  useEffect(() => {
    if (!open) return
    const initial = deriveInitialSpec(input)
    setSpec(initial)
    setError(initial ? null : '当前 widget 缺少骨架信息，无法轻量编辑；请在 Agent 里再次生成或引用修改。')
    setSizeWarning(null)
  }, [open, input])

  const skeleton = useMemo(() => (spec ? getWidgetSkeleton(spec.skeleton) : null), [spec])
  const fieldMap = useMemo(() => (spec ? getFieldMap(spec.skeleton) : null), [spec])

  const updateProps = useCallback((path: string, value: unknown) => {
    setSpec((prev) => {
      if (!prev) return prev
      const props = (prev.props as Record<string, unknown> | undefined) ?? {}
      const nextProps = setAtPath(props, path, value)
      return { ...prev, props: nextProps }
    })
  }, [])

  const updateSize = useCallback((size: WidgetSize) => {
    setSpec((prev) => (prev ? { ...prev, size } : prev))
  }, [])

  const updateBackground = useCallback((mode: WidgetBackgroundMode) => {
    setSpec((prev) => (prev ? { ...prev, background_mode: mode } : prev))
  }, [])

  const handleSave = useCallback(() => {
    if (!spec || !skeleton) return
    setBusy(true)
    setError(null)
    setSizeWarning(null)
    try {
      const compiled = compileWidgetSkeletonSpec(spec)
      const approxBytes = estimateBase64Size(spec)
      if (approxBytes > BASE64_SOFT_LIMIT_BYTES) {
        setSizeWarning(`内联资源体积约 ${(approxBytes / (1024 * 1024)).toFixed(1)}MB，建议改用 URL 或上传到资源层。`)
      }
      onSave({
        skeletonSpec: {
          skeleton: compiled.skeleton,
          size: compiled.size,
          background_mode: compiled.backgroundMode,
          props: (spec.props as Record<string, unknown> | undefined) ?? {},
        },
        widgetCode: compiled.widgetCode,
      })
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(false)
    }
  }, [onSave, skeleton, spec])

  useEffect(() => {
    if (!open) return
    const handler = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [onClose, open])

  if (!open) return null

  const props = (spec?.props as Record<string, unknown> | undefined) ?? {}

  return (
    <div
      className="ready-widget-edit-drawer-backdrop"
      onClick={(event) => {
        if (event.target === event.currentTarget) onClose()
      }}
    >
      <div ref={panelRef} className="ready-widget-edit-drawer-panel" role="dialog" aria-label="编辑 widget">
        <div className="ready-widget-edit-drawer-header">
          <div>
            <div className="ready-widget-edit-drawer-title">{skeleton?.displayName ?? '编辑 widget'}</div>
            <div className="ready-widget-edit-drawer-subtitle">{input?.title ?? ''}</div>
          </div>
          <button type="button" className="ready-widget-edit-drawer-close" onClick={onClose}>
            <X size={16} />
          </button>
        </div>

        <div className="ready-widget-edit-drawer-body">
          {error ? <div className="ready-widget-edit-drawer-error">{error}</div> : null}

          {spec && skeleton && fieldMap ? (
            <>
              <div className="ready-widget-edit-drawer-section">
                <div className="ready-widget-edit-drawer-label">尺寸</div>
                <select
                  value={spec.size ?? skeleton.defaultSize}
                  onChange={(event) => updateSize(event.target.value as WidgetSize)}
                >
                  {skeleton.allowedSizes.map((sizeId) => (
                    <option key={sizeId} value={sizeId}>{sizeId}</option>
                  ))}
                </select>
              </div>
              <div className="ready-widget-edit-drawer-section">
                <div className="ready-widget-edit-drawer-label">背景</div>
                <div className="ready-widget-edit-drawer-segmented">
                  <button
                    type="button"
                    className={(spec.background_mode ?? skeleton.defaultBackgroundMode) === 'opaque' ? 'is-active' : ''}
                    onClick={() => updateBackground('opaque')}
                  >不透明</button>
                  <button
                    type="button"
                    className={(spec.background_mode ?? skeleton.defaultBackgroundMode) === 'transparent' ? 'is-active' : ''}
                    onClick={() => updateBackground('transparent')}
                  >透明</button>
                </div>
              </div>

              {fieldMap.fields.map((field) => (
                <FieldInput
                  key={field.path}
                  field={field}
                  value={getAtPath(props, field.path)}
                  onChange={(next) => updateProps(field.path, next)}
                />
              ))}

              {(skeleton.id === 'freeform_interactive') ? (
                <div className="ready-widget-edit-drawer-callout">
                  交互式 widget 当前导出为静帧快照；Live 视频 / 动图导出（__widgetRender 宿主接口）尚在规划中，保存的 skeletonSpec 会被保留，未来可直接升级。
                </div>
              ) : null}

              {sizeWarning ? (
                <div className="ready-widget-edit-drawer-warning">{sizeWarning}</div>
              ) : null}
            </>
          ) : null}
        </div>

        <div className="ready-widget-edit-drawer-footer">
          <button type="button" className="ready-widget-edit-drawer-cancel" onClick={onClose}>取消</button>
          <button
            type="button"
            className="ready-widget-edit-drawer-save"
            disabled={!spec || !skeleton || busy}
            onClick={handleSave}
          >
            {busy ? <Loader2 size={14} className="ready-widget-edit-drawer-spinner" /> : null}
            <span>保存</span>
          </button>
        </div>
      </div>
    </div>
  )
}

interface FieldInputProps {
  field: FieldDescriptor
  value: unknown
  onChange: (value: unknown) => void
}

function FieldInput({ field, value, onChange }: FieldInputProps) {
  switch (field.kind) {
    case 'text':
      return (
        <div className="ready-widget-edit-drawer-section">
          <div className="ready-widget-edit-drawer-label">{field.label}</div>
          <input
            type="text"
            value={typeof value === 'string' ? value : ''}
            placeholder={field.placeholder}
            onChange={(event) => onChange(event.target.value)}
          />
        </div>
      )
    case 'textarea':
      return (
        <div className="ready-widget-edit-drawer-section">
          <div className="ready-widget-edit-drawer-label">{field.label}</div>
          <textarea
            rows={field.rows ?? 4}
            value={typeof value === 'string' ? value : ''}
            placeholder={field.placeholder}
            onChange={(event) => onChange(event.target.value)}
          />
        </div>
      )
    case 'enum':
      return (
        <div className="ready-widget-edit-drawer-section">
          <div className="ready-widget-edit-drawer-label">{field.label}</div>
          <select
            value={typeof value === 'string' ? value : typeof value === 'number' ? String(value) : field.options[0]?.value ?? ''}
            onChange={(event) => {
              const raw = event.target.value
              const asNumber = Number(raw)
              onChange(Number.isFinite(asNumber) && String(asNumber) === raw ? asNumber : raw)
            }}
          >
            {field.options.map((option) => (
              <option key={option.value} value={option.value}>{option.label}</option>
            ))}
          </select>
        </div>
      )
    case 'ramp':
      return <RampPicker label={field.label} value={typeof value === 'string' ? (value as WidgetRampId) : 'indigo'} onChange={onChange} />
    case 'metrics-list':
      return <MetricsListEditor label={field.label} value={Array.isArray(value) ? value : []} onChange={onChange} />
    case 'events-list':
      return <EventsListEditor label={field.label} value={Array.isArray(value) ? value : []} onChange={onChange} />
    case 'grid-items-list':
      return <GridItemsListEditor label={field.label} value={Array.isArray(value) ? value : []} onChange={onChange} />
    case 'tags-list':
      return <TagsListEditor label={field.label} value={Array.isArray(value) ? value : []} onChange={onChange} />
    case 'hero-image':
      return <HeroImageEditor label={field.label} value={value && typeof value === 'object' ? value as Record<string, unknown> : {}} onChange={onChange} />
    default:
      return null
  }
}

function RampPicker({ label, value, onChange }: { label: string; value: WidgetRampId; onChange: (next: WidgetRampId) => void }) {
  return (
    <div className="ready-widget-edit-drawer-section">
      <div className="ready-widget-edit-drawer-label">{label}</div>
      <div className="ready-widget-edit-drawer-ramp">
        {RAMP_IDS.map((rampId) => (
          <button
            key={rampId}
            type="button"
            className={`ready-widget-edit-drawer-ramp-chip ramp-${rampId} ${value === rampId ? 'is-active' : ''}`}
            onClick={() => onChange(rampId)}
            title={rampId}
          >
            <span>{rampId}</span>
          </button>
        ))}
      </div>
    </div>
  )
}

function MetricsListEditor({ label, value, onChange }: { label: string; value: unknown[]; onChange: (next: unknown[]) => void }) {
  const items = value as Array<Record<string, unknown>>
  const update = (index: number, patch: Record<string, unknown>) => {
    const next = items.slice()
    next[index] = { ...(items[index] || {}), ...patch }
    onChange(next)
  }
  const remove = (index: number) => onChange(items.filter((_, i) => i !== index))
  const add = () => onChange([...items, { label: '新指标', value: '0' }])
  return (
    <div className="ready-widget-edit-drawer-section">
      <div className="ready-widget-edit-drawer-label">{label}</div>
      <div className="ready-widget-edit-drawer-list">
        {items.map((item, index) => (
          <div key={index} className="ready-widget-edit-drawer-row">
            <input
              type="text"
              placeholder="标签"
              value={typeof item.label === 'string' ? item.label : ''}
              onChange={(event) => update(index, { label: event.target.value })}
            />
            <input
              type="text"
              placeholder="数值"
              value={typeof item.value === 'string' ? item.value : typeof item.value === 'number' ? String(item.value) : ''}
              onChange={(event) => update(index, { value: event.target.value })}
            />
            <input
              type="text"
              placeholder="差值（可选）"
              value={typeof item.delta === 'string' ? item.delta : ''}
              onChange={(event) => update(index, { delta: event.target.value || undefined })}
            />
            <button type="button" onClick={() => remove(index)}>✕</button>
          </div>
        ))}
        <button type="button" className="ready-widget-edit-drawer-add" onClick={add}>+ 添加指标</button>
      </div>
    </div>
  )
}

function EventsListEditor({ label, value, onChange }: { label: string; value: unknown[]; onChange: (next: unknown[]) => void }) {
  const items = value as Array<Record<string, unknown>>
  const update = (index: number, patch: Record<string, unknown>) => {
    const next = items.slice()
    next[index] = { ...(items[index] || {}), ...patch }
    onChange(next)
  }
  const remove = (index: number) => onChange(items.filter((_, i) => i !== index))
  const add = () => onChange([...items, { time: '', title: '新事件', status: 'pending' }])
  return (
    <div className="ready-widget-edit-drawer-section">
      <div className="ready-widget-edit-drawer-label">{label}</div>
      <div className="ready-widget-edit-drawer-list">
        {items.map((item, index) => (
          <div key={index} className="ready-widget-edit-drawer-row ready-widget-edit-drawer-row-wide">
            <input
              type="text"
              placeholder="时间"
              value={typeof item.time === 'string' ? item.time : ''}
              onChange={(event) => update(index, { time: event.target.value })}
            />
            <input
              type="text"
              placeholder="标题"
              value={typeof item.title === 'string' ? item.title : ''}
              onChange={(event) => update(index, { title: event.target.value })}
            />
            <select
              value={typeof item.status === 'string' ? item.status : 'pending'}
              onChange={(event) => update(index, { status: event.target.value })}
            >
              <option value="done">已完成</option>
              <option value="active">进行中</option>
              <option value="pending">待开始</option>
              <option value="blocked">受阻</option>
            </select>
            <button type="button" onClick={() => remove(index)}>✕</button>
          </div>
        ))}
        <button type="button" className="ready-widget-edit-drawer-add" onClick={add}>+ 添加事件</button>
      </div>
    </div>
  )
}

function GridItemsListEditor({ label, value, onChange }: { label: string; value: unknown[]; onChange: (next: unknown[]) => void }) {
  const items = value as Array<Record<string, unknown>>
  const update = (index: number, patch: Record<string, unknown>) => {
    const next = items.slice()
    next[index] = { ...(items[index] || {}), ...patch }
    onChange(next)
  }
  const remove = (index: number) => onChange(items.filter((_, i) => i !== index))
  const add = () => onChange([...items, { label: '新项', status: 'pending' }])
  return (
    <div className="ready-widget-edit-drawer-section">
      <div className="ready-widget-edit-drawer-label">{label}</div>
      <div className="ready-widget-edit-drawer-list">
        {items.map((item, index) => (
          <div key={index} className="ready-widget-edit-drawer-row ready-widget-edit-drawer-row-wide">
            <input
              type="text"
              placeholder="标签"
              value={typeof item.label === 'string' ? item.label : ''}
              onChange={(event) => update(index, { label: event.target.value })}
            />
            <input
              type="text"
              placeholder="Emoji"
              value={typeof item.emoji === 'string' ? item.emoji : ''}
              onChange={(event) => update(index, { emoji: event.target.value || undefined })}
            />
            <input
              type="text"
              placeholder="图片 URL（可选）"
              value={typeof item.image === 'string' ? item.image : ''}
              onChange={(event) => update(index, { image: event.target.value || undefined })}
            />
            <select
              value={typeof item.status === 'string' ? item.status : 'pending'}
              onChange={(event) => update(index, { status: event.target.value })}
            >
              <option value="done">完成</option>
              <option value="active">进行</option>
              <option value="pending">待办</option>
              <option value="highlight">高亮</option>
            </select>
            <button type="button" onClick={() => remove(index)}>✕</button>
          </div>
        ))}
        <button type="button" className="ready-widget-edit-drawer-add" onClick={add}>+ 添加网格项</button>
      </div>
    </div>
  )
}

function TagsListEditor({ label, value, onChange }: { label: string; value: unknown[]; onChange: (next: unknown[]) => void }) {
  const items = (value as unknown[]).map((v) => (typeof v === 'string' ? v : ''))
  const update = (index: number, next: string) => {
    const list = items.slice()
    list[index] = next
    onChange(list)
  }
  const remove = (index: number) => onChange(items.filter((_, i) => i !== index))
  const add = () => onChange([...items, '新标签'])
  return (
    <div className="ready-widget-edit-drawer-section">
      <div className="ready-widget-edit-drawer-label">{label}</div>
      <div className="ready-widget-edit-drawer-list">
        {items.map((tag, index) => (
          <div key={index} className="ready-widget-edit-drawer-row">
            <input
              type="text"
              value={tag}
              onChange={(event) => update(index, event.target.value)}
            />
            <button type="button" onClick={() => remove(index)}>✕</button>
          </div>
        ))}
        <button type="button" className="ready-widget-edit-drawer-add" onClick={add}>+ 添加标签</button>
      </div>
    </div>
  )
}

function HeroImageEditor({ label, value, onChange }: { label: string; value: Record<string, unknown>; onChange: (next: Record<string, unknown>) => void }) {
  const type = typeof value.type === 'string' ? value.type : 'image'
  const src = typeof value.src === 'string' ? value.src : ''
  const emoji = typeof value.emoji === 'string' ? value.emoji : ''
  const aspect = typeof value.aspect === 'string' ? value.aspect : '4/3'

  const handleFile = useCallback(async (file: File | null) => {
    if (!file) return
    try {
      const dataUrl = await readFileAsDataUrl(file)
      onChange({ ...value, type: 'image', src: dataUrl })
    } catch {
      // ignore
    }
  }, [onChange, value])

  return (
    <div className="ready-widget-edit-drawer-section">
      <div className="ready-widget-edit-drawer-label">{label}</div>
      <div className="ready-widget-edit-drawer-segmented">
        {(['image', 'emoji_block', 'svg_illustration'] as const).map((mode) => (
          <button
            key={mode}
            type="button"
            className={type === mode ? 'is-active' : ''}
            onClick={() => onChange({ ...value, type: mode })}
          >
            {mode === 'image' ? '图片' : mode === 'emoji_block' ? 'Emoji' : 'SVG'}
          </button>
        ))}
      </div>
      {type === 'image' ? (
        <>
          <input
            type="text"
            placeholder="图片 URL（推荐，避免内联体积过大）"
            value={src}
            onChange={(event) => onChange({ ...value, src: event.target.value })}
          />
          <input
            type="file"
            accept="image/*"
            onChange={(event) => handleFile(event.target.files?.[0] ?? null)}
          />
        </>
      ) : null}
      {type === 'emoji_block' ? (
        <input
          type="text"
          placeholder="Emoji（如 📘）"
          value={emoji}
          onChange={(event) => onChange({ ...value, emoji: event.target.value })}
        />
      ) : null}
      {type === 'svg_illustration' ? (
        <textarea
          rows={5}
          placeholder="<svg ...> ... </svg>"
          value={typeof value.svg === 'string' ? value.svg : ''}
          onChange={(event) => onChange({ ...value, svg: event.target.value })}
        />
      ) : null}
      <input
        type="text"
        placeholder="宽高比（如 4/3、16/9）"
        value={aspect}
        onChange={(event) => onChange({ ...value, aspect: event.target.value })}
      />
    </div>
  )
}
