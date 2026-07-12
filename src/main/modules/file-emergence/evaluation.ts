import { computeAttentionInvestmentScore } from './scoring'
const DAY_MS = 86_400_000

export interface EmergenceReplayEvent { projectKey: string; at: number; kind?:'open'|'save'|'read';activeMs?:number }
export interface EmergencePrediction { snapshotId: string; projectKey: string; fileKeys?:string[];bucket: string; rank: number; generatedAt: number;reasonCodes?:string[];machineName?:boolean }
export interface EmergenceGeneration {snapshotId:string;generatedAt:number;visibleCount:number;machineNameCount:number;rejectionReasons:Record<string,number>}

export interface EmergenceEvaluationReport {
  generatedAt: number
  prelaunchReplay: {
    kind: 'prelaunch_event_replay'
    optimizedModel:'production_attention_subset'
    windowCount: number
    baselineTop1HitRate: number
    optimizedTop1HitRate: number
    improvement: number
    leakageSafe: true
  }
  postlaunchOutcomes: {
    kind: 'postlaunch_prediction_outcomes'
    available: boolean
    snapshotCount: number
    top1NextUseHitRate: number | null
    futureSevenDayHitRate: number | null
    futureSevenDayFalsePositiveRate: number | null
    distantThirtyDayReuseRate: number | null
    bucketCoverage: string[]
    reasonCodeDistribution:Record<string,number>
    rejectionReasonDistribution:Record<string,number>
    machineNameRate:number|null
    feedbackCounts: Record<string, number>
  }
}

export function rankReplayCandidates(events: readonly EmergenceReplayEvent[], cutoff: number): string[] {
  const history = events.filter((event) => event.at <= cutoff)
  const byProject = new Map<string, EmergenceReplayEvent[]>()
  for (const event of history) byProject.set(event.projectKey, [...(byProject.get(event.projectKey) || []), event])
  return [...byProject].map(([projectKey, rows]) => {
    const times=rows.map((row)=>row.at)
    const activeDays = new Set(times.map((at) => Math.floor(at / DAY_MS))).size
    const score=computeAttentionInvestmentScore({activeDays,saveCount:rows.filter((row)=>row.kind==='save').length,readingMs:rows.filter((row)=>row.kind==='read').reduce((sum,row)=>sum+(row.activeMs??0),0),markCount:0})
    return { projectKey, score,activeDays,lastAt:Math.max(...times) }
  }).filter((row)=>row.activeDays>=3&&row.score>=.55&&row.lastAt>=cutoff-21*DAY_MS)
    .sort((a, b) => b.score - a.score || b.lastAt-a.lastAt || a.projectKey.localeCompare(b.projectKey)).map((row) => row.projectKey)
}

