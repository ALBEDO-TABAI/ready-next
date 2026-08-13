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

export type PreparedCodexResourceAuthority = {
  kind: 'local_file' | 'local_directory'
  logicalResourceId: string
  name: string
  path: string
  currentVersion: string
  currentDigest: string
  policyEpoch: number
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
  allowedToolNames: z.array(z.enum([
    'file_extract_text', 'file_read_excerpt', 'file_inventory',
  ])),
}).strict()

export type ResolvedCodexExplicitResources = {
  input: CodexUserInput[]
  resourceRefs: ResourceVersionReference[]
  requestResources: RequestEnvelopeResource[]
  authorities: PreparedCodexResourceAuthority[]
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
  path: string
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

export async function resolveCodexExplicitResources(input: {
  selections: readonly SendScopedResourceSelection[]
  resolveSkill: (selection: Extract<SendScopedResourceSelection, { kind: 'skill' }>) => CodexResolvedSkillInput | null
  selectedSkill?: CodexResolvedSkillInput | null
}): Promise<ResolvedCodexExplicitResources> {
  const nativeInput: CodexUserInput[] = []
  const resourceRefs: ResourceVersionReference[] = []
  const requestResources: RequestEnvelopeResource[] = []
  const authorities: PreparedCodexResourceAuthority[] = []
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
    const key = `${selection.kind}\u0000${canonicalPath}`
    if (seen.has(key)) continue
    seen.add(key)

    const name = selection.name.trim() || basename(canonicalPath)
    const digest = expectedDirectory
      ? sha256(JSON.stringify([canonicalPath, metadata.mtimeMs]))
      : await sha256File(canonicalPath).catch(() => {
          throw new Error('codex_explicit_resource_unavailable')
        })
    const logicalResourceId = `${expectedDirectory ? 'local-directory' : 'local-file'}:${sha256(canonicalPath).slice(0, 32)}`
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
        allowedToolNames: ['file_inventory'],
      })
      continue
    }

    const extension = extname(canonicalPath).toLowerCase()
    if (IMAGE_EXTENSIONS.has(extension)) {
      nativeInput.push({ type: 'localImage', path: canonicalPath, detail: null })
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

  return { input: nativeInput, resourceRefs, requestResources, authorities }
}
