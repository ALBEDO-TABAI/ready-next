import type { BrowserHistoryEntry, ChatMessageRecord } from '../database/records'
import { basename } from 'path'

import {
  directoryProjectKey,
  documentProjectKey,
  semanticProjectKey,
  buildProjectTitle,
  chooseDirectoryAnchor,
} from './project-normalizer'
import { fileKindFromPath } from './file-kind'
import type {
  CalendarEventLike,
  FileEmergenceCandidate,
  RecentConversation,
} from './types'

import type { FileActivityEvent, FileReadingSession } from '../../../shared/file-emergence'

const DAY_MS = 24 * 60 * 60 * 1000

const FUTURE_WORDS = /准备|下周|明天|即将|发布|截止|排期|上线|启动|launch|deadline/i
const COMPLETION_WORDS = /完成|结束|复盘|交付|总结|归档|收尾|done|retro|postmortem/i
const IMPORTANT_WORDS = /品牌|合同|提案|数据库|案例|模板|资产|发布|客户|门店|研究|空间|预算|报价/i
const GENERIC_BROWSER_DOMAINS = /(^|\.)google\.|(^|\.)baidu\.|(^|\.)bing\.|(^|\.)search\.|(^|\.)duckduckgo\./i
const LOW_SIGNAL_PHRASE_RE = /^(这份|这个|那个|这些|看一下|继续|帮我|请|新建|打开|保存|已|把|将|给我|需要|今天|明天)?\s*(文件|文档|内容|笔记|资料|任务|工作)?(?:是|为|要|准备|接下来|之后|一下)?\s*$/i

export function candidatesFromActivity(
  events: readonly FileActivityEvent[],
  workspaceRoots: readonly string[],
  now: number,
): FileEmergenceCandidate[] {
  const byKey = new Map<string, FileEmergenceCandidate>()
  const recentCutoff = now - 30 * DAY_MS

  for (const event of events) {
    const anchor = chooseDirectoryAnchor(event.path, workspaceRoots)
    const key = directoryProjectKey(anchor)
    const existing = byKey.get(key)
    const candidate = existing || createCandidate({
      id: key,
      anchorType: 'directory',
      anchorPath: anchor,
      rawLabels: [basename(anchor)],
    })
    candidate.lastOpenOrSaveAt = Math.max(candidate.lastOpenOrSaveAt ?? 0, event.createdAt)
    candidate.fileClusterStrength = Math.min(1, candidate.fileClusterStrength + 0.12)
    candidate.historicalImportanceScore = Math.min(
      1,
      candidate.historicalImportanceScore +
      (event.createdAt < recentCutoff ? 0.12 : 0.05) +
      (IMPORTANT_WORDS.test(event.path) ? 0.18 : 0) +
      (event.meta?.source === 'attention_rollup' ? Math.min(0.7, event.weight * 0.35) : 0),
    )
    if (event.meta?.source === 'attention_rollup') {
      candidate.fileClusterStrength = Math.min(1, candidate.fileClusterStrength + Math.min(0.65, event.weight * 0.3))
    }
    const sourceMultiplier = event.source === 'emergence'
      ? 0.1
      : event.source === 'document_mode'
        ? 0.55
        : event.source === 'document_write'
          ? 0.6
          : 0.42
    if (event.createdAt >= startOfLocalDay(now)) {
      candidate.todayActivityScore = Math.min(1, candidate.todayActivityScore + event.weight * sourceMultiplier)
    }
    if (event.createdAt >= recentCutoff) {
      candidate.recentActivityScore = Math.min(1, candidate.recentActivityScore + event.weight * 0.16)
    }
    candidate.evidence.push({
      source: 'file_activity',
      label: basename(event.path),
      score: event.weight,
      timestamp: event.createdAt,
      ref: event.path,
    })
    candidate.directFiles.push({
      path: event.path,
      name: basename(event.path),
      kind: fileKindFromPath(event.path),
      score: event.weight,
      reason: event.eventType === 'save' ? '最近保存' : '最近打开',
      modifiedAt: event.createdAt,
    })
    byKey.set(key, candidate)
  }

  return Array.from(byKey.values())
}

