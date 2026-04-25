export type EmbeddedSkillId =
  | 'video-expert-analyzer'
  | 'video-copy-analyzer'
  | 'lets-go-rss'

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
]

export const EMBEDDED_SKILL_IDS = new Set<EmbeddedSkillId>(EMBEDDED_SKILLS.map((skill) => skill.id))

export function getEmbeddedSkillManifest(skillId: string): EmbeddedSkillManifest | null {
  const found = EMBEDDED_SKILLS.find((skill) => skill.id === skillId)
  return found || null
}
