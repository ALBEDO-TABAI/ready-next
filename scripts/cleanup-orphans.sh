#!/usr/bin/env bash
# cleanup-orphans.sh — kill leftover Ready subprocesses (Python sidecar + Puppeteer Chrome)
#
# Run after a Ready force-quit / freeze / crash to reap orphaned children.
# Safe: only kills processes spawned by THIS Ready install (worktree path or
# `~/Library/Application Support/ready/puppeteer-cache`).
#
# Usage: bash scripts/cleanup-orphans.sh [--dry-run]
set -uo pipefail

DRY_RUN=0
if [[ "${1:-}" == "--dry-run" ]]; then DRY_RUN=1; fi

WORKTREE_PATH="${WORKTREE_PATH:-/Users/user/Documents/实验田/ready-cowork}"
PUPPETEER_CACHE="$HOME/Library/Application Support/ready/puppeteer-cache"

echo "=== Ready orphan reaper ==="
[[ $DRY_RUN -eq 1 ]] && echo "(dry-run; no kills)"

# 1) Python sidecars from the Ready repo tree
SIDECAR_PATTERN="ready_sidecar/main.py"
SIDECAR_PIDS=$(pgrep -f "$SIDECAR_PATTERN" 2>/dev/null || true)
SIDECAR_COUNT=$(echo "$SIDECAR_PIDS" | grep -c . || true)
echo "[sidecar] pattern='$SIDECAR_PATTERN' found=$SIDECAR_COUNT"
if [[ -n "$SIDECAR_PIDS" && $DRY_RUN -eq 0 ]]; then
  echo "$SIDECAR_PIDS" | xargs -n1 kill -9 2>/dev/null || true
  echo "[sidecar] killed"
fi

# 2) Puppeteer Chrome instances from Ready's puppeteer-cache
CHROME_PATTERN="$PUPPETEER_CACHE"
CHROME_PIDS=$(pgrep -f "Chrome for Testing.app.*$PUPPETEER_CACHE" 2>/dev/null || true)
# pgrep -f matches against full command line; the path itself is enough
CHROME_PIDS_BROAD=$(pgrep -f "$PUPPETEER_CACHE/chrome" 2>/dev/null || true)
CHROME_PIDS=$(printf '%s\n%s\n' "$CHROME_PIDS" "$CHROME_PIDS_BROAD" | sort -u | grep -E '^[0-9]+$' || true)
CHROME_COUNT=$(echo "$CHROME_PIDS" | grep -c . || true)
echo "[chrome] pattern='$PUPPETEER_CACHE/chrome' found=$CHROME_COUNT"
if [[ -n "$CHROME_PIDS" && $DRY_RUN -eq 0 ]]; then
  echo "$CHROME_PIDS" | xargs -n1 kill -9 2>/dev/null || true
  echo "[chrome] killed"
fi

# 3) Orphan rsshub-worker.mjs from this worktree
RSSHUB_PATTERN="$WORKTREE_PATH.*rsshub-worker.mjs"
RSSHUB_PIDS=$(pgrep -f "$RSSHUB_PATTERN" 2>/dev/null || true)
RSSHUB_COUNT=$(echo "$RSSHUB_PIDS" | grep -c . || true)
echo "[rsshub] pattern='*$WORKTREE_PATH*rsshub-worker.mjs' found=$RSSHUB_COUNT"
if [[ -n "$RSSHUB_PIDS" && $DRY_RUN -eq 0 ]]; then
  echo "$RSSHUB_PIDS" | xargs -n1 kill -9 2>/dev/null || true
  echo "[rsshub] killed"
fi

echo "=== done ==="
