from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime, timezone
from threading import Lock
from typing import Any, Callable, Dict, Optional


def now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


EventCallback = Callable[[str, Dict[str, Any]], None]


@dataclass
class AdapterState:
    status: str = "stopped"  # starting|running|stopped|error
    healthy: bool = False
    last_beat_at: Optional[str] = None
    error: Optional[str] = None
    connected: bool = False


class ChannelAdapter:
    def __init__(self, channel_id: str, channel_type: str, name: str, config: Dict[str, Any]) -> None:
        self.channel_id = channel_id
        self.channel_type = channel_type
        self.name = name
        self.config = config
        self.state = AdapterState()
        self._emit: Optional[EventCallback] = None
        self._lock = Lock()

    def set_event_callback(self, callback: EventCallback) -> None:
        self._emit = callback

    def emit_inbound(self, payload: Dict[str, Any]) -> None:
        if not self._emit:
            return
        self._emit("channel.inbound", payload)

    def mark_running(self) -> None:
        with self._lock:
            self.state.status = "running"
            self.state.healthy = True
            self.state.connected = True
            self.state.last_beat_at = now_iso()
            self.state.error = None

    def mark_starting(self) -> None:
        with self._lock:
            self.state.status = "starting"
            self.state.healthy = False
            self.state.connected = False
            self.state.last_beat_at = now_iso()
            self.state.error = None

    def mark_stopped(self) -> None:
        with self._lock:
            self.state.status = "stopped"
            self.state.healthy = False
            self.state.connected = False
            self.state.last_beat_at = now_iso()

    def mark_error(self, error: str) -> None:
        with self._lock:
            self.state.status = "error"
            self.state.healthy = False
            self.state.connected = False
            self.state.last_beat_at = now_iso()
            self.state.error = error

    def beat(self) -> None:
        with self._lock:
            self.state.last_beat_at = now_iso()
            if self.state.status == "running":
                self.state.healthy = True

    def test(self) -> tuple[bool, Optional[str]]:
        raise NotImplementedError

    def start(self) -> tuple[bool, Optional[str]]:
        raise NotImplementedError

    def stop(self) -> None:
        raise NotImplementedError

    def send(self, thread: Optional[str], text: str, attachments: Optional[list[Dict[str, Any]]] = None) -> tuple[bool, Optional[str]]:
        raise NotImplementedError

    def send_typing(self, thread: Optional[str], typing: bool = True) -> tuple[bool, Optional[str]]:
        _ = thread, typing
        return True, None
