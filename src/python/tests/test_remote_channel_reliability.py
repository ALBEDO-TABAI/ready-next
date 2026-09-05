import json
import importlib
import os
import tempfile
import time
import unittest
from pathlib import Path
from unittest.mock import patch

from ready_sidecar.event_store import EventStore
from ready_sidecar.channels.feishu_app_adapter import FeishuAppAdapter
from ready_sidecar.channels.wechat_openclaw_adapter import WechatOpenClawAdapter


class RemoteChannelReliabilityTests(unittest.TestCase):
    def test_wechat_reply_context_is_persisted_before_main_can_consume_the_message(self):
        with tempfile.TemporaryDirectory() as root:
            adapter = WechatOpenClawAdapter('w', 'wechat-openclaw', 'WeChat', {'stateDir': root, 'allowedSenderId': 'owner'})
            adapter._post_json = lambda *args, **kwargs: {'ret': 0, 'get_updates_buf': 'next', 'msgs': [{
                'from_user_id': 'owner', 'msg_id': 'one', 'context_token': 'reply-context',
                'item_list': [{'type': 1, 'text_item': {'text': 'hello'}}]}]}
            observed = []
            adapter.set_event_callback(lambda *_: observed.append(adapter._load_context_tokens('account').get('owner')))
            adapter._poll_updates_once({'accountId': 'account', 'userId': 'owner', 'token': 'fixture-token'})
            self.assertEqual(observed, ['reply-context'])

    def test_already_bound_qr_result_publishes_completion_without_renderer_polling(self):
        with tempfile.TemporaryDirectory() as root:
            adapter = WechatOpenClawAdapter('w', 'wechat-openclaw', 'WeChat', {'stateDir': root, 'accountId': 'account'})
            adapter._save_account({'accountId': 'account', 'token': 'fixture-token', 'userId': 'owner'})
            adapter._login_sessions['session'] = {'startedAt': time.time(), 'qrcode': 'fixture-qr'}
            adapter._get_json = lambda *args, **kwargs: {'status': 'binded_redirect'}
            events = []
            adapter.set_event_callback(lambda kind, payload: events.append((kind, payload)))
            adapter._poll_login_session('session')
            self.assertEqual(events[0][0], 'channel.wechat-bound')
            self.assertEqual(events[0][1]['sessionKey'], 'session')
            self.assertEqual(events[0][1]['userId'], 'owner')
            self.assertEqual(adapter.get_login_status('session')['status'], 'already_connected')

    def test_public_callback_cannot_bypass_long_connection_authentication(self):
        import asyncio
        from fastapi import HTTPException
        from starlette.requests import Request
        with tempfile.TemporaryDirectory() as root, patch.dict(os.environ, {'READY_SIDECAR_RUNTIME_ROOT': root}):
            main = importlib.import_module('ready_sidecar.main')
            channel = main.ChannelConfig(id='callback-fixture', type='feishu-app', name='Fixture', enabled=True, config={})
            main.state.channels[channel.id] = channel
            main.state.channel_manager.adapters[channel.id] = FeishuAppAdapter(channel.id, channel.type, channel.name, {})
            try:
                with self.assertRaises(HTTPException) as caught:
                    asyncio.run(main.feishu_callback(channel.id, Request({'type': 'http', 'headers': []})))
                self.assertEqual(caught.exception.status_code, 403)
                self.assertEqual(main.state.pull_events(10), [])
            finally:
                main.state.event_store.close()

    def test_inbound_survives_pull_restart_and_requires_explicit_ack(self):
        with tempfile.TemporaryDirectory() as root:
            path = Path(root) / "events.db"
            store = EventStore(path)
            store.enqueue("channel.inbound", {"id": "fs:c:m", "text": "hello"})
            first = store.pull(10)
            self.assertEqual(store.pull(10), first)
            store.close()
            store = EventStore(path)
            self.assertEqual(store.pull(10), first)
            store.enqueue("channel.inbound", {"id": "fs:c:m", "text": "hello"})
            self.assertEqual(len(store.pull(10)), 1)
            store.ack([first[0]["id"]])
            store.ack([first[0]["id"]])
            self.assertEqual(store.pull(10), [])
            store.close()

    def test_unknown_delivery_is_not_sent_again_after_restart(self):
        with tempfile.TemporaryDirectory() as root:
            path = Path(root) / "events.db"
            store = EventStore(path)
            payload = {"id": "c", "thread": "t", "text": "hello"}
            self.assertIsNone(store.begin_delivery("delivery-1", payload))
            store.close()
            store = EventStore(path)
            repeated = store.begin_delivery("delivery-1", payload)
            self.assertFalse(repeated["success"])
            self.assertIn("unknown", repeated["error"])
            store.finish_delivery("delivery-1", {"success": True})
            self.assertEqual(store.begin_delivery("delivery-1", payload), {"success": True})
            self.assertFalse(store.begin_delivery("delivery-1", {**payload, "thread": "other"})["success"])
            store.close()

    def test_feishu_ignores_bot_messages_and_requires_group_trigger(self):
        adapter = FeishuAppAdapter("c", "feishu-app", "Feishu", {"triggerPrefix": "@ready"})
        def message(text, chat_type="group", sender_type="user"):
            return {"event": {"message": {"chat_id": "chat", "message_id": "m", "chat_type": chat_type,
                "message_type": "text", "content": json.dumps({"text": text})},
                "sender": {"sender_type": sender_type, "sender_id": {"open_id": "owner"}}}}
        self.assertIsNone(adapter._extract_im_event(message("ordinary chat")))
        self.assertIsNone(adapter._extract_im_event(message("@ready loop", sender_type="app")))
        self.assertEqual(adapter._extract_im_event(message("@ready hello"))["text"], "hello")
        self.assertEqual(adapter._extract_im_event(message("hello", "p2p"))["text"], "hello")

    def test_feishu_file_delivery_uploads_and_does_not_succeed_when_upload_fails(self):
        adapter = FeishuAppAdapter("c", "feishu-app", "Feishu", {})
        adapter._refresh_access_token = lambda force: ("fixture-token", None)
        with tempfile.TemporaryDirectory() as root:
            path = Path(root) / "result.txt"
            path.write_text("result")
            calls = []
            def post(url, **kwargs):
                calls.append((url, kwargs))
                class Response:
                    def json(self):
                        return {"code": 0, "data": {"file_key": "file-1", "message_id": "m-1"}}
                    def raise_for_status(self):
                        pass
                return Response()
            with patch("ready_sidecar.channels.feishu_app_adapter.requests.post", post):
                self.assertEqual(adapter.send("chat", "", [{"path": str(path), "name": path.name}]), (True, None))
            self.assertEqual(len(calls), 2)
            self.assertTrue(calls[0][0].endswith("/files"))
            self.assertEqual(calls[1][1]["json"]["msg_type"], "file")
            with patch("ready_sidecar.channels.feishu_app_adapter.requests.post", side_effect=RuntimeError("upload failed")):
                self.assertFalse(adapter.send("chat", "", [{"path": str(path)}])[0])

    def test_wechat_does_not_advance_cursor_when_persistence_fails(self):
        with tempfile.TemporaryDirectory() as root:
            adapter = WechatOpenClawAdapter("c", "wechat-openclaw", "Wechat", {"stateDir": root})
            account = {"accountId": "bot", "token": "fixture-token", "userId": "owner"}
            adapter._post_json = lambda *args, **kwargs: {"ret": 0, "get_updates_buf": "next",
                "msgs": [{"from_user_id": "owner", "msg_id": "m", "item_list": [{"type": 1, "text_item": {"text": "hello"}}]}]}
            adapter.set_event_callback(lambda *_: (_ for _ in ()).throw(RuntimeError("disk full")))
            with self.assertRaisesRegex(RuntimeError, "disk full"):
                adapter._poll_updates_once(account)
            self.assertEqual(list(Path(root).glob("accounts/*.sync.json")), [])

    def test_wechat_restores_identity_before_receiving_and_only_forwards_its_owner(self):
        with tempfile.TemporaryDirectory() as root:
            adapter = WechatOpenClawAdapter("c", "wechat-openclaw", "Wechat", {"stateDir": root})
            account = {"accountId": "bot", "token": "fixture-token", "userId": "owner"}
            def message(sender, identity):
                return {"from_user_id": sender, "msg_id": identity, "item_list": [{"type": 1, "text_item": {"text": "hello"}}]}
            adapter._post_json = lambda *args, **kwargs: {"ret": 0, "get_updates_buf": "next",
                "msgs": [message("stranger", "ignored"), message("owner", "accepted")]}
            events = []
            adapter.set_event_callback(lambda kind, payload: events.append((kind, payload)))
            adapter._poll_updates_once(account)
            self.assertEqual([kind for kind, _ in events], ['channel.wechat-restored', 'channel.inbound'])
            self.assertEqual(events[0][1]['bindingId'], events[1][1]['meta']['bindingId'])
            self.assertNotIn('token', events[0][1])

    def test_forgetting_wechat_deletes_only_the_selected_account_and_its_context(self):
        with tempfile.TemporaryDirectory() as root:
            adapter = WechatOpenClawAdapter("c", "wechat-openclaw", "Wechat", {"stateDir": root, "accountId": "one"})
            adapter._save_account({"accountId": "one", "token": "fixture-one"})
            adapter._save_account({"accountId": "two", "token": "fixture-two"})
            adapter._save_context_tokens("one", {"owner": "context"})
            adapter.forget_account()
            self.assertIsNone(adapter._load_account("one"))
            self.assertIsNotNone(adapter._load_account("two"))
            self.assertEqual(adapter._list_account_ids(), ["two"])
            self.assertEqual(adapter._load_context_tokens("one"), {})


if __name__ == "__main__":
    unittest.main()
