from __future__ import annotations

import base64
import hashlib
import json
import mimetypes
import os
import random
import re
import secrets
import socket
import threading
import time
import uuid
from pathlib import Path
from typing import Any, Dict, List, Optional, Tuple
from urllib import error as urlerror
from urllib import parse, request

from .base import ChannelAdapter, now_iso, write_private_bytes


DEFAULT_BASE_URL = "https://ilinkai.weixin.qq.com"
DEFAULT_CDN_BASE_URL = "https://novac2c.cdn.weixin.qq.com/c2c"
DEFAULT_BOT_TYPE = "3"
CHANNEL_VERSION = "2.4.4"
ILINK_APP_ID = "bot"
ILINK_CLIENT_VERSION = str((2 << 16) | (4 << 8) | 4)
LOGIN_TTL_SECONDS = 5 * 60
LOGIN_WAIT_SECONDS = 8 * 60
QR_POLL_TIMEOUT_SECONDS = 35
GET_UPDATES_TIMEOUT_SECONDS = 35
WEIXIN_MEDIA_MAX_BYTES = 100 * 1024 * 1024
UPLOAD_MEDIA_IMAGE = 1
UPLOAD_MEDIA_VIDEO = 2
UPLOAD_MEDIA_FILE = 3
MESSAGE_TYPE_BOT = 2
MESSAGE_STATE_FINISH = 2
ITEM_TYPE_TEXT = 1
ITEM_TYPE_IMAGE = 2
ITEM_TYPE_VOICE = 3
ITEM_TYPE_FILE = 4
ITEM_TYPE_VIDEO = 5


def _write_private_json(path: Path, data: Any) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_name(path.name + "." + uuid.uuid4().hex + ".tmp")
    try:
        with open(temporary, "x", encoding="utf-8", opener=lambda p, flags: os.open(p, flags, 0o600)) as stream:
            json.dump(data, stream, ensure_ascii=False)
            stream.flush()
            os.fsync(stream.fileno())
        os.replace(temporary, path)
    finally:
        temporary.unlink(missing_ok=True)


def _safe_account_filename(account_id: str) -> str:
    encoded = base64.urlsafe_b64encode(account_id.encode("utf-8")).decode("ascii").rstrip("=")
    return encoded or "default"


def _decode_account_filename(filename: str) -> Optional[str]:
    try:
        padded = filename + ("=" * ((4 - len(filename) % 4) % 4))
        return base64.urlsafe_b64decode(padded.encode("ascii")).decode("utf-8")
    except Exception:
        return None


def _random_wechat_uin() -> str:
    value = str(random.randint(0, 2**32 - 1))
    return base64.b64encode(value.encode("utf-8")).decode("ascii")


def _generate_client_id() -> str:
    return f"ready-weixin-{uuid.uuid4().hex}"


def _safe_filename(name: str, fallback: str = "attachment") -> str:
    value = str(name or "").strip() or fallback
    safe = "".join(ch if ch.isalnum() or ch in {"-", "_", "."} else "-" for ch in value).strip("-")
    return safe or fallback


def _guess_mime_type(path_or_name: str) -> str:
    guessed, _ = mimetypes.guess_type(path_or_name)
    return guessed or "application/octet-stream"


def _attachment_kind_for_file(path: Path) -> str:
    mime = _guess_mime_type(path.name)
    if mime.startswith("image/"):
        return "image"
    if mime.startswith("video/"):
        return "video"
    suffix = path.suffix.lower()
    if suffix in {".xls", ".xlsx", ".numbers"}:
        return "spreadsheet"
    if suffix in {".txt", ".md", ".markdown", ".json", ".csv", ".doc", ".docx", ".pdf"}:
        return "text"
    return "other"


def _upload_media_type_for_file(path: Path) -> int:
    mime = _guess_mime_type(path.name)
    if mime.startswith("image/"):
        return UPLOAD_MEDIA_IMAGE
    if mime.startswith("video/"):
        return UPLOAD_MEDIA_VIDEO
    return UPLOAD_MEDIA_FILE


