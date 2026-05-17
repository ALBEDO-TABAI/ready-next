from __future__ import annotations

import os
import sys
import threading
import time
import uuid
from collections import deque
from datetime import datetime, timezone
from threading import Lock
from typing import Any, Deque, Dict, List, Optional

from apscheduler.schedulers.background import BackgroundScheduler
from apscheduler.triggers.cron import CronTrigger
from fastapi import Depends, FastAPI, Header, HTTPException, Request, Response
from pydantic import BaseModel, Field
import uvicorn

from ready_sidecar.channels import ChannelConfigModel, ChannelManager
from ready_sidecar.channels.feishu_app_adapter import FeishuAppAdapter
from ready_sidecar.channels.feishu_plugin_ops import FeishuPluginOperations
from ready_sidecar.channels.wechat_openclaw_adapter import WechatOpenClawAdapter


# ---------------------------------------------------------------------------
# Parent-PID watchdog
#
# When Ready (Electron parent) crashes or is force-killed, this Python sidecar
# would otherwise be reparented to launchd/init (PID 1) and survive forever.
# Audit found 63 leaked sidecar processes. Poll the original parent PID every
# WATCHDOG_INTERVAL_SEC and exit cleanly when it disappears.
# ---------------------------------------------------------------------------
PARENT_PID = os.getppid()
WATCHDOG_INTERVAL_SEC = 30

# Bounded event queue: drop oldest events when full so a stalled consumer
# can't grow memory unboundedly. Logged every EVENT_DROP_LOG_EVERY evictions.
EVENT_QUEUE_MAXLEN = 10000
EVENT_DROP_LOG_EVERY = 100


def now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


def _parent_watchdog() -> None:
    """Polls parent PID every WATCHDOG_INTERVAL_SEC. Exits cleanly when parent gone.

    Uses os.kill(pid, 0) — sends signal 0 which doesn't actually signal but
    raises ProcessLookupError if pid doesn't exist. Cross-platform on POSIX
    (macOS, Linux). On Windows ppid checking is different — skip there for now.
    """
    if sys.platform == "win32":
        return  # TODO: Windows parent-watch via psutil
    while True:
        time.sleep(WATCHDOG_INTERVAL_SEC)
        try:
            os.kill(PARENT_PID, 0)
        except (ProcessLookupError, OSError):
            print(f"[sidecar] parent PID {PARENT_PID} gone, exiting", flush=True)
            os._exit(0)  # _exit (not sys.exit) — bypass cleanup hooks; clean shutdown is parent's job


def _start_parent_watchdog() -> None:
    threading.Thread(target=_parent_watchdog, daemon=True, name="parent-watchdog").start()


class ChannelConfig(BaseModel):
    id: str
    type: str
    name: str
    enabled: bool = True
    config: Dict[str, Any] = Field(default_factory=dict)


class ScheduleConfig(BaseModel):
    id: str
    name: str
    cronExpr: str
    prompt: str
    channelId: Optional[str] = None
    enabled: bool = True
    payload: Dict[str, Any] = Field(default_factory=dict)


class EventPayload(BaseModel):
    type: str
    payload: Dict[str, Any] = Field(default_factory=dict)


class ChannelSendPayload(BaseModel):
    id: str
    thread: Optional[str] = None
    text: str


class WechatLoginStartPayload(BaseModel):
    channel_id: str
    force: bool = False


class WechatLoginStatusPayload(BaseModel):
    channel_id: str
    session_key: str


class WechatLoginVerifyPayload(BaseModel):
    channel_id: str
    session_key: str
    code: str


