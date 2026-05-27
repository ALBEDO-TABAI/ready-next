#!/usr/bin/env python3
"""
Compatibility transcription entry for the Ready embedded skill.

The embedded skill uses FunASR only. Older callers may still pass
model/language/device positional arguments; this entry accepts those arguments
and ignores them so the invocation continues through the supported path.
"""

import sys
from pathlib import Path


SCRIPT_DIR = Path(__file__).resolve().parent
sys.path.insert(0, str(SCRIPT_DIR))

from extract_subtitle_funasr import extract_with_funasr  # noqa: E402


def main() -> int:
    if len(sys.argv) < 3 or sys.argv[1] in ["-h", "--help"]:
        print("用法: python transcribe_audio.py <视频路径> <输出SRT路径> [兼容参数...]")
        print("说明: Ready 内置版本仅使用 FunASR，额外兼容参数会被忽略。")
        return 0 if len(sys.argv) > 1 else 1

    video_path = sys.argv[1]
    output_srt = sys.argv[2]
    return 0 if extract_with_funasr(video_path, output_srt) else 1


if __name__ == "__main__":
    raise SystemExit(main())
