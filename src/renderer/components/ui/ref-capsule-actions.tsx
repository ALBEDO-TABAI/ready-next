import { Copy, Eye, FolderSearch, SquareArrowOutUpRight } from 'lucide-react'
import { toReadyUri, writeReadyRefTransfer, type ReadyRef } from '../../../shared/ready-ref'
import { openReadyRef } from '../../modules/workbench/open-ready-ref'
import { requestQuickLook } from '../../modules/workbench/commands/shell-actions'
import { requestWorkbenchModeOpen } from '../../modules/workbench/mode-transition'
import { revealPathInFiles } from '../../modules/document/navigator/useDocumentNavigator'
import { anchorOf, closeFloat, openFloat } from './float/float-store'
import { openMenu } from './float/open-menu'
import { TOOLTIP_DELAY_MS } from './float/Tooltip'
import type { MenuEntry } from './float/Menu'
import { showToast } from './toast-store'
import { REF_CAPSULE_KINDS, resolveRefSource as resolve, type RefCapsuleKind, type RefSource } from './ref-capsule-kinds'
import { RefPreviewCard } from './RefPreviewCard'

// The behaviour of the reference capsule (W6 §2.1), shared by <RefCapsule> and the block editor's links, so a reference
// acts the same everywhere: click opens, ⌥-click or hover-then-Space quick-looks, ⌘-click opens in a new tab, a drag
// carries the unified format, and the context menu offers 打开 / 速览 / 复制引用 / 在文件视角中显示.

const report = (error: unknown) => { showToast(error instanceof Error ? error.message : String(error), { tone: 'bad' }) }

export function openRef(source: RefSource, { newTab = false }: { newTab?: boolean } = {}) {
  hideRefPreview()
  void resolve(source).then(ref => openReadyRef(ref, undefined, { newTab })).catch(report)
}
export function quickLookRef(source: RefSource) {
  hideRefPreview()
  void resolve(source).then(requestQuickLook).catch(report)
}

type ModifiedEvent = { altKey: boolean; metaKey: boolean; ctrlKey: boolean; preventDefault(): void; stopPropagation(): void }
/** Click: open; ⌥: quick look; ⌘ (Ctrl): open in a new tab. */
export function activateRefCapsule(event: ModifiedEvent, source: RefSource) {
  event.preventDefault(); event.stopPropagation()
  if (event.altKey) quickLookRef(source)
  else openRef(source, { newTab: event.metaKey || event.ctrlKey })
}

