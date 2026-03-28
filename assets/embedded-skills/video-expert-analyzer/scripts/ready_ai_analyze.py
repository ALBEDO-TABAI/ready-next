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


def find_latest(root: Path, suffix: str) -> Path | None:
    matches = sorted(root.rglob(f"*{suffix}"), key=lambda item: item.stat().st_mtime, reverse=True)
    return matches[0] if matches else None


def main() -> int:
    payload = load_payload()
    scene_scores_path = str(payload.get("sceneScoresPath") or "").strip()
    mode = str(payload.get("mode") or "agent").strip() or "agent"
    if not scene_scores_path:
        emit({
            "ok": False,
            "status": "failed",
            "outputs": {},
            "artifacts": [],
            "logs": {"stdout": "", "stderr": ""},
            "error": {"message": "Missing sceneScoresPath"},
        })
        return 1

    command = [
        sys.executable,
        str(SKILL_DIR / "scripts" / "ai_analyzer.py"),
        scene_scores_path,
        "--mode",
        mode,
    ]
    completed = subprocess.run(command, capture_output=True, text=True, cwd=str(SKILL_DIR), env=os.environ.copy())
    stdout = completed.stdout or ""
    stderr = completed.stderr or ""
    if completed.returncode != 0:
        emit({
            "ok": False,
            "status": "failed",
            "outputs": {},
            "artifacts": [],
            "logs": {"stdout": stdout, "stderr": stderr},
            "error": {"message": stderr or stdout or "AI analyze failed"},
        })
        return 1

    root = Path(scene_scores_path).parent
    summary = find_latest(root, ".md")
    artifacts = []
    outputs = {}
    if summary:
        artifacts.append({
            "id": uuid.uuid4().hex,
            "label": "ai_visual_summary",
            "kind": "file",
            "path": str(summary),
            "mimeType": "text/markdown"
        })
        outputs["summaryPath"] = str(summary)

    emit({
        "ok": True,
        "status": "success",
        "outputs": outputs,
        "artifacts": artifacts,
        "logs": {"stdout": stdout, "stderr": stderr},
    })
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
