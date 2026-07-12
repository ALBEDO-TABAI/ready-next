import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { Loader2, X } from 'lucide-react'
import {
  compileWidgetSkeletonSpec,
  getWidgetSkeleton,
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

const WIDGET_SIZE_LABELS: Record<WidgetSize, string> = {
  square_card: '方形卡片',
  portrait_card: '竖向卡片',
  story_card: '故事长卡',
  landscape_card: '横向卡片',
  landscape_4_3: '横向 4:3',
  a4_portrait: 'A4 竖版',
  doc_block: '随文宽度',
}

export interface WidgetEditDrawerSave {
  skeletonSpec: DocumentWidgetSkeletonSpecSummary
  widgetCode: string
}

export interface WidgetEditDrawerInput {
  id?: string
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
  const inputRef = useRef(input)
  inputRef.current = input
  const inputKey = input
    ? input.id || `${input.title}\u0000${input.widgetCode}`
    : null

  useEffect(() => {
    if (!open) return
    const initial = deriveInitialSpec(inputRef.current)
    setSpec(initial)
    setError(initial ? null : '当前 widget 缺少骨架信息，无法轻量编辑；请在 Agent 里再次生成或引用修改。')
    setSizeWarning(null)
  }, [inputKey, open])

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

  // W10e（2026-07-12 dogfood）：抽屉此前挂在编辑器子树内，祖先一旦携带
  // transform/filter/contain 就会劫持 position:fixed 的包含块并困住堆叠上下文，
  // 预览态下面板可见但点击被相邻层吞掉。portal 到 body 让遮罩/面板真正以
  // 视口为基准置顶，整类陷阱一次消除。
  return createPortal(
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
          <button type="button" className="ready-widget-edit-drawer-close" onClick={onClose} aria-label="关闭信息卡编辑">
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
                  aria-label="尺寸"
                  value={spec.size ?? skeleton.defaultSize}
                  onChange={(event) => updateSize(event.target.value as WidgetSize)}
                >
                  {skeleton.allowedSizes.map((sizeId) => (
                    <option key={sizeId} value={sizeId}>{WIDGET_SIZE_LABELS[sizeId]}</option>
                  ))}
                </select>
              </div>
              <div className="ready-widget-edit-drawer-section">
                <div className="ready-widget-edit-drawer-label">背景</div>
                <div className="ready-widget-edit-drawer-segmented">
                  <button
                    type="button"
                    aria-pressed={(spec.background_mode ?? skeleton.defaultBackgroundMode) === 'opaque'}
                    className={(spec.background_mode ?? skeleton.defaultBackgroundMode) === 'opaque' ? 'is-active' : ''}
                    onClick={() => updateBackground('opaque')}
                  >不透明</button>
                  <button
                    type="button"
                    aria-pressed={(spec.background_mode ?? skeleton.defaultBackgroundMode) === 'transparent'}
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
    </div>,
    document.body,
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
            aria-label={field.label}
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
            aria-label={field.label}
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
            aria-label={field.label}
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
    case 'key-value-list':
      return <KeyValueListEditor label={field.label} value={Array.isArray(value) ? value : []} onChange={onChange} />
    case 'metrics-list':
      return <MetricsListEditor label={field.label} value={Array.isArray(value) ? value : []} onChange={onChange} />
    case 'text-list':
      return <TextListEditor label={field.label} addLabel={field.addLabel} value={Array.isArray(value) ? value : []} onChange={onChange} />
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
  const choices: Array<{ value: WidgetRampId; label: string; description: string }> = [
    { value: 'indigo', label: '默认', description: '克制灰阶' },
    { value: 'amber', label: '强调', description: '橘红提示' },
    { value: 'emerald', label: '完成', description: '绿色状态' },
  ]
  const activeValue = value === 'emerald'
    ? 'emerald'
    : value === 'amber' || value === 'rose'
      ? 'amber'
      : 'indigo'
  return (
    <div className="ready-widget-edit-drawer-section">
      <div className="ready-widget-edit-drawer-label">{label}</div>
      <div className="ready-widget-edit-drawer-ramp">
        {choices.map((choice) => (
          <button
            key={choice.value}
            type="button"
            className={`ready-widget-edit-drawer-ramp-chip ramp-${choice.value} ${activeValue === choice.value ? 'is-active' : ''}`}
            onClick={() => onChange(choice.value)}
            aria-pressed={activeValue === choice.value}
          >
            <span className="ready-widget-edit-drawer-ramp-dot" />
            <span><strong>{choice.label}</strong><small>{choice.description}</small></span>
          </button>
        ))}
      </div>
    </div>
  )
}

function KeyValueListEditor({ label, value, onChange }: { label: string; value: unknown[]; onChange: (next: unknown[]) => void }) {
  const items = value as Array<Record<string, unknown>>
  const update = (index: number, patch: Record<string, unknown>) => {
    const next = items.slice()
    next[index] = { ...(items[index] || {}), ...patch }
    onChange(next)
  }
  const remove = (index: number) => onChange(items.filter((_, itemIndex) => itemIndex !== index))
  const add = () => onChange([...items, { label: '新条目', value: '补充内容' }])
  return (
    <div className="ready-widget-edit-drawer-section">
      <div className="ready-widget-edit-drawer-label">{label}</div>
      <div className="ready-widget-edit-drawer-list">
        {items.map((item, index) => (
          <div key={index} className="ready-widget-edit-drawer-row ready-widget-edit-drawer-row-pair">
            <input
              type="text"
              aria-label={`${label} ${index + 1} 标签`}
              placeholder="标签"
              value={typeof item.label === 'string' ? item.label : ''}
              onChange={(event) => update(index, { label: event.target.value })}
            />
            <input
              type="text"
              aria-label={`${label} ${index + 1} 内容`}
              placeholder="内容"
              value={typeof item.value === 'string' ? item.value : typeof item.value === 'number' ? String(item.value) : ''}
              onChange={(event) => update(index, { value: event.target.value })}
            />
            <button type="button" aria-label={`删除${label}第 ${index + 1} 项`} onClick={() => remove(index)}><X size={14} /></button>
          </div>
        ))}
        <button type="button" className="ready-widget-edit-drawer-add" onClick={add}>+ 添加条目</button>
      </div>
    </div>
  )
}

function TextListEditor({ label, addLabel, value, onChange }: { label: string; addLabel?: string; value: unknown[]; onChange: (next: unknown[]) => void }) {
  const items = value.map((item) => (typeof item === 'string' ? item : ''))
  const update = (index: number, nextValue: string) => {
    const next = items.slice()
    next[index] = nextValue
    onChange(next)
  }
  const remove = (index: number) => onChange(items.filter((_, itemIndex) => itemIndex !== index))
  const add = () => onChange([...items, '补充内容'])
  return (
    <div className="ready-widget-edit-drawer-section">
      <div className="ready-widget-edit-drawer-label">{label}</div>
      <div className="ready-widget-edit-drawer-list">
        {items.map((item, index) => (
          <div key={index} className="ready-widget-edit-drawer-row ready-widget-edit-drawer-row-single">
            <input
              type="text"
              aria-label={`${label} ${index + 1}`}
              value={item}
              onChange={(event) => update(index, event.target.value)}
            />
            <button type="button" aria-label={`删除${label}第 ${index + 1} 项`} onClick={() => remove(index)}><X size={14} /></button>
          </div>
        ))}
        <button type="button" className="ready-widget-edit-drawer-add" onClick={add}>+ {addLabel || `添加${label}`}</button>
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
              aria-label={`${label} ${index + 1} 标签`}
              placeholder="标签"
              value={typeof item.label === 'string' ? item.label : ''}
              onChange={(event) => update(index, { label: event.target.value })}
            />
            <input
              type="text"
              aria-label={`${label} ${index + 1} 数值`}
              placeholder="数值"
              value={typeof item.value === 'string' ? item.value : typeof item.value === 'number' ? String(item.value) : ''}
              onChange={(event) => update(index, { value: event.target.value })}
            />
            <input
              type="text"
              aria-label={`${label} ${index + 1} 差值`}
              placeholder="差值（可选）"
              value={typeof item.delta === 'string' ? item.delta : ''}
              onChange={(event) => update(index, { delta: event.target.value || undefined })}
            />
            <button type="button" aria-label={`删除${label}第 ${index + 1} 项`} onClick={() => remove(index)}><X size={14} /></button>
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
  const add = () => onChange([...items, { time: '', heading: '新事件', status: 'pending' }])
  return (
    <div className="ready-widget-edit-drawer-section">
      <div className="ready-widget-edit-drawer-label">{label}</div>
      <div className="ready-widget-edit-drawer-list">
        {items.map((item, index) => (
          <div key={index} className="ready-widget-edit-drawer-row ready-widget-edit-drawer-row-wide">
            <input
              type="text"
              aria-label={`${label} ${index + 1} 时间`}
              placeholder="时间"
              value={typeof item.time === 'string' ? item.time : ''}
              onChange={(event) => update(index, { time: event.target.value })}
            />
            <input
              type="text"
              aria-label={`${label} ${index + 1} 标题`}
              placeholder="标题"
              value={typeof item.heading === 'string' ? item.heading : ''}
              onChange={(event) => update(index, { heading: event.target.value })}
            />
            <select
              aria-label={`${label} ${index + 1} 状态`}
              value={typeof item.status === 'string' ? item.status : 'pending'}
              onChange={(event) => update(index, { status: event.target.value })}
            >
              <option value="done">已完成</option>
              <option value="active">进行中</option>
              <option value="pending">待开始</option>
              <option value="blocked">受阻</option>
            </select>
            <button type="button" aria-label={`删除${label}第 ${index + 1} 项`} onClick={() => remove(index)}><X size={14} /></button>
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
          <div key={index} className="ready-widget-edit-drawer-row ready-widget-edit-drawer-row-grid">
            <input
              type="text"
              aria-label={`${label} ${index + 1} 标签`}
              placeholder="标签"
              value={typeof item.label === 'string' ? item.label : ''}
              onChange={(event) => update(index, { label: event.target.value })}
            />
            <input
              type="text"
              aria-label={`${label} ${index + 1} 图片`}
              placeholder="图片 URL（可选）"
              value={typeof item.image === 'string' ? item.image : ''}
              onChange={(event) => update(index, { image: event.target.value || undefined })}
            />
            <select
              aria-label={`${label} ${index + 1} 状态`}
              value={typeof item.status === 'string' ? item.status : 'pending'}
              onChange={(event) => update(index, { status: event.target.value })}
            >
              <option value="done">完成</option>
              <option value="active">进行</option>
              <option value="pending">待办</option>
              <option value="highlight">高亮</option>
            </select>
            <button type="button" aria-label={`删除${label}第 ${index + 1} 项`} onClick={() => remove(index)}><X size={14} /></button>
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
          <div key={index} className="ready-widget-edit-drawer-row ready-widget-edit-drawer-row-single">
            <input
              type="text"
              aria-label={`${label} ${index + 1}`}
              value={tag}
              onChange={(event) => update(index, event.target.value)}
            />
            <button type="button" aria-label={`删除${label}第 ${index + 1} 项`} onClick={() => remove(index)}><X size={14} /></button>
          </div>
        ))}
        <button type="button" className="ready-widget-edit-drawer-add" onClick={add}>+ 添加标签</button>
      </div>
    </div>
  )
}

function HeroImageEditor({ label, value, onChange }: { label: string; value: Record<string, unknown>; onChange: (next: Record<string, unknown>) => void }) {
  const storedType = typeof value.type === 'string' ? value.type : 'image'
  const type = storedType === 'svg_illustration' ? 'svg_illustration' : 'image'
  const src = typeof value.src === 'string' ? value.src : ''
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
        {(['image', 'svg_illustration'] as const).map((mode) => (
          <button
            key={mode}
            type="button"
            className={type === mode ? 'is-active' : ''}
            onClick={() => onChange({ ...value, type: mode })}
            aria-pressed={type === mode}
          >
            {mode === 'image' ? '图片' : 'SVG'}
          </button>
        ))}
      </div>
      {type === 'image' ? (
        <>
          <input
            type="text"
            aria-label={`${label} 图片 URL`}
            placeholder="图片 URL（推荐，避免内联体积过大）"
            value={src}
            onChange={(event) => onChange({ ...value, type: 'image', src: event.target.value })}
          />
          <input
            type="file"
            aria-label={`${label} 本地图片`}
            accept="image/*"
            onChange={(event) => handleFile(event.target.files?.[0] ?? null)}
          />
        </>
      ) : null}
      {type === 'svg_illustration' ? (
        <textarea
          aria-label={`${label} SVG 源码`}
          rows={5}
          placeholder="<svg ...> ... </svg>"
          value={typeof value.svg === 'string' ? value.svg : ''}
          onChange={(event) => onChange({ ...value, svg: event.target.value })}
        />
      ) : null}
      <input
        type="text"
        aria-label={`${label} 宽高比`}
        placeholder="宽高比（如 4/3、16/9）"
        value={aspect}
        onChange={(event) => onChange({ ...value, type, aspect: event.target.value })}
      />
    </div>
  )
}
