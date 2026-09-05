from __future__ import annotations

import asyncio
import json
import re
import uuid
import mimetypes
import os
import time
from threading import Event, Thread, Lock
from typing import Any, Dict, Optional
from pathlib import Path
from urllib.parse import unquote, quote

import requests
from lark_oapi.core.model import RawRequest, RawResponse

from .base import ChannelAdapter, now_iso, write_private_bytes


# The pinned SDK schedules work on a module-level loop. All clients share
# this one owned loop; never run Client.start() on competing worker threads.
_connection_loop = None
_connection_loop_lock = Lock()


def connection_loop():
    global _connection_loop
    with _connection_loop_lock:
        if _connection_loop is None:
            import lark_oapi.ws.client as sdk
            if not sdk.loop.is_running() and not sdk.loop.is_closed():
                sdk.loop.close()
            _connection_loop = asyncio.new_event_loop()
            sdk.loop = _connection_loop
            Thread(target=_connection_loop.run_forever, daemon=True, name="feishu-connections").start()
        return _connection_loop


class FeishuAppAdapter(ChannelAdapter):
    def __init__(self, channel_id: str, channel_type: str, name: str, config: Dict[str, Any]) -> None:
        super().__init__(channel_id, channel_type, name, config)
        self._stop = Event()
        self._access_token: Optional[str] = None
        self._access_token_exp_at = 0.0
        self._ws_client: Any = None
        self._listener = None
        self._bot_open_id = ""

    @property
    def app_id(self) -> str:
        return str(self.config.get("appId") or "").strip()

    @property
    def app_secret(self) -> str:
        return str(self.config.get("appSecret") or "").strip()

    @property
    def domain(self) -> str:
        return str(self.config.get("domain") or "https://open.feishu.cn").rstrip("/")

    @property
    def verification_token(self) -> str:
        return str(self.config.get("verificationToken") or "").strip()

    @property
    def encrypt_key(self) -> str:
        return str(self.config.get("encryptKey") or "").strip()

    @property
    def runtime_root(self) -> Path:
        configured = str(self.config.get("runtimeRoot") or os.environ.get("READY_SIDECAR_RUNTIME_ROOT") or "").strip()
        if configured:
            return Path(configured)
        return Path.home() / ".ready-agent-sidecar"

    @property
    def attachment_root(self) -> Path:
        safe_channel = "".join(ch if ch.isalnum() or ch in {"-", "_"} else "-" for ch in self.channel_id).strip("-") or "feishu"
        return self.runtime_root / "channel-attachments" / safe_channel

    def test(self) -> tuple[bool, Optional[str]]:
        if not self.app_id or not self.app_secret:
            return False, "飞书 App ID / App Secret 不能为空"
        token, err = self._refresh_access_token(force=True)
        if not token:
            return False, err or "飞书鉴权失败"
        try:
            self._connection_info()
        except Exception as exc:
            return False, f"飞书长连接握手失败：{exc}"
        return True, None

    def _connection_info(self):
        response = requests.post(f"{self.domain}/callback/ws/endpoint",
            json={"AppID": self.app_id, "AppSecret": self.app_secret}, timeout=10)
        response.raise_for_status()
        payload = response.json()
        if payload.get("code") != 0:
            raise RuntimeError(str(payload.get("msg") or "飞书长连接握手失败"))
        data = payload.get("data") or {}
        return data["URL"], max(5, int((data.get("ClientConfig") or {}).get("PingInterval") or 120))

    def _load_bot_identity(self):
        token, error = self._refresh_access_token(force=False)
        if not token:
            raise RuntimeError(error or "飞书鉴权失败")
        response = requests.get(f"{self.domain}/open-apis/bot/v3/info/",
            headers={"Authorization": f"Bearer {token}"}, timeout=10)
        response.raise_for_status()
        data = response.json()
        if data.get("code") != 0:
            self._access_token = None
            self._access_token_exp_at = 0
            raise RuntimeError(str(data.get("msg") or "请在飞书应用中启用机器人能力"))
        self._bot_open_id = str((data.get("bot") or {}).get("open_id") or "")

    def start(self) -> tuple[bool, Optional[str]]:
        if self._listener and not self._listener.done():
            return True, None
        if not self.app_id or not self.app_secret:
            self.mark_error("飞书 App ID / App Secret 不能为空")
            return False, self.state.error
        self._stop.clear()
        self.mark_starting()
        self._listener = asyncio.run_coroutine_threadsafe(self._listen(), connection_loop())
        return True, None

    def stop(self) -> None:
        self._stop.set()
        if self._listener:
            self._listener.cancel()
        self.mark_stopped()

    def send(self, thread: Optional[str], text: str, attachments: Optional[list[Dict[str, Any]]] = None) -> tuple[bool, Optional[str]]:
        target = str(thread or self.config.get("defaultChatId") or "").strip()
        if not target:
            return False, "请先在飞书中向已绑定的机器人发一条消息，再发送测试消息。"
        token, err = self._refresh_access_token(force=False)
        if not token:
            return False, err or "飞书鉴权失败"
        try:
            headers = {"Authorization": f"Bearer {token}"}
            route = json.loads(target) if target.startswith("{") else {"chatId": target}
            if route.get("replyTo"):
                url = f"{self.domain}/open-apis/im/v1/messages/{quote(str(route['replyTo']), safe='')}/reply"
                addressing = {"reply_in_thread": True}
                params = None
            else:
                url = f"{self.domain}/open-apis/im/v1/messages"
                addressing = {"receive_id": route["chatId"]}
                params = {"receive_id_type": "chat_id"}

            def send_message(kind, content):
                response = requests.post(url, params=params, headers=headers,
                    json={**addressing, "uuid": str(uuid.uuid4()), "msg_type": kind,
                          "content": json.dumps(content, ensure_ascii=False)}, timeout=20)
                response.raise_for_status()
                data = response.json()
                if data.get("code") != 0 or not (data.get("data") or {}).get("message_id"):
                    raise RuntimeError(str(data.get("msg") or "飞书未确认消息发送成功"))

            if text.strip():
                send_message("text", {"text": text})
            for attachment in attachments or []:
                path = Path(str(attachment.get("path") or ""))
                if not path.is_file() or path.stat().st_size > 30 * 1024 * 1024:
                    raise ValueError("飞书文件不存在或超过 30 MB")
                is_image = str(mimetypes.guess_type(path.name)[0] or "").startswith("image/")
                if is_image and path.stat().st_size > 10 * 1024 * 1024:
                    raise ValueError("飞书图片超过 10 MB，请压缩后发送")
                kind = "image" if is_image else "file"
                with path.open("rb") as stream:
                    response = requests.post(f"{self.domain}/open-apis/im/v1/{'images' if is_image else 'files'}", headers=headers,
                        data={"image_type": "message"} if is_image else {"file_type": "stream", "file_name": path.name},
                        files={kind: stream}, timeout=90)
                    response.raise_for_status()
                    data = response.json()
                key = (data.get("data") or {}).get(f"{kind}_key")
                if data.get("code") != 0 or not key:
                    raise RuntimeError(str(data.get("msg") or "飞书文件上传失败"))
                send_message(kind, {f"{kind}_key": key})
            if not text.strip() and not attachments:
                return False, "消息内容不能为空"
            self.beat()
            return True, None
        except Exception as exc:
            # Refresh authentication on the next explicit send, never replay an unknown send.
            self._access_token = None
            self._access_token_exp_at = 0
            return False, str(exc)

    def _refresh_access_token(self, force: bool) -> tuple[Optional[str], Optional[str]]:
        if (not force) and self._access_token and time.time() < self._access_token_exp_at - 60:
            return self._access_token, None
        try:
            resp = requests.post(
                f"{self.domain}/open-apis/auth/v3/tenant_access_token/internal",
                json={"app_id": self.app_id, "app_secret": self.app_secret},
                timeout=10,
            )
            data = resp.json()
            code = int(data.get("code", -1))
            if code != 0:
                return None, str(data.get("msg") or data.get("message") or "tenant token 获取失败")
            token = str(data.get("tenant_access_token") or "")
            expire = int(data.get("expire", 7200))
            if not token:
                return None, "飞书 tenant_access_token 为空"
            self._access_token = token
            self._access_token_exp_at = time.time() + max(300, expire)
            return token, None
        except Exception as exc:
            return None, str(exc)

    async def _listen(self) -> None:
        import lark_oapi as lark
        adapter = self

        class Client(lark.ws.Client):
            def _get_conn_url(self):
                url, self._ping_interval = adapter._connection_info()
                return url

            async def _receive_message_loop(self):
                try:
                    await super()._receive_message_loop()
                except Exception:
                    pass  # _listen owns recovery after _conn has been cleared.

        def on_message(data):
            if self._stop.is_set():
                return
            try:
                event = self._extract_im_event(data)
                if event:
                    self.emit_inbound(event)
                    self.mark_running()
            except Exception as exc:
                self.mark_error(f"飞书消息尚未保存：{exc}")
                raise

        while not self._stop.is_set():
            client = Client(self.app_id, self.app_secret,
                event_handler=self._build_dispatcher(lark, on_message, lambda _: None),
                log_level=lark.LogLevel.ERROR, domain=self.domain, auto_reconnect=False)
            self._ws_client = client
            ping = None
            try:
                self.mark_starting()
                await asyncio.to_thread(self._load_bot_identity)
                await client._connect()
                if self._stop.is_set():
                    return
                self.mark_running()
                ping = asyncio.create_task(client._ping_loop())
                while not self._stop.is_set() and client._conn is not None:
                    await asyncio.sleep(0.25)
                if not self._stop.is_set():
                    self.mark_error("飞书连接已断开，正在重连")
            except asyncio.CancelledError:
                return
            except Exception as exc:
                if not self._stop.is_set():
                    self.mark_error(f"飞书连接失败：{exc}")
            finally:
                if ping:
                    ping.cancel()
                    await asyncio.gather(ping, return_exceptions=True)
                await client._disconnect()
            if not self._stop.is_set():
                await asyncio.sleep(3)

    def _build_dispatcher(self, lark: Any, on_message: Any, on_session_event: Any) -> Any:
        return (
            lark.EventDispatcherHandler.builder(self.encrypt_key or "", self.verification_token or "")
                .register_p2_im_message_receive_v1(on_message)
                .register_p2_im_chat_access_event_bot_p2p_chat_entered_v1(on_session_event)
                .register_p2_im_chat_member_bot_added_v1(on_session_event)
                .register_p2_im_chat_member_bot_deleted_v1(on_session_event)
                .build()
        )

    @staticmethod
    def _read_value(obj: Any, key: str, default: Any = None) -> Any:
        if obj is None:
            return default
        if isinstance(obj, dict):
            return obj.get(key, default)
        return getattr(obj, key, default)

    def handle_callback(self, headers: Dict[str, str], body: bytes) -> tuple[int, Dict[str, str], bytes]:
        try:
            import lark_oapi as lark  # type: ignore

            def _on_msg(data: Any) -> None:
                event = self._extract_im_event(data)
                if event:
                    self.emit_inbound(event)
                self.beat()

            def _on_session_event(_: Any) -> None:
                self.beat()

            dispatcher = self._build_dispatcher(lark, _on_msg, _on_session_event)
            req = RawRequest()
            req.uri = "/feishu/callback"
            req.headers = {str(k): str(v) for k, v in headers.items()}
            req.body = body
            resp: RawResponse = dispatcher.do(req)
            return int(resp.status_code or 200), resp.headers or {}, resp.content or b""
        except Exception as exc:
            self.mark_error(str(exc))
            return 500, {"content-type": "application/json; charset=utf-8"}, json.dumps({
                "msg": str(exc),
            }, ensure_ascii=False).encode("utf-8")

    def _extract_im_event(self, data: Any) -> Optional[Dict[str, Any]]:
        # Compatible parser for multiple sdk payload shapes
        payload = None
        if isinstance(data, dict):
            payload = data.get("event", data)
        elif hasattr(data, "event"):
            payload = getattr(data, "event")
        elif hasattr(data, "to_dict"):
            payload = data.to_dict()

        if payload is None:
            return None

        msg = self._read_value(payload, "message")
        sender_obj = self._read_value(payload, "sender")
        if msg is None or self._read_value(sender_obj, "sender_type") == "app":
            return None

        sender_id_obj = self._read_value(sender_obj, "sender_id")
        early_sender = str(self._read_value(sender_id_obj, "open_id") or self._read_value(sender_id_obj, "user_id") or "")
        owner = str(self.config.get("allowedSenderId") or "")
        if owner and early_sender != owner:
            return None
        content_raw = self._read_value(msg, "content")
        message_id = str(self._read_value(msg, "message_id") or "")
        message_type = str(self._read_value(msg, "message_type") or "text").strip().lower()
        content_json: Dict[str, Any] = {}
        text = ""
        if isinstance(content_raw, str):
            try:
                content_json = json.loads(content_raw) or {}
                text = str(content_json.get("text") or "").strip()
            except Exception:
                text = content_raw.strip()
        if not message_id:
            return None
        if message_type == "post":
            post = content_json if "content" in content_json else next((v for v in content_json.values() if isinstance(v, dict) and "content" in v), {})
            content_json = post
            text = "\n".join("".join(str(item.get("text") or item.get("href") or "") for item in row if isinstance(item, dict))
                for row in post.get("content", []) if isinstance(row, list)).strip()
        chat_type = str(self._read_value(msg, "chat_type") or "")
        if chat_type == "group":
            prefix = str(self.config.get("triggerPrefix") or "@ready")
            mentions = self._read_value(msg, "mentions") or []
            own_mention = next((item for item in mentions if self._bot_open_id and
                self._read_value(self._read_value(item, "id"), "open_id") == self._bot_open_id), None)
            mention_key = str(self._read_value(own_mention, "key") or "")
            if mention_key and mention_key in text:
                text = text.replace(mention_key, "", 1).strip()
            elif text.lower().startswith(prefix.lower()):
                text = text[len(prefix):].strip()
            else:
                return None
        attachments = self._extract_attachments(message_type, content_json, message_id) if owner else []
        if message_type not in {"text", "post"}:
            text = ""
        if not text and not attachments:
            return None

        chat_id = str(
            self._read_value(msg, "chat_id")
            or self._read_value(msg, "thread_id")
            or ""
        )
        sender_id = ""
        if sender_obj is not None:
            sender_id_obj = self._read_value(sender_obj, "sender_id")
            sender_id = str(
                self._read_value(sender_id_obj, "open_id")
                or self._read_value(sender_id_obj, "user_id")
                or self._read_value(sender_obj, "tenant_key")
                or ""
            )

        if not chat_id:
            return None
        topic = str(self._read_value(msg, "thread_id") or "")
        root = str(self._read_value(msg, "root_id") or message_id)
        thread = json.dumps({"chatId": chat_id, "replyTo": root, "topicId": topic}, sort_keys=True) if topic else chat_id
        event_id = f"fs:{self.channel_id}:{message_id}"
        return {
            "id": event_id,
            "channelId": self.channel_id,
            "source": self.channel_type,
            "thread": thread,
            "sender": sender_id or "feishu-user",
            "text": text,
            "timestamp": now_iso(),
            "idempotencyKey": event_id,
            "meta": {
                "bindingId": self.config.get("bindingId"),
                "messageId": message_id,
                "threadId": str(self._read_value(msg, "thread_id") or ""),
                "chatType": str(self._read_value(msg, "chat_type") or ""),
                "messageType": str(self._read_value(msg, "message_type") or ""),
            },
            "attachments": attachments,
        }

    def _extract_attachments(self, message_type: str, content_json: Dict[str, Any], message_id: str) -> list[Dict[str, Any]]:
        attachments: list[Dict[str, Any]] = []
        if message_type == "image":
            image_key = str(content_json.get("image_key") or "").strip()
            if image_key:
                downloaded = self._download_message_resource(
                    message_id,
                    image_key,
                    "image",
                    f"飞书图片-{image_key[:8]}.png",
                )
                item = {
                    "id": f"fs-image-{image_key[:12]}",
                    "name": f"飞书图片-{image_key[:8]}.png",
                    "path": f"feishu://image/{image_key}",
                    "type": "image",
                    "ext": ".png",
                    "size": 0,
                    "remoteId": image_key,
                }
                if downloaded:
                    item.update(downloaded)
                attachments.append(item)
        elif message_type == "file":
            file_key = str(content_json.get("file_key") or "").strip()
            file_name = str(content_json.get("file_name") or "飞书文件").strip()
            if file_key:
                ext = Path(file_name).suffix or ""
                downloaded = self._download_message_resource(
                    message_id,
                    file_key,
                    "file",
                    file_name or f"飞书文件-{file_key[:8]}{ext or ''}",
                )
                item = {
                    "id": f"fs-file-{file_key[:12]}",
                    "name": file_name,
                    "path": f"feishu://file/{file_key}",
                    "type": "other",
                    "ext": ext,
                    "size": int(content_json.get("file_size") or 0),
                    "remoteId": file_key,
                }
                if downloaded:
                    item.update(downloaded)
                    if item.get("mimeType", "").startswith("image/"):
                        item["type"] = "image"
                    elif item.get("mimeType", "").startswith("video/"):
                        item["type"] = "video"
                attachments.append(item)
        elif message_type in {"media", "audio"}:
            file_key = str(content_json.get("file_key") or content_json.get("media_key") or "").strip()
            if file_key:
                item = {
                    "id": f"fs-media-{file_key[:12]}",
                    "name": "飞书媒体",
                    "path": f"feishu://media/{file_key}",
                    "type": "other",
                    "ext": "",
                    "size": 0,
                    "remoteId": file_key,
                }
                downloaded = self._download_message_resource(
                    message_id,
                    file_key,
                    "file",
                    f"飞书媒体-{file_key[:8]}",
                )
                if downloaded:
                    item.update(downloaded)
                    mime_type = str(item.get("mimeType") or "")
                    if mime_type.startswith("image/"):
                        item["type"] = "image"
                    elif mime_type.startswith("video/"):
                        item["type"] = "video"
                attachments.append(item)
        elif message_type == "post":
            for row in content_json.get("content", []):
                for item in row if isinstance(row, list) else []:
                    if isinstance(item, dict) and item.get("tag") == "img" and item.get("image_key"):
                        image = self._download_message_resource(message_id, str(item["image_key"]), "image", "图片")
                        if image:
                            attachments.append({**image, "type": "image", "remoteId": item["image_key"]})
        return attachments

    def _download_message_resource(
        self,
        message_id: str,
        file_key: str,
        resource_type: str,
        fallback_name: str,
    ) -> Optional[Dict[str, Any]]:
        if not message_id or not file_key:
            return None
        token, err = self._refresh_access_token(force=False)
        if not token or err:
            raise RuntimeError(err or "飞书附件鉴权失败")

        try:
            response = requests.get(
                f"{self.domain}/open-apis/im/v1/messages/{message_id}/resources/{file_key}",
                params={"type": resource_type},
                headers={"Authorization": f"Bearer {token}"},
                timeout=20,
            )
            if response.status_code >= 400:
                raise RuntimeError(f"附件下载失败（HTTP {response.status_code}），请检查消息资源权限")

            content_type = str(response.headers.get("Content-Type") or "").split(";")[0].strip()
            filename = self._resolve_download_filename(response.headers.get("Content-Disposition"), fallback_name)
            ext = Path(filename).suffix or mimetypes.guess_extension(content_type or "") or ""
            if ext and not filename.endswith(ext):
                filename = f"{filename}{ext}"
            if not ext:
                ext = Path(filename).suffix or ""

            self.attachment_root.mkdir(parents=True, exist_ok=True)
            safe_name = "".join(ch if ch.isalnum() or ch in {"-", "_", "."} else "-" for ch in filename).strip("-") or fallback_name
            safe_id = re.sub(r"[^a-zA-Z0-9_-]", "-", message_id)
            safe_key = re.sub(r"[^a-zA-Z0-9_-]", "-", file_key[:12])
            target = self.attachment_root / f"{safe_id}-{safe_key}-{safe_name}"
            write_private_bytes(target, response.content)
            return {
                "name": safe_name,
                "path": str(target),
                "mimeType": content_type or None,
                "ext": ext,
                "size": len(response.content),
                "downloaded": True,
            }
        except Exception as exc:
            raise RuntimeError(f"飞书附件尚未保存：{exc}") from exc

    @staticmethod
    def _resolve_download_filename(content_disposition: Optional[str], fallback_name: str) -> str:
        raw = str(content_disposition or "")
        if raw:
            marker = "filename*="
            if marker in raw:
                value = raw.split(marker, 1)[1].split(";", 1)[0].strip()
                if "''" in value:
                    _, encoded = value.split("''", 1)
                    decoded = unquote(encoded.strip().strip('"'))
                    if decoded:
                        return decoded
            marker = "filename="
            if marker in raw:
                value = raw.split(marker, 1)[1].split(";", 1)[0].strip().strip('"')
                if value:
                    return unquote(value)
        return fallback_name

    def _build_attachment_notice(self, attachments: list[Dict[str, Any]]) -> str:
        if not attachments:
            return ""
        if len(attachments) == 1:
            item = attachments[0]
            kind = str(item.get("type") or "other")
            if kind == "image":
                label = "图片"
            elif kind == "video":
                label = "视频"
            elif kind == "text":
                label = "文件"
            else:
                label = "附件"
            return f"[收到{label}] {item.get('name') or ''}".strip()
        return f"[收到 {len(attachments)} 个附件]"
