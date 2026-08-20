#!/usr/bin/env node
/**
 * Stage V — V5 IPC contract gate.
 *
 * Per
 * `docs/superpowers/plans/2026-05-21-V-stage-v-comprehensive-implementation.md §6`,
 * Ready exposes 3 distinct cross-process channel surfaces; each surface
 * has its own producer/consumer correspondence:
 *
 *   A. INVOKE_HANDLED == INVOKE_USED   (ipcMain.handle ↔ ipcRenderer.invoke)
 *   B. SEND_USED ⊆ SEND_RECEIVED       (ipcRenderer.send → ipcMain.on)
 *   C. PUSH_EMITTED ⊆ PUSH_LISTENED    (main push → ipcRenderer.on)
 *   D. METHODS_EXPOSED == METHODS_TYPED (preload exposeInMainWorld
 *       top-level keys ↔ Window['electronAPI'] type fields)
 *
 * PUSH_EMITTED callees we scan (AST CallExpression + PropertyAccess
 * walking, per §6 v5 revision):
 *   - `*.webContents.send` (e.g. webContents.send / win.webContents.send)
 *   - `*.sender.send` (e.g. event.sender.send / session.sender.send)
 *   - `*.sendToRenderer(` (e.g. controller.sendToRenderer /
 *     this.host.sendToRenderer)
 *
 * Non-literal first-arg push (e.g. forwarders like
 * `this.mainWindow.webContents.send(channel, data)` in
 * browser-engine/ipc-handler.ts:418-420, or spy wrappers like
 * content-study-runner.ts:181-182) is NOT silently skipped: it emits
 * NON_LITERAL_PUSH, which requires explicit registration in
 * `scripts/ipc-contract-allowlist.json` under `non_literal_push` with
 * `{ callsite, variable, channels[], reason, owner, expiry }`. Missing
 * or expired entry = gate fail (§6 v7 format).
 *
 * Top-level allowlist sections (all entries require owner + reason +
 * expiry YYYY-MM-DD; expired = gate fail):
 *   - invoke_only          : INVOKE_HANDLED w/o INVOKE_USED (handler
 *                            registered but no renderer caller — usually
 *                            transitional)
 *   - invoke_unhandled     : INVOKE_USED w/o INVOKE_HANDLED (renderer
 *                            calls a channel main does not handle — must
 *                            justify or fix)
 *   - send_unreceived      : SEND_USED w/o SEND_RECEIVED
 *   - push_unlistened      : PUSH_EMITTED w/o PUSH_LISTENED
 *   - non_literal_push     : runtime-variable channel emit sites
 *   - methods_exposed_only : keys exposed but not in Window types
 *   - methods_typed_only   : keys typed but not exposed
 *
 * Implementation uses the typescript compiler API directly (no
 * ts-morph dep), per §6 — same approach as
 * scripts/check-silent-catch.cjs.
 */

'use strict'

const fs = require('node:fs')
const path = require('node:path')

const ts = require('typescript')

const REPO_DEFAULT = path.resolve(__dirname, '..')
const MAIN_SCAN_ROOT = 'src/main'
const PRELOAD_FILE = 'src/preload/index.ts'
const RENDERER_TYPES_FILE = 'src/renderer/types/electron.d.ts'
const SOURCE_EXTS = new Set(['.ts', '.tsx'])
const ALLOWLIST_PATH = 'scripts/ipc-contract-allowlist.json'

main()

function main() {
  if (require.main !== module) return
  try {
    const result = checkIPCContract({ root: REPO_DEFAULT })
    if (result.fatal.length > 0) {
      console.error('ipc contract gate: fatal allowlist errors')
      for (const f of result.fatal) console.error(`- ${f}`)
      process.exit(1)
    }

    let hasFail = false
    for (const section of result.sections) {
      printSection(section)
      if (section.violations.length > 0) hasFail = true
    }
    printNonLiteralReport(result.nonLiteral)
    if (result.nonLiteral.violations.length > 0) hasFail = true

    if (hasFail) {
      console.error('\nipc contract gate: FAIL — see violations above')
      process.exit(1)
    }

    const counts = result.counts
    console.log(
      `ipc contract: ok — invoke=${counts.invokeHandled}/${counts.invokeUsed} `
        + `send=${counts.sendUsed}/${counts.sendReceived} `
        + `push=${counts.pushEmitted}/${counts.pushListened} `
        + `methods=${counts.methodsExposed}/${counts.methodsTyped} `
        + `allowlist=${counts.allowlistEntries} non_literal_push=${counts.nonLiteralAllowlist}`,
    )
  } catch (error) {
    console.error(error instanceof Error ? error.stack || error.message : String(error))
    process.exit(1)
  }
}

