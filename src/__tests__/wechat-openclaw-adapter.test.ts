import assert from 'node:assert/strict'
import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { execFileSync, spawnSync } from 'node:child_process'
import test from 'node:test'

function resolvePython(): string | null {
  for (const candidate of ['python3.12', 'python3.11', 'python3.10', 'python3']) {
    const result = spawnSync(candidate, ['--version'], { encoding: 'utf8' })
    if (result.status === 0) return candidate
  }
  return null
}

test('wechat adapter runs embedded QR login, persists account, sends, and emits inbound events', (t) => {
  const python = resolvePython()
  if (!python) {
    t.skip('python3 is not available')
    return
  }

  const root = join(tmpdir(), `ready-wechat-embedded-${Date.now()}-${Math.random().toString(16).slice(2)}`)
  mkdirSync(root, { recursive: true })

  const script = `
import json
import time
from ready_sidecar.channels.wechat_openclaw_adapter import WechatOpenClawAdapter

events = []

class FakeWechatAdapter(WechatOpenClawAdapter):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, **kwargs)
        self.calls = []

    def _http_request_json(self, method, base_url, endpoint, payload=None, token=None, timeout=15):
        self.calls.append({"method": method, "endpoint": endpoint, "payload": payload, "token": token})
        if "get_bot_qrcode" in endpoint:
            return {"qrcode": "qr-token-1", "qrcode_img_content": "https://login.example/qr-token-1"}
        if "sendmessage" in endpoint:
            return {"ret": 0}
        if "getupdates" in endpoint:
            return {
                "ret": 0,
                "get_updates_buf": "next-sync",
                "msgs": [{
                    "from_user_id": "owner@im.wechat",
                    "client_id": "msg-1",
                    "context_token": "ctx-1",
                    "item_list": [{"type": 1, "text_item": {"text": "明天三点开会"}}],
                }],
            }
        raise AssertionError(endpoint)

    def _get_json(self, base_url, endpoint, timeout):
        self.calls.append({"method": "GET", "endpoint": endpoint, "timeout": timeout})
        if "get_qrcode_status" in endpoint:
            return {
                "status": "confirmed",
                "ilink_bot_id": "bot@im.bot",
                "bot_token": "token-1",
                "baseurl": "https://ilinkai.weixin.qq.com",
                "ilink_user_id": "owner@im.wechat",
            }
        raise AssertionError(endpoint)

adapter = FakeWechatAdapter("channel-wechat-openclaw-default", "wechat-openclaw", "微信", {
    "stateDir": ${JSON.stringify(root)},
})
adapter.set_event_callback(lambda event_type, payload: events.append([event_type, payload]))

start = adapter.start_login("fixture-login", force=True)
deadline = time.time() + 3
status = {}
while time.time() < deadline:
    status = adapter.get_login_status(start["sessionKey"])
    if status.get("status") == "connected":
        break
    time.sleep(0.05)

probe = adapter.test()
send = adapter.send(None, "Ready ping")
account = adapter._resolve_account()
adapter._poll_updates_once(account)

print(json.dumps({
    "start": start,
    "status": status,
    "probe": probe,
    "send": send,
    "events": events,
    "calls": adapter.calls,
}, ensure_ascii=False))
`

  const output = execFileSync(python, ['-c', script], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      PYTHONPATH: join(process.cwd(), 'src/python'),
    },
    encoding: 'utf8',
  })
  const result = JSON.parse(output)

  assert.equal(result.start.success, true)
  assert.equal(result.start.qrcodeUrl, 'https://login.example/qr-token-1')
  assert.equal(result.status.status, 'connected')
  assert.equal(result.status.accountId, 'bot@im.bot')
  assert.deepEqual(result.probe, [true, null])
  assert.deepEqual(result.send, [true, null])

  assert.equal(result.events.filter((item: unknown[]) => item[0] === 'channel.wechat-bound').length, 1)
  result.events = result.events.filter((item: unknown[]) => item[0] === 'channel.inbound')
  assert.equal(result.events.length, 1)
  assert.equal(result.events[0][0], 'channel.inbound')
  assert.equal(result.events[0][1].channelId, 'channel-wechat-openclaw-default')
  assert.equal(result.events[0][1].source, 'wechat-openclaw')
  assert.equal(result.events[0][1].thread, 'owner@im.wechat')
  assert.equal(result.events[0][1].text, '明天三点开会')

  assert.ok(result.calls.some((call: { endpoint: string }) => call.endpoint.includes('get_bot_qrcode')))
  assert.ok(result.calls.some((call: { endpoint: string }) => call.endpoint.includes('get_qrcode_status')))
  const sendCall = result.calls.find((call: { endpoint: string }) => call.endpoint.includes('sendmessage'))
  assert.equal(sendCall.payload.msg.to_user_id, 'owner@im.wechat')
  assert.ok(result.calls.some((call: { endpoint: string }) => call.endpoint.includes('getupdates')))
})

