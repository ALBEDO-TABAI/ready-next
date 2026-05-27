const assert = require('node:assert/strict')
const { spawnSync } = require('node:child_process')
const path = require('node:path')
const test = require('node:test')

const repoRoot = path.resolve(__dirname, '..', '..')
const skillRoot = path.join(repoRoot, 'assets', 'embedded-skills', 'video-expert-analyzer')

function runPython(source) {
  const result = spawnSync('python3', ['-c', source], {
    cwd: skillRoot,
    env: {
      ...process.env,
      PYTHONPATH: path.join(skillRoot, 'scripts'),
    },
    encoding: 'utf8',
  })
  assert.equal(result.status, 0, result.stderr || result.stdout)
  return result.stdout.trim()
}

test('VEA prompt fidelity accepts Chinese scene evidence labels', () => {
  const output = runPython(`
from audiovisual.reporting import template_engine
text = "本节引用场景001、场景 002 和 Scene 003 作为证据。"
print(bool(template_engine._SCENE_EVIDENCE_RE.search(text)))
print(",".join(sorted(template_engine._distinct_scene_numbers(text))))
`)

  assert.equal(output, 'True\n1,2,3')
})

test('VEA audiovisual body appends real scene evidence before raw-prompt validation', () => {
  const output = runPython(`
from audiovisual.reporting import template_engine

data = {
    "scenes": [
        {"scene_number": 1, "timestamp_range": "00:00:00,000 --> 00:00:01,000", "description": "沙漠远景奔跑"},
        {"scene_number": 2, "timestamp_range": "00:00:01,000 --> 00:00:02,000", "description": "人物喘息特写"},
        {"scene_number": 3, "timestamp_range": "00:00:02,000 --> 00:00:03,000", "description": "产品标志亮相"},
    ]
}
body = """
## 视觉修辞语法
Scene 001（00:00:00,000）用于说明开场世界建构。

## 媒介语境与 Campaign 生态位分析
这一节讨论平台适配性与 Campaign 矩阵定位，但模型漏掉了场景证据。
""".strip()
report = template_engine._assemble_final_report(
    body,
    {"generated_at": "2026-05-25 00:00:00"},
    [],
    data,
    {"framework": "event_brand_ad", "route_label": "广告品牌片"},
    required_sections=["## 视觉修辞语法", "## 媒介语境与 Campaign 生态位分析"],
    source="raw_prompt",
    validation_rules={
        "require_scene_evidence_per_section": True,
        "min_scene_evidence_per_section": 3,
        "min_chars_per_section": 0,
        "min_subsection_chars": 0,
        "required_subsections": {},
        "section_anchor_terms": {},
    },
)
print("证据补充：Scene 001" in report)
print("Scene 003" in report)
`)

  assert.equal(output, 'True\nTrue')
})

test('VEA scene evidence repair canonicalizes quoted required headings first', () => {
  const output = runPython(`
from audiovisual.reporting import template_engine

data = {
    "scenes": [
        {"scene_number": 1, "timestamp_range": "00:00:00", "description": "A"},
        {"scene_number": 2, "timestamp_range": "00:00:01", "description": "B"},
        {"scene_number": 3, "timestamp_range": "00:00:02", "description": "C"},
    ]
}
body = "## 能量弧线与“高潮工程学”\\n这一节模型漏掉了场景证据。"
report = template_engine._assemble_final_report(
    body,
    {"generated_at": "2026-05-25 00:00:00"},
    [],
    data,
    {"framework": "event_brand_ad", "route_label": "广告品牌片"},
    required_sections=['## 能量弧线与"高潮工程学"'],
    source="raw_prompt",
    validation_rules={
        "require_scene_evidence_per_section": True,
        "min_scene_evidence_per_section": 3,
        "min_chars_per_section": 0,
        "min_subsection_chars": 0,
        "required_subsections": {},
        "section_anchor_terms": {},
    },
)
print('## 能量弧线与"高潮工程学"' in report)
print("证据补充：Scene 001" in report)
print("Scene 003" in report)
`)

  assert.equal(output, 'True\nTrue\nTrue')
})
