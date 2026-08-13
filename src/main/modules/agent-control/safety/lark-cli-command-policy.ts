import { tokenizeLarkCliCommand } from '../../skills-runtime/lark-cli-argv'

export type LarkCliCommandClass = 'not_lark_cli' | 'read_only' | 'external_write' | 'local_management' | 'unsupported_domain'

export const DELEGABLE_LARK_CLI_VERSION = 'lark-cli version 1.0.76'

const READ_ONLY_SHORTCUTS: Readonly<Record<string, ReadonlySet<string>>> = {
  calendar: new Set([
    '+agenda', '+freebusy', '+get', '+meeting', '+search-event',
  ]),
  drive: new Set([
    '+inspect', '+list-comments', '+search', '+secure-label-list', '+status', '+task_result',
    '+version-history',
  ]),
  docs: new Set([
    '+fetch', '+history-list', '+history-revert-status', '+search',
  ]),
  sheets: new Set([
    '+cells-get', '+cells-search', '+changeset-get', '+chart-list', '+cond-format-list',
    '+csv-get', '+dropdown-get', '+filter-list', '+filter-view-list', '+float-image-list',
    '+formula-verify', '+history-list', '+history-revert-status', '+pivot-list', '+revision-get',
    '+sheet-info', '+sparkline-list', '+table-get', '+workbook-info',
  ]),
}

const READ_ONLY_METHODS = new Set([
  'batch_query', 'find', 'get', 'list', 'search', 'status', 'subscription_status',
])

const LOCAL_INPUT_SHORTCUTS: Readonly<Record<string, ReadonlySet<string>>> = {
  drive: new Set(['+import', '+push', '+status', '+sync', '+upload']),
  docs: new Set(['+media-insert', '+media-upload', '+resource-update']),
  sheets: new Set(['+cells-set-image', '+workbook-import']),
}

const LOCAL_INPUT_PATH_FLAGS = new Set([
  '--file', '--file-path', '--image', '--image-path', '--input-file', '--local-file',
])

const DELEGABLE_ONLINE_WRITE_SHORTCUTS: Readonly<Record<string, ReadonlySet<string>>> = {
  drive: new Set(['+create-folder', '+move']),
  docs: new Set(['+create', '+update']),
  sheets: new Set(['+cells-set', '+dim-insert']),
}

const DELEGABLE_DRIVE_FILE_TYPES = new Set([
  'bitable', 'doc', 'docx', 'file', 'mindnote', 'sheet', 'slides',
])

const DOCUMENT_CONTENT_VALUE_FLAGS = new Set([
  '--cells', '--content', '--pattern', '--query', '--reference-map', '--values',
])

const OUTBOUND_CONTENT_VALUE_FLAGS = new Set([
  ...DOCUMENT_CONTENT_VALUE_FLAGS,
  '--comment', '--description', '--name', '--summary', '--text', '--title',
])

const MINIMAL_LARK_CLI_SCOPES = new Set([
  'calendar:calendar.event:read',
  'calendar:calendar.free_busy:read',
  'calendar:calendar:read',
  'docs:document.comment:create',
  'docs:document.comment:delete',
  'docs:document.comment:read',
  'docs:document.comment:update',
  'docs:document.comment:write_only',
  'docs:document.content:read',
  'docs:document.media:download',
  'docs:document.media:upload',
  'docs:document:copy',
  'docs:document:export',
  'docs:document:import',
  'docx:document:create',
  'docx:document:readonly',
  'docx:document:write_only',
  'drive:drive.metadata:readonly',
  'drive:file:download',
  'drive:file:upload',
  'drive:file:view_record:readonly',
  'search:docs:read',
  'sheets:spreadsheet:create',
  'sheets:spreadsheet.meta:read',
  'sheets:spreadsheet.meta:write_only',
  'sheets:spreadsheet:read',
  'sheets:spreadsheet:write_only',
  'space:document:create',
  'space:document:delete',
  'space:document:move',
  'space:document:retrieve',
  'space:document:shortcut',
])

const LARK_CLI_SKILL_ROOTS = new Set([
  'lark-shared', 'lark-drive', 'lark-doc', 'lark-sheets', 'lark-calendar',
])

