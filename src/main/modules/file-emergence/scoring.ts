import type {
  FileEmergenceBucket,
  FileEmergenceEvidence,
  FileEmergenceProject,
} from '../../../shared/file-emergence'

const DAY_MS = 24 * 60 * 60 * 1000

export function computeAttentionInvestmentScore(input:{activeDays:number;saveCount:number;readingMs:number;markCount:number}):number{
  return clamp01(input.activeDays/8+input.saveCount/10+input.readingMs/7_200_000+input.markCount/5)
}

export interface ProjectScoreInput {
  anchorType: 'directory' | 'semantic' | 'document'
  hasLinkedFiles: boolean
  evidence: FileEmergenceEvidence[]
  now: number
  lastOpenOrSaveAt?: number | null
  upcomingCalendarAt?: number | null
  todayActivityScore?: number
  recentActivityScore?: number
  historicalImportanceScore?: number
  fileClusterStrength?: number
  agentIntentScore?: number
  browserIntentScore?: number
  completionIntentScore?: number
  readingContinuityScore?: number
  readingDaysSinceLastRead?: number | null
  readingProgressRatio?: number | null
  todayReadingMinutes?: number
  recentReadingMinutes?: number
  activeIntentScore?: number
  activeDays90?: number
  totalInvestmentScore?: number
  surfacedRecently?: boolean
  controlledTagStates?: readonly string[]
}

export interface BucketScore {
  bucket: FileEmergenceBucket
  score: number
  status: NonNullable<FileEmergenceProject['status']>
}

export interface ProjectScoreResult {
  bucketScores: BucketScore[]
  assignedBucket: FileEmergenceBucket | null
  assignedScore: number
  confidence: FileEmergenceProject['confidence'] | null
  confidenceRaw: number
  visible: boolean
}

export function scoreProject(input: ProjectScoreInput): ProjectScoreResult {
  if (input.controlledTagStates?.includes('已归档')) {
    return { bucketScores: [], assignedBucket: null, assignedScore: 0, confidence: null, confidenceRaw: 0, visible: false }
  }
  const bucketScores = qualifyBuckets(input).sort((a, b) => b.score - a.score)
  const assigned = chooseBucket(bucketScores)
  const assignedScore = assigned?.score ?? 0
  const confidenceRaw = computeConfidenceRaw(input, assignedScore)
  const confidence =
    confidenceRaw >= 0.75 ? 'high' :
      confidenceRaw >= 0.5 ? 'medium' :
        confidenceRaw >= 0.35 ? 'low' : null

  return {
    bucketScores,
    assignedBucket: assigned?.bucket ?? null,
    assignedScore,
    confidence,
    confidenceRaw,
    visible: !!assigned && (confidence === 'medium' || confidence === 'high'),
  }
}

