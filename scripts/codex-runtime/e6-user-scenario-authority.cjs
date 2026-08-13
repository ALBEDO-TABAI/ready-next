'use strict'

const { execFileSync } = require('node:child_process')
const { resolve } = require('node:path')

const { digestJson, repoRoot } = require('./contract-lib.cjs')
const plan = require('../../assets/codex-runtime/contracts/e6-user-scenario-plan.json')

const SUPPORTED_VERSION = plan.supportedCliVersion
const EXPECTED_SHEET_URL = plan.sheetUrl
const EXPECTED_DOCX_URL = plan.docxUrl
const EXPECTED_DOCX_TITLE = plan.docxTitle
const SHEET_APPEND_POLICY = Object.freeze({ ...plan.sheetAppendPolicy })
const TRUSTED_RUNTIME_PATH = '/usr/bin:/bin:/usr/sbin:/sbin:/opt/homebrew/bin:/usr/local/bin'

function sheetSentinelForProofId(proofId) {
  return `E6-READY-${proofId.slice(0, 16)}`
}

function docxTaskMarkerForProofId(proofId) {
  return `E6-POLISH-${proofId.slice(0, 12)}`
}

function polishSentenceForE6(pattern) {
  let output = pattern
  for (const [before, after] of plan.polishReplacements) {
    if (output.split(before).length !== 2) return null
    output = output.replace(before, after)
  }
  return output
}

function collectValuesForKey(value, key, output = []) {
  if (Array.isArray(value)) {
    value.forEach((child) => collectValuesForKey(child, key, output))
  } else if (value && typeof value === 'object') {
    for (const [candidateKey, child] of Object.entries(value)) {
      if (candidateKey === key) output.push(child)
      collectValuesForKey(child, key, output)
    }
  }
  return output
}

function uniqueNumberForKeys(value, keys) {
  const values = keys.flatMap((key) => collectValuesForKey(value, key))
    .map(Number).filter(Number.isSafeInteger)
  const unique = [...new Set(values)]
  return unique.length === 1 && unique[0] >= 0 ? unique[0] : null
}

function columnNameForNumber(value) {
  if (!Number.isSafeInteger(value) || value < 1) return null
  let remaining = value
  let output = ''
  while (remaining > 0) {
    remaining -= 1
    output = String.fromCharCode(65 + (remaining % 26)) + output
    remaining = Math.floor(remaining / 26)
  }
  return output
}

function matchingSheetMetadata(value, selector, output = []) {
  if (Array.isArray(value)) {
    value.forEach((child) => matchingSheetMetadata(child, selector, output))
  } else if (value && typeof value === 'object') {
    const candidate = value[selector.key]
      ?? (selector.key === 'sheet_id' ? value.sheetId : value.sheet_name ?? value.sheetName)
    if (candidate === selector.value) output.push(value)
    Object.values(value).forEach((child) => matchingSheetMetadata(child, selector, output))
  }
  return output
}

function projectSheetStructureRead(value, selector) {
  const matches = matchingSheetMetadata(value, selector)
  const mergedCells = collectValuesForKey(value, 'merged_cells').filter(Array.isArray)
  const ranges = collectValuesForKey(value, 'range').filter((candidate) => (
    typeof candidate === 'string'
  ))
  const revision = uniqueNumberForKeys(value, ['revision', 'revision_id', 'revisionId'])
  if (matches.length !== 1 || mergedCells.length !== 1 || mergedCells[0].length !== 0
    || ranges.length !== 1 || revision === null) return null
  return { range: ranges[0], revision }
}

function projectSingleSheetCellRead(value, expectedRange) {
  const ranges = collectValuesForKey(value, 'ranges').filter(Array.isArray)
  const hasMore = collectValuesForKey(value, 'has_more')
  const warnings = collectValuesForKey(value, 'warning_message')
  const revision = uniqueNumberForKeys(value, ['revision', 'revision_id', 'revisionId'])
  if (ranges.length !== 1 || ranges[0].length !== 1
    || hasMore.length !== 1 || hasMore[0] !== false
    || warnings.length !== 1 || typeof warnings[0] !== 'string' || warnings[0].length === 0
    || revision === null) return null
  const range = ranges[0][0]
  const columnName = expectedRange.replace(/1$/, '')
  if (!range || typeof range !== 'object' || Array.isArray(range)
    || range.actual_range !== `${expectedRange}:${expectedRange}`
    || JSON.stringify(range.row_indices) !== JSON.stringify([1])
    || JSON.stringify(range.col_indices) !== JSON.stringify([columnName])
    || range.truncated !== false
    || !Array.isArray(range.cells) || range.cells.length !== 1
    || !Array.isArray(range.cells[0]) || range.cells[0].length !== 1) return null
  const cell = range.cells[0][0]
  if (!cell || typeof cell !== 'object' || Array.isArray(cell)) return null
  const hasValue = Object.prototype.hasOwnProperty.call(cell, 'value')
  const hasFormula = Object.prototype.hasOwnProperty.call(cell, 'formula')
  const hasRichText = Object.prototype.hasOwnProperty.call(cell, 'rich_text')
  const hasMultipleValues = Object.prototype.hasOwnProperty.call(cell, 'multiple_values')
  const styleDigest = digestJson({
    cellStyles: cell.cell_styles ?? null,
    borderStyles: cell.border_styles ?? null,
    dataValidation: cell.data_validation ?? null,
  })
  return {
    empty: !hasValue && !hasFormula && !hasRichText && !hasMultipleValues,
    literalValue: hasValue && !hasFormula && !hasRichText && !hasMultipleValues
      ? cell.value
      : undefined,
    revision,
    styleDigest,
  }
}

