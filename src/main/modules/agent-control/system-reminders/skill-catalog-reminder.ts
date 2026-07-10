/**
 * P2-1 (T4) — L1 技能目录 system reminder。
 *
 * 每轮把全部技能的 name+description 常驻注入模型上下文（预算裁剪），让模型能按描述自选技能，
 * 而不必依赖用户显式 mention。安全语义不变：目录只是"清单"，激活（mention / use_skill / 续跑）才开原语。
 *
 * 文案只经 SystemReminderRegistry 组装（CLAUDE.md §5），确定性算法（同输入逐字节相等，无 Date/随机）。
 */

import type { SystemReminderRegistry } from './system-reminder-registry'

export const SKILL_CATALOG_CHAR_BUDGET = 4000
export const SKILL_CATALOG_DESC_CAP = 120

export interface SkillCatalogEntry {
  id: string
  name: string
  description: string
}

// The model's activation path is `use_skill`（typed refs come only from user input, never model output）；
// `@[技能id]` is how the USER references a skill. Keep both accurate so the catalog never advertises a
// path the model cannot take (P2-2 review fix).
export const CATALOG_HEADER =
  '可用技能（用 use_skill 激活后其工具才可用；用户也可 @[技能id] 引用）：'
export const SKILL_CATALOG_REMINDER_MARKER = '<!-- ready:system-reminder:skill-catalog -->'

function normalizeDescription(description: string): string {
  const text = String(description || '')
    .replace(/\s+/g, ' ')
    .trim()
  if (text.length <= SKILL_CATALOG_DESC_CAP) return text
  return `${text.slice(0, 117)}…`
}

/**
 * 确定性目录文本：
 * - 每行 `- @[id]｜name｜description`；description 超 SKILL_CATALOG_DESC_CAP → 截 117 + `…`。
 * - 逐行累加（含换行），超 budget 即停止；剩余技能只计数。恰好等于预算不丢。
 * - 有丢弃 → 末行 `（另有 N 个技能，可在技能中心查看或直接 @[技能id] 引用）`。
 * - entries 为空 → 空串。
 */
export function buildSkillCatalogText(
  entries: ReadonlyArray<SkillCatalogEntry>,
  budget: number = SKILL_CATALOG_CHAR_BUDGET
): string {
  if (entries.length === 0) return ''
  const lines: string[] = [SKILL_CATALOG_REMINDER_MARKER, CATALOG_HEADER]
  let used = SKILL_CATALOG_REMINDER_MARKER.length + 1 + CATALOG_HEADER.length
  let dropped = 0
  for (let index = 0; index < entries.length; index += 1) {
    const entry = entries[index]
    const line = `- @[${entry.id}]｜${entry.name}｜${normalizeDescription(entry.description)}`
    // +1 for the '\n' separator that join() will insert before this line.
    if (used + 1 + line.length > budget) {
      dropped = entries.length - index
      break
    }
    lines.push(line)
    used += 1 + line.length
  }
  if (dropped > 0) {
    lines.push(`（另有 ${dropped} 个技能，可在技能中心查看或直接 @[技能id] 引用）`)
  }
  return lines.join('\n')
}

/**
 * 注册目录段。entries 为空 → buildSkillCatalogText 返回空串 → 不注册（不产生空段）。
 * priority 低于 current-date（90）10 档 = 80；topic `skill-catalog`。
 */
export function registerSkillCatalogReminder(
  registry: SystemReminderRegistry,
  entries: ReadonlyArray<SkillCatalogEntry>
): void {
  const text = buildSkillCatalogText(entries)
  if (!text) return
  registry.register({
    topic: 'skill-catalog',
    priority: 80,
    text
  })
}