function checkIPCContract({ root }) {
  const repoRoot = path.resolve(root)
  const allowlist = loadAllowlist(repoRoot)
  const fatal = []
  validateAllowlist(allowlist, fatal)
  if (fatal.length > 0) {
    return { fatal, sections: [], nonLiteral: { violations: [], used: new Set() }, counts: emptyCounts() }
  }

  const mainScan = scanMainProcess(repoRoot)
  const preloadScan = scanPreload(repoRoot)
  const rendererScan = scanRendererTypes(repoRoot)

  const today = todayISO()
  const sections = []
  const usedAllowlistKeys = {
    invoke_only: new Set(),
    invoke_unhandled: new Set(),
    send_unreceived: new Set(),
    push_unlistened: new Set(),
    methods_exposed_only: new Set(),
    methods_typed_only: new Set(),
  }

  // A. INVOKE_HANDLED == INVOKE_USED
  sections.push(diffSetSection({
    label: 'A. INVOKE  (ipcMain.handle ↔ ipcRenderer.invoke)',
    leftLabel: 'handled',
    rightLabel: 'used',
    left: mainScan.invokeHandled,
    right: preloadScan.invokeUsed,
    requireEqual: true,
    allowlistLeftOnly: allowlist.invoke_only,
    allowlistRightOnly: allowlist.invoke_unhandled,
    usedLeftOnly: usedAllowlistKeys.invoke_only,
    usedRightOnly: usedAllowlistKeys.invoke_unhandled,
    today,
  }))

  // B. SEND_USED ⊆ SEND_RECEIVED  (right side is preload-used, left is main-listener)
  sections.push(diffSetSection({
    label: 'B. SEND·ON  (ipcRenderer.send → ipcMain.on)',
    leftLabel: 'received',
    rightLabel: 'used',
    left: mainScan.sendReceived,
    right: preloadScan.sendUsed,
    requireEqual: false, // only used ⊆ received is enforced
    allowlistLeftOnly: null, // received-without-used is allowed (warmup listeners ok)
    allowlistRightOnly: allowlist.send_unreceived,
    usedRightOnly: usedAllowlistKeys.send_unreceived,
    today,
  }))

  // C. PUSH_EMITTED ⊆ PUSH_LISTENED
  sections.push(diffSetSection({
    label: 'C. PUSH  (main *.webContents.send / *.sender.send / *.sendToRenderer → ipcRenderer.on)',
    leftLabel: 'listened',
    rightLabel: 'emitted',
    left: preloadScan.pushListened,
    right: mainScan.pushEmitted,
    requireEqual: false, // only emitted ⊆ listened is enforced
    allowlistLeftOnly: null,
    allowlistRightOnly: allowlist.push_unlistened,
    usedRightOnly: usedAllowlistKeys.push_unlistened,
    today,
  }))

  // D. METHODS_EXPOSED == METHODS_TYPED
  sections.push(diffSetSection({
    label: 'D. METHODS  (preload exposeInMainWorld ↔ Window["electronAPI"] type)',
    leftLabel: 'exposed',
    rightLabel: 'typed',
    left: preloadScan.methodsExposed,
    right: rendererScan.methodsTyped,
    requireEqual: true,
    allowlistLeftOnly: allowlist.methods_exposed_only,
    allowlistRightOnly: allowlist.methods_typed_only,
    usedLeftOnly: usedAllowlistKeys.methods_exposed_only,
    usedRightOnly: usedAllowlistKeys.methods_typed_only,
    today,
  }))

  // Non-literal push gate
  const nonLiteral = checkNonLiteralPush({
    sites: mainScan.nonLiteralPushSites,
    allowlist: allowlist.non_literal_push,
    today,
  })

  const counts = {
    invokeHandled: mainScan.invokeHandled.size,
    invokeUsed: preloadScan.invokeUsed.size,
    sendReceived: mainScan.sendReceived.size,
    sendUsed: preloadScan.sendUsed.size,
    pushEmitted: mainScan.pushEmitted.size,
    pushListened: preloadScan.pushListened.size,
    methodsExposed: preloadScan.methodsExposed.size,
    methodsTyped: rendererScan.methodsTyped.size,
    allowlistEntries:
      allowlist.invoke_only.length
      + allowlist.invoke_unhandled.length
      + allowlist.send_unreceived.length
      + allowlist.push_unlistened.length
      + allowlist.methods_exposed_only.length
      + allowlist.methods_typed_only.length,
    nonLiteralAllowlist: allowlist.non_literal_push.length,
  }

  // Unused allowlist entries surface as violations so the list stays
  // hygienic.
  const unusedViolations = []
  collectUnused(
    'invoke_only', allowlist.invoke_only, usedAllowlistKeys.invoke_only,
    unusedViolations,
  )
  collectUnused(
    'invoke_unhandled', allowlist.invoke_unhandled, usedAllowlistKeys.invoke_unhandled,
    unusedViolations,
  )
  collectUnused(
    'send_unreceived', allowlist.send_unreceived, usedAllowlistKeys.send_unreceived,
    unusedViolations,
  )
  collectUnused(
    'push_unlistened', allowlist.push_unlistened, usedAllowlistKeys.push_unlistened,
    unusedViolations,
  )
  collectUnused(
    'methods_exposed_only', allowlist.methods_exposed_only, usedAllowlistKeys.methods_exposed_only,
    unusedViolations,
  )
  collectUnused(
    'methods_typed_only', allowlist.methods_typed_only, usedAllowlistKeys.methods_typed_only,
    unusedViolations,
  )
  if (unusedViolations.length > 0) {
    sections.push({
      label: 'X. UNUSED ALLOWLIST ENTRIES',
      ok: false,
      summary: `${unusedViolations.length} stale allowlist channel(s) — remove or update`,
      details: [],
      violations: unusedViolations,
    })
  }
  // Non-literal push unused entries
  const unusedNonLiteral = []
  for (const entry of allowlist.non_literal_push) {
    const key = `${entry.callsite}::${entry.variable}`
    if (!nonLiteral.used.has(key)) {
      unusedNonLiteral.push(`non_literal_push ${key} — no matching call site found`)
    }
  }
  if (unusedNonLiteral.length > 0) {
    nonLiteral.violations.push(...unusedNonLiteral)
  }

  return { fatal: [], sections, nonLiteral, counts }
}

