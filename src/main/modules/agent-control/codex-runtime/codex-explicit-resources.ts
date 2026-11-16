import { libraryResourceSelectionSchema } from '../../../../shared/ipc-contracts/agent-runtime'
import { libraryResourceVersion, libraryTools, type LibraryGrant } from './library-read-resources'
import type { ObjectLocation } from '../../../../shared/object-identity'
import { RSSReferenceResourceSchema, type RSSReferenceResource } from '../../../../shared/rss-reference'
import { rssResourceVersion } from './codex-rss-resources'
import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { realpath, stat } from 'node:fs/promises'
import { basename, extname, join } from 'node:path'
import { z } from 'zod'

import type { SendScopedResourceSelection } from '../../../../shared/ipc-contracts/agent-runtime'
import type { RequestEnvelopeResource } from '../contracts/request-envelope'

import type { CodexUserInput } from './codex-user-input'
import type { ResourceVersionReference } from './codex-turn-input-builder'

const IMAGE_EXTENSIONS = new Set([
  '.avif', '.bmp', '.gif', '.ico', '.jpeg', '.jpg', '.png', '.svg', '.tif', '.tiff', '.webp',
])
const AUDIO_EXTENSIONS = new Set([
  '.aac', '.flac', '.m4a', '.mp3', '.ogg', '.opus', '.wav', '.webm',
])
const TEXT_EXTENSIONS = new Set([
  '.csv', '.html', '.htm', '.json', '.log', '.markdown', '.md', '.txt', '.xml', '.yaml', '.yml',
])
const EXTRACTABLE_DOCUMENT_EXTENSIONS = new Set([
  ...TEXT_EXTENSIONS,
  '.docx', '.pdf', '.xls', '.xlsx',
])

export type CodexResolvedSkillInput = {
  name: string
  path: string
}

export type CodexResolvedInlineResource = {
  name: string
  path: string | null
  text: string
  digest: string
}

export type PreparedCodexResourceAuthority = {
  kind: 'local_file' | 'local_directory'
  logicalResourceId: string
  name: string
  path: string
  currentVersion: string
  currentDigest: string
  policyEpoch: number
  directoryIdentity?: {
    device: string
    inode: string
    mode: number
    mtimeMs: number
  }
  allowedToolNames: Array<'file_extract_text' | 'file_read_excerpt' | 'file_inventory'>
}

export const preparedCodexResourceAuthoritySchema = z.object({
  kind: z.enum(['local_file', 'local_directory']),
  logicalResourceId: z.string().min(1),
  name: z.string().min(1),
  path: z.string().min(1),
  currentVersion: z.string().min(1),
  currentDigest: z.string().regex(/^[a-f0-9]{64}$/),
  policyEpoch: z.number().int().positive(),
  directoryIdentity: z.object({
    device: z.string().min(1),
    inode: z.string().min(1),
    mode: z.number().int().nonnegative(),
    mtimeMs: z.number().nonnegative(),
  }).strict().optional(),
  allowedToolNames: z.array(z.enum([
    'file_extract_text', 'file_read_excerpt', 'file_inventory',
  ])),
}).strict()

export type ResolvedCodexExplicitResources = {
  input: CodexUserInput[]
  resourceRefs: ResourceVersionReference[]
  requestResources: RequestEnvelopeResource[]
  authorities: PreparedCodexResourceAuthority[]
  libraryResources: LibraryGrant[]
  rssReferences: RSSReferenceResource[]
}


function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex')
}

async function sha256File(path: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const hash = createHash('sha256')
    const stream = createReadStream(path)
    stream.on('data', (chunk) => hash.update(chunk))
    stream.once('error', reject)
    stream.once('end', () => resolve(hash.digest('hex')))
  })
}

function versionReference(
  logicalResourceId: string,
  digest: string,
): ResourceVersionReference {
  return {
    logicalResourceId,
    currentVersion: `sha256:${digest}`,
    currentDigest: digest,
    supersedesVersion: null,
    policyEpoch: 1,
  }
}

function bodyFreeRequestResource(input: {
  logicalResourceId: string
  kind: RequestEnvelopeResource['kind']
  source: RequestEnvelopeResource['source']
  name: string
  path: string | null
  order: number
  canRead: boolean
}): RequestEnvelopeResource {
  return {
    id: input.logicalResourceId,
    kind: input.kind,
    source: input.source,
    name: input.name,
    path: input.path,
    text: '',
    summary: null,
    order: input.order,
    canRead: input.canRead,
    canWrite: false,
  }
}

