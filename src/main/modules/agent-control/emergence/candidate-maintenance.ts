/**
 * EP3-C5 — emergence candidate maintenance (03 §5). Deterministic, zero LLM
 * — the file-emergence paradigm (多源证据 → 候选 → 打分 → 可解释投影)
 * extended to agent candidates:
 *
 *  - agent candidates: same-domain similar requests ≥2 → write/update an
 *    `aspire` card with a candidate `stage` (hint → candidate when evidence
 *    reaches 3 dated entries with stable I/O), dated evidence lines and the
 *    explicit 升/降置信度 conditions in the body;
 *  - routing fixes: a dedicated agent exists but the request landed on the
 *    main agent → `routing-<agentId>.md` (tag self, confidence H);
 *  - prune suggestions: long-idle / overlapping agents → a suggestion card
 *    ONLY — this module has no execution path at all; adoption/derivation
 *    belongs to the phase-4 user-confirm flow (04 篇).
 *
 * Every card write goes through BeliefCardStore.writeCard and is FORCED
 * staged (maintenance never mints active beliefs). Wording is observational
 * （"最近…"），never judgmental（"你是一个…"）.
 */

import {
  BeliefCardStore,
  isSafeAgentScopeId,
  type CandidateStage,
} from '../knowledge/belief-card-store'

export interface SimilarRequestSignal {
  /** Deterministic same-domain grouping key, computed by caller CODE. */
  domain: string
  request: string
  /** ISO date — 证据必须带日期。 */
  date: string
  /** 稳定输入/过程/输出 judgment from structured task results. */
  stableIO: boolean
}

export interface RoutingMissSignal {
  agentId: string
  agentName: string
  requestSummary: string
  date: string
}

export interface AgentTrafficSignal {
  agentId: string
  agentName: string
  runsLast30Days: number
  overlapsWithAgentId?: string | null
}

export interface CandidateMaintenanceReport {
  candidateCards: Array<{ relPath: string; stage: CandidateStage; evidenceCount: number }>
  routingCards: string[]
  pruneCards: string[]
  rejected: number
}

// stability is PERSISTED per evidence entry — upgrades count historical
// stable evidence, not just this round's signals. Unmarked legacy lines
// count as NOT stable (conservative: never upgrade on unproven history).
const EVIDENCE_LINE = /^- (\d{4}-\d{2}-\d{2})(?: \[(stable|varied)\])? (.+)$/

interface EvidenceEntry {
  date: string
  fact: string
  stable: boolean
}

function slugify(text: string): string {
  const slug = text.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '')
  return slug || 'domain'
}

function readExistingEvidence(store: BeliefCardStore, relPath: string): EvidenceEntry[] {
  const card = store.readCard(relPath, { includeStaged: true })
  if (!card) return []
  const out: EvidenceEntry[] = []
  for (const line of card.body.split('\n')) {
    const match = line.trim().match(EVIDENCE_LINE)
    if (match) out.push({ date: match[1], stable: match[2] === 'stable', fact: match[3] })
  }
  return out
}

function candidateBody(domain: string, evidence: EvidenceEntry[], stage: CandidateStage): string {
  return [
    `最近在「${domain}」域观察到重复出现的相似请求（观察记录，非定性）：`,
    '',
    ...evidence.map((entry) => `- ${entry.date} [${entry.stable ? 'stable' : 'varied'}] ${entry.fact}`),
    '',
    '升降置信度条件：',
    `- 升：同域请求再次出现且输入/输出保持稳定 → ${stage === 'hint' ? '升为 candidate' : '保持 candidate，等待用户确认采纳'}`,
    '- 降：30 天无新证据 → 降回 hint；60 天无新证据 → retired',
    '',
    '已记录，待派生流程上线（确认采纳属 04 篇用户流程，本卡只观察不执行）。',
  ].join('\n')
}