function emptyCounts() {
  return {
    invokeHandled: 0,
    invokeUsed: 0,
    sendReceived: 0,
    sendUsed: 0,
    pushEmitted: 0,
    pushListened: 0,
    methodsExposed: 0,
    methodsTyped: 0,
    allowlistEntries: 0,
    nonLiteralAllowlist: 0,
  }
}

function collectUnused(section, entries, used, out) {
  for (const entry of entries) {
    if (!used.has(entry.channel)) {
      out.push(`${section} '${entry.channel}' — no matching diff entry found (stale allowlist)`)
    }
  }
}

function diffSetSection({
  label,
  leftLabel,
  rightLabel,
  left,
  right,
  requireEqual,
  allowlistLeftOnly,
  allowlistRightOnly,
  usedLeftOnly,
  usedRightOnly,
  today,
}) {
  const leftOnly = setDiff(left, right)
  const rightOnly = setDiff(right, left)
  const violations = []
  const details = []

  if (requireEqual) {
    for (const ch of leftOnly) {
      const entry = findAllowlistEntry(allowlistLeftOnly || [], ch)
      if (!entry) {
        violations.push(`${leftLabel}-only '${ch}' — no ${rightLabel} counterpart and no allowlist entry`)
      } else if (isExpired(entry.expiry, today)) {
        violations.push(
          `${leftLabel}-only '${ch}' — allowlist entry expired ${entry.expiry} (owner=${entry.owner})`,
        )
      } else {
        if (usedLeftOnly) usedLeftOnly.add(ch)
        details.push(`${leftLabel}-only '${ch}' — allowlisted (owner=${entry.owner}, expiry=${entry.expiry})`)
      }
    }
  }

  for (const ch of rightOnly) {
    const entry = findAllowlistEntry(allowlistRightOnly || [], ch)
    if (!entry) {
      violations.push(`${rightLabel}-only '${ch}' — no ${leftLabel} counterpart and no allowlist entry`)
    } else if (isExpired(entry.expiry, today)) {
      violations.push(
        `${rightLabel}-only '${ch}' — allowlist entry expired ${entry.expiry} (owner=${entry.owner})`,
      )
    } else {
      if (usedRightOnly) usedRightOnly.add(ch)
      details.push(`${rightLabel}-only '${ch}' — allowlisted (owner=${entry.owner}, expiry=${entry.expiry})`)
    }
  }

  const summary =
    `${leftLabel}=${left.size} ${rightLabel}=${right.size} `
    + `${leftLabel}-only=${leftOnly.length} ${rightLabel}-only=${rightOnly.length} `
    + `violations=${violations.length}`

  return { label, ok: violations.length === 0, summary, details, violations }
}

