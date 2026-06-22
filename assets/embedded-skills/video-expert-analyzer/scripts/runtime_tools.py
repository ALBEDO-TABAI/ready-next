#!/usr/bin/env python3
from __future__ import annotations

import os
import shutil
import sys
from pathlib import Path


def resolve_tool_binary(binary_name: str) -> str:
    found = shutil.which(binary_name)
    if found:
        return found

    suffixes = [".exe", ""] if sys.platform == "win32" else [""]
    roots: list[Path] = []
    packaged_root = os.environ.get("READY_PACKAGED_SKILL_RUNTIME_ROOT", "").strip()
    if packaged_root:
        packaged = Path(packaged_root)
        roots.append(packaged / "bin")
        roots.append(packaged / "python" / ("Scripts" if sys.platform == "win32" else "bin"))

    try:
        roots.append(Path(sys.executable).resolve().parent)
    except OSError:
        pass

    if sys.platform == "darwin":
        roots.extend(Path(p) for p in ("/opt/homebrew/bin", "/usr/local/bin", "/usr/bin", "/bin"))
    elif sys.platform != "win32":
        roots.extend(Path(p) for p in ("/usr/local/bin", "/usr/bin", "/bin"))

    for root in roots:
        for suffix in suffixes:
            candidate = root / f"{binary_name}{suffix}"
            if candidate.is_file() and os.access(candidate, os.X_OK):
                return str(candidate)
    return binary_name
