import assert from 'node:assert/strict'
import test from 'node:test'
import { evaluateEmergence, rankReplayCandidates } from '../main/modules/file-emergence/evaluation'

const day = 86_400_000

test('historical replay rewards sustained work and beats a recency-only baseline without future leakage', () => {
  const cutoff = 30 * day
  const history = [5, 10, 15, 20, 25].map((at) => ({ projectKey: 'sustained', at: at * day }))
  history.push({ projectKey: 'one-off', at: cutoff - 1 })
  const events = [...history, { projectKey: 'sustained', at: cutoff + day }]
  const report = evaluateEmergence({ events, predictions: [], cutoffs: [cutoff], now: 40 * day })
  assert.equal(report.prelaunchReplay.baselineTop1HitRate, 0)
  assert.equal(report.prelaunchReplay.optimizedTop1HitRate, 1)
  assert.ok(report.prelaunchReplay.improvement > 0)
  assert.deepEqual(rankReplayCandidates(events, cutoff), rankReplayCandidates([...events, { projectKey: 'future-decoy', at: cutoff + 2 * day }], cutoff))
  assert.equal(report.prelaunchReplay.leakageSafe, true)
})

test('postlaunch snapshot outcomes stay separate and record future and distant coverage', () => {
  const generatedAt = 50 * day
  const report = evaluateEmergence({
    events: [{ projectKey: 'future-project', at: generatedAt + day }, { projectKey: 'old-project', at: generatedAt + 10 * day }],
    predictions: [
      { snapshotId: 's1', projectKey: 'future-project', bucket: 'future', rank: 1, generatedAt,reasonCodes:['project_intent'],machineName:false },
      { snapshotId: 's1', projectKey: 'old-project', bucket: 'distant', rank: 2, generatedAt,reasonCodes:['attention_rollup'],machineName:false },
    ],
    generations:[{snapshotId:'s1',generatedAt,visibleCount:2,machineNameCount:0,rejectionReasons:{not_qualified:3}}],
    feedbackCounts: { hide: 2 }, cutoffs: [], now: 80 * day,
  })
  assert.equal(report.postlaunchOutcomes.available, true)
  assert.equal(report.postlaunchOutcomes.top1NextUseHitRate, 1)
  assert.equal(report.postlaunchOutcomes.futureSevenDayHitRate, 1)
  assert.equal(report.postlaunchOutcomes.futureSevenDayFalsePositiveRate,0)
  assert.equal(report.postlaunchOutcomes.distantThirtyDayReuseRate, 1)
  assert.deepEqual(report.postlaunchOutcomes.reasonCodeDistribution,{project_intent:1,attention_rollup:1})
  assert.deepEqual(report.postlaunchOutcomes.rejectionReasonDistribution,{not_qualified:3})
  assert.equal(report.postlaunchOutcomes.machineNameRate,0)
  assert.deepEqual(report.postlaunchOutcomes.bucketCoverage, ['distant', 'future'])
  assert.equal(report.postlaunchOutcomes.feedbackCounts.hide, 2)
})

test('postlaunch evaluation ignores future-dated outcomes and waits for full bucket outcome windows',()=>{
  const generatedAt=10*day
  const report=evaluateEmergence({
    events:[{projectKey:'future-project',at:generatedAt+8*day},{projectKey:'future-project',at:generatedAt+40*day}],
    predictions:[{snapshotId:'s1',projectKey:'future-project',bucket:'future',rank:1,generatedAt}],
    cutoffs:[],now:generatedAt+6*day,
  })
  assert.equal(report.postlaunchOutcomes.available,false)
  assert.equal(report.postlaunchOutcomes.futureSevenDayHitRate,null)
  assert.equal(report.postlaunchOutcomes.futureSevenDayFalsePositiveRate,null)
})

test('a mature future prediction with no outcome is available and counted as a false positive',()=>{
  const generatedAt=10*day
  const report=evaluateEmergence({events:[],predictions:[{snapshotId:'s1',projectKey:'future-project',bucket:'future',rank:1,generatedAt}],cutoffs:[],now:generatedAt+8*day})
  assert.equal(report.postlaunchOutcomes.available,true)
  assert.equal(report.postlaunchOutcomes.futureSevenDayHitRate,0)
  assert.equal(report.postlaunchOutcomes.futureSevenDayFalsePositiveRate,1)
})