function checkNonLiteralPush({ sites, allowlist, today }) {
  const violations = []
  const used = new Set()
  for (const site of sites) {
    const callsite = site.callsite
    const variable = site.variable || '<expr>'
    const entry = allowlist.find(e => e.callsite === callsite && e.variable === variable)
    if (!entry) {
      violations.push(
        `NON_LITERAL_PUSH ${callsite} variable='${variable}' (${site.calleeForm}) — no allowlist entry`,
      )
    } else if (isExpired(entry.expiry, today)) {
      violations.push(
        `NON_LITERAL_PUSH ${callsite} variable='${variable}' — allowlist expired ${entry.expiry}`,
      )
    } else {
      used.add(`${entry.callsite}::${entry.variable}`)
    }
  }
  return { violations, used }
}

function findAllowlistEntry(entries, channel) {
  return entries.find(e => e.channel === channel)
}

function setDiff(a, b) {
  const out = []
  for (const v of a) if (!b.has(v)) out.push(v)
  out.sort()
  return out
}

function isExpired(expiryISO, todayISO) {
  if (typeof expiryISO !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(expiryISO)) return true
  return expiryISO < todayISO
}

function todayISO() {
  const d = new Date()
  const y = d.getFullYear()
  const m = String(d.getMonth() + 1).padStart(2, '0')
  const day = String(d.getDate()).padStart(2, '0')
  return `${y}-${m}-${day}`
}

function loadAllowlist(repoRoot) {
  const file = path.join(repoRoot, ALLOWLIST_PATH)
  if (!fs.existsSync(file)) {
    return emptyAllowlist()
  }
  const raw = fs.readFileSync(file, 'utf8')
  let parsed
  try {
    parsed = JSON.parse(raw)
  } catch (error) {
    throw new Error(`${ALLOWLIST_PATH}: invalid JSON — ${error.message}`)
  }
  const empty = emptyAllowlist()
  for (const key of Object.keys(empty)) {
    if (parsed[key] !== undefined && !Array.isArray(parsed[key])) {
      throw new Error(`${ALLOWLIST_PATH}: '${key}' must be an array`)
    }
    if (Array.isArray(parsed[key])) empty[key] = parsed[key]
  }
  return empty
}

function emptyAllowlist() {
  return {
    invoke_only: [],
    invoke_unhandled: [],
    send_unreceived: [],
    push_unlistened: [],
    methods_exposed_only: [],
    methods_typed_only: [],
    non_literal_push: [],
  }
}

function validateAllowlist(allowlist, fatal) {
  for (const section of [
    'invoke_only',
    'invoke_unhandled',
    'send_unreceived',
    'push_unlistened',
    'methods_exposed_only',
    'methods_typed_only',
  ]) {
    for (const [idx, entry] of allowlist[section].entries()) {
      if (!entry || typeof entry !== 'object') {
        fatal.push(`${ALLOWLIST_PATH} ${section}[${idx}]: must be object`)
        continue
      }
      if (typeof entry.channel !== 'string' || entry.channel.length === 0) {
        fatal.push(`${ALLOWLIST_PATH} ${section}[${idx}]: missing 'channel' string`)
      }
      checkMetaFields(entry, `${section}[${idx}]`, fatal)
    }
  }
  for (const [idx, entry] of allowlist.non_literal_push.entries()) {
    if (!entry || typeof entry !== 'object') {
      fatal.push(`${ALLOWLIST_PATH} non_literal_push[${idx}]: must be object`)
      continue
    }
    if (typeof entry.callsite !== 'string' || !/^[^:]+:\d+$/.test(entry.callsite)) {
      fatal.push(`${ALLOWLIST_PATH} non_literal_push[${idx}]: 'callsite' must be 'file:line'`)
    }
    if (typeof entry.variable !== 'string' || entry.variable.length === 0) {
      fatal.push(`${ALLOWLIST_PATH} non_literal_push[${idx}]: missing 'variable' string`)
    }
    if (!Array.isArray(entry.channels) || entry.channels.length === 0) {
      fatal.push(`${ALLOWLIST_PATH} non_literal_push[${idx}]: 'channels' must be non-empty array`)
    }
    checkMetaFields(entry, `non_literal_push[${idx}]`, fatal)
  }
}

