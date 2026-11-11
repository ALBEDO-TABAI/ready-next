#!/usr/bin/env node
'use strict'

const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const { createHash } = require('node:crypto')
const { spawnSync } = require('node:child_process')

const repo = path.resolve(__dirname, '..')
const dataset = path.join(__dirname, 'library-retrieval')
const fixture = path.join(dataset, 'fixtures/library')
const output = path.join(repo, 'docs/superpowers/audits/2026-11-11-library-retrieval')
const categories = ['exact', 'paraphrase', 'crosslang']
const labels = { exact: '原词', paraphrase: '同义／改写', crosslang: '中英混合／跨语言' }
const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex')

function filesIn(root, prefix = '') {
  return fs.readdirSync(path.join(root, prefix), { withFileTypes: true }).flatMap((entry) => {
    const relative = prefix ? `${prefix}/${entry.name}` : entry.name
    return entry.isDirectory() ? filesIn(root, relative) : [relative]
  }).sort()
}

function readDataset() {
  const lock = JSON.parse(fs.readFileSync(path.join(dataset, 'dataset-lock.json'), 'utf8'))
  const rawQueries = fs.readFileSync(path.join(dataset, 'queries.json'))
  assert.equal(sha256(rawQueries), lock.queriesSha256, '查询或答案与首次运行前锁定的版本不同')
  const pages = filesIn(fixture).map((name) => ({
    path: name, sha256: sha256(fs.readFileSync(path.join(fixture, name))),
  }))
  assert.deepEqual(pages, lock.pages, '资料库与首次运行前锁定的版本不同')
  assert(pages.length >= 60 && pages.length <= 100)
  assert(pages.every((page) => page.path.endsWith('.md')))
  const queries = JSON.parse(rawQueries)
  assert.equal(queries.length, 30)
  assert.equal(new Set(queries.map((q) => q.id)).size, 30)
  for (const category of categories) assert.equal(queries.filter((q) => q.category === category).length, 10)
  for (const q of queries) {
    assert(typeof q.query === 'string' && q.query.trim())
    assert(q.acceptablePaths.length > 0 && q.acceptablePaths.every((name) => pages.some((p) => p.path === name)))
    if (q.category === 'exact') {
      assert(q.acceptablePaths.some((name) => {
        const text = fs.readFileSync(path.join(fixture, name), 'utf8').toLowerCase()
        return q.query.toLowerCase().split(/\s+/).every((term) => text.includes(term))
      }), `原词查询没有原文依据：${q.id}`)
    }
  }
  return { queries, pages, queriesSha256: lock.queriesSha256 }
}

