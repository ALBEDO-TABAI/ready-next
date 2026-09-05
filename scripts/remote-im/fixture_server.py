"""Loopback-only Feishu, WeChat and Responses endpoints for Electron acceptance."""
import asyncio
import json
import sys
import uuid

from fastapi import FastAPI, Request, WebSocket
from fastapi.responses import PlainTextResponse, StreamingResponse
import uvicorn
from lark_oapi.ws.pb.pbbp2_pb2 import Frame

port = int(sys.argv[1])
app = FastAPI()
sockets = set()
outbound = []
provider_calls = []
acks = []
wechat_inbound = []
wechat_outbound = []


@app.post('/fixture/wechat/inbound')
async def enqueue_wechat(request: Request):
    body = await request.json()
    wechat_inbound.append({'msg_id': body['id'], 'from_user_id': body.get('sender', 'wechat-owner'),
        'context_token': 'fixture-context', 'item_list': [{'type': 1, 'text_item': {'text': body['text']}}]})
    return {'success': True}


@app.post('/ilink/bot/msg/notifystart')
@app.post('/ilink/bot/msg/notifystop')
async def wechat_notify():
    return {'ret': 0}


@app.post('/ilink/bot/getupdates')
async def wechat_updates(request: Request):
    cursor = int((await request.json()).get('get_updates_buf') or 0)
    if cursor == len(wechat_inbound):
        await asyncio.sleep(0.4)
    return {'ret': 0, 'msgs': wechat_inbound[cursor:], 'get_updates_buf': str(len(wechat_inbound))}


@app.post('/ilink/bot/sendmessage')
async def wechat_send(request: Request):
    wechat_outbound.append((await request.json())['msg'])
    return {'ret': 0}


@app.post('/open-apis/auth/v3/tenant_access_token/internal')
async def token():
    return {'code': 0, 'tenant_access_token': 'local-fixture-token', 'expire': 7200}


@app.get('/open-apis/bot/v3/info/')
async def bot():
    return {'code': 0, 'bot': {'open_id': 'fixture-bot'}}


@app.post('/callback/ws/endpoint')
async def endpoint():
    return {'code': 0, 'data': {'URL': f'ws://127.0.0.1:{port}/socket?device_id=fixture&service_id=1',
                              'ClientConfig': {'PingInterval': 120}}}


@app.websocket('/socket')
async def socket(ws: WebSocket):
    await ws.accept()
    sockets.add(ws)
    try:
        while True:
            raw = await ws.receive_bytes()
            frame = Frame()
            frame.ParseFromString(raw)
            if frame.payload:
                acks.append(json.loads(frame.payload))
    except Exception:
        pass
    finally:
        sockets.discard(ws)


@app.post('/fixture/inbound')
async def inbound(request: Request):
    body = await request.json()
    message_id = body['id']
    message = {'message_id': message_id, 'chat_id': 'fixture-chat', 'chat_type': body.get('chatType', 'p2p'),
               'message_type': body.get('messageType', 'text'),
               'content': json.dumps(body.get('content', {'text': body.get('text', '')})), 'create_time': '1788595200000'}
    if body.get('topic'):
        message.update(thread_id=body['topic'], root_id=body['root'])
    envelope = {'schema': '2.0', 'header': {'event_id': message_id, 'event_type': 'im.message.receive_v1',
        'create_time': '1788595200000', 'app_id': 'fixture-app', 'tenant_key': 'fixture'},
        'event': {'sender': {'sender_type': 'user', 'sender_id': {'open_id': body.get('sender', 'fixture-owner')},
                            'tenant_key': 'fixture'}, 'message': message}}
    frame = Frame()
    frame.SeqID = 0
    frame.LogID = 0
    frame.service = 1
    frame.method = 1
    for key, value in {'type': 'event', 'message_id': message_id, 'trace_id': message_id, 'sum': '1', 'seq': '0'}.items():
        header = frame.headers.add()
        header.key, header.value = key, value
    frame.payload = json.dumps(envelope).encode()
    for ws in list(sockets):
        await ws.send_bytes(frame.SerializeToString())
    return {'success': True, 'connections': len(sockets)}


@app.get('/open-apis/im/v1/messages/{message_id}/resources/{file_key}')
async def resource(message_id: str, file_key: str):
    return PlainTextResponse('LOCAL_FIXTURE_ATTACHMENT', headers={'Content-Disposition': 'attachment; filename="brief.txt"'})


@app.post('/open-apis/im/v1/messages')
@app.post('/open-apis/im/v1/messages/{message_id}/reply')
async def send(request: Request, message_id: str = ''):
    body = await request.json()
    outbound.append({'replyTo': message_id, **body})
    return {'code': 0, 'data': {'message_id': f'out-{len(outbound)}'}}


@app.get('/fixture/records')
async def records():
    return {'connections': len(sockets), 'outbound': outbound, 'providerCalls': provider_calls, 'acks': acks,
        'wechatOutbound': wechat_outbound}


@app.post('/v1/responses')
async def responses(request: Request):
    body = await request.json()
    provider_calls.append({'model': body.get('model'), 'tools': [item.get('name') for item in body.get('tools', [])]})
    identity = uuid.uuid4().hex
    text = 'READY_REMOTE_OK'
    item = {'type': 'message', 'id': f'message-{identity}', 'role': 'assistant', 'phase': 'final_answer',
            'content': [{'type': 'output_text', 'text': text}]}
    events = [
        {'type': 'response.created', 'response': {'id': identity, 'model': body['model'], 'status': 'in_progress', 'output': []}},
        {'type': 'response.output_item.added', 'output_index': 0, 'item': {**item, 'content': []}},
        {'type': 'response.output_text.delta', 'output_index': 0, 'content_index': 0, 'item_id': item['id'], 'delta': text},
        {'type': 'response.output_text.done', 'output_index': 0, 'content_index': 0, 'item_id': item['id'], 'text': text},
        {'type': 'response.output_item.done', 'output_index': 0, 'item': item},
        {'type': 'response.completed', 'response': {'id': identity, 'model': body['model'], 'status': 'completed', 'output': [item],
            'usage': {'input_tokens': 20, 'output_tokens': 5, 'total_tokens': 25,
                      'input_tokens_details': {'cached_tokens': 0}, 'output_tokens_details': {'reasoning_tokens': 0}}}},
    ]
    return StreamingResponse(iter([f'event: {event["type"]}\ndata: {json.dumps(event)}\n\n' for event in events]), media_type='text/event-stream')


uvicorn.run(app, host='127.0.0.1', port=port, log_level='error')
