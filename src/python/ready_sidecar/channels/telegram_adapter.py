from __future__ import annotations

import time
from threading import Event, Thread
from typing import Any, Dict, Optional

import requests

from .base import ChannelAdapter, now_iso


class TelegramAdapter(ChannelAdapter):
    def __init__(self, channel_id: str, channel_type: str, name: str, config: Dict[str, Any]) -> None:
        super().__init__(channel_id, channel_type, name, config)
        self._stop = Event()
        self._thread: Optional[Thread] = None
        self._offset = 0

    @property
    def token(self) -> str:
        return str(self.config.get("token") or self.config.get("botToken") or "").strip()

    def _api(self, method: str) -> str:
        return f"https://api.telegram.org/bot{self.token}/{method}"

    def test(self) -> tuple[bool, Optional[str]]:
        if not self.token:
            return False, "Telegram Bot Token 不能为空"
        try:
            resp = requests.get(self._api("getMe"), timeout=8)
            data = resp.json()
            if not data.get("ok"):
                return False, str(data.get("description") or "Telegram 鉴权失败")
            return True, None
        except Exception as exc:
            return False, str(exc)

    def start(self) -> tuple[bool, Optional[str]]:
        ok, err = self.test()
        if not ok:
            self.mark_error(err or "Telegram 连接失败")
            return False, err
        if self._thread and self._thread.is_alive():
            self.mark_running()
            return True, None
        self._stop.clear()
        self._thread = Thread(target=self._poll_loop, name=f"tg-{self.channel_id}", daemon=True)
        self._thread.start()
        self.mark_running()
        return True, None

    def stop(self) -> None:
        self._stop.set()
        if self._thread and self._thread.is_alive():
            self._thread.join(timeout=1.5)
        self.mark_stopped()

    def send(self, thread: Optional[str], text: str, attachments: Optional[list[Dict[str, Any]]] = None) -> tuple[bool, Optional[str]]:
        _ = attachments
        chat_id = str(thread or self.config.get("defaultChatId") or "").strip()
        if not chat_id:
            return False, "缺少 Telegram chat_id（thread）"
        try:
            resp = requests.post(
                self._api("sendMessage"),
                json={"chat_id": chat_id, "text": text},
                timeout=10,
            )
            data = resp.json()
            if not data.get("ok"):
                return False, str(data.get("description") or "发送失败")
            self.beat()
            return True, None
        except Exception as exc:
            self.mark_error(str(exc))
            return False, str(exc)

    def _poll_loop(self) -> None:
        while not self._stop.is_set():
            try:
                resp = requests.get(
                    self._api("getUpdates"),
                    params={"timeout": 25, "offset": self._offset + 1},
                    timeout=35,
                )
                data = resp.json()
                if not data.get("ok"):
                    self.mark_error(str(data.get("description") or "getUpdates 失败"))
                    time.sleep(2.0)
                    continue

                updates = data.get("result") or []
                for update in updates:
                    update_id = int(update.get("update_id", 0))
                    if update_id > self._offset:
                        self._offset = update_id
                    message = update.get("message") or update.get("edited_message")
                    if not message:
                        continue
                    text = (message.get("text") or "").strip()
                    if not text:
                        continue
                    chat = message.get("chat") or {}
                    from_user = message.get("from") or {}
                    chat_id = str(chat.get("id") or "")
                    message_id = str(message.get("message_id") or "")
                    sender = str(from_user.get("username") or from_user.get("first_name") or "telegram-user")
                    if not chat_id:
                        continue
                    event_id = f"tg:{self.channel_id}:{update_id}"
                    self.emit_inbound({
                        "id": event_id,
                        "channelId": self.channel_id,
                        "source": self.channel_type,
                        "thread": chat_id,
                        "sender": sender,
                        "text": text,
                        "timestamp": now_iso(),
                        "idempotencyKey": event_id,
                        "meta": {
                            "messageId": message_id,
                            "chatType": chat.get("type"),
                        },
                    })
                    self.beat()
                if self.state.status != "running":
                    self.mark_running()
            except Exception as exc:
                self.mark_error(str(exc))
                time.sleep(2.0)