const BOOLEAN_LEADING_FLAGS = new Set([
  '--dry-run', '--help', '--json', '--no-wait', '--page-all', '--recommend', '--verify', '--version', '--yes',
  '-h', '-v',
])

function findPrimaryIndex(tokens: readonly string[]): number {
  let index = 1
  while (index < tokens.length && tokens[index]?.startsWith('-')) {
    const flag = tokens[index] || ''
    if (flag.includes('=') || BOOLEAN_LEADING_FLAGS.has(flag)) index += 1
    else index += tokens[index + 1]?.startsWith('-') ? 1 : 2
  }
  return index
}

function findDomainActionIndex(tokens: readonly string[], primaryIndex: number): number {
  let index = primaryIndex + 1
  while (index < tokens.length && tokens[index]?.startsWith('-')) {
    const flag = tokens[index] || ''
    if (flag.includes('=') || BOOLEAN_LEADING_FLAGS.has(flag)) index += 1
    else index += tokens[index + 1]?.startsWith('-') ? 1 : 2
  }
  return index
}

function isStandaloneFlagAt(tokens: readonly string[], index: number): boolean {
  const previous = tokens[index - 1]
  return !previous || !previous.startsWith('-') || BOOLEAN_LEADING_FLAGS.has(previous) || previous.includes('=')
}

function hasStandaloneFlag(tokens: readonly string[], flag: string): boolean {
  return tokens.some((token, index) => token === flag && isStandaloneFlagAt(tokens, index))
}

function hasExactSingleBooleanFlag(tokens: readonly string[], flag: string): boolean {
  let exactCount = 0
  for (const token of tokens) {
    if (token === flag) exactCount += 1
    else if (token.startsWith(`${flag}=`)) return false
  }
  return exactCount === 1
}

function scalarOptionValues(tokens: readonly string[], flag: string): string[] {
  const values: string[] = []
  tokens.forEach((token, index) => {
    if (DOCUMENT_CONTENT_VALUE_FLAGS.has(tokens[index - 1] || '')) return
    if (token.startsWith(`${flag}=`)) values.push(token.slice(flag.length + 1))
    else if (token === flag && tokens[index + 1] && !tokens[index + 1]?.startsWith('-')) {
      values.push(tokens[index + 1] || '')
    }
  })
  return values
}

function exactOptionValues(tokens: readonly string[], flag: string): string[] {
  const values: string[] = []
  tokens.forEach((token, index) => {
    if (token.startsWith(`${flag}=`)) values.push(token.slice(flag.length + 1))
    else if (token === flag && tokens[index + 1] !== undefined) values.push(tokens[index + 1] || '')
  })
  return values
}

function spreadsheetColumnIndex(value: string): number | null {
  if (!/^[A-Z]{1,4}$/.test(value)) return null
  let total = 0
  for (const character of value) total = total * 26 + character.charCodeAt(0) - 64
  return total
}

function spreadsheetRangeDimensions(value: string): { columns: number; rows: number; cells: number } | null {
  const coordinates = value.slice(value.lastIndexOf('!') + 1)
  const match = coordinates.match(/^\$?([A-Z]{1,4})\$?(\d+)(?::\$?([A-Z]{1,4})\$?(\d+))?$/)
  if (!match) return null
  const startColumn = spreadsheetColumnIndex(match[1] || '')
  const endColumn = spreadsheetColumnIndex(match[3] || match[1] || '')
  const startRow = Number(match[2])
  const endRow = Number(match[4] || match[2])
  if (!startColumn || !endColumn || !Number.isSafeInteger(startRow)
    || !Number.isSafeInteger(endRow) || startRow < 1 || endRow < startRow
    || endColumn < startColumn) return null
  const columns = endColumn - startColumn + 1
  const rows = endRow - startRow + 1
  return { columns, rows, cells: columns * rows }
}