function checkMetaFields(entry, label, fatal) {
  if (typeof entry.reason !== 'string' || entry.reason.length < 4) {
    fatal.push(`${ALLOWLIST_PATH} ${label}: missing/short 'reason' string`)
  }
  if (typeof entry.owner !== 'string' || entry.owner.length === 0) {
    fatal.push(`${ALLOWLIST_PATH} ${label}: missing 'owner' string`)
  }
  if (typeof entry.expiry !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(entry.expiry)) {
    fatal.push(`${ALLOWLIST_PATH} ${label}: 'expiry' must be 'YYYY-MM-DD'`)
  }
}

function scanMainProcess(repoRoot) {
  const files = listTSFilesUnder(path.join(repoRoot, MAIN_SCAN_ROOT))
  const invokeHandled = new Set()
  const sendReceived = new Set()
  const pushEmitted = new Set()
  const nonLiteralPushSites = []
  for (const filePath of files) {
    const rel = relPath(repoRoot, filePath)
    const sf = readSourceFile(filePath)
    visitMainFile({
      relativeFile: rel,
      sourceFile: sf,
      invokeHandled,
      sendReceived,
      pushEmitted,
      nonLiteralPushSites,
    })
  }
  return { invokeHandled, sendReceived, pushEmitted, nonLiteralPushSites }
}

function visitMainFile({
  relativeFile,
  sourceFile,
  invokeHandled,
  sendReceived,
  pushEmitted,
  nonLiteralPushSites,
}) {
  const stringConstants = collectTopLevelStringConstants(sourceFile)
  function visit(node) {
    if (ts.isCallExpression(node)) {
      const calleePath = propertyPath(node.expression)
      const lastSegment = calleePath[calleePath.length - 1]
      const prevSegment = calleePath[calleePath.length - 2]

      // ipcMain.handle('channel', ...)
      if (calleePath.length >= 2 && prevSegment === 'ipcMain' && lastSegment === 'handle') {
        const ch = stringLiteralArg(node, 0, stringConstants)
        if (ch !== null) invokeHandled.add(ch)
      }
      // ipcMain.on('channel', ...)
      else if (calleePath.length >= 2 && prevSegment === 'ipcMain' && lastSegment === 'on') {
        const ch = stringLiteralArg(node, 0, stringConstants)
        if (ch !== null) sendReceived.add(ch)
      }
      // PUSH: *.sendToRenderer(...)
      else if (
        lastSegment === 'sendToRenderer'
        && ts.isPropertyAccessExpression(node.expression)
      ) {
        recordPush({
          node,
          sourceFile,
          relativeFile,
          calleeForm: 'sendToRenderer',
          pushEmitted,
          nonLiteralPushSites,
        })
      }
      // PUSH: *.webContents.send(...) or *.sender.send(...)
      else if (
        lastSegment === 'send'
        && (prevSegment === 'webContents' || prevSegment === 'sender')
        && ts.isPropertyAccessExpression(node.expression)
      ) {
        recordPush({
          node,
          sourceFile,
          relativeFile,
          calleeForm: `${prevSegment}.send`,
          pushEmitted,
          nonLiteralPushSites,
        })
      }
    }
    ts.forEachChild(node, visit)
  }
  visit(sourceFile)
}

function collectTopLevelStringConstants(sourceFile) {
  const constants = new Map()
  for (const statement of sourceFile.statements) {
    if (!ts.isVariableStatement(statement)) continue
    if ((statement.declarationList.flags & ts.NodeFlags.Const) === 0) continue
    for (const declaration of statement.declarationList.declarations) {
      if (!ts.isIdentifier(declaration.name) || !declaration.initializer) continue
      if (
        ts.isStringLiteral(declaration.initializer)
        || ts.isNoSubstitutionTemplateLiteral(declaration.initializer)
      ) constants.set(declaration.name.text, declaration.initializer.text)
    }
  }
  return constants
}

