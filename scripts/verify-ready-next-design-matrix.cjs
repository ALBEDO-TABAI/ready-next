#!/usr/bin/env node
// W1 design matrix — docs/superpowers/plans/2026-11-11-ready-next-w1-design-system-implementation.md §6.
// Build first (npx electron-vite build). Real Electron on a throwaway profile and a seeded test vault;
// the daily Ready data is never opened.
//
//   node scripts/verify-ready-next-design-matrix.cjs [options]
//     --label <name>            output folder suffix (default: HHMM)
//     --themes light,dark       themes to run (default: both)
//     --transparency normal,reduced   (default: every value this build supports)
//     --quick                   the four modes at 1440×900 only; never writes the budget
//     --write-budget            lower scripts/design-matrix-budget.json to this run's counts (never raises)
//     --no-budget               report only
//     --keep                    keep the temporary profile and vault
//
// Screenshots go to outputs/design-matrix/<date>-<label>/ with report.json and report.md.
// Every check counts distinct violation signatures; the counts may only go down (DS1–DS7, G1, G4, G5).
// page.screenshot cannot see the system glass behind the window or the native web view, so glass
// quality still needs one look at a visible window per batch (W1 §6).
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { execFileSync } = require('node:child_process')
const harness = require('./design-matrix/harness.cjs')
const { collect, contrast, LEGACY_SHEETS } = require('./design-matrix/checks.cjs')

const REPO = harness.REPO
const BUDGET_PATH = path.join(REPO, 'scripts', 'design-matrix-budget.json')
const SIZES = [{ width: 1440, height: 900 }, { width: 1100, height: 760 }]
const MODES = ['document', 'rss', 'calendar', 'browser']
const CHECKS = ['contentWidth', 'bandSymmetry', 'composerAlign', 'overflow', 'uiFont', 'currentAccent', 'nativeControls', 'focusRing', 'contrast']

function parseArgs(argv) {
  const args = { themes: ['light', 'dark'], transparency: null, quick: false, writeBudget: false, budget: true, keep: false, label: null }
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]
    if (arg === '--themes') args.themes = argv[++i].split(',')
    else if (arg === '--transparency') args.transparency = argv[++i].split(',')
    else if (arg === '--label') args.label = argv[++i]
    else if (arg === '--quick') args.quick = true
    else if (arg === '--write-budget') args.writeBudget = true
    else if (arg === '--no-budget') args.budget = false
    else if (arg === '--keep') args.keep = true
    else throw new Error(`unknown option ${arg}`)
  }
  if (args.quick && args.writeBudget) throw new Error('--quick runs never write the budget')
  return args
}

const log = message => console.log(message)

// ---- screens ----

const sidebar = page => page.getByLabel('页面侧栏', { exact: true })
async function openPage(page, title) {
  await sidebar(page).locator('.ink-sb-label-btn', { hasText: title }).first().click()
  await harness.sleep(1400)
}
async function backToWorkbench(page) {
  await page.keyboard.press('Escape').catch(() => {})
  await page.keyboard.press('Escape').catch(() => {})
  const hash = await page.evaluate(() => location.hash)
  if (!hash.startsWith('#/workbench') && hash !== '#/' && hash !== '') {
    await page.evaluate(() => { location.hash = '#/workbench' })
    await page.waitForSelector('[data-workbench-shell="true"]', { timeout: 15000 })
    await harness.sleep(800)
  }
}

