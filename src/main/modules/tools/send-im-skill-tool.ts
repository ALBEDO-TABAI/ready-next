import { existsSync, readdirSync, statSync } from 'node:fs'
import { basename, extname, isAbsolute, join } from 'node:path'

import { createToolExecutionOutput, type ToolExecutionOutput } from '../agent-control/tools-runtime/tool-result-types'
import { SEND_IM_ERROR_KINDS } from '../agent-control/contracts/error-kinds'
import { isRetryOnlyTurn } from '../agent-control/skills/skill-detection-inputs'
import { normalizeChannelDeliveryResult } from '../agent-control/runtime-core/channel-delivery-result'
import { hasNegatedLocalSendImFileIntent } from '../../../shared/remote-im-file-intent'

interface SendImChannelConfig {
  id: string
  type: string
  name: string
  enabled: boolean
  config?: Record<string, unknown>
}

interface SendImAttachmentResource {
  name: string
  path: string
  kind?: string | null
  mimeType?: string | null
  createdAt?: string | null
}

interface ResolvedSendImFile {
  path: string
  name: string
  size: number
  ext: string
  mimeType: string
  type: string
}

interface SendImProjectionArtifact {
  id: string
  kind: string
  label: string
  path: string
  mimeType: string
  size: number
  createdAt: string
  source: string
}

type TerminalFailureReason = 'delivery_failed' | 'tool_unavailable' | 'no_artifact' | 'proof_gap'

interface SendImFailureDiagnosis {
  text: string
  errorKind: string
  errorCode: string
  retryable: boolean
  rawError: string
}

export interface SendImSkillRuntimeContext {
  runtime?: {
    listChannels?: () => SendImChannelConfig[]
    recordChannelDeliveryResult?: (
      channelId: string,
      result: { success: boolean; error?: string },
    ) => void
  } | null
  sidecarManager?: {
    isRunning?: () => boolean
    start?: () => Promise<unknown>
    sendChannel?: (payload: {
      id: string
      thread?: string
      text: string
      attachments?: Array<Record<string, unknown>>
    }) => Promise<Record<string, unknown>>
  } | null
  scopeId?: string
  sessionId?: string
  taskId?: string
  taskProjectionId?: string
  currentUserText?: string
  requestEnvelope?: unknown
  recentArtifacts?: unknown
  activeFrame?: {
    discoveredHandles?: Record<string, unknown>[]
  } | null
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null
}

function stringField(record: Record<string, unknown>, ...keys: string[]): string {
  for (const key of keys) {
    const value = record[key]
    if (typeof value === 'string' && value.trim()) return value.trim()
  }
  return ''
}

function stringArrayField(record: Record<string, unknown>, ...keys: string[]): string[] {
  const out: string[] = []
  for (const key of keys) {
    const value = record[key]
    if (Array.isArray(value)) {
      for (const item of value) {
        if (typeof item === 'string' && item.trim()) out.push(item.trim())
      }
    } else if (typeof value === 'string' && value.trim()) {
      out.push(value.trim())
    }
  }
  return Array.from(new Set(out))
}

function normalizeReferenceName(value: string): string {
  return String(value || '')
    .trim()
    .replace(/^@\[/, '')
    .replace(/\]$/, '')
    .toLowerCase()
}

function resourceFromRecord(item: Record<string, unknown>): SendImAttachmentResource | null {
  const path = stringField(item, 'path', 'documentPath', 'filePath')
  if (!path) return null
  return {
    name: stringField(item, 'name', 'label', 'filename', 'fileName') || basename(path),
    path,
    kind: stringField(item, 'kind', 'type') || null,
    mimeType: stringField(item, 'mimeType', 'content_type', 'contentType') || null,
    createdAt: stringField(item, 'createdAt', 'created_at') || null,
  }
}

function listArtifacts(value: unknown): SendImAttachmentResource[] {
  if (!Array.isArray(value)) return []
  return value
    .map((item) => asRecord(item))
    .filter((item): item is Record<string, unknown> => Boolean(item))
    .map((item) => resourceFromRecord(item))
    .filter((item): item is SendImAttachmentResource => Boolean(item))
}

