#!/usr/bin/env python3
import json
import os
import sys
from pathlib import Path


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
    print(result.get("logs", {}).get("stdout", ""))


def main() -> int:
    payload = load_payload()
    source_input = str(payload.get("input") or payload.get("sourceInput") or "").strip()
    if not source_input:
        emit({
            "ok": False,
            "status": "failed",
            "outputs": {},
            "artifacts": [],
            "logs": {"stdout": "", "stderr": ""},
            "error": {"message": "Missing input/sourceInput"},
        })
        return 1

    output_dir = str(payload.get("outputDir") or (Path.home() / "video-analysis")).strip()
    Path(output_dir).mkdir(parents=True, exist_ok=True)
    result = {
        "ok": True,
        "status": "success",
        "outputs": {
            "sourceInput": source_input,
            "outputDir": output_dir,
            "model": payload.get("model") or "medium",
            "language": payload.get("language") or "auto",
            "forceSubtitleMode": payload.get("forceSubtitleMode") or "auto",
        },
        "artifacts": [],
        "logs": {
            "stdout": f"Prepared input: {source_input}\nOutput directory: {output_dir}",
            "stderr": "",
        },
    }
    emit(result)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
