#!/usr/bin/env python3
"""Tiny echo script for the test-host-contract fixture skill.

Reads a JSON payload from stdin (Ready's `inputMode: 'json'` contract) and
prints a single JSON status line so the host can parse it. The fixture skill
is never actually invoked by product code — the test suite owns it.
"""

from __future__ import annotations

import json
import sys


def main() -> int:
    raw = sys.stdin.read()
    try:
        payload = json.loads(raw) if raw.strip() else {}
    except json.JSONDecodeError:
        payload = {}
    message = payload.get("message", "")
    print(json.dumps({"state": "done", "message": message}))
    return 0


if __name__ == "__main__":
    sys.exit(main())