class RuntimeState:
    def __init__(self) -> None:
        self.started_at = now_iso()
        self.last_heartbeat_at: Optional[str] = None
        self.channels: Dict[str, ChannelConfig] = {}
        self.schedules: Dict[str, ScheduleConfig] = {}
        self.events: Deque[Dict[str, Any]] = deque(maxlen=EVENT_QUEUE_MAXLEN)
        self.dropped_event_count = 0
        self.lock = Lock()
        self.scheduler = BackgroundScheduler(timezone="UTC")
        self.scheduler.start()
        self.channel_manager = ChannelManager(self.enqueue_event)

    def enqueue_event(self, event_type: str, payload: Dict[str, Any]) -> None:
        with self.lock:
            # When the deque is at maxlen, append() silently evicts the oldest
            # entry. Detect that case and log periodically so a stalled puller
            # is visible in the sidecar log.
            at_capacity = len(self.events) == self.events.maxlen
            self.events.append(
                {
                    "id": str(uuid.uuid4()),
                    "type": event_type,
                    "timestamp": now_iso(),
                    "payload": payload,
                }
            )
            if at_capacity:
                self.dropped_event_count += 1
                if self.dropped_event_count % EVENT_DROP_LOG_EVERY == 0:
                    print(
                        f"[sidecar] event queue at capacity, dropping oldest "
                        f"(total dropped: {self.dropped_event_count})",
                        flush=True,
                    )

    def pull_events(self, limit: int) -> List[Dict[str, Any]]:
        with self.lock:
            items: List[Dict[str, Any]] = []
            for _ in range(max(1, limit)):
                if not self.events:
                    break
                items.append(self.events.popleft())
            return items


state = RuntimeState()
app = FastAPI(title="Ready Sidecar", version="0.2.0")


def check_auth(x_ready_token: Optional[str] = Header(default=None)) -> None:
    expected = os.environ.get("READY_SIDECAR_AUTH_TOKEN", "").strip()
    if expected and x_ready_token != expected:
        raise HTTPException(status_code=401, detail="Unauthorized")


def schedule_job_id(schedule_id: str) -> str:
    return f"schedule:{schedule_id}"


def enqueue_schedule_trigger(schedule_id: str) -> None:
    schedule = state.schedules.get(schedule_id)
    if not schedule:
        return
    state.enqueue_event(
        "schedule.trigger",
        {
            "scheduleId": schedule.id,
            "name": schedule.name,
            "prompt": schedule.prompt,
            "channelId": schedule.channelId,
            "payload": schedule.payload,
        },
    )


def register_schedule_job(schedule: ScheduleConfig) -> None:
    job_id = schedule_job_id(schedule.id)
    try:
        state.scheduler.remove_job(job_id)
    except Exception:
        pass

    if not schedule.enabled:
        return

    trigger = CronTrigger.from_crontab(schedule.cronExpr, timezone="UTC")
    state.scheduler.add_job(
        enqueue_schedule_trigger,
        trigger=trigger,
        args=[schedule.id],
        id=job_id,
        replace_existing=True,
        coalesce=True,
        max_instances=1,
    )


@app.get("/health")
def health(_: None = Depends(check_auth)) -> Dict[str, Any]:
    state.last_heartbeat_at = now_iso()
    return {
        "ok": True,
        "startedAt": state.started_at,
        "schedulerRunning": bool(state.scheduler.running),
        "channels": len(state.channels),
        "schedules": len(state.schedules),
    }


@app.get("/heartbeat")
def heartbeat(_: None = Depends(check_auth)) -> Dict[str, Any]:
    now = now_iso()
    state.last_heartbeat_at = now
    channel_state = state.channel_manager.state()
    adapters = []
    for item in channel_state.get("adapters", []):
        adapters.append(
            {
                "id": item.get("id"),
                "type": item.get("type"),
                "healthy": bool(item.get("healthy")),
                "status": item.get("status"),
                "lastBeatAt": item.get("lastBeatAt") or now,
                "error": item.get("error"),
            }
        )
    return {
        "sidecar": {
            "healthy": True,
            "lastBeatAt": now,
            "schedulerRunning": bool(state.scheduler.running),
        },
        "adapters": adapters,
    }


@app.get("/channels")
def list_channels(_: None = Depends(check_auth)) -> Dict[str, Any]:
    return {"channels": [c.model_dump() for c in state.channels.values()]}


@app.post("/channels/upsert")
def upsert_channel(channel: ChannelConfig, _: None = Depends(check_auth)) -> Dict[str, Any]:
    state.channels[channel.id] = channel
    state.channel_manager.upsert(ChannelConfigModel(**channel.model_dump()))
    if channel.enabled:
        state.channel_manager.start(channel.id)
    else:
        state.channel_manager.stop(channel.id)
    return {"success": True, "channel": channel.model_dump()}


@app.post("/channels/start")
def start_channel(payload: Dict[str, str], _: None = Depends(check_auth)) -> Dict[str, Any]:
    channel_id = str(payload.get("id") or "")
    if not channel_id:
        return {"success": False, "error": "id is required"}
    result = state.channel_manager.start(channel_id)
    return result


