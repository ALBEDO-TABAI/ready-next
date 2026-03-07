/**
 * Keyword-based content classifier (zero-config, no API key needed).
 * Ported from lets-go-rss classifier.py SimpleClassifier.
 */

export type Category = '科技' | '人文' | '设计' | '娱乐' | '其他'

const KEYWORDS: Partial<Record<Category, string[]>> = {
  科技: [
    '技术', '编程', '代码', 'AI', '人工智能', '软件', '硬件', '科学', '算法',
    '机器学习', '深度学习', 'GPU', 'CPU', '数据库', 'API', 'SDK', '开源',
    'tech', 'code', 'programming', 'software', 'hardware', 'algorithm',
    'machine learning', 'deep learning', 'open source', 'developer'
  ],
  人文: [
    '文学', '历史', '哲学', '社会', '文化', '人文', '思想', '书籍', '读书',
    '经济', '政治', '心理', '教育',
    'literature', 'history', 'philosophy', 'culture', 'society', 'education'
  ],
  设计: [
    '设计', 'UI', 'UX', '平面', '产品', '艺术', '摄影', '视觉', '排版',
    '字体', '配色', 'Figma', 'Sketch',
    'design', 'art', 'photography', 'visual', 'typography', 'creative'
  ],
  娱乐: [
    '游戏', '影视', '电影', '音乐', '综艺', '体育', '娱乐', '动漫', '漫画',
    '小说', '剧集',
    'game', 'movie', 'music', 'entertainment', 'sport', 'anime', 'comic'
  ]
}

export function classifyItem(title: string, description = ''): Category {
  const text = (title + ' ' + description).toLowerCase()

  const scores: Record<string, number> = {}
  for (const [category, keywords] of Object.entries(KEYWORDS)) {
    scores[category] = 0
    for (const keyword of keywords) {
      if (text.includes(keyword.toLowerCase())) {
        scores[category]++
      }
    }
  }

  let maxScore = 0
  let bestCategory: Category = '其他'
  for (const [category, score] of Object.entries(scores)) {
    if (score > maxScore) {
      maxScore = score
      bestCategory = category as Category
    }
  }

  return bestCategory
}
