#!/usr/bin/env python3
import json
import os
import subprocess
import sys
import uuid
from pathlib import Path


SKILL_DIR = Path(__file__).resolve().parent.parent


def load_payload() -> dict:
    if "--payload-json" in sys.argv:
        idx = sys.argv.index("--payload-json")
        if idx + 1 < len(sys.argv):
            return json.loads(sys.argv[idx + 1])
    return {}


def emit(result: dict) -> None:
    path = os.environ.get("READY_SKILL_RESULT_PATH", "").strip()
    if path:
        Path(path).write_text(json.dumps(result, ensure_ascii=False, indent=2), encoding="utf-8")
    if result.get("logs", {}).get("stdout"):
        print(result["logs"]["stdout"])
    if result.get("logs", {}).get("stderr"):
        print(result["logs"]["stderr"], file=sys.stderr)


def find_latest(root: Path, name: str) -> Path | None:
    matches = sorted(root.rglob(name), key=lambda item: item.stat().st_mtime, reverse=True)
    return matches[0] if matches else None


def main() -> int:
    payload = load_payload()
    url = str(payload.get("url") or "").strip()
    if not url:
        emit({
            "ok": False,
            "status": "failed",
            "outputs": {},
            "artifacts": [],
            "logs": {"stdout": "", "stderr": ""},
            "error": {"message": "Missing url"},
        })
        return 1

    output_dir = Path(str(payload.get("outputDir") or (Path.home() / "video-analysis")).strip())
    output_dir.mkdir(parents=True, exist_ok=True)
    command = [
        sys.executable,
        str(SKILL_DIR / "scripts" / "pipeline_enhanced.py"),
        url,
        "-o",
        str(output_dir),
    ]
    if payload.get("sceneThreshold") is not None:
        command.extend(["--scene-threshold", str(payload["sceneThreshold"])])
    if payload.get("bestThreshold") is not None:
        command.extend(["--best-threshold", str(payload["bestThreshold"])])

    completed = subprocess.run(command, capture_output=True, text=True, cwd=str(SKILL_DIR))
    stdout = completed.stdout or ""
    stderr = completed.stderr or ""
    if completed.returncode != 0:
        emit({
            "ok": False,
            "status": "failed",
            "outputs": {"outputDir": str(output_dir)},
            "artifacts": [],
            "logs": {"stdout": stdout, "stderr": stderr},
            "error": {"message": stderr or stdout or "Pipeline failed"},
        })
        return 1

    scene_scores = find_latest(output_dir, "scene_scores.json")
    markdown_report = find_latest(output_dir, "详细分析报告.md") or find_latest(output_dir, "分析报告.md")
    if not scene_scores:
        emit({
            "ok": False,
            "status": "failed",
            "outputs": {"outputDir": str(output_dir)},
            "artifacts": [],
            "logs": {"stdout": stdout, "stderr": stderr},
            "error": {"message": "Missing scene_scores.json"},
        })
        return 1

    artifacts = [
        {
            "id": uuid.uuid4().hex,
            "label": "scene_scores",
            "kind": "file",
            "path": str(scene_scores),
            "mimeType": "application/json"
        }
    ]
    if markdown_report:
        artifacts.append({
            "id": uuid.uuid4().hex,
            "label": "analysis_report",
            "kind": "file",
            "path": str(markdown_report),
            "mimeType": "text/markdown"
        })

    emit({
        "ok": True,
        "status": "success",
        "outputs": {
            "outputDir": str(output_dir),
            "sceneScoresPath": str(scene_scores),
            "reportPath": str(markdown_report) if markdown_report else ""
        },
        "artifacts": artifacts,
        "logs": {"stdout": stdout, "stderr": stderr},
    })
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
