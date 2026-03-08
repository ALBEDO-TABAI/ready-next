from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any, Callable, Dict, Optional
from .base import ChannelAdapter
from .feishu_app_adapter import FeishuAppAdapter
from .telegram_adapter import TelegramAdapter


class NoopAdapter(ChannelAdapter):
    def test(self) -> tuple[bool, Optional[str]]:
        return True, None

    def start(self) -> tuple[bool, Optional[str]]:
        self.mark_running()
        return True, None

    def stop(self) -> None:
        self.mark_stopped()

    def send(self, thread: Optional[str], text: str) -> tuple[bool, Optional[str]]:
        _ = thread, text
        return True, None


class ChannelManager:
    def __init__(self, emit_event: Callable[[str, Dict[str, Any]], None]) -> None:
        self._emit = emit_event
        self.adapters: Dict[str, ChannelAdapter] = {}
        self.channels: Dict[str, ChannelConfigModel] = {}

    def upsert(self, channel: ChannelConfigModel) -> None:
        self.channels[channel.id] = channel
        if channel.id in self.adapters:
            self.adapters[channel.id].stop()
            self.adapters.pop(channel.id, None)
        adapter = self._build_adapter(channel)
        adapter.set_event_callback(self._emit)
        self.adapters[channel.id] = adapter

    def start(self, channel_id: str) -> Dict[str, Any]:
        adapter = self.adapters.get(channel_id)
        if not adapter:
            return {"success": False, "error": "channel not found"}
        ok, err = adapter.start()
        return {"success": bool(ok), "error": err}

    def stop(self, channel_id: str) -> Dict[str, Any]:
        adapter = self.adapters.get(channel_id)
        if not adapter:
            return {"success": False, "error": "channel not found"}
        adapter.stop()
        return {"success": True}

    def test(self, channel: ChannelConfigModel) -> Dict[str, Any]:
        adapter = self._build_adapter(channel)
        ok, err = adapter.test()
        return {"success": bool(ok), "error": err}

    def delete(self, channel_id: str) -> Dict[str, Any]:
        adapter = self.adapters.get(channel_id)
        if adapter:
            adapter.stop()
            self.adapters.pop(channel_id, None)
        self.channels.pop(channel_id, None)
        return {"success": True}

    def send(self, channel_id: str, thread: Optional[str], text: str) -> Dict[str, Any]:
        adapter = self.adapters.get(channel_id)
        if not adapter:
            return {"success": False, "error": "channel not found"}
        ok, err = adapter.send(thread, text)
        return {"success": bool(ok), "error": err}

    def state(self) -> Dict[str, Any]:
        adapters = []
        connected = 0
        errors = 0
        for channel_id, adapter in self.adapters.items():
            channel = self.channels.get(channel_id)
            if adapter.state.connected:
                connected += 1
            if adapter.state.error:
                errors += 1
            adapters.append(
                {
                    "id": channel_id,
                    "type": adapter.channel_type,
                    "name": channel.name if channel else adapter.name,
                    "healthy": adapter.state.healthy,
                    "status": adapter.state.status,
                    "connected": adapter.state.connected,
                    "lastBeatAt": adapter.state.last_beat_at,
                    "error": adapter.state.error,
                }
            )
        return {"connected": connected, "errors": errors, "adapters": adapters}

    def _build_adapter(self, channel: ChannelConfigModel) -> ChannelAdapter:
        ctype = channel.type
        if ctype == "telegram-bot":
            return TelegramAdapter(channel.id, ctype, channel.name, channel.config)
        if ctype == "feishu-app":
            return FeishuAppAdapter(channel.id, ctype, channel.name, channel.config)
        return NoopAdapter(channel.id, ctype, channel.name, channel.config)
@dataclass
class ChannelConfigModel:
    id: str
    type: str
    name: str
    enabled: bool = True
    config: Dict[str, Any] = field(default_factory=dict)
