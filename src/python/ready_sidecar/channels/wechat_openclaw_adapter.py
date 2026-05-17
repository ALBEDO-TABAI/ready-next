from __future__ import annotations

import base64
import json
import os
import random
import re
import socket
import threading
import time
import uuid
from pathlib import Path
from typing import Any, Dict, List, Optional, Tuple
from urllib import error as urlerror
from urllib import parse, request

from .base import ChannelAdapter, now_iso


DEFAULT_BASE_URL = "https://ilinkai.weixin.qq.com"
DEFAULT_BOT_TYPE = "3"
CHANNEL_VERSION = "2.4.3"
ILINK_APP_ID = "bot"
ILINK_CLIENT_VERSION = str((2 << 16) | (4 << 8) | 3)
LOGIN_TTL_SECONDS = 5 * 60
LOGIN_WAIT_SECONDS = 8 * 60
QR_POLL_TIMEOUT_SECONDS = 35
GET_UPDATES_TIMEOUT_SECONDS = 35


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


def _extract_text(item_list: Any) -> str:
    if not isinstance(item_list, list):
        return ""
    for item in item_list:
        if not isinstance(item, dict):
            continue
        if item.get("type") == 1:
            text_item = item.get("text_item")
            if isinstance(text_item, dict) and text_item.get("text") is not None:
                return str(text_item.get("text") or "")
        if item.get("type") == 3:
            voice_item = item.get("voice_item")
            if isinstance(voice_item, dict) and voice_item.get("text") is not None:
                return str(voice_item.get("text") or "")
    return ""


