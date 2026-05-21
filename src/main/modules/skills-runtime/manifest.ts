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
  | 'obsidian-web-clip'
  | 'study-notes'
  | 'image-analysis-router'
  | 'image-reverse-descriptor'
  | 'fastnote'

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
  {
    id: 'obsidian-web-clip',
    name: 'Obsidian Web Clip',
    description: '网页 → Obsidian-compatible Markdown 笔记的方法论 + preset 库：路由 web_clip_url（公共 URL）或 /clip-current（用户当前标签页）',
    version: '2026.05.15',
    requirementsFile: 'requirements.txt',
  },
  {
    id: 'study-notes',
    name: 'Study Notes',
    description: '结构化学习笔记方法论：8 种内容类型路由（教程 / 评论 / 故事 / 数据报告 / 新闻 / 框架 / 混合 / 不适合）+ 复杂度分层 + 可信度初判',
    version: '2026.05.17',
    requirementsFile: 'requirements.txt',
  },
  {
    id: 'image-analysis-router',
    name: 'Image Analysis Router',
    description: '图像分析路由方法论：17 类视觉路由 + 批量处理 + AI 内容判定 + Study Report 模板',
    version: '2026.05.17',
    requirementsFile: 'requirements.txt',
  },
  {
    id: 'image-reverse-descriptor',
    name: 'Image Reverse Descriptor',
    description: '网页图片反推描述词：主体 / 场景 / 构图 / 光线 / 色彩 / 材质 / 风格关键词',
    version: '2026.05.21',
    requirementsFile: 'requirements.txt',
  },
  {
    id: 'fastnote',
    name: 'FastNote',
    description: '笔记快捷模式路由方法论：把 IM-style 混合输入按 -/: / -/2: 触发深度档位分发到剪藏 / study-notes / image-analysis-router / video-* 并写入工作区',
    version: '2026.05.17',
    requirementsFile: 'requirements.txt',
  },
]

export const EMBEDDED_SKILL_IDS = new Set<EmbeddedSkillId>(EMBEDDED_SKILLS.map((skill) => skill.id))

export function getEmbeddedSkillManifest(skillId: string): EmbeddedSkillManifest | null {
  const found = EMBEDDED_SKILLS.find((skill) => skill.id === skillId)
  return found || null
}