def _aes_ecb_padded_size(size: int) -> int:
    return ((int(size) // 16) + 1) * 16


def _encrypt_aes_ecb(plaintext: bytes, key: bytes) -> bytes:
    try:
        from cryptography.hazmat.primitives.ciphers import Cipher, algorithms, modes
    except Exception as exc:
        raise RuntimeError("缺少 cryptography，无法上传微信附件。请重新启动 Ready 让 sidecar 安装依赖。") from exc
    pad_len = 16 - (len(plaintext) % 16)
    padded = plaintext + bytes([pad_len]) * pad_len
    encryptor = Cipher(algorithms.AES(key), modes.ECB()).encryptor()
    return encryptor.update(padded) + encryptor.finalize()


def _decrypt_aes_ecb(ciphertext: bytes, key: bytes) -> bytes:
    try:
        from cryptography.hazmat.primitives.ciphers import Cipher, algorithms, modes
    except Exception as exc:
        raise RuntimeError("缺少 cryptography，无法下载微信附件。请重新启动 Ready 让 sidecar 安装依赖。") from exc
    decryptor = Cipher(algorithms.AES(key), modes.ECB()).decryptor()
    padded = decryptor.update(ciphertext) + decryptor.finalize()
    if not padded:
        return padded
    pad_len = padded[-1]
    if pad_len < 1 or pad_len > 16:
        return padded
    return padded[:-pad_len]


def _parse_cdn_aes_key(raw: str) -> Optional[bytes]:
    value = str(raw or "").strip()
    if not value:
        return None
    try:
        decoded = base64.b64decode(value)
        if len(decoded) == 16:
            return decoded
        if len(decoded) == 32 and re.fullmatch(rb"[0-9a-fA-F]{32}", decoded):
            return bytes.fromhex(decoded.decode("ascii"))
    except Exception:
        pass
    if re.fullmatch(r"[0-9a-fA-F]{32}", value):
        return bytes.fromhex(value)
    return None


def _build_cdn_download_url(media: Dict[str, Any], cdn_base_url: str) -> str:
    full_url = str(media.get("full_url") or "").strip()
    if full_url:
        return full_url
    encrypted_param = str(media.get("encrypt_query_param") or "").strip()
    if not encrypted_param:
        return ""
    return f"{cdn_base_url.rstrip('/')}/download?encrypted_query_param={parse.quote(encrypted_param, safe='')}"


def _build_cdn_upload_url(upload_param: str, filekey: str, cdn_base_url: str) -> str:
    return (
        f"{cdn_base_url.rstrip('/')}/upload"
        f"?encrypted_query_param={parse.quote(upload_param, safe='')}"
        f"&filekey={parse.quote(filekey, safe='')}"
    )


def _is_success_business_code(value: Any) -> bool:
    if value is None:
        return True
    if isinstance(value, bool):
        return value is False
    if isinstance(value, (int, float)):
        return int(value) == 0
    text = str(value).strip().lower()
    return text in {"", "0", "ok", "success", "succeeded"}


def _raise_for_business_error(endpoint: str, response: Dict[str, Any]) -> None:
    for key in ("ret", "errcode", "error_code", "code"):
        if key not in response:
            continue
        value = response.get(key)
        if _is_success_business_code(value):
            continue
        message = str(response.get("errmsg") or response.get("err_msg") or response.get("message") or "").strip()
        suffix = f"：{message}" if message else ""
        raise RuntimeError(f"微信接口返回错误 {key}={value} ({endpoint}){suffix}")


def _extract_text(item_list: Any) -> str:
    if not isinstance(item_list, list):
        return ""
    for item in item_list:
        if not isinstance(item, dict):
            continue
        if item.get("type") == ITEM_TYPE_TEXT:
            text_item = item.get("text_item")
            if isinstance(text_item, dict) and text_item.get("text") is not None:
                return str(text_item.get("text") or "")
        if item.get("type") == ITEM_TYPE_VOICE:
            voice_item = item.get("voice_item")
            if isinstance(voice_item, dict) and voice_item.get("text") is not None:
                return str(voice_item.get("text") or "")
    return ""


def _coerce_attachment_type(raw: str, name: str = "", mime_type: str = "") -> str:
    value = str(raw or "").strip().lower()
    if value in {"image", "video", "text", "spreadsheet", "other"}:
        return value
    mime = str(mime_type or "").strip().lower()
    suffix = Path(name or "").suffix.lower()
    if mime.startswith("image/") or suffix in {".jpg", ".jpeg", ".png", ".gif", ".webp", ".heic"}:
        return "image"
    if mime.startswith("video/") or suffix in {".mp4", ".mov", ".m4v", ".webm"}:
        return "video"
    if suffix in {".txt", ".md", ".markdown", ".json", ".csv", ".doc", ".docx", ".pdf"}:
        return "text"
    if suffix in {".xls", ".xlsx", ".numbers"}:
        return "spreadsheet"
    return "other"


def _normalize_attachment(raw: Any, fallback_id: str, fallback_kind: str = "other") -> Optional[Dict[str, Any]]:
    if not isinstance(raw, dict):
        return None
    remote_id = str(
        raw.get("id")
        or raw.get("file_id")
        or raw.get("media_id")
        or raw.get("file_key")
        or raw.get("url")
        or raw.get("cdn_url")
        or fallback_id
    ).strip()
    name = str(
        raw.get("name")
        or raw.get("file_name")
        or raw.get("filename")
        or raw.get("title")
        or f"微信附件-{remote_id[-8:] if remote_id else fallback_id[-8:]}"
    ).strip()
    mime_type = str(raw.get("mimeType") or raw.get("mime_type") or raw.get("content_type") or "").strip()
    path = str(raw.get("path") or raw.get("local_path") or "").strip()
    url = str(raw.get("url") or raw.get("download_url") or raw.get("cdn_url") or "").strip()
    ext = str(raw.get("ext") or Path(name).suffix or "").strip()
    size_raw = raw.get("size") or raw.get("file_size") or 0
    try:
        size = int(size_raw or 0)
    except Exception:
        size = 0
    kind = _coerce_attachment_type(str(raw.get("type") or fallback_kind), name, mime_type)
    attachment_path = path or (url if url else f"wechat://attachment/{remote_id or fallback_id}")
    item: Dict[str, Any] = {
        "id": f"wx-attachment-{(remote_id or fallback_id)[-12:]}",
        "name": name,
        "path": attachment_path,
        "type": kind,
        "ext": ext,
        "size": size,
        "remoteId": remote_id or fallback_id,
    }
    if url:
        item["url"] = url
    if mime_type:
        item["mimeType"] = mime_type
    return item


def _extract_attachments(item_list: Any, raw_id: str) -> List[Dict[str, Any]]:
    if not isinstance(item_list, list):
        return []
    attachments: List[Dict[str, Any]] = []
    for index, item in enumerate(item_list):
        if not isinstance(item, dict):
            continue
        item_type = item.get("type")
        if item_type in {ITEM_TYPE_TEXT, ITEM_TYPE_VOICE}:
            continue
        fallback_id = f"{raw_id}-{index}"
        candidates: List[Tuple[str, Any]] = [
            ("image", item.get("image_item")),
            ("video", item.get("video_item")),
            ("text", item.get("file_item")),
            ("other", item.get("attachment_item")),
            ("other", item.get("media_item")),
        ]
        added = False
        for kind, raw in candidates:
            attachment = _normalize_attachment(raw, fallback_id, kind)
            if attachment:
                attachments.append(attachment)
                added = True
        if not added:
            attachment = _normalize_attachment(item, fallback_id, "other")
            if attachment:
                attachments.append(attachment)
    return attachments


class WechatOpenClawAdapter(ChannelAdapter):
    def __init__(self, channel_id: str, channel_type: str, name: str, config: Dict[str, Any]) -> None:
        super().__init__(channel_id, channel_type, name, config)
        self._stop_event = threading.Event()
        self._monitor_thread: Optional[threading.Thread] = None
        self._login_lock = threading.Lock()
        self._login_sessions: Dict[str, Dict[str, Any]] = {}
        self._typing_tickets: Dict[str, str] = {}
        self._restored_binding_id: Optional[str] = None

    @property
    def configured_account_id(self) -> str:
        return str(self.config.get("accountId") or "").strip()

    @property
    def configured_route_tag(self) -> str:
        return str(self.config.get("routeTag") or self.config.get("skRouteTag") or "").strip()

    @property
    def configured_bot_agent(self) -> str:
        return str(self.config.get("botAgent") or "").strip()

    @property
    def state_dir(self) -> Path:
        configured = str(self.config.get("stateDir") or os.environ.get("READY_WECHAT_STATE_DIR") or "").strip()
        if configured:
            return Path(configured).expanduser()
        root = os.environ.get("READY_SIDECAR_RUNTIME_ROOT", "").strip()
        if root:
            return Path(root).expanduser() / "wechat-openclaw"
        return Path.home() / ".ready" / "wechat-openclaw"

    @property
    def runtime_root(self) -> Path:
        configured = str(self.config.get("runtimeRoot") or os.environ.get("READY_SIDECAR_RUNTIME_ROOT") or "").strip()
        if configured:
            return Path(configured).expanduser()
        return self.state_dir.parent

    @property
    def attachment_root(self) -> Path:
        safe_channel = "".join(ch if ch.isalnum() or ch in {"-", "_"} else "-" for ch in self.channel_id).strip("-") or "wechat"
        return self.runtime_root / "channel-attachments" / safe_channel

    @property
    def accounts_dir(self) -> Path:
        return self.state_dir / "accounts"

    @property
    def account_index_path(self) -> Path:
        return self.state_dir / "accounts.json"

    def test(self) -> tuple[bool, Optional[str]]:
        account = self._resolve_account()
        if account:
            return True, None
        return False, "微信尚未绑定，请在设置页启用后扫码绑定。"

    def start(self) -> tuple[bool, Optional[str]]:
        if self._monitor_thread and self._monitor_thread.is_alive() and not self._stop_event.is_set():
            return True, None
        account = self._resolve_account()
        if not account:
            self.mark_error("微信尚未绑定")
            return False, "微信尚未绑定，请先扫码绑定。"
        self._stop_event = threading.Event()
        self.mark_starting()
        self._monitor_thread = threading.Thread(target=self._monitor_loop, args=(self._stop_event,), daemon=True, name=f"wechat-{self.channel_id}")
        self._monitor_thread.start()
        return True, None

    def stop(self) -> None:
        self._stop_event.set()
        with self._login_lock:
            self._login_sessions.clear()
        account = self._resolve_account()
        if account:
            try:
                self._notify_stop(account)
            except Exception:
                pass
        self.mark_stopped()

    def send(self, thread: Optional[str], text: str, attachments: Optional[List[Dict[str, Any]]] = None) -> tuple[bool, Optional[str]]:
        account = self._resolve_account()
        if not account:
            return False, "微信尚未绑定，请先扫码绑定。"
        target = self._resolve_outbound_target(account, thread)
        body = str(text or "").strip()
        outbound_attachments = self._normalize_external_attachments(attachments or [])
        if not target:
            return False, "微信账号凭据缺少可发送目标"
        if not body and not outbound_attachments:
            return False, "消息内容不能为空"

        try:
            if body:
                self._send_message_items(account, target, [{"type": ITEM_TYPE_TEXT, "text_item": {"text": body}}])
            for attachment in outbound_attachments:
                self._send_attachment(account, target, attachment)
            self.beat()
            return True, None
        except Exception as exc:
            return False, str(exc)

    def send_typing(self, thread: Optional[str], typing: bool = True) -> tuple[bool, Optional[str]]:
        account = self._resolve_account()
        if not account:
            return False, "微信尚未绑定，请先扫码绑定。"
        target = self._resolve_outbound_target(account, thread)
        if not target:
            return False, "微信账号凭据缺少可发送目标"

        try:
            ticket_key = f"{account['accountId']}:{target}"
            ticket = self._typing_tickets.get(ticket_key, "")
            if typing and not ticket:
                context_token = self._load_context_tokens(account["accountId"]).get(target)
                config = self._post_json(
                    account.get("baseUrl") or DEFAULT_BASE_URL,
                    "ilink/bot/getconfig",
                    {
                        "ilink_user_id": target,
                        **({"context_token": context_token} if context_token else {}),
                        "base_info": self._base_info(),
                    },
                    token=account["token"],
                    timeout=10,
                )
                ticket = str(config.get("typing_ticket") or "").strip()
                if ticket:
                    self._typing_tickets[ticket_key] = ticket
            if not ticket:
                return True, None

            self._post_json(
                account.get("baseUrl") or DEFAULT_BASE_URL,
                "ilink/bot/sendtyping",
                {
                    "ilink_user_id": target,
                    "typing_ticket": ticket,
                    "status": 1 if typing else 2,
                    "base_info": self._base_info(),
                },
                token=account["token"],
                timeout=10,
            )
            self.beat()
            return True, None
        except Exception as exc:
            return False, str(exc)

    def _resolve_outbound_target(self, account: Dict[str, str], thread: Optional[str]) -> str:
        target = str(thread or "").strip()
        if target:
            return target
        return str(account.get("userId") or account.get("accountId") or "").strip()

    def _notify_start(self, account: Dict[str, str]) -> None:
        self._post_json(
            account.get("baseUrl") or DEFAULT_BASE_URL,
            "ilink/bot/msg/notifystart",
            {"base_info": self._base_info()},
            token=account["token"],
            timeout=10,
        )

    def _notify_stop(self, account: Dict[str, str]) -> None:
        self._post_json(
            account.get("baseUrl") or DEFAULT_BASE_URL,
            "ilink/bot/msg/notifystop",
            {"base_info": self._base_info()},
            token=account["token"],
            timeout=10,
        )

    def _send_message_items(self, account: Dict[str, str], target: str, items: List[Dict[str, Any]]) -> None:
        context_token = self._load_context_tokens(account["accountId"]).get(target)
        payload = {
            "msg": {
                "from_user_id": "",
                "to_user_id": target,
                "client_id": _generate_client_id(),
                "message_type": MESSAGE_TYPE_BOT,
                "message_state": MESSAGE_STATE_FINISH,
                "item_list": items,
                **({"context_token": context_token} if context_token else {}),
            },
            "base_info": self._base_info(),
        }
        self._post_json(
            account.get("baseUrl") or DEFAULT_BASE_URL,
            "ilink/bot/sendmessage",
            payload,
            token=account["token"],
            timeout=15,
        )

    def _send_attachment(self, account: Dict[str, str], target: str, attachment: Dict[str, Any]) -> None:
        path = Path(str(attachment.get("path") or "")).expanduser()
        if not path.is_absolute() or not path.exists() or not path.is_file():
            raise RuntimeError(f"微信附件文件不可用：{attachment.get('name') or path}")
        stat = path.stat()
        if stat.st_size <= 0:
            raise RuntimeError(f"微信附件为空：{path.name}")
        if stat.st_size > WEIXIN_MEDIA_MAX_BYTES:
            raise RuntimeError(f"微信附件超过 100MB：{path.name}")

        media_type = _upload_media_type_for_file(path)
        uploaded = self._upload_attachment_to_cdn(account, target, path, media_type)
        aes_key_b64 = base64.b64encode(uploaded["aeskey"].encode("ascii")).decode("ascii")
        media = {
            "encrypt_query_param": uploaded["downloadEncryptedQueryParam"],
            "aes_key": aes_key_b64,
            "encrypt_type": 1,
        }
        if media_type == UPLOAD_MEDIA_IMAGE:
            item = {
                "type": ITEM_TYPE_IMAGE,
                "image_item": {
                    "media": media,
                    "mid_size": uploaded["fileSizeCiphertext"],
                },
            }
        elif media_type == UPLOAD_MEDIA_VIDEO:
            item = {
                "type": ITEM_TYPE_VIDEO,
                "video_item": {
                    "media": media,
                    "video_size": uploaded["fileSizeCiphertext"],
                },
            }
        else:
            item = {
                "type": ITEM_TYPE_FILE,
                "file_item": {
                    "media": media,
                    "file_name": str(attachment.get("name") or path.name),
                    "len": str(uploaded["fileSize"]),
                },
            }
        self._send_message_items(account, target, [item])

    def _upload_attachment_to_cdn(
        self,
        account: Dict[str, str],
        target: str,
        path: Path,
        media_type: int,
    ) -> Dict[str, Any]:
        plaintext = path.read_bytes()
        raw_size = len(plaintext)
        raw_md5 = hashlib.md5(plaintext).hexdigest()
        filekey = secrets.token_hex(16)
        aeskey = secrets.token_bytes(16)
        aeskey_hex = aeskey.hex()
        encrypted = _encrypt_aes_ecb(plaintext, aeskey)
        upload_resp = self._post_json(
            account.get("baseUrl") or DEFAULT_BASE_URL,
            "ilink/bot/getuploadurl",
            {
                "filekey": filekey,
                "media_type": media_type,
                "to_user_id": target,
                "rawsize": raw_size,
                "rawfilemd5": raw_md5,
                "filesize": len(encrypted),
                "no_need_thumb": True,
                "aeskey": aeskey_hex,
                "base_info": self._base_info(),
            },
            token=account["token"],
            timeout=15,
        )
        upload_url = str(upload_resp.get("upload_full_url") or "").strip()
        upload_param = str(upload_resp.get("upload_param") or "").strip()
        if not upload_url:
            if not upload_param:
                raise RuntimeError("微信服务未返回附件上传地址")
            upload_url = _build_cdn_upload_url(upload_param, filekey, account.get("cdnBaseUrl") or DEFAULT_CDN_BASE_URL)

        headers = self._post_bytes(upload_url, encrypted, timeout=60)
        download_param = str(headers.get("x-encrypted-param") or headers.get("X-Encrypted-Param") or "").strip()
        if not download_param:
            raise RuntimeError("微信 CDN 上传成功但未返回下载参数")
        return {
            "filekey": filekey,
            "downloadEncryptedQueryParam": download_param,
            "aeskey": aeskey_hex,
            "fileSize": raw_size,
            "fileSizeCiphertext": _aes_ecb_padded_size(raw_size),
        }

    def start_login(self, session_key: str, force: bool = False) -> Dict[str, Any]:
        with self._login_lock:
            self._purge_expired_login_sessions_locked()
            self._login_sessions.clear()

        try:
            response = self._post_json(
                DEFAULT_BASE_URL,
                f"ilink/bot/get_bot_qrcode?bot_type={parse.quote(DEFAULT_BOT_TYPE)}",
                {"local_token_list": self._recent_tokens()},
                timeout=15,
            )
            qrcode = str(response.get("qrcode") or "").strip()
            qrcode_url = str(response.get("qrcode_img_content") or "").strip()
            if not qrcode or not qrcode_url:
                return {"success": False, "error": "微信服务未返回可用二维码"}

            session = {
                "sessionKey": session_key,
                "qrcode": qrcode,
                "qrcodeUrl": qrcode_url,
                "status": "waiting",
                "message": "请用手机微信扫码确认绑定。",
                "startedAt": time.time(),
                "currentBaseUrl": DEFAULT_BASE_URL,
                "verifyCode": "",
                "accountId": "",
            }
            with self._login_lock:
                self._login_sessions[session_key] = session
            threading.Thread(
                target=self._poll_login_session,
                args=(session_key,),
                daemon=True,
                name=f"wechat-login-{session_key[:8]}",
            ).start()
            return {
                "success": True,
                "sessionKey": session_key,
                "qrcodeUrl": qrcode_url,
                "status": "waiting",
                "message": session["message"],
            }
        except Exception as exc:
            return {"success": False, "error": f"生成微信二维码失败：{exc}"}

    def get_login_status(self, session_key: str) -> Dict[str, Any]:
        with self._login_lock:
            session = self._login_sessions.get(session_key)
            if not session:
                return {"success": False, "status": "missing", "error": "登录会话不存在或已结束"}
            return {
                "success": True,
                "sessionKey": session_key,
                "status": session.get("status") or "waiting",
                "message": session.get("message") or "",
                "accountId": session.get("accountId") or "",
                "qrcodeUrl": session.get("qrcodeUrl") or "",
                "userId": session.get("userId") or "",
            }

    def submit_verify_code(self, session_key: str, code: str) -> Dict[str, Any]:
        normalized = re.sub(r"\D+", "", str(code or ""))
        if not normalized:
            return {"success": False, "error": "请输入手机上显示的数字"}
        with self._login_lock:
            session = self._login_sessions.get(session_key)
            if not session:
                return {"success": False, "error": "登录会话不存在或已结束"}
            session["verifyCode"] = normalized
            session["status"] = "waiting"
            session["message"] = "已提交数字，继续等待微信确认。"
        return {"success": True}

    def handle_openclaw_event(self, payload: Dict[str, Any]) -> tuple[bool, Optional[str]]:
        # Kept for compatibility with older hook-style bridge calls.
        context = payload.get("context") if isinstance(payload.get("context"), dict) else payload
        if not isinstance(context, dict):
            return False, "invalid payload"
        text = str(context.get("content") or context.get("text") or context.get("message") or "").strip()
        thread = str(context.get("from") or context.get("thread") or context.get("target") or "").strip()
        attachments = self._normalize_external_attachments(context.get("attachments") or payload.get("attachments"))
        if (not text and not attachments) or not thread:
            return False, "微信入站事件缺少 sender/thread 或文本/附件"
        raw_id = str(payload.get("id") or context.get("id") or int(time.time() * 1000))
        self._emit_message(thread, thread, text, raw_id, {}, attachments)
        return True, None

    def _poll_login_session(self, session_key: str) -> None:
        deadline = time.time() + LOGIN_WAIT_SECONDS
        while time.time() < deadline:
            with self._login_lock:
                session = self._login_sessions.get(session_key)
                if not session:
                    return
                if time.time() - float(session.get("startedAt") or 0) > LOGIN_TTL_SECONDS:
                    session["status"] = "expired"
                    session["message"] = "二维码已过期，请重新启用。"
                    return
                qrcode = str(session.get("qrcode") or "")
                base_url = str(session.get("currentBaseUrl") or DEFAULT_BASE_URL)
                verify_code = str(session.get("verifyCode") or "").strip()

            endpoint = f"ilink/bot/get_qrcode_status?qrcode={parse.quote(qrcode)}"
            if verify_code:
                endpoint += f"&verify_code={parse.quote(verify_code)}"
            try:
                response = self._get_json(base_url, endpoint, timeout=QR_POLL_TIMEOUT_SECONDS)
            except Exception:
                response = {"status": "wait"}

            with self._login_lock:
                if session_key not in self._login_sessions:
                    return
            status = str(response.get("status") or "wait")
            if status == "wait":
                self._update_login_session(session_key, status="waiting", message="等待扫码确认。")
            elif status == "scaned":
                self._update_login_session(session_key, status="scanned", message="已扫码，等待手机确认。", verifyCode="")
            elif status == "need_verifycode":
                self._update_login_session(session_key, status="needs_verify_code", message="请输入手机微信显示的数字。")
            elif status == "verify_code_blocked":
                self._update_login_session(session_key, status="error", message="数字多次输入错误，请重新启用。")
                return
            elif status == "scaned_but_redirect":
                redirect_host = str(response.get("redirect_host") or "").strip()
                if redirect_host:
                    self._update_login_session(session_key, currentBaseUrl=f"https://{redirect_host}")
            elif status == "binded_redirect":
                account = self._resolve_account()
                if not account:
                    self._update_login_session(
                        session_key,
                        status="error",
                        message="微信提示已绑定过，但 Ready 本地没有可用凭据，请重新启用。",
                    )
                    return
                if self._emit:
                    self._emit("channel.wechat-bound", {"id": session_key, "channelId": self.channel_id,
                        "sessionKey": session_key, "accountId": account["accountId"], "userId": account.get("userId") or ""})
                self._update_login_session(
                    session_key,
                    status="already_connected",
                    message="此微信已绑定过 Ready。",
                    accountId=account["accountId"],
                    userId=account.get("userId") or "",
                )
                return
            elif status == "confirmed":
                account_id = str(response.get("ilink_bot_id") or "").strip()
                token = str(response.get("bot_token") or "").strip()
                if not account_id or not token:
                    self._update_login_session(session_key, status="error", message="微信确认成功，但服务未返回完整凭据。")
                    return
                account = {
                    "accountId": account_id,
                    "token": token,
                    "baseUrl": str(response.get("baseurl") or DEFAULT_BASE_URL).strip() or DEFAULT_BASE_URL,
                    "cdnBaseUrl": str(response.get("cdnBaseUrl") or response.get("cdn_base_url") or DEFAULT_CDN_BASE_URL).strip() or DEFAULT_CDN_BASE_URL,
                    "userId": str(response.get("ilink_user_id") or "").strip(),
                    "savedAt": now_iso(),
                }
                with self._login_lock:
                    if session_key not in self._login_sessions:
                        return
                    self._save_account(account)
                if self._emit:
                    self._emit("channel.wechat-bound", {"id": session_key, "channelId": self.channel_id,
                        "sessionKey": session_key, "accountId": account_id, "userId": account["userId"]})
                self._update_login_session(
                    session_key,
                    status="connected",
                    message="微信已绑定。",
                    accountId=account_id,
                    userId=account["userId"],
                )
                return
            time.sleep(1)

        self._update_login_session(session_key, status="error", message="绑定超时，请重新启用。")

    def _update_login_session(self, session_key: str, **updates: Any) -> None:
        with self._login_lock:
            session = self._login_sessions.get(session_key)
            if session:
                session.update(updates)

    def _purge_expired_login_sessions_locked(self) -> None:
        now = time.time()
        for key, session in list(self._login_sessions.items()):
            if now - float(session.get("startedAt") or 0) > LOGIN_WAIT_SECONDS:
                self._login_sessions.pop(key, None)

    def _monitor_loop(self, stopped: threading.Event) -> None:
        notified = False
        while not stopped.is_set():
            account = self._resolve_account()
            if not account:
                self.mark_error("微信账号凭据缺失")
                return
            try:
                if not notified:
                    self._notify_start(account)
                    notified = True
                self._poll_updates_once(account, stopped)
                if not stopped.is_set():
                    self.mark_running()
            except Exception as exc:
                if not stopped.is_set():
                    self.mark_error(str(exc))
                stopped.wait(5)

    def _poll_updates_once(self, account: Dict[str, str], stopped: Optional[threading.Event] = None) -> None:
        sync_path = self.accounts_dir / f"{_safe_account_filename(account['accountId'])}.sync.json"
        sync_buf = ""
        try:
            if sync_path.exists():
                parsed = json.loads(sync_path.read_text(encoding="utf-8"))
                if isinstance(parsed, dict):
                    sync_buf = str(parsed.get("get_updates_buf") or "")
        except Exception:
            sync_buf = ""

        try:
            response = self._post_json(
                account.get("baseUrl") or DEFAULT_BASE_URL,
                "ilink/bot/getupdates",
                {"get_updates_buf": sync_buf, "base_info": self._base_info()},
                token=account["token"],
                timeout=GET_UPDATES_TIMEOUT_SECONDS,
            )
        except (TimeoutError, socket.timeout):
            return
        if stopped is not None and stopped.is_set():
            return
        if int(response.get("ret") or 0) != 0:
            raise RuntimeError(f"微信收信失败：ret={response.get('ret')}，请检查连接或重新绑定")
        if not self.config.get("allowedSenderId") and account.get("userId") and self._emit:
            self._restored_binding_id = "restored-" + hashlib.sha256(f"{self.channel_id}:{account['accountId']}:{account['userId']}".encode()).hexdigest()[:32]
            self._emit("channel.wechat-restored", {"id": f"restore:{self.channel_id}:{account['accountId']}",
                "channelId": self.channel_id, "accountId": account["accountId"], "userId": account["userId"], "restored": True, "bindingId": self._restored_binding_id})
        next_buf = response.get("get_updates_buf")
        messages = response.get("msgs")
        if not isinstance(messages, list):
            messages = []
        context_tokens = self._load_context_tokens(account["accountId"])
        for msg in messages:
            if not isinstance(msg, dict):
                continue
            thread = str(msg.get("from_user_id") or "").strip()
            if not thread or (account.get("userId") and thread != account["userId"]):
                continue
            token = str(msg.get("context_token") or "").strip()
            if token and context_tokens.get(thread) != token:
                context_tokens[thread] = token
                self._save_context_tokens(account["accountId"], context_tokens)
            text = _extract_text(msg.get("item_list")).strip()
            raw_id = str(msg.get("msg_id") or msg.get("client_id") or hashlib.sha256(json.dumps(msg, sort_keys=True).encode()).hexdigest())
            attachments = self._extract_message_attachments(account, msg.get("item_list"), raw_id)
            if not text and not attachments:
                continue
            self._emit_message(thread, thread, text, raw_id, {"accountId": account["accountId"]}, attachments)
        if isinstance(next_buf, str):
            _write_private_json(sync_path, {"get_updates_buf": next_buf})

    def _extract_message_attachments(self, account: Dict[str, str], item_list: Any, raw_id: str) -> List[Dict[str, Any]]:
        if not isinstance(item_list, list):
            return []
        attachments: List[Dict[str, Any]] = []
        for index, item in enumerate(item_list):
            if not isinstance(item, dict):
                continue
            item_type = item.get("type")
            if item_type in {ITEM_TYPE_TEXT, ITEM_TYPE_VOICE}:
                continue
            fallback_id = f"{raw_id}-{index}"
            downloaded = self._download_message_attachment(account, item, fallback_id)
            if downloaded:
                attachments.append(downloaded)
                continue
            extracted = _extract_attachments([item], fallback_id)
            attachments.extend(extracted)
        return attachments

    def _download_message_attachment(
        self,
        account: Dict[str, str],
        item: Dict[str, Any],
        fallback_id: str,
    ) -> Optional[Dict[str, Any]]:
        item_type = item.get("type")
        raw: Any = None
        filename = f"wechat-{fallback_id}.bin"
        mime_type = "application/octet-stream"
        kind = "other"
        if item_type == ITEM_TYPE_IMAGE:
            raw = item.get("image_item")
            filename = f"image-{int(time.time() * 1000)}.jpg"
            mime_type = "image/jpeg"
            kind = "image"
        elif item_type == ITEM_TYPE_FILE:
            raw = item.get("file_item")
            if isinstance(raw, dict):
                filename = str(raw.get("file_name") or raw.get("name") or filename)
            mime_type = _guess_mime_type(filename)
            kind = _coerce_attachment_type("text", filename, mime_type)
        elif item_type == ITEM_TYPE_VIDEO:
            raw = item.get("video_item")
            filename = f"video-{int(time.time() * 1000)}.mp4"
            mime_type = "video/mp4"
            kind = "video"
        if not isinstance(raw, dict):
            return None
        media = raw.get("media")
        if not isinstance(media, dict):
            return None
        url = _build_cdn_download_url(media, account.get("cdnBaseUrl") or DEFAULT_CDN_BASE_URL)
        if not url:
            return None
        aes_key = _parse_cdn_aes_key(str(raw.get("aeskey") or media.get("aes_key") or ""))
        try:
            data = self._get_bytes(url, timeout=60)
            if len(data) > WEIXIN_MEDIA_MAX_BYTES:
                return None
            if aes_key:
                data = _decrypt_aes_ecb(data, aes_key)
            safe_name = _safe_filename(filename, "wechat-attachment.bin")
            self.attachment_root.mkdir(parents=True, exist_ok=True)
            target = self.attachment_root / f"{_safe_filename(fallback_id)}-{safe_name}"
            write_private_bytes(target, data)
            return {
                "id": f"wx-attachment-{fallback_id[-12:]}",
                "name": safe_name,
                "path": str(target),
                "type": kind,
                "ext": Path(safe_name).suffix,
                "size": len(data),
                "mimeType": mime_type,
                "remoteId": fallback_id,
                "downloaded": True,
            }
        except Exception:
            return None

    def _normalize_external_attachments(self, raw: Any) -> List[Dict[str, Any]]:
        if not isinstance(raw, list):
            return []
        attachments: List[Dict[str, Any]] = []
        for index, item in enumerate(raw):
            attachment = _normalize_attachment(item, f"hook-{index}", "other")
            if attachment:
                attachments.append(attachment)
        return attachments

    def _emit_message(
        self,
        thread: str,
        sender: str,
        text: str,
        raw_id: str,
        meta: Dict[str, Any],
        attachments: Optional[List[Dict[str, Any]]] = None,
    ) -> None:
        event_id = f"wx:{self.channel_id}:{meta.get('accountId', 'external')}:{raw_id}"
        self.emit_inbound({
            "id": event_id,
            "channelId": self.channel_id,
            "source": self.channel_type,
            "thread": thread,
            "sender": sender,
            "text": text,
            "timestamp": now_iso(),
            "idempotencyKey": event_id,
            "meta": {"messageId": raw_id, **meta, "bindingId": self.config.get("bindingId") or self._restored_binding_id},
            "attachments": attachments or [],
        })

    def _resolve_account(self) -> Optional[Dict[str, str]]:
        account_id = self.configured_account_id
        if account_id:
            return self._load_account(account_id)
        ids = self._list_account_ids()
        if not ids:
            return None
        return self._load_account(ids[-1])

    def _list_account_ids(self) -> List[str]:
        try:
            if not self.account_index_path.exists():
                return []
            parsed = json.loads(self.account_index_path.read_text(encoding="utf-8"))
            if isinstance(parsed, list):
                return [str(item) for item in parsed if str(item).strip()]
        except Exception:
            return []
        return []

    def _load_account(self, account_id: str) -> Optional[Dict[str, str]]:
        path = self.accounts_dir / f"{_safe_account_filename(account_id)}.json"
        try:
            if not path.exists():
                return None
            parsed = json.loads(path.read_text(encoding="utf-8"))
            if not isinstance(parsed, dict):
                return None
            token = str(parsed.get("token") or "").strip()
            if not token:
                return None
            return {
                "accountId": str(parsed.get("accountId") or account_id),
                "token": token,
                "baseUrl": str(parsed.get("baseUrl") or DEFAULT_BASE_URL).strip() or DEFAULT_BASE_URL,
                "cdnBaseUrl": str(parsed.get("cdnBaseUrl") or DEFAULT_CDN_BASE_URL).strip() or DEFAULT_CDN_BASE_URL,
                "userId": str(parsed.get("userId") or "").strip(),
            }
        except Exception:
            return None

    def _save_account(self, account: Dict[str, str]) -> None:
        self.accounts_dir.mkdir(parents=True, exist_ok=True)
        account_id = account["accountId"]
        ids = [item for item in self._list_account_ids() if item != account_id]
        ids.append(account_id)
        self.state_dir.mkdir(parents=True, exist_ok=True)
        path = self.accounts_dir / f"{_safe_account_filename(account_id)}.json"
        _write_private_json(path, account)
        _write_private_json(self.account_index_path, ids)

    def forget_account(self) -> None:
        account_id = self.configured_account_id
        if not account_id:
            return
        stem = _safe_account_filename(account_id)
        for suffix in [".json", ".sync.json", ".context-tokens.json"]:
            (self.accounts_dir / f"{stem}{suffix}").unlink(missing_ok=True)
        _write_private_json(self.account_index_path, [item for item in self._list_account_ids() if item != account_id])

    def _recent_tokens(self) -> List[str]:
        tokens: List[str] = []
        for account_id in reversed(self._list_account_ids()):
            account = self._load_account(account_id)
            if account and account.get("token"):
                tokens.append(account["token"])
            if len(tokens) >= 10:
                break
        return tokens

    def _load_context_tokens(self, account_id: str) -> Dict[str, str]:
        path = self.accounts_dir / f"{_safe_account_filename(account_id)}.context-tokens.json"
        try:
            if not path.exists():
                return {}
            parsed = json.loads(path.read_text(encoding="utf-8"))
            if isinstance(parsed, dict):
                return {str(k): str(v) for k, v in parsed.items() if str(v)}
        except Exception:
            return {}
        return {}

    def _save_context_tokens(self, account_id: str, tokens: Dict[str, str]) -> None:
        self.accounts_dir.mkdir(parents=True, exist_ok=True)
        path = self.accounts_dir / f"{_safe_account_filename(account_id)}.context-tokens.json"
        _write_private_json(path, tokens)

    def _base_info(self) -> Dict[str, str]:
        app_version = os.environ.get("READY_APP_VERSION", "0.0.0").strip() or "0.0.0"
        return {
            "channel_version": CHANNEL_VERSION,
            "bot_agent": self.configured_bot_agent or f"Ready/{app_version} OpenClaw-Weixin/{CHANNEL_VERSION}",
        }

    def _headers(self, token: Optional[str] = None) -> Dict[str, str]:
        headers = {
            "Content-Type": "application/json",
            "AuthorizationType": "ilink_bot_token",
            "X-WECHAT-UIN": _random_wechat_uin(),
            "iLink-App-Id": ILINK_APP_ID,
            "iLink-App-ClientVersion": ILINK_CLIENT_VERSION,
        }
        if token:
            headers["Authorization"] = f"Bearer {token}"
        route_tag = self.configured_route_tag
        if route_tag:
            headers["SKRouteTag"] = route_tag
        return headers

    def _get_json(self, base_url: str, endpoint: str, timeout: int) -> Dict[str, Any]:
        url = parse.urljoin(base_url.rstrip("/") + "/", endpoint)
        req = request.Request(url, headers={
            "iLink-App-Id": ILINK_APP_ID,
            "iLink-App-ClientVersion": ILINK_CLIENT_VERSION,
        }, method="GET")
        try:
            with request.urlopen(req, timeout=timeout) as resp:
                raw = resp.read().decode("utf-8")
        except urlerror.HTTPError as exc:
            raw = exc.read().decode("utf-8", errors="replace")
            raise RuntimeError(f"HTTP {exc.code}: {raw}") from exc
        parsed = json.loads(raw or "{}")
        parsed_dict = parsed if isinstance(parsed, dict) else {}
        _raise_for_business_error(endpoint, parsed_dict)
        return parsed_dict

    def _get_bytes(self, url: str, timeout: int = 60) -> bytes:
        req = request.Request(url, method="GET")
        try:
            with request.urlopen(req, timeout=timeout) as resp:
                return resp.read()
        except urlerror.HTTPError as exc:
            raw = exc.read().decode("utf-8", errors="replace")
            raise RuntimeError(f"HTTP {exc.code}: {raw}") from exc

    def _post_json(
        self,
        base_url: str,
        endpoint: str,
        payload: Dict[str, Any],
        token: Optional[str] = None,
        timeout: int = 15,
    ) -> Dict[str, Any]:
        response = self._http_request_json("POST", base_url, endpoint, payload, token=token, timeout=timeout)
        _raise_for_business_error(endpoint, response)
        return response

    def _http_request_json(
        self,
        method: str,
        base_url: str,
        endpoint: str,
        payload: Optional[Dict[str, Any]] = None,
        token: Optional[str] = None,
        timeout: int = 15,
    ) -> Dict[str, Any]:
        url = parse.urljoin(base_url.rstrip("/") + "/", endpoint)
        data = None if payload is None else json.dumps(payload, ensure_ascii=False).encode("utf-8")
        req = request.Request(url, data=data, headers=self._headers(token), method=method)
        try:
            with request.urlopen(req, timeout=timeout) as resp:
                raw = resp.read().decode("utf-8")
        except urlerror.HTTPError as exc:
            raw = exc.read().decode("utf-8", errors="replace")
            raise RuntimeError(f"HTTP {exc.code}: {raw}") from exc
        parsed = json.loads(raw or "{}")
        return parsed if isinstance(parsed, dict) else {}

    def _post_bytes(self, url: str, data: bytes, timeout: int = 60) -> Dict[str, str]:
        req = request.Request(
            url,
            data=data,
            headers={"Content-Type": "application/octet-stream"},
            method="POST",
        )
        try:
            with request.urlopen(req, timeout=timeout) as resp:
                resp.read()
                return {key: value for key, value in resp.headers.items()}
        except urlerror.HTTPError as exc:
            raw = exc.read().decode("utf-8", errors="replace")
            raise RuntimeError(f"HTTP {exc.code}: {raw}") from exc
