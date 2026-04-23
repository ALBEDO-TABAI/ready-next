#!/usr/bin/env python3
"""
B Phase 3 — Compat adapter for legacy production callers.

The skill-runtime invokes Python actions with the contract:
    python <entry> [...baseArgs] --payload-json '{"key":"value",...}'

Two legacy actions stay alive for non-LLM callers (RSS visual analysis in
`src/main/modules/rss-engine/item-analysis-manager.ts`):
    - video_expert_pipeline    : { url, outputDir?, sceneThreshold?, bestThreshold? }
    - video_expert_ai_analyze  : { sceneScoresPath, mode? }

This adapter maps that JSON payload onto the vnext orchestrator
(`scripts/orchestrate_vnext.py`) which uses positional + flag CLI args.

LLM-driven callers go through SKILL.md (reference action) and pick
flags themselves — they never reach this adapter.
"""

from __future__ import annotations

import json
import os
import subprocess
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
ORCHESTRATOR = HERE / "orchestrate_vnext.py"


def _parse_args(argv: list[str]) -> tuple[str, dict]:
    action = ""
    payload: dict = {}
    if "--action" in argv:
        idx = argv.index("--action")
        if idx + 1 < len(argv):
            action = argv[idx + 1]
    if "--payload-json" in argv:
        idx = argv.index("--payload-json")
        if idx + 1 < len(argv):
            try:
                payload = json.loads(argv[idx + 1])
            except json.JSONDecodeError as exc:
                sys.stderr.write(f"ready_compat: invalid --payload-json: {exc}\n")
                sys.exit(2)
    return action, payload


def _build_pipeline_cmd(payload: dict) -> list[str]:
    source = (payload.get("url") or payload.get("source") or "").strip()
    if not source:
        sys.stderr.write("ready_compat: video_expert_pipeline requires `url`\n")
        sys.exit(2)
    cmd: list[str] = [sys.executable, str(ORCHESTRATOR), source]
    output_dir = payload.get("outputDir")
    if output_dir:
        cmd += ["-o", str(output_dir)]
    if payload.get("sceneThreshold") is not None:
        cmd += ["--scene-threshold", str(payload["sceneThreshold"])]
    if payload.get("bestThreshold") is not None:
        cmd += ["--best-threshold", str(payload["bestThreshold"])]
    return cmd


def _build_ai_analyze_cmd(payload: dict) -> list[str]:
    scores = (payload.get("sceneScoresPath") or payload.get("source") or "").strip()
    if not scores:
        sys.stderr.write("ready_compat: video_expert_ai_analyze requires `sceneScoresPath`\n")
        sys.exit(2)
    # vnext orchestrator auto-detects scene_scores.json source and
    # picks `--mode auto` internally; legacy `mode` payload is ignored.
    return [sys.executable, str(ORCHESTRATOR), scores]


def main() -> int:
    action, payload = _parse_args(sys.argv[1:])
    if action == "video_expert_pipeline":
        cmd = _build_pipeline_cmd(payload)
    elif action == "video_expert_ai_analyze":
        cmd = _build_ai_analyze_cmd(payload)
    else:
        sys.stderr.write(
            f"ready_compat: unsupported --action {action!r}; "
            "expected video_expert_pipeline | video_expert_ai_analyze\n"
        )
        return 2
    return subprocess.call(cmd, env=os.environ.copy())


if __name__ == "__main__":
    sys.exit(main())
