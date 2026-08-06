const crypto = require('node:crypto')
const fs = require('node:fs')
const readline = require('node:readline')
const { spawn } = require('node:child_process')

const V1_BODY = 'E0R_RESOURCE_V1_BODY: policy says ALPHA only.'
const V2_BODY = 'E0R_RESOURCE_V2_BODY: policy says BETA only.'

function sha256(value) {
  return crypto.createHash('sha256').update(value).digest('hex')
}

function exactObject(value, expected) {
  return (
    value &&
    typeof value === 'object' &&
    JSON.stringify(Object.keys(value).sort()) ===
      JSON.stringify(Object.keys(expected).sort()) &&
    Object.entries(expected).every(([key, expectedValue]) => value[key] === expectedValue)
  )
}

function parseMcpResult(item) {
  const content = item?.result?.content
  if (!Array.isArray(content) || content.length !== 1 || content[0]?.type !== 'text') {
    return null
  }
  try {
    return JSON.parse(content[0].text)
  } catch {
    return null
  }
}

function listen(server) {
  return new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => resolve(server.address()))
  })
}

function closeServer(server) {
  return new Promise((resolve) => server.close(resolve))
}

function readBody(request) {
  return new Promise((resolve, reject) => {
    const chunks = []
    request.on('data', (chunk) => chunks.push(chunk))
    request.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
    request.on('error', reject)
  })
}

