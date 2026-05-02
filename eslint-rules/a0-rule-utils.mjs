import { createHash } from 'node:crypto'

export const RULE_IDS = {
  sourceGrep: 'ready/no-source-grep-test',
  legacyBackdoor: 'ready/no-legacy-backdoor',
  migrationTodo: 'ready/no-migration-todo',
  subagentLeak: 'ready/no-subagent-leak',
}

export const A05_AREAS = {
  a1Gate: 'a1-gate',
  uiHistory: 'ui-history',
  otherA0: 'other-a0',
}

export const A05_AREA_VALUES = new Set(Object.values(A05_AREAS))

const CODE_FILE_EXT_RE = /\.(?:[cm]?[jt]sx?|mjs|cjs)['"`)]/
const READ_FILE_SYNC_RE = /\breadFileSync\s*\(/g
const SOURCE_NAMED_READ_RE = /\b(?:source|Source|executor|Executor|renderer|Renderer)\w*\s*=\s*readFileSync\s*\(/
const SOURCE_GREP_CONSUMER_RE = /\bassert\.(?:match|doesNotMatch)\s*\(|\.indexOf\s*\(|\.includes\s*\(/
const ALLOW_SOURCE_GREP_RE = /allow-source-grep:/
const ALLOW_SOURCE_GREP_WITH_REASON_RE = /allow-source-grep:\s*\S/
const MIGRATION_TODO_RE = /(?:todo\b.*\bmigration\b|\bmigration\b.*\btodo\b|remove after migration)/i
const LEGACY_BACKDOOR_RE = /\bif\s*\([^)]*\blegacy\b[^)]*\)|\blegacy\?\s*:|\blegacy\s*:\s*(?:boolean|true|false|\{|\[)/
const A1_GATE_KEYWORDS_RE = /(agent|skill|tool|driver|supervisor|child|task|run-state|run-coordinator|rss-(?!draft-store-ui|list-row-style)|browser-task|document-task|continuation|turn-engine|capability|memory|session-recall|sidecar|live-info|workflow|orchestrator|spawn|delivery|primitive|admission|sanitiz)/i

export function normalizeFilePath(filePath) {
  return String(filePath || '').replaceAll('\\', '/')
}

export function snippetHash(snippet) {
  return createHash('sha256')
    .update(String(snippet || '').replace(/\s+/g, ' ').trim())
    .digest('hex')
    .slice(0, 16)
}

export function findingKey(finding) {
  return `${finding.file}|${finding.rule}|${finding.snippetHash}`
}

export function classifyA05Area(entry) {
  const file = normalizeFilePath(entry?.file)
  if (entry?.rule !== RULE_IDS.sourceGrep) return A05_AREAS.otherA0
  if (file.endsWith('-ui-contract.test.ts') || file.endsWith('-style-contract.test.ts')) {
    return A05_AREAS.uiHistory
  }
  const testName = file.replace(/^src\/__tests__\//, '')
  if (file.startsWith('src/__tests__/') && A1_GATE_KEYWORDS_RE.test(testName)) {
    return A05_AREAS.a1Gate
  }
  return A05_AREAS.uiHistory
}

export function scanA0RuleViolations({ filePath, sourceText, honorReviewedDisables = true }) {
  const file = normalizeFilePath(filePath)
  const text = String(sourceText || '')
  return [
    ...scanNoSourceGrepTest(file, text, { honorReviewedDisables }),
    ...scanNoLegacyBackdoor(file, text),
    ...scanNoMigrationTodo(file, text),
  ]
}

export function scanRuleViolations({ filePath, sourceText, rule, honorReviewedDisables = true }) {
  return scanA0RuleViolations({ filePath, sourceText, honorReviewedDisables })
    .filter((finding) => finding.rule === rule)
}

function scanNoSourceGrepTest(file, sourceText, options) {
  if (!isTestFile(file)) return []

  const findings = []
  for (const lineInfo of iterateLines(sourceText)) {
    if (ALLOW_SOURCE_GREP_RE.test(lineInfo.text) && !ALLOW_SOURCE_GREP_WITH_REASON_RE.test(lineInfo.text)) {
      findings.push(makeFinding({
        file,
        rule: RULE_IDS.sourceGrep,
        lineInfo,
        sourceText,
        messageId: 'allowSourceGrepMissingReason',
        message: 'allow-source-grep comments must include a product reason.',
      }))
    }
  }

  if (!SOURCE_GREP_CONSUMER_RE.test(sourceText)) return findings

  for (const lineInfo of iterateLines(sourceText)) {
    if (!READ_FILE_SYNC_RE.test(lineInfo.text)) continue
    READ_FILE_SYNC_RE.lastIndex = 0
    if (options.honorReviewedDisables && hasReviewedDisableNextLine(lineInfo.previousText, RULE_IDS.sourceGrep)) continue
    if (ALLOW_SOURCE_GREP_RE.test(lineInfo.previousText || '')) continue
    if (hasAllowSourceGrepReason(lineInfo.previousText)) continue
    const lineAndRest = sourceText.slice(lineInfo.index, Math.min(sourceText.length, lineInfo.index + 300))
    if (!CODE_FILE_EXT_RE.test(lineAndRest) && !SOURCE_NAMED_READ_RE.test(lineInfo.text)) continue
    findings.push(makeFinding({
      file,
      rule: RULE_IDS.sourceGrep,
      lineInfo,
      sourceText,
      messageId: 'noSourceGrepTest',
      message: 'Do not assert source-code text with readFileSync; use a behavior test instead.',
    }))
  }
  return findings
}

function scanNoLegacyBackdoor(file, sourceText) {
  if (!isRuntimeSourceFile(file) || isTestFile(file)) return []

  const findings = []
  for (const lineInfo of iterateLines(sourceText)) {
    if (isCommentOnlyLine(lineInfo.text)) continue
    if (!LEGACY_BACKDOOR_RE.test(lineInfo.text)) continue
    findings.push(makeFinding({
      file,
      rule: RULE_IDS.legacyBackdoor,
      lineInfo,
      sourceText,
      messageId: 'noLegacyBackdoor',
      message: 'Do not add legacy conditionals or optional legacy switches without an explicit reviewed exemption.',
    }))
  }
  return findings
}

function scanNoMigrationTodo(file, sourceText) {
  if (!isRuntimeSourceFile(file) || isTestFile(file)) return []

  const findings = []
  for (const lineInfo of iterateLines(sourceText)) {
    if (!MIGRATION_TODO_RE.test(lineInfo.text)) continue
    findings.push(makeFinding({
      file,
      rule: RULE_IDS.migrationTodo,
      lineInfo,
      sourceText,
      messageId: 'noMigrationTodo',
      message: 'Do not add migration TODO placeholders; file a staged plan or remove the TODO.',
    }))
  }
  return findings
}

function makeFinding({ file, rule, lineInfo, sourceText, messageId, message }) {
  const snippet = lineInfo.text.trim()
  const contextStart = Math.max(0, lineInfo.index - 160)
  const contextEnd = Math.min(sourceText.length, lineInfo.index + lineInfo.text.length + 160)
  const hashSource = sourceText.slice(contextStart, contextEnd)
  return {
    file,
    rule,
    snippetHash: snippetHash(hashSource),
    line: lineInfo.line,
    column: lineInfo.column,
    snippet,
    messageId,
    message,
  }
}

function* iterateLines(sourceText) {
  let index = 0
  let line = 1
  let previousText = ''
  for (const text of sourceText.split(/\n/)) {
    const firstNonSpace = text.search(/\S/)
    yield {
      index,
      line,
      column: firstNonSpace >= 0 ? firstNonSpace + 1 : 1,
      text,
      previousText,
    }
    index += text.length + 1
    line += 1
    previousText = text
  }
}

function hasReviewedDisableNextLine(previousText, ruleId) {
  const escapedRule = ruleId.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const re = new RegExp(`eslint-disable-next-line\\s+${escapedRule}\\s+--\\s+\\S`)
  return re.test(previousText || '')
}

function hasAllowSourceGrepReason(previousText) {
  return ALLOW_SOURCE_GREP_WITH_REASON_RE.test(previousText || '')
}

function isCommentOnlyLine(line) {
  const trimmed = line.trim()
  return trimmed.startsWith('//') || trimmed.startsWith('*') || trimmed.startsWith('/*')
}

function isTestFile(file) {
  return /^src\/__tests__\/.*\.test\.[cm]?[jt]sx?$/.test(file)
}

function isRuntimeSourceFile(file) {
  return file.startsWith('src/main/modules/agent-control/')
    || file.startsWith('src/main/modules/skills-runtime/')
    || file.startsWith('src/main/modules/tools/')
    || file.startsWith('src/shared/')
}
