#!/usr/bin/env node
/**
 * EP2-K6 — one-shot agent_knowledge k/v → staged belief cards (sub-contract
 * §5). Source rows are NEVER deleted (迁移期共存); reruns skip existing
 * slugs (hand-edited cards are never overwritten); staged status keeps the
 * export out of every injection surface until a human adopts each card.
 *
 * Usage: node scripts/export-agent-knowledge-to-cards.cjs --db <sqlite> --memory-root <dir>
 * (explicit user invocation only — never wired into startup.)
 */

const { writeFileSync, existsSync, mkdirSync } = require('node:fs')
const { join } = require('node:path')

function slugify(agentName, key) {
  const raw = `kv-${agentName}-${key}`.toLowerCase()
  return raw.replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 80) || 'kv-row'
}

/** Pure core — testable without sqlite. Returns created/skipped relPaths. */
function exportKvRowsToCards(rows, memoryRoot, today) {
  const dir = join(memoryRoot, 'knowledge')
  mkdirSync(dir, { recursive: true })
  const created = []
  const skipped = []
  for (const row of rows) {
    const slug = slugify(String(row.agent_name || 'global'), String(row.key || ''))
    const relPath = `knowledge/${slug}.md`
    const abs = join(memoryRoot, relPath)
    if (existsSync(abs)) { skipped.push(relPath); continue }
    const body = [
      '---',
      `title: ${String(row.key || slug)}`,
      `description: 从 agent_knowledge 导出（agent=${String(row.agent_name || 'global')}）`,
      'confidence: L',
      'tag: knowledge',
      `created: ${today}`,
      'status: staged',
      '---',
      String(row.value ?? ''),
      '',
      `> 来源：agent_knowledge k/v 一次性导出（${today}）；人工过目采纳后晋升 active。`,
    ].join('\n')
    writeFileSync(abs, body, 'utf-8')
    created.push(relPath)
  }
  return { created, skipped }
}

module.exports = { exportKvRowsToCards, slugify }

if (require.main === module) {
  const args = process.argv.slice(2)
  const argOf = (flag) => { const i = args.indexOf(flag); return i >= 0 ? args[i + 1] : null }
  const dbPath = argOf('--db')
  const memoryRoot = argOf('--memory-root')
  if (!dbPath || !memoryRoot) {
    console.error('usage: export-agent-knowledge-to-cards --db <sqlite> --memory-root <dir>')
    process.exit(2)
  }
  let Database
  try {
    Database = require('better-sqlite3')
  } catch (error) {
    console.error('better-sqlite3 unavailable in this Node (ABI). Run via the app Node or export rows manually.')
    console.error(String(error && error.message))
    process.exit(1)
  }
  const db = new Database(dbPath, { readonly: true })
  const rows = db.prepare('SELECT agent_name, key, value FROM agent_knowledge').all()
  const result = exportKvRowsToCards(rows, memoryRoot, new Date().toISOString().slice(0, 10))
  console.log(JSON.stringify({ total: rows.length, created: result.created.length, skipped: result.skipped.length }, null, 2))
}
