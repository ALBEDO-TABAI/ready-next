import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, resolve } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'

import { runClipCurrentTab } from '../main/modules/browser-engine/ipc-clip'
import { skipIfSqliteUnavailable } from './utils/sqlite-skip'

test('obsidian-web-clip-current-tab-ipc declares transitive sqlite coverage', (t) => {
  skipIfSqliteUnavailable(t, 'obsidian-web-clip-current-tab-ipc transitive sqlite guard')
})

const __dirname = dirname(fileURLToPath(import.meta.url))
const repoRoot = resolve(__dirname, '../..')

function sanitizerOk(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    ok: true,
    html: `<!doctype html>
      <html>
        <head>
          <title>小红书测试笔记</title>
          <meta name="author" content="Ready Test" />
          <meta name="description" content="这是一条用于验证小红书剪藏的测试笔记。" />
        </head>
        <body>
          <main>
            <article>
              <h1>小红书测试笔记</h1>
              <p>这是一条用于验证小红书剪藏的测试笔记，包含足够长的正文，避免被当成空页面。</p>
              <p>剪藏应该保存当前页面内容，而不是因为小红书专用模板暂时需要智能整理就直接失败。</p>
            </article>
          </main>
        </body>
      </html>`,
    title: '小红书测试笔记',
    url: 'https://www.xiaohongshu.com/explore/test-note',
    finalUrl: 'https://www.xiaohongshu.com/explore/test-note',
    lang: 'zh-CN',
    stable: true,
    sanitizationSummary: {
      inputsStripped: 0,
      hiddenFieldsStripped: 0,
      textareasStripped: 0,
      selectsStripped: 0,
      contentEditableStripped: 0,
      checkedToggled: 0,
      csrfMetasStripped: 0,
      iframesSkipped: 0,
    },
    ...overrides,
  }
}

test('current-tab Xiaohongshu clip falls back to article when the matched preset needs an interpreter', async () => {
  const outputsRoot = mkdtempSync(resolve(tmpdir(), 'ready-xhs-clip-'))
  try {
    const result = await runClipCurrentTab(
      {
        getActiveTab: () => ({
          id: 'tab-xhs',
          url: 'https://www.xiaohongshu.com/explore/test-note',
          title: '小红书测试笔记',
          domain: 'www.xiaohongshu.com',
        }),
        executeJS: async () => sanitizerOk(),
      },
      {},
      {
        getRuntimeInfo: () => ({
          skillsRoot: resolve(repoRoot, 'assets/embedded-skills'),
          outputsRoot,
        }),
      },
    )

    assert.equal(result.ok, true)
    assert.equal(result.preset?.id, 'article-clipper')
    assert.ok(result.warnings?.includes('preset_requires_interpreter_fallback_to_article'))
    assert.ok(result.savedPath)
    assert.ok(existsSync(result.savedPath))
    const markdown = readFileSync(result.savedPath, 'utf8')
    assert.match(markdown, /小红书测试笔记/)
    assert.match(markdown, /保存当前页面内容/)
  } finally {
    rmSync(outputsRoot, { recursive: true, force: true })
  }
})