function inlineSheetCellDimensions(value: string): { columns: number; rows: number; cells: number } | null {
  try {
    const parsed = JSON.parse(value)
    if (!Array.isArray(parsed) || parsed.length === 0) return null
    let columns: number | null = null
    for (const row of parsed) {
      if (!Array.isArray(row) || row.length === 0) return null
      if (columns === null) columns = row.length
      if (row.length !== columns || row.some((cell) => {
        if (!cell || typeof cell !== 'object' || Array.isArray(cell)) return true
        const record = cell as Record<string, unknown>
        if (Object.keys(record).some((key) => key !== 'value')) return true
        const literal = record.value
        if (typeof literal === 'string' && literal.trimStart().startsWith('=')) return true
        return literal !== null
          && typeof literal !== 'string'
          && typeof literal !== 'number'
          && typeof literal !== 'boolean'
      })) return null
    }
    const rows = parsed.length
    return { columns: columns || 0, rows, cells: rows * (columns || 0) }
  } catch {
    return null
  }
}

export function decodeXmlEntities(value: string): string {
  return value
    .replace(/&#x([0-9a-f]+);/gi, (_match, hex: string) => {
      const codePoint = Number.parseInt(hex, 16)
      return Number.isSafeInteger(codePoint) && codePoint <= 0x10ffff
        ? String.fromCodePoint(codePoint)
        : _match
    })
    .replace(/&#(\d+);/g, (_match, decimal: string) => {
      const codePoint = Number.parseInt(decimal, 10)
      return Number.isSafeInteger(codePoint) && codePoint <= 0x10ffff
        ? String.fromCodePoint(codePoint)
        : _match
    })
    .replace(/&(?:amp|lt|gt|quot|apos);/g, (entity) => ({
      '&amp;': '&',
      '&lt;': '<',
      '&gt;': '>',
      '&quot;': '"',
      '&apos;': "'",
    })[entity] || entity)
}

function collectJsonStringValues(value: string): string[] {
  try {
    const strings: string[] = []
    const visit = (item: unknown): void => {
      if (typeof item === 'string') {
        strings.push(item)
        return
      }
      if (Array.isArray(item)) {
        item.forEach(visit)
        return
      }
      if (item && typeof item === 'object') Object.values(item).forEach(visit)
    }
    visit(JSON.parse(value))
    return strings
  } catch {
    return []
  }
}

function isSmallDelegableCellsSet(tokens: readonly string[]): boolean {
  const ranges = exactOptionValues(tokens, '--range')
  const cells = exactOptionValues(tokens, '--cells')
  const allowOverwriteTokens = tokens.filter((token) => (
    token === '--allow-overwrite' || token.startsWith('--allow-overwrite=')
  ))
  if (ranges.length !== 1 || cells.length !== 1
    || allowOverwriteTokens.length !== 1 || allowOverwriteTokens[0] !== '--allow-overwrite=false'
    || exactOptionValues(tokens, '--copy-to-range').length > 0) return false
  const rangeDimensions = spreadsheetRangeDimensions(ranges[0] || '')
  const cellDimensions = inlineSheetCellDimensions(cells[0] || '')
  return rangeDimensions !== null && cellDimensions !== null
    && rangeDimensions.cells <= 20 && cellDimensions.cells <= 20
    && rangeDimensions.rows === cellDimensions.rows
    && rangeDimensions.columns === cellDimensions.columns
}

function isSmallDelegableDimensionInsert(tokens: readonly string[]): boolean {
  const counts = exactOptionValues(tokens, '--count')
  if (counts.length === 0) return true
  return counts.length === 1 && /^[1-5]$/.test(counts[0] || '')
}

function isSingleDelegableDriveFileMove(tokens: readonly string[]): boolean {
  const fileTokens = exactOptionValues(tokens, '--file-token')
  const folderTokens = exactOptionValues(tokens, '--folder-token')
  const types = exactOptionValues(tokens, '--type')
  return fileTokens.length === 1 && fileTokens[0]?.length > 0
    && folderTokens.length === 1 && folderTokens[0]?.length > 0
    && types.length === 1 && DELEGABLE_DRIVE_FILE_TYPES.has(types[0] || '')
}

function hasLocalInputFlag(tokens: readonly string[], flag: string): boolean {
  return tokens.some((token, index) => (
    !DOCUMENT_CONTENT_VALUE_FLAGS.has(tokens[index - 1] || '')
    && (token === flag || token.startsWith(`${flag}=`))
  ))
}