test('wechat adapter does not enable already-bound login without local credentials', (t) => {
  const python = resolvePython()
  if (!python) {
    t.skip('python3 is not available')
    return
  }

  const root = join(tmpdir(), `ready-wechat-bound-missing-${Date.now()}-${Math.random().toString(16).slice(2)}`)
  mkdirSync(root, { recursive: true })

  const script = `
import json
import time
from ready_sidecar.channels.wechat_openclaw_adapter import WechatOpenClawAdapter

class FakeWechatAdapter(WechatOpenClawAdapter):
    def _http_request_json(self, method, base_url, endpoint, payload=None, token=None, timeout=15):
        if "get_bot_qrcode" in endpoint:
            return {"qrcode": "qr-token-1", "qrcode_img_content": "https://login.example/qr-token-1"}
        raise AssertionError(endpoint)

    def _get_json(self, base_url, endpoint, timeout):
        if "get_qrcode_status" in endpoint:
            return {"status": "binded_redirect"}
        raise AssertionError(endpoint)

adapter = FakeWechatAdapter("channel-wechat-openclaw-default", "wechat-openclaw", "微信", {
    "stateDir": ${JSON.stringify(root)},
})
start = adapter.start_login("fixture-login", force=True)
deadline = time.time() + 3
status = {}
while time.time() < deadline:
    status = adapter.get_login_status(start["sessionKey"])
    if status.get("status") == "error":
        break
    time.sleep(0.05)

print(json.dumps({"start": start, "status": status}, ensure_ascii=False))
`

  const output = execFileSync(python, ['-c', script], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      PYTHONPATH: join(process.cwd(), 'src/python'),
    },
    encoding: 'utf8',
  })
  const result = JSON.parse(output)

  assert.equal(result.start.success, true)
  assert.equal(result.status.status, 'error')
  assert.match(result.status.message, /没有可用凭据/)
})

test('wechat adapter emits attachment-only inbound events instead of dropping them', (t) => {
  const python = resolvePython()
  if (!python) {
    t.skip('python3 is not available')
    return
  }

  const root = join(tmpdir(), `ready-wechat-attachment-${Date.now()}-${Math.random().toString(16).slice(2)}`)
  mkdirSync(root, { recursive: true })

  const script = `
import json
from ready_sidecar.channels.wechat_openclaw_adapter import WechatOpenClawAdapter

events = []

class FakeWechatAdapter(WechatOpenClawAdapter):
    def _http_request_json(self, method, base_url, endpoint, payload=None, token=None, timeout=15):
        if "getupdates" in endpoint:
            return {
                "ret": 0,
                "get_updates_buf": "next-sync",
                "msgs": [{
                    "from_user_id": "friend@im.wechat",
                    "client_id": "file-msg-1",
                    "item_list": [{
                        "type": 6,
                        "file_item": {
                            "file_id": "wx-file-token-1",
                            "file_name": "世界杯先导预告.md",
                            "file_size": 1234,
                        },
                    }],
                }],
            }
        raise AssertionError(endpoint)

adapter = FakeWechatAdapter("channel-wechat-openclaw-default", "wechat-openclaw", "微信", {
    "stateDir": ${JSON.stringify(root)},
})
adapter.set_event_callback(lambda event_type, payload: events.append([event_type, payload]))
adapter._poll_updates_once({"accountId": "bot@im.bot", "token": "token-1", "baseUrl": "https://ilinkai.weixin.qq.com"})

hook_ok = adapter.handle_openclaw_event({
    "id": "hook-msg-1",
    "context": {
        "thread": "friend@im.wechat",
        "attachments": [{
            "name": "参考图.png",
            "path": "/tmp/reference.png",
            "type": "image",
            "mimeType": "image/png",
            "size": 42,
        }],
    },
})

print(json.dumps({"events": events, "hook": hook_ok}, ensure_ascii=False))
`

  const output = execFileSync(python, ['-c', script], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      PYTHONPATH: join(process.cwd(), 'src/python'),
    },
    encoding: 'utf8',
  })
  const result = JSON.parse(output)

  assert.equal(result.events.length, 2)
  assert.equal(result.events[0][0], 'channel.inbound')
  assert.equal(result.events[0][1].text, '')
  assert.equal(result.events[0][1].attachments.length, 1)
  assert.equal(result.events[0][1].attachments[0].name, '世界杯先导预告.md')
  assert.equal(result.events[0][1].attachments[0].type, 'text')
  assert.equal(result.events[0][1].attachments[0].remoteId, 'wx-file-token-1')
  assert.equal(result.events[0][1].attachments[0].path, 'wechat://attachment/wx-file-token-1')
  assert.deepEqual(result.hook, [true, null])
  assert.equal(result.events[1][1].attachments[0].name, '参考图.png')
  assert.equal(result.events[1][1].attachments[0].type, 'image')
  assert.equal(result.events[1][1].attachments[0].path, '/tmp/reference.png')
})

