"""Durable handoff to Main; reading an event never acknowledges it."""
import hashlib
import json
import os
import sqlite3
import uuid
from datetime import datetime, timezone
from pathlib import Path
from threading import RLock
from typing import Any, Dict, Optional


class EventStore:
    def __init__(self, path: Path) -> None:
        path.parent.mkdir(parents=True, exist_ok=True)
        self._lock = RLock()
        self._db = sqlite3.connect(path, check_same_thread=False)
        os.chmod(path, 0o600)
        self._db.execute("PRAGMA journal_mode=WAL")
        self._db.executescript("""
            CREATE TABLE IF NOT EXISTS events (
                id TEXT PRIMARY KEY, type TEXT NOT NULL, timestamp TEXT NOT NULL, payload TEXT NOT NULL
            );
            CREATE TABLE IF NOT EXISTS deliveries (
                id TEXT PRIMARY KEY, digest TEXT NOT NULL, result TEXT
            );
        """)

    def enqueue(self, event_type: str, payload: Dict[str, Any]) -> None:
        event_id = f"{event_type}:{payload['id']}" if payload.get("id") else str(uuid.uuid4())
        with self._lock, self._db:
            self._db.execute("INSERT OR IGNORE INTO events VALUES (?, ?, ?, ?)", (
                event_id, event_type, datetime.now(timezone.utc).isoformat(), json.dumps(payload, ensure_ascii=False)))

    def pull(self, limit: int) -> list[Dict[str, Any]]:
        with self._lock:
            return [{"id": row[0], "type": row[1], "timestamp": row[2], "payload": json.loads(row[3])}
                    for row in self._db.execute("SELECT * FROM events ORDER BY rowid LIMIT ?", (max(1, min(200, limit)),))]

    def ack(self, ids: list[str]) -> None:
        with self._lock, self._db:
            self._db.executemany("DELETE FROM events WHERE id = ?", [(item,) for item in ids])

    def begin_delivery(self, delivery_id: str, payload: Dict[str, Any]) -> Optional[Dict[str, Any]]:
        digest = hashlib.sha256(json.dumps(payload, sort_keys=True, ensure_ascii=False).encode()).hexdigest()
        with self._lock, self._db:
            row = self._db.execute("SELECT digest, result FROM deliveries WHERE id = ?", (delivery_id,)).fetchone()
            if row:
                if row[0] != digest:
                    return {"success": False, "error": "delivery_identity_conflict"}
                return json.loads(row[1]) if row[1] else {"success": False, "error": "delivery_outcome_unknown"}
            self._db.execute("INSERT INTO deliveries VALUES (?, ?, NULL)", (delivery_id, digest))
            return None

    def finish_delivery(self, delivery_id: str, result: Dict[str, Any]) -> None:
        with self._lock, self._db:
            self._db.execute("UPDATE deliveries SET result = ? WHERE id = ?", (json.dumps(result), delivery_id))

    def close(self) -> None:
        with self._lock:
            self._db.close()
