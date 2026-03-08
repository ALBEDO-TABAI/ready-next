from __future__ import annotations

import os
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


def now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


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


class RuntimeState:
    def __init__(self) -> None:
        self.started_at = now_iso()
        self.last_heartbeat_at: Optional[str] = None
        self.channels: Dict[str, ChannelConfig] = {}
        self.schedules: Dict[str, ScheduleConfig] = {}
        self.events: Deque[Dict[str, Any]] = deque()
        self.lock = Lock()
        self.scheduler = BackgroundScheduler(timezone="UTC")
        self.scheduler.start()
        self.channel_manager = ChannelManager(self.enqueue_event)

    def enqueue_event(self, event_type: str, payload: Dict[str, Any]) -> None:
        with self.lock:
            self.events.append(
                {
                    "id": str(uuid.uuid4()),
                    "type": event_type,
                    "timestamp": now_iso(),
                    "payload": payload,
                }
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


if __name__ == "__main__":
    host = os.environ.get("READY_SIDECAR_HOST", "127.0.0.1")
    port = int(os.environ.get("READY_SIDECAR_PORT", "18777"))
    uvicorn.run("ready_sidecar.main:app", host=host, port=port, log_level="warning")
