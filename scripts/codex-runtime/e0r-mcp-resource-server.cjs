const crypto = require('node:crypto')
const fs = require('node:fs')
const readline = require('node:readline')

const authorityPath = process.env.E0R_RESOURCE_AUTHORITY_FILE
const auditPath = process.env.E0R_MCP_AUDIT_FILE

if (!authorityPath || !auditPath) {
  process.stderr.write('E0R_RESOURCE_AUTHORITY_FILE and E0R_MCP_AUDIT_FILE are required\n')
  process.exit(2)
}

function sha256(value) {
  return crypto.createHash('sha256').update(value).digest('hex')
}

function readAuthority() {
  return JSON.parse(fs.readFileSync(authorityPath, 'utf8'))
}

function appendAudit(event) {
  fs.appendFileSync(
    auditPath,
    `${JSON.stringify({ at: new Date().toISOString(), ...event })}\n`
  )
}

function send(id, result) {
  process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id, result })}\n`)
}

function textResult(value, isError = false) {
  return {
    content: [{ type: 'text', text: JSON.stringify(value) }],
    isError
  }
}

function turnMetadata(message) {
  return message.params?._meta?.['x-codex-turn-metadata'] || {}
}

function handleRead(message) {
  const authority = readAuthority()
  const args = message.params?.arguments || {}
  const metadata = turnMetadata(message)
  const requested = {
    logicalResourceId: args.logicalResourceId || null,
    version: args.version || null,
    requestNonce: args.requestNonce || null
  }
  if (
    requested.logicalResourceId !== authority.logicalResourceId ||
    requested.version !== authority.currentVersion
  ) {
    const denial = {
      ok: false,
      error: 'resource_version_superseded',
      logicalResourceId: requested.logicalResourceId,
      requestedVersion: requested.version,
      currentVersion: authority.currentVersion,
      bodyBytes: 0,
      receipt: null
    }
    appendAudit({ kind: 'stale_read_denied', metadata, requested, denial })
    return textResult(denial)
  }

  const provisionalReceipt = {
    receiptId: `mcp-provisional-${message.id}-${sha256(JSON.stringify(metadata)).slice(0, 12)}`,
    transport: 'mcp_provisional',
    mcpRequestId: String(message.id),
    threadId: metadata.thread_id || null,
    turnId: metadata.turn_id || null,
    callId: null,
    requestNonce: requested.requestNonce,
    logicalResourceId: authority.logicalResourceId,
    version: authority.currentVersion,
    digest: authority.currentDigest,
    policyEpoch: authority.policyEpoch,
    resultDigest: sha256(authority.body)
  }
  const result = {
    ok: true,
    body: authority.body,
    bodyBytes: Buffer.byteLength(authority.body),
    provisionalReceipt
  }
  appendAudit({ kind: 'current_read', metadata, requested, provisionalReceipt })
  return textResult(result)
}

const tools = [
  {
    name: 'read_current_resource',
    description: 'Read a Ready resource only when the requested version is currently authorized.',
    inputSchema: {
      type: 'object',
      properties: {
        logicalResourceId: { type: 'string' },
        version: { type: 'string' },
        requestNonce: { type: 'string' }
      },
      required: ['logicalResourceId', 'version', 'requestNonce'],
      additionalProperties: false
    },
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false
    }
  }
]

const lines = readline.createInterface({ input: process.stdin })
lines.on('line', (line) => {
  let message
  try {
    message = JSON.parse(line)
  } catch (error) {
    appendAudit({ kind: 'invalid_json', error: String(error) })
    return
  }

  if (message.method === 'initialize') {
    appendAudit({ kind: 'initialize', protocolVersion: message.params?.protocolVersion || null })
    send(message.id, {
      protocolVersion: message.params?.protocolVersion || '2025-03-26',
      capabilities: { tools: {} },
      serverInfo: { name: 'ready-e0r-resource-authority', version: '1.0.0' }
    })
    return
  }
  if (message.method === 'notifications/initialized') {
    appendAudit({ kind: 'initialized' })
    return
  }
  if (message.method === 'tools/list') {
    appendAudit({ kind: 'tools_list' })
    send(message.id, { tools })
    return
  }
  if (message.method === 'tools/call') {
    if (message.params?.name === 'read_current_resource') {
      send(message.id, handleRead(message))
    } else {
      send(
        message.id,
        textResult({ ok: false, error: 'tool_not_registered', bodyBytes: 0 }, true)
      )
    }
    return
  }
  if (message.id !== undefined) {
    send(message.id, {})
  }
})