test('wechat adapter sends local files through media message items', (t) => {
  const python = resolvePython()
  if (!python) {
    t.skip('python3 is not available')
    return
  }

  const root = join(tmpdir(), `ready-wechat-send-file-${Date.now()}-${Math.random().toString(16).slice(2)}`)
  mkdirSync(root, { recursive: true })
  const filePath = join(root, 'result.md')
  writeFileSync(filePath, '# Ready\n')

  const script = `
import json
from ready_sidecar.channels.wechat_openclaw_adapter import WechatOpenClawAdapter

class FakeWechatAdapter(WechatOpenClawAdapter):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, **kwargs)
        self.calls = []

    def _http_request_json(self, method, base_url, endpoint, payload=None, token=None, timeout=15):
        self.calls.append({"method": method, "endpoint": endpoint, "payload": payload, "token": token})
        if "sendmessage" in endpoint:
            return {"ret": 0}
        raise AssertionError(endpoint)

    def _upload_attachment_to_cdn(self, account, target, path, media_type):
        self.calls.append({"method": "UPLOAD", "target": target, "path": str(path), "media_type": media_type})
        return {
            "filekey": "filekey-1",
            "downloadEncryptedQueryParam": "download-param-1",
            "aeskey": "00112233445566778899aabbccddeeff",
            "fileSize": 8,
            "fileSizeCiphertext": 16,
        }

adapter = FakeWechatAdapter("channel-wechat-openclaw-default", "wechat-openclaw", "微信", {
    "stateDir": ${JSON.stringify(root)},
})
adapter._save_account({
    "accountId": "bot@im.bot",
    "userId": "owner@im.wechat",
    "token": "token-1",
    "baseUrl": "https://ilinkai.weixin.qq.com",
    "cdnBaseUrl": "https://novac2c.cdn.weixin.qq.com/c2c",
})
send = adapter.send(None, "", [{
    "name": "result.md",
    "path": ${JSON.stringify(filePath)},
    "type": "text",
    "mimeType": "text/markdown",
    "size": 8,
}])
print(json.dumps({"send": send, "calls": adapter.calls}, ensure_ascii=False))
`

  const output = execFileSync(python, ['-c', script], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      PYTHONPATH: join(process.cwd(), 'src/python'),
    },
    encoding: 'utf8',
  })
  const result = JSON.parse(output)

  assert.deepEqual(result.send, [true, null])
  const upload = result.calls.find((call: { method: string }) => call.method === 'UPLOAD')
  assert.equal(upload.target, 'owner@im.wechat')
  assert.equal(upload.media_type, 3)
  const sendCall = result.calls.find((call: { endpoint: string }) => call.endpoint?.includes('sendmessage'))
  assert.equal(sendCall.payload.msg.to_user_id, 'owner@im.wechat')
  const item = sendCall.payload.msg.item_list[0]
  assert.equal(item.type, 4)
  assert.equal(item.file_item.file_name, 'result.md')
  assert.equal(item.file_item.len, '8')
  assert.equal(item.file_item.media.encrypt_query_param, 'download-param-1')
  assert.equal(item.file_item.media.encrypt_type, 1)
})

