#!/usr/bin/env node
'use strict'

const fs = require('node:fs')
const path = require('node:path')

const ROOT = process.cwd()
const PRODUCTION_SCAN_ROOT = path.join(ROOT, 'src/main')
const EXECUTE_BROWSER_TOOL_ALLOWLIST = new Map([
  ['src/main/modules/tools/browser-tools.ts', 'definition'],
  ['src/main/modules/tools/index.ts', 'barrel-export'],
  ['src/main/modules/tools/tool-executor.ts', 'tool-executor-dispatch'],
  ['src/main/modules/tools/browser-agent-runner.ts', 'browser-agent-runner-dispatch'],
  ['src/main/modules/browser-engine/ipc-handler.ts', 'scoped-facade-injected-dispatcher'],
])

function read(relPath) {
  return fs.readFileSync(path.join(ROOT, relPath), 'utf8')
}

function fail(message) {
  console.error(`[check-browser-surface-binding] FAIL: ${message}`)
  process.exit(1)
}

const errors = read('src/main/modules/browser-engine/agent-browser-errors.ts')
if (!/export type AgentBrowserSurface\s*=\s*'user-view'\s*\|\s*'agent-view'\s*(?:\r?\n|$)/.test(errors)) {
  fail('AgentBrowserSurface must remain the two engine write-lease surfaces')
}
if (!errors.includes('browser_surface_undeclared') || !errors.includes('browser_surface_binding_violation')) {
  fail('surface binding structured error codes are missing')
}

const helper = read('src/main/modules/browser-engine/browser-surface-binding.ts')
for (const token of ['user-view-assisted', 'agent-view-background', 'read-only-observe', 'resolveBrowserToolSurfaceBinding']) {
  if (!helper.includes(token)) fail(`browser-surface-binding helper missing ${token}`)
}

const toolExecutor = read('src/main/modules/tools/tool-executor.ts')
if (!toolExecutor.includes("dispatch: 'tool-executor'")) {
  fail('tool-executor must declare its browser surface dispatch')
}
if (!toolExecutor.includes('resolveBrowserToolSurfaceBinding')) {
  fail('tool-executor must call resolveBrowserToolSurfaceBinding')
}

const runner = read('src/main/modules/tools/browser-agent-runner.ts')
if (!runner.includes("dispatch: 'browser-agent-runner'")) {
  fail('browser-agent-runner must declare its browser surface dispatch')
}

const facade = read('src/main/modules/browser-engine/scoped-browser-facade.ts')
if (!facade.includes("dispatch: 'scoped-facade'")) {
  fail('scoped-browser-facade must declare its browser surface dispatch')
}

function listTsFiles(dir) {
  if (!fs.existsSync(dir)) return []
  const out = []
  const walk = (current) => {
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const next = path.join(current, entry.name)
      if (entry.isDirectory()) {
        walk(next)
      } else if (entry.name.endsWith('.ts')) {
        out.push(next)
      }
    }
  }
  walk(dir)
  return out
}

function stripComments(source) {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split(/\r?\n/)
    .map((line) => line.replace(/\/\/.*$/, ''))
    .join('\n')
}

function hasExecuteBrowserToolEntry(source) {
  const stripped = stripComments(source)
  return /\bexecuteBrowserTool\b/.test(stripped)
}

function assertScopedFacadeDispatcher(source) {
  const callMatches = [...source.matchAll(/\bexecuteBrowserTool\s*\(/g)]
  if (callMatches.length !== 1) {
    fail('ipc-handler must have exactly one executeBrowserTool call, behind ScopedBrowserFacade')
  }
  const facadeIndex = source.indexOf('new ScopedBrowserFacade({')
  const executeIndex = source.indexOf('execute: async (toolName, args, gateSurface, gateLeaseId)')
  const importIndex = source.indexOf('const { executeBrowserTool } = await import(')
  const callIndex = callMatches[0].index ?? -1
  if (
    facadeIndex < 0 ||
    executeIndex < facadeIndex ||
    importIndex < executeIndex ||
    callIndex < importIndex
  ) {
    fail('ipc-handler executeBrowserTool call must stay inside the ScopedBrowserFacade execute callback')
  }
}

for (const file of listTsFiles(PRODUCTION_SCAN_ROOT)) {
  const source = fs.readFileSync(file, 'utf8')
  const strippedSource = stripComments(source)
  if (!hasExecuteBrowserToolEntry(strippedSource)) continue
  const relative = path.relative(ROOT, file).replace(/\\/g, '/')
  const reason = EXECUTE_BROWSER_TOOL_ALLOWLIST.get(relative)
  if (!reason) {
    fail(`executeBrowserTool production call/import is not in the surface-binding allowlist: ${relative}`)
  }
  if (reason === 'barrel-export' && /\bexecuteBrowserTool\s*\(/.test(strippedSource)) {
    fail('tools/index.ts may only re-export executeBrowserTool, not call it')
  }
  if (reason === 'tool-executor-dispatch' && !source.includes("dispatch: 'tool-executor'")) {
    fail('tool-executor executeBrowserTool path must declare dispatch')
  }
  if (reason === 'browser-agent-runner-dispatch' && !source.includes("dispatch: 'browser-agent-runner'")) {
    fail('browser-agent-runner executeBrowserTool path must declare dispatch')
  }
  if (reason === 'scoped-facade-injected-dispatcher') {
    assertScopedFacadeDispatcher(strippedSource)
  }
}

console.log('[check-browser-surface-binding] OK')
