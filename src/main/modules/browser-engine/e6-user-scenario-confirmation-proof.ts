import { digestCanonicalJson } from '../agent-control/codex-runtime/codex-model-gateway-contract'
import { decodeXmlEntities } from '../agent-control/safety/lark-cli-command-policy'
import { tokenizeLarkCliCommand } from '../skills-runtime/lark-cli-argv'
import plan from '../../../../assets/codex-runtime/contracts/e6-user-scenario-plan.json'

export type E6UserScenarioConfirmationStage = 'sheet_insert' | 'sheet_write' | 'docx_write'

export type E6UserScenarioConfirmationExpectation = Readonly<{
  stage: E6UserScenarioConfirmationStage
  sheetUrl: string
  docxUrl: string
  sheetSentinel: string
  docxTaskMarker: string
}>

export type E6UserScenarioConfirmationProof = Readonly<{
  schemaVersion: 1
  stage: E6UserScenarioConfirmationStage
  paramsCanonicalSha256: string
  commandArgsDigest: string
  targetReferenceDigest: string
  sheetSelector: Readonly<{ key: string; value: string }> | null
  sheetSelectorDigest: string | null
  position: string | null
  range: string | null
  revisionId: string | null
  patternDigest: string | null
  patternLength: number | null
  visibleContentDigest: string | null
  visibleContentLength: number | null
}>

type ParsedOptions = Readonly<{
  values: ReadonlyMap<string, string[]>
  flags: ReadonlySet<string>
}>

function expectedPolishedSentence(pattern: string): string | null {
  let output = pattern
  for (const [before, after] of plan.polishReplacements) {
    if (output.split(before).length !== 2) return null
    output = output.replace(before, after)
  }
  return output
}

function parseStrictOptions(
  tokens: readonly string[],
  allowedValues: ReadonlySet<string>,
  allowedFlags: ReadonlySet<string>,
): ParsedOptions | null {
  const values = new Map<string, string[]>()
  const flags = new Set<string>()
  for (let index = 3; index < tokens.length; index += 1) {
    const token = tokens[index] || ''
    const equalIndex = token.indexOf('=')
    const name = equalIndex > 0 ? token.slice(0, equalIndex) : token
    if (allowedFlags.has(name)) {
      if (equalIndex > 0 || flags.has(name)) return null
      flags.add(name)
      continue
    }
    if (!allowedValues.has(name)) return null
    const value = equalIndex > 0 ? token.slice(equalIndex + 1) : tokens[++index]
    if (typeof value !== 'string' || value.length === 0 || value.startsWith('--')) return null
    const existing = values.get(name) || []
    existing.push(value)
    values.set(name, existing)
  }
  return { values, flags }
}

function exactlyOne(options: ParsedOptions, name: string): string | null {
  const values = options.values.get(name) || []
  return values.length === 1 ? values[0] || null : null
}

function exactSheetSelector(options: ParsedOptions): { key: string; value: string } | null {
  const sheetId = exactlyOne(options, '--sheet-id')
  const sheetName = exactlyOne(options, '--sheet-name')
  if (Boolean(sheetId) === Boolean(sheetName)) return null
  return sheetId ? { key: 'sheet_id', value: sheetId } : { key: 'title', value: sheetName || '' }
}

function baseProof(
  stage: E6UserScenarioConfirmationStage,
  params: Record<string, unknown>,
  targetReferenceDigest: string,
  commandArgs: readonly string[],
): E6UserScenarioConfirmationProof {
  return {
    schemaVersion: 1,
    stage,
    paramsCanonicalSha256: digestCanonicalJson(params),
    commandArgsDigest: digestCanonicalJson(commandArgs),
    targetReferenceDigest,
    sheetSelector: null,
    sheetSelectorDigest: null,
    position: null,
    range: null,
    revisionId: null,
    patternDigest: null,
    patternLength: null,
    visibleContentDigest: null,
    visibleContentLength: null,
  }
}

