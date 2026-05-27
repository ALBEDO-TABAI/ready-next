#!/usr/bin/env python3
import json
import os
import sys
import uuid
from contextlib import redirect_stderr, redirect_stdout
from io import StringIO
from pathlib import Path
from typing import Optional


SKILL_DIR = Path(__file__).resolve().parent.parent
SCRIPTS_DIR = SKILL_DIR / "scripts"
VIDEO_EXTENSIONS = [".mp4", ".mov", ".mkv", ".avi", ".webm", ".m4v", ".flv"]

sys.path.insert(0, str(SKILL_DIR))
sys.path.insert(0, str(SCRIPTS_DIR))

from main import download_video, extract_video_id, is_url  # noqa: E402
from extract_subtitle_funasr import extract_with_funasr, smart_subtitle_extraction  # noqa: E402


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


def find_existing_video_for_input(source_input: str, output_dir: Path) -> Optional[Path]:
    if not is_url(source_input):
        video_path = Path(source_input).expanduser()
        return video_path.resolve() if video_path.exists() and video_path.is_file() else None
    video_id = extract_video_id(source_input)
    matches = []
    for ext in VIDEO_EXTENSIONS:
        matches.extend(output_dir.glob(f"{video_id}{ext}"))
    matches = sorted(
        [item for item in matches if item.is_file() and item.stat().st_size > 0],
        key=lambda item: item.stat().st_mtime,
        reverse=True,
    )
    return matches[0] if matches else None


def find_existing_srt_for_video(video_path: Path, output_dir: Path) -> Optional[Path]:
    video_mtime = video_path.stat().st_mtime
    matches = list(output_dir.glob(f"{video_path.stem}.srt"))
    matches.extend(output_dir.glob(f"{video_path.stem}_*.srt"))
    matches = sorted(
        [
            item for item in matches
            if item.is_file()
            and item.stat().st_size > 0
            and item.stat().st_mtime >= video_mtime
        ],
        key=lambda item: item.stat().st_mtime,
        reverse=True,
    )
    return matches[0] if matches else None


def find_transcript_for_srt(srt_path: Path) -> Optional[Path]:
    transcript_path = srt_path.with_name(f"{srt_path.stem}_文字稿.md")
    return transcript_path if transcript_path.is_file() and transcript_path.stat().st_size > 0 else None


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


def resolve_video(source_input: str, output_dir: Path) -> Path:
    if is_url(source_input):
        existing_video = find_existing_video_for_input(source_input, output_dir)
        if existing_video:
            return existing_video
        video_path = download_video(source_input, output_dir)
        if not video_path:
            raise RuntimeError("Video download failed")
        return Path(video_path)

    video_path = Path(source_input).expanduser()
    if not video_path.exists() or not video_path.is_file():
        raise RuntimeError(f"Video file does not exist: {source_input}")
    return video_path.resolve()


def main() -> int:
    payload = load_payload()
    source_input = str(payload.get("sourceInput") or payload.get("input") or "").strip()
    output_dir = Path(str(payload.get("outputDir") or (Path.home() / "video-analysis")).strip())
    output_dir.mkdir(parents=True, exist_ok=True)
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

    stdout_buffer = StringIO()
    stderr_buffer = StringIO()
    try:
        with redirect_stdout(stdout_buffer), redirect_stderr(stderr_buffer):
            video_path = resolve_video(source_input, output_dir)
            existing_srt_path = find_existing_srt_for_video(video_path, output_dir)
            subtitle_mode = "cached"
            if existing_srt_path:
                srt_path = existing_srt_path
            else:
                srt_path = output_dir / f"{video_path.stem}_{uuid.uuid4().hex[:8]}.srt"
                if force_mode == "funasr":
                    success = extract_with_funasr(str(video_path), str(srt_path))
                    subtitle_mode = "funasr" if success else "failed"
                else:
                    video_url = source_input if is_url(source_input) else ""
                    success, subtitle_mode = smart_subtitle_extraction(str(video_path), str(srt_path), video_url)
                if not success:
                    raise RuntimeError("Subtitle extraction failed")

        stdout = stdout_buffer.getvalue()
        stderr = stderr_buffer.getvalue()

        if not srt_path or not srt_path.exists():
            raise RuntimeError("Missing generated SRT file")
        video_path = video_path.resolve()
        transcript_path = find_transcript_for_srt(srt_path)
        if not transcript_path:
            transcript_path = build_transcript_from_srt(srt_path)
        if not transcript_path or not transcript_path.exists():
            raise RuntimeError("Missing generated transcript file")
        if not video_path or not video_path.exists():
            raise RuntimeError("Missing resolved video file")

        emit({
            "ok": True,
            "status": "success",
            "outputs": {
                "sourceInput": source_input,
                "outputDir": str(output_dir),
                "videoPath": str(video_path),
                "srtPath": str(srt_path),
                "transcriptPath": str(transcript_path),
                "forceSubtitleMode": force_mode,
                "subtitleEngine": subtitle_mode,
                "asrEngine": "funasr",
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
                    "label": "source_video",
                    "kind": "file",
                    "path": str(video_path),
                    "mimeType": "video/mp4"
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
        stdout = stdout_buffer.getvalue()
        stderr = stderr_buffer.getvalue()
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
