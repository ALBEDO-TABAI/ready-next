#!/usr/bin/env python3
"""共享文件 IO 原语：原子写 + JSON 读写。

此前 run_state.py / host_batching.py / openclaw_dispatch.py 各有一份
几乎相同的实现，统一收敛到这里。原子写用 same-directory tempfile +
os.replace，避免主控与 ai_analyzer 并发触碰同一状态文件时读到半截内容。
"""

from __future__ import annotations

import json
import os
import tempfile
from pathlib import Path
from typing import Any


def atomic_write_text(path: Path, text: str) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    fd, tmp_name = tempfile.mkstemp(prefix=path.name + ".", dir=str(path.parent))
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as handle:
            handle.write(text)
        os.replace(tmp_name, path)
    except Exception:
        try:
            os.unlink(tmp_name)
        except OSError:
            pass
        raise


def read_json(path: Path, default: Any = None) -> Any:
    if not path.exists():
        return default
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return default


def write_json_if_changed(path: Path, payload: Any) -> bool:
    """内容无变化时不落盘（保留 mtime，供 stale 检测等机制使用）。"""
    text = json.dumps(payload, ensure_ascii=False, indent=2) + "\n"
    return write_text_if_changed(path, text)


def write_text_if_changed(path: Path, text: str) -> bool:
    if path.exists():
        try:
            if path.read_text(encoding="utf-8") == text:
                return False
        except OSError:
            pass
    atomic_write_text(path, text)
    return True