export function maintainAgentCandidates(deps: {
  store: BeliefCardStore
  signals: ReadonlyArray<SimilarRequestSignal>
  routingMisses?: ReadonlyArray<RoutingMissSignal>
  traffic?: ReadonlyArray<AgentTrafficSignal>
  now: Date
}): CandidateMaintenanceReport {
  const report: CandidateMaintenanceReport = { candidateCards: [], routingCards: [], pruneCards: [], rejected: 0 }
  const today = deps.now.toISOString().slice(0, 10)

  // ---- agent candidates: same-domain ≥2 → aspire card with stage
  const byDomain = new Map<string, SimilarRequestSignal[]>()
  for (const signal of deps.signals) {
    if (!signal.domain.trim() || !signal.request.trim() || !/^\d{4}-\d{2}-\d{2}/.test(signal.date)) {
      report.rejected += 1
      continue
    }
    const list = byDomain.get(signal.domain) ?? []
    list.push(signal)
    byDomain.set(signal.domain, list)
  }
  for (const [domain, signals] of byDomain) {
    const relPath = `knowledge/agent-candidate-${slugify(domain)}.md`
    const existing = readExistingEvidence(deps.store, relPath)
    const seen = new Set(existing.map((entry) => `${entry.date}|${entry.fact}`))
    const merged = [...existing]
    for (const signal of signals) {
      const fact = signal.request.replace(/\n+/g, ' ').slice(0, 200)
      const key = `${signal.date.slice(0, 10)}|${fact}`
      if (seen.has(key)) continue
      seen.add(key)
      merged.push({ date: signal.date.slice(0, 10), fact, stable: signal.stableIO })
    }
    if (merged.length < 2) continue // 同域 ≥2 次才立卡
    // 升 candidate 的依据是累计的带日期稳定证据（≥3 条 stable），
    // 不是本轮信号——历史 varied 证据永远不为升级背书。
    const stableEvidence = merged.filter((entry) => entry.stable).length
    const stage: CandidateStage = stableEvidence >= 3 ? 'candidate' : 'hint'
    const written = deps.store.writeCard({
      relPath,
      frontmatter: {
        title: `专项 agent 候选：${domain}`,
        description: `同域相似请求 ${merged.length} 次（${stage}）`,
        confidence: stage === 'candidate' ? 'M' : 'L',
        tag: 'aspire',
        created: today,
        status: 'staged',
        stage,
      },
      body: candidateBody(domain, merged, stage),
    })
    if (written.ok) report.candidateCards.push({ relPath, stage, evidenceCount: merged.length })
    else report.rejected += 1
  }

  // ---- routing fixes: dedicated agent exists, request hit the main agent
  for (const miss of deps.routingMisses ?? []) {
    if (!isSafeAgentScopeId(miss.agentId)) {
      report.rejected += 1
      continue
    }
    const relPath = `knowledge/routing-${miss.agentId}.md`
    const existing = readExistingEvidence(deps.store, relPath)
    const merged = [...existing, { date: miss.date.slice(0, 10), fact: miss.requestSummary.replace(/\n+/g, ' ').slice(0, 200) }]
    const written = deps.store.writeCard({
      relPath,
      frontmatter: {
        title: `路由修复：该域请求应交给 ${miss.agentName}`,
        description: `已有专项 agent「${miss.agentName}」但请求仍落在主 agent`,
        confidence: 'H',
        tag: 'self',
        created: today,
        status: 'staged',
      },
      body: [
        `最近观察到应由「${miss.agentName}」(${miss.agentId}) 处理的请求落在了主 agent：`,
        '',
        ...merged.map((entry) => `- ${entry.date} ${entry.fact}`),
        '',
        `确认后此域请求路由至 [[${miss.agentId}]]。`,
      ].join('\n'),
    })
    if (written.ok) report.routingCards.push(relPath)
    else report.rejected += 1
  }

  // ---- prune SUGGESTIONS — never an execution path
  for (const traffic of deps.traffic ?? []) {
    if (!isSafeAgentScopeId(traffic.agentId)) {
      report.rejected += 1
      continue
    }
    const idle = traffic.runsLast30Days === 0
    const overlap = Boolean(traffic.overlapsWithAgentId)
    if (!idle && !overlap) continue
    const relPath = `knowledge/agent-prune-${traffic.agentId}.md`
    const written = deps.store.writeCard({
      relPath,
      frontmatter: {
        title: `观察：「${traffic.agentName}」${idle ? '最近 30 天没有流量' : `与 ${traffic.overlapsWithAgentId} 职责重叠`}`,
        description: '合并/退休建议——只建议不执行',
        confidence: 'L',
        tag: 'aspire',
        created: today,
        status: 'staged',
      },
      body: [
        idle
          ? `最近 30 天「${traffic.agentName}」(${traffic.agentId}) 没有任何任务流量。`
          : `「${traffic.agentName}」(${traffic.agentId}) 与 [[${traffic.overlapsWithAgentId}]] 的职责出现重叠。`,
        '',
        '建议考虑合并或退休；执行权在用户确认流程（04 篇），本卡只建议不执行。',
      ].join('\n'),
    })
    if (written.ok) report.pruneCards.push(relPath)
    else report.rejected += 1
  }

  return report
}
