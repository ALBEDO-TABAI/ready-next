const assert = require('node:assert/strict')
const { execFileSync } = require('node:child_process')
const test = require('node:test')

test('VEA OpenClaw probe retries single images when multi-image request fails', () => {
  const code = String.raw`
import json
import sys
import tempfile
from pathlib import Path

repo = Path.cwd()
scripts_dir = repo / "assets" / "embedded-skills" / "video-expert-analyzer" / "scripts"
sys.path.insert(0, str(scripts_dir))

import openclaw_batch_probe as probe

tmp = Path(tempfile.mkdtemp())
paths = {}
for label in ("primary", "start", "mid", "end"):
    path = tmp / f"{label}.jpg"
    path.write_bytes(b"fake-jpeg")
    paths[label] = str(path)

calls = []

def fake_call(provider_config, model_config, prompt, image_paths):
    calls.append([label for label, _ in image_paths])
    if len(image_paths) > 1:
        raise RuntimeError("Multimodal data is corrupted or cannot be processed.")
    return json.dumps({
        "type_classification": "TYPE-B Narrative",
        "description": "fallback ok",
        "visual_summary": "single frame fallback",
        "storyboard": {
            "shot_size": "中景",
            "lighting": "自然光",
            "camera_movement": "静止镜头",
            "visual_style": "纪实",
            "technique": "单帧判断"
        },
        "scores": {
            "aesthetic_beauty": 6,
            "credibility": 7,
            "impact": 6,
            "memorability": 6,
            "fun_interest": 5
        },
        "selection_reasoning": "ok",
        "edit_suggestion": "ok"
    })

probe._call_openai_responses = fake_call

result = probe.analyze_scene_with_attempts(
    {
        "scene_number": 40,
        "batch_id": "batch-007",
        "frames": paths,
        "hints": {},
    },
    attempts=[{
        "model_ref": "provider/model",
        "provider_config": {"baseUrl": "http://example.invalid", "apiKey": "x"},
        "model_config": {"id": "model", "input": ["text", "image"]},
        "declared_image_support": True,
        "api_style": "openai-responses",
    }],
    total_scenes=127,
)

assert result["scene_result"]["scene_number"] == 40
assert calls == [["primary", "start", "mid", "end"], ["primary"]], calls
assert result["attempts"][0]["image_set"] == "all"
assert result["attempts"][0]["ok"] is False
assert result["attempts"][1]["image_set"] == "primary-only"
assert result["attempts"][1]["ok"] is True
`

  execFileSync('python3', ['-c', code], {
    cwd: process.cwd(),
    stdio: 'pipe',
  })
  assert.ok(true)
})

test('VEA OpenClaw probe does not retry the same single-image payload', () => {
  const code = String.raw`
import json
import sys
import tempfile
from pathlib import Path

repo = Path.cwd()
scripts_dir = repo / "assets" / "embedded-skills" / "video-expert-analyzer" / "scripts"
sys.path.insert(0, str(scripts_dir))

import openclaw_batch_probe as probe

tmp = Path(tempfile.mkdtemp())
image_path = tmp / "primary.jpg"
image_path.write_bytes(b"fake-jpeg")

calls = []

def fake_call(provider_config, model_config, prompt, image_paths):
    calls.append([label for label, _ in image_paths])
    raise RuntimeError("single image failed")

probe._call_openai_responses = fake_call

try:
    probe.analyze_scene_with_attempts(
        {
            "scene_number": 1,
            "batch_id": "batch-001",
            "frames": {"primary": str(image_path)},
            "hints": {},
        },
        attempts=[{
            "model_ref": "provider/model",
            "provider_config": {"baseUrl": "http://example.invalid", "apiKey": "x"},
            "model_config": {"id": "model", "input": ["text", "image"]},
            "declared_image_support": True,
            "api_style": "openai-responses",
        }],
        total_scenes=1,
    )
except probe.ProbeFailure as exc:
    assert calls == [["primary"]], calls
    assert len(exc.attempts) == 1
    assert exc.attempts[0]["image_set"] == "all"
    assert exc.attempts[0]["image_count"] == 1
else:
    raise AssertionError("expected ProbeFailure")
`

  execFileSync('python3', ['-c', code], {
    cwd: process.cwd(),
    stdio: 'pipe',
  })
  assert.ok(true)
})