const escapeHtml = (text: string) => text.replace(/[&<>"]/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[char]!)
/** 复制引用: a Markdown link as text and a link as HTML, so pasting into a page gives a capsule again. */
export async function copyRefCapsule(source: RefSource, title: string) {
  const uri = toReadyUri(await resolve(source))
  const markdown = `[${title.replace(/([\\[\]])/g, '\\$1')}](${uri})`
  try {
    if (typeof ClipboardItem === 'undefined') throw new Error('no rich clipboard')
    await navigator.clipboard.write([new ClipboardItem({
      'text/plain': new Blob([markdown], { type: 'text/plain' }),
      'text/html': new Blob([`<a href="${escapeHtml(uri)}">${escapeHtml(title)}</a>`], { type: 'text/html' }),
    })])
  } catch { await navigator.clipboard.writeText(markdown) }
  showToast('已复制引用')
}

const IN_FILES: RefCapsuleKind[] = ['page', 'database', 'highlight', 'canvas', 'file']
async function revealRefInFiles(source: RefSource) {
  const ref = await resolve(source)
  if (ref.kind !== 'page' && ref.kind !== 'file' && ref.kind !== 'canvas') throw new Error('这个引用没有对应的文件')
  const location = await window.electronAPI.objects.locate(ref.id)
  if (!location) throw new Error('引用文档已不存在')
  requestWorkbenchModeOpen('document')
  await revealPathInFiles(location.path)
}

type MenuEvent = { clientX: number; clientY: number; currentTarget: EventTarget | null; preventDefault(): void; stopPropagation(): void }
/** The capsule's context menu; `extra` adds the host's own actions after a separator (the editor's 修改日期). */
export function openRefCapsuleMenu(event: MenuEvent, source: RefSource, title: string, kind: RefCapsuleKind, extra: MenuEntry[] = []) {
  event.preventDefault(); event.stopPropagation()
  hideRefPreview()
  const target = event.currentTarget instanceof Element ? event.currentTarget : null
  // A context menu key has no pointer position: the menu opens under the capsule instead.
  const anchor = event.clientX || event.clientY || !target
    ? { left: event.clientX, top: event.clientY, right: event.clientX, bottom: event.clientY } : anchorOf(target)
  const items: MenuEntry[] = [
    { id: 'open', label: '打开', icon: <SquareArrowOutUpRight />, onSelect: () => openRef(source) },
    { id: 'quick-look', label: '速览', icon: <Eye />, hint: '空格', onSelect: () => quickLookRef(source) },
    { id: 'copy', label: '复制引用', icon: <Copy />, onSelect: () => { void copyRefCapsule(source, title).catch(report) } },
    ...(IN_FILES.includes(kind) ? [{ id: 'reveal', label: '在文件视角中显示', icon: <FolderSearch />, onSelect: () => { void revealRefInFiles(source).catch(report) } }] : []),
    ...(extra.length ? [{ kind: 'separator' as const }, ...extra] : []),
  ]
  openMenu(anchor, items, { label: `${REF_CAPSULE_KINDS[kind].label} ${title}` })
}

/** Dragging a capsule carries the unified format (W6 §3.1). A reference not yet resolved cannot be carried. */
export function startRefCapsuleDrag(event: { dataTransfer: DataTransfer | null; preventDefault(): void; stopPropagation(): void }, ref: ReadyRef | null, title: string) {
  hideRefPreview()
  if (!ref || !event.dataTransfer) { event.preventDefault(); return }
  event.stopPropagation()
  writeReadyRefTransfer(event.dataTransfer, ref, title)
  event.dataTransfer.effectAllowed = 'copyLink'
}

// ---- Hover: a short preview after the tooltip pause, and Space for quick look ----
const PREVIEW_ID = 'rn-ref-preview'
let previewTimer: number | undefined
let hovered: { element: Element; source: RefSource } | null = null
let keyWindow: Window | null = null

// Space belongs to whatever has the keyboard: typing, a button, a list option. Only otherwise does hovering count.
const busyKeyboard = (element: Element | null) => Boolean(element?.closest('input, textarea, select, button, [contenteditable]:not([contenteditable="false"]), [role="button"], [role="option"], [role="menuitem"]'))
function onKey(event: KeyboardEvent) {
  if (event.key !== ' ' || event.altKey || event.metaKey || event.ctrlKey || event.shiftKey || event.isComposing) { hideRefPreview(); return }
  // A focused capsule answers Space itself.
  const focused = document.activeElement?.closest('[data-ready-ref-capsule]')
  if (focused || busyKeyboard(document.activeElement) || !hovered?.element.isConnected) return
  event.preventDefault(); event.stopPropagation()
  quickLookRef(hovered.source)
}

export function enterRefCapsule(element: Element, source: RefSource, title: string, kind: RefCapsuleKind) {
  hovered = { element, source }
  if (keyWindow !== window) { keyWindow = window; window.addEventListener('keydown', onKey, true) }
  window.clearTimeout(previewTimer)
  previewTimer = window.setTimeout(() => {
    if (!element.isConnected || hovered?.element !== element) return
    openFloat({ id: PREVIEW_ID, anchor: () => anchorOf(element), placement: 'bottom-start', offset: 6, noFocus: true, role: 'tooltip',
      className: 'rn-ref-preview', render: () => <RefPreviewCard source={source} title={title} kind={kind} /> })
  }, TOOLTIP_DELAY_MS)
}
export function leaveRefCapsule(element: Element) {
  if (hovered?.element === element) hovered = null
  hideRefPreview()
}
export function hideRefPreview() {
  window.clearTimeout(previewTimer)
  closeFloat(PREVIEW_ID)
}
