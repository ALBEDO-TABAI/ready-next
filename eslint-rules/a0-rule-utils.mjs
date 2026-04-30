import { createHash } from 'node:crypto'

export const RULE_IDS = {
  sourceGrep: 'ready/no-source-grep-test',
  legacyBackdoor: 'ready/no-legacy-backdoor',
  migrationTodo: 'ready/no-migration-todo',
}

const CODE_FILE_EXT_RE = /\.(?:[cm]?[jt]sx?|mjs|cjs)['"`)]/
const READ_FILE_SYNC_RE = /\breadFileSync\s*\(/g
const SOURCE_NAMED_READ_RE = /\b(?:source|Source|executor|Executor|renderer|Renderer)\w*\s*=\s*readFileSync\s*\(/
const SOURCE_GREP_CONSUMER_RE = /\bassert\.(?:match|doesNotMatch)\s*\(|\.indexOf\s*\(|\.includes\s*\(/
const MIGRATION_TODO_RE = /(?:todo\b.*\bmigration\b|\bmigration\b.*\btodo\b|remove after migration)/i
const LEGACY_BACKDOOR_RE = /\bif\s*\([^)]*\blegacy\b[^)]*\)|\blegacy\?\s*:|\blegacy\s*:\s*(?:boolean|true|false|\{|\[)/

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

export function scanA0RuleViolations({ filePath, sourceText }) {
  const file = normalizeFilePath(filePath)
  const text = String(sourceText || '')
  return [
    ...scanNoSourceGrepTest(file, text),
    ...scanNoLegacyBackdoor(file, text),
    ...scanNoMigrationTodo(file, text),
  ]
}

export function scanRuleViolations({ filePath, sourceText, rule }) {
  return scanA0RuleViolations({ filePath, sourceText })
    .filter((finding) => finding.rule === rule)
}

function scanNoSourceGrepTest(file, sourceText) {
  if (!isTestFile(file)) return []
  if (!SOURCE_GREP_CONSUMER_RE.test(sourceText)) return []

  const findings = []
  for (const lineInfo of iterateLines(sourceText)) {
    if (!READ_FILE_SYNC_RE.test(lineInfo.text)) continue
    READ_FILE_SYNC_RE.lastIndex = 0
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
  for (const text of sourceText.split(/\n/)) {
    const firstNonSpace = text.search(/\S/)
    yield {
      index,
      line,
      column: firstNonSpace >= 0 ? firstNonSpace + 1 : 1,
      text,
    }
    index += text.length + 1
    line += 1
  }
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