export function qualifyBuckets(input: ProjectScoreInput): BucketScore[] {
  const scores: BucketScore[] = []
  const todayStart = startOfLocalDay(input.now)
  const todayEnd = todayStart + DAY_MS
  const lastActivity = input.lastOpenOrSaveAt ?? null
  const calendarToday =
    input.upcomingCalendarAt !== null &&
    input.upcomingCalendarAt !== undefined &&
    input.upcomingCalendarAt >= todayStart &&
    input.upcomingCalendarAt < todayEnd

  const selected = input.controlledTagStates?.includes('精选') === true
  const read = input.controlledTagStates?.includes('已精读') === true
  const needsOrganizing = input.controlledTagStates?.includes('待整理') === true
  const effectiveReadingContinuity = (input.readingContinuityScore ?? 0) * (read ? 0.35 : 1)
  const readingToday = (input.todayReadingMinutes ?? 0) >= 5 ||
    (effectiveReadingContinuity >= 0.45 && (input.readingDaysSinceLastRead ?? Infinity) <= 1)
  const meaningfulTodayActivity = (input.todayActivityScore ?? 0) > 0.35

  if (calendarToday || meaningfulTodayActivity || readingToday) {
    scores.push({
      bucket: 'today',
      score: clamp01(
        (calendarToday ? 0.35 : 0) +
        (input.todayActivityScore ?? 0) * 0.3 +
        effectiveReadingContinuity * 0.32 +
        (input.agentIntentScore ?? 0) * 0.2 +
        (input.browserIntentScore ?? 0) * 0.1 +
        crossSourceBonus(input.evidence) * 0.05,
      ),
      status: 'active',
    })
  }

  const upcoming = input.upcomingCalendarAt
  const daysSinceLastRead = input.readingDaysSinceLastRead ?? null
  const readingContinuationFuture =
    daysSinceLastRead !== null &&
    daysSinceLastRead >= 2 &&
    daysSinceLastRead <= 4 &&
    effectiveReadingContinuity >= 0.45 &&
    (input.readingProgressRatio ?? 0) >= 0.35

  if (
    upcoming !== null &&
    upcoming !== undefined &&
    upcoming >= todayEnd &&
    upcoming <= input.now + 365 * DAY_MS
  ) {
    const daysAway = Math.max(0, (upcoming - input.now) / DAY_MS)
    const upcomingCalendarScore = Math.exp(-daysAway / 120)
    scores.push({
      bucket: 'future',
      score: clamp01(
        upcomingCalendarScore * 0.55 +
        (input.recentActivityScore ?? 0) * 0.2 +
        (input.agentIntentScore ?? 0) * 0.15 +
        (input.browserIntentScore ?? 0) * 0.05 +
        crossSourceBonus(input.evidence) * 0.05,
      ),
      status: 'upcoming',
    })
  }

  const explicitIntent = (input.activeIntentScore ?? 0) >= 0.6
  const highInvestmentPause = (input.activeDays90 ?? 0) >= 3 && (input.totalInvestmentScore ?? 0) >= 0.55 &&
    lastActivity !== null && lastActivity < todayStart && lastActivity >= input.now - 21 * DAY_MS
  if (explicitIntent || highInvestmentPause) {
    scores.push({
      bucket: 'future',
      score: clamp01((input.activeIntentScore ?? 0) * 0.7 + (input.totalInvestmentScore ?? 0) * 0.45 + 0.15),
      status: 'upcoming',
    })
  }

  const recentInvestment = lastActivity !== null && lastActivity >= input.now - 21 * DAY_MS &&
    ((input.activeDays90 ?? 0) >= 2 || (input.totalInvestmentScore ?? 0) >= 0.35)
  if (needsOrganizing && recentInvestment) {
    scores.push({
      bucket: 'future',
      score: clamp01(0.35 + (input.totalInvestmentScore ?? 0) * 0.45 + (input.recentActivityScore ?? 0) * 0.2),
      status: 'upcoming',
    })
  }

  if (readingContinuationFuture) {
    scores.push({
      bucket: 'future',
      score: clamp01(
        effectiveReadingContinuity * 0.65 +
        (input.recentReadingMinutes ?? 0) / 300 * 0.2 +
        (input.readingProgressRatio ?? 0) * 0.15,
      ),
      status: 'continuation',
    })
  }

  const recentCutoff = input.now - 30 * DAY_MS
  const recentlyEndedCalendarAt = input.evidence
    .filter((item) => item.source === 'calendar' && item.timestamp != null)
    .map((item) => item.timestamp as number)
    .filter((timestamp) => timestamp >= recentCutoff && timestamp < todayStart)
    .sort((a, b) => b - a)[0] ?? null
  if (
    ((lastActivity !== null && lastActivity >= recentCutoff && lastActivity < todayStart) ||
      recentlyEndedCalendarAt !== null) &&
    ((input.completionIntentScore ?? 0) > 0 || (input.recentActivityScore ?? 0) > 0.2)
  ) {
    scores.push({
      bucket: 'past',
      score: clamp01(
        (input.recentActivityScore ?? 0) * 0.25 +
        (input.completionIntentScore ?? 0) * 0.2 +
        (input.browserIntentScore ?? 0) * 0.1 +
        crossSourceBonus(input.evidence) * 0.1 +
        0.25,
      ),
      status: 'recently_finished',
    })
  }

  const historicalImportance = input.historicalImportanceScore ?? 0
  const dormant = lastActivity === null || lastActivity < recentCutoff
  const readingDormantImportance =
    (input.readingDaysSinceLastRead ?? 0) >= 30 &&
    (input.readingProgressRatio ?? 0) >= 0.6 &&
    historicalImportance >= 0.45
  const valueFactCount = [
    (input.activeDays90 ?? 0) >= 2,
    (input.totalInvestmentScore ?? 0) >= 0.5,
    historicalImportance >= 0.5 || selected,
    (input.fileClusterStrength ?? 0) >= 0.5,
  ].filter(Boolean).length
  const dormantDays = lastActivity === null ? Infinity : (input.now - lastActivity) / DAY_MS
  if (!input.surfacedRecently && dormantDays >= 31 && dormantDays <= 365 && valueFactCount >= 2 && ((dormant && (historicalImportance >= 0.5 || selected)) || readingDormantImportance)) {
    const dormantAgeScore = lastActivity === null
      ? 0.6
      : clamp01((input.now - lastActivity - 30 * DAY_MS) / (180 * DAY_MS))
    scores.push({
      bucket: 'distant',
      score: clamp01(
        Math.max(historicalImportance, selected ? 0.65 : 0) * 0.4 +
        dormantAgeScore * 0.25 +
        (input.fileClusterStrength ?? 0) * 0.2 +
        crossSourceBonus(input.evidence) * 0.1,
      ),
      status: 'dormant_important',
    })
  }

  return scores
}

export function chooseBucket(scores: readonly BucketScore[]): BucketScore | null {
  const byBucket = new Map(scores.map((score) => [score.bucket, score]))
  return byBucket.get('today') ||
    byBucket.get('future') ||
    byBucket.get('past') ||
    byBucket.get('distant') ||
    null
}

export function computeConfidenceRaw(input: ProjectScoreInput, normalizedScore: number): number {
  const sourceCount = new Set(input.evidence.map((item) => item.source)).size
  const anchorConfidence =
    (input.anchorType === 'directory' || input.anchorType === 'document') && input.hasLinkedFiles ? 0.35 :
      input.anchorType === 'semantic' && input.hasLinkedFiles ? 0.2 :
        0.1
  return clamp01(anchorConfidence + Math.min(sourceCount, 3) * 0.15 + clamp01(normalizedScore) * 0.35)
}

export function startOfLocalDay(timestamp: number): number {
  const date = new Date(timestamp)
  date.setHours(0, 0, 0, 0)
  return date.getTime()
}

function crossSourceBonus(evidence: readonly FileEmergenceEvidence[]): number {
  return clamp01(new Set(evidence.map((item) => item.source)).size / 3)
}

function clamp01(value: number): number {
  if (!Number.isFinite(value)) return 0
  return Math.max(0, Math.min(1, value))
}
