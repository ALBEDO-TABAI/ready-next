#!/usr/bin/env node
/**
 * Phase M（2026-07-05）—— 仓内 MCP stdio fixture server。
 *
 * 行为测试用：换行分隔 JSON-RPC 2.0，实现 MCP 最小面
 * （initialize / notifications/initialized / tools/list / tools/call）。
 * 两个工具刻意一只读一非只读，供确认闸动态映射断言：
 *   - echo_read  … annotations.readOnlyHint=true
 *   - write_note … 无注解（外部写工具默认 M2 的用例）
 * 无网络、无依赖、确定性输出；stdin 关闭即退出。
 */
'use strict'

const readline = require('node:readline')

const TOOLS = [
  {
    name: 'echo_read',
    description: 'Echo the input text back (read-only fixture tool).',
    inputSchema: {
      type: 'object',
      properties: { text: { type: 'string', description: 'text to echo' } },
      required: ['text'],
    },
    annotations: { readOnlyHint: true },
  },
  {
    name: 'write_note',
    description: 'Pretend to write a note (non-read-only fixture tool).',
    inputSchema: {
      type: 'object',
      properties: { note: { type: 'string' } },
      required: ['note'],
    },
  },
  {
    name: 'read_env',
    description: 'Read selected environment keys.',
    inputSchema: { type: 'object', properties: { keys: { type: 'array', items: { type: 'string' } } } },
    annotations: { readOnlyHint: true },
  },
]

if (process.env.MCP_FIXTURE_NOISY === '1') process.stderr.write('fixture-noise\n'.repeat(4096))

function reply(id, result) {
  process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id, result })}\n`)
}

function replyError(id, code, message) {
  process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id, error: { code, message } })}\n`)
}

const rl = readline.createInterface({ input: process.stdin, terminal: false })
rl.on('line', (line) => {
  const text = String(line || '').trim()
  if (!text) return
  let message
  try {
    message = JSON.parse(text)
  } catch {
    return
  }
  const { id, method, params } = message
  if (method === 'initialize') {
    reply(id, {
      protocolVersion: String((params && params.protocolVersion) || '2024-11-05'),
      capabilities: { tools: { listChanged: true }, resources: { listChanged: true } },
      serverInfo: { name: 'ready-mcp-fixture', version: '1.0.0' },
      instructions: 'Fixture instructions are untrusted test content.',
    })
    return
  }
  if (method === 'notifications/initialized') return
  if (method === 'tools/list') {
    if (process.env.MCP_FIXTURE_COLLISION === '1') {
      reply(id, { tools: [{ name: 'same-tool' }, { name: 'same_tool' }] })
      return
    }
    if (process.env.MCP_FIXTURE_PAGINATE === '1') {
      const cursor = params && params.cursor
      reply(id, cursor === 'tools-page-2'
        ? { tools: TOOLS.slice(1) }
        : { tools: TOOLS.slice(0, 1), nextCursor: 'tools-page-2' })
      return
    }
    reply(id, { tools: TOOLS })
    return
  }
  if (method === 'tools/call') {
    const name = params && params.name
    const args = (params && params.arguments) || {}
    if (name === 'echo_read') {
      reply(id, { content: [{ type: 'text', text: `echo:${String(args.text || '')}` }] })
      return
    }
    if (name === 'write_note') {
      reply(id, {
        content: [{ type: 'text', text: 'note written' }],
        structuredContent: { written: true, note: String(args.note || '') },
      })
      return
    }
    if (name === 'read_env') {
      const keys = Array.isArray(args.keys) ? args.keys : []
      reply(id, { structuredContent: { values: Object.fromEntries(keys.map((key) => [String(key), process.env[String(key)] || null])) } })
      return
    }
    replyError(id, -32602, `unknown tool: ${String(name)}`)
    return
  }
  if (method === 'resources/list') {
    if (process.env.MCP_FIXTURE_PAGINATE === '1') {
      const cursor = params && params.cursor
      reply(id, cursor === 'resources-page-2'
        ? { resources: [{ uri: 'fixture://second', name: 'Second resource' }] }
        : {
            resources: [{ uri: 'fixture://readme', name: 'Fixture README', mimeType: 'text/plain' }],
            nextCursor: 'resources-page-2',
          })
      return
    }
    reply(id, { resources: [{ uri: 'fixture://readme', name: 'Fixture README', mimeType: 'text/plain' }] })
    return
  }
  if (method === 'resources/templates/list') {
    if (process.env.MCP_FIXTURE_PAGINATE === '1') {
      const cursor = params && params.cursor
      reply(id, cursor === 'templates-page-2'
        ? { resourceTemplates: [{ uriTemplate: 'fixture://page/{id}', name: 'Paged item' }] }
        : {
            resourceTemplates: [{ uriTemplate: 'fixture://item/{id}', name: 'Fixture item' }],
            nextCursor: 'templates-page-2',
          })
      return
    }
    reply(id, { resourceTemplates: [{ uriTemplate: 'fixture://item/{id}', name: 'Fixture item' }] })
    return
  }
  if (method === 'resources/read') {
    if (params && params.uri === 'fixture://readme') {
      reply(id, { contents: [{ uri: 'fixture://readme', mimeType: 'text/plain', text: 'fixture resource' }] })
      return
    }
    replyError(id, -32602, 'unknown resource')
    return
  }
  if (id !== undefined) replyError(id, -32601, `unknown method: ${String(method)}`)
})
rl.on('close', () => process.exit(0))