const FIXED_SCREENS = [
  { name: 'doc-home', mode: 'document', run: async page => { await sidebar(page).getByText('主页', { exact: true }).click(); await harness.sleep(1200) } },
  { name: 'doc-page', mode: 'document', run: page => openPage(page, '新书发布') },
  {
    name: 'doc-slash', mode: 'document',
    run: async page => {
      await openPage(page, '读书笔记')
      const editable = page.locator('[data-ready-block-editor] [contenteditable="true"]').last()
      await editable.click()
      await page.keyboard.press('End')
      await page.keyboard.press('Enter')
      await page.keyboard.type('/')
      await harness.sleep(800)
    },
    cleanup: async page => { await page.keyboard.press('Escape'); await page.keyboard.press('Backspace'); await page.keyboard.press('Backspace') },
  },
  { name: 'doc-database', mode: 'document', run: page => openPage(page, '选题库') },
  { name: 'doc-canvas', mode: 'document', run: async page => { await openPage(page, '灵感'); await harness.sleep(600) } },
  {
    name: 'library-shelf', mode: 'document',
    run: async page => {
      await page.locator('[data-library-entry="true"]').click()
      await page.locator('.rn-library').waitFor({ timeout: 15000 })
      await harness.sleep(2200)
    },
  },
  {
    name: 'library-reader', mode: 'document',
    run: async page => {
      if (!(await page.locator('.rn-library').isVisible().catch(() => false))) {
        await page.locator('[data-library-entry="true"]').click()
        await page.locator('.rn-library').waitFor({ timeout: 15000 })
        await harness.sleep(1500)
      }
      const spine = page.locator('.rn-library .spine').first()
      const box = await spine.boundingBox()
      if (!box) throw new Error('no book spine on the shelf')
      await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2)
      await harness.sleep(1400)
      await page.getByRole('button', { name: '翻看封面' }).click({ force: true })
      await harness.sleep(700)
      await page.getByRole('button', { name: '开始阅读' }).evaluate(button => button.click())
      await harness.sleep(2800)
    },
  },
  {
    name: 'cmdk', mode: 'document',
    run: async page => { await page.keyboard.press('Meta+k'); await harness.sleep(700); await page.keyboard.type('筛子'); await harness.sleep(1000) },
  },
  {
    name: 'rss-article', mode: 'rss',
    // Scoped to the mode panel: the same titles also sit, hidden, in other modes' lists.
    run: async page => { await page.locator('[data-workbench-mode-panel="rss"]').getByText('本地模型在端侧推理上的新进展').first().click(); await harness.sleep(2500) },
  },
  {
    name: 'calendar-event', mode: 'calendar',
    run: async page => { await page.locator('[data-workbench-mode-panel="calendar"]').getByText('封面评审').first().click(); await harness.sleep(1200) },
  },
  {
    name: 'settings', mode: null,
    run: async page => { await page.evaluate(() => { location.hash = '#/settings' }); await harness.sleep(1800) },
  },
  {
    name: 'design-system', mode: null, optional: true,
    run: async page => {
      await page.evaluate(() => { location.hash = '#/design-system' })
      await harness.sleep(1500)
      if (!(await page.locator('[data-design-system-page]').count())) return 'absent'
      return null
    },
  },
]

async function ensureBrowserTab(page, fixtureUrl) {
  const tabs = await page.evaluate(() => window.electronAPI.browser.getTabs())
  const list = Array.isArray(tabs) ? tabs : tabs?.data ?? tabs?.tabs ?? []
  if (!list.some(tab => String(tab.url ?? '').startsWith(fixtureUrl))) {
    await page.evaluate(url => window.electronAPI.browser.createTab(url), `${fixtureUrl}/a/1`)
  }
  await harness.sleep(2200)
}

async function capture(page, ctx, screen, { mode, checkLayout }) {
  const file = path.join(ctx.outDir, `${ctx.combo}-${screen}.png`)
  await page.screenshot({ path: file, scale: 'css' })
  const data = await page.evaluate(collect, { mode, legacySheets: mode ? LEGACY_SHEETS[mode] : [], checkLayout })
  ctx.results.push({ combo: ctx.combo, screen, file: path.relative(REPO, file), ...data })
  const counts = Object.entries(data.violations).map(([k, v]) => `${k} ${v.length}`).join(', ')
  log(`  ${screen}${counts ? ` — ${counts}` : ''}`)
}

