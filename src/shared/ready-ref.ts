import { z } from 'zod'
import { RSSReadExcerptSchema } from './rss-excerpt'
import { RSSReadArticleSchema, RSSQuerySchema } from './rss-workspace'
import { parseIsoDate } from './calendar/dates'

const text = z.string().min(1).refine(value => !/[\uD800-\uDFFF]/u.test(value), 'Invalid Unicode')
const date = text.refine(value => {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false
  try { parseIsoDate(value); return true } catch { return false }
}, 'Expected a valid YYYY-MM-DD date')
const webUrl = text.refine(value => {
  try {
    const url = new URL(value)
    return /^https?:\/\//i.test(value) && (url.protocol === 'https:' || url.protocol === 'http:')
      && !/[\s\p{Cc}]/u.test(value)
  } catch { return false }
}, 'Expected an absolute HTTP(S) URL')

export const ReadyRefSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('page'), id: text, anchor: text.optional() }),
  z.strictObject({ kind: z.literal('file'), id: text, anchor: text.optional() }),
  z.strictObject({ kind: z.literal('canvas'), id: text, node: text.optional() }),
  // Preserve the original occurrence value; the calendar owns its time format and unit.
  z.strictObject({ kind: z.literal('event'), id: text, occurrence: text.optional() }),
  z.strictObject({ kind: z.literal('day'), date, at: z.string().regex(/^(?:[01]\d|2[0-3]):[0-5]\d$/).optional(), remind: z.number().int().nonnegative().optional() }),
  z.strictObject({ kind: z.literal('book-location'), book: text, loc: text }),
  z.strictObject({ kind: z.literal('rss-item'), id: text,
    article: RSSReadArticleSchema.omit({ itemId: true }).extend({ expectedRevision: text }).optional(),
    excerpt: RSSReadExcerptSchema.omit({ itemId: true }).optional(),
  }).refine(ref => !(ref.article && ref.excerpt), 'Conflicting RSS scopes'),
  z.strictObject({ kind: z.literal('rss-digest'), id: text, offset: z.number().int().nonnegative(), limit: z.number().int().min(1).max(50) }),
  z.strictObject({ kind: z.literal('rss-query'), query: RSSQuerySchema.safeExtend({ cursor: z.never().optional(), expectedRevision: z.number().int().nonnegative() }) }),
  z.strictObject({ kind: z.literal('web'), url: webUrl }),
  z.strictObject({ kind: z.literal('conversation'), id: text, run: text.optional() }),
  z.strictObject({ kind: z.literal('fastcard'), id: text }),
])

export type ReadyRef = z.infer<typeof ReadyRefSchema>
export type ReadyUriErrorCode =
  | 'invalid_scheme' | 'unknown_module' | 'invalid_path' | 'missing_id'
  | 'invalid_encoding' | 'invalid_query' | 'invalid_fragment'
  | 'invalid_date' | 'invalid_time' | 'invalid_remind' | 'invalid_web_url' | 'invalid_ref'
export type ReadyUriParseResult =
  | { ok: true; ref: ReadyRef }
  | { ok: false; error: { code: ReadyUriErrorCode; message: string } }

// [path, kind, identity field, fragment field, fragment prefix]
const routes = [
  ['doc/page', 'page', 'id', 'anchor', ''],
  ['doc/file', 'file', 'id', 'anchor', ''],
  ['canvas', 'canvas', 'id', 'node', 'node='],
  ['calendar/event', 'event', 'id', 'occurrence', 'occurrence='],
  ['read/book', 'book-location', 'book', 'loc', ''],
  ['rss/item', 'rss-item', 'id', undefined, ''],
  ['rss/digest', 'rss-digest', 'id', undefined, ''],
  ['agent/conversation', 'conversation', 'id', 'run', 'run='],
  ['fastcard', 'fastcard', 'id', undefined, ''],
] as const