function hasForbiddenLocalInput(tokens: readonly string[]): boolean {
  return tokens.some((token, index) => {
    if (token.startsWith('@') && token !== '@-') return true
    if (/<whiteboard\b[^>]*\bpath\s*=\s*["']@[^"']+["']/i.test(token)) return true
    if (DOCUMENT_CONTENT_VALUE_FLAGS.has(tokens[index - 1] || '')) return false
    const flag = token.split('=', 1)[0] || ''
    return LOCAL_INPUT_PATH_FLAGS.has(flag)
  })
}

function authLoginHasExactShape(authTokens: readonly string[], phase: 'initiate' | 'complete'): boolean {
  if (authTokens[0] !== 'login') return false
  let jsonCount = 0
  let noWaitCount = 0
  let scopeCount = 0
  let deviceCodeCount = 0
  for (let index = 1; index < authTokens.length; index += 1) {
    const token = authTokens[index] || ''
    if (token === '--json') {
      jsonCount += 1
      continue
    }
    if (phase === 'initiate' && token === '--no-wait') {
      noWaitCount += 1
      continue
    }
    if (phase === 'initiate' && (token === '--scope' || token.startsWith('--scope='))) {
      scopeCount += 1
      if (token === '--scope') index += 1
      continue
    }
    if (phase === 'complete' && (token === '--device-code' || token.startsWith('--device-code='))) {
      deviceCodeCount += 1
      if (token === '--device-code') index += 1
      continue
    }
    return false
  }
  return jsonCount === 1 && (phase === 'initiate'
    ? noWaitCount === 1 && scopeCount === 1 && deviceCodeCount === 0
    : deviceCodeCount === 1 && noWaitCount === 0 && scopeCount === 0)
}

function isAllowedLarkCliSkillPath(
  value: string,
  action: 'list' | 'read',
): boolean {
  if (!value || value.includes('\\')) return false
  const segments = value.split('/')
  const skillRoot = segments.shift() || ''
  if (!LARK_CLI_SKILL_ROOTS.has(skillRoot)) return false
  if (segments.length === 0) return true
  return segments[0] === 'references'
    && segments.every((segment) => Boolean(segment) && segment !== '.' && segment !== '..')
    && (action === 'list' || (segments.length > 1 && (segments.at(-1) || '').endsWith('.md')))
}

function isAllowedLarkCliSkillInspection(
  tokens: readonly string[],
  primaryIndex: number,
  action: 'list' | 'read',
): boolean {
  const args = tokens.slice(primaryIndex + 2)
  const positional: string[] = []
  for (const token of args) {
    if (token === '--json' || token === '--help' || token === '-h') continue
    if (token.startsWith('-')) return false
    positional.push(token)
  }
  if (positional.length === 0) return action === 'list'
  if (positional.length > 2) return false
  const target = positional[0] || ''
  if (positional.length === 2) {
    if (action !== 'read' || target.includes('/')) return false
    return LARK_CLI_SKILL_ROOTS.has(target)
      && isAllowedLarkCliSkillPath(`${target}/${positional[1] || ''}`, action)
  }
  return isAllowedLarkCliSkillPath(target, action)
}

export function isAnyLarkCliAuthCommand(command: unknown): boolean {
  if (typeof command !== 'string') return false
  const tokens = tokenizeLarkCliCommand(command)
  return Boolean(tokens && tokens[0] === 'lark-cli' && tokens[findPrimaryIndex(tokens)] === 'auth')
}

export function shouldPersistLarkCliOverflowArtifacts(command: unknown): boolean {
  return !isAnyLarkCliAuthCommand(command)
}

export function isLarkCliBusinessCommand(command: unknown): boolean {
  if (typeof command !== 'string') return false
  const tokens = tokenizeLarkCliCommand(command)
  if (!tokens || tokens[0] !== 'lark-cli') return false
  return ['calendar', 'drive', 'docs', 'sheets'].includes(tokens[findPrimaryIndex(tokens)] || '')
}