test('wechat adapter reports nonzero sendmessage ret as a failed send', (t) => {
  const python = resolvePython()
  if (!python) {
    t.skip('python3 is not available')
    return
  }

  const root = join(tmpdir(), `ready-wechat-send-ret-${Date.now()}-${Math.random().toString(16).slice(2)}`)
  mkdirSync(root, { recursive: true })

  const script = `
import json
from ready_sidecar.channels.wechat_openclaw_adapter import WechatOpenClawAdapter

class FakeWechatAdapter(WechatOpenClawAdapter):
    def _http_request_json(self, method, base_url, endpoint, payload=None, token=None, timeout=15):
        if "sendmessage" in endpoint:
            return {"ret": -2}
        raise AssertionError(endpoint)

adapter = FakeWechatAdapter("channel-wechat-openclaw-default", "wechat-openclaw", "微信", {
    "stateDir": ${JSON.stringify(root)},
})
adapter._save_account({
    "accountId": "bot@im.bot",
    "userId": "owner@im.wechat",
    "token": "token-1",
    "baseUrl": "https://ilinkai.weixin.qq.com",
})
send = adapter.send(None, "Ready ping")
print(json.dumps({"send": send}, ensure_ascii=False))
`

  const output = execFileSync(python, ['-c', script], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      PYTHONPATH: join(process.cwd(), 'src/python'),
    },
    encoding: 'utf8',
  })
  const result = JSON.parse(output)

  assert.equal(result.send[0], false)
  assert.match(result.send[1], /ret=-2/)
})

test('wechat adapter notifies WeChat session start and stop', (t) => {
  const python = resolvePython()
  if (!python) {
    t.skip('python3 is not available')
    return
  }

  const root = join(tmpdir(), `ready-wechat-notify-${Date.now()}-${Math.random().toString(16).slice(2)}`)
  mkdirSync(root, { recursive: true })

  const script = `
import json
import time
from ready_sidecar.channels.wechat_openclaw_adapter import WechatOpenClawAdapter

class FakeWechatAdapter(WechatOpenClawAdapter):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, **kwargs)
        self.calls = []

    def _http_request_json(self, method, base_url, endpoint, payload=None, token=None, timeout=15):
        self.calls.append({"method": method, "endpoint": endpoint, "payload": payload, "token": token})
        if "notifystart" in endpoint or "notifystop" in endpoint:
            return {"ret": 0}
        if "getupdates" in endpoint:
            return {"ret": 0, "msgs": [], "get_updates_buf": ""}
        raise AssertionError(endpoint)

adapter = FakeWechatAdapter("channel-wechat-openclaw-default", "wechat-openclaw", "微信", {
    "stateDir": ${JSON.stringify(root)},
    "routeTag": "route-1",
    "botAgent": "ReadyTest/1.0.0",
})
adapter._save_account({
    "accountId": "bot@im.bot",
    "userId": "owner@im.wechat",
    "token": "token-1",
    "baseUrl": "https://ilinkai.weixin.qq.com",
})
started = adapter.start()
time.sleep(0.05)
adapter.stop()
print(json.dumps({"started": started, "calls": adapter.calls, "headers": adapter._headers("token-1")}, ensure_ascii=False))
`

  const output = execFileSync(python, ['-c', script], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      PYTHONPATH: join(process.cwd(), 'src/python'),
    },
    encoding: 'utf8',
  })
  const result = JSON.parse(output)

  assert.deepEqual(result.started, [true, null])
  const endpoints = result.calls.map((call: { endpoint: string }) => call.endpoint)
  assert.ok(endpoints.includes('ilink/bot/msg/notifystart'))
  assert.ok(endpoints.includes('ilink/bot/msg/notifystop'))
  const startCall = result.calls.find((call: { endpoint: string }) => call.endpoint === 'ilink/bot/msg/notifystart')
  assert.equal(startCall.payload.base_info.channel_version, '2.4.4')
  assert.equal(startCall.payload.base_info.bot_agent, 'ReadyTest/1.0.0')
  assert.equal(result.headers.SKRouteTag, 'route-1')
})