export function candidatesFromReadingSessions(
  sessions: readonly FileReadingSession[],
  workspaceRoots: readonly string[],
  now: number,
): FileEmergenceCandidate[] {
  const byPath = new Map<string, FileReadingSession[]>()
  for (const session of sessions) {
    if (!isInsideWorkspace(session.path, workspaceRoots)) continue
    const list = byPath.get(session.path) || []
    list.push(session)
    byPath.set(session.path, list)
  }

  const candidates: FileEmergenceCandidate[] = []
  for (const [path, pathSessions] of byPath) {
    const sorted = pathSessions.slice().sort((a, b) => b.endedAt - a.endedAt)
    const latest = sorted[0]
    const todayStart = startOfLocalDay(now)
    const sevenDayCutoff = now - 7 * DAY_MS
    const todayMs = sorted
      .filter((session) => session.endedAt >= todayStart)
      .reduce((sum, session) => sum + Math.max(0, session.activeMs), 0)
    const recentMs = sorted
      .filter((session) => session.endedAt >= sevenDayCutoff)
      .reduce((sum, session) => sum + Math.max(0, session.activeMs), 0)
    const recentDays = new Set(
      sorted
        .filter((session) => session.endedAt >= sevenDayCutoff)
        .map((session) => startOfLocalDay(session.endedAt)),
    )
    const progressRatio = clamp01(Math.max(
      0,
      ...sorted
        .map((session) => session.progressEnd)
        .filter((value): value is number => typeof value === 'number' && Number.isFinite(value)),
    ))
    const daysSinceLastRead = Math.max(0, Math.floor((startOfLocalDay(now) - startOfLocalDay(latest.endedAt)) / DAY_MS))
    const todayReadingMinutes = todayMs / 60_000
    const recentReadingMinutes = recentMs / 60_000
    const durationScore = clamp01(todayReadingMinutes / 60) * 0.6 + clamp01(recentReadingMinutes / 300) * 0.4
    const cadenceScore = daysSinceLastRead <= 1
      ? 0.9
      : daysSinceLastRead <= 4
        ? 0.65
        : daysSinceLastRead <= 7
          ? 0.35
          : 0
    const streakScore = clamp01(recentDays.size / 4)
    const progressScore = progressRatio >= 0.9
      ? 0.75
      : progressRatio >= 0.6
        ? 0.85
        : progressRatio >= 0.25
          ? 0.55
          : 0.2
    const readingContinuityScore = clamp01(
      durationScore * 0.35 +
      Math.max(cadenceScore, streakScore) * 0.3 +
      progressScore * 0.25,
    )
    const title = basenameWithoutExtension(path)
    const candidate = createCandidate({
      id: documentProjectKey(path),
      anchorType: 'document',
      anchorPath: path,
      rawLabels: [title],
    })
    candidate.lastOpenOrSaveAt = latest.endedAt
    candidate.todayActivityScore = todayReadingMinutes >= 5 ? clamp01(todayReadingMinutes / 45) : 0
    candidate.recentActivityScore = clamp01(recentReadingMinutes / 240)
    candidate.historicalImportanceScore = clamp01(recentReadingMinutes / 300 + progressRatio * 0.35 + (IMPORTANT_WORDS.test(path) ? 0.2 : 0))
    candidate.fileClusterStrength = Math.min(1, sorted.length * 0.08)
    candidate.readingContinuityScore = readingContinuityScore
    candidate.readingDaysSinceLastRead = daysSinceLastRead
    candidate.readingProgressRatio = progressRatio
    candidate.todayReadingMinutes = todayReadingMinutes
    candidate.recentReadingMinutes = recentReadingMinutes
    candidate.evidence.push({
      source: 'reading_session',
      label: readingSessionLabel({ todayReadingMinutes, recentReadingMinutes, daysSinceLastRead, progressRatio }),
      score: readingContinuityScore,
      timestamp: latest.endedAt,
      ref: path,
    })
    candidate.directFiles.push({
      path,
      name: basename(path),
      kind: fileKindFromPath(path),
      score: Math.max(0.45, readingContinuityScore),
      reason: daysSinceLastRead <= 1 ? '最近持续阅读' : `最近读到 ${Math.round(progressRatio * 100)}%`,
      modifiedAt: latest.endedAt,
    })
    candidates.push(candidate)
  }
  return candidates
}