function recordPush({
  node,
  sourceFile,
  relativeFile,
  calleeForm,
  pushEmitted,
  nonLiteralPushSites,
}) {
  const arg = node.arguments[0]
  if (arg && ts.isStringLiteral(arg)) {
    pushEmitted.add(arg.text)
    return
  }
  const { line } = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile))
  let variable = '<expr>'
  if (arg && ts.isIdentifier(arg)) variable = arg.text
  else if (arg && ts.isPropertyAccessExpression(arg)) variable = propertyPath(arg).join('.')
  else if (arg && ts.isElementAccessExpression(arg)) variable = propertyPath(arg.expression).join('.') + '[…]'
  nonLiteralPushSites.push({
    callsite: `${relativeFile}:${line + 1}`,
    variable,
    calleeForm,
  })
}

function scanPreload(repoRoot) {
  const file = path.join(repoRoot, PRELOAD_FILE)
  const invokeUsed = new Set()
  const sendUsed = new Set()
  const pushListened = new Set()
  const methodsExposed = new Set()
  if (!fs.existsSync(file)) {
    return { invokeUsed, sendUsed, pushListened, methodsExposed }
  }
  const sf = readSourceFile(file)
  const invokeForwarders = collectIpcRendererInvokeForwarders(sf)

  function visit(node) {
    if (ts.isCallExpression(node)) {
      const calleePath = propertyPath(node.expression)
      const lastSegment = calleePath[calleePath.length - 1]
      const prevSegment = calleePath[calleePath.length - 2]
      if (calleePath.length >= 2 && prevSegment === 'ipcRenderer') {
        if (lastSegment === 'invoke') {
          const ch = stringLiteralArg(node, 0)
          if (ch !== null) invokeUsed.add(ch)
        } else if (lastSegment === 'send') {
          const ch = stringLiteralArg(node, 0)
          if (ch !== null) sendUsed.add(ch)
        } else if (lastSegment === 'on') {
          const ch = stringLiteralArg(node, 0)
          if (ch !== null) pushListened.add(ch)
        }
      } else if (ts.isIdentifier(node.expression) && invokeForwarders.has(node.expression.text)) {
        const ch = stringLiteralArg(node, 0)
        if (ch !== null) invokeUsed.add(ch)
      }
      // contextBridge.exposeInMainWorld('electronAPI', { ... })
      if (
        calleePath.length >= 2
        && prevSegment === 'contextBridge'
        && lastSegment === 'exposeInMainWorld'
      ) {
        const first = node.arguments[0]
        const second = node.arguments[1]
        if (
          first
          && ts.isStringLiteral(first)
          && first.text === 'electronAPI'
          && second
          && ts.isObjectLiteralExpression(second)
        ) {
          collectObjectKeys(second, methodsExposed)
        }
      }
    }
    ts.forEachChild(node, visit)
  }
  visit(sf)
  return { invokeUsed, sendUsed, pushListened, methodsExposed }
}

function collectIpcRendererInvokeForwarders(sourceFile) {
  const names = new Set()

  function forwardsInvoke(node, parameterName) {
    let found = false
    function visit(candidate) {
      if (found) return
      if (ts.isCallExpression(candidate)) {
        const calleePath = propertyPath(candidate.expression)
        const lastSegment = calleePath[calleePath.length - 1]
        const prevSegment = calleePath[calleePath.length - 2]
        const firstArg = candidate.arguments[0]
        if (
          prevSegment === 'ipcRenderer'
          && lastSegment === 'invoke'
          && firstArg
          && ts.isIdentifier(firstArg)
          && firstArg.text === parameterName
        ) {
          found = true
          return
        }
      }
      ts.forEachChild(candidate, visit)
    }
    visit(node)
    return found
  }

  for (const statement of sourceFile.statements) {
    if (
      ts.isFunctionDeclaration(statement)
      && statement.name
      && statement.body
      && statement.parameters[0]
      && ts.isIdentifier(statement.parameters[0].name)
      && forwardsInvoke(statement.body, statement.parameters[0].name.text)
    ) {
      names.add(statement.name.text)
      continue
    }
    if (!ts.isVariableStatement(statement)) continue
    for (const declaration of statement.declarationList.declarations) {
      if (!ts.isIdentifier(declaration.name) || !declaration.initializer) continue
      const initializer = declaration.initializer
      if (!ts.isArrowFunction(initializer) && !ts.isFunctionExpression(initializer)) continue
      const firstParameter = initializer.parameters[0]
      if (
        firstParameter
        && ts.isIdentifier(firstParameter.name)
        && forwardsInvoke(initializer.body, firstParameter.name.text)
      ) {
        names.add(declaration.name.text)
      }
    }
  }
  return names
}

