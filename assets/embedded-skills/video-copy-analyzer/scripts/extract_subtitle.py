#!/usr/bin/env python3
"""
Compatibility subtitle extractor for the Ready embedded skill.

The supported extraction path is FunASR via extract_subtitle_funasr.py. This
file remains only so older script references keep working without opening a
second ASR path.
"""

import sys
from pathlib import Path
from typing import Optional, Tuple


SCRIPT_DIR = Path(__file__).resolve().parent
sys.path.insert(0, str(SCRIPT_DIR))

from extract_subtitle_funasr import extract_with_funasr  # noqa: E402


def extract_subtitles(video_path: str, output_srt: str, _video_url: Optional[str] = None) -> Tuple[bool, str]:
    ok = extract_with_funasr(video_path, output_srt)
    return ok, "funasr" if ok else "failed"


def main() -> int:
    if len(sys.argv) < 3 or sys.argv[1] in ["-h", "--help"]:
        print("用法: python extract_subtitle.py <视频路径> <输出SRT路径> [视频URL]")
        print("说明: Ready 内置版本仅使用 FunASR。")
        return 0 if len(sys.argv) > 1 else 1

    ok, engine = extract_subtitles(sys.argv[1], sys.argv[2], sys.argv[3] if len(sys.argv) > 3 else None)
    if ok:
        print(f"✅ 字幕提取完成: {sys.argv[2]} ({engine})")
        return 0
    print("❌ 字幕提取失败")
    return 1


if __name__ == "__main__":
    raise SystemExit(main())