async function runCombo(session, ctx, options) {
  let { app, page } = session
  // Modes at both sizes.
  const sizes = options.quick ? SIZES.slice(0, 1) : SIZES
  for (const size of sizes) {
    await harness.setContentSize(app, page, size.width, size.height)
    for (const mode of MODES) {
      const screen = `${mode}-${size.width}`
      try {
        await harness.requestMode(page, mode)
        if (mode === 'browser') await ensureBrowserTab(page, ctx.fixtureUrl)
        await capture(page, ctx, screen, { mode, checkLayout: true })
      } catch (error) {
        ctx.failures.push({ combo: ctx.combo, screen, error: String(error.message ?? error).split('\n')[0] })
        log(`  ${screen} — STEP FAILED: ${ctx.failures.at(-1).error}`)
      }
    }
  }
  await harness.setContentSize(app, page, 1440, 900)
  if (options.quick) return { app, page }
  for (const screen of FIXED_SCREENS) {
    try {
      if (screen.mode) await harness.requestMode(page, screen.mode)
      const outcome = await screen.run(page)
      if (outcome === 'absent' && screen.optional) { log(`  ${screen.name} — not built yet, skipped`); await backToWorkbench(page); continue }
      await capture(page, ctx, screen.name, { mode: screen.mode, checkLayout: false })
      if (screen.cleanup) await screen.cleanup(page)
    } catch (error) {
      ctx.failures.push({ combo: ctx.combo, screen: screen.name, error: String(error.message ?? error).split('\n')[0] })
      log(`  ${screen.name} — STEP FAILED: ${ctx.failures.at(-1).error}`)
    }
    await backToWorkbench(page).catch(() => {})
  }
  return { app, page }
}

// ---- budget ----

function tally(results, contrastByCombo) {
  const counts = {}
  for (const result of results) {
    counts[result.combo] ??= Object.fromEntries(CHECKS.map(check => [check, 0]))
    for (const [check, list] of Object.entries(result.violations)) counts[result.combo][check] += list.length
  }
  for (const [combo, value] of Object.entries(contrastByCombo)) {
    counts[combo] ??= Object.fromEntries(CHECKS.map(check => [check, 0]))
    counts[combo].contrast = value.violations.length
  }
  return counts
}

function readJson(file) {
  return fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : null
}

function headBudget() {
  try {
    return JSON.parse(execFileSync('git', ['show', 'HEAD:scripts/design-matrix-budget.json'], { cwd: REPO, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }))
  } catch {
    return null
  }
}

function compareBudget(counts, budget) {
  const problems = []
  const lowerable = []
  for (const [combo, checks] of Object.entries(counts)) {
    const limits = budget?.combos?.[combo]
    if (!limits) { problems.push(`${combo}: no budget yet (run with --write-budget once this combination is meant to be enforced)`); continue }
    for (const [check, value] of Object.entries(checks)) {
      const limit = limits[check] ?? 0
      if (value > limit) problems.push(`${combo} ${check}: ${value} > budget ${limit}`)
      else if (value < limit) lowerable.push(`${combo} ${check}: ${value} < ${limit}`)
    }
  }
  const head = headBudget()
  if (head && budget) {
    for (const [combo, checks] of Object.entries(budget.combos ?? {})) {
      for (const [check, value] of Object.entries(checks)) {
        const before = head.combos?.[combo]?.[check]
        if (before !== undefined && value > before) problems.push(`budget file raised ${combo} ${check} from ${before} to ${value} (budgets only go down)`)
      }
    }
  }
  return { problems, lowerable }
}

function writeBudget(counts, budget) {
  const next = budget ?? {
    note: 'W1 design matrix budget: distinct violation signatures per theme/transparency combination. Counts only go down; the target is 0 everywhere (G1, G4, G5, DS5, DS7). Written by --write-budget, which never raises a value.',
    combos: {},
  }
  for (const [combo, checks] of Object.entries(counts)) {
    next.combos[combo] ??= {}
    for (const [check, value] of Object.entries(checks)) {
      const current = next.combos[combo][check]
      next.combos[combo][check] = current === undefined ? value : Math.min(current, value)
    }
  }
  fs.writeFileSync(BUDGET_PATH, `${JSON.stringify(next, null, 2)}\n`)
}

function writeReport(outDir, results, failures, contrastByCombo, counts, verdict) {
  fs.writeFileSync(path.join(outDir, 'report.json'), `${JSON.stringify({ results, failures, contrast: contrastByCombo, counts, verdict }, null, 2)}\n`)
  const lines = ['# Design matrix', '', `Generated ${new Date().toISOString()}`, '']
  lines.push('| combination | screen | content | bands (top/bottom) | composer Δ | violations |', '| --- | --- | --- | --- | --- | --- |')
  for (const r of results) {
    const m = r.measures
    const content = m.contentRatio !== undefined ? `${Math.round(m.contentRatio * 100)}% (${m.sheet?.w}px)` : ''
    const bands = m.bands ? `${m.bands.top}/${m.bands.bottom}` : ''
    const v = Object.entries(r.violations).map(([k, list]) => `${k} ${list.length}`).join(', ')
    lines.push(`| ${r.combo} | ${r.screen} | ${content} | ${bands} | ${m.composerDelta ?? ''} | ${v} |`)
  }
  lines.push('', '## Contrast', '')
  for (const [combo, c] of Object.entries(contrastByCombo)) lines.push(`- ${combo}: ${Object.entries(c.values).map(([k, v]) => `${k} ${v}`).join(', ')}`)
  lines.push('', '## Counts', '', '```json', JSON.stringify(counts, null, 2), '```')
  if (failures.length) lines.push('', '## Step failures', '', ...failures.map(f => `- ${f.combo} ${f.screen}: ${f.error}`))
  lines.push('', '## Verdict', '', ...verdict.map(v => `- ${v}`))
  fs.writeFileSync(path.join(outDir, 'report.md'), `${lines.join('\n')}\n`)
}