function sse(events) {
  return events
    .map((event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`)
    .join('')
}

function responseCreated(responseId) {
  return { type: 'response.created', response: { id: responseId } }
}

function responseCompleted(responseId, totalTokens = 120) {
  return {
    type: 'response.completed',
    response: {
      id: responseId,
      usage: {
        input_tokens: Math.max(1, totalTokens - 20),
        input_tokens_details: null,
        output_tokens: Math.min(20, totalTokens),
        output_tokens_details: null,
        total_tokens: totalTokens
      }
    }
  }
}

function messageEvents(responseId, messageId, text, totalTokens = 120) {
  return [
    responseCreated(responseId),
    {
      type: 'response.output_item.done',
      output_index: 0,
      item: {
        type: 'message',
        role: 'assistant',
        id: messageId,
        phase: 'final_answer',
        content: [{ type: 'output_text', text }]
      }
    },
    responseCompleted(responseId, totalTokens)
  ]
}

function functionCallEvents(responseId, callId, name, args, namespace = null) {
  const item = {
    type: 'function_call',
    call_id: callId,
    name,
    arguments: JSON.stringify(args)
  }
  if (namespace) item.namespace = namespace
  return [
    responseCreated(responseId),
    { type: 'response.output_item.done', output_index: 0, item },
    responseCompleted(responseId, 80)
  ]
}

function flattenText(value, output = []) {
  if (typeof value === 'string') output.push(value)
  else if (Array.isArray(value)) value.forEach((entry) => flattenText(entry, output))
  else if (value && typeof value === 'object') {
    Object.values(value).forEach((entry) => flattenText(entry, output))
  }
  return output
}

function parseJsonHeader(value) {
  try {
    return value ? JSON.parse(value) : null
  } catch {
    return null
  }
}

function extractReadyResourceRefs(value) {
  const pattern = /\{"logicalResourceId":"[^"]+","currentVersion":"[^"]+","currentDigest":"[^"]+","supersedesVersion":(?:null|"[^"]*"),"policyEpoch":\d+\}/g
  const refs = flattenText(value).flatMap((entry) =>
    [...entry.matchAll(pattern)].flatMap((match) => {
      try {
        return [JSON.parse(match[0])]
      } catch {
        return []
      }
    })
  )
  return [...new Map(refs.map((ref) => [JSON.stringify(ref), ref])).values()]
}

function requestSummary(body, headers = {}) {
  const text = flattenText(body).join('\n')
  const tools = Array.isArray(body.tools) ? body.tools : []
  const toolSurface = tools.flatMap((tool) => {
    if (tool.type === 'namespace' && Array.isArray(tool.tools)) {
      return tool.tools.map((nestedTool) => ({
        namespace: tool.name || null,
        name: nestedTool.name || nestedTool.type || null
      }))
    }
    return [{ namespace: tool.namespace || null, name: tool.name || tool.type || null }]
  })
  const count = (value) => text.split(value).length - 1
  return {
    requestSha256: sha256(JSON.stringify(body)),
    threadId: headers['thread-id'] || null,
    sessionId: headers['session-id'] || null,
    turnMetadata: parseJsonHeader(headers['x-codex-turn-metadata']),
    model: body.model || null,
    toolSurface,
    clientMetadata: body.client_metadata || null,
    readyResourceRefs: extractReadyResourceRefs(body),
    inputContains: {
      v1Body: text.includes(V1_BODY),
      v2Body: text.includes(V2_BODY),
      v1Ref: text.includes('"currentVersion":"v1"'),
      v2Ref: text.includes('"currentVersion":"v2"'),
      readyHistory: text.includes('READY_HISTORY_INJECTION_FORBIDDEN'),
      readyCompaction: text.includes('READY_COMPACTION_FORBIDDEN')
    },
    occurrenceCounts: {
      v1Body: count(V1_BODY),
      v2Body: count(V2_BODY)
    },
    inputItemDigests: Array.isArray(body.input)
      ? body.input.map((item) => ({
          role: item.role || null,
          type: item.type || null,
          digest: sha256(JSON.stringify(item)),
          containsV1Body: JSON.stringify(item).includes(V1_BODY),
          containsV2Body: JSON.stringify(item).includes(V2_BODY)
        }))
      : []
  }
}

class JsonLineClient {
  constructor(child, handleServerRequest) {
    this.child = child
    this.handleServerRequest = handleServerRequest
    this.frames = []
    this.waiters = []
    this.nextId = 1
    this.stderr = []
    this.serverRequests = []
    this.exit = new Promise((resolve) => {
      child.once('exit', (code, signal) => resolve({ code, signal }))
    })
    const lines = readline.createInterface({ input: child.stdout })
    lines.on('line', (line) => this._onLine(line))
    child.stderr.on('data', (chunk) => this.stderr.push(String(chunk)))
    child.on('exit', (code, signal) => {
      if (code !== 0 && signal !== 'SIGTERM') {
        this._rejectAll(
          new Error(`app-server exited code=${code} signal=${signal}: ${this.stderr.join('')}`)
        )
      }
    })
  }

  async _onLine(line) {
    let frame
    try {
      frame = JSON.parse(line)
    } catch {
      this._rejectAll(new Error(`Non-JSON stdout: ${line}`))
      return
    }
    this.frames.push(frame)
    if (frame.method === 'item/tool/call' && frame.id !== undefined) {
      this.serverRequests.push(frame)
      try {
        const result = await this.handleServerRequest(frame)
        this.write({ id: frame.id, result })
      } catch (error) {
        this.write({
          id: frame.id,
          error: { code: -32000, message: String(error) }
        })
      }
    }
    this._resolveWaiters(frame)
  }

  write(frame) {
    this.child.stdin.write(`${JSON.stringify(frame)}\n`)
  }

  request(method, params, timeoutMs = 30000) {
    const id = this.nextId
    this.nextId += 1
    const response = this.waitFor((frame) => frame.id === id, timeoutMs)
    this.write({ method, id, params })
    return response.then((frame) => {
      if (frame.error) throw new Error(`${method} failed: ${JSON.stringify(frame.error)}`)
      return frame.result
    })
  }

  notify(method, params) {
    this.write(params === undefined ? { method } : { method, params })
  }

  waitFor(predicate, timeoutMs = 30000) {
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        const index = this.waiters.findIndex((waiter) => waiter.resolve === resolve)
        if (index >= 0) this.waiters.splice(index, 1)
        reject(new Error(`Timed out waiting for app-server frame. stderr=${this.stderr.join('')}`))
      }, timeoutMs)
      this.waiters.push({
        predicate,
        resolve: (frame) => {
          clearTimeout(timeout)
          resolve(frame)
        },
        reject: (error) => {
          clearTimeout(timeout)
          reject(error)
        }
      })
    })
  }

  _resolveWaiters(frame) {
    const ready = this.waiters.filter((waiter) => waiter.predicate(frame))
    this.waiters = this.waiters.filter((waiter) => !ready.includes(waiter))
    ready.forEach((waiter) => waiter.resolve(frame))
  }

  _rejectAll(error) {
    this.waiters.splice(0).forEach((waiter) => waiter.reject(error))
  }

  async stop() {
    if (this.child.exitCode === null && this.child.signalCode === null) this.child.kill('SIGTERM')
    return this.exit
  }
}

function spawnAppServer(binary, cwd, env, handleServerRequest) {
  const child = spawn(binary, ['app-server', '--stdio', '--strict-config'], {
    cwd,
    env,
    stdio: ['pipe', 'pipe', 'pipe']
  })
  return new JsonLineClient(child, handleServerRequest)
}

function turnCompleted(frame, turnId) {
  return frame.method === 'turn/completed' && frame.params?.turn?.id === turnId
}

async function startTurn(client, params, timeoutMs = 60000) {
  const start = await client.request('turn/start', params, timeoutMs)
  const terminal = await client.waitFor((frame) => turnCompleted(frame, start.turn.id), timeoutMs)
  return { start, terminal }
}

async function waitForFrame(client, predicate, timeoutMs = 60000) {
  return client.frames.find(predicate) || client.waitFor(predicate, timeoutMs)
}

async function collectNativeChildTurn(client, capture, caseId) {
  const threadId = capture.summary.threadId
  const turnId = capture.summary.turnMetadata?.turn_id || null
  const terminal = await waitForFrame(
    client,
    (frame) =>
      frame.method === 'turn/completed' &&
      frame.params?.threadId === threadId &&
      frame.params?.turn?.id === turnId
  )
  const read = await client.request('thread/read', { threadId, includeTurns: true })
  const turn = read.thread.turns.find((entry) => entry.id === turnId)
  const completedItems = client.frames
    .filter(
      (frame) =>
        frame.method === 'item/completed' &&
        frame.params?.threadId === threadId &&
        frame.params?.turnId === turnId
    )
    .map((frame) => frame.params.item)
  const summarizeToolItem = (item) => ({
    id: item.id,
    type: item.type,
    server: item.server || null,
    tool: item.tool || null,
    namespace: item.namespace || null,
    status: item.status || null,
    arguments: item.arguments || null,
    result: item.result || null,
    success: item.success ?? null
  })
  return {
    caseId,
    threadId,
    turnId,
    terminalStatus: terminal.params?.turn?.status || null,
    readbackThreadId: read.thread.id,
    readbackTurnFound: Boolean(turn),
    finalText: finalAgentText(read, turnId),
    itemTypes: (turn?.items || []).map((item) => item.type),
    notificationItemTypes: completedItems.map((item) => item.type),
    mcpToolCalls: completedItems
      .filter((item) => item.type === 'mcpToolCall')
      .map(summarizeToolItem),
    dynamicToolCalls: completedItems
      .filter((item) => item.type === 'dynamicToolCall')
      .map(summarizeToolItem)
  }
}

function reconcileMcpReadBindings(mcpAudit, nativeTurn, captures, authority) {
  const providerCalls = captures
    .filter((capture) => capture.marker.startsWith('E0R_CHILD_NONE_TASK'))
    .map((capture) => capture.responseToolCall)
    .filter(Boolean)
  return mcpAudit
    .filter((entry) => ['stale_read_denied', 'current_read'].includes(entry.kind))
    .map((entry) => {
      const requestNonce = entry.requested?.requestNonce || null
      const nativeItems = nativeTurn.mcpToolCalls.filter(
        (item) => item.arguments?.requestNonce === requestNonce
      )
      const matchingProviderCalls = providerCalls.filter(
        (call) => call.arguments?.requestNonce === requestNonce
      )
      const nativeItem = nativeItems.length === 1 ? nativeItems[0] : null
      const providerCall =
        matchingProviderCalls.length === 1 ? matchingProviderCalls[0] : null
      const version = entry.kind === 'current_read' ? authority.currentVersion : 'v1'
      const expectedArguments = {
        logicalResourceId: authority.logicalResourceId,
        version,
        requestNonce
      }
      const parsedResult = parseMcpResult(nativeItem)
      const provisional = entry.provisionalReceipt
      const resultValid =
        entry.kind === 'current_read'
          ? exactObject(parsedResult, {
              ok: true,
              body: authority.body,
              bodyBytes: Buffer.byteLength(authority.body),
              provisionalReceipt: parsedResult?.provisionalReceipt
            }) &&
            JSON.stringify(parsedResult.provisionalReceipt) ===
              JSON.stringify(provisional) &&
            provisional?.transport === 'mcp_provisional' &&
            typeof provisional?.receiptId === 'string' &&
            provisional.receiptId.length > 0 &&
            typeof provisional?.mcpRequestId === 'string' &&
            provisional.mcpRequestId.length > 0 &&
            provisional?.callId === null &&
            provisional?.threadId === nativeTurn.threadId &&
            provisional?.turnId === nativeTurn.turnId &&
            provisional?.requestNonce === requestNonce &&
            provisional?.logicalResourceId === authority.logicalResourceId &&
            provisional?.version === authority.currentVersion &&
            provisional?.digest === authority.currentDigest &&
            provisional?.policyEpoch === authority.policyEpoch &&
            provisional?.resultDigest === sha256(authority.body)
          : exactObject(parsedResult, {
              ok: false,
              error: 'resource_version_superseded',
              logicalResourceId: authority.logicalResourceId,
              requestedVersion: 'v1',
              currentVersion: authority.currentVersion,
              bodyBytes: 0,
              receipt: null
            }) && JSON.stringify(parsedResult) === JSON.stringify(entry.denial)
      const bindingValid =
        Boolean(requestNonce) &&
        entry.metadata?.thread_id === nativeTurn.threadId &&
        entry.metadata?.turn_id === nativeTurn.turnId &&
        nativeItem?.id === providerCall?.callId &&
        nativeItem?.server === 'ready_resource' &&
        nativeItem?.tool === 'read_current_resource' &&
        nativeItem?.status === 'completed' &&
        exactObject(nativeItem?.result, {
          content: nativeItem?.result?.content,
          structuredContent: null,
          _meta: null
        }) &&
        exactObject(entry.requested, expectedArguments) &&
        exactObject(nativeItem?.arguments, expectedArguments) &&
        exactObject(providerCall?.arguments, expectedArguments) &&
        resultValid
      const receipt =
        entry.kind === 'current_read' && bindingValid
          ? {
              receiptId: `mcp-host-${nativeItem.id}`,
              transport: 'mcp_host_reconciled',
              threadId: nativeTurn.threadId,
              turnId: nativeTurn.turnId,
              callId: nativeItem.id,
              requestNonce,
              logicalResourceId: authority.logicalResourceId,
              version: authority.currentVersion,
              digest: authority.currentDigest,
              policyEpoch: authority.policyEpoch,
              resultDigest: entry.provisionalReceipt.resultDigest
            }
          : null
      return {
        kind: entry.kind,
        requestNonce,
        providerCallId: providerCall?.callId || null,
        nativeCallId: nativeItem?.id || null,
        provisionalReceiptId: entry.provisionalReceipt?.receiptId || null,
        bindingValid,
        receipt
      }
    })
}

function finalAgentText(threadRead, turnId) {
  const turn = threadRead.thread.turns.find((entry) => entry.id === turnId)
  const messages = (turn?.items || []).filter((item) => item.type === 'agentMessage')
  return messages.at(-1)?.text || null
}

class ResourceAuthorityHost {
  constructor(authorityPath) {
    this.authorityPath = authorityPath
    this.audit = []
    this.effects = []
    this.receipts = []
    this.setVersion('v1')
  }

  setVersion(version) {
    const body = version === 'v1' ? V1_BODY : V2_BODY
    this.current = {
      logicalResourceId: 'resource-a',
      currentVersion: version,
      currentDigest: sha256(body),
      policyEpoch: version === 'v1' ? 1 : 2,
      body
    }
    fs.writeFileSync(this.authorityPath, `${JSON.stringify(this.current, null, 2)}\n`)
  }

  thinRef(supersedesVersion = null) {
    return {
      logicalResourceId: this.current.logicalResourceId,
      currentVersion: this.current.currentVersion,
      currentDigest: this.current.currentDigest,
      supersedesVersion,
      policyEpoch: this.current.policyEpoch
    }
  }

  _denial(frame) {
    return {
      ok: false,
      error: 'resource_version_superseded',
      logicalResourceId: frame.params.arguments.logicalResourceId || null,
      requestedVersion: frame.params.arguments.version || null,
      currentVersion: this.current.currentVersion,
      bodyBytes: 0,
      receipt: null
    }
  }

  _result(value) {
    return {
      contentItems: [{ type: 'inputText', text: JSON.stringify(value) }],
      success: true
    }
  }

  handleDynamic(frame) {
    const args = frame.params.arguments || {}
    const current =
      args.logicalResourceId === this.current.logicalResourceId &&
      args.version === this.current.currentVersion
    if (frame.params.tool === 'ready_resource_read') {
      if (!current) {
        const denial = this._denial(frame)
        this.audit.push({ kind: 'stale_read_denied', frame: frame.params, denial })
        return this._result(denial)
      }
      const receipt = {
        receiptId: `dynamic-${frame.params.callId}`,
        transport: 'dynamic_tool',
        threadId: frame.params.threadId,
        turnId: frame.params.turnId,
        callId: frame.params.callId,
        logicalResourceId: this.current.logicalResourceId,
        version: this.current.currentVersion,
        digest: this.current.currentDigest,
        policyEpoch: this.current.policyEpoch,
        resultDigest: sha256(this.current.body)
      }
      this.receipts.push(receipt)
      this.audit.push({ kind: 'current_read', frame: frame.params, receipt })
      return this._result({
        ok: true,
        body: this.current.body,
        bodyBytes: Buffer.byteLength(this.current.body),
        receipt
      })
    }
    if (frame.params.tool === 'ready_resource_write_probe') {
      if (!current) {
        const denial = this._denial(frame)
        this.audit.push({
          kind: 'stale_write_denied',
          frame: frame.params,
          denial,
          effectIdentityCreated: false,
          effectCountAfter: this.effects.length
        })
        return this._result(denial)
      }
      const effect = {
        effectId: `effect-${frame.params.callId}`,
        value: args.value || null
      }
      this.effects.push(effect)
      this.audit.push({ kind: 'current_write', frame: frame.params, effect })
      return this._result({ ok: true, effect })
    }
    throw new Error(`Unexpected dynamic tool: ${frame.params.tool}`)
  }
}

function readJsonLines(filePath) {
  if (!fs.existsSync(filePath)) return []
  return fs
    .readFileSync(filePath, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line))
}

module.exports = {
  JsonLineClient,
  ResourceAuthorityHost,
  V1_BODY,
  V2_BODY,
  closeServer,
  collectNativeChildTurn,
  finalAgentText,
  flattenText,
  functionCallEvents,
  listen,
  messageEvents,
  readBody,
  readJsonLines,
  reconcileMcpReadBindings,
  requestSummary,
  sha256,
  spawnAppServer,
  sse,
  startTurn
}