function assertNoAmbientExecutionInjection(source) {
  const blocked = Object.keys(source).filter((key) => (
    key === 'NODE_OPTIONS' || key === 'NODE_PATH' || key === 'NODE_EXTRA_CA_CERTS'
      || key === 'ELECTRON_RUN_AS_NODE' || key === 'BASH_ENV' || key === 'ENV'
      || key === 'ZDOTDIR' || key.startsWith('DYLD_') || key.startsWith('LD_')
      || key.startsWith('SSL_CERT')
      || ['npm_config_node_options', 'npm_config_node_path', 'npm_config_script_shell']
        .includes(key.toLowerCase())
  ))
  if (blocked.length > 0) throw new Error('ambient_execution_injection_forbidden')
}

function trustedChildEnvironment(source) {
  const allowed = new Set([
    'HOME', 'LANG', 'LC_ALL', 'LC_CTYPE', 'LOGNAME', 'NO_COLOR', 'SHELL',
    'TEMP', 'TERM', 'TMP', 'TMPDIR', 'TZ', 'USER', 'XDG_CONFIG_HOME',
  ])
  return {
    ...Object.fromEntries(Object.entries(source).filter(([key, value]) => (
      allowed.has(key) && typeof value === 'string'
    ))),
    PATH: TRUSTED_RUNTIME_PATH,
  }
}

function readCurrentLarkCliAuthority(repositoryRoot = repoRoot) {
  assertNoAmbientExecutionInjection(process.env)
  const tsxPath = require.resolve('tsx/cli', { paths: [repositoryRoot] })
  const sourcePath = resolve(
    repositoryRoot,
    'src/main/modules/skills-runtime/lark-cli-executable-authority.ts',
  )
  const program = `
    import { resolveGlobalLarkCliExecutableAuthority } from ${JSON.stringify(sourcePath)};
    void (async () => {
      const authority = await resolveGlobalLarkCliExecutableAuthority();
      process.stdout.write(JSON.stringify({
        architecture: process.arch,
        authorityDigest: authority.authorityDigest,
        autoInstallForbidden: authority.autoInstallForbidden,
        launcherCount: authority.launcherChain.length,
        payloadSha256: authority.payloadSha256,
        version: authority.version,
        wrapperExecutionForbidden: authority.wrapperExecutionForbidden,
      }));
    })().catch((error) => {
      process.stderr.write(error instanceof Error ? error.message : String(error));
      process.exitCode = 1;
    });
  `
  const raw = execFileSync(process.execPath, [tsxPath, '-e', program], {
    cwd: repositoryRoot,
    encoding: 'utf8',
    env: trustedChildEnvironment(process.env),
    maxBuffer: 1024 * 1024,
  })
  const authority = JSON.parse(raw)
  if (authority.version !== SUPPORTED_VERSION
    || authority.architecture !== 'arm64'
    || authority.wrapperExecutionForbidden !== true
    || authority.autoInstallForbidden !== true
    || authority.launcherCount !== 1
    || !/^[a-f0-9]{64}$/.test(authority.authorityDigest)
    || !/^[a-f0-9]{64}$/.test(authority.payloadSha256)) {
    throw new Error('e6_user_scenario_lark_cli_authority_invalid')
  }
  return authority
}

function mapReadyToolOutputDigests(outputs, repositoryRoot = repoRoot) {
  if (!Array.isArray(outputs) || outputs.length === 0) {
    throw new Error('e6_user_scenario_tool_response_invalid')
  }
  assertNoAmbientExecutionInjection(process.env)
  const tsxPath = require.resolve('tsx/cli', { paths: [repositoryRoot] })
  const bridgePath = resolve(
    repositoryRoot,
    'src/main/modules/agent-control/codex-runtime/codex-tool-output-mapper.ts',
  )
  const contractPath = resolve(
    repositoryRoot,
    'src/main/modules/agent-control/codex-runtime/codex-model-gateway-contract.ts',
  )
  const program = `
    import { readFileSync } from 'node:fs';
    import { mapReadyToolOutput } from ${JSON.stringify(bridgePath)};
    import { digestCanonicalJson } from ${JSON.stringify(contractPath)};
    const outputs = JSON.parse(readFileSync(0, 'utf8'));
    process.stdout.write(JSON.stringify(outputs.map((output) =>
      digestCanonicalJson(mapReadyToolOutput(output, [])))));
  `
  const raw = execFileSync(process.execPath, [tsxPath, '-e', program], {
    cwd: repositoryRoot,
    encoding: 'utf8',
    env: trustedChildEnvironment(process.env),
    input: JSON.stringify(outputs),
    maxBuffer: 4 * 1024 * 1024,
  })
  const digests = JSON.parse(raw)
  if (!Array.isArray(digests) || digests.length !== outputs.length
    || !digests.every((digest) => /^[a-f0-9]{64}$/.test(digest))) {
    throw new Error('e6_user_scenario_tool_response_invalid')
  }
  return digests
}