function listEnvelopeResources(envelope: unknown): SendImAttachmentResource[] {
  const record = asRecord(envelope)
  if (!record) return []
  return [
    ...listArtifacts(record.resources),
    ...listArtifacts(record.recentArtifacts),
    ...listArtifacts(record.artifactRefs),
  ]
}

function listContextRecentArtifacts(context: SendImSkillRuntimeContext): SendImAttachmentResource[] {
  const out: SendImAttachmentResource[] = []
  out.push(...listArtifacts(context.recentArtifacts))
  out.push(...listEnvelopeResources(context.requestEnvelope).filter((item) => isMediaResource(item)))
  const discovered = context.activeFrame?.discoveredHandles || []
  out.push(...listArtifacts(discovered).filter((item) => isMediaResource(item)))

  const runtime = context.runtime as unknown as {
    getTaskProjection?: (taskId: string) => { recentArtifacts?: unknown[] } | null
    listTaskProjections?: (scopeId: string) => Array<{ recentArtifacts?: unknown[]; updatedAt?: string | null }>
  } | null | undefined
  const taskIds = [context.taskProjectionId, context.taskId]
    .map((value) => String(value || '').trim())
    .filter(Boolean)
  for (const taskId of taskIds) {
    const projection = runtime?.getTaskProjection?.(taskId)
    out.push(...listArtifacts(projection?.recentArtifacts).filter((item) => isMediaResource(item)))
  }
  if (out.length === 0 && context.scopeId && runtime?.listTaskProjections) {
    const projections = runtime.listTaskProjections(context.scopeId)
      .slice()
      .sort((a, b) => Date.parse(String(b.updatedAt || '')) - Date.parse(String(a.updatedAt || '')))
      .slice(0, 3)
    for (const projection of projections) {
      out.push(...listArtifacts(projection.recentArtifacts).filter((item) => isMediaResource(item)))
    }
  }

  const byPath = new Map<string, SendImAttachmentResource>()
  for (const item of out) {
    if (!item.path || byPath.has(item.path)) continue
    byPath.set(item.path, item)
  }
  return Array.from(byPath.values())
    .map((item, index) => ({ item, index, time: Date.parse(String(item.createdAt || '')) }))
    .sort((a, b) => {
      const aHasTime = Number.isFinite(a.time)
      const bHasTime = Number.isFinite(b.time)
      if (aHasTime && bHasTime && a.time !== b.time) return a.time - b.time
      if (aHasTime !== bHasTime) return aHasTime ? 1 : -1
      return a.index - b.index
    })
    .map((entry) => entry.item)
}

function extractMentionNames(text: string): string[] {
  return Array.from(String(text || '').matchAll(/@\[([^\]]+)\]/g))
    .map((match) => String(match[1] || '').trim())
    .filter(Boolean)
}

function selectResources(
  resources: SendImAttachmentResource[],
  wantedNames: string[],
  allowSingleFallback = true,
): SendImAttachmentResource[] {
  if (resources.length === 0) return []
  const wanted = wantedNames
    .map((name) => normalizeReferenceName(name))
    .filter(Boolean)
  const selected: SendImAttachmentResource[] = []
  for (const name of wanted) {
    const exact = resources.find((resource) => {
      const resourceName = normalizeReferenceName(resource.name)
      const resourceBasename = normalizeReferenceName(basename(resource.path))
      return resourceName === name || resourceBasename === name
    })
    if (exact && !selected.some((item) => item.path === exact.path)) selected.push(exact)
  }
  if (selected.length > 0) return selected
  return allowSingleFallback && wanted.length === 0 && resources.length === 1 ? [resources[0]] : []
}

function mimeTypeFromExt(ext: string): string {
  switch (ext.toLowerCase()) {
    case '.md':
    case '.markdown':
      return 'text/markdown'
    case '.txt':
      return 'text/plain'
    case '.json':
      return 'application/json'
    case '.csv':
      return 'text/csv'
    case '.pdf':
      return 'application/pdf'
    case '.doc':
      return 'application/msword'
    case '.docx':
      return 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
    case '.png':
      return 'image/png'
    case '.jpg':
    case '.jpeg':
      return 'image/jpeg'
    case '.webp':
      return 'image/webp'
    case '.gif':
      return 'image/gif'
    case '.mp4':
      return 'video/mp4'
    case '.mov':
      return 'video/quicktime'
    case '.xlsx':
      return 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
    case '.xls':
      return 'application/vnd.ms-excel'
    default:
      return 'application/octet-stream'
  }
}

