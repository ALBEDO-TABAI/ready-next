from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any, Callable, Dict, Optional
from .base import ChannelAdapter
from .feishu_app_adapter import FeishuAppAdapter
from .telegram_adapter import TelegramAdapter
from .wechat_openclaw_adapter import WechatOpenClawAdapter


class NoopAdapter(ChannelAdapter):
    def test(self) -> tuple[bool, Optional[str]]:
        return True, None

    def start(self) -> tuple[bool, Optional[str]]:
        self.mark_running()
        return True, None

    def stop(self) -> None:
        self.mark_stopped()

    def send(self, thread: Optional[str], text: str, attachments: Optional[list[Dict[str, Any]]] = None) -> tuple[bool, Optional[str]]:
        _ = thread, text, attachments
        return True, None


def _retired_callback(*_):
    raise RuntimeError("channel_adapter_retired")


class ChannelManager:
    def __init__(self, emit_event: Callable[[str, Dict[str, Any]], None]) -> None:
        self._emit = emit_event
        self.adapters: Dict[str, ChannelAdapter] = {}
        self.channels: Dict[str, ChannelConfigModel] = {}

    def upsert(self, channel: ChannelConfigModel) -> None:
        if self.channels.get(channel.id) == channel and channel.id in self.adapters:
            return
        self.channels[channel.id] = channel
        if channel.id in self.adapters:
            self.adapters[channel.id].set_event_callback(_retired_callback)
            self.adapters[channel.id].stop()
            self.adapters.pop(channel.id, None)
        adapter = self._build_adapter(channel)
        adapter.set_event_callback(lambda kind, payload: self._emit(kind, payload) if self.adapters.get(channel.id) is adapter else _retired_callback())
        self.adapters[channel.id] = adapter

    def start(self, channel_id: str) -> Dict[str, Any]:
        channel = self.channels.get(channel_id)
        if not channel or not channel.enabled:
            return {"success": False, "error": "channel disabled"}
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
            adapter.set_event_callback(_retired_callback)
            adapter.stop()
            self.adapters.pop(channel_id, None)
            if isinstance(adapter, WechatOpenClawAdapter) and not any(
                isinstance(other, WechatOpenClawAdapter) and other.configured_account_id == adapter.configured_account_id
                for other in self.adapters.values()
            ):
                adapter.forget_account()
        self.channels.pop(channel_id, None)
        return {"success": True}

    def send(
        self,
        channel_id: str,
        thread: Optional[str],
        text: str,
        attachments: Optional[list[Dict[str, Any]]] = None,
    ) -> Dict[str, Any]:
        adapter = self.adapters.get(channel_id)
        if not adapter:
            return {"success": False, "error": "channel not found"}
        ok, err = adapter.send(thread, text, attachments)
        return {"success": bool(ok), "error": err}

    def send_typing(self, channel_id: str, thread: Optional[str], typing: bool = True) -> Dict[str, Any]:
        adapter = self.adapters.get(channel_id)
        if not adapter:
            return {"success": False, "error": "channel not found"}
        ok, err = adapter.send_typing(thread, typing)
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
        if ctype == "wechat-openclaw":
            return WechatOpenClawAdapter(channel.id, ctype, channel.name, channel.config)
        return NoopAdapter(channel.id, ctype, channel.name, channel.config)
@dataclass
class ChannelConfigModel:
    id: str
    type: str
    name: str
    enabled: bool = True
    config: Dict[str, Any] = field(default_factory=dict)