export function isDelegableLarkCliOnlineWrite(
  command: unknown,
  stdin: unknown = undefined,
  executableVersion: unknown = undefined,
): boolean {
  if (executableVersion !== DELEGABLE_LARK_CLI_VERSION) return false
  if (typeof command !== 'string' || classifyLarkCliCommand(command) !== 'external_write') return false
  const tokens = tokenizeLarkCliCommand(command)
  if (!tokens || tokens[0] !== 'lark-cli') return false
  const primaryIndex = findPrimaryIndex(tokens)
  const primary = tokens[primaryIndex] || ''
  const actionIndex = findDomainActionIndex(tokens, primaryIndex)
  const shortcut = tokens[actionIndex] || ''
  const stdinText = typeof stdin === 'string' ? stdin : ''
  if (exactOptionValues(tokens, '--reference-map').length > 0) return false
  if (primary === 'docs' && shortcut === '+update') {
    // `str_replace` is a whole-document search/replace in lark-cli 1.0.76.
    // Without a frozen read revision and exact-one-match proof, even a short
    // pattern can change multiple blocks, so document updates stay M2.
    return false
  }
  if (primary === 'docs' && shortcut === '+create') {
    const titles = exactOptionValues(tokens, '--title')
    const contents = exactOptionValues(tokens, '--content')
    const documentFormats = exactOptionValues(tokens, '--doc-format')
    const title = titles[0] || ''
    const content = contents[0] === '-' ? stdinText : contents[0] || ''
    if (titles.length > 1
      || (titles.length === 1 && title.length === 0)
      || contents.length !== 1
      || documentFormats.length > 0
      || content.length === 0) return false
    // Automatic delegation is intentionally plain-text only. Lark Doc XML
    // can fetch remote images and create active/resource blocks, so any tag,
    // URL, or explicit format requires the normal per-call confirmation.
    if ([title, content].some((value) => {
      const decoded = decodeXmlEntities(value)
      return /[<>]/.test(decoded) || /\bhttps?:\/\//i.test(decoded)
    })) return false
  }
  if (primary === 'sheets' && shortcut === '+cells-set' && !isSmallDelegableCellsSet(tokens)) return false
  if (primary === 'sheets' && shortcut === '+dim-insert'
    && !isSmallDelegableDimensionInsert(tokens)) return false
  if (primary === 'drive' && shortcut === '+move'
    && !isSingleDelegableDriveFileMove(tokens)) return false
  const outboundValues = [...OUTBOUND_CONTENT_VALUE_FLAGS]
    .flatMap((flag) => exactOptionValues(tokens, flag))
  if (stdinText.length > 0 && !exactOptionValues(tokens, '--content').includes('-')) return false
  if (outboundValues.some((value) => value.length > 4_000)
    || stdinText.length > 4_000
    || outboundValues.reduce((total, value) => total + value.length, stdinText.length) > 8_000) return false
  return Boolean(DELEGABLE_ONLINE_WRITE_SHORTCUTS[primary]?.has(shortcut))
    && !tokens.some((token) => (
      token === '--yes'
      || token === '--overwrite'
      || token.startsWith('--overwrite=')
      || token === '--output'
      || token.startsWith('--output=')
      || token === '--output-path'
      || token.startsWith('--output-path=')
      || token === '--output-dir'
      || token.startsWith('--output-dir=')
      || token === '--local-dir'
      || token.startsWith('--local-dir=')
      || token === '-o'
      || (token.startsWith('-o') && token.length > 2)
    ))
}

export function larkCliOutboundContentValues(command: unknown): string[] {
  if (typeof command !== 'string') return []
  const tokens = tokenizeLarkCliCommand(command)
  if (!tokens || tokens[0] !== 'lark-cli') return []
  const values: string[] = []
  for (const flag of OUTBOUND_CONTENT_VALUE_FLAGS) {
    for (const value of exactOptionValues(tokens, flag)) {
      values.push(value, decodeXmlEntities(value))
      const displayText = decodeXmlEntities(value).replace(/<[^>]*>/g, '')
      if (displayText !== value) values.push(displayText)
      if (flag === '--cells' || flag === '--reference-map') {
        values.push(...collectJsonStringValues(value).map(decodeXmlEntities))
      }
    }
  }
  const primaryIndex = findPrimaryIndex(tokens)
  const actionIndex = findDomainActionIndex(tokens, primaryIndex)
  if (tokens[primaryIndex] === 'docs' && tokens[actionIndex] === '+create') {
    const titles = exactOptionValues(tokens, '--title')
    const contents = exactOptionValues(tokens, '--content')
    if (titles.length === 1 && contents.length === 1) {
      const displayedContent = decodeXmlEntities(contents[0] || '').replace(/<[^>]*>/g, '')
      values.push(`${titles[0] || ''}${displayedContent}`, `${titles[0] || ''}\n${displayedContent}`)
    }
  }
  return [...values, values.join(''), values.join('\n')]
}

