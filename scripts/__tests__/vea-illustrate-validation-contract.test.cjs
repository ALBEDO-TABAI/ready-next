const assert = require('node:assert/strict')
const { execFileSync } = require('node:child_process')
const path = require('node:path')
const test = require('node:test')

const repoRoot = path.resolve(__dirname, '..', '..')
const scriptsRoot = path.join(repoRoot, 'assets', 'embedded-skills', 'video-expert-analyzer', 'scripts')

test('VEA illustrate sanitizer removes nearby duplicate inserted screenshots before validation', () => {
  const python = `
import sys
sys.path.insert(0, ${JSON.stringify(scriptsRoot)})
from audiovisual.reporting import builder

original = "## 模块\\n\\nScene 008 建立品牌入口。\\n\\nScene 008 再次说明品牌揭示。\\n\\nScene 009 补充标题场景。"
illustrated = """## 模块

Scene 008 建立品牌入口。

![Scene 008](<frames/video-Scene-008.jpg>)

*Scene 008 · 画面：品牌入口*

Scene 008 再次说明品牌揭示。

![Scene 008](<frames/video-Scene-008.jpg>)

*Scene 008 · 画面：品牌入口*

Scene 009 补充标题场景。

![Scene 009](<frames/video-Scene-009.jpg>)
"""
catalog = [
  {"rel_path": "frames/video-Scene-008.jpg"},
  {"rel_path": "frames/video-Scene-009.jpg"},
]
cleaned = builder._remove_nearby_duplicate_inserted_images(illustrated, original)
builder._validate_illustrated_markdown(cleaned, original, catalog)
print(cleaned.count("frames/video-Scene-008.jpg"))
print("Scene 008 · 画面" in cleaned)
`
  const [count, hasCaption] = execFileSync('python3', ['-c', python], {
    encoding: 'utf8',
  }).trim().split('\n')
  assert.equal(count, '1')
  assert.equal(hasCaption, 'True')
})