const ISO_WINDOW = /^\d{4}-\d{2}-\d{2}(?:T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,3})?)?(?:Z|[+-]\d{2}:\d{2})?)?$/
const MAX_CALENDAR_WINDOW_MS = 366 * 24 * 60 * 60 * 1000

export function validateCodexCalendarWindow(input: {
  start: string
  end: string
  calendarId?: string
}): { start: string; end: string; calendarId?: string } {
  const start = String(input.start || '').trim()
  const end = String(input.end || '').trim()
  if (!ISO_WINDOW.test(start) || !ISO_WINDOW.test(end)) {
    throw new Error('codex_calendar_window_invalid')
  }
  const startMs = Date.parse(start)
  const endMs = Date.parse(end)
  if (!Number.isFinite(startMs) || !Number.isFinite(endMs)) {
    throw new Error('codex_calendar_window_invalid')
  }
  if (startMs >= endMs) throw new Error('codex_calendar_window_order_invalid')
  if (endMs - startMs > MAX_CALENDAR_WINDOW_MS) {
    throw new Error('codex_calendar_window_span_invalid')
  }
  const calendarId = typeof input.calendarId === 'string' && input.calendarId.trim()
    ? input.calendarId.trim()
    : undefined
  return { start, end, ...(calendarId ? { calendarId } : {}) }
}