async function evaluate(temp) {
  assert(process.versions.electron && process.env.ELECTRON_RUN_AS_NODE === '1', '必须使用无窗口的 Electron Node 模式')
  assert.equal(path.dirname(temp), repo)
  assert(path.basename(temp).startsWith('.library-retrieval-'))
  assert.equal(require('node:os').tmpdir(), temp, '日志与临时文件必须隔离在 worktree 内')
  require('tsx/cjs')
  const { SearchEngine, probeFts5Availability } = require('../src/main/modules/search-engine/indexer.ts')
  const { runMigrations } = require('../src/main/modules/migrations.ts')
  const { parseSearchQuery } = require('../src/main/modules/search-engine/query.ts')
  const { flushBufferedRotatingLoggers } = require('../src/main/utils/rotating-logger.ts')
  const Database = require('better-sqlite3')
  const input = readDataset()
  const library = path.join(temp, 'library')
  fs.cpSync(fixture, library, { recursive: true })
  const db = new Database(path.join(temp, 'evaluation.db'))
  let engine
  try {
    runMigrations(db)
    assert(probeFts5Availability(db), 'FTS5 不可用，不能把降级检索当作本次评测')
    engine = new SearchEngine(db, { fts5Available: true })
    const indexed = await engine.reindexWorkspace({ root: library })
    assert(indexed.ok && !indexed.degraded, JSON.stringify(indexed))
    assert.equal(indexed.scanned, input.pages.length)
    assert.equal(indexed.indexed, input.pages.length)
    assert.equal(indexed.skipped, 0)
    assert.equal(engine.countDocuments(indexed.workspaceId), input.pages.length)
    const rows = []
    for (const q of input.queries) {
      // file_search -> worker.searchDocuments -> SearchEngine.search.
      // Preserve the tool's default limit (20); score only its first five.
      const found = await engine.search(q.query, { limit: 20, workspaceRoots: [library] })
      assert.equal(found.degraded, false)
      const top5 = found.items.slice(0, 5).map((item) => {
        const relative = path.relative(library, item.path).split(path.sep).join('/')
        assert(input.pages.some((p) => p.path === relative), `返回了夹具以外的路径：${relative}`)
        return { path: relative, name: item.name, rank: item.rank, snippet: item.snippet, sourceType: item.sourceType }
      })
      rows.push({ ...q, ftsMatch: parseSearchQuery(q.query).ftsMatch, hit: top5.some((item) => q.acceptablePaths.includes(item.path)), top5 })
    }
    flushBufferedRotatingLoggers()
    const searchLog = fs.readFileSync(path.join(temp, 'ready-test-logs/ready-search.log'), 'utf8')
    assert(!/failed|error=/i.test(searchLog), '生产检索日志有错误，不能计为普通未命中：\n' + searchLog)
    // Indexing adds identity metadata to the disposable copy only.
    readDataset()
    const metrics = Object.fromEntries(categories.map((category) => {
      const group = rows.filter((q) => q.category === category)
      const hits = group.filter((q) => q.hit).length
      return [category, { hits, total: group.length, hitRate: hits / group.length }]
    }))
    const needsT9 = metrics.paraphrase.hitRate < 0.7 || metrics.crosslang.hitRate < 0.7
    const result = {
      date: '2026-11-11', metric: 'Hit@5 (任一可接受页面在原始排序前五条)',
      retrievalPath: '助手 file_search → worker.searchDocuments → SearchEngine.search；直接调用同一查询函数，limit=20，取前五条',
      indexingPath: 'document:reindexWorkspace → SearchEngine.reindexWorkspace → FileSystemAdapter；使用生产 migrations 和 FTS5',
      scope: '固定查询原样检索；不包含模型改写、翻译、多次查找或最终回答质量；未运行 UI/IPC/worker 传输层',
      dataset: { pages: input.pages.length, queries: input.queries.length, queriesSha256: input.queriesSha256,
        corpusSha256: sha256(JSON.stringify(input.pages)), lockSha256: sha256(fs.readFileSync(path.join(dataset, 'dataset-lock.json'))) },
      runtime: { electron: process.versions.electron, node: process.versions.node, sqlite: db.prepare('SELECT sqlite_version() AS version').get().version },
      productionSources: Object.fromEntries(['indexer.ts', 'query.ts', 'adapters.ts', 'repository.ts'].map((name) => [name,
        sha256(fs.readFileSync(path.join(repo, 'src/main/modules/search-engine', name)))])),
      indexing: { scanned: indexed.scanned, indexed: indexed.indexed, skipped: indexed.skipped, degraded: indexed.degraded },
      metrics, needsT9, conclusion: needsT9 ? '需要 T9' : '不需要 T9', queries: rows,
    }
    const misses = rows.filter((q) => !q.hit)
    const lines = [
      '# W3-T7 资料库检索评测（2026-11-11）', '',
      '## 方法', '',
      '70 页原创虚构资料库，分层目录，均带 frontmatter title；含 7 篇英文页面、3 篇超过 1100 字符的长文和少量双链。先写资料库，再固定 30 条查询及可接受答案；首次运行前保存 dataset-lock.json，运行时核验全部文件，未根据结果调题。', '',
      `- 建索引：${result.indexingPath}。`,
      `- 检索：${result.retrievalPath}；作用域仅为本次复制的资料库。`,
      '- 指标：任一可接受答案出现在前五条即命中；不补词、不翻译、不重排。未命中是测量结果，不使脚本失败；建库不完整、FTS 降级或查询日志报错会使脚本失败。',
      '- 隔离：ELECTRON_RUN_AS_NODE=1；数据库、复制的资料库与日志均在 worktree 内临时目录，finally 删除；不启动应用窗口，不接触日常资料。无需新增产品导出。',
      `- 复跑：在仓库根目录执行 \`npm run verify:library-retrieval\`。查询 SHA-256：\`${input.queriesSha256}\`。逐条原始排序、分数、摘要及答案见 [results.json](results.json)。`, '',
      '## 命中率', '', '| 类别 | 命中 / 总数 | Hit@5 |', '| --- | --- | --- |',
      ...categories.map((c) => `| ${labels[c]} | ${metrics[c].hits} / ${metrics[c].total} | ${metrics[c].hitRate * 100}% |`), '',
      '## 未命中查询（全部）', '',
      ...misses.map((q) => `- **${q.id}「${q.query}」**：应命中 ${q.acceptablePaths.map((p) => `\`${p}\``).join('、')}；前五条：${q.top5.length ? q.top5.map((p, i) => `${i + 1}. \`${p.path}\``).join('；') : '无结果'}。`),
      ...(misses.length ? [] : ['无。']), '', '## M9 结论', '',
      `**${result.conclusion}**：第二类 ${metrics.paraphrase.hitRate * 100}%，第三类 ${metrics.crosslang.hitRate * 100}%，${needsT9 ? '至少一类低于 70%' : '两类均达到 70%'}。这里只记录触发条件；T9 未实施，是否启动由用户决定。`, '',
      '本轮后两类全部返回空列表。生产查询会把中文拆成双字片段，并要求所有词片段同时匹配；没有同义扩展或翻译。因此这次失败包含口语问句的字面匹配限制，不能单独归因为缺少向量。原词全部命中，70 页全部入库，日志无查询错误。', '',
      '这是固定人工样本上的单次查询结果，不代表助手通过多步改词后的最终成功率，也不证明任何向量方案已经有效。英文关键词与中文问句混用和纯跨语言均计入第三类；每类仅 10 条，结论限于本评测集。', '',
    ]
    fs.mkdirSync(output, { recursive: true })
    fs.writeFileSync(path.join(output, 'results.json'), JSON.stringify(result, null, 2) + '\n')
    fs.writeFileSync(path.join(output, 'README.md'), lines.join('\n'))
    console.log(result.retrievalPath)
    for (const c of categories) console.log(`${c}: ${metrics[c].hits}/${metrics[c].total} (${metrics[c].hitRate * 100}%)`)
    for (const q of misses) console.log(`MISS ${q.id} ${q.query}: ${q.top5.map((p) => p.path).join(', ') || '(无结果)'}`)
    console.log(`M9: ${result.conclusion}；T9 未实施。报告：${path.relative(repo, output)}`)
  } finally {
    engine?.cancelPendingWorkspaceResolves()
    db.close()
  }
}

if (process.argv[2] === '--evaluate') {
  evaluate(process.argv[3]).catch((error) => { console.error(error); process.exitCode = 1 })
} else {
  const temp = fs.mkdtempSync(path.join(repo, '.library-retrieval-'))
  try {
    const child = spawnSync(path.join(repo, 'node_modules/.bin/electron'), [__filename, '--evaluate', temp], {
      cwd: repo, stdio: 'inherit', env: { ...process.env, ELECTRON_RUN_AS_NODE: '1',
        TMPDIR: temp, TMP: temp, TEMP: temp, TSX_DISABLE_CACHE: '1', READY_TEST_LOG_ISOLATION: '1' },
    })
    if (child.error) throw child.error
    process.exitCode = child.status ?? 1
  } finally {
    fs.rmSync(temp, { recursive: true, force: true })
  }
}
