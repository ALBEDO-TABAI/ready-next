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


def find_latest(path: Path, suffix: str) -> Path | None:
    matches = sorted(path.glob(f"*{suffix}"), key=lambda item: item.stat().st_mtime, reverse=True)
    return matches[0] if matches else None


def build_transcript_from_srt(srt_path: Path) -> Path:
    transcript_path = srt_path.with_name(f"{srt_path.stem}_文字稿.md")
    lines = []
    for line in srt_path.read_text(encoding="utf-8", errors="ignore").splitlines():
        stripped = line.strip()
        if not stripped or stripped.isdigit() or "-->" in stripped:
            continue
        lines.append(stripped)
    transcript_path.write_text(
        "# 视频语音转录文字稿\n\n## 正文\n\n" + "\n".join(lines) + "\n",
        encoding="utf-8",
    )
    return transcript_path


def main() -> int:
    payload = load_payload()
    source_input = str(payload.get("sourceInput") or payload.get("input") or "").strip()
    output_dir = Path(str(payload.get("outputDir") or (Path.home() / "video-analysis")).strip())
    output_dir.mkdir(parents=True, exist_ok=True)
    model = str(payload.get("model") or "medium").strip() or "medium"
    language = str(payload.get("language") or "auto").strip() or "auto"
    force_mode = str(payload.get("forceSubtitleMode") or "auto").strip() or "auto"
    if not source_input:
        emit({
            "ok": False,
            "status": "failed",
            "outputs": {},
            "artifacts": [],
            "logs": {"stdout": "", "stderr": ""},
            "error": {"message": "Missing sourceInput/input"},
        })
        return 1

    stdout = ""
    stderr = ""
    try:
        if force_mode == "funasr" and Path(source_input).exists():
            srt_path = output_dir / f"{Path(source_input).stem}_{uuid.uuid4().hex[:8]}.srt"
            command = [
                sys.executable,
                str(SKILL_DIR / "scripts" / "extract_subtitle_funasr.py"),
                source_input,
                str(srt_path),
                source_input,
            ]
        else:
            command = [
                sys.executable,
                str(SKILL_DIR / "main.py"),
                source_input,
                str(output_dir),
                model,
                language,
            ]
        completed = subprocess.run(command, capture_output=True, text=True, cwd=str(SKILL_DIR))
        stdout = completed.stdout or ""
        stderr = completed.stderr or ""
        if completed.returncode != 0:
            raise RuntimeError(stderr or stdout or "Subtitle extraction failed")

        srt_path = find_latest(output_dir, ".srt")
        transcript_path = find_latest(output_dir, "_文字稿.md")
        if not transcript_path and srt_path and srt_path.exists():
            transcript_path = build_transcript_from_srt(srt_path)
        if not srt_path or not srt_path.exists():
            raise RuntimeError("Missing generated SRT file")
        if not transcript_path or not transcript_path.exists():
            raise RuntimeError("Missing generated transcript file")

        emit({
            "ok": True,
            "status": "success",
            "outputs": {
                "sourceInput": source_input,
                "outputDir": str(output_dir),
                "srtPath": str(srt_path),
                "transcriptPath": str(transcript_path),
                "forceSubtitleMode": force_mode,
            },
            "artifacts": [
                {
                    "id": uuid.uuid4().hex,
                    "label": "subtitle_srt",
                    "kind": "file",
                    "path": str(srt_path),
                    "mimeType": "application/x-subrip"
                },
                {
                    "id": uuid.uuid4().hex,
                    "label": "transcript_markdown",
                    "kind": "file",
                    "path": str(transcript_path),
                    "mimeType": "text/markdown"
                }
            ],
            "logs": {"stdout": stdout, "stderr": stderr},
        })
        return 0
    except Exception as error:
        emit({
            "ok": False,
            "status": "failed",
            "outputs": {"outputDir": str(output_dir)},
            "artifacts": [],
            "logs": {"stdout": stdout, "stderr": stderr},
            "error": {"message": str(error)},
        })
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
