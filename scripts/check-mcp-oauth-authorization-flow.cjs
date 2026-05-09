#!/usr/bin/env node
/**
 * Stage T PR-T5 — MCP OAuth flow is wired.
 *
 * `mcp/oauth.ts` must declare three named entry points (the contract is
 * what's enforced — the wire protocol implementation can be a skeleton):
 *   - requestAuthorizationCode
 *   - exchangeCodeForToken
 *   - ensureAuthorized
 *
 * `mcp/client.ts` must call `ensureAuthorized` before issuing a tool call —
 * so MCP traffic never bypasses OAuth.
 */

const { existsSync, readFileSync } = require('node:fs')
const { resolve } = require('node:path')

const OAUTH_FILE = 'src/main/modules/mcp/oauth.ts'
const CLIENT_FILE = 'src/main/modules/mcp/client.ts'

function read(rel) {
  const path = resolve(__dirname, '..', rel)
  if (!existsSync(path)) return null
  return readFileSync(path, 'utf8')
}

function main() {
  const violations = []

  const oauthSrc = read(OAUTH_FILE)
  if (!oauthSrc) {
    violations.push({ file: OAUTH_FILE, reason: 'missing file' })
  } else {
    for (const fn of ['requestAuthorizationCode', 'exchangeCodeForToken', 'ensureAuthorized']) {
      const re = new RegExp(`export\\s+(async\\s+)?function\\s+${fn}\\s*\\(`)
      if (!re.test(oauthSrc)) {
        violations.push({
          file: OAUTH_FILE,
          reason: `must export \`${fn}\` function`,
        })
      }
    }
    // ensureAuthorized must reference the other two — it's the orchestrator.
    const ensureBody = oauthSrc.match(/function\s+ensureAuthorized\s*\([\s\S]*?\n\}/)
    if (ensureBody) {
      const body = ensureBody[0]
      if (!/requestAuthorizationCode\s*\(/.test(body)) {
        violations.push({
          file: OAUTH_FILE,
          reason: 'ensureAuthorized must call requestAuthorizationCode',
        })
      }
      if (!/exchangeCodeForToken\s*\(/.test(body)) {
        violations.push({
          file: OAUTH_FILE,
          reason: 'ensureAuthorized must call exchangeCodeForToken',
        })
      }
    }
  }

  const clientSrc = read(CLIENT_FILE)
  if (!clientSrc) {
    violations.push({ file: CLIENT_FILE, reason: 'missing file' })
  } else {
    if (!/import\s*\{[^}]*\bensureAuthorized\b[^}]*\}\s*from\s*['"]\.\/oauth['"]/.test(clientSrc)) {
      violations.push({
        file: CLIENT_FILE,
        reason: 'must import `ensureAuthorized` from `./oauth`',
      })
    }
    if (!/ensureAuthorized\s*\(/.test(clientSrc)) {
      violations.push({
        file: CLIENT_FILE,
        reason: 'must call `ensureAuthorized(...)` before tool dispatch',
      })
    }
  }

  if (violations.length > 0) {
    console.error('[check-mcp-oauth-authorization-flow] FAIL:')
    for (const v of violations) console.error(`  - ${v.file}: ${v.reason}`)
    process.exit(1)
  }
  console.log('[check-mcp-oauth-authorization-flow] OK')
}

main()
