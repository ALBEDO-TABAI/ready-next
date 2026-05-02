#!/usr/bin/env node

const { existsSync, readFileSync } = require('node:fs')
const { resolve } = require('node:path')

function checkRendererErrorFriendliness(options = {}) {
  const root = resolve(options.root || resolve(__dirname, '..'))
  const errors = []
  const read = (file) => {
    const path = resolve(root, file)
    return existsSync(path) ? readFileSync(path, 'utf8') : ''
  }

  const useAgent = read('src/renderer/stores/useAgent.ts')
  const runtimeDriver = read('src/renderer/modules/agent/runtimeDriver.ts')
  const softFailure = read('src/renderer/components/agent/SoftFailureCapsule.tsx')

  if (!/mapBackendErrorToFriendly/.test(useAgent)) {
    errors.push('useAgent send failure path must use friendly error mapping')
  }
  if (/content:\s*`?\$\{result\.error\b/.test(useAgent) || /content:\s*result\.error\b/.test(useAgent)) {
    errors.push('useAgent must not write result.error directly into chat content')
  }
  if (/content:\s*`错误:\s*\$\{error instanceof Error/.test(useAgent)) {
    errors.push('useAgent catch path must not write raw Error.message into chat content')
  }
  if (!/mapBackendErrorToFriendly/.test(runtimeDriver)) {
    errors.push('runtimeDriver agent:error path must use friendly error mapping')
  }
  if (/content:\s*`Agent 错误:\s*\$\{data\.error/.test(runtimeDriver)) {
    errors.push('runtimeDriver must not write data.error directly into chat content')
  }
  if (!/mapBackendErrorToFriendly/.test(softFailure)) {
    errors.push('SoftFailureCapsule must map soft errors before rendering')
  }
  if (/<span[^>]*>\{softError\.message\}<\/span>/.test(softFailure)) {
    errors.push('SoftFailureCapsule must not render softError.message directly')
  }

  return { ok: errors.length === 0, errors }
}

function main() {
  const result = checkRendererErrorFriendliness()
  if (!result.ok) {
    console.error('renderer error friendliness check failed:')
    for (const error of result.errors) console.error(`- ${error}`)
    process.exit(1)
  }
  console.log('renderer error friendliness: ok')
}

if (require.main === module) main()

module.exports = { checkRendererErrorFriendliness }