export function isLarkCliEvidenceCommand(command: unknown): boolean {
  if (!isLarkCliBusinessCommand(command) || typeof command !== 'string') return false
  const tokens = tokenizeLarkCliCommand(command)
  if (!tokens) return false
  return !tokens.some((token) => (
    token === '--jq'
    || token.startsWith('--jq=')
    || token === '-q'
    || (token.startsWith('-q') && token.length > 2)
    || token === '--format'
    || token.startsWith('--format=')
    || token === '--output'
    || token.startsWith('--output=')
    || token === '--output-path'
    || token.startsWith('--output-path=')
    || token === '--output-dir'
    || token.startsWith('--output-dir=')
    || token === '-o'
    || (token.startsWith('-o') && token.length > 2)
  ))
}

export function inspectLarkCliAuthCommand(command: unknown):
  | { phase: 'initiate'; scope: string }
  | { phase: 'complete'; deviceCode: string }
  | { phase: 'blocking' }
  | null {
  if (typeof command !== 'string') return null
  const tokens = tokenizeLarkCliCommand(command)
  if (!tokens || tokens[0] !== 'lark-cli') return null
  const primaryIndex = findPrimaryIndex(tokens)
  if (tokens[primaryIndex] !== 'auth') return null
  const authTokens = tokens.slice(primaryIndex + 1)
  if (!authTokens.includes('login')) return null
  const deviceCodes = scalarOptionValues(authTokens, '--device-code')
  if (deviceCodes.length > 0 && !authLoginHasExactShape(authTokens, 'complete')) return { phase: 'blocking' }
  const deviceCode = deviceCodes[0]
  if (deviceCode) return { phase: 'complete', deviceCode }
  if (authTokens.includes('--no-wait') && authLoginHasExactShape(authTokens, 'initiate')) {
    const scopes = scalarOptionValues(authTokens, '--scope')
      .flatMap((value) => value.split(/[\s,]+/))
      .filter(Boolean)
    return scopes.length === 1 ? { phase: 'initiate', scope: scopes[0] || '' } : { phase: 'blocking' }
  }
  return { phase: 'blocking' }
}

export function inspectLarkCliAuthQrcodeCommand(command: unknown):
  | { verificationUrl: string | null; exactAsciiShape: boolean }
  | null {
  if (typeof command !== 'string') return null
  const tokens = tokenizeLarkCliCommand(command)
  if (!tokens || tokens[0] !== 'lark-cli') return null
  const primaryIndex = findPrimaryIndex(tokens)
  if (tokens[primaryIndex] !== 'auth') return null
  const authTokens = tokens.slice(primaryIndex + 1)
  const qrcodeIndex = authTokens.indexOf('qrcode')
  if (qrcodeIndex < 0) return null
  const qrcodeArgs = authTokens.slice(qrcodeIndex + 1)
  const verificationUrl = qrcodeArgs[0] && !qrcodeArgs[0].startsWith('-') ? qrcodeArgs[0] : null
  return {
    verificationUrl,
    exactAsciiShape: qrcodeArgs.length === 2 && Boolean(verificationUrl) && qrcodeArgs[1] === '--ascii',
  }
}

export function isMinimalLarkCliScope(scope: string): boolean {
  return MINIMAL_LARK_CLI_SCOPES.has(scope)
}

