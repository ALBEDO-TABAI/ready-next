import type {
  FileEmergenceBucket,
  FileEmergenceIntentCard,
  FileEmergenceProject,
  FileEmergenceSnapshot,
} from '../../../shared/file-emergence'

export interface WelcomeSuggestion {
  id: string
  label: string
  description: string
  prompt: string
}

export const DEFAULT_WELCOME_SUGGESTIONS: readonly WelcomeSuggestion[] = [
  {
    id: 'default-review',
    label: '梳理当前工作',
    description: '从工作区里找出最值得推进的事',
    prompt: '请结合我当前工作区里的文件和最近活动，找出最值得推进的一件事，说明判断依据，然后直接帮我开始。',
  },
  {
    id: 'default-plan',
    label: '安排下一步',
    description: '按轻重缓急整理成行动清单',
    prompt: '请结合我当前工作区里的内容，按轻重缓急整理今天最合理的行动清单，并从第一项开始协助我执行。',
  },
]

interface SuggestionCandidate {
  id: string
  projectKey: string
  title: string
  bucket: FileEmergenceBucket
  status: FileEmergenceProject['status']
  score: number
  updatedAt: number
  files: FileEmergenceProject['files']
  intentType?: Extract<FileEmergenceIntentCard['type'], 'prepare' | 'forming'>
}

const BUCKET_PRIORITY: Record<FileEmergenceBucket, number> = {
  today: 0,
  future: 1,
  past: 2,
  distant: 3,
}

