import type { CanvasCommand, CanvasNode } from '../../../shared/ready-canvas'
import type { StagedAttachmentReceipt } from '../../../main/modules/board-engine/media-ipc'

// Files onto the board (M4 2026-11-14 contract): what the person dropped from Finder, pasted, picked in 文件… or
// recorded. Pictures, sound and video become media cards whose bytes Main validates and copies into the board's
// attachments; .md and .txt become text cards. Only the File objects handed over are read.

export type IntakeKind = 'image' | 'audio' | 'video' | 'text'
const MB = 1024 * 1024
/** The same limits Main enforces, checked here first so a large file fails before its bytes cross the bridge. */
export const INTAKE_LIMITS: Record<IntakeKind, number> = { image: 20 * MB, audio: 50 * MB, video: 50 * MB, text: 1 * MB }
const KIND_LABEL: Record<IntakeKind, string> = { image: '图片', audio: '音频', video: '视频', text: '文本' }
const GAP = 24, PER_ROW = 4
export const AUDIO_CARD = { width: 300, height: 132 }

export function intakeKind(file: Pick<File, 'name' | 'type'>): IntakeKind | null {
  const type = file.type.toLowerCase(), name = file.name.toLowerCase()
  if (/\.(md|markdown|txt)$/.test(name) || type === 'text/plain' || type === 'text/markdown') return 'text'
  if (type.startsWith('image/') ? /^image\/(png|jpeg|gif|webp)$/.test(type) : /\.(png|jpe?g|gif|webp)$/.test(name)) return 'image'
  if (type.startsWith('audio/') || /\.(mp3|m4a|wav|ogg|oga|flac|weba)$/.test(name)) return 'audio'
  if (type.startsWith('video/') || /\.(mp4|m4v|mov|webm)$/.test(name)) return 'video'
  return null
}

export interface MediaMeasure { width?: number; height?: number; durationMs?: number }
export interface IntakeHost {
  /** The board's library-relative path (`目录/X.canvas`). */
  boardPath: string
  stage(input: { name: string; mime: string; bytes: Uint8Array }): Promise<StagedAttachmentReceipt>
  write(commands: CanvasCommand[]): Promise<void>
  /** Picture size and sound length, read from the bytes in the renderer; a failure leaves the defaults. */
  measure?(kind: Exclude<IntakeKind, 'text'>, bytes: Uint8Array, mime: string): Promise<MediaMeasure>
  now?(): Date
}
export interface IntakeResult { nodeIds: string[]; skipped: string[] }

const title = (name: string) => name.replace(/\.[^.]*$/, '')

