// A scripted stand-in for the person's model, on loopback only, for the hidden browser-shell window check (W7 T7/T8).
// Ready's own model gateway talks to it exactly as to an OpenAI-compatible service (Chat Completions, real SSE), so a
// real Codex turn runs Ready's production browser tools; no real model, no network, no cost.
//
// A scenario is picked by a marker in the person's latest message. Its steps answer in order, one per model request
// of the turn: a step returns { tool, args } (one tool call) or { reply } (the final answer), and may wait (a hold)
// before answering, so a check can act while the run is still going.
const http = require('node:http')

const USAGE = { prompt_tokens: 12, completion_tokens: 4, total_tokens: 16 }

const contentText = content => (typeof content === 'string'
  ? content
  : Array.isArray(content) ? content.map(part => (part && typeof part.text === 'string' ? part.text : '')).join('') : '')

function sse(response, chunks) {
  response.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-store' })
  response.end(chunks.map(chunk => `data: ${JSON.stringify(chunk)}\n\n`).join('') + 'data: [DONE]\n\n')
}

/** The first string value under `key` anywhere in a parsed tool result. */
function findDeep(value, key) {
  if (!value || typeof value !== 'object') return undefined
  if (typeof value[key] === 'string' && value[key]) return value[key]
  for (const child of Object.values(value)) {
    const found = findDeep(child, key)
    if (found) return found
  }
  return undefined
}

function parseJson(text) {
  try { return JSON.parse(text) } catch { return null }
}

/**
 * @param {Array<{ name: string, match: RegExp, steps: Array<(turn: object) => object | Promise<object>> }>} scenarios
 */
function createStandInModel(scenarios) {
  const requests = []
  let sequence = 0
  const server = http.createServer(async (request, response) => {
    const chunks = []
    for await (const chunk of request) chunks.push(chunk)
    const body = parseJson(Buffer.concat(chunks).toString('utf8')) || {}
    const seq = ++sequence
    if (!String(request.url).endsWith('/chat/completions')) {
      response.writeHead(404, { 'content-type': 'application/json' })
      response.end('{}')
      return
    }
    const messages = Array.isArray(body.messages) ? body.messages : []
    const userIndex = messages.map(message => message.role).lastIndexOf('user')
    const user = userIndex >= 0 ? contentText(messages[userIndex].content) : ''
    const results = messages.slice(userIndex + 1).filter(message => message.role === 'tool').map(message => contentText(message.content))
    const names = (Array.isArray(body.tools) ? body.tools : []).map(tool => tool?.function?.name).filter(Boolean)
    const scenario = scenarios.find(candidate => candidate.match.test(user))
    const entry = { seq, scenario: scenario?.name ?? null, user, results, tools: names, decision: null }
    requests.push(entry)
    const toolName = name => names.find(candidate => candidate === name || candidate.endsWith(`__${name}`) || candidate.endsWith(`.${name}`)) || name
    let decision = { reply: '好的。' }
    try {
      const step = scenario?.steps[Math.min(results.length, scenario.steps.length - 1)]
      if (step) decision = await step({ user, results, parsed: results.map(parseJson), findDeep, names })
    } catch (error) {
      decision = { reply: `替身脚本出错：${error instanceof Error ? error.message : String(error)}` }
    }
    entry.decision = decision
    const id = `stand-in-${seq}`
    const model = body.model || 'stand-in-model'
    if (decision.tool) {
      sse(response, [
        { id, model, choices: [{ index: 0, delta: { role: 'assistant', tool_calls: [{ index: 0, id: `call-${seq}`, type: 'function', function: { name: toolName(decision.tool), arguments: JSON.stringify(decision.args || {}) } }] } }] },
        { id, model, choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }], usage: USAGE },
      ])
      return
    }
    sse(response, [
      { id, model, choices: [{ index: 0, delta: { role: 'assistant', content: decision.reply } }] },
      { id, model, choices: [{ index: 0, delta: {}, finish_reason: 'stop' }], usage: USAGE },
    ])
  })
  return {
    requests,
    async start() {
      await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
      return server.address().port
    },
    close: () => new Promise(resolve => server.close(() => resolve())),
  }
}

/** The AI settings of a profile that uses the stand-in (written through the same settings call as the 设置 page). */
function standInWorkspace(port) {
  return {
    version: 1,
    activeProfileId: 'custom-browser-shell-stand-in',
    profiles: [{
      id: 'custom-browser-shell-stand-in', category: 'custom', name: '本地替身', builtIn: false, showInChatSwitcher: true,
      config: {
        provider: 'openai-compatible', baseUrl: `http://127.0.0.1:${port}/v1`, apiKey: 'local-stand-in-key', model: 'stand-in-model',
        agentProtocol: 'openai', wireApi: 'chat/completions', toolUseMode: 'on', contextWindowOverride: 128000, displayName: '本地替身',
      },
    }],
  }
}

module.exports = { createStandInModel, standInWorkspace, findDeep }
