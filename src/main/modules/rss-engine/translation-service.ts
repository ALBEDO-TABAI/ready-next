import { randomUUID } from 'node:crypto'
import { fromMarkdown } from 'mdast-util-from-markdown'
import { gfmFromMarkdown } from 'mdast-util-gfm'
import { gfm } from 'micromark-extension-gfm'
import type { RootContent } from 'mdast'
import type { RSSArticle } from '../../../shared/rss-workspace'
import {
  rssTranslationLanguageName, RSSTranslateArticleSchema,
  type RSSArticleTranslation, type RSSTranslateArticleInput, type RSSTranslationBlock, type RSSTranslationLanguage,
} from '../../../shared/rss-translation'
import type { RSSTranslationStore } from '../database/rss-translation-store'

const BATCH_CHARACTERS = 3_000
const BATCH_BLOCKS = 30
const PARALLEL_BATCHES = 2
const MAX_BODY_CHARACTERS = 200_000
const TRANSLATABLE = new Set(['paragraph', 'heading', 'list', 'blockquote', 'table'])

function hasText(node: RootContent): boolean {
  if (node.type === 'text' || node.type === 'inlineCode') return node.value.trim().length > 0
  return 'children' in node && (node.children as RootContent[]).some(hasText)
}

/** Translatable top-level blocks of a body, by character range; code, HTML, rules and bare pictures stay as written. */
export function segmentRSSTranslationBlocks(markdown: string): RSSTranslationBlock[] {
  const root = fromMarkdown(markdown, { extensions: [gfm()], mdastExtensions: [gfmFromMarkdown()] })
  return root.children.flatMap((node) => {
    const start = node.position?.start.offset
    const end = node.position?.end.offset
    if (start === undefined || end === undefined || !TRANSLATABLE.has(node.type) || !hasText(node)) return []
    return [{ start, end, state: 'pending' as const, markdown: null }]
  })
}

export function batchRSSTranslationBlocks(blocks: readonly RSSTranslationBlock[]): number[][] {
  const batches: number[][] = []
  let current: number[] = [], characters = 0
  blocks.forEach((block, index) => {
    if (block.state !== 'pending') return
    const size = block.end - block.start
    if (current.length && (characters + size > BATCH_CHARACTERS || current.length >= BATCH_BLOCKS)) {
      batches.push(current)
      current = []
      characters = 0
    }
    current.push(index)
    characters += size
  })
  if (current.length) batches.push(current)
  return batches
}

export function rssTranslationInstructions(target: RSSTranslationLanguage): string {
  const name = rssTranslationLanguageName(target)
  return [
    `You translate the blocks of one article into ${name}.`,
    'Input is JSON {"target": string, "blocks": [{"id": number, "markdown": string}]}.',
    'Reply with JSON only: {"blocks": [{"id": number, "markdown": string}]}, one entry for every input id and nothing else.',
    'Translate each block faithfully and fluently. Keep its Markdown structure: heading markers, list markers and numbering, quote markers, table pipes and alignment rows, emphasis.',
    'Keep every URL, image reference and `inline code` exactly as written; translate only link text and image alt text.',
    `Do not merge, split, summarize or annotate blocks. A block already in ${name} comes back unchanged.`,
  ].join('\n')
}

/** The model's reply, by id; anything that is not the promised JSON yields no translations. */
export function parseRSSTranslationReply(reply: string): Map<number, string> {
  const text = reply.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '')
  const translations = new Map<number, string>()
  try {
    const parsed = JSON.parse(text.slice(text.indexOf('{'), text.lastIndexOf('}') + 1)) as { blocks?: unknown }
    if (!Array.isArray(parsed.blocks)) return translations
    for (const entry of parsed.blocks) {
      if (!entry || typeof entry !== 'object') continue
      const { id, markdown } = entry as { id?: unknown; markdown?: unknown }
      if (Number.isInteger(id) && typeof markdown === 'string' && !translations.has(id as number)) translations.set(id as number, markdown)
    }
  } catch {
    return new Map()
  }
  return translations
}

