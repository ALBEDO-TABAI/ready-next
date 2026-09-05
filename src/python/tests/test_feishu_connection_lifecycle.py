import asyncio
import unittest
from unittest.mock import patch

import websockets
from ready_sidecar.channels.feishu_app_adapter import FeishuAppAdapter


class FeishuConnectionLifecycleTests(unittest.IsolatedAsyncioTestCase):
    async def test_two_connections_share_the_sdk_loop_and_both_close_without_restarting(self):
        active = set()
        total_connections = 0

        async def handler(socket):
            nonlocal total_connections
            total_connections += 1
            active.add(socket)
            try:
                await socket.wait_closed()
            finally:
                active.discard(socket)

        async def wait_for(predicate):
            async with asyncio.timeout(5):
                while not predicate():
                    await asyncio.sleep(0.02)

        async with websockets.serve(handler, '127.0.0.1', 0) as server:
            port = server.sockets[0].getsockname()[1]
            url = f'ws://127.0.0.1:{port}/?device_id=fixture&service_id=1'
            with patch.object(FeishuAppAdapter, '_connection_info', return_value=(url, 60)), \
                 patch.object(FeishuAppAdapter, '_load_bot_identity', return_value=None):
                first = FeishuAppAdapter('one', 'feishu-app', 'One', {'appId': 'one', 'appSecret': 'fixture'})
                second = FeishuAppAdapter('two', 'feishu-app', 'Two', {'appId': 'two', 'appSecret': 'fixture'})
                try:
                    self.assertEqual(first.start(), (True, None))
                    self.assertEqual(first.start(), (True, None))
                    self.assertEqual(second.start(), (True, None))
                    await wait_for(lambda: first.state.connected and second.state.connected)
                    self.assertEqual(total_connections, 2)
                    first.stop()
                    await wait_for(lambda: len(active) == 1)
                    self.assertFalse(first.state.connected)
                    self.assertTrue(second.state.connected)
                    second.stop()
                    await wait_for(lambda: not active)
                    self.assertEqual(total_connections, 2)
                finally:
                    first.stop()
                    second.stop()


if __name__ == '__main__':
    unittest.main()