@app.post("/channels/stop")
def stop_channel(payload: Dict[str, str], _: None = Depends(check_auth)) -> Dict[str, Any]:
    channel_id = str(payload.get("id") or "")
    if not channel_id:
        return {"success": False, "error": "id is required"}
    result = state.channel_manager.stop(channel_id)
    return result


@app.get("/channels/state")
def channel_state(_: None = Depends(check_auth)) -> Dict[str, Any]:
    return state.channel_manager.state()


@app.post("/channels/delete")
def delete_channel(payload: Dict[str, str], _: None = Depends(check_auth)) -> Dict[str, Any]:
    channel_id = str(payload.get("id") or "")
    if not channel_id:
        return {"success": False, "error": "id is required"}
    state.channel_manager.delete(channel_id)
    if channel_id in state.channels:
        del state.channels[channel_id]
    return {"success": True}


@app.post("/channels/send")
def send_channel(payload: ChannelSendPayload, _: None = Depends(check_auth)) -> Dict[str, Any]:
    result = state.channel_manager.send(payload.id, payload.thread, payload.text)
    return result


@app.post("/channels/test")
def test_channel(channel: ChannelConfig, _: None = Depends(check_auth)) -> Dict[str, Any]:
    return state.channel_manager.test(ChannelConfigModel(**channel.model_dump()))


@app.get("/cron")
def list_cron(_: None = Depends(check_auth)) -> Dict[str, Any]:
    return {"schedules": [s.model_dump() for s in state.schedules.values()]}


@app.post("/cron/upsert")
def upsert_cron(schedule: ScheduleConfig, _: None = Depends(check_auth)) -> Dict[str, Any]:
    state.schedules[schedule.id] = schedule
    register_schedule_job(schedule)
    return {"success": True, "schedule": schedule.model_dump()}


@app.post("/cron/pause")
def pause_cron(payload: Dict[str, str], _: None = Depends(check_auth)) -> Dict[str, Any]:
    schedule_id = payload.get("id", "")
    schedule = state.schedules.get(schedule_id)
    if not schedule:
        return {"success": False, "error": "schedule not found"}
    schedule.enabled = False
    register_schedule_job(schedule)
    return {"success": True}


@app.post("/cron/resume")
def resume_cron(payload: Dict[str, str], _: None = Depends(check_auth)) -> Dict[str, Any]:
    schedule_id = payload.get("id", "")
    schedule = state.schedules.get(schedule_id)
    if not schedule:
        return {"success": False, "error": "schedule not found"}
    schedule.enabled = True
    register_schedule_job(schedule)
    return {"success": True}


@app.post("/cron/delete")
def delete_cron(payload: Dict[str, str], _: None = Depends(check_auth)) -> Dict[str, Any]:
    schedule_id = payload.get("id", "")
    if schedule_id in state.schedules:
        del state.schedules[schedule_id]
    try:
        state.scheduler.remove_job(schedule_job_id(schedule_id))
    except Exception:
        pass
    return {"success": True}


@app.post("/cron/run-now")
def cron_run_now(payload: Dict[str, str], _: None = Depends(check_auth)) -> Dict[str, Any]:
    schedule_id = payload.get("id", "")
    schedule = state.schedules.get(schedule_id)
    if not schedule:
        return {"success": False, "error": "schedule not found"}
    enqueue_schedule_trigger(schedule_id)
    return {"success": True}


@app.get("/events/pull")
def pull_events(limit: int = 20, _: None = Depends(check_auth)) -> Dict[str, Any]:
    safe_limit = max(1, min(200, limit))
    return {"events": state.pull_events(safe_limit)}


@app.post("/events/inbound")
def inbound_event(payload: EventPayload, _: None = Depends(check_auth)) -> Dict[str, Any]:
    state.enqueue_event(payload.type, payload.payload)
    return {"success": True}