export async function resolveCodexExplicitResources(input: {
  selections: readonly SendScopedResourceSelection[]
  resolveSkill: (selection: Extract<SendScopedResourceSelection, { kind: 'skill' }>) => CodexResolvedSkillInput | null
  resolveBrowser?: (
    selection: Extract<SendScopedResourceSelection, { kind: 'browser_tab' }>,
  ) => Promise<CodexResolvedInlineResource | null>
  resolveCalendar?: (
    selection: Extract<SendScopedResourceSelection, { kind: 'calendar_event' }>,
  ) => CodexResolvedInlineResource | null
  resolveRssReference?: (resource: RSSReferenceResource) => RSSReferenceResource | null
  resolveRssItem?: (
    selection: Extract<SendScopedResourceSelection, { kind: 'rss_item' }>,
  ) => CodexResolvedInlineResource | null
  resolveRssSource?: (
    selection: Extract<SendScopedResourceSelection, { kind: 'rss_source' }>,
  ) => CodexResolvedInlineResource | null
  resolveMcpResource?: (
    selection: Extract<SendScopedResourceSelection, { kind: 'mcp_resource' }>,
  ) => Promise<CodexResolvedInlineResource | null>
  resolveLocalObject?: (path: string) => ObjectLocation
  resolveReadyReference?: (selection: Extract<SendScopedResourceSelection, { kind: 'ready_reference' }>) => CodexResolvedInlineResource | Promise<CodexResolvedInlineResource>
  resolveLibrary?: (selection: unknown) => Promise<LibraryGrant>
  /** The file to hand the model for an attached image: the image itself, or a fitted copy of a large one. */
  prepareImage?: (path: string) => Promise<string>
  selectedSkill?: CodexResolvedSkillInput | null
}): Promise<ResolvedCodexExplicitResources> {
  const nativeInput: CodexUserInput[] = []
  const resourceRefs: ResourceVersionReference[] = []
  const requestResources: RequestEnvelopeResource[] = []
  const authorities: PreparedCodexResourceAuthority[] = []
  const rssReferences: RSSReferenceResource[] = []
  const libraryResources: LibraryGrant[] = []
  const seen = new Set<string>()

  const addSkill = async (
    skill: CodexResolvedSkillInput,
    unavailableCode: 'codex_explicit_skill_unavailable' | 'codex_selected_skill_unavailable',
  ): Promise<void> => {
    let canonicalPath: string
    let metadata
    try {
      canonicalPath = await realpath(skill.path)
      metadata = await stat(canonicalPath)
    } catch {
      throw new Error(unavailableCode)
    }
    if (!metadata.isDirectory()) throw new Error('codex_explicit_skill_not_directory')
    const key = `skill\u0000${canonicalPath}`
    if (seen.has(key)) return
    seen.add(key)
    const digest = await sha256File(join(canonicalPath, 'SKILL.md')).catch(() => {
      throw new Error(unavailableCode)
    })
    const logicalResourceId = `skill:${sha256(canonicalPath).slice(0, 32)}`
    nativeInput.push({ type: 'skill', name: skill.name, path: canonicalPath })
    resourceRefs.push(versionReference(logicalResourceId, digest))
    requestResources.push(bodyFreeRequestResource({
      logicalResourceId,
      kind: 'skill_reference',
      source: 'explicit_reference',
      name: skill.name,
      path: canonicalPath,
      order: requestResources.length,
      canRead: false,
    }))
  }

  for (const selection of input.selections) {
    if (selection.kind === 'ready_reference') {
      const resolved = await input.resolveReadyReference?.(selection)
      if (!resolved) throw new Error('codex_explicit_reference_unavailable')
      const logicalResourceId = `ready:${sha256(JSON.stringify(selection.ref))}`
      if (seen.has(logicalResourceId)) continue
      seen.add(logicalResourceId)
      nativeInput.push({ type: 'text', text: resolved.text, text_elements: [] })
      resourceRefs.push(versionReference(logicalResourceId, resolved.digest))
      requestResources.push(bodyFreeRequestResource({ logicalResourceId, kind: 'document_quote', source: 'explicit_reference',
        name: resolved.name, path: resolved.path, order: requestResources.length, canRead: true }))
      continue
    }
    if (selection.kind === 'skill') {
      let skill: CodexResolvedSkillInput | null
      try {
        skill = input.resolveSkill(selection)
      } catch {
        throw new Error('codex_explicit_skill_unavailable')
      }
      if (!skill) throw new Error('codex_explicit_skill_unavailable')
      await addSkill(skill, 'codex_explicit_skill_unavailable')
      continue
    }

    if (selection.kind === 'browser_tab' || selection.kind === 'calendar_event') {
      const resolved = selection.kind === 'browser_tab'
        ? await input.resolveBrowser?.(selection) ?? null
        : input.resolveCalendar?.(selection) ?? null
      if (!resolved) {
        throw new Error(selection.kind === 'browser_tab'
          ? 'codex_explicit_browser_reference_unavailable'
          : 'codex_explicit_calendar_reference_unavailable')
      }
      const logicalResourceId = `${selection.kind}:${sha256(
        selection.kind === 'browser_tab' ? selection.tabId : selection.eventId,
      ).slice(0, 32)}`
      const key = `${selection.kind}\u0000${logicalResourceId}`
      if (seen.has(key)) continue
      seen.add(key)
      nativeInput.push({ type: 'text', text: resolved.text, text_elements: [] })
      resourceRefs.push(versionReference(logicalResourceId, resolved.digest))
      requestResources.push(bodyFreeRequestResource({
        logicalResourceId,
        kind: selection.kind === 'browser_tab' ? 'browser_reference' : 'calendar_event',
        source: selection.kind === 'browser_tab' ? 'browser_context' : 'calendar_context',
        name: resolved.name,
        path: resolved.path,
        order: requestResources.length,
        canRead: true,
      }))
      continue
    }

    if (selection.kind === 'rss_reference') {
      const selected = RSSReferenceResourceSchema.parse({ id: selection.id, name: selection.name, reference: selection.reference })
      const resource = input.resolveRssReference?.(selected)
      if (!resource) throw new Error('codex_explicit_rss_reference_unavailable')
      const key = `rss_reference:${resource.id}`
      if (seen.has(key)) continue
      seen.add(key)
      rssReferences.push(resource)
      resourceRefs.push(rssResourceVersion(resource))
      requestResources.push({ ...bodyFreeRequestResource({ logicalResourceId: resource.id, kind: 'rss_reference', source: 'rss_context', name: resource.name, path: null, order: requestResources.length, canRead: true }), rssReference: resource.reference })
      nativeInput.push({ type: 'text', text: JSON.stringify({ rssReferenceId: resource.id, name: resource.name, readWith: 'rss_read_reference', readonly: true }), text_elements: [] })
      continue
    }

    if (selection.kind === 'rss_item' || selection.kind === 'rss_source') {
      const resolved = selection.kind === 'rss_item'
        ? input.resolveRssItem?.(selection) ?? null
        : input.resolveRssSource?.(selection) ?? null
      if (!resolved) {
        throw new Error(selection.kind === 'rss_item'
          ? 'codex_explicit_rss_item_unavailable'
          : 'codex_explicit_rss_source_unavailable')
      }
      const identity = selection.kind === 'rss_item' ? selection.itemId : selection.sourceId
      const logicalResourceId = `${selection.kind}:${sha256(identity).slice(0, 32)}`
      const key = `${selection.kind}\u0000${logicalResourceId}`
      if (seen.has(key)) continue
      seen.add(key)
      nativeInput.push({ type: 'text', text: resolved.text, text_elements: [] })
      resourceRefs.push(versionReference(logicalResourceId, resolved.digest))
      requestResources.push(bodyFreeRequestResource({
        logicalResourceId,
        kind: selection.kind,
        source: 'rss_context',
        name: resolved.name,
        path: resolved.path,
        order: requestResources.length,
        canRead: true,
      }))
      continue
    }

    if (selection.kind === 'mcp_resource') {
      const resolved = await input.resolveMcpResource?.(selection) ?? null
      if (!resolved || resolved.digest !== selection.contentDigest) {
        throw new Error('codex_explicit_mcp_resource_unavailable')
      }
      const identity = `${selection.serverId}\u0000${selection.uri}\u0000${selection.catalogGeneration}`
      const logicalResourceId = `mcp-resource:${sha256(identity).slice(0, 32)}`
      const key = `mcp_resource\u0000${logicalResourceId}`
      if (seen.has(key)) continue
      seen.add(key)
      nativeInput.push({ type: 'text', text: resolved.text, text_elements: [] })
      resourceRefs.push(versionReference(logicalResourceId, resolved.digest))
      requestResources.push(bodyFreeRequestResource({
        logicalResourceId,
        kind: 'mcp_resource',
        source: 'mcp_context',
        name: resolved.name,
        path: resolved.path,
        order: requestResources.length,
        canRead: true,
      }))
      continue
    }

    if (selection.kind === 'calendar_window') {
      const window = validateCodexCalendarWindow(selection)
      const digest = sha256(JSON.stringify(window))
      const logicalResourceId = `calendar-window:${digest.slice(0, 32)}`
      const key = `calendar_window\u0000${logicalResourceId}`
      if (seen.has(key)) continue
      seen.add(key)
      nativeInput.push({
        type: 'text',
        text: `当前日历可见窗口（结构事实，不含事件正文）：${window.start} 至 ${window.end}${window.calendarId ? `，日历 ${window.calendarId}` : ''}`,
        text_elements: [],
      })
      resourceRefs.push(versionReference(logicalResourceId, digest))
      requestResources.push({
        ...bodyFreeRequestResource({
          logicalResourceId,
          kind: 'calendar_window',
          source: 'calendar_context',
          name: selection.name,
          path: null,
          order: requestResources.length,
          canRead: true,
        }),
        summary: `${window.start}/${window.end}`,
      })
      continue
    }

    if (selection.kind === 'widget_target') {
      const digest = selection.currentDigest
      const logicalResourceId = selection.logicalResourceId
      const key = `widget_target\u0000${logicalResourceId}\u0000${selection.widgetId}`
      if (seen.has(key)) continue
      seen.add(key)
      resourceRefs.push(versionReference(logicalResourceId, digest))
      requestResources.push({
        ...bodyFreeRequestResource({
          logicalResourceId,
          kind: 'widget_target',
          source: 'widget_target',
          name: selection.name,
          path: null,
          order: requestResources.length,
          canRead: true,
        }),
        tabId: selection.tabId,
        widgetId: selection.widgetId,
      })
      continue
    }

    if (libraryResourceSelectionSchema.options.some(schema => schema.shape.kind.value === selection.kind)) {
      let grant: LibraryGrant
      try {
        if (!input.resolveLibrary) throw new Error('library_resource_unavailable')
        grant = await input.resolveLibrary(selection)
      } catch (error) {
        if (!(error instanceof Error) || error.message !== 'library_resource_unavailable') throw error
        requestResources.push(bodyFreeRequestResource({ logicalResourceId: selection.id, kind: 'library_resource', source: 'explicit_reference', name: selection.name, path: null, order: requestResources.length, canRead: false }))
        nativeInput.push({ type: 'text', text: JSON.stringify({ resourceId: selection.id, name: selection.name, status: 'unavailable', message: '引用的内容已变化或无法读取，请重新选择；本项未授予读取权限。' }), text_elements: [] })
        continue
      }
      if (libraryResources.some(item => item.selection.id === grant.selection.id)) throw new Error('library_resource_unavailable')
      libraryResources.push(grant)
      resourceRefs.push(libraryResourceVersion(grant))
      requestResources.push(bodyFreeRequestResource({ logicalResourceId: grant.selection.id, kind: 'library_resource', source: 'explicit_reference', name: grant.selection.name, path: null, order: requestResources.length, canRead: true }))
      nativeInput.push({ type: 'text', text: JSON.stringify({ resource: grant.selection, version: grant.version, readWith: libraryTools(grant.selection) }), text_elements: [] })
      continue
    }
    if (selection.kind !== 'local_file' && selection.kind !== 'local_directory') throw new Error('library_resource_unavailable')

    let canonicalPath: string
    let metadata
    try {
      canonicalPath = await realpath(selection.path)
      metadata = await stat(canonicalPath)
    } catch {
      throw new Error('codex_explicit_resource_unavailable')
    }
    const expectedDirectory = selection.kind === 'local_directory'
    if (expectedDirectory !== metadata.isDirectory() || (!expectedDirectory && !metadata.isFile())) {
      throw new Error('codex_explicit_resource_kind_mismatch')
    }
    if (!input.resolveLocalObject) throw new Error('codex_object_resolver_unavailable')
    const object = input.resolveLocalObject(canonicalPath)
    // Files and directories are registered locally; identity grants no additional tools or write access.
    const logicalResourceId = `${expectedDirectory ? 'local-directory' : 'local-file'}:${object.objectId}`
    const key = `${selection.kind}\u0000${logicalResourceId}`
    if (seen.has(key)) continue
    seen.add(key)

    const name = selection.name.trim() || basename(canonicalPath)
    const digest = expectedDirectory
      ? sha256(JSON.stringify([canonicalPath, metadata.mtimeMs]))
      : await sha256File(canonicalPath).catch(() => {
          throw new Error('codex_explicit_resource_unavailable')
        })
    const reference = versionReference(logicalResourceId, digest)
    resourceRefs.push(reference)

    if (expectedDirectory) {
      nativeInput.push({ type: 'mention', name, path: canonicalPath })
      requestResources.push(bodyFreeRequestResource({
        logicalResourceId,
        kind: 'folder_reference',
        source: 'folder_reference',
        name,
        path: canonicalPath,
        order: requestResources.length,
        canRead: true,
      }))
      authorities.push({
        kind: 'local_directory',
        logicalResourceId,
        name,
        path: canonicalPath,
        currentVersion: reference.currentVersion,
        currentDigest: reference.currentDigest,
        policyEpoch: reference.policyEpoch,
        directoryIdentity: {
          device: String(metadata.dev),
          inode: String(metadata.ino),
          mode: metadata.mode,
          mtimeMs: metadata.mtimeMs,
        },
        allowedToolNames: ['file_inventory'],
      })
      continue
    }

    const extension = extname(canonicalPath).toLowerCase()
    if (IMAGE_EXTENSIONS.has(extension)) {
      nativeInput.push({ type: 'localImage', path: await input.prepareImage?.(canonicalPath) ?? canonicalPath, detail: null })
    } else if (AUDIO_EXTENSIONS.has(extension)) {
      nativeInput.push({ type: 'localAudio', path: canonicalPath })
    } else if (EXTRACTABLE_DOCUMENT_EXTENSIONS.has(extension)) {
      nativeInput.push({ type: 'mention', name, path: canonicalPath })
    } else {
      throw new Error('codex_explicit_resource_unsupported')
    }
    requestResources.push(bodyFreeRequestResource({
      logicalResourceId,
      kind: 'attachment',
      source: 'user_attachment',
      name,
      path: canonicalPath,
      order: requestResources.length,
      canRead: EXTRACTABLE_DOCUMENT_EXTENSIONS.has(extension),
    }))
    if (EXTRACTABLE_DOCUMENT_EXTENSIONS.has(extension)) {
      authorities.push({
        kind: 'local_file',
        logicalResourceId,
        name,
        path: canonicalPath,
        currentVersion: reference.currentVersion,
        currentDigest: reference.currentDigest,
        policyEpoch: reference.policyEpoch,
        allowedToolNames: [
          'file_extract_text',
          ...(TEXT_EXTENSIONS.has(extension) ? ['file_read_excerpt' as const] : []),
        ],
      })
    }
  }

  if (input.selectedSkill) await addSkill(input.selectedSkill, 'codex_selected_skill_unavailable')

  return { input: nativeInput, resourceRefs, requestResources, authorities, rssReferences, libraryResources }
}