class WechatOpenClawAdapter(ChannelAdapter):
    def __init__(self, channel_id: str, channel_type: str, name: str, config: Dict[str, Any]) -> None:
        super().__init__(channel_id, channel_type, name, config)
        self._stop_event = threading.Event()
        self._monitor_thread: Optional[threading.Thread] = None
        self._login_lock = threading.Lock()
        self._login_sessions: Dict[str, Dict[str, Any]] = {}

    @property
    def default_target(self) -> str:
        return str(self.config.get("defaultTarget") or "").strip()

    @property
    def configured_account_id(self) -> str:
        return str(self.config.get("accountId") or "").strip()

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
        account = self._resolve_account()
        if not account:
            self.mark_error("微信尚未绑定")
            return False, "微信尚未绑定，请先扫码绑定。"
        self._stop_event.clear()
        if not self._monitor_thread or not self._monitor_thread.is_alive():
            self._monitor_thread = threading.Thread(target=self._monitor_loop, daemon=True, name=f"wechat-{self.channel_id}")
            self._monitor_thread.start()
        self.mark_running()
        return True, None

    def stop(self) -> None:
        self._stop_event.set()
        self.mark_stopped()

    def send(self, thread: Optional[str], text: str) -> tuple[bool, Optional[str]]:
        account = self._resolve_account()
        if not account:
            return False, "微信尚未绑定，请先扫码绑定。"
        target = str(thread or self.default_target).strip()
        body = str(text or "").strip()
        if not target:
            return False, "缺少微信收件人"
        if not body:
            return False, "消息内容不能为空"

        context_token = self._load_context_tokens(account["accountId"]).get(target)
        payload = {
            "msg": {
                "from_user_id": "",
                "to_user_id": target,
                "client_id": _generate_client_id(),
                "message_type": 2,
                "message_state": 2,
                "item_list": [{"type": 1, "text_item": {"text": body}}],
                **({"context_token": context_token} if context_token else {}),
            },
            "base_info": self._base_info(),
        }
        try:
            self._post_json(
                account.get("baseUrl") or DEFAULT_BASE_URL,
                "ilink/bot/sendmessage",
                payload,
                token=account["token"],
                timeout=15,
            )
            self.beat()
            return True, None
        except Exception as exc:
            self.mark_error(str(exc))
            return False, str(exc)

    def start_login(self, force: bool = False) -> Dict[str, Any]:
        session_key = str(uuid.uuid4())
        with self._login_lock:
            self._purge_expired_login_sessions_locked()

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
        if not text or not thread:
            return False, "微信入站事件缺少 sender/thread 或文本"
        raw_id = str(payload.get("id") or context.get("id") or int(time.time() * 1000))
        self._emit_message(thread, thread, text, raw_id, {})
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
                self._update_login_session(
                    session_key,
                    status="already_connected",
                    message="此微信已绑定过 Ready。",
                    accountId=account["accountId"],
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
                    "userId": str(response.get("ilink_user_id") or "").strip(),
                    "savedAt": now_iso(),
                }
                self._save_account(account)
                self._update_login_session(
                    session_key,
                    status="connected",
                    message="微信已绑定。",
                    accountId=account_id,
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

    def _monitor_loop(self) -> None:
        while not self._stop_event.is_set():
            account = self._resolve_account()
            if not account:
                self.mark_error("微信账号凭据缺失")
                return
            try:
                self._poll_updates_once(account)
                self.beat()
            except Exception as exc:
                self.mark_error(str(exc))
                self._stop_event.wait(5)

    def _poll_updates_once(self, account: Dict[str, str]) -> None:
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
        next_buf = response.get("get_updates_buf")
        if isinstance(next_buf, str):
            self.accounts_dir.mkdir(parents=True, exist_ok=True)
            sync_path.write_text(json.dumps({"get_updates_buf": next_buf}, ensure_ascii=False), encoding="utf-8")

        messages = response.get("msgs")
        if not isinstance(messages, list):
            return
        context_tokens = self._load_context_tokens(account["accountId"])
        for msg in messages:
            if not isinstance(msg, dict):
                continue
            thread = str(msg.get("from_user_id") or "").strip()
            if not thread:
                continue
            token = str(msg.get("context_token") or "").strip()
            if token:
                context_tokens[thread] = token
            text = _extract_text(msg.get("item_list")).strip()
            if not text:
                continue
            raw_id = str(msg.get("msg_id") or msg.get("client_id") or int(time.time() * 1000))
            self._emit_message(thread, thread, text, raw_id, {"accountId": account["accountId"]})
        self._save_context_tokens(account["accountId"], context_tokens)

    def _emit_message(self, thread: str, sender: str, text: str, raw_id: str, meta: Dict[str, Any]) -> None:
        event_id = f"wx:{self.channel_id}:{raw_id}"
        self.emit_inbound({
            "id": event_id,
            "channelId": self.channel_id,
            "source": self.channel_type,
            "thread": thread,
            "sender": sender,
            "text": text,
            "timestamp": now_iso(),
            "idempotencyKey": event_id,
            "meta": {"messageId": raw_id, **meta},
            "attachments": [],
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
        self.account_index_path.write_text(json.dumps(ids, ensure_ascii=False, indent=2), encoding="utf-8")
        path = self.accounts_dir / f"{_safe_account_filename(account_id)}.json"
        path.write_text(json.dumps(account, ensure_ascii=False, indent=2), encoding="utf-8")
        try:
            os.chmod(path, 0o600)
        except Exception:
            pass

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
        path.write_text(json.dumps(tokens, ensure_ascii=False), encoding="utf-8")

    def _base_info(self) -> Dict[str, str]:
        return {
            "channel_version": CHANNEL_VERSION,
            "bot_agent": "Ready/0.1.0 OpenClaw-Weixin/2.4.3",
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
        return parsed if isinstance(parsed, dict) else {}

    def _post_json(
        self,
        base_url: str,
        endpoint: str,
        payload: Dict[str, Any],
        token: Optional[str] = None,
        timeout: int = 15,
    ) -> Dict[str, Any]:
        return self._http_request_json("POST", base_url, endpoint, payload, token=token, timeout=timeout)

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