@app.post("/channels/feishu/callback/{channel_id}")
async def feishu_callback(channel_id: str, request: Request) -> Response:
    channel = state.channels.get(channel_id)
    if not channel or channel.type != "feishu-app":
        raise HTTPException(status_code=404, detail="channel not found")

    adapter = state.channel_manager.adapters.get(channel_id)
    if not isinstance(adapter, FeishuAppAdapter):
        adapter = FeishuAppAdapter(channel.id, channel.type, channel.name, channel.config)
        adapter.set_event_callback(state.enqueue_event)

    body = await request.body()
    status_code, headers, content = adapter.handle_callback(dict(request.headers), body)
    response = Response(content=content, status_code=status_code)
    for key, value in headers.items():
        response.headers[key] = value
    return response


@app.post("/channels/wechat-openclaw/inbound/{channel_id}")
async def wechat_openclaw_inbound(channel_id: str, request: Request, _: None = Depends(check_auth)) -> Dict[str, Any]:
    channel = state.channels.get(channel_id)
    if not channel or channel.type != "wechat-openclaw":
        raise HTTPException(status_code=404, detail="channel not found")

    adapter = state.channel_manager.adapters.get(channel_id)
    if not isinstance(adapter, WechatOpenClawAdapter):
        adapter = WechatOpenClawAdapter(channel.id, channel.type, channel.name, channel.config)
        adapter.set_event_callback(state.enqueue_event)

    payload = await request.json()
    ok, err = adapter.handle_openclaw_event(payload if isinstance(payload, dict) else {})
    return {"success": bool(ok), "error": err}


def _get_wechat_adapter(channel_id: str) -> WechatOpenClawAdapter:
    channel = state.channels.get(channel_id)
    if not channel or channel.type != "wechat-openclaw":
        raise HTTPException(status_code=404, detail="channel not found")
    adapter = state.channel_manager.adapters.get(channel_id)
    if not isinstance(adapter, WechatOpenClawAdapter):
        adapter = WechatOpenClawAdapter(channel.id, channel.type, channel.name, channel.config)
        adapter.set_event_callback(state.enqueue_event)
        state.channel_manager.adapters[channel_id] = adapter
    return adapter


@app.post("/channels/wechat-openclaw/login/start")
def wechat_login_start(payload: WechatLoginStartPayload, _: None = Depends(check_auth)) -> Dict[str, Any]:
    adapter = _get_wechat_adapter(payload.channel_id)
    return adapter.start_login(force=payload.force)


@app.post("/channels/wechat-openclaw/login/status")
def wechat_login_status(payload: WechatLoginStatusPayload, _: None = Depends(check_auth)) -> Dict[str, Any]:
    adapter = _get_wechat_adapter(payload.channel_id)
    return adapter.get_login_status(payload.session_key)


@app.post("/channels/wechat-openclaw/login/verify")
def wechat_login_verify(payload: WechatLoginVerifyPayload, _: None = Depends(check_auth)) -> Dict[str, Any]:
    adapter = _get_wechat_adapter(payload.channel_id)
    return adapter.submit_verify_code(payload.session_key, payload.code)


# ============================================================
# Feishu Plugin Operations Endpoints
# ============================================================


def _get_feishu_plugin_ops(channel_id: str) -> Optional[FeishuPluginOperations]:
    """Get Feishu plugin operations instance for a channel"""
    channel = state.channels.get(channel_id)
    if not channel or channel.type != "feishu-app":
        return None

    app_id = str(channel.config.get("appId") or "").strip()
    app_secret = str(channel.config.get("appSecret") or "").strip()
    domain = str(channel.config.get("domain") or "https://open.feishu.cn").rstrip("/")

    if not app_id or not app_secret:
        return None

    return FeishuPluginOperations(app_id, app_secret, domain)


class FeishuDocReadPayload(BaseModel):
    channel_id: str
    doc_token: str
    doc_type: str


class FeishuDocCreatePayload(BaseModel):
    channel_id: str
    title: str
    doc_type: str
    content: Optional[Dict[str, Any]] = None
    folder_token: Optional[str] = None


class FeishuDocUpdatePayload(BaseModel):
    channel_id: str
    doc_token: str
    doc_type: str
    updates: Dict[str, Any]


class FeishuDocListPayload(BaseModel):
    channel_id: str
    folder_token: Optional[str] = None
    doc_type: Optional[str] = None
    limit: int = 50


class FeishuMessageSendPayload(BaseModel):
    channel_id: str
    chat_id: str
    content: Dict[str, Any]
    msg_type: str