export function evaluateEmergence(input: {
  events: readonly EmergenceReplayEvent[]
  predictions: readonly EmergencePrediction[]
  generations?:readonly EmergenceGeneration[]
  feedbackCounts?: Record<string, number>
  cutoffs: readonly number[]
  now: number
}): EmergenceEvaluationReport {
  let baselineHits = 0
  let optimizedHits = 0
  let evaluatedWindows = 0
  for (const cutoff of input.cutoffs) {
    const history = input.events.filter((event) => event.at <= cutoff)
    const outcome = new Set(input.events.filter((event) => event.at > cutoff && event.at <= cutoff + 7 * DAY_MS).map((event) => event.projectKey))
    if (!history.length || !outcome.size) continue
    evaluatedWindows += 1
    const latest = new Map<string, number>()
    for (const event of history) latest.set(event.projectKey, Math.max(latest.get(event.projectKey) || 0, event.at))
    const baseline = [...latest].sort((a, b) => b[1] - a[1])[0]?.[0]
    const optimized = rankReplayCandidates(history, cutoff)[0]
    if (baseline && outcome.has(baseline)) baselineHits += 1
    if (optimized && outcome.has(optimized)) optimizedHits += 1
  }
  const baselineTop1HitRate = ratio(baselineHits, evaluatedWindows)
  const optimizedTop1HitRate = ratio(optimizedHits, evaluatedWindows)

  const snapshots = new Map<string, EmergencePrediction[]>()
  for (const prediction of input.predictions) snapshots.set(prediction.snapshotId, [...(snapshots.get(prediction.snapshotId) || []), prediction])
  let nextHits = 0
  let futureHits = 0;let futureTotal=0
  let distantHits = 0;let distantTotal=0
  let outcomeSnapshots = 0
  const buckets = new Set<string>()
  const reasonCodeDistribution:Record<string,number>={}
  const sortedEvents=[...input.events].filter((event)=>event.at<=input.now).sort((a,b)=>a.at-b.at)
  for (const rows of snapshots.values()) {
    const ranked = [...rows].sort((a, b) => a.rank - b.rank)
    const generatedAt = ranked[0]?.generatedAt
    if (generatedAt === undefined) continue
    ranked.forEach((row) => buckets.add(row.bucket))
    for(const row of ranked)for(const reason of row.reasonCodes??[])reasonCodeDistribution[reason]=(reasonCodeDistribution[reason]??0)+1
    const later = sortedEvents.filter((event) => event.at > generatedAt)
    if (later.length){outcomeSnapshots += 1;if (predictionMatches(ranked[0],later[0]!.projectKey)) nextHits += 1}
    if(generatedAt+7*DAY_MS<=input.now)for(const row of ranked.filter((item)=>item.bucket==='future')){futureTotal+=1;if(later.some((event)=>predictionMatches(row,event.projectKey)&&event.at<=generatedAt+7*DAY_MS))futureHits+=1}
    if(generatedAt+30*DAY_MS<=input.now)for(const row of ranked.filter((item)=>item.bucket==='distant')){distantTotal+=1;if(later.some((event)=>predictionMatches(row,event.projectKey)&&event.at<=generatedAt+30*DAY_MS))distantHits+=1}
  }
  const generations=input.generations??[];const rejectionReasonDistribution:Record<string,number>={}
  for(const generation of generations)for(const [reason,count] of Object.entries(generation.rejectionReasons))rejectionReasonDistribution[reason]=(rejectionReasonDistribution[reason]??0)+count
  const machineNames=generations.reduce((sum,row)=>sum+row.machineNameCount,0);const visible=generations.reduce((sum,row)=>sum+row.visibleCount,0)
  return {
    generatedAt: input.now,
    prelaunchReplay: { kind: 'prelaunch_event_replay',optimizedModel:'production_attention_subset', windowCount: evaluatedWindows, baselineTop1HitRate, optimizedTop1HitRate, improvement: optimizedTop1HitRate - baselineTop1HitRate, leakageSafe: true },
    postlaunchOutcomes: {
      kind: 'postlaunch_prediction_outcomes', available: outcomeSnapshots > 0||futureTotal>0||distantTotal>0, snapshotCount: generations.length||snapshots.size,
      top1NextUseHitRate: outcomeSnapshots ? ratio(nextHits, outcomeSnapshots) : null,
      futureSevenDayHitRate: futureTotal ? ratio(futureHits,futureTotal) : null,
      futureSevenDayFalsePositiveRate:futureTotal?ratio(futureTotal-futureHits,futureTotal):null,
      distantThirtyDayReuseRate: distantTotal ? ratio(distantHits,distantTotal) : null,
      bucketCoverage: [...buckets].sort(),reasonCodeDistribution,rejectionReasonDistribution,machineNameRate:visible?machineNames/visible:null, feedbackCounts: input.feedbackCounts || {},
    },
  }
}

function ratio(value: number, total: number): number { return total ? value / total : 0 }
function predictionMatches(prediction:EmergencePrediction|undefined,outcomeKey:string):boolean{return Boolean(prediction&&((prediction.fileKeys?.length?prediction.fileKeys.includes(outcomeKey):prediction.projectKey===outcomeKey)))}