export function classifyLarkCliCommand(command: unknown): LarkCliCommandClass {
  if (typeof command !== 'string') return 'not_lark_cli'
  const tokens = tokenizeLarkCliCommand(command)
  if (!tokens || tokens[0] !== 'lark-cli') {
    return /^\s*lark-cli(?:\s|$)/.test(command) ? 'external_write' : 'not_lark_cli'
  }
  if (scalarOptionValues(tokens, '--profile').length > 0) {
    return 'local_management'
  }
  if (hasLocalInputFlag(tokens, '--from-clipboard')) return 'unsupported_domain'
  const primaryIndex = findPrimaryIndex(tokens)
  const primary = tokens[primaryIndex]
  if (!primary || primary === '--help' || primary === '-h' || primary === '--version' || primary === '-v' || primary === 'help') {
    return 'read_only'
  }
  if (primary === 'profile' || primary === 'config' || primary === 'update') return 'local_management'
  if (primary === 'auth') {
    const authTokens = tokens.slice(primaryIndex + 1)
    const action = authTokens.find((token) => ['login', 'logout', 'qrcode', 'status'].includes(token))
    if (action === 'status') return 'read_only'
    if (action === 'qrcode') {
      return inspectLarkCliAuthQrcodeCommand(command)?.exactAsciiShape
        ? 'read_only'
        : 'external_write'
    }
    if (action === 'login') {
      const authCommand = inspectLarkCliAuthCommand(command)
      if (authCommand?.phase === 'initiate') {
        return isMinimalLarkCliScope(authCommand.scope) ? 'read_only' : 'unsupported_domain'
      }
      return authCommand?.phase === 'complete' ? 'external_write' : 'unsupported_domain'
    }
    return 'local_management'
  }
  if (primary === 'skills') {
    const action = tokens[primaryIndex + 1]
    if (action !== 'list' && action !== 'read') return 'local_management'
    return isAllowedLarkCliSkillInspection(tokens, primaryIndex, action)
      ? 'read_only'
      : 'unsupported_domain'
  }
  if (primary === 'whoami' || primary === 'doctor') return 'read_only'
  if (primary === 'schema') {
    const schemaTarget = tokens[primaryIndex + 1] || ''
    return /^(?:calendar|docs?|docx|drive|sheets?)[.]/i.test(schemaTarget) ? 'read_only' : 'unsupported_domain'
  }
  if (!['calendar', 'drive', 'docs', 'sheets'].includes(primary)) return 'unsupported_domain'
  if (
    (hasStandaloneFlag(tokens, '--help') && hasExactSingleBooleanFlag(tokens, '--help'))
    || (hasStandaloneFlag(tokens, '-h') && hasExactSingleBooleanFlag(tokens, '-h'))
  ) return 'read_only'
  const identities = scalarOptionValues(tokens, '--as')
  const actionIndex = findDomainActionIndex(tokens, primaryIndex)
  const shortcut = tokens[actionIndex]
  if (primary === 'calendar') {
    if (identities.length > 1 || (identities[0] && identities[0].toLowerCase() !== 'user')) {
      return 'unsupported_domain'
    }
    if (hasForbiddenLocalInput(tokens)) return 'unsupported_domain'
    if (shortcut && READ_ONLY_SHORTCUTS.calendar?.has(shortcut)) return 'read_only'
    const method = tokens[actionIndex + 1]
    return method && READ_ONLY_METHODS.has(method) ? 'read_only' : 'unsupported_domain'
  }
  if (identities.length !== 1 || identities[0]?.toLowerCase() !== 'user') return 'unsupported_domain'
  if (shortcut && LOCAL_INPUT_SHORTCUTS[primary]?.has(shortcut)) return 'unsupported_domain'
  if (hasForbiddenLocalInput(tokens)) return 'unsupported_domain'
  if (tokens.includes('--yes')) return 'external_write'
  if (hasStandaloneFlag(tokens, '--dry-run') && hasExactSingleBooleanFlag(tokens, '--dry-run')) return 'read_only'
  if (tokens.some((token) => token === '--overwrite' || token.startsWith('--overwrite='))) return 'external_write'
  if (shortcut && READ_ONLY_SHORTCUTS[primary]?.has(shortcut)) return 'read_only'
  const method = tokens[actionIndex + 1]
  if (method && READ_ONLY_METHODS.has(method)) return 'read_only'
  return 'external_write'
}
