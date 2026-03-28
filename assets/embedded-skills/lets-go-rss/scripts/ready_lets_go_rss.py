#!/usr/bin/env python3
import json
import os
import subprocess
import sys
import uuid
from pathlib import Path


SKILL_DIR = Path(__file__).resolve().parent.parent
ASSETS_DIR = SKILL_DIR / "assets"


def load_payload() -> tuple[str, dict]:
    action = ""
    if "--action" in sys.argv:
        idx = sys.argv.index("--action")
        if idx + 1 < len(sys.argv):
            action = sys.argv[idx + 1]
    payload = {}
    if "--payload-json" in sys.argv:
        idx = sys.argv.index("--payload-json")
        if idx + 1 < len(sys.argv):
            payload = json.loads(sys.argv[idx + 1])
    return action, payload


def emit(result: dict) -> None:
    path = os.environ.get("READY_SKILL_RESULT_PATH", "").strip()
    if path:
        Path(path).write_text(json.dumps(result, ensure_ascii=False, indent=2), encoding="utf-8")
    if result.get("logs", {}).get("stdout"):
        print(result["logs"]["stdout"])
    if result.get("logs", {}).get("stderr"):
        print(result["logs"]["stderr"], file=sys.stderr)


def build_command(action: str, payload: dict) -> list[str]:
    command = [sys.executable, str(SKILL_DIR / "scripts" / "lets_go_rss.py")]
    if action == "rss_add":
      command.extend(["--add", str(payload.get("url") or ""), "--skip-setup"])
    elif action == "rss_update":
      command.extend(["--update", "--skip-setup"])
      if payload.get("digest", True):
          command.append("--digest")
      if payload.get("noLlm", True):
          command.append("--no-llm")
    elif action == "rss_status":
      command.append("--status")
    elif action == "rss_list":
      command.extend(["--list", "--skip-setup"])
    elif action == "rss_stats":
      command.extend(["--stats", "--skip-setup"])
    else:
      raise ValueError(f"Unsupported action: {action}")
    return command


def main() -> int:
    action, payload = load_payload()
    try:
        command = build_command(action, payload)
    except Exception as error:
        emit({
            "ok": False,
            "status": "failed",
            "outputs": {},
            "artifacts": [],
            "logs": {"stdout": "", "stderr": ""},
            "error": {"message": str(error)},
        })
        return 1

    completed = subprocess.run(command, capture_output=True, text=True, cwd=str(SKILL_DIR))
    stdout = completed.stdout or ""
    stderr = completed.stderr or ""
    report_path = ASSETS_DIR / "latest_update.md"
    outputs = {"reportPath": str(report_path)} if report_path.exists() else {}
    artifacts = []
    if report_path.exists():
        artifacts.append({
            "id": uuid.uuid4().hex,
            "label": "rss_latest_report",
            "kind": "file",
            "path": str(report_path),
            "mimeType": "text/markdown"
        })
    emit({
        "ok": completed.returncode == 0,
        "status": "success" if completed.returncode == 0 else "failed",
        "outputs": outputs,
        "artifacts": artifacts,
        "logs": {"stdout": stdout, "stderr": stderr},
        "error": None if completed.returncode == 0 else {"message": stderr or stdout or f"{action} failed"},
    })
    return 0 if completed.returncode == 0 else 1


if __name__ == "__main__":
    raise SystemExit(main())
