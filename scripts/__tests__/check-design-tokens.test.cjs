const { test } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { spawnSync } = require('node:child_process')

const script = path.resolve(__dirname, '../check-design-tokens.cjs')
function fixture(t, overrides = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'design-tokens-'))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  const put = (file, text) => {
    fs.mkdirSync(path.dirname(path.join(root, file)), { recursive: true })
    fs.writeFileSync(path.join(root, file), text)
  }
  fs.mkdirSync(path.join(root, 'src/renderer'), { recursive: true })
  put('scripts/design-budget.json', JSON.stringify({
    directories: { styles: { color: 0, backdropFilter: 0, fontFace: 0 } },
    retired: {}, whitelist: [], retiredAllowFiles: [], ...overrides,
  }))
  const run = (...args) => spawnSync(process.execPath, [script, '--root', root, ...args], { encoding: 'utf8' })
  const readBudget = () => JSON.parse(fs.readFileSync(path.join(root, 'scripts/design-budget.json'), 'utf8'))
  return { root, put, run, readBudget }
}

test('新增颜色报出文件和行，JSON 是独立可解析的结果', t => {
  const { put, run } = fixture(t)
  put('src/renderer/styles/test.css', '.a {\n  color: #abc;\n}\n')
  const result = run()
  assert.equal(result.status, 1)
  assert.match(result.stderr, /styles \/ color \/ 1 \/ 0/)
  assert.match(result.stderr, /src\/renderer\/styles\/test.css:2/)
  const json = run('--json')
  assert.equal(json.status, 1)
  assert.equal(JSON.parse(json.stdout).totals.color, 1)
})

test('排除注释、令牌组合、无模糊值、选择器、URL、实体和测试；保留字符串中的颜色及行号', t => {
  const { put, run } = fixture(t)
  put('src/renderer/styles/test.css', `/* #fff rgb(1 2 3) @font-face backdrop-filter: blur(2px) */
#abc { --color: rgb(var(--x) / .5); backdrop-filter: none; -webkit-backdrop-filter: INITIAL !important;
background: url(https://example.com/#aabbcc); content: "&#123;"; }
`)
  put('src/renderer/styles/test.tsx', `// #fff @font-face data-skin
/* rgba(0,0,0,1) ThemeSkin */
const url = 'https://example.com/#abc';
const regex = /https?:\\/\\/example/;
const style = { backdropFilter: 'unset', WebkitBackdropFilter: 'inherit', color: 'rgb(var(--x) / .5)' };
const selector = document.querySelector('#abc');
const markup = <a href="#abc">{/* #fff */}</a>;
const template = \`url(https://example.com/#fff) \${'#123456'}\`;
const color = '#abcd'; // #fff
`)
  put('src/renderer/styles/__tests__/ignored.ts', 'const color = "#fff"; const ThemeSkin = 1')
  put('src/renderer/styles/ignored.test.tsx', 'const color = "#fff"')
  put('src/renderer/styles/ignored.d.ts', 'type Color = "#fff"')
  const result = JSON.parse(run('--json').stdout)
  assert.deepEqual(result.totals, { color: 2, backdropFilter: 0, fontFace: 0 })
  assert.equal(result.retired['data-skin'], 0)
  assert.equal(result.retired.ThemeSkin, 0)
  assert.deepEqual(result.locations.filter(hit => hit.metric === 'color').map(hit => hit.line), [8, 9])
})

test('统计全部颜色函数、CSS/JS 模糊属性和 HTML 内样式，不把 HTML 片段当颜色', t => {
  const { put, run } = fixture(t)
  put('src/renderer/styles/test.css', `.a { color: #abc; --x: #abcd; border-color: #abcdef; background: #abcdef12;
box-shadow: ${['rgb', 'rgba', 'hsl', 'hsla', 'hwb', 'lab', 'lch', 'oklab', 'oklch', 'color'].map(fn => `${fn}(1 2 3)`).join(',')};
backdrop-filter: blur(4px); -webkit-backdrop-filter: blur(4px); }
@font-face { font-family: test; src: url(test.woff2); }`)
  put('src/renderer/styles/test.jsx', `const style = { backdropFilter: 'blur(4px)', ['WebkitBackdropFilter']: 'blur(4px)' };
style.backdropFilter = 'blur(2px)'; style['WebkitBackdropFilter'] = 'inherit';
const css = \`#abc { backdrop-filter: blur(2px); }\`;`)
  put('src/renderer/index.html', `<!-- #fff data-skin --><a href="#abc" id="abc">&#123;</a>
<style>#abc { color: #fff; backdrop-filter: none }</style>
<div style="color: #fff; backdrop-filter: blur(2px)"></div>
<script>/* #fff ThemeSkin */ const url = 'https://example.com/#abc'; const color = '#fff';</script>`)
  const result = JSON.parse(run('--json').stdout)
  assert.deepEqual(result.totals, { color: 17, backdropFilter: 7, fontFace: 1 })
  assert.equal(result.retired['data-skin'], 0)
  assert.equal(result.retired.ThemeSkin, 0)
  // This gate counts declarations even when an unrelated selector is malformed.
  put('src/renderer/styles/test.css', "html:is([data-theme='dark'] { color: #fff; }")
  assert.equal(JSON.parse(run('--json').stdout).directories.styles.color, 1)
})

