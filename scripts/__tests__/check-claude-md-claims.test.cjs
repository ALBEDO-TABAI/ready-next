const assert = require('node:assert/strict')
const { spawnSync } = require('node:child_process')
const { mkdirSync, mkdtempSync, rmSync, writeFileSync } = require('node:fs')
const { tmpdir } = require('node:os')
const { dirname, join, resolve } = require('node:path')
const test = require('node:test')

const {
  checkClaudeMdClaims,
} = require('../check-claude-md-claims.cjs')

const SCRIPT_PATH = resolve(__dirname, '../check-claude-md-claims.cjs')

test('accepts section 6.12-6.18 claims that exist in code', () => {
  withFixture(
    {
      'CLAUDE.md': docWithClaims([
        '- `ExistingFunction` 和 `READY_EXISTING_FLAG` 都有代码依据。',
        '- `src/main/modules/example.ts::ExistingFunction` 指向真实文件和符号。',
        '- `isXxxEnabled` 是文档里的占位写法。',
      ]),
      'AGENTS.md': docWithClaims([
        '- `ExistingFunction` 和 `READY_EXISTING_FLAG` 都有代码依据。',
      ]),
      'src/main/modules/example.ts': [
        'export const READY_EXISTING_FLAG = "1"',
        'export function ExistingFunction() {}',
        '',
      ].join('\n'),
    },
    (root) => {
      const result = checkClaudeMdClaims({ root })
      assert.equal(result.ok, true, result.errors.join('\n'))
    },
  )
})

test('accepts checked claims that point at renderer code', () => {
  withFixture(
    {
      'CLAUDE.md': docWithClaims([
        '- `RendererOnlyFunction` 是 UI 收口合同的一部分。',
      ]),
      'AGENTS.md': docWithClaims([]),
      'src/renderer/example.ts': 'export function RendererOnlyFunction() {}\n',
    },
    (root) => {
      const result = checkClaudeMdClaims({ root })
      assert.equal(result.ok, true, result.errors.join('\n'))
    },
  )
})

test('rejects a fake code claim inside section 6.12-6.18', () => {
  withFixture(
    {
      'CLAUDE.md': docWithClaims(['- `MissingFakeClaim` 不存在。']),
      'AGENTS.md': docWithClaims([]),
      'src/main/modules/example.ts': 'export function ExistingFunction() {}\n',
    },
    (root) => {
      const result = checkClaudeMdClaims({ root })
      assert.equal(result.ok, false)
      assert.match(result.errors.join('\n'), /CLAUDE\.md:\d+: undefined identifier 'MissingFakeClaim'/)
    },
  )
})

test('ignores code-like claims outside section 6.12-6.18', () => {
  withFixture(
    {
      'CLAUDE.md': ['### 6.11 其他', '- `MissingOutsideScope` 不检查。', '', '## 7. 结束', ''].join('\n'),
      'AGENTS.md': ['### 6.11 其他', '- `MissingOutsideScope` 不检查。', '', '## 7. 结束', ''].join('\n'),
      'src/main/modules/example.ts': 'export {}\n',
    },
    (root) => {
      const result = checkClaudeMdClaims({ root })
      assert.equal(result.ok, true, result.errors.join('\n'))
    },
  )
})

test('supports CLI --root', () => {
  withFixture(
    {
      'CLAUDE.md': docWithClaims(['- `ExistingFunction` 有代码依据。']),
      'AGENTS.md': docWithClaims([]),
      'src/main/modules/example.ts': 'export function ExistingFunction() {}\n',
    },
    (root) => {
      const result = spawnSync(process.execPath, [SCRIPT_PATH, '--root', root], {
        encoding: 'utf8',
      })
      assert.equal(result.status, 0, result.stderr)
      assert.match(result.stdout, /CLAUDE.md claims: ok/)
    },
  )
})

function withFixture(files, callback) {
  const root = mkdtempSync(join(tmpdir(), 'ready-claude-md-claims-'))
  try {
    for (const [file, text] of Object.entries(files)) {
      write(root, file, text)
    }
    return callback(root)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
}

function docWithClaims(lines) {
  return [
    '# Test Doc',
    '',
    '### 6.12 Skill 原语沙箱边界',
    ...lines,
    '',
    '### 6.18 提质 + 控制面',
    '',
    '## 7. 新功能开发最小闭环',
    '',
  ].join('\n')
}

function write(root, file, text) {
  const path = join(root, file)
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, text)
}