class FeishuMessageContextPayload(BaseModel):
    channel_id: str
    chat_id: str
    limit: int = 50
    start_time: Optional[str] = None
    end_time: Optional[str] = None


class FeishuMessageReplyPayload(BaseModel):
    channel_id: str
    message_id: str
    content: Dict[str, Any]
    msg_type: str


class FeishuCalendarListEventsPayload(BaseModel):
    channel_id: str
    calendar_id: str
    start_time: str
    end_time: str
    limit: int = 50


class FeishuCalendarCreateEventPayload(BaseModel):
    channel_id: str
    event: Dict[str, Any]


class FeishuCalendarUpdateEventPayload(BaseModel):
    channel_id: str
    event_id: str
    calendar_id: Optional[str] = None
    updates: Dict[str, Any]


class FeishuCalendarDeleteEventPayload(BaseModel):
    channel_id: str
    event_id: str
    calendar_id: Optional[str] = None


class FeishuChatListPayload(BaseModel):
    channel_id: str
    limit: int = 50


class FeishuChatGetMembersPayload(BaseModel):
    channel_id: str
    chat_id: str


class FeishuChatGetInfoPayload(BaseModel):
    channel_id: str
    chat_id: str


class FeishuFileUploadPayload(BaseModel):
    channel_id: str
    file_path: str
    file_type: str
    parent_token: Optional[str] = None


class FeishuFileDownloadPayload(BaseModel):
    channel_id: str
    file_token: str
    save_path: str


# Document operations
@app.post("/feishu/doc/read")
async def feishu_doc_read(payload: FeishuDocReadPayload, _: None = Depends(check_auth)) -> Dict[str, Any]:
    ops = _get_feishu_plugin_ops(payload.channel_id)
    if not ops:
        return {"success": False, "error": "Feishu channel not found or not configured"}
    return await ops.read_document(payload.doc_token, payload.doc_type)


@app.post("/feishu/doc/create")
async def feishu_doc_create(payload: FeishuDocCreatePayload, _: None = Depends(check_auth)) -> Dict[str, Any]:
    ops = _get_feishu_plugin_ops(payload.channel_id)
    if not ops:
        return {"success": False, "error": "Feishu channel not found or not configured"}
    return await ops.create_document(payload.title, payload.doc_type, payload.content, payload.folder_token)


@app.post("/feishu/doc/update")
async def feishu_doc_update(payload: FeishuDocUpdatePayload, _: None = Depends(check_auth)) -> Dict[str, Any]:
    ops = _get_feishu_plugin_ops(payload.channel_id)
    if not ops:
        return {"success": False, "error": "Feishu channel not found or not configured"}
    return await ops.update_document(payload.doc_token, payload.doc_type, payload.updates)


@app.post("/feishu/doc/list")
async def feishu_doc_list(payload: FeishuDocListPayload, _: None = Depends(check_auth)) -> Dict[str, Any]:
    ops = _get_feishu_plugin_ops(payload.channel_id)
    if not ops:
        return {"success": False, "error": "Feishu channel not found or not configured"}
    return await ops.list_documents(payload.folder_token, payload.doc_type, payload.limit)


# Message operations
@app.post("/feishu/message/send")
async def feishu_message_send(payload: FeishuMessageSendPayload, _: None = Depends(check_auth)) -> Dict[str, Any]:
    ops = _get_feishu_plugin_ops(payload.channel_id)
    if not ops:
        return {"success": False, "error": "Feishu channel not found or not configured"}
    return await ops.send_message(payload.chat_id, payload.content, payload.msg_type)


@app.post("/feishu/message/context")
async def feishu_message_context(payload: FeishuMessageContextPayload, _: None = Depends(check_auth)) -> Dict[str, Any]:
    ops = _get_feishu_plugin_ops(payload.channel_id)
    if not ops:
        return {"success": False, "error": "Feishu channel not found or not configured"}
    return await ops.get_message_context(payload.chat_id, payload.limit, payload.start_time, payload.end_time)


@app.post("/feishu/message/reply")
async def feishu_message_reply(payload: FeishuMessageReplyPayload, _: None = Depends(check_auth)) -> Dict[str, Any]:
    ops = _get_feishu_plugin_ops(payload.channel_id)
    if not ops:
        return {"success": False, "error": "Feishu channel not found or not configured"}
    return await ops.reply_message(payload.message_id, payload.content, payload.msg_type)


