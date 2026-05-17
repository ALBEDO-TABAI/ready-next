import assert from 'node:assert/strict'
import { mkdirSync } from 'node:fs'
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
                    "from_user_id": "friend@im.wechat",
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
    "defaultTarget": "friend@im.wechat",
})
adapter.set_event_callback(lambda event_type, payload: events.append([event_type, payload]))

start = adapter.start_login(force=True)
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

  assert.equal(result.events.length, 1)
  assert.equal(result.events[0][0], 'channel.inbound')
  assert.equal(result.events[0][1].channelId, 'channel-wechat-openclaw-default')
  assert.equal(result.events[0][1].source, 'wechat-openclaw')
  assert.equal(result.events[0][1].thread, 'friend@im.wechat')
  assert.equal(result.events[0][1].text, '明天三点开会')

  assert.ok(result.calls.some((call: { endpoint: string }) => call.endpoint.includes('get_bot_qrcode')))
  assert.ok(result.calls.some((call: { endpoint: string }) => call.endpoint.includes('get_qrcode_status')))
  assert.ok(result.calls.some((call: { endpoint: string }) => call.endpoint.includes('sendmessage')))
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
start = adapter.start_login(force=True)
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