/** Invalid references throw a ZodError; parsing untrusted URIs uses the result API below. */
export function toReadyUri(input: ReadyRef): string {
  const ref = ReadyRefSchema.parse(input)
  if (ref.kind === 'web') return `ready://web?url=${encodeURIComponent(ref.url)}`
  if (ref.kind === 'day') {
    const query: string[] = []
    if (ref.at !== undefined) query.push(`at=${ref.at}`)
    if (ref.remind !== undefined) query.push(`remind=${ref.remind}`)
    return `ready://calendar/day/${ref.date}${query.length ? `?${query.join('&')}` : ''}`
  }
  const encodeRSS = (value: string) => encodeURIComponent(value).replace(/[!'()*]/g, c => `%${c.charCodeAt(0).toString(16)}`)
  const encodeScope = (value: unknown) => encodeRSS(JSON.stringify(value))
  if (ref.kind === 'rss-query') return `ready://rss/query?query=${encodeScope(ref.query)}`
  if (ref.kind === 'rss-digest') return `ready://rss/digest/${encodeRSS(ref.id)}?offset=${ref.offset}&limit=${ref.limit}`
  if (ref.kind === 'rss-item' && (ref.article || ref.excerpt)) {
    const key = ref.excerpt ? 'excerpt' : 'article'
    return `ready://rss/item/${encodeRSS(ref.id)}?${key}=${encodeScope(ref[key])}`
  }
  const route = routes.find(([, kind]) => kind === ref.kind)!
  const [path, , , , prefix] = route
  const id = ref.kind === 'book-location' ? ref.book : ref.id
  const fragment = 'anchor' in ref ? ref.anchor : 'node' in ref ? ref.node
    : 'occurrence' in ref ? ref.occurrence : 'loc' in ref ? ref.loc : 'run' in ref ? ref.run : undefined
  return `ready://${path}/${encodeURIComponent(id)}${fragment !== undefined ? `#${prefix}${encodeURIComponent(fragment)}` : ''}`
}

function failure(code: ReadyUriErrorCode, message: string): ReadyUriParseResult {
  return { ok: false, error: { code, message } }
}

function validateRef(input: unknown): ReadyUriParseResult {
  const result = ReadyRefSchema.safeParse(input)
  if (result.success) return { ok: true, ref: result.data }
  const issue = result.error.issues[0]
  const codes: Record<string, ReadyUriErrorCode> = {
    date: 'invalid_date', at: 'invalid_time', remind: 'invalid_remind', url: 'invalid_web_url',
  }
  return failure(codes[String(issue.path[0])] ?? 'invalid_ref', issue.message)
}

/** Parse the raw components so URL normalization cannot erase IDs such as '.' or '..'. */
export function parseReadyUri(uri: string): ReadyUriParseResult {
  if (typeof uri !== 'string' || !uri.startsWith('ready://')) {
    return failure('invalid_scheme', 'Expected ready://')
  }
  try { decodeURIComponent(uri) } catch {
    return failure('invalid_encoding', 'Invalid percent encoding or UTF-8')
  }
  const match = /^ready:\/\/([^/?#]*)([^?#]*)(?:\?([^#]*))?(?:#([\s\S]*))?$/.exec(uri)
  if (!match) return failure('invalid_path', 'Invalid Ready URI structure')
  const [, module, path, query, fragment] = match
  if (!['doc', 'canvas', 'calendar', 'read', 'rss', 'web', 'agent', 'fastcard'].includes(module)) {
    return failure('unknown_module', `Unknown Ready module: ${module}`)
  }
  const target = module + path
  const isDay = target === 'calendar/day' || target.startsWith('calendar/day/')
  const params = new Map<string, string>()
  if (query !== undefined) {
    for (const pair of query.split('&')) {
      const equals = pair.indexOf('=')
      if (equals < 0) return failure('invalid_query', 'Expected key=value query parameters')
      const key = decodeURIComponent(pair.slice(0, equals).replace(/\+/g, ' '))
      const value = decodeURIComponent(pair.slice(equals + 1).replace(/\+/g, ' '))
      const allowed = isDay ? ['at', 'remind'] : module === 'web' ? ['url'] : target === 'rss/query' ? ['query']
        : target.startsWith('rss/item/') ? ['article', 'excerpt'] : target.startsWith('rss/digest/') ? ['offset', 'limit'] : []
      if (!allowed.includes(key) || params.has(key)) return failure('invalid_query', `Unexpected or repeated query parameter: ${key}`)
      params.set(key, value)
    }
  }
  if (target === 'rss/query') {
    if (fragment !== undefined) return failure('invalid_fragment', 'Unexpected RSS fragment')
    try { return validateRef({ kind: 'rss-query', query: JSON.parse(params.get('query') || '') }) }
    catch { return failure('invalid_query', 'Invalid RSS query scope') }
  }
  if (module === 'web' || isDay) {
    if (fragment !== undefined) return failure('invalid_fragment', 'This reference does not accept a fragment')
    if (module === 'web') {
      if (path !== '') return failure('invalid_path', 'Expected ready://web?url=...')
      return validateRef({ kind: 'web', url: params.get('url') })
    }
    const value = target.slice('calendar/day'.length).replace(/^\//, '')
    if (value.includes('/')) return failure('invalid_path', 'Expected one date segment')
    const remind = params.get('remind')
    if (remind !== undefined && !/^\d+$/.test(remind)) return failure('invalid_remind', 'Expected nonnegative integer minutes')
    return validateRef({ kind: 'day', date: decodeURIComponent(value),
      ...(params.has('at') ? { at: params.get('at') } : {}),
      ...(remind !== undefined ? { remind: Number(remind) } : {}),
    })
  }
  const route = routes.find(([prefix]) => target === prefix || target.startsWith(`${prefix}/`))
  if (!route) return failure('invalid_path', 'Unknown Ready reference path')
  const [prefix, kind, idField, fragmentField, fragmentPrefix] = route
  const id = target.slice(prefix.length).replace(/^\//, '')
  if (!id) return failure('missing_id', 'Reference ID is required')
  if (id.includes('/')) return failure('invalid_path', 'Encode slashes inside reference IDs')
  const ref: Record<string, unknown> = { kind, [idField]: decodeURIComponent(id) }
  if (kind === 'rss-item') {
    try {
      for (const key of ['article', 'excerpt']) if (params.has(key)) ref[key] = JSON.parse(params.get(key)!)
    } catch { return failure('invalid_query', 'Invalid RSS reading scope') }
  }
  if (kind === 'rss-digest') {
    for (const key of ['offset', 'limit']) {
      const value = params.get(key)
      if (value === undefined || !/^\d+$/.test(value)) return failure('invalid_query', 'Invalid digest scope')
      ref[key] = Number(value)
    }
  }
  if (fragment !== undefined) {
    if (!fragmentField || !fragment.startsWith(fragmentPrefix)) return failure('invalid_fragment', 'Unexpected reference fragment')
    ref[fragmentField] = decodeURIComponent(fragment.slice(fragmentPrefix.length))
  }
  return validateRef(ref)
}

export function isReadyUri(uri: string): boolean {
  return parseReadyUri(uri).ok
}