# Calendar operations
@app.post("/feishu/calendar/events")
async def feishu_calendar_events(payload: FeishuCalendarListEventsPayload, _: None = Depends(check_auth)) -> Dict[str, Any]:
    ops = _get_feishu_plugin_ops(payload.channel_id)
    if not ops:
        return {"success": False, "error": "Feishu channel not found or not configured"}
    return await ops.list_calendar_events(payload.calendar_id, payload.start_time, payload.end_time, payload.limit)


@app.post("/feishu/calendar/event/create")
async def feishu_calendar_event_create(payload: FeishuCalendarCreateEventPayload, _: None = Depends(check_auth)) -> Dict[str, Any]:
    ops = _get_feishu_plugin_ops(payload.channel_id)
    if not ops:
        return {"success": False, "error": "Feishu channel not found or not configured"}
    return await ops.create_calendar_event(payload.event)


@app.post("/feishu/calendar/event/update")
async def feishu_calendar_event_update(payload: FeishuCalendarUpdateEventPayload, _: None = Depends(check_auth)) -> Dict[str, Any]:
    ops = _get_feishu_plugin_ops(payload.channel_id)
    if not ops:
        return {"success": False, "error": "Feishu channel not found or not configured"}
    return await ops.update_calendar_event(payload.event_id, payload.calendar_id, payload.updates)


@app.post("/feishu/calendar/event/delete")
async def feishu_calendar_event_delete(payload: FeishuCalendarDeleteEventPayload, _: None = Depends(check_auth)) -> Dict[str, Any]:
    ops = _get_feishu_plugin_ops(payload.channel_id)
    if not ops:
        return {"success": False, "error": "Feishu channel not found or not configured"}
    return await ops.delete_calendar_event(payload.event_id, payload.calendar_id)


# Chat operations
@app.post("/feishu/chat/list")
async def feishu_chat_list(payload: FeishuChatListPayload, _: None = Depends(check_auth)) -> Dict[str, Any]:
    ops = _get_feishu_plugin_ops(payload.channel_id)
    if not ops:
        return {"success": False, "error": "Feishu channel not found or not configured"}
    return await ops.list_chats(payload.limit)


@app.post("/feishu/chat/members")
async def feishu_chat_members(payload: FeishuChatGetMembersPayload, _: None = Depends(check_auth)) -> Dict[str, Any]:
    ops = _get_feishu_plugin_ops(payload.channel_id)
    if not ops:
        return {"success": False, "error": "Feishu channel not found or not configured"}
    return await ops.get_chat_members(payload.chat_id)


@app.post("/feishu/chat/info")
async def feishu_chat_info(payload: FeishuChatGetInfoPayload, _: None = Depends(check_auth)) -> Dict[str, Any]:
    ops = _get_feishu_plugin_ops(payload.channel_id)
    if not ops:
        return {"success": False, "error": "Feishu channel not found or not configured"}
    return await ops.get_chat_info(payload.chat_id)


# File operations
@app.post("/feishu/file/upload")
async def feishu_file_upload(payload: FeishuFileUploadPayload, _: None = Depends(check_auth)) -> Dict[str, Any]:
    ops = _get_feishu_plugin_ops(payload.channel_id)
    if not ops:
        return {"success": False, "error": "Feishu channel not found or not configured"}
    return await ops.file_upload(payload.file_path, payload.file_type, payload.parent_token)


@app.post("/feishu/file/download")
async def feishu_file_download(payload: FeishuFileDownloadPayload, _: None = Depends(check_auth)) -> Dict[str, Any]:
    ops = _get_feishu_plugin_ops(payload.channel_id)
    if not ops:
        return {"success": False, "error": "Feishu channel not found or not configured"}
    return await ops.file_download(payload.file_token, payload.save_path)


def main() -> None:
    host = os.environ.get("READY_SIDECAR_HOST", "127.0.0.1")
    port = int(os.environ.get("READY_SIDECAR_PORT", "18777"))
    # Start watchdog before the listener so a parent that dies during
    # uvicorn boot is still detected on the next tick.
    _start_parent_watchdog()
    uvicorn.run("ready_sidecar.main:app", host=host, port=port, log_level="warning")


if __name__ == "__main__":
    main()