/** Places the files as cards from `at` (their top-left corner), rows of four; one board write for all of them. */
export async function intakeFiles(files: readonly File[], at: { x: number; y: number }, host: IntakeHost,
  options: { durationMs?: number; capturedAt?: Date; title?: string } = {}): Promise<IntakeResult> {
  const commands: CanvasCommand[] = [], nodeIds: string[] = [], skipped: string[] = []
  const base = host.boardPath.replace(/\.canvas$/i, ''), stamp = (options.capturedAt ?? host.now?.() ?? new Date()).toISOString()
  let x = Math.round(at.x), y = Math.round(at.y), column = 0, rowHeight = 0
  const place = (width: number, height: number) => {
    const frame = { id: crypto.randomUUID(), x, y, width, height }
    nodeIds.push(frame.id); rowHeight = Math.max(rowHeight, height); x += width + GAP
    if (++column >= PER_ROW) { column = 0; x = Math.round(at.x); y += rowHeight + GAP; rowHeight = 0 }
    return frame
  }
  for (const file of files) {
    const kind = intakeKind(file)
    if (!kind) { skipped.push(file.name); continue }
    if (file.size > INTAKE_LIMITS[kind]) throw new Error(`「${file.name}」超过大小上限（${KIND_LABEL[kind]} ${INTAKE_LIMITS[kind] / MB} MB）`)
    if (!file.size) throw new Error(`「${file.name}」是空文件`)
    if (kind === 'text') {
      const text = (await file.text()).replace(/\r\n?/g, '\n').trim()
      if (!text) { skipped.push(file.name); continue }
      const lines = text.split('\n').length
      commands.push({ type: 'addNode', node: { ...place(280, Math.max(120, Math.min(360, 56 + lines * 22))), type: 'text', text, ready: { kind: 'text' } } })
      continue
    }
    const bytes = new Uint8Array(await file.arrayBuffer())
    const staged = await host.stage({ name: file.name, mime: file.type, bytes })
    const measured: MediaMeasure = await host.measure?.(staged.kind, bytes, staged.mime).catch(() => ({})) ?? {}
    const durationMs = options.durationMs ?? measured.durationMs
    const ratio = measured.width && measured.height ? measured.height / measured.width : staged.kind === 'video' ? 9 / 16 : 3 / 4
    const width = staged.kind === 'audio' ? AUDIO_CARD.width : staged.kind === 'video' ? 360 : Math.round(Math.min(420, Math.max(180, (measured.width ?? 640) / 2)))
    const height = staged.kind === 'audio' ? AUDIO_CARD.height : Math.max(60, Math.round(width * ratio))
    const node: CanvasNode = { ...place(width, height), type: 'file', file: `${base}.assets/${staged.sha256}`, ready: { kind: staged.kind,
      media: { mime: staged.mime, sha256: staged.sha256, originalName: file.name, ...(durationMs !== undefined && Number.isFinite(durationMs) ? { durationMs: Math.max(0, Math.round(durationMs)) } : {}) },
      // The time the card's content was taken: the end of a recording, or the file's own date.
      preview: { title: options.title ?? title(file.name), fetchedAt: options.capturedAt ? stamp : new Date(file.lastModified || Date.parse(stamp)).toISOString() } } }
    commands.push({ type: 'importAttachment', sourceToken: staged.token, node })
  }
  if (!commands.length) throw new Error('画板接收图片、音频、视频和 .md / .txt 文件；这些文件没有放入')
  await host.write(commands)
  return { nodeIds, skipped }
}

/** The files a drop or a paste carries. Read synchronously: the transfer is only readable during its event. */
export function transferFiles(data: Pick<DataTransfer, 'files'> | null | undefined): File[] {
  return data?.files?.length ? Array.from(data.files) : []
}

/** A picture on the system clipboard (a screenshot, a copied image), for the 粘贴 menu item where no paste event exists. */
export async function clipboardImageFiles(clipboard: Pick<Clipboard, 'read'> | undefined = globalThis.navigator?.clipboard, now = new Date()): Promise<File[]> {
  if (!clipboard?.read) return []
  const files: File[] = []
  let items: ClipboardItems
  try { items = await clipboard.read() } catch { /* silent-catch: an unreadable clipboard (no permission, nothing on it) simply carries no picture. */ return [] }
  for (const item of items) {
    const type = item.types.find(value => /^image\/(png|jpeg|gif|webp)$/.test(value))
    if (type) files.push(new File([await item.getType(type)], pastedImageName(type, now), { type }))
  }
  return files
}
const pad = (value: number) => String(value).padStart(2, '0')
export const stampName = (now: Date) => `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())} ${pad(now.getHours())}.${pad(now.getMinutes())}.${pad(now.getSeconds())}`
export const pastedImageName = (type: string, now: Date) => `粘贴的图片 ${stampName(now)}.${type === 'image/jpeg' ? 'jpg' : type.split('/')[1]}`

/** Picture size from the bytes; sound length by decoding (short files only: decoding holds the whole sound in memory). */
export async function measureMedia(kind: Exclude<IntakeKind, 'text'>, bytes: Uint8Array, mime: string): Promise<MediaMeasure> {
  if (kind === 'image') {
    const bitmap = await createImageBitmap(new Blob([bytes as BlobPart], { type: mime }))
    try { return { width: bitmap.width, height: bitmap.height } } finally { bitmap.close() }
  }
  if (kind === 'audio' && bytes.byteLength <= 12 * MB && typeof AudioContext !== 'undefined') {
    const context = new AudioContext()
    try { return { durationMs: (await context.decodeAudioData(bytes.slice().buffer)).duration * 1000 } } finally { void context.close() }
  }
  return {}
}