export function candidatesFromCalendar(events: readonly CalendarEventLike[], now: number): FileEmergenceCandidate[] {
  const candidates: FileEmergenceCandidate[] = []
  for (const event of events) {
    const title = cleanLabel([event.title, event.location, event.description].filter(Boolean).join(' '))
    if (!title || isLowSignalPhrase(title)) continue
    const timestamp = event.start_time * 1000
    const key = semanticProjectKey(title)
    const candidate = createCandidate({
      id: key,
      anchorType: 'semantic',
      rawLabels: [title],
    })
    candidate.upcomingCalendarAt = timestamp >= now ? timestamp : null
    candidate.recentActivityScore = timestamp < now && timestamp >= now - 30 * DAY_MS ? 0.35 : 0
    candidate.todayActivityScore = isSameLocalDay(timestamp, now) ? 0.9 : 0
    candidate.completionIntentScore = timestamp < now && timestamp >= now - 30 * DAY_MS ? 0.4 : 0
    candidate.agentIntentScore = FUTURE_WORDS.test(title) ? 0.4 : 0
    candidate.evidence.push({
      source: 'calendar',
      label: title,
      score: timestamp >= now ? 1 : 0.65,
      timestamp,
      ref: event.id,
    })
    candidates.push(candidate)
  }
  return candidates
}

export function candidatesFromConversations(
  conversations: readonly RecentConversation[],
  messagesByConversation: ReadonlyMap<string, readonly ChatMessageRecord[]>,
  now: number,
): FileEmergenceCandidate[] {
  const candidates: FileEmergenceCandidate[] = []
  for (const conversation of conversations) {
    const recentMessages = messagesByConversation.get(conversation.id) || []
    const text = [
      conversation.title,
      ...recentMessages
        .filter((message) => message.role === 'user')
        .slice(-6)
        .map((message) => message.content),
    ].join('\n')
    const fallbackTitle = cleanLabel(conversation.title)
    const title = firstProjectPhrase(text) || (isLowSignalPhrase(fallbackTitle) ? null : fallbackTitle)
    if (!title) continue
    const updatedAt = Date.parse(conversation.updatedAt)
    const timestamp = Number.isFinite(updatedAt) ? updatedAt : now
    const candidate = createCandidate({
      id: semanticProjectKey(title),
      anchorType: 'semantic',
      rawLabels: [title, conversation.title].filter(Boolean),
    })
    candidate.agentIntentScore = FUTURE_WORDS.test(text) ? 0.75 : 0.35
    candidate.completionIntentScore = COMPLETION_WORDS.test(text) ? 0.7 : 0
    candidate.todayActivityScore = isSameLocalDay(timestamp, now) ? 0.55 : 0
    candidate.recentActivityScore = timestamp >= now - 30 * DAY_MS ? 0.45 : 0
    candidate.historicalImportanceScore = IMPORTANT_WORDS.test(text) ? 0.35 : 0.12
    candidate.evidence.push({
      source: 'agent',
      label: title,
      score: candidate.agentIntentScore || 0.35,
      timestamp,
      ref: conversation.id,
    })
    candidates.push(candidate)
  }
  return candidates
}

export function candidatesFromBrowserHistory(history: readonly BrowserHistoryEntry[], now: number): FileEmergenceCandidate[] {
  const candidates: FileEmergenceCandidate[] = []
  const byDomain = new Map<string, BrowserHistoryEntry[]>()
  for (const item of history) {
    if (!item.title && !item.url) continue
    if (GENERIC_BROWSER_DOMAINS.test(item.domain || item.url)) continue
    const list = byDomain.get(item.domain) || []
    list.push(item)
    byDomain.set(item.domain, list)
  }

  for (const entries of byDomain.values()) {
    const first = entries[0]
    const fallbackTitle = cleanLabel(first.title || first.domain)
    const title = firstProjectPhrase(first.title || first.url) || (isLowSignalPhrase(fallbackTitle) ? null : fallbackTitle)
    if (!title) continue
    const timestamp = secondsToMs(first.visited_at || first.last_visit_time)
    const visitScore = Math.min(0.65, entries.length * 0.12)
    const candidate = createCandidate({
      id: semanticProjectKey(title),
      anchorType: 'semantic',
      rawLabels: [title, first.domain].filter(Boolean),
    })
    candidate.browserIntentScore = FUTURE_WORDS.test(`${first.title} ${first.url}`) ? 0.6 : visitScore
    candidate.todayActivityScore = isSameLocalDay(timestamp, now) ? 0.35 : 0
    candidate.recentActivityScore = timestamp >= now - 30 * DAY_MS ? 0.25 : 0
    candidate.historicalImportanceScore = IMPORTANT_WORDS.test(`${first.title} ${first.url}`) ? 0.25 : 0.08
    candidate.evidence.push({
      source: 'browser_history',
      label: title,
      score: candidate.browserIntentScore,
      timestamp,
      ref: first.url,
    })
    candidates.push(candidate)
  }
  return candidates
}

