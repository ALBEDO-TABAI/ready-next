#!/usr/bin/env node
const fs = require('fs')
const path = require('path')

const root = process.env.BROWSER_TOOL_SCAN_ROOT || process.cwd()
const toolsDir = path.join(root, 'src/main/modules/tools')

function listBrowserActSources(dir = toolsDir) {
  if (!fs.existsSync(dir)) return []
  return fs.readdirSync(dir)
    .filter((name) => name.startsWith('browser-act-') && name.endsWith('.ts'))
    .sort()
    .map((name) => ({ name, source: fs.readFileSync(path.join(dir, name), 'utf8') }))
}

const browserToolsPath = path.join(toolsDir, 'browser-tools.ts')
const browserInvocationPath = path.join(toolsDir, 'browser-tool-invocation.ts')
const browserPowerToolsPath = path.join(toolsDir, 'browser-power-tools.ts')
const browserCollectionToolsPath = path.join(toolsDir, 'browser-collection-tools.ts')
const browserObserveToolsPath = path.join(toolsDir, 'browser-observe-tools.ts')
const registryPath = path.join(toolsDir, 'browser-readonly-script-templates.ts')
const browserActSources = listBrowserActSources()

let failed = false
function fail(message) {
  console.error(`[check-browser-script-no-freeform-passthrough] FAIL — ${message}`)
  failed = true
}

if (!fs.existsSync(registryPath)) {
  fail('missing browser-readonly-script-templates.ts registry.')
} else {
  const registry = fs.readFileSync(registryPath, 'utf8')
  for (const name of ['read_text', 'read_attr', 'read_all_text', 'count_selector', 'exists_selector', 'read_rect', 'read_meta']) {
    if (!registry.includes(name)) fail(`registry missing template ${name}.`)
  }
  if (!registry.includes('export function compileBrowserReadonlyScriptTemplate')) {
    fail('readonly script templates must export compileBrowserReadonlyScriptTemplate.')
  }
}

const source = fs.existsSync(browserToolsPath) ? fs.readFileSync(browserToolsPath, 'utf8') : ''
const invocationSource = fs.existsSync(browserInvocationPath) ? fs.readFileSync(browserInvocationPath, 'utf8') : ''
const powerSource = fs.existsSync(browserPowerToolsPath) ? fs.readFileSync(browserPowerToolsPath, 'utf8') : ''
const collectionSource = fs.existsSync(browserCollectionToolsPath) ? fs.readFileSync(browserCollectionToolsPath, 'utf8') : ''
const observeSource = fs.existsSync(browserObserveToolsPath) ? fs.readFileSync(browserObserveToolsPath, 'utf8') : ''

if (!source.includes('resolveBrowserToolInvocation(toolName, args')) {
  fail('browser-tools.ts must resolve tools through resolveBrowserToolInvocation.')
}
if (!source.includes('executeBrowserActTool(')) {
  fail('browser-tools.ts must dispatch act tools through executeBrowserActTool.')
}
if (!invocationSource.includes('custom_script: _customScript')) {
  fail('resolveBrowserToolInvocation must strip custom_script from model args.')
}

const forbidden = [
  [/customJs:\s*typeof args\.custom_js\s*===\s*'string'\s*\?\s*args\.custom_js/, 'browser_wait_for_condition directly forwards args.custom_js'],
  [/customScript:\s*typeof args\.custom_script\s*===\s*'string'\s*\?\s*args\.custom_script/, 'browser_extract_structured/browser_scroll_collect directly forwards args.custom_script'],
  [/const code = args\.code as string/, 'browser_execute_js directly reads args.code'],
  [/if \(action === 'execute_js'\)[\s\S]{0,260}?String\(step\.code \|\| ''\)/, 'workflow execute_js directly reads step.code'],
  [/payload,\s*\n\s*\}\)/, 'browser_start_task forwards payload without script verdict sanitization'],
]

const namedSources = [
  { name: 'browser-tools.ts', source },
  { name: 'browser-power-tools.ts', source: powerSource },
  { name: 'browser-collection-tools.ts', source: collectionSource },
  { name: 'browser-observe-tools.ts', source: observeSource },
  ...browserActSources,
]

for (const [pattern, message] of forbidden) {
  for (const file of namedSources) {
    if (pattern.test(file.source)) fail(`${message} (${file.name})`)
  }
}

function main() {
  if (failed) process.exit(1)
  console.log('[check-browser-script-no-freeform-passthrough] OK')
}

if (require.main === module) {
  main()
}

module.exports = { listBrowserActSources }