/** A translation keeps what readers follow and code copies: link and picture targets, inline code, heading level. */
export function keepsRSSBlockInvariants(source: string, translation: string): boolean {
  if (!translation.trim()) return false
  for (const match of source.matchAll(/\]\(\s*<?([^)\s>]+)/g)) if (!translation.includes(match[1])) return false
  for (const match of source.matchAll(/`([^`\n]+)`/g)) if (!translation.includes(`\`${match[1]}\``)) return false
  const heading = source.match(/^(#{1,6})\s/)?.[1]
  return !heading || translation.trimStart().startsWith(`${heading} `)
}

export interface RSSTranslationServiceDeps {
  store: RSSTranslationStore
  getArticle(itemId: string): RSSArticle | null
  /** Throws a reader-facing reason when no usable model is configured. */
  assertModelReady(): void
  complete(request: { system: string; user: string; maxTokens: number; signal: AbortSignal; runId: string }): Promise<string>
  notify(itemId: string, targetLang: RSSTranslationLanguage): void
}

/** Translation is an explicit reader action; jobs run in Main and outlive the reader that started them. */
export class RSSTranslationService {
  private readonly running = new Map<string, { controller: AbortController; promise: Promise<void> }>()
  private stopped = false

  constructor(private readonly deps: RSSTranslationServiceDeps) {
    deps.store.recoverInterrupted()
  }

  read(itemId: string, targetLang: RSSTranslationLanguage): RSSArticleTranslation | null {
    return this.deps.store.get(itemId, targetLang)
  }

  translate(input: RSSTranslateArticleInput): RSSArticleTranslation {
    if (this.stopped) throw new Error('RSS translation service stopped')
    const { itemId, targetLang, retryUntranslated } = RSSTranslateArticleSchema.parse(input)
    const key = `${itemId}\u0000${targetLang}`
    const existing = this.deps.store.get(itemId, targetLang)
    if (this.running.has(key) && existing) return existing
    const article = this.deps.getArticle(itemId)
    const markdown = article?.body.markdown
    const bodyRevision = article?.body.revision
    if (!article || !markdown || !bodyRevision || !['ready', 'partial'].includes(article.body.status)) {
      throw new Error('请先获取正文，再翻译这篇文章。')
    }
    if (markdown.length > MAX_BODY_CHARACTERS) throw new Error('这篇文章太长，暂不支持整篇翻译。')
    const current = existing?.bodyRevision === bodyRevision ? existing : null
    if (current?.status === 'completed' || (current && !retryUntranslated && current.status !== 'cancelled')) return current
    const blocks = current
      ? current.blocks.map((block) => block.state === 'translated' ? block : { ...block, state: 'pending' as const, markdown: null })
      : segmentRSSTranslationBlocks(markdown)
    if (blocks.length === 0) throw new Error('正文里没有可翻译的文字。')
    this.deps.assertModelReady()
    const requestId = randomUUID()
    this.deps.store.begin({ itemId, targetLang, bodyRevision, requestId, blocks })
    const controller = new AbortController()
    const promise = this.run({ itemId, targetLang, requestId, markdown, blocks, signal: controller.signal })
      .finally(() => { if (this.running.get(key)?.controller === controller) this.running.delete(key) })
    this.running.set(key, { controller, promise })
    return this.deps.store.get(itemId, targetLang)!
  }

  cancel(itemId: string, targetLang: RSSTranslationLanguage): void {
    this.running.get(`${itemId}\u0000${targetLang}`)?.controller.abort()
  }

  async stop(): Promise<void> {
    this.stopped = true
    const pending = [...this.running.values()]
    for (const entry of pending) entry.controller.abort()
    await Promise.allSettled(pending.map((entry) => entry.promise))
  }

  private async run(job: {
    itemId: string; targetLang: RSSTranslationLanguage; requestId: string; markdown: string
    blocks: RSSTranslationBlock[]; signal: AbortSignal
  }): Promise<void> {
    const batches = batchRSSTranslationBlocks(job.blocks)
    const system = rssTranslationInstructions(job.targetLang)
    let firstError: string | null = null
    let next = 0
    const worker = async () => {
      while (next < batches.length && !job.signal.aborted) {
        const batch = batches[next++]
        const sources = batch.map((index) => job.markdown.slice(job.blocks[index].start, job.blocks[index].end))
        let replies = new Map<number, string>()
        try {
          replies = parseRSSTranslationReply(await this.deps.complete({
            system,
            user: JSON.stringify({ target: rssTranslationLanguageName(job.targetLang), blocks: sources.map((markdown, id) => ({ id, markdown })) }),
            maxTokens: 4_096,
            signal: job.signal,
            runId: job.requestId,
          }))
        } catch (error) {
          if (job.signal.aborted) return
          firstError ??= error instanceof Error ? error.message : String(error)
        }
        batch.forEach((index, id) => {
          const translation = replies.get(id)
          job.blocks[index] = translation !== undefined && keepsRSSBlockInvariants(sources[id], translation)
            ? { ...job.blocks[index], state: 'translated', markdown: translation.trim() }
            : { ...job.blocks[index], state: 'untranslated', markdown: null }
        })
        // A replaced or deleted translation is no longer this job's; it stops without writing.
        if (!this.deps.store.progress(job.itemId, job.targetLang, job.requestId, job.blocks)) return
        this.deps.notify(job.itemId, job.targetLang)
      }
    }
    await Promise.all(Array.from({ length: Math.min(PARALLEL_BATCHES, batches.length) }, worker))
    const translated = job.blocks.filter((block) => block.state === 'translated').length
    const status = job.signal.aborted ? 'cancelled'
      : translated === job.blocks.length ? 'completed'
        : translated === 0 ? 'failed' : 'partial'
    const error = status === 'completed' || status === 'cancelled' ? null
      : firstError ?? '部分段落没有通过译文校验，已保留原文。'
    if (this.deps.store.finish(job.itemId, job.targetLang, job.requestId, status, error)) this.deps.notify(job.itemId, job.targetLang)
  }
}