export function mergeCandidates(candidates: readonly FileEmergenceCandidate[]): FileEmergenceCandidate[] {
  const merged = new Map<string, FileEmergenceCandidate>()
  for (const candidate of candidates) {
    const existing = merged.get(candidate.id)
    if (!existing) {
      merged.set(candidate.id, { ...candidate, rawLabels: [...candidate.rawLabels], evidence: [...candidate.evidence], directFiles: [...candidate.directFiles] })
      continue
    }
    mergeInto(existing, candidate)
  }
  return Array.from(merged.values()).map((candidate) => {
    const title = buildProjectTitle({
      rawLabels: candidate.rawLabels,
      evidence: candidate.evidence,
      anchorPath: candidate.anchorPath,
    })
    candidate.rawLabels = unique(candidate.rawLabels)
    if (!candidate.rawLabels.includes(title.title)) candidate.rawLabels.unshift(title.title)
    return candidate
  })
}

export function mergeInto(target: FileEmergenceCandidate, source: FileEmergenceCandidate): void {
  target.rawLabels = unique([...target.rawLabels, ...source.rawLabels])
  target.evidence.push(...source.evidence)
  target.directFiles.push(...source.directFiles)
  target.lastOpenOrSaveAt = maxNullable(target.lastOpenOrSaveAt, source.lastOpenOrSaveAt)
  target.upcomingCalendarAt = minNullableFuture(target.upcomingCalendarAt, source.upcomingCalendarAt)
  target.todayActivityScore = Math.max(target.todayActivityScore, source.todayActivityScore)
  target.recentActivityScore = Math.max(target.recentActivityScore, source.recentActivityScore)
  target.historicalImportanceScore = Math.max(target.historicalImportanceScore, source.historicalImportanceScore)
  target.fileClusterStrength = Math.max(target.fileClusterStrength, source.fileClusterStrength)
  target.agentIntentScore = Math.max(target.agentIntentScore, source.agentIntentScore)
  target.browserIntentScore = Math.max(target.browserIntentScore, source.browserIntentScore)
  target.completionIntentScore = Math.max(target.completionIntentScore, source.completionIntentScore)
  target.readingContinuityScore = Math.max(target.readingContinuityScore, source.readingContinuityScore)
  target.readingDaysSinceLastRead = minNullable(target.readingDaysSinceLastRead, source.readingDaysSinceLastRead)
  target.readingProgressRatio = Math.max(target.readingProgressRatio ?? 0, source.readingProgressRatio ?? 0)
  target.todayReadingMinutes = Math.max(target.todayReadingMinutes, source.todayReadingMinutes)
  target.recentReadingMinutes = Math.max(target.recentReadingMinutes, source.recentReadingMinutes)
}

function createCandidate(input: {
  id: string
  anchorType: FileEmergenceCandidate['anchorType']
  anchorPath?: string | null
  rawLabels: string[]
}): FileEmergenceCandidate {
  return {
    id: input.id,
    anchorType: input.anchorType,
    anchorPath: input.anchorPath ?? null,
    rawLabels: input.rawLabels,
    evidence: [],
    directFiles: [],
    lastOpenOrSaveAt: null,
    upcomingCalendarAt: null,
    todayActivityScore: 0,
    recentActivityScore: 0,
    historicalImportanceScore: 0,
    fileClusterStrength: 0,
    agentIntentScore: 0,
    browserIntentScore: 0,
    completionIntentScore: 0,
    readingContinuityScore: 0,
    readingDaysSinceLastRead: null,
    readingProgressRatio: null,
    todayReadingMinutes: 0,
    recentReadingMinutes: 0,
  }
}