function runCurrentLarkCliRead(args, repositoryRoot = repoRoot) {
  const safeCommands = [
    ['auth', 'status', '--json', '--verify'],
    ['sheets', '+workbook-info', '--url', EXPECTED_SHEET_URL, '--as', 'user', '--json'],
    ['sheets', '+revision-get', '--url', EXPECTED_SHEET_URL, '--as', 'user', '--json'],
    ['docs', '+fetch', '--doc', EXPECTED_DOCX_URL, '--as', 'user', '--json'],
  ]
  const exact = safeCommands.some((candidate) => JSON.stringify(candidate) === JSON.stringify(args))
  const safeCellsGet = args.length === 11 && args[0] === 'sheets' && args[1] === '+cells-get'
    && args[2] === '--url' && args[3] === EXPECTED_SHEET_URL
    && ['--sheet-id', '--sheet-name'].includes(args[4])
    && typeof args[5] === 'string' && args[5].length > 0
    && args[6] === '--range' && /^[A-Z]{1,3}1$/.test(args[7])
    && args[8] === '--as' && args[9] === 'user' && args[10] === '--json'
  if (!exact && !safeCellsGet) throw new Error('e6_user_scenario_recovery_command_invalid')
  assertNoAmbientExecutionInjection(process.env)
  const tsxPath = require.resolve('tsx/cli', { paths: [repositoryRoot] })
  const sourcePath = resolve(
    repositoryRoot,
    'src/main/modules/skills-runtime/lark-cli-executable-authority.ts',
  )
  const executionPath = resolve(
    repositoryRoot,
    'src/main/modules/skills-runtime/desktop-executable-authority.ts',
  )
  const program = `
    import { resolveGlobalLarkCliExecutableAuthority } from ${JSON.stringify(sourcePath)};
    import { executeFrozenDesktopExecutable } from ${JSON.stringify(executionPath)};
    void (async () => {
      const authority = await resolveGlobalLarkCliExecutableAuthority();
      const result = await executeFrozenDesktopExecutable({
        authority,
        args: ${JSON.stringify(args)},
        env: {
          ...process.env,
          LARKSUITE_CLI_NO_SKILLS_NOTIFIER: '1',
          LARKSUITE_CLI_NO_UPDATE_NOTIFIER: '1',
        },
        timeoutMs: 30_000,
      });
      if (result.executableReadbackDigest !== authority.authorityDigest) {
        throw new Error('dependency_identity_drift');
      }
      process.stdout.write(JSON.stringify({
        authority: {
          architecture: process.arch,
          authorityDigest: authority.authorityDigest,
          autoInstallForbidden: authority.autoInstallForbidden,
          launcherCount: authority.launcherChain.length,
          payloadSha256: authority.payloadSha256,
          version: authority.version,
          wrapperExecutionForbidden: authority.wrapperExecutionForbidden,
        },
        status: result.exitCode,
        signal: null,
        stdout: result.stdout,
        stderr: result.stderr,
      }));
    })().catch((error) => {
      process.stderr.write(error instanceof Error ? error.message : String(error));
      process.exitCode = 1;
    });
  `
  const raw = execFileSync(process.execPath, [tsxPath, '-e', program], {
    cwd: repositoryRoot,
    encoding: 'utf8',
    env: trustedChildEnvironment(process.env),
    maxBuffer: 20 * 1024 * 1024,
  })
  const result = JSON.parse(raw)
  if (result.status !== 0 || result.signal !== null || typeof result.stdout !== 'string') {
    throw new Error('e6_user_scenario_recovery_read_failed')
  }
  let value
  try { value = JSON.parse(result.stdout) } catch {
    throw new Error('e6_user_scenario_recovery_read_invalid')
  }
  if (value?.ok !== true) throw new Error('e6_user_scenario_recovery_read_failed')
  return { authority: result.authority, value }
}

module.exports = {
  EXPECTED_DOCX_TITLE,
  EXPECTED_DOCX_URL,
  EXPECTED_SHEET_URL,
  SHEET_APPEND_POLICY,
  SUPPORTED_VERSION,
  assertNoAmbientExecutionInjection,
  columnNameForNumber,
  docxTaskMarkerForProofId,
  mapReadyToolOutputDigests,
  plan,
  polishSentenceForE6,
  projectSheetStructureRead,
  projectSingleSheetCellRead,
  readCurrentLarkCliAuthority,
  runCurrentLarkCliRead,
  sheetSentinelForProofId,
}
