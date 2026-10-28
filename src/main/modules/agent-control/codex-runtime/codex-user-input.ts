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

// How the pinned runtime reads a sent input back, which depends on the thread's history mode: `paginated` threads
// keep every item in order; `legacy` threads (created before 0.160.1, and forks of them) join the text without a
// separator, then list remote images, local images, remote audio and local audio, and drop skill and mention items.
const USER_INPUT_READBACK: Readonly<Record<
  'legacy' | 'paginated',
  (input: readonly CodexUserInput[]) => CodexUserInput[]
>> = {
  paginated: (input) => input.map((item) => {
    const value = normalizeCodexUserInput(item)
    if (!value) throw new Error('codex_user_input_invalid')
    return value
  }),
  legacy: (input) => {
    const text = input.flatMap((item) => item.type === 'text' ? [item.text] : []).join('')
    return [
      ...(text ? [{ type: 'text' as const, text, text_elements: [] as [] }] : []),
      ...(['image', 'localImage', 'audio', 'localAudio'] as const).flatMap((type) => (
        input.filter((item) => item.type === type)
      )),
    ]
  },
}

export function projectCodexUserInputReadback(
  input: readonly CodexUserInput[],
  historyMode: 'legacy' | 'paginated',
): CodexUserInput[] {
  const project = Object.hasOwn(USER_INPUT_READBACK, historyMode) ? USER_INPUT_READBACK[historyMode] : null
  if (!project) throw new Error('codex_thread_history_mode_unknown')
  return project(input)
}

export function digestCodexUserInput(input: readonly CodexUserInput[]): string {
  const normalized = input.map((item) => {
    const value = normalizeCodexUserInput(item)
    if (!value) throw new Error('codex_user_input_invalid')
    return value
  })
  return createHash('sha256').update(JSON.stringify(normalized)).digest('hex')
}