function firstProjectPhrase(text: string): string | null {
  const cleaned = cleanLabel(text)
  if (!cleaned) return null
  const projectMatch = cleaned.match(/([\p{L}\p{N}][\p{L}\p{N}\s_-]{1,28}(?:项目|提案|发布|复盘|计划|方案|数据库|门店|品牌|案例|资产|研究|预算|合同))/u)
  if (projectMatch) return projectMatch[1].trim()
  const firstSentence = cleaned.split(/\n|[。！？!?]/)[0]?.slice(0, 28).trim() || null
  return isLowSignalPhrase(firstSentence) ? null : firstSentence
}

function cleanLabel(value: string): string {
  return value
    .replace(/@\[([^\]]+)\]/g, ' ')
    .replace(/\[[^\]]+\]\([^)]+\)/g, ' ')
    .replace(/`[^`]+`/g, ' ')
    .replace(/(?:^|\s)[~/./\w-]*[/\\][^\s]+/g, ' ')
    .replace(/https?:\/\/\S+/g, '')
    .replace(/\b[\w.-]+\.(?:md|txt|docx?|pdf|xlsx?|pptx?|png|jpe?g|webp|gif)\b/gi, ' ')
    .replace(/[“”‘’]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 80)
}

function isLowSignalPhrase(value: string | null): boolean {
  if (!value) return true
  const compact = value.replace(/\s+/g, '')
  if (compact.length < 4) return true
  if (/^\d+$/.test(compact)) return true
  if (LOW_SIGNAL_PHRASE_RE.test(compact)) return true
  if (/^(这份|这个|那个|这些)(文件|文档|内容|笔记|资料)/.test(compact)) return true
  if (/^(看一下|继续|帮我|请|新建|打开|保存|把|给我)/.test(compact)) return true
  return false
}

function startOfLocalDay(timestamp: number): number {
  const date = new Date(timestamp)
  date.setHours(0, 0, 0, 0)
  return date.getTime()
}

function isSameLocalDay(a: number, b: number): boolean {
  return startOfLocalDay(a) === startOfLocalDay(b)
}

function secondsToMs(value: number): number {
  return value > 10_000_000_000 ? value : value * 1000
}

function isInsideWorkspace(path: string, workspaceRoots: readonly string[]): boolean {
  return workspaceRoots.some((root) => path === root || path.startsWith(`${root}/`))
}

function basenameWithoutExtension(path: string): string {
  const name = basename(path)
  const ext = name.includes('.') ? name.split('.').pop() || '' : ''
  if (!ext || ext.length > 8) return name
  return name.slice(0, -(ext.length + 1)) || name
}

function readingSessionLabel(input: {
  todayReadingMinutes: number
  recentReadingMinutes: number
  daysSinceLastRead: number
  progressRatio: number
}): string {
  if (input.todayReadingMinutes >= 1) return `今天阅读 ${Math.round(input.todayReadingMinutes)} 分钟`
  if (input.daysSinceLastRead <= 4) {
    return `最近读了很多，已停 ${input.daysSinceLastRead} 天`
  }
  if (input.progressRatio > 0) return `阅读进度 ${Math.round(input.progressRatio * 100)}%`
  return `近 7 天阅读 ${Math.round(input.recentReadingMinutes)} 分钟`
}

function maxNullable(a?: number | null, b?: number | null): number | null {
  if (a == null) return b ?? null
  if (b == null) return a
  return Math.max(a, b)
}

function minNullableFuture(a?: number | null, b?: number | null): number | null {
  if (a == null) return b ?? null
  if (b == null) return a
  return Math.min(a, b)
}

function minNullable(a?: number | null, b?: number | null): number | null {
  if (a == null) return b ?? null
  if (b == null) return a
  return Math.min(a, b)
}

function unique(values: readonly string[]): string[] {
  return Array.from(new Set(values.map((value) => value.trim()).filter(Boolean)))
}

function clamp01(value: number): number {
  if (!Number.isFinite(value)) return 0
  return Math.max(0, Math.min(1, value))
}
