#!/usr/bin/env bash
# rescue-ready-db.sh — one-shot DB rescue for the 80GB ready.db crisis.
#
# 1) Backup ready.db to ready.db.bak.<timestamp>
# 2) DROP documents + dependent tables (FTS5 takes 84GB of the 86GB total)
# 3) DELETE workspaces (so no Home root auto-loads on next launch)
# 4) DELETE chat_messages older than 5 days (preserve recent + RSS sources + settings)
# 5) VACUUM to reclaim disk
#
# Pre-condition: Ready Electron must be FULLY KILLED. Script aborts if it
# detects a running Ready process.
#
# Usage:
#   bash scripts/rescue-ready-db.sh [--no-backup] [--dry-run]
#
# After running: launch Ready, default workspace will be empty, search panel
# will not auto-reindex. Last 5 days of chat history + all RSS subscriptions
# preserved.
set -euo pipefail

DRY_RUN=0
NO_BACKUP=0
for arg in "$@"; do
  case "$arg" in
    --dry-run) DRY_RUN=1 ;;
    --no-backup) NO_BACKUP=1 ;;
    *) echo "unknown arg: $arg"; exit 2 ;;
  esac
done

DB="$HOME/Library/Application Support/ready/ready.db"
TS=$(date +%Y%m%d-%H%M%S)
BAK="${DB}.bak.${TS}"

echo "=== Ready DB rescue ==="

# Sanity: Ready not running
if pgrep -f 'electron-vite dev' > /dev/null || pgrep -f 'cowork.*Electron' > /dev/null; then
  echo "ABORT: Ready / electron-vite still running. Kill it first:"
  echo "  pkill -9 -f 'electron-vite dev'"
  exit 3
fi

if [[ ! -f "$DB" ]]; then
  echo "ABORT: $DB not found"
  exit 4
fi

ORIG_SIZE=$(stat -f %z "$DB" 2>/dev/null || stat -c %s "$DB")
ORIG_GB=$(echo "scale=2; $ORIG_SIZE/1024/1024/1024" | bc)
echo "[before] DB size: ${ORIG_GB} GB"

if [[ $DRY_RUN -eq 1 ]]; then
  echo "(dry-run; would back up to $BAK then run SQL below)"
fi

# Step 1: Backup
if [[ $NO_BACKUP -eq 0 ]]; then
  if [[ $DRY_RUN -eq 0 ]]; then
    echo "[1/4] Backup → $BAK (this can take 3-10 min on 80GB)"
    cp "$DB" "$BAK"
    BAK_SIZE=$(stat -f %z "$BAK" 2>/dev/null || stat -c %s "$BAK")
    [[ "$BAK_SIZE" == "$ORIG_SIZE" ]] || { echo "ABORT: backup size mismatch"; exit 5; }
    echo "[1/4] Backup OK ($(echo "scale=2; $BAK_SIZE/1024/1024/1024" | bc) GB)"
  else
    echo "[1/4] (skip backup — dry-run)"
  fi
else
  echo "[1/4] (skip backup — --no-backup)"
fi

# Step 2-4: Run SQL in a single sqlite3 invocation
SQL=$(cat <<'EOF'
PRAGMA foreign_keys = ON;
BEGIN;

-- Pre-state observation
SELECT '[before] documents=' || COUNT(*) FROM documents;
SELECT '[before] chat_messages=' || COUNT(*) FROM chat_messages;
SELECT '[before] rss_sources=' || COUNT(*) FROM rss_sources;
SELECT '[before] workspaces=' || COUNT(*) FROM workspaces;

-- Drop FTS5 + dependent tables
DROP TRIGGER IF EXISTS documents_ad;
DROP TABLE IF EXISTS documents_fts;
DROP TABLE IF EXISTS doc_attachments;
DROP TABLE IF EXISTS doc_links;
DROP TABLE IF EXISTS tags;
-- documents now safe to drop; CASCADE was via documents->doc_*, not the other way
DROP TABLE IF EXISTS documents;
-- workspaces was the parent of documents — its rows linger now; clear them
DELETE FROM workspaces;
-- CRITICAL: also delete the migration tracking rows so the next Ready launch
-- re-runs migrations 026/027 and re-creates the tables we just dropped.
-- Without this, SearchEngine constructor will throw `no such table: documents`
-- on startup. (Discovered 2026-04-25 when first launch after rescue crashed.)
DELETE FROM migrations WHERE name IN (
  '026_create_search_index_tables',
  '027_documents_multi_source'
);

-- Prune old chat messages (keep last 5 days)
DELETE FROM chat_messages WHERE julianday(timestamp) < julianday('now', '-5 days');

-- Optional: clean conversations with no surviving messages
-- (leave them — UI can prune; we want to be conservative)

-- Post-state
SELECT '[after pre-vacuum] chat_messages=' || COUNT(*) FROM chat_messages;
SELECT '[after pre-vacuum] rss_sources=' || COUNT(*) FROM rss_sources;
SELECT '[after pre-vacuum] workspaces=' || COUNT(*) FROM workspaces;

COMMIT;
EOF
)

echo "[2/4] DROP FTS5 + dependent tables, prune chat_messages > 5 days old"
if [[ $DRY_RUN -eq 0 ]]; then
  echo "$SQL" | sqlite3 "$DB"
else
  echo "(dry-run SQL:)"
  echo "$SQL"
fi

# Step 3: VACUUM (separate transaction; can't run inside a tx)
echo "[3/4] VACUUM to reclaim disk (this can take 5-30 min on the original 80GB)"
if [[ $DRY_RUN -eq 0 ]]; then
  sqlite3 "$DB" "VACUUM;"
fi

# Step 4: Report
NEW_SIZE=$(stat -f %z "$DB" 2>/dev/null || stat -c %s "$DB")
NEW_GB=$(echo "scale=4; $NEW_SIZE/1024/1024/1024" | bc)
SAVED_GB=$(echo "scale=2; ($ORIG_SIZE - $NEW_SIZE)/1024/1024/1024" | bc)
echo "[4/4] DB size: ${ORIG_GB} GB → ${NEW_GB} GB (saved ~${SAVED_GB} GB)"
echo "Backup at: ${BAK}  (delete after verifying Ready works)"
echo "=== done ==="