async function main() {
  const options = parseArgs(process.argv.slice(2))
  for (const file of ['out/main/index.js', 'out/renderer/index.html']) {
    if (!fs.existsSync(path.join(REPO, file))) throw new Error(`missing ${file}: run npx electron-vite build first`)
  }
  const now = new Date()
  const pad = n => String(n).padStart(2, '0')
  const stamp = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`
  const outDir = path.join(REPO, 'outputs', 'design-matrix', `${stamp}-${options.label ?? `${pad(now.getHours())}${pad(now.getMinutes())}`}`)
  fs.mkdirSync(outDir, { recursive: true })
  // realpath: on macOS os.tmpdir() is under /var, a symlink to /private/var, and the vault
  // service insists on the canonical root.
  const temp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'ready-design-matrix-')))
  const profile = path.join(temp, 'profile')
  const vault = path.join(temp, '测试资料库')
  log(`profile ${profile}`)
  log(`output  ${path.relative(REPO, outDir)}`)

  const fixture = await harness.startFixtureServer()
  const results = []
  const failures = []
  const contrastByCombo = {}
  let session = null
  try {
    await harness.seedVault({ profile, vault, dataDir: temp, fixtureUrl: fixture.url, log })
    session = await harness.launch(profile)
    const supportsTransparency = await session.page.evaluate(() => typeof window.electronAPI.theme.setReduceTransparency === 'function')
    const transparencies = options.transparency ?? (supportsTransparency ? ['normal', 'reduced'] : ['normal'])
    for (const theme of options.themes) {
      for (const transparency of transparencies) {
        const combo = `${theme}-${transparency}`
        log(`\n${combo}`)
        session = await harness.ensureAppearance(profile, session, { theme, transparency: supportsTransparency ? transparency : null }, {})
        const ctx = { combo, outDir, results, failures, fixtureUrl: fixture.url }
        session = await runCombo(session, ctx, options)
        contrastByCombo[combo] = await session.page.evaluate(contrast)
        log(`  contrast — ${Object.entries(contrastByCombo[combo].values).map(([k, v]) => `${k} ${v}`).join(', ')}`)
      }
    }
  } finally {
    if (session) await harness.close(session.app)
    fixture.server.close()
    if (!options.keep) fs.rmSync(temp, { recursive: true, force: true })
  }

  const counts = tally(results, contrastByCombo)
  const verdict = []
  let failed = failures.length > 0
  if (failures.length) verdict.push(`${failures.length} step(s) failed — fix the script or the screen before trusting the counts`)
  if (options.budget && !options.quick) {
    const budget = readJson(BUDGET_PATH)
    if (options.writeBudget && !failures.length) {
      writeBudget(counts, budget)
      verdict.push(`budget written to ${path.relative(REPO, BUDGET_PATH)} (lower-only)`)
    } else {
      const { problems, lowerable } = compareBudget(counts, budget)
      if (problems.length) { failed = true; verdict.push(...problems) }
      if (lowerable.length) verdict.push(`can lower: ${lowerable.join('; ')} — run --write-budget`)
      if (!problems.length) verdict.push('within budget')
    }
  } else verdict.push('budget not checked (quick run or --no-budget)')
  writeReport(outDir, results, failures, contrastByCombo, counts, verdict)
  log(`\n${verdict.join('\n')}`)
  log(`report: ${path.relative(REPO, path.join(outDir, 'report.md'))}`)
  if (failed) process.exitCode = 1
}

main().catch(error => {
  console.error(error)
  process.exit(1)
})
