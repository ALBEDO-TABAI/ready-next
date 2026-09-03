import { createHash } from 'node:crypto'
import { z } from 'zod'

const nonEmptyString = z.string().min(1)

export const codexUserInputSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('text'), text: z.string(), text_elements: z.tuple([]) }).strict(),
  z.object({
    type: z.literal('image'),
    url: nonEmptyString,
    detail: z.enum(['auto', 'low', 'high', 'original']).nullable(),
  }).strict(),
  z.object({
    type: z.literal('localImage'),
    path: nonEmptyString,
    detail: z.enum(['auto', 'low', 'high', 'original']).nullable(),
  }).strict(),
  z.object({ type: z.literal('audio'), url: nonEmptyString }).strict(),
  z.object({ type: z.literal('localAudio'), path: nonEmptyString }).strict(),
  z.object({ type: z.literal('skill'), name: nonEmptyString, path: nonEmptyString }).strict(),
  z.object({ type: z.literal('mention'), name: nonEmptyString, path: nonEmptyString }).strict(),
])

export type CodexUserInput = z.infer<typeof codexUserInputSchema>

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

type CodexImageDetail = 'auto' | 'low' | 'high' | 'original' | null

function normalizeDetail(value: unknown): CodexImageDetail | undefined {
  if (value === undefined || value === null) return null
  return value === 'auto' || value === 'low' || value === 'high' || value === 'original'
    ? value
    : undefined
}

export function normalizeCodexUserInput(value: unknown): CodexUserInput | null {
  if (!isRecord(value)) return null
  if (value.type === 'text') {
    if (typeof value.text !== 'string') return null
    if (value.text_elements !== undefined && (
      !Array.isArray(value.text_elements) || value.text_elements.length !== 0
    )) return null
    return { type: 'text', text: value.text, text_elements: [] }
  }
  if (value.type === 'image' || value.type === 'localImage') {
    const key = value.type === 'image' ? 'url' : 'path'
    const location = value[key]
    const detail = normalizeDetail(value.detail)
    if (typeof location !== 'string' || location.trim().length === 0 || detail === undefined) return null
    return value.type === 'image'
      ? { type: 'image', url: location, detail }
      : { type: 'localImage', path: location, detail }
  }
  if (value.type === 'audio' || value.type === 'localAudio') {
    const key = value.type === 'audio' ? 'url' : 'path'
    const location = value[key]
    if (typeof location !== 'string' || location.trim().length === 0) return null
    return value.type === 'audio'
      ? { type: 'audio', url: location }
      : { type: 'localAudio', path: location }
  }
  if (value.type === 'skill' || value.type === 'mention') {
    if (
      typeof value.name !== 'string'
      || value.name.trim().length === 0
      || typeof value.path !== 'string'
      || value.path.trim().length === 0
    ) return null
    return { type: value.type, name: value.name, path: value.path }
  }
  return null
}

export function isCodexUserInput(value: unknown): value is CodexUserInput {
  return codexUserInputSchema.safeParse(value).success
}

export function digestCodexUserInput(input: readonly CodexUserInput[]): string {
  const normalized = input.map((item) => {
    const value = normalizeCodexUserInput(item)
    if (!value) throw new Error('codex_user_input_invalid')
    return value
  })
  return createHash('sha256').update(JSON.stringify(normalized)).digest('hex')
}