function attachmentTypeFromPath(path: string, mimeType: string): string {
  const ext = extname(path).toLowerCase()
  if (mimeType.startsWith('image/')) return 'image'
  if (mimeType.startsWith('video/')) return 'video'
  if (['.xls', '.xlsx', '.numbers'].includes(ext)) return 'spreadsheet'
  if (['.txt', '.md', '.markdown', '.json', '.csv', '.doc', '.docx', '.pdf'].includes(ext)) return 'text'
  return 'other'
}

function isMediaResource(resource: SendImAttachmentResource): boolean {
  const kind = String(resource.kind || '').toLowerCase()
  if (kind === 'image' || kind === 'media' || kind === 'download') return true
  const mimeType = String(resource.mimeType || '').toLowerCase()
  if (mimeType.startsWith('image/') || mimeType.startsWith('video/')) return true
  return ['.png', '.jpg', '.jpeg', '.webp', '.gif', '.mp4', '.mov'].includes(extname(resource.path).toLowerCase())
}

function extractLocalFileResourcesFromText(text: string): SendImAttachmentResource[] {
  const source = String(text || '')
  if (!source.trim()) return []
  const pattern = /(\/(?:Users|Volumes|var|tmp|private|Applications|Library|opt|home)[^\n\r`"']+?\.(?:md|markdown|txt|json|csv|pdf|docx?|xlsx?|png|jpe?g|webp|gif|mp4|mov|m4v|webm))/gi
  const out: SendImAttachmentResource[] = []
  const seen = new Set<string>()
  let match: RegExpExecArray | null
  while ((match = pattern.exec(source)) !== null) {
    const path = String(match[1] || '')
      .replace(/[，。；;,.!！?？)\]}>]+$/g, '')
      .trim()
    if (!path || seen.has(path)) continue
    seen.add(path)
    out.push({
      name: basename(path),
      path,
      kind: attachmentTypeFromPath(path, mimeTypeFromExt(extname(path).toLowerCase())),
      mimeType: mimeTypeFromExt(extname(path).toLowerCase()),
    })
  }
  return out
}

function filesToRecentArtifacts(files: ResolvedSendImFile[]): SendImProjectionArtifact[] {
  const createdAt = new Date().toISOString()
  return files.map((file, index) => ({
    id: `send-im-file-${index + 1}-${Buffer.from(file.path).toString('base64url').slice(0, 20)}`,
    kind: file.type,
    label: file.name,
    path: file.path,
    mimeType: file.mimeType,
    size: file.size,
    createdAt,
    source: 'send-im',
  }))
}

function terminalFailureReasonForSendImError(errorKind: string): TerminalFailureReason {
  if (
    errorKind === SEND_IM_ERROR_KINDS.sendFailed.code
    || errorKind === SEND_IM_ERROR_KINDS.blockedExternal.code
  ) return 'delivery_failed'
  if (
    errorKind === SEND_IM_ERROR_KINDS.sidecarUnavailable.code
    || errorKind === SEND_IM_ERROR_KINDS.channelNotReady.code
  ) return 'tool_unavailable'
  if (
    errorKind === SEND_IM_ERROR_KINDS.fileNotFound.code
    || errorKind === SEND_IM_ERROR_KINDS.fileAmbiguous.code
    || errorKind === SEND_IM_ERROR_KINDS.directoryNotSupported.code
  ) {
    return 'no_artifact'
  }
  return 'proof_gap'
}

function skillProjectionPatch(files?: ResolvedSendImFile[], errorKind?: string): Record<string, unknown> {
  const patch: Record<string, unknown> = { module: 'skill', taskType: 'short_task', skillExecutionForm: 'direct' }
  if (files && files.length > 0) patch.recentArtifacts = filesToRecentArtifacts(files)
  if (errorKind) {
    patch.terminalFailureReason = terminalFailureReasonForSendImError(errorKind)
    patch.terminalFailureTool = 'skill_send_im_file'
    patch.terminalFailureErrorKind = errorKind
  }
  return patch
}

function isDirectoryPath(path: string): boolean {
  try {
    return isAbsolute(path) && existsSync(path) && statSync(path).isDirectory()
  } catch {
    // silent-catch: path probes can fail on permissions; callers treat it as not-a-directory.
    return false
  }
}

function listDirectoryMediaResources(resource: SendImAttachmentResource): SendImAttachmentResource[] {
  if (!isDirectoryPath(resource.path)) return []
  try {
    return readdirSync(resource.path)
      .map((name) => {
        const path = join(resource.path, name)
        if (!existsSync(path) || !statSync(path).isFile()) return null
        const mimeType = mimeTypeFromExt(extname(path).toLowerCase())
        const item: SendImAttachmentResource = {
          name,
          path,
          kind: attachmentTypeFromPath(path, mimeType),
          mimeType,
        }
        return isMediaResource(item) ? item : null
      })
      .filter((item): item is SendImAttachmentResource => Boolean(item))
      .sort((left, right) => left.name.localeCompare(right.name, 'zh-Hans-CN', { numeric: true }))
  } catch {
    // silent-catch: unreadable folders are ignored so explicit file paths still work.
    return []
  }
}

function wantsDirectoryMedia(text: string): boolean {
  const value = String(text || '')
  return /(?:里|里面|目录|文件夹|folder|directory).{0,12}(?:图|图片|照片|素材)|(?:图|图片|照片|素材).{0,12}(?:里|里面|目录|文件夹|folder|directory)/i.test(value)
}

function wantsRecentMedia(text: string): boolean {
  return /(这|最近|刚刚|刚才|下载|保存|选中).{0,12}(图|图片|照片|素材|文件)|这(?:几|四|3|4|三|张|些)张图|四张图|这些图/.test(text)
}

function parseSmallChineseNumber(value: string): number | null {
  const token = String(value || '').trim()
  if (!token) return null
  if (/^\d+$/.test(token)) {
    const parsed = Number.parseInt(token, 10)
    return parsed > 0 && parsed <= 20 ? parsed : null
  }
  const digit: Record<string, number> = {
    一: 1,
    二: 2,
    两: 2,
    三: 3,
    四: 4,
    五: 5,
    六: 6,
    七: 7,
    八: 8,
    九: 9,
  }
  if (token in digit) return digit[token]
  if (token === '十') return 10
  const tenIndex = token.indexOf('十')
  if (tenIndex >= 0) {
    const tens = tenIndex === 0 ? 1 : digit[token.slice(0, tenIndex)] || 0
    const onesToken = token.slice(tenIndex + 1)
    const ones = onesToken ? digit[onesToken] || 0 : 0
    const total = tens * 10 + ones
    return total > 0 && total <= 20 ? total : null
  }
  return null
}

function requestedRecentMediaCount(text: string): number | null {
  const value = String(text || '')
  const patterns = [
    /这\s*([0-9一二两三四五六七八九十]+)\s*张(?:图|图片|照片|素材)?/,
    /([0-9一二两三四五六七八九十]+)\s*张(?:图|图片|照片|素材)/,
    /(?:最近|刚刚|刚才|下载|已下载|保存|选中).{0,8}([0-9一二两三四五六七八九十]+)\s*(?:张|个)(?:图|图片|照片|素材)?/,
  ]
  for (const pattern of patterns) {
    const match = value.match(pattern)
    const parsed = match ? parseSmallChineseNumber(match[1] || '') : null
    if (parsed) return parsed
  }
  return null
}

function primaryInstructionFromContext(context: SendImSkillRuntimeContext): string {
  const envelope = asRecord(context.requestEnvelope)
  const primary = envelope && typeof envelope.primaryInstruction === 'string'
    ? envelope.primaryInstruction.trim()
    : ''
  return primary
}

function isRetrySendImRecovery(context: SendImSkillRuntimeContext): boolean {
  const primary = primaryInstructionFromContext(context)
  return isRetryOnlyTurn(primary) || isRetryOnlyTurn(context.currentUserText || '')
}

function validateResolvedFile(path: string, displayName?: string): {
  ok: true
  file: ResolvedSendImFile
} | { ok: false; error: string; detail?: Record<string, unknown> } {
  if (!isAbsolute(path) || !existsSync(path)) {
    return { ok: false, error: `本地文件不可用：${path}` }
  }
  const stat = statSync(path)
  if (!stat.isFile()) return { ok: false, error: `目标不是文件：${path}` }
  if (stat.size <= 0) return { ok: false, error: `文件为空：${path}` }
  if (stat.size > 100 * 1024 * 1024) return { ok: false, error: `文件超过 100MB：${basename(path)}` }
  const ext = extname(path).toLowerCase()
  const mimeType = mimeTypeFromExt(ext)
  return {
    ok: true,
    file: {
      path,
      name: displayName || basename(path),
      size: stat.size,
      ext,
      mimeType,
      type: attachmentTypeFromPath(path, mimeType),
    },
  }
}

function stringifySendError(error: unknown): string {
  if (error instanceof Error) return error.message
  if (typeof error === 'string') return error
  if (error === null || error === undefined) return ''
  try {
    return JSON.stringify(error)
  } catch {
    // silent-catch: non-serializable thrown values still need a readable fallback.
    return String(error)
  }
}

function diagnoseSendFailure(error: unknown): SendImFailureDiagnosis {
  const rawError = stringifySendError(error).trim()
  const sendMessageRet = rawError.match(/ret\s*=\s*(-[23])\b/i)?.[1] || ''
  if (sendMessageRet && /sendmessage/i.test(rawError)) {
    return {
      text: [
        `微信发送接口拒绝了这次发送：ret=${sendMessageRet} (sendmessage)。`,
        '这不是 Ready 找不到文件，也没有证据指向附件尺寸限制；本轮直接重试大概率仍会失败。',
        '请先从微信给 Ready 发一条新消息刷新发送会话后重试；仍失败再重新绑定微信。',
      ].join(''),
      errorKind: SEND_IM_ERROR_KINDS.blockedExternal.code,
      errorCode: `wechat_sendmessage_ret_${sendMessageRet}`,
      retryable: false,
      rawError,
    }
  }
  return {
    text: `微信文件发送失败：${rawError || '未知错误'}`,
    errorKind: SEND_IM_ERROR_KINDS.sendFailed.code,
    errorCode: SEND_IM_ERROR_KINDS.sendFailed.code,
    retryable: true,
    rawError,
  }
}

function recordChannelDeliveryResult(
  context: SendImSkillRuntimeContext,
  channelId: string,
  result: { success: boolean; error?: string },
): void {
  context.runtime?.recordChannelDeliveryResult?.(channelId, result)
}

function resolveFiles(args: Record<string, unknown>, context: SendImSkillRuntimeContext): {
  ok: true
  files: ResolvedSendImFile[]
} | { ok: false; error: string; errorKind: string; detail?: Record<string, unknown> } {
  const explicitPaths = stringArrayField(args, 'filePaths', 'file_paths', 'paths')
  const explicitPath = stringField(args, 'filePath', 'file_path', 'path')
  if (explicitPath) explicitPaths.unshift(explicitPath)

  const requestedNames = stringArrayField(args, 'fileNames', 'file_names', 'names')
  const requestedName = stringField(args, 'fileName', 'file_name', 'name', 'reference')
  if (requestedName) requestedNames.unshift(requestedName)
  const mentionNames = extractMentionNames(context.currentUserText || '')
  const resources = listEnvelopeResources(context.requestEnvelope)
  const recentMedia = listContextRecentArtifacts(context)
  const textWantsRecentMedia = wantsRecentMedia(context.currentUserText || '')
  const textWantsDirectoryMedia = wantsDirectoryMedia(context.currentUserText || '')
  const requestedMediaCount = requestedRecentMediaCount(context.currentUserText || '')

  const selectedResources = explicitPaths.some((path) => !isAbsolute(path))
    ? selectResources([...resources, ...recentMedia], [...explicitPaths, ...requestedNames, ...mentionNames], !textWantsRecentMedia)
    : selectResources(resources, [...requestedNames, ...mentionNames], !textWantsRecentMedia)
  const selectedResourcesOrPaths = [
    ...explicitPaths.filter((path) => isAbsolute(path)).map((path) => ({ path, name: basename(path) })),
    ...selectedResources.map((item) => ({ path: item.path, name: basename(item.path) || item.name })),
  ]
  const selectedPaths: Array<{ path: string; name: string }> = []
  for (const candidate of selectedResourcesOrPaths) {
    if (!isDirectoryPath(candidate.path)) {
      selectedPaths.push(candidate)
      continue
    }
    if (!textWantsDirectoryMedia) {
      return {
        ok: false,
        error: `目标是文件夹，不是可直接发送的文件：${candidate.path}`,
        errorKind: SEND_IM_ERROR_KINDS.directoryNotSupported.code,
        detail: { path: candidate.path },
      }
    }
    const expanded = listDirectoryMediaResources(candidate)
    if (expanded.length === 0) {
      return {
        ok: false,
        error: `文件夹里没有找到可发送的图片或视频：${candidate.path}`,
        errorKind: SEND_IM_ERROR_KINDS.fileNotFound.code,
        detail: { path: candidate.path },
      }
    }
    if (requestedMediaCount !== null && expanded.length < requestedMediaCount) {
      return {
        ok: false,
        error: `文件夹里只找到 ${expanded.length} 个媒体文件，少于用户要求的 ${requestedMediaCount} 个。`,
        errorKind: SEND_IM_ERROR_KINDS.fileNotFound.code,
        detail: {
          requestedCount: requestedMediaCount,
          mediaCount: expanded.length,
          candidates: expanded.map((item) => ({ name: item.name, path: item.path })).slice(0, 12),
        },
      }
    }
    const chosen = requestedMediaCount === null ? expanded : expanded.slice(0, requestedMediaCount)
    if (requestedMediaCount === null && chosen.length > 4) {
      return {
        ok: false,
        error: '文件夹里找到多个媒体文件，请说明要发哪几张，或传入 fileNames/filePaths。',
        errorKind: SEND_IM_ERROR_KINDS.fileAmbiguous.code,
        detail: {
          mediaCount: expanded.length,
          candidates: expanded.map((item) => ({ name: item.name, path: item.path })).slice(0, 12),
        },
      }
    }
    selectedPaths.push(...chosen.map((item) => ({ path: item.path, name: item.name })))
  }

  if (selectedPaths.length === 0) {
    const textResources = extractLocalFileResourcesFromText(context.currentUserText || '')
      .filter((item) => !textWantsRecentMedia || isMediaResource(item))
    if (textResources.length > 0) {
      const retryRecoveredMedia = isRetrySendImRecovery(context)
        && textResources.length <= 4
        && textResources.every((item) => isMediaResource(item))
      if (requestedMediaCount !== null) {
        selectedPaths.push(...textResources.slice(-requestedMediaCount).map((item) => ({
          path: item.path,
          name: item.name,
        })))
      } else if (textResources.length === 1 || (textWantsRecentMedia && textResources.length <= 4) || retryRecoveredMedia) {
        selectedPaths.push(...textResources.map((item) => ({ path: item.path, name: item.name })))
      } else {
        return {
          ok: false,
          error: '上下文里找到多个可发送文件，请明确要发哪几个。',
          errorKind: SEND_IM_ERROR_KINDS.fileAmbiguous.code,
          detail: {
            textPathCount: textResources.length,
            candidates: textResources.map((item) => ({
              name: item.name,
              path: item.path,
              kind: item.kind || null,
            })).slice(0, 12),
          },
        }
      }
    }
  }

  const useRecentMedia = selectedPaths.length === 0
    && recentMedia.length > 0
    && textWantsRecentMedia
  const recentMediaCount = useRecentMedia ? requestedMediaCount : null
  if (useRecentMedia && recentMediaCount !== null && recentMedia.length < recentMediaCount) {
    return {
      ok: false,
      error: `只找到 ${recentMedia.length} 个最近媒体，少于用户要求的 ${recentMediaCount} 个。`,
      errorKind: SEND_IM_ERROR_KINDS.fileNotFound.code,
      detail: {
        requestedCount: recentMediaCount,
        recentMediaCount: recentMedia.length,
        candidates: recentMedia.map((item) => ({
          name: item.name,
          path: item.path,
          kind: item.kind || null,
        })).slice(0, 12),
      },
    }
  }
  if (useRecentMedia && recentMediaCount === null && recentMedia.length > 4) {
    return {
      ok: false,
      error: '找到多个最近媒体，请说明要发哪几张，或传入 fileNames/filePaths。',
      errorKind: SEND_IM_ERROR_KINDS.fileAmbiguous.code,
      detail: {
        recentMediaCount: recentMedia.length,
        candidates: recentMedia.map((item) => ({
          name: item.name,
          path: item.path,
          kind: item.kind || null,
        })).slice(0, 12),
      },
    }
  }
  const candidates = useRecentMedia
    ? recentMedia
        .slice(-(recentMediaCount || recentMedia.length))
        .map((item) => ({ path: item.path, name: basename(item.path) || item.name }))
    : selectedPaths

  if (candidates.length === 0) {
    const available = [...resources, ...recentMedia].map((item) => ({
      name: item.name,
      path: item.path,
      kind: item.kind || null,
    })).slice(0, 12)
    const errorKind = available.length > 1
      ? SEND_IM_ERROR_KINDS.fileAmbiguous.code
      : SEND_IM_ERROR_KINDS.fileNotFound.code
    return {
      ok: false,
      error: available.length > 1
        ? '找到多个可发送文件，请指定 fileName 或 filePaths。'
        : '没有找到要发送的本地文件。请用 @[文件] 引用、传入 filePath/filePaths，或先下载/选中图片。',
      errorKind,
      detail: {
        requestedNames,
        mentions: mentionNames,
        resourceCount: resources.length,
        recentMediaCount: recentMedia.length,
        candidates: available,
      },
    }
  }

  const files: ResolvedSendImFile[] = []
  for (const candidate of candidates) {
    if (files.some((file) => file.path === candidate.path)) continue
    const resolved = validateResolvedFile(candidate.path, candidate.name)
    if (!resolved.ok) return { ...resolved, errorKind: SEND_IM_ERROR_KINDS.fileNotFound.code }
    files.push(resolved.file)
  }
  return { ok: true, files }
}

function resolveWechatChannel(args: Record<string, unknown>, context: SendImSkillRuntimeContext): {
  ok: true
  channel: SendImChannelConfig
  thread?: string
  usesSelfTarget: boolean
} | { ok: false; error: string; detail?: Record<string, unknown> } {
  const runtime = context.runtime
  const channels = runtime?.listChannels?.() || []
  const channelId = stringField(args, 'channelId', 'channel_id')
  const target = stringField(args, 'target', 'channel', 'channelType', 'channel_type', 'im')
  if (target && !/(?:微信|wechat|weixin|wx|im)/i.test(target)) {
    return { ok: false, error: 'send-im 目前只支持微信附件直发。' }
  }
  const enabledWechat = channels.filter((channel) => channel.enabled && channel.type === 'wechat-openclaw')
  const channel = channelId
    ? channels.find((item) => item.id === channelId)
    : enabledWechat.find((item) => item.id === 'channel-wechat-openclaw-default') || enabledWechat[0] || null
  if (!channel) {
    return { ok: false, error: '没有找到已启用的微信远程 IM 通道。' }
  }
  if (!channel.enabled) {
    return { ok: false, error: `微信通道未启用：${channel.name || channel.id}` }
  }
  if (channel.type !== 'wechat-openclaw') {
    return { ok: false, error: `目标通道不是微信：${channel.name || channel.id}` }
  }
  if (!channelId && enabledWechat.length > 1 && channel.id !== 'channel-wechat-openclaw-default') {
    return {
      ok: false,
      error: '存在多个微信通道，请指定 channelId。',
      detail: { channels: enabledWechat.map((item) => ({ id: item.id, name: item.name })) },
    }
  }
  const explicitRecipient = stringField(args, 'recipient', 'thread', 'to', 'targetId', 'target_id')
  if (explicitRecipient) {
    return { ok: false, error: '微信 Send IM 只支持发送到已绑定账号本人，不支持指定收件人。' }
  }
  return { ok: true, channel, usesSelfTarget: true }
}

export async function executeSendImFileTool(
  args: Record<string, unknown>,
  context: SendImSkillRuntimeContext,
): Promise<ToolExecutionOutput> {
  if (hasNegatedLocalSendImFileIntent(context.currentUserText || '')) {
    return createToolExecutionOutput('用户明确表示不要发送到远程 IM，已取消发送。', {
      shape: 'json',
      data: { status: 'error', errorKind: SEND_IM_ERROR_KINDS.intentNegated.code },
      projectionPatch: skillProjectionPatch(undefined, SEND_IM_ERROR_KINDS.intentNegated.code),
    })
  }
  const sidecar = context.sidecarManager
  if (!sidecar?.sendChannel) {
    return createToolExecutionOutput('远程 IM 发送通道不可用。', {
      shape: 'json',
      data: { status: 'error', errorKind: SEND_IM_ERROR_KINDS.sidecarUnavailable.code },
      projectionPatch: skillProjectionPatch(undefined, SEND_IM_ERROR_KINDS.sidecarUnavailable.code),
    })
  }
  const resolved = resolveFiles(args, context)
  if (!resolved.ok) {
    return createToolExecutionOutput(resolved.error, {
      shape: 'json',
      data: { status: 'error', errorKind: resolved.errorKind, detail: resolved.detail || null },
      projectionPatch: skillProjectionPatch(undefined, resolved.errorKind),
    })
  }
  const target = resolveWechatChannel(args, context)
  if (!target.ok) {
    return createToolExecutionOutput(target.error, {
      shape: 'json',
      data: { status: 'error', errorKind: SEND_IM_ERROR_KINDS.channelNotReady.code, detail: target.detail || null },
      projectionPatch: skillProjectionPatch(resolved.files, SEND_IM_ERROR_KINDS.channelNotReady.code),
    })
  }
  if (sidecar.isRunning && !sidecar.isRunning() && sidecar.start) {
    await sidecar.start()
  }
  const message = stringField(args, 'message', 'text', 'caption')
  const attachments = resolved.files.map((file) => ({
    name: file.name,
    path: file.path,
    mimeType: file.mimeType,
    size: file.size,
    type: file.type,
    ext: file.ext,
  }))
  try {
    const response = await sidecar.sendChannel({
      id: target.channel.id,
      thread: target.thread || undefined,
      text: message,
      attachments,
    })
    const delivery = normalizeChannelDeliveryResult(response, '微信文件发送失败')
    recordChannelDeliveryResult(context, target.channel.id, delivery)
    if (!delivery.success) {
      const failure = diagnoseSendFailure(delivery.error)
      return createToolExecutionOutput(failure.text, {
        shape: 'json',
        data: {
          status: 'error',
          errorKind: failure.errorKind,
          errorCode: failure.errorCode,
          retryable: failure.retryable,
          channelId: target.channel.id,
          filePaths: resolved.files.map((file) => file.path),
          error: failure.rawError || null,
          message: failure.text,
        },
        projectionPatch: skillProjectionPatch(resolved.files, failure.errorKind),
      })
    }
    return createToolExecutionOutput(
      resolved.files.length === 1
        ? `已发送文件到微信：${resolved.files[0].name}`
        : `已发送 ${resolved.files.length} 个文件到微信。`,
      {
        shape: 'json',
        data: {
          status: 'done',
          channelId: target.channel.id,
          channelName: target.channel.name,
          usesSelfTarget: target.usesSelfTarget,
          filePaths: resolved.files.map((file) => file.path),
          fileNames: resolved.files.map((file) => file.name),
          count: resolved.files.length,
          totalSize: resolved.files.reduce((sum, file) => sum + file.size, 0),
        },
        projectionPatch: skillProjectionPatch(resolved.files),
      },
    )
  } catch (error) {
    // silent-catch: send failure is returned as structured tool output for the model and task ledger.
    const delivery = { success: false, error: stringifySendError(error) || '微信文件发送失败' }
    recordChannelDeliveryResult(context, target.channel.id, delivery)
    const failure = diagnoseSendFailure(error)
    return createToolExecutionOutput(failure.text, {
      shape: 'json',
      data: {
        status: 'error',
        errorKind: failure.errorKind,
        errorCode: failure.errorCode,
        retryable: failure.retryable,
        channelId: target.channel.id,
        filePaths: resolved.files.map((file) => file.path),
        error: failure.rawError || null,
        message: failure.text,
      },
      projectionPatch: skillProjectionPatch(resolved.files, failure.errorKind),
    })
  }
}