test('--write 只降低预算，颜色、模糊、字体和退役标识超额都不被接纳', t => {
  const { put, run, readBudget } = fixture(t, { directories: { styles: { color: 0, backdropFilter: 0, fontFace: 0 }, removed: { color: 3, backdropFilter: 2, fontFace: 1 } }, retired: { ThemeSkin: 0, ThemeAccent: 4 } })
  put('src/renderer/styles/test.css', '.a { color: #fff; backdrop-filter: blur(3px) } @font-face { font-family: x }')
  put('src/main/theme.ts', 'const ThemeSkin = "x"')
  assert.equal(run('--write').status, 1)
  const budget = readBudget()
  assert.deepEqual(budget.directories.styles, { color: 0, backdropFilter: 0, fontFace: 0 })
  assert.deepEqual(budget.directories.removed, { color: 0, backdropFilter: 0, fontFace: 0 })
  assert.deepEqual(budget.retired, { ThemeSkin: 0, ThemeAccent: 0 })
})

test('新目录预算为零，--write 也不能接纳；首次无文件时才允许建基线', t => {
  const { root, put, run, readBudget } = fixture(t)
  put('src/renderer/new/component.ts', 'const color = "#123456"')
  assert.equal(run('--write').status, 1)
  assert.equal(readBudget().directories.new, undefined)
  fs.unlinkSync(path.join(root, 'scripts/design-budget.json'))
  assert.equal(run('--write').status, 0)
  assert.equal(readBudget().directories.new.color, 1)
  assert.equal(run().status, 0)
})

test('颜色白名单不豁免模糊和字体，每条必须有理由', t => {
  const { put, run } = fixture(t, { whitelist: [{ glob: 'src/renderer/styles/**', reason: 'fixture palette' }] })
  put('src/renderer/styles/test.css', '.a { color: #fff; backdrop-filter: blur(3px) } @font-face { font-family: x }')
  const result = run('--json')
  assert.equal(result.status, 1)
  assert.deepEqual(JSON.parse(result.stdout).totals, { color: 0, backdropFilter: 1, fontFace: 1 })
  put('scripts/design-budget.json', JSON.stringify({ directories: {}, retired: {}, retiredAllowFiles: [], whitelist: [{ glob: '**' }] }))
  assert.match(run().stderr, /reason/)
})

test('退役标识扫描 main/shared/renderer，按完整名称计数并排除允许文件及测试', t => {
  const { put, run } = fixture(t, { retiredAllowFiles: ['src/main/migrate.ts'] })
  put('src/main/migrate.ts', 'const key = "ready-theme-accent"; type ThemeSkin = string')
  put('src/shared/theme.ts', 'type ThemeAccent = string; const resetAccent = 1; const setAccent = 2')
  put('src/renderer/index.html', '<div data-skin="x" data-glass-variant="x" data-glass-backdrop="x" data-accent="x"></div>')
  put('src/renderer/theme.ts', 'const keys = ["ready-theme-accent", "ready-theme-skin"]; const accentPalettes = {}; type ThemeSkin = string')
  put('src/__tests__/ignored.ts', 'type ThemeSkin = string')
  const result = run('--json')
  assert.equal(result.status, 1)
  assert.deepEqual(Object.values(JSON.parse(result.stdout).retired), Array(10).fill(1))
  put('src/shared/theme.ts', '')
  put('src/renderer/index.html', '')
  put('src/renderer/theme.ts', '')
  assert.equal(run().status, 0)
})
