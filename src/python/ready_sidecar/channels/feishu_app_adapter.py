from __future__ import annotations

import json
import mimetypes
import os
import time
from threading import Event, Thread
from typing import Any, Dict, Optional
from pathlib import Path
from urllib.parse import unquote

import requests
from lark_oapi.core.model import RawRequest, RawResponse

from .base import ChannelAdapter, now_iso


class FeishuAppAdapter(ChannelAdapter):
    def __init__(self, channel_id: str, channel_type: str, name: str, config: Dict[str, Any]) -> None:
        super().__init__(channel_id, channel_type, name, config)
        self._stop = Event()
        self._thread: Optional[Thread] = None
        self._ws_thread: Optional[Thread] = None
        self._access_token: Optional[str] = None
        self._access_token_exp_at = 0.0
        self._ws_client: Any = None

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
            import lark_oapi as lark  # type: ignore

            client = lark.ws.Client(
                self.app_id,
                self.app_secret,
                event_handler=self._build_dispatcher(lark, lambda _data: None, lambda _data: None),
                log_level=lark.LogLevel.WARNING,
                domain=self.domain,
            )
            client._get_conn_url()
        except Exception as exc:
            return False, f"飞书长连接握手失败：{exc}"
        return True, None

    def start(self) -> tuple[bool, Optional[str]]:
        ok, err = self.test()
        if not ok:
            self.mark_error(err or "飞书连接失败")
            return False, err

        if self._thread and self._thread.is_alive():
            self.mark_running()
            return True, None

        self._stop.clear()
        self.mark_starting()
        self._thread = Thread(target=self._long_conn_loop, name=f"feishu-{self.channel_id}", daemon=True)
        self._thread.start()
        return True, None

    def stop(self) -> None:
        self._stop.set()
        try:
            if self._ws_client and hasattr(self._ws_client, "stop"):
                self._ws_client.stop()
        except Exception:
            pass
        if self._ws_thread and self._ws_thread.is_alive():
            self._ws_thread.join(timeout=1.5)
        if self._thread and self._thread.is_alive():
            self._thread.join(timeout=1.5)
        self.mark_stopped()

    def send(self, thread: Optional[str], text: str) -> tuple[bool, Optional[str]]:
        receive_id = str(thread or self.config.get("defaultChatId") or "").strip()
        if not receive_id:
            return False, "缺少飞书会话 ID（thread/chat_id）"

        token, err = self._refresh_access_token(force=False)
        if not token:
            return False, err or "飞书鉴权失败"
        try:
            resp = requests.post(
                f"{self.domain}/open-apis/im/v1/messages",
                params={"receive_id_type": "chat_id"},
                headers={
                    "Authorization": f"Bearer {token}",
                    "Content-Type": "application/json; charset=utf-8",
                },
                json={
                    "receive_id": receive_id,
                    "msg_type": "text",
                    "content": json.dumps({"text": text}, ensure_ascii=False),
                },
                timeout=12,
            )
            data = resp.json()
            code = int(data.get("code", -1))
            if code != 0:
                return False, str(data.get("msg") or data.get("message") or "飞书发送失败")
            self.beat()
            return True, None
        except Exception as exc:
            self.mark_error(str(exc))
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

    def _long_conn_loop(self) -> None:
        try:
            import lark_oapi as lark  # type: ignore

            def _on_msg(data: Any) -> None:
                try:
                    event = self._extract_im_event(data)
                    if not event:
                        return
                    self.emit_inbound(event)
                    self.mark_running()
                    self.beat()
                except Exception as inner_exc:
                    self.mark_error(str(inner_exc))

            def _on_session_event(_: Any) -> None:
                self.mark_running()
                self.beat()

            retry_delay = 3.0
            while not self._stop.is_set():
                self.mark_starting()
                dispatcher = self._build_dispatcher(lark, _on_msg, _on_session_event)
                self._ws_client = lark.ws.Client(
                    self.app_id,
                    self.app_secret,
                    event_handler=dispatcher,
                    log_level=lark.LogLevel.WARNING,
                    domain=self.domain,
                )

                def _run_ws() -> None:
                    try:
                        self._ws_client.start()
                    except Exception as ws_exc:
                        self.mark_error(str(ws_exc))

                self._ws_thread = Thread(target=_run_ws, name=f"feishu-ws-{self.channel_id}", daemon=True)
                self._ws_thread.start()
                deadline = time.time() + 10.0
                connected = False
                while not self._stop.is_set() and time.time() < deadline:
                    conn = getattr(self._ws_client, "_conn", None)
                    if conn is not None:
                        self.mark_running()
                        connected = True
                        break
                    if self._ws_thread and not self._ws_thread.is_alive():
                        break
                    time.sleep(0.2)

                if not connected:
                    self.mark_error("飞书长连接未建立，请检查事件订阅是否已启用长连接、应用版本是否已发布，以及机器人是否具备消息权限")
                    try:
                        if self._ws_client and hasattr(self._ws_client, "stop"):
                            self._ws_client.stop()
                    except Exception:
                        pass
                    if self._ws_thread and self._ws_thread.is_alive():
                        self._ws_thread.join(timeout=1.5)
                    if self._stop.wait(retry_delay):
                        return
                    continue

                while not self._stop.is_set():
                    if self.state.status == "error":
                        break
                    conn = getattr(self._ws_client, "_conn", None)
                    if conn is None or (self._ws_thread and not self._ws_thread.is_alive()):
                        self.mark_error("飞书长连接已断开，正在重连")
                        break
                    time.sleep(2.0)

                if self._stop.is_set():
                    return

                try:
                    if self._ws_client and hasattr(self._ws_client, "stop"):
                        self._ws_client.stop()
                except Exception:
                    pass
                if self._ws_thread and self._ws_thread.is_alive():
                    self._ws_thread.join(timeout=1.5)
                if self._stop.wait(retry_delay):
                    return
        except Exception as exc:
            self.mark_error(f"飞书长连接初始化失败: {exc}")
            return

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
            payload = data
        elif hasattr(data, "event"):
            payload = getattr(data, "event")
        elif hasattr(data, "to_dict"):
            payload = data.to_dict()

        if payload is None:
            return None

        msg = self._read_value(payload, "message")
        sender_obj = self._read_value(payload, "sender")
        if msg is None:
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
        attachments = self._extract_attachments(message_type, content_json, message_id)
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
        event_id = f"fs:{self.channel_id}:{message_id or int(time.time() * 1000)}"
        return {
            "id": event_id,
            "channelId": self.channel_id,
            "source": self.channel_type,
            "thread": chat_id,
            "sender": sender_id or "feishu-user",
            "text": text,
            "timestamp": now_iso(),
            "idempotencyKey": event_id,
            "meta": {
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
            title = str(content_json.get("title") or "").strip()
            if title:
                attachments.append({
                    "id": f"fs-post-{int(time.time() * 1000)}",
                    "name": title,
                    "path": "feishu://post",
                    "type": "text",
                    "ext": ".txt",
                    "size": 0,
                })
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
            return None

        try:
            response = requests.get(
                f"{self.domain}/open-apis/im/v1/messages/{message_id}/resources/{file_key}",
                params={"type": resource_type},
                headers={"Authorization": f"Bearer {token}"},
                timeout=20,
            )
            if response.status_code >= 400:
                return None

            content_type = str(response.headers.get("Content-Type") or "").split(";")[0].strip()
            filename = self._resolve_download_filename(response.headers.get("Content-Disposition"), fallback_name)
            ext = Path(filename).suffix or mimetypes.guess_extension(content_type or "") or ""
            if ext and not filename.endswith(ext):
                filename = f"{filename}{ext}"
            if not ext:
                ext = Path(filename).suffix or ""

            self.attachment_root.mkdir(parents=True, exist_ok=True)
            safe_name = "".join(ch if ch.isalnum() or ch in {"-", "_", "."} else "-" for ch in filename).strip("-") or fallback_name
            target = self.attachment_root / f"{message_id}-{file_key[:12]}-{safe_name}"
            target.write_bytes(response.content)
            return {
                "name": safe_name,
                "path": str(target),
                "mimeType": content_type or None,
                "ext": ext,
                "size": len(response.content),
                "downloaded": True,
            }
        except Exception:
            return None

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