function compactText(value: string, maxLength: number): string {
  const compact = value
    .normalize('NFKC')
    .replace(/[\u0000-\u001f\u007f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
  if (compact.length <= maxLength) return compact
  return `${compact.slice(0, Math.max(1, maxLength - 1)).trimEnd()}…`
}

function intentTitle(card: FileEmergenceIntentCard): string {
  return compactText(
    card.title.replace(/^(?:接下来要准备|正在成形)\s*[：:]\s*/u, ''),
    60,
  ) || '当前项目'
}

function projectCandidate(project: FileEmergenceProject): SuggestionCandidate {
  return {
    id: `project:${project.projectKey || project.id}`,
    projectKey: project.projectKey || project.id,
    title: compactText(project.title, 60) || '当前项目',
    bucket: project.bucket,
    status: project.status,
    score: project.score,
    updatedAt: project.updatedAt,
    files: project.files,
  }
}

function intentCandidate(
  card: FileEmergenceIntentCard & { type: 'prepare' | 'forming' },
  generatedAt: number,
): SuggestionCandidate {
  return {
    id: `intent:${card.id}`,
    projectKey: card.projectKey,
    title: intentTitle(card),
    bucket: card.type === 'prepare' ? 'future' : 'today',
    status: card.type === 'prepare' ? 'upcoming' : 'active',
    score: 1 + card.confidence,
    updatedAt: generatedAt,
    files: [],
    intentType: card.type,
  }
}

function fileNames(candidate: SuggestionCandidate): string[] {
  return [...new Set(candidate.files.map((file) => compactText(file.name, 28)).filter(Boolean))].slice(0, 2)
}

function fileContext(candidate: SuggestionCandidate): string {
  const names = fileNames(candidate)
  if (names.length === 0) return ''
  return `，重点参考“${names.join('”“')}”`
}

function toSuggestion(candidate: SuggestionCandidate): WelcomeSuggestion {
  const shortTitle = compactText(candidate.title, 22)
  const count = candidate.files.length

  if (candidate.intentType === 'prepare') {
    return {
      id: candidate.id,
      label: `准备 · ${shortTitle}`,
      description: '近期可能会用到，先把材料备齐',
      prompt: `文件涌现判断“${candidate.title}”可能是我接下来要准备的事。请查看工作区内的相关材料，先核对缺口，再整理行动清单并直接开始执行。`,
    }
  }

  if (candidate.intentType === 'forming') {
    return {
      id: candidate.id,
      label: `推进 · ${shortTitle}`,
      description: '相关材料正在聚合，适合继续推进',
      prompt: `文件涌现判断“${candidate.title}”正在成形。请查看工作区内的相关材料，判断当前进度和最可能的下一步，然后直接帮我继续推进。`,
    }
  }

  if (candidate.status === 'continuation') {
    return {
      id: candidate.id,
      label: `续读 · ${shortTitle}`,
      description: count > 0 ? `从 ${fileNames(candidate).join('、')} 继续` : '从上次阅读进度继续',
      prompt: `继续处理文件涌现中的“${candidate.title}”${fileContext(candidate)}。请先恢复上次进度，再直接推进最合理的下一步。`,
    }
  }

  if (candidate.status === 'upcoming' || candidate.bucket === 'future') {
    return {
      id: candidate.id,
      label: `准备 · ${shortTitle}`,
      description: count > 0 ? `${count} 份相关材料待提前梳理` : '提前检查材料和行动节点',
      prompt: `为文件涌现中的“${candidate.title}”提前做准备${fileContext(candidate)}。请检查材料是否齐全，补出行动清单，并从最优先的一项开始。`,
    }
  }

  if (candidate.status === 'recently_finished' || candidate.bucket === 'past') {
    return {
      id: candidate.id,
      label: `收尾 · ${shortTitle}`,
      description: count > 0 ? `${count} 份相关产出待整理` : '复盘成果、遗漏和归档项',
      prompt: `对文件涌现中的“${candidate.title}”做一次收尾${fileContext(candidate)}。请梳理已完成成果、遗漏问题和需要归档的内容，并直接处理能立即完成的部分。`,
    }
  }

  if (candidate.status === 'dormant_important' || candidate.bucket === 'distant') {
    return {
      id: candidate.id,
      label: `重拾 · ${shortTitle}`,
      description: count > 0 ? `回顾 ${count} 份旧材料再决定` : '快速回顾，判断是否值得继续',
      prompt: `重新审视文件涌现中的“${candidate.title}”${fileContext(candidate)}。请简要回顾已有内容，判断是否值得继续，并给出一个最小可执行的下一步。`,
    }
  }

  return {
    id: candidate.id,
    label: `继续 · ${shortTitle}`,
    description: count > 0 ? `从 ${fileNames(candidate).join('、')} 接着推进` : '判断进度后继续最可能的下一步',
    prompt: `结合文件涌现中的“${candidate.title}”${fileContext(candidate)}，先判断当前进度，再直接帮我推进最可能的下一步。`,
  }
}

function companionSuggestion(candidate: SuggestionCandidate): WelcomeSuggestion {
  const shortTitle = compactText(candidate.title, 22)
  return {
    id: `${candidate.id}:organize`,
    label: `梳理 · ${shortTitle}`,
    description: '汇总相关材料，找出信息缺口',
    prompt: `先梳理文件涌现中的“${candidate.title}”${fileContext(candidate)}，汇总现有材料、关键信息和缺口，再给我一份可以直接执行的下一步。`,
  }
}

export function buildWelcomeSuggestions(snapshot: FileEmergenceSnapshot | null): readonly WelcomeSuggestion[] {
  if (!snapshot?.enabled) return DEFAULT_WELCOME_SUGGESTIONS

  const projectCandidates = (Object.values(snapshot.buckets).flat() as FileEmergenceProject[])
    .map(projectCandidate)
  const intentCandidates = (snapshot.intentCards ?? [])
    .filter((card): card is FileEmergenceIntentCard & { type: 'prepare' | 'forming' } =>
      (card.type === 'prepare' || card.type === 'forming') && card.confidence >= 0.5,
    )
    .map((card) => intentCandidate(card, snapshot.generatedAt))

  const candidates = [...intentCandidates, ...projectCandidates]
    .sort((a, b) =>
      BUCKET_PRIORITY[a.bucket] - BUCKET_PRIORITY[b.bucket] ||
      b.score - a.score ||
      b.updatedAt - a.updatedAt,
    )

  const selected: SuggestionCandidate[] = []
  const seenProjects = new Set<string>()
  const seenTitles = new Set<string>()
  for (const candidate of candidates) {
    const titleKey = candidate.title.toLocaleLowerCase()
    if (seenProjects.has(candidate.projectKey) || seenTitles.has(titleKey)) continue
    selected.push(candidate)
    seenProjects.add(candidate.projectKey)
    seenTitles.add(titleKey)
    if (selected.length === 2) break
  }

  if (selected.length === 0) return DEFAULT_WELCOME_SUGGESTIONS
  if (selected.length === 1) {
    return [toSuggestion(selected[0]), companionSuggestion(selected[0])]
  }
  return selected.map(toSuggestion)
}
