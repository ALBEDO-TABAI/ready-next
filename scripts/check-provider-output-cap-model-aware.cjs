#!/usr/bin/env node

const fs = require('node:fs')
const path = require('node:path')

const root = path.resolve(__dirname, '..')
const read = (file) => fs.readFileSync(path.join(root, file), 'utf8')
const provider = read('src/main/modules/agent-control/runtime-core/agent-sdk-provider.ts')
const runner = read('src/main/modules/agent-control/runtime-core/agent-sdk-provider-runner.ts')
const bridge = read('src/main/modules/claude-bridge/anthropic-execution-client.ts')
const shared = read('src/shared/ai-providers.ts')
const violations = []

if (/max_tokens:\s*request\.modelSettings\.maxTokens\s*\|\|\s*4096/.test(provider))
  violations.push('SDK provider still hard-caps Anthropic at 4096')
if (!/export function resolveMaxOutputTokens/.test(shared))
  violations.push('shared model capability layer lacks resolveMaxOutputTokens')
if (!/resolveMaxOutputTokens/.test(provider))
  violations.push('SDK provider does not use shared output-cap resolver')
if (!/modelSettings:\s*\{\s*maxTokens:\s*params\.maxOutputTokens\s*\}/.test(runner)) {
  violations.push('native OpenAI Agent does not receive the resolved output cap')
}
if (!/resolveMaxOutputTokens/.test(bridge) || /max_tokens:\s*4096/.test(bridge))
  violations.push('Claude bridge still owns a separate 4096 cap')
for (const name of [
  'shapeAnthropicModelResponse',
  'shapeChatCompletionsModelResponse',
  'shapeResponsesModelResponse'
]) {
  const start = provider.indexOf(`function ${name}`)
  const next = provider.indexOf('\nfunction ', start + 10)
  const body = provider.slice(start, next < 0 ? provider.length : next)
  if (!/logProviderOutputTruncated/.test(body))
    violations.push(`${name} lacks truncation metric wiring`)
}

if (violations.length > 0) {
  console.error(violations.map((item) => `- ${item}`).join('\n'))
  process.exit(1)
}
console.log('provider output cap contract: OK')
