"""
Feishu Plugin Operations

Provides comprehensive Feishu plugin capabilities including:
- Document operations (read, create, update, list)
- Message operations (send, get context, reply)
- Calendar operations (list, create, update, delete events)
- Group chat operations (list, get members, get info)
- File operations (upload, download)
"""

from __future__ import annotations

import json
import time
from pathlib import Path
from typing import Any, Dict, List, Optional

import requests


class FeishuPluginOperations:
    """Feishu plugin capability operations"""

    def __init__(self, app_id: str, app_secret: str, domain: str = "https://open.feishu.cn"):
        self.app_id = app_id
        self.app_secret = app_secret
        self.domain = domain.rstrip("/")
        self._access_token: Optional[str] = None
        self._access_token_exp_at = 0.0

    def _refresh_access_token(self, force: bool = False) -> tuple[Optional[str], Optional[str]]:
        """Refresh tenant access token"""
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

    def _make_request(
        self,
        method: str,
        path: str,
        params: Optional[Dict[str, Any]] = None,
        json_data: Optional[Dict[str, Any]] = None,
        timeout: int = 15,
    ) -> tuple[bool, Optional[str], Optional[Dict[str, Any]]]:
        """Make authenticated request to Feishu API"""
        token, err = self._refresh_access_token()
        if not token:
            return False, err or "飞书鉴权失败", None

        try:
            url = f"{self.domain}{path}"
            headers = {
                "Authorization": f"Bearer {token}",
                "Content-Type": "application/json; charset=utf-8",
            }

            resp = requests.request(
                method=method,
                url=url,
                params=params,
                json=json_data,
                headers=headers,
                timeout=timeout,
            )

            data = resp.json()
            code = int(data.get("code", -1))
            if code != 0:
                return False, str(data.get("msg") or data.get("message") or "飞书 API 调用失败"), None

            return True, None, data.get("data")
        except Exception as exc:
            return False, str(exc), None

    # ============================================================
    # Document Operations
    # ============================================================

    async def read_document(self, doc_token: str, doc_type: str) -> Dict[str, Any]:
        """Read Feishu document content"""
        if doc_type == "doc":
            # Old doc format
            success, error, data = self._make_request(
                "GET",
                f"/open-apis/doc/v2/{doc_token}/content",
            )
        elif doc_type == "docx":
            # New docx format
            success, error, data = self._make_request(
                "GET",
                f"/open-apis/docx/v1/documents/{doc_token}/raw_content",
            )
        elif doc_type == "sheet":
            # Spreadsheet
            success, error, data = self._make_request(
                "GET",
                f"/open-apis/sheets/v2/spreadsheets/{doc_token}/metainfo",
            )
        elif doc_type == "bitable":
            # Bitable (multi-dimensional table)
            success, error, data = self._make_request(
                "GET",
                f"/open-apis/bitable/v1/apps/{doc_token}",
            )
        else:
            return {"success": False, "error": f"不支持的文档类型: {doc_type}"}

        if not success:
            return {"success": False, "error": error}

        return {"success": True, "data": data}

    async def create_document(
        self,
        title: str,
        doc_type: str,
        content: Optional[Dict[str, Any]] = None,
        folder_token: Optional[str] = None,
    ) -> Dict[str, Any]:
        """Create new Feishu document"""
        payload: Dict[str, Any] = {"title": title}

        if folder_token:
            payload["folder_token"] = folder_token

        if content:
            payload["content"] = content

        if doc_type == "docx":
            success, error, data = self._make_request(
                "POST",
                "/open-apis/docx/v1/documents",
                json_data=payload,
            )
        elif doc_type == "sheet":
            success, error, data = self._make_request(
                "POST",
                "/open-apis/sheets/v3/spreadsheets",
                json_data=payload,
            )
        elif doc_type == "bitable":
            success, error, data = self._make_request(
                "POST",
                "/open-apis/bitable/v1/apps",
                json_data=payload,
            )
        else:
            return {"success": False, "error": f"不支持的文档类型: {doc_type}"}

        if not success:
            return {"success": False, "error": error}

        return {"success": True, "data": data}

    async def update_document(
        self,
        doc_token: str,
        doc_type: str,
        updates: Dict[str, Any],
    ) -> Dict[str, Any]:
        """Update existing Feishu document"""
        if doc_type == "docx":
            success, error, data = self._make_request(
                "PATCH",
                f"/open-apis/docx/v1/documents/{doc_token}",
                json_data=updates,
            )
        elif doc_type == "sheet":
            success, error, data = self._make_request(
                "PUT",
                f"/open-apis/sheets/v2/spreadsheets/{doc_token}/values",
                json_data=updates,
            )
        elif doc_type == "bitable":
            success, error, data = self._make_request(
                "PATCH",
                f"/open-apis/bitable/v1/apps/{doc_token}",
                json_data=updates,
            )
        else:
            return {"success": False, "error": f"不支持的文档类型: {doc_type}"}

        if not success:
            return {"success": False, "error": error}

        return {"success": True, "data": data}

    async def list_documents(
        self,
        folder_token: Optional[str] = None,
        doc_type: Optional[str] = None,
        limit: int = 50,
    ) -> Dict[str, Any]:
        """List accessible Feishu documents"""
        params: Dict[str, Any] = {"page_size": min(limit, 200)}

        if folder_token:
            params["folder_token"] = folder_token

        if doc_type and doc_type != "all":
            params["doc_type"] = doc_type

        success, error, data = self._make_request(
            "GET",
            "/open-apis/drive/v1/files",
            params=params,
        )

        if not success:
            return {"success": False, "error": error}

        return {"success": True, "data": data}

    # ============================================================
    # Message Operations
    # ============================================================

    async def send_message(
        self,
        chat_id: str,
        content: Dict[str, Any],
        msg_type: str,
    ) -> Dict[str, Any]:
        """Send message to Feishu chat/user"""
        payload = {
            "receive_id": chat_id,
            "msg_type": msg_type,
            "content": json.dumps(content, ensure_ascii=False),
        }

        success, error, data = self._make_request(
            "POST",
            "/open-apis/im/v1/messages",
            params={"receive_id_type": "chat_id"},
            json_data=payload,
        )

        if not success:
            return {"success": False, "error": error}

        return {"success": True, "data": data}

    async def get_message_context(
        self,
        chat_id: str,
        limit: int = 50,
        start_time: Optional[str] = None,
        end_time: Optional[str] = None,
    ) -> Dict[str, Any]:
        """Retrieve message history for context"""
        params: Dict[str, Any] = {
            "container_id_type": "chat",
            "container_id": chat_id,
            "page_size": min(limit, 100),
        }

        if start_time:
            params["start_time"] = start_time

        if end_time:
            params["end_time"] = end_time

        success, error, data = self._make_request(
            "GET",
            "/open-apis/im/v1/messages",
            params=params,
        )

        if not success:
            return {"success": False, "error": error}

        return {"success": True, "data": data}

    async def reply_message(
        self,
        message_id: str,
        content: Dict[str, Any],
        msg_type: str,
    ) -> Dict[str, Any]:
        """Reply to specific message"""
        payload = {
            "msg_type": msg_type,
            "content": json.dumps(content, ensure_ascii=False),
        }

        success, error, data = self._make_request(
            "POST",
            f"/open-apis/im/v1/messages/{message_id}/reply",
            json_data=payload,
        )

        if not success:
            return {"success": False, "error": error}

        return {"success": True, "data": data}

    # ============================================================
    # Calendar Operations
    # ============================================================

    async def list_calendar_events(
        self,
        calendar_id: str,
        start_time: str,
        end_time: str,
        limit: int = 50,
    ) -> Dict[str, Any]:
        """List calendar events in time range"""
        params = {
            "start_time": start_time,
            "end_time": end_time,
            "page_size": min(limit, 500),
        }

        success, error, data = self._make_request(
            "GET",
            f"/open-apis/calendar/v4/calendars/{calendar_id}/events",
            params=params,
        )

        if not success:
            return {"success": False, "error": error}

        return {"success": True, "data": data}

    async def create_calendar_event(self, event: Dict[str, Any]) -> Dict[str, Any]:
        """Create calendar event"""
        calendar_id = event.pop("calendar_id", "primary")

        success, error, data = self._make_request(
            "POST",
            f"/open-apis/calendar/v4/calendars/{calendar_id}/events",
            json_data=event,
        )

        if not success:
            return {"success": False, "error": error}

        return {"success": True, "data": data}

    async def update_calendar_event(
        self,
        event_id: str,
        calendar_id: Optional[str],
        updates: Dict[str, Any],
    ) -> Dict[str, Any]:
        """Update calendar event"""
        cal_id = calendar_id or "primary"

        success, error, data = self._make_request(
            "PATCH",
            f"/open-apis/calendar/v4/calendars/{cal_id}/events/{event_id}",
            json_data=updates,
        )

        if not success:
            return {"success": False, "error": error}

        return {"success": True, "data": data}

    async def delete_calendar_event(
        self,
        event_id: str,
        calendar_id: Optional[str] = None,
    ) -> Dict[str, Any]:
        """Delete calendar event"""
        cal_id = calendar_id or "primary"

        success, error, data = self._make_request(
            "DELETE",
            f"/open-apis/calendar/v4/calendars/{cal_id}/events/{event_id}",
        )

        if not success:
            return {"success": False, "error": error}

        return {"success": True, "data": data}

    # ============================================================
    # Group Chat Operations
    # ============================================================

    async def list_chats(self, limit: int = 50) -> Dict[str, Any]:
        """List accessible group chats"""
        params = {"page_size": min(limit, 100)}

        success, error, data = self._make_request(
            "GET",
            "/open-apis/im/v1/chats",
            params=params,
        )

        if not success:
            return {"success": False, "error": error}

        return {"success": True, "data": data}

    async def get_chat_members(self, chat_id: str) -> Dict[str, Any]:
        """Get chat member list"""
        success, error, data = self._make_request(
            "GET",
            f"/open-apis/im/v1/chats/{chat_id}/members",
            params={"page_size": 100},
        )

        if not success:
            return {"success": False, "error": error}

        return {"success": True, "data": data}

    async def get_chat_info(self, chat_id: str) -> Dict[str, Any]:
        """Get chat information"""
        success, error, data = self._make_request(
            "GET",
            f"/open-apis/im/v1/chats/{chat_id}",
        )

        if not success:
            return {"success": False, "error": error}

        return {"success": True, "data": data}

    # ============================================================
    # File Operations
    # ============================================================

    async def file_upload(
        self,
        file_path: str,
        file_type: str,
        parent_token: Optional[str] = None,
    ) -> Dict[str, Any]:
        """Upload file to Feishu"""
        token, err = self._refresh_access_token()
        if not token:
            return {"success": False, "error": err or "飞书鉴权失败"}

        try:
            path = Path(file_path)
            if not path.exists():
                return {"success": False, "error": f"文件不存在: {file_path}"}

            with open(path, "rb") as f:
                files = {"file": (path.name, f, file_type)}
                data_payload = {"file_name": path.name}

                if parent_token:
                    data_payload["parent_token"] = parent_token

                resp = requests.post(
                    f"{self.domain}/open-apis/drive/v1/files/upload_all",
                    headers={"Authorization": f"Bearer {token}"},
                    data=data_payload,
                    files=files,
                    timeout=60,
                )

                result = resp.json()
                code = int(result.get("code", -1))
                if code != 0:
                    return {
                        "success": False,
                        "error": str(result.get("msg") or result.get("message") or "文件上传失败"),
                    }

                return {"success": True, "data": result.get("data")}
        except Exception as exc:
            return {"success": False, "error": str(exc)}

    async def file_download(self, file_token: str, save_path: str) -> Dict[str, Any]:
        """Download file from Feishu"""
        token, err = self._refresh_access_token()
        if not token:
            return {"success": False, "error": err or "飞书鉴权失败"}

        try:
            resp = requests.get(
                f"{self.domain}/open-apis/drive/v1/files/{file_token}/download",
                headers={"Authorization": f"Bearer {token}"},
                timeout=60,
            )

            if resp.status_code >= 400:
                return {"success": False, "error": f"文件下载失败: HTTP {resp.status_code}"}

            path = Path(save_path)
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_bytes(resp.content)

            return {
                "success": True,
                "data": {
                    "path": str(path),
                    "size": len(resp.content),
                },
            }
        except Exception as exc:
            return {"success": False, "error": str(exc)}