function collectObjectKeys(objectLiteral, out) {
  for (const prop of objectLiteral.properties) {
    if (!prop.name) continue
    if (ts.isIdentifier(prop.name)) out.add(prop.name.text)
    else if (ts.isStringLiteral(prop.name)) out.add(prop.name.text)
  }
}

function scanRendererTypes(repoRoot) {
  const file = path.join(repoRoot, RENDERER_TYPES_FILE)
  const methodsTyped = new Set()
  if (!fs.existsSync(file)) return { methodsTyped }
  const sf = readSourceFile(file)

  // Find `interface ElectronAPI { ... }` and collect property names.
  function visit(node) {
    if (
      ts.isInterfaceDeclaration(node)
      && node.name
      && node.name.text === 'ElectronAPI'
    ) {
      for (const member of node.members) {
        if (ts.isPropertySignature(member) && member.name) {
          if (ts.isIdentifier(member.name)) methodsTyped.add(member.name.text)
          else if (ts.isStringLiteral(member.name)) methodsTyped.add(member.name.text)
        }
      }
    }
    ts.forEachChild(node, visit)
  }
  visit(sf)
  return { methodsTyped }
}

function propertyPath(expr) {
  // Returns ['a','b','c'] for a.b.c, ['ipcRenderer','invoke'] for
  // ipcRenderer.invoke, ['<this>','host','send'] for this.host.send,
  // ['<expr>','send'] for foo().send.
  if (ts.isIdentifier(expr)) return [expr.text]
  if (expr.kind === ts.SyntaxKind.ThisKeyword) return ['<this>']
  if (ts.isPropertyAccessExpression(expr)) {
    const parent = propertyPath(expr.expression)
    return [...parent, expr.name.text]
  }
  if (ts.isCallExpression(expr)) {
    return ['<call>']
  }
  if (ts.isParenthesizedExpression(expr)) {
    return propertyPath(expr.expression)
  }
  return ['<expr>']
}

function stringLiteralArg(callExpr, index, stringConstants = new Map()) {
  const arg = callExpr.arguments[index]
  if (arg && ts.isStringLiteral(arg)) return arg.text
  if (arg && ts.isNoSubstitutionTemplateLiteral(arg)) return arg.text
  if (arg && ts.isIdentifier(arg)) return stringConstants.get(arg.text) ?? null
  return null
}

function readSourceFile(filePath) {
  const sourceText = fs.readFileSync(filePath, 'utf8')
  return ts.createSourceFile(
    filePath,
    sourceText,
    ts.ScriptTarget.Latest,
    /*setParentNodes*/ true,
    filePath.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
  )
}

function listTSFilesUnder(dir) {
  const out = []
  if (!fs.existsSync(dir)) return out
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, entry.name)
    if (entry.isDirectory()) out.push(...listTSFilesUnder(p))
    else if (entry.isFile() && SOURCE_EXTS.has(path.extname(entry.name))) out.push(p)
  }
  return out
}

function relPath(root, abs) {
  return path.relative(root, abs).split(path.sep).join('/')
}

function printSection(section) {
  const mark = section.ok ? 'OK' : 'FAIL'
  console.log(`[${mark}] ${section.label} — ${section.summary}`)
  for (const d of section.details) console.log(`     · ${d}`)
  for (const v of section.violations) console.error(`     ✗ ${v}`)
}

function printNonLiteralReport(nonLiteral) {
  if (nonLiteral.violations.length === 0) {
    console.log(`[OK] NON_LITERAL_PUSH — ${nonLiteral.used.size} allowlisted site(s)`)
    return
  }
  console.log('[FAIL] NON_LITERAL_PUSH')
  for (const v of nonLiteral.violations) console.error(`     ✗ ${v}`)
}

module.exports = {
  checkIPCContract,
  scanMainProcess,
  scanPreload,
  scanRendererTypes,
}