test('wechat adapter builds PDF and video outbound media items', (t) => {
  const python = resolvePython()
  if (!python) {
    t.skip('python3 is not available')
    return
  }

  const root = join(tmpdir(), `ready-wechat-send-pdf-video-${Date.now()}-${Math.random().toString(16).slice(2)}`)
  mkdirSync(root, { recursive: true })
  const pdfPath = join(root, 'report.pdf')
  const videoPath = join(root, 'clip.mp4')
  writeFileSync(pdfPath, '%PDF-ready\n')
  writeFileSync(videoPath, 'video-ready\n')

  const script = `
import json
from ready_sidecar.channels.wechat_openclaw_adapter import WechatOpenClawAdapter

class FakeWechatAdapter(WechatOpenClawAdapter):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, **kwargs)
        self.calls = []

    def _http_request_json(self, method, base_url, endpoint, payload=None, token=None, timeout=15):
        self.calls.append({"method": method, "endpoint": endpoint, "payload": payload, "token": token})
        if "sendmessage" in endpoint:
            return {"ret": 0}
        raise AssertionError(endpoint)

    def _upload_attachment_to_cdn(self, account, target, path, media_type):
        self.calls.append({"method": "UPLOAD", "target": target, "path": str(path), "media_type": media_type})
        return {
            "filekey": "filekey-" + str(media_type),
            "downloadEncryptedQueryParam": "download-param-" + str(media_type),
            "aeskey": "00112233445566778899aabbccddeeff",
            "fileSize": path.stat().st_size,
            "fileSizeCiphertext": 32,
        }

adapter = FakeWechatAdapter("channel-wechat-openclaw-default", "wechat-openclaw", "微信", {
    "stateDir": ${JSON.stringify(root)},
})
adapter._save_account({
    "accountId": "bot@im.bot",
    "userId": "owner@im.wechat",
    "token": "token-1",
    "baseUrl": "https://ilinkai.weixin.qq.com",
    "cdnBaseUrl": "https://novac2c.cdn.weixin.qq.com/c2c",
})
send = adapter.send(None, "", [
    {"name": "report.pdf", "path": ${JSON.stringify(pdfPath)}, "type": "text", "mimeType": "application/pdf", "size": 10},
    {"name": "clip.mp4", "path": ${JSON.stringify(videoPath)}, "type": "video", "mimeType": "video/mp4", "size": 12},
])
print(json.dumps({"send": send, "calls": adapter.calls}, ensure_ascii=False))
`

  const output = execFileSync(python, ['-c', script], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      PYTHONPATH: join(process.cwd(), 'src/python'),
    },
    encoding: 'utf8',
  })
  const result = JSON.parse(output)

  assert.deepEqual(result.send, [true, null])
  const uploads = result.calls.filter((call: { method: string }) => call.method === 'UPLOAD')
  assert.deepEqual(uploads.map((call: { media_type: number }) => call.media_type), [3, 2])
  const sendCalls = result.calls.filter((call: { endpoint: string }) => call.endpoint?.includes('sendmessage'))
  assert.equal(sendCalls.length, 2)
  const pdfItem = sendCalls[0].payload.msg.item_list[0]
  assert.equal(pdfItem.type, 4)
  assert.equal(pdfItem.file_item.file_name, 'report.pdf')
  assert.equal(pdfItem.file_item.media.encrypt_query_param, 'download-param-3')
  const videoItem = sendCalls[1].payload.msg.item_list[0]
  assert.equal(videoItem.type, 5)
  assert.equal(videoItem.video_item.video_size, 32)
  assert.equal(videoItem.video_item.media.encrypt_query_param, 'download-param-2')
})

