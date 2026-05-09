export type EmbeddedSkillId =
  | 'video-expert-analyzer'
  | 'video-copy-analyzer'
  | 'lets-go-rss'
  | 'deep-research'
  | 'systematic-literature-review'
  | 'github-deep-research'
  | 'academic-paper-review'
  | 'web-design-guidelines'
  | 'find-skills'

export interface EmbeddedSkillManifest {
  id: EmbeddedSkillId
  name: string
  description: string
  version: string
  requirementsFile: string
}

export const EMBEDDED_SKILLS: EmbeddedSkillManifest[] = [
  {
    id: 'video-expert-analyzer',
    name: 'Video Expert Analyzer',
    description: '视频下载、场景检测、字幕提取与多模态评分流水线',
    version: '2026.04.23-vnext',
    requirementsFile: 'requirements.txt',
  },
  {
    id: 'video-copy-analyzer',
    name: 'Video Copy Analyzer',
    description: '视频文案提取与转录分析（下载/字幕/文字稿）',
    version: '2026.04.23',
    requirementsFile: 'requirements.txt',
  },
  {
    id: 'lets-go-rss',
    name: "Let's Go RSS",
    description: '多平台订阅聚合、增量更新、摘要报告',
    version: '2026.04.23',
    requirementsFile: 'requirements.txt',
  },
  {
    id: 'deep-research',
    name: 'Deep Research',
    description: '系统化多源研究方法论：维度拆解 + 多查询 + 全文 fetch + 引用追踪',
    version: '2026.05.09',
    requirementsFile: 'requirements.txt',
  },
  {
    id: 'systematic-literature-review',
    name: 'Systematic Literature Review',
    description: '学术综述方法论：Boolean query / PRISMA / 引用图谱',
    version: '2026.05.09',
    requirementsFile: 'requirements.txt',
  },
  {
    id: 'github-deep-research',
    name: 'GitHub Deep Research',
    description: 'GitHub 项目调研方法论：仓库 / issue / 贡献者 / 依赖图',
    version: '2026.05.09',
    requirementsFile: 'requirements.txt',
  },
  {
    id: 'academic-paper-review',
    name: 'Academic Paper Review',
    description: '论文审稿方法论：method / experiment / claim / threat-to-validity',
    version: '2026.05.09',
    requirementsFile: 'requirements.txt',
  },
  {
    id: 'web-design-guidelines',
    name: 'Web Design Guidelines',
    description: '网页设计调研方法论：sitemap / typography / palette / interaction patterns',
    version: '2026.05.09',
    requirementsFile: 'requirements.txt',
  },
  {
    id: 'find-skills',
    name: 'Find Skills',
    description: '技能搜索方法论：description matching + when-to-use 反向 lookup',
    version: '2026.05.09',
    requirementsFile: 'requirements.txt',
  },
]

export const EMBEDDED_SKILL_IDS = new Set<EmbeddedSkillId>(EMBEDDED_SKILLS.map((skill) => skill.id))

export function getEmbeddedSkillManifest(skillId: string): EmbeddedSkillManifest | null {
  const found = EMBEDDED_SKILLS.find((skill) => skill.id === skillId)
  return found || null
}