export function inspectE6UserScenarioFrozenCall(
  toolName: string,
  params: Record<string, unknown>,
  expectation: E6UserScenarioConfirmationExpectation,
): E6UserScenarioConfirmationProof | null {
  if (toolName !== 'skill_run_shell' || typeof params.command !== 'string'
    || (params.stdin !== undefined && params.stdin !== '')) return null
  const tokens = tokenizeLarkCliCommand(params.command)
  if (!tokens || tokens[0] !== 'lark-cli') return null

  if (expectation.stage === 'sheet_insert') {
    if (tokens[1] !== 'sheets' || tokens[2] !== '+dim-insert') return null
    const options = parseStrictOptions(tokens, new Set([
      '--url', '--sheet-id', '--sheet-name', '--as', '--position', '--count',
      '--inherit-style',
    ]), new Set(['--json']))
    if (!options || exactlyOne(options, '--url') !== expectation.sheetUrl
      || exactlyOne(options, '--as') !== 'user') return null
    const selector = exactSheetSelector(options)
    const position = exactlyOne(options, '--position')
    if (!selector || !position || !/^[A-Z]{1,3}$/.test(position)
      || exactlyOne(options, '--count') !== '1'
      || exactlyOne(options, '--inherit-style') !== plan.sheetAppendPolicy.inheritStyle) return null
    return {
      ...baseProof('sheet_insert', params, digestCanonicalJson(expectation.sheetUrl), tokens.slice(1)),
      sheetSelector: selector,
      sheetSelectorDigest: digestCanonicalJson(selector),
      position,
    }
  }

  if (expectation.stage === 'sheet_write') {
    if (tokens[1] !== 'sheets' || tokens[2] !== '+cells-set') return null
    const options = parseStrictOptions(tokens, new Set([
      '--url', '--sheet-id', '--sheet-name', '--as', '--range', '--cells',
      '--allow-overwrite',
    ]), new Set(['--json']))
    if (!options || exactlyOne(options, '--url') !== expectation.sheetUrl
      || exactlyOne(options, '--as') !== 'user'
      || exactlyOne(options, '--allow-overwrite') !== 'false') return null
    const selector = exactSheetSelector(options)
    const range = exactlyOne(options, '--range')
    const cells = exactlyOne(options, '--cells')
    if (!selector || !range || !cells) return null
    let parsedCells: unknown
    try { parsedCells = JSON.parse(cells) } catch { return null }
    if (digestCanonicalJson(parsedCells) !== digestCanonicalJson([[
      { value: expectation.sheetSentinel },
    ]])) return null
    return {
      ...baseProof('sheet_write', params, digestCanonicalJson(expectation.sheetUrl), tokens.slice(1)),
      sheetSelector: selector,
      sheetSelectorDigest: digestCanonicalJson(selector),
      range,
    }
  }

  if (tokens[1] !== 'docs' || tokens[2] !== '+update') return null
  const options = parseStrictOptions(tokens, new Set([
    '--doc', '--as', '--command', '--revision-id', '--pattern', '--content', '--doc-format',
  ]), new Set(['--json']))
  if (!options || exactlyOne(options, '--doc') !== expectation.docxUrl
    || exactlyOne(options, '--as') !== 'user'
    || exactlyOne(options, '--command') !== 'str_replace') return null
  const formats = options.values.get('--doc-format') || []
  if (formats.length > 1 || (formats.length === 1 && formats[0] !== 'xml')) return null
  const revisionId = exactlyOne(options, '--revision-id')
  const pattern = exactlyOne(options, '--pattern')
  const content = exactlyOne(options, '--content')
  const paragraph = content ? /^<p>([^<>]*)<\/p>$/.exec(content.trim()) : null
  const rawVisibleContent = paragraph?.[1]?.trim() || ''
  const visibleContent = decodeXmlEntities(rawVisibleContent)
  const expectedContent = pattern ? expectedPolishedSentence(pattern.trim()) : null
  if (!revisionId || !/^\d+$/.test(revisionId) || !pattern || !visibleContent
    || pattern.trim().length < 12 || visibleContent.length < 12
    || !expectedContent || visibleContent !== expectedContent || rawVisibleContent !== visibleContent
    || !/\p{Script=Han}/u.test(pattern) || !/\p{Script=Han}/u.test(visibleContent)
    || /[<>]/.test(pattern) || /https?:\/\//i.test(pattern)
    || /https?:\/\//i.test(visibleContent)
    || pattern.includes(expectation.docxTaskMarker)
    || visibleContent.includes(expectation.docxTaskMarker)) return null
  return {
    ...baseProof('docx_write', params, digestCanonicalJson(expectation.docxUrl), tokens.slice(1)),
    revisionId,
    patternDigest: digestCanonicalJson(pattern),
    patternLength: pattern.length,
    visibleContentDigest: digestCanonicalJson(visibleContent),
    visibleContentLength: visibleContent.length,
  }
}