test('wechat adapter downloads inbound image media to a local attachment path', (t) => {
  const python = resolvePython()
  if (!python) {
    t.skip('python3 is not available')
    return
  }

  const root = join(tmpdir(), `ready-wechat-download-image-${Date.now()}-${Math.random().toString(16).slice(2)}`)
  mkdirSync(root, { recursive: true })

  const script = `
import json
from pathlib import Path
from ready_sidecar.channels.wechat_openclaw_adapter import WechatOpenClawAdapter

events = []

class FakeWechatAdapter(WechatOpenClawAdapter):
    def _http_request_json(self, method, base_url, endpoint, payload=None, token=None, timeout=15):
        if "getupdates" in endpoint:
            return {
                "ret": 0,
                "get_updates_buf": "next-sync",
                "msgs": [{
                    "from_user_id": "friend@im.wechat",
                    "client_id": "image-msg-1",
                    "item_list": [{
                        "type": 2,
                        "image_item": {
                            "media": {"full_url": "https://cdn.example/image"},
                        },
                    }],
                }],
            }
        raise AssertionError(endpoint)

    def _get_bytes(self, url, timeout=60):
        return b"image-bytes"

adapter = FakeWechatAdapter("channel-wechat-openclaw-default", "wechat-openclaw", "微信", {
    "stateDir": ${JSON.stringify(root)},
    "runtimeRoot": ${JSON.stringify(root)},
})
adapter.set_event_callback(lambda event_type, payload: events.append([event_type, payload]))
adapter._poll_updates_once({
    "accountId": "bot@im.bot",
    "token": "token-1",
    "baseUrl": "https://ilinkai.weixin.qq.com",
    "cdnBaseUrl": "https://novac2c.cdn.weixin.qq.com/c2c",
})
path = events[0][1]["attachments"][0]["path"]
print(json.dumps({
    "events": events,
    "exists": Path(path).exists(),
    "content": Path(path).read_bytes().decode("utf-8"),
}, ensure_ascii=False))
`

  const output = execFileSync(python, ['-c', script], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      PYTHONPATH: join(process.cwd(), 'src/python'),
    },
    encoding: 'utf8',
  })
  const result = JSON.parse(output)

  assert.equal(result.events.length, 1)
  assert.equal(result.events[0][1].attachments[0].type, 'image')
  assert.equal(result.events[0][1].attachments[0].downloaded, true)
  assert.equal(result.exists, true)
  assert.equal(result.content, 'image-bytes')
  assert.equal(existsSync(result.events[0][1].attachments[0].path), true)
})

test('wechat adapter sends and cancels native typing state', (t) => {
  const python = resolvePython()
  if (!python) {
    t.skip('python3 is not available')
    return
  }

  const root = join(tmpdir(), `ready-wechat-typing-${Date.now()}-${Math.random().toString(16).slice(2)}`)
  mkdirSync(root, { recursive: true })

  const script = `
import json
from ready_sidecar.channels.wechat_openclaw_adapter import WechatOpenClawAdapter

class FakeWechatAdapter(WechatOpenClawAdapter):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, **kwargs)
        self.calls = []

    def _http_request_json(self, method, base_url, endpoint, payload=None, token=None, timeout=15):
        self.calls.append({"method": method, "endpoint": endpoint, "payload": payload, "token": token, "timeout": timeout})
        if "getconfig" in endpoint:
            return {"ret": 0, "typing_ticket": "typing-ticket-1"}
        if "sendtyping" in endpoint:
            return {"ret": 0}
        raise AssertionError(endpoint)

adapter = FakeWechatAdapter("channel-wechat-openclaw-default", "wechat-openclaw", "微信", {
    "stateDir": ${JSON.stringify(root)},
})
adapter._save_account({
    "accountId": "bot@im.bot",
    "token": "token-1",
    "baseUrl": "https://ilinkai.weixin.qq.com",
    "cdnBaseUrl": "https://novac2c.cdn.weixin.qq.com/c2c",
})
adapter._save_context_tokens("bot@im.bot", {"friend@im.wechat": "ctx-1"})
start = adapter.send_typing("friend@im.wechat", True)
stop = adapter.send_typing("friend@im.wechat", False)
print(json.dumps({"start": start, "stop": stop, "calls": adapter.calls}, ensure_ascii=False))
`

  const output = execFileSync(python, ['-c', script], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      PYTHONPATH: join(process.cwd(), 'src/python'),
    },
    encoding: 'utf8',
  })
  const result = JSON.parse(output)

  assert.deepEqual(result.start, [true, null])
  assert.deepEqual(result.stop, [true, null])
  const configCalls = result.calls.filter((call: { endpoint: string }) => call.endpoint.includes('getconfig'))
  const typingCalls = result.calls.filter((call: { endpoint: string }) => call.endpoint.includes('sendtyping'))
  assert.equal(configCalls.length, 1)
  assert.equal(configCalls[0].payload.ilink_user_id, 'friend@im.wechat')
  assert.equal(configCalls[0].payload.context_token, 'ctx-1')
  assert.equal(typingCalls.length, 2)
  assert.equal(typingCalls[0].payload.typing_ticket, 'typing-ticket-1')
  assert.equal(typingCalls[0].payload.status, 1)
  assert.equal(typingCalls[1].payload.status, 2)
})
