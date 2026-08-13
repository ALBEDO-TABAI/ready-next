'use strict'

const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const test = require('node:test')
const {
  assertPackagedPackageJsonMatchesSource,
  assertPackagedRuntimeDependencies,
  assertNoHighConfidenceSecretsInTree,
  assertResourceTree,
  collectRuntimeExternalPackageRoots,
  highConfidenceSecretKind,
  isSensitivePayloadPath,
  resolvePackagedRuntimeDependencyClosure,
  verifyAndWriteReceipt,
  verifyExistingStructuralReceipt,
} = require('../verify-release-structural-package.cjs')

test('packaged package metadata may retain harmless fields while runtime wiring must match', () => {
  const sourcePackage = {
    name: 'ready', version: '0.7.9-a', main: './out/main/index.js', type: 'module',
    dependencies: { docx: '9.5.1' }, engines: { node: '>=20' },
  }
  assert.doesNotThrow(() => assertPackagedPackageJsonMatchesSource(JSON.stringify({
    ...sourcePackage,
    homepage: 'https://example.invalid',
  }), sourcePackage))
  assert.throws(() => assertPackagedPackageJsonMatchesSource(JSON.stringify({
    ...sourcePackage,
    main: './out/main/missing.js',
  }), sourcePackage), /field does not match.*main/)
})

const verification = {
  signature: 'verified', signingIdentity: 'ad-hoc-local', dmg: 'verified', mount: 'read-only', applicationsLink: '/Applications',
  aiSeed: 'empty-object', packageShape: 'slim', architecture: 'arm64', appVersion: '1.0.0',
  bundleVersion: '1.0.0', runtimeManifestSha256: null,
}

test('database-shaped packaged state is treated as a sensitive carrier', () => {
  for (const file of ['ready.db', 'ready.db-shm', 'ready.db-wal', 'agent-memory.db', '.npmrc_backup']) {
    assert.equal(isSensitivePayloadPath(`embedded-skills/demo/${file}`), true)
  }
  for (const file of [
    'embedded-skills/agent-memory/history.json',
    'sidecar/agent-sidecar-runtime/state.json',
    'sidecar/channel-attachments/blob.bin',
    'resources/rss-artifacts/result.json',
    'resources/rsshub-runtime/cache.json',
    'resources/puppeteer-cache/state.json',
    'sidecar/__pycache__/module.pyc',
    'sidecar/.pytest_cache/state',
    'sidecar/.mypy_cache/state',
  ]) {
    assert.equal(isSensitivePayloadPath(file), true)
  }
})

test('high-confidence secret content rejects real credentials but not placeholders', () => {
  assert.equal(highConfidenceSecretKind(Buffer.from('OPENAI_API_KEY="sk-real-secret-material-123456789"')), 'credential-value')
  assert.equal(highConfidenceSecretKind(Buffer.from('OPENAI_API_KEY=sk-proj-real-secret-material-123456789')), 'credential-value')
  assert.equal(highConfidenceSecretKind(Buffer.from('{"OPENAI_API_KEY":"sk-real-secret-material-123456789"}')), 'credential-value')
  assert.equal(highConfidenceSecretKind(Buffer.from('{"app_secret":"real-secret-material-123456789"}')), 'credential-value')
  const privateKey = require('node:crypto').generateKeyPairSync('ed25519').privateKey.export({
    type: 'pkcs8', format: 'pem',
  })
  assert.equal(highConfidenceSecretKind(Buffer.from(privateKey)), 'private-key')
  assert.equal(highConfidenceSecretKind(Buffer.from(`\ufeff${privateKey}`, 'utf16le')), 'private-key')
  assert.equal(highConfidenceSecretKind(Buffer.from(JSON.stringify({ private_key: privateKey }))), 'private-key')
  const rsa = require('node:crypto').generateKeyPairSync('rsa', { modulusLength: 1024 })
  const ec = require('node:crypto').generateKeyPairSync('ec', { namedCurve: 'prime256v1' })
  for (const der of [
    rsa.privateKey.export({ format: 'der', type: 'pkcs8' }),
    rsa.privateKey.export({ format: 'der', type: 'pkcs1' }),
    ec.privateKey.export({ format: 'der', type: 'sec1' }),
  ]) assert.equal(highConfidenceSecretKind(der, { sourcePath: 'private.der' }), 'private-key')
  const privateJwk = rsa.privateKey.export({ format: 'jwk' })
  const publicJwk = rsa.publicKey.export({ format: 'jwk' })
  assert.equal(highConfidenceSecretKind(Buffer.from(JSON.stringify(privateJwk))), 'private-key')
  assert.equal(highConfidenceSecretKind(Buffer.from(JSON.stringify(privateJwk, null, 2))), 'private-key')
  assert.equal(highConfidenceSecretKind(Buffer.from(JSON.stringify(publicJwk))), null)
  const passphrase = 'synthetic-test-passphrase'
  const encryptedPem = rsa.privateKey.export({
    format: 'pem', type: 'pkcs8', cipher: 'aes-256-cbc', passphrase,
  })
  const encryptedDer = rsa.privateKey.export({
    format: 'der', type: 'pkcs8', cipher: 'aes-256-cbc', passphrase,
  })
  assert.equal(highConfidenceSecretKind(Buffer.from(encryptedPem), { sourcePath: 'secret.blob' }), 'private-key')
  assert.equal(highConfidenceSecretKind(Buffer.from(JSON.stringify({ key: encryptedPem }))), 'private-key')
  assert.equal(highConfidenceSecretKind(encryptedDer, { sourcePath: 'secret.der' }), 'private-key')
  assert.equal(highConfidenceSecretKind(Buffer.from('300b06092a864886f70d01050d', 'hex')), null)
  for (const [key, type] of [[rsa.privateKey, 'pkcs1'], [ec.privateKey, 'sec1']]) {
    const traditionalPem = key.export({
      format: 'pem', type, cipher: 'aes-256-cbc', passphrase,
    })
    assert.equal(highConfidenceSecretKind(Buffer.from(traditionalPem)), 'private-key')
  }
  const legacyEncryptedPem = rsa.privateKey.export({
    format: 'pem', type: 'pkcs1', cipher: 'des-ede3-cbc', passphrase,
  })
  assert.equal(highConfidenceSecretKind(Buffer.from(legacyEncryptedPem)), 'private-key')
  assert.equal(highConfidenceSecretKind(Buffer.from(JSON.stringify({ key: legacyEncryptedPem }))), 'private-key')
  const pbeSha1TripleDes = Buffer.from('301d300f060a2a864886f70d010c0103300100040a00112233445566778899', 'hex')
  assert.equal(highConfidenceSecretKind(pbeSha1TripleDes, { sourcePath: 'secret.der' }), 'private-key')
  const symmetricJwk = require('node:crypto').createSecretKey(Buffer.alloc(32, 7)).export({ format: 'jwk' })
  assert.equal(highConfidenceSecretKind(Buffer.from(JSON.stringify(symmetricJwk))), 'private-key')
  assert.equal(highConfidenceSecretKind(Buffer.from(JSON.stringify({ keys: [privateJwk] }))), 'private-key')
  assert.equal(highConfidenceSecretKind(Buffer.from(JSON.stringify({ keys: [symmetricJwk] }))), 'private-key')
  assert.equal(highConfidenceSecretKind(Buffer.from(JSON.stringify({ signing: privateJwk }))), 'private-key')
  assert.equal(highConfidenceSecretKind(Buffer.from(JSON.stringify({ keys: [publicJwk] }))), null)
  assert.equal(highConfidenceSecretKind(Buffer.from(JSON.stringify([privateJwk]))), 'private-key')
  assert.equal(highConfidenceSecretKind(Buffer.from(JSON.stringify({
    keys: [{ kty: 'RSA', d: 'invalid' }, privateJwk],
  }))), 'private-key')
  assert.equal(highConfidenceSecretKind(Buffer.from(JSON.stringify({
    first: { kty: 'EC', d: 'bad' }, second: { signing: privateJwk },
  }))), 'private-key')
  assert.equal(highConfidenceSecretKind(Buffer.from('{"apiKey":"your-api-key-here"}')), null)
  assert.equal(highConfidenceSecretKind(Buffer.from('const apiKey = process.env.OPENAI_API_KEY')), null)
  assert.equal(highConfidenceSecretKind(Buffer.from('privateKey = Uint8Array.from(arr.subarray(1, 33))')), null)
  assert.equal(highConfidenceSecretKind(Buffer.from('refreshToken = tokens.refresh_token')), null)
  assert.equal(highConfidenceSecretKind(Buffer.from('password = envs.DIDA365_PASSWORD')), null)
  assert.equal(highConfidenceSecretKind(
    Buffer.from("const ETHEREAL_API_KEY = (process.env.ETHEREAL_API_KEY || '').replace(/\\s*/g, '') || null"),
    { thirdPartyDependency: true },
  ), null)
  assert.equal(highConfidenceSecretKind(Buffer.from('API_KEY="AIzaSyAO_FJ2SlqU8Q4STEHLGCilw_Y9_11qcW8"')), null)
  assert.equal(highConfidenceSecretKind(Buffer.from('apiKey: "preview"')), null)
  assert.equal(highConfidenceSecretKind(Buffer.from('appSecret: "secret_preview_feishu"')), null)
  assert.equal(highConfidenceSecretKind(Buffer.from('apiKey="Cah2snYi52eJjpshbIfof1Tpx8ZhzXqh"')), 'credential-value')
  assert.equal(highConfidenceSecretKind(
    Buffer.from('apiKey="Cah2snYi52eJjpshbIfof1Tpx8ZhzXqh"'),
    { thirdPartyDependency: true },
  ), null)
  assert.equal(highConfidenceSecretKind(
    Buffer.from('apiKey="sk-proj-real-secret-material-123456789"'),
    { thirdPartyDependency: true },
  ), 'credential-value')
  for (const credential of [
    'AWS_ACCESS_KEY_ID=AKIA1234567890ABCDEF',
    'AWS_SECRET_ACCESS_KEY=wJalrXUtnFEMI/K7MDENG/bPxRfiCY1234567890',
    'GITHUB_TOKEN=ghp_1234567890abcdefghijklmnop',
    'SLACK_BOT_TOKEN=xoxb-123456789012-abcdefghijklmnop',
    'SLACK_APP_TOKEN=xapp-1-123456789012-abcdefghijklmnop',
    'AWS_SESSION_TOKEN=IQoJb3JpZ2luX2VjEOr//////////wEaCXVzLWVhc3QtMSJHMEUCIQDexample123456789',
    'NPM_TOKEN=npm_1234567890abcdefghijklmnopqrstuvwxyz',
    'GITLAB_TOKEN=glpat-1234567890abcdefghijklmnop',
    'STRIPE_WEBHOOK_SECRET=whsec_1234567890abcdefghijklmnop',
    'STRIPE_RESTRICTED_KEY=rk_live_1234567890abcdefghijklmnop',
    'SENDGRID_API_KEY=SG.abcdefghijklmnop.1234567890abcdefghijklmnop',
    'AWS_ACCESS_KEY_ID=ASIA1234567890ABCDEF',
    'BOT_TOKEN=123456789:AAEfgHiJkLmNoPqRsTuVwXyZ0123456789',
    'Authorization: Basic dXNlcjpyZWFsLXBhc3N3b3JkLTEyMzQ1Njc4OTA=',
    'STRIPE_SECRET_KEY=sk_live_1234567890abcdefghijklmnop',
    'STRIPE_SECRET_KEY=sk_test_1234567890abcdefghijklmnop',
    'SLACK_BOT_TOKEN=xoxb-123456789012-demoabcdefghijklmnop',
    'AUTH_TOKEN=token_1234567890abcdefghijklmnop',
    'DATABASE_URL=postgres://ready:real-password-123456789@db.example.com/ready',
    'Authorization: Bearer eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJyZWFkeSJ9.signature123456789',
    'Authorization: Bearer opaqueTokenMaterial1234567890abcdef',
    'Authorization: "Bearer opaqueTokenMaterial1234567890abcdef"',
    'Authorization: Bearer opaqueTokenMaterial1234567890%3D%3D',
  ]) {
    assert.equal(
      highConfidenceSecretKind(Buffer.from(credential), { thirdPartyDependency: true }),
      'credential-value',
      credential.split('=')[0],
    )
  }
  for (const credential of [
    'TOKEN="ghp_1234567890abcdefghijklmnop"',
    'token="sk_live_1234567890abcdefghijklmnop"',
    'apiToken="xoxb-123456789012-abcdefghijklmnop"',
    'credential="AKIA1234567890ABCDEF"',
    'credential="IQoJb3JpZ2luX2VjEOr//////////wEaCXVzLWVhc3QtMSJHMEUCIQDexample123456789"',
    'OPENAI_API_KEY=`sk-proj-AbCd1234567890abcdefghijklmnop`',
    'GITHUB_TOKEN=`ghp_1234567890abcdefghijklmnop`',
    'NPM_TOKEN=`npm_1234567890abcdefghijklmnopqrstuvwxyz`',
    'OPENAI_API_KEY: |\n  sk-proj-AbCd1234567890abcdefghijklmnop',
    'OPENAI_API_KEY: |2-\n  sk-proj-AbCd1234567890abcdefghijklmnop',
    'ghp_1234567890abcdefghijklmnop',
    '["ghp_1234567890abcdefghijklmnop"]',
    '{"TOKEN":"ghp\\u005f1234567890abcdefghijklmnop"}',
    '{"TOKEN":"\\u0067hp_1234567890abcdefghijklmnop"}',
  ]) {
    assert.equal(highConfidenceSecretKind(Buffer.from(credential)), 'credential-value', credential)
    assert.equal(
      highConfidenceSecretKind(Buffer.from(credential), { thirdPartyDependency: true }),
      'credential-value',
      `third-party ${credential}`,
    )
  }
  for (const credential of [
    'PASSWORD="CorrectHorseBatteryStaple!2026"',
    'CLIENT_SECRET="p@ssw0rd!secret#material"',
    'PASSWORD=CorrectHorseBatteryStaple!2026',
    'CLIENT_SECRET=p@ssw0rd!secret-material',
    'client-secret: "p@ssw0rd!secret-material"',
    'PASSWORD: CorrectHorseBatteryStaple!2026',
    'PASSWORD="a\\"CorrectHorseBatteryStaple!2026"',
    "CLIENT_SECRET='a\\'CorrectHorseBatteryStaple!2026'",
  ]) {
    assert.equal(highConfidenceSecretKind(Buffer.from(credential)), 'credential-value', credential)
  }
  for (const codeValue of [
    'const privateKey = generatedPrivateKeyMaterial123456789',
    'password = resolvedPasswordVersion2026',
    'GITHUB_TOKEN = resolvedGithubTokenVersion2026',
    'PASSWORD=config?.password',
    'CLIENT_SECRET=payload?.clientSecret',
    'PASSWORD=options.password!',
    '// TOKEN="ghp_1234567890abcdefghijklmnop"',
    '/* credential="AKIA1234567890ABCDEF" */',
    'const matcher = /TOKEN="ghp_1234567890abcdefghijklmnop"/',
    'const file = "npm-another-standard-file.json"',
    'const command = "npm-super-common-command-name"',
    '{"filename":"npm-workspace-new.yaml"}',
    'const url = "mongodb://${host}:${port}/${database}"',
    'const url = "postgresql://localhost:5432/database"',
    'const url = "redis://localhost:6379/0"',
    'const encoded = "eyJub3QtYS1qd3QiOiJqdXN0LWJhc2U2NCJ9"',
  ]) {
    assert.equal(highConfidenceSecretKind(Buffer.from(codeValue)), null, codeValue)
  }
  assert.equal(
    highConfidenceSecretKind(Buffer.from("const leaked = 'prefix ghp_1234567890abcdefghijklmnop suffix'")),
    'credential-value',
  )
  assert.equal(
    highConfidenceSecretKind(Buffer.from("const leaked = '<key>TOKEN</key><string>ghp_1234567890abcdefghijklmnop</string>'")),
    'credential-value',
  )
  for (const [sourcePath, content] of [
    ['fixture.py', '# TOKEN="ghp_1234567890abcdefghijklmnop"'],
    ['fixture.yaml', '# TOKEN="ghp_1234567890abcdefghijklmnop"'],
    ['fixture.html', '<!-- TOKEN="ghp_1234567890abcdefghijklmnop" -->'],
  ]) {
    assert.equal(highConfidenceSecretKind(Buffer.from(content), { sourcePath }), null, sourcePath)
  }
  for (const content of [
    `It's TOKEN="ghp_1234567890abcdefghijklmnop" that's packaged`,
    'source https://example.com/ TOKEN="ghp_1234567890abcdefghijklmnop"',
  ]) {
    assert.equal(
      highConfidenceSecretKind(Buffer.from(content), { sourcePath: 'fixture.md' }),
      'credential-value',
    )
  }
  for (const [sourcePath, content] of [
    ['fixture.html', `<p>It's TOKEN="ghp_1234567890abcdefghijklmnop" that's leaked</p>`],
    ['fixture.xml', `<note>It's TOKEN="ghp_1234567890abcdefghijklmnop" that's leaked</note>`],
    ['fixture.svg', `<text>It's TOKEN="ghp_1234567890abcdefghijklmnop" that's leaked</text>`],
    ['fixture.yaml', `note: It's TOKEN="ghp_1234567890abcdefghijklmnop" that's leaked`],
    ['fixture.toml', `note = "prefix ghp_1234567890abcdefghijklmnop suffix"`],
    ['fixture.ini', `note=prefix ghp_1234567890abcdefghijklmnop suffix`],
    ['fixture.json', `{"note":"It's TOKEN=ghp_1234567890abcdefghijklmnop that's leaked"}`],
    ['fixture.py', `message = "prefix ghp_1234567890abcdefghijklmnop suffix"`],
    ['fixture.txt', 'prefix ghp_1234567890abcdefghijklmnop suffix'],
  ]) {
    assert.equal(
      highConfidenceSecretKind(Buffer.from(content), { sourcePath }),
      'credential-value',
      sourcePath,
    )
  }
  assert.equal(
    highConfidenceSecretKind(Buffer.from('privateKey = "generatedPrivateKeyMaterial123456789"')),
    'credential-value',
  )
  for (const credential of [
    'PASSWORD="CorrectHorse123process.env.HOME"',
    'CLIENT_SECRET="realMaterial123_process.env.API_KEY_more"',
    'APP_SECRET="process.env.API_KEY-real-prod-secret-123"',
  ]) {
    assert.equal(highConfidenceSecretKind(Buffer.from(credential)), 'credential-value', credential)
  }
  assert.equal(highConfidenceSecretKind(Buffer.alloc(1024 * 1024, 65)), null)
})

test('secret scan covers mixed UTF-8 and UTF-16 views', () => {
  const secret = 'OPENAI_API_KEY=sk-proj-real-secret-material-123456789'
  const utf16be = Buffer.from(secret, 'utf16le')
  utf16be.swap16()
  for (const content of [
    Buffer.concat([Buffer.from('A'.repeat(4096), 'utf16le'), Buffer.from(secret)]),
    Buffer.concat([Buffer.from('A'.repeat(8192)), Buffer.from(secret, 'utf16le')]),
    Buffer.concat([Buffer.from('A'.repeat(8192)), utf16be]),
    Buffer.concat([Buffer.from('A\0'.repeat(2048)), Buffer.from(secret)]),
  ]) {
    assert.equal(highConfidenceSecretKind(content), 'credential-value')
  }
})

test('secret scan stays bounded for dense assignment-shaped input', () => {
  for (const content of [
    Buffer.from('API_KEY='.repeat(128 * 1024)),
    Buffer.from('API_KEY:'.repeat(128 * 1024)),
  ]) {
    const startedAt = performance.now()
    assert.equal(highConfidenceSecretKind(content), null)
    assert.ok(performance.now() - startedAt < 5_000)
  }
  const denseProviderValues = Buffer.from(
    'const token = "ghp_1234567890abcdefghijklmnop";\n'.repeat(160 * 1024),
  )
  const providerStartedAt = performance.now()
  assert.equal(highConfidenceSecretKind(denseProviderValues), 'credential-value')
  assert.ok(performance.now() - providerStartedAt < 5_000)
})

test('secret content scan covers ordinary binary-looking file extensions', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ready-secret-content-'))
  fs.writeFileSync(path.join(root, 'payload.dat'), 'OPENAI_API_KEY=sk-proj-real-secret-material-123456789\n')
  assert.throws(() => assertNoHighConfidenceSecretsInTree('fixture', root, [
    { path: 'payload.dat', bytes: fs.statSync(path.join(root, 'payload.dat')).size },
  ]), /contains credential-value/)
  fs.writeFileSync(path.join(root, 'payload.dat'), Buffer.from([0, 1, 2, 3, 4]))
  assert.doesNotThrow(() => assertNoHighConfidenceSecretsInTree('fixture', root, [
    { path: 'payload.dat', bytes: 5 },
  ]))
  for (const value of [
    'OPENAI_API_KEY: sk-proj-real-secret-material-123456789\n',
    '<plist><key>OPENAI_API_KEY</key><string>sk-proj-real-secret-material-123456789</string></plist>',
    '\0OPENAI_API_KEY=sk-proj-real-secret-material-123456789\n',
  ]) {
    fs.writeFileSync(path.join(root, 'payload.dat'), value)
    assert.throws(() => assertNoHighConfidenceSecretsInTree('fixture', root, [
      { path: 'payload.dat', bytes: fs.statSync(path.join(root, 'payload.dat')).size },
    ]), /contains credential-value/)
  }
})

test('packaged runtime dependencies are derived from built main and preload imports', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ready-runtime-deps-'))
  fs.mkdirSync(path.join(root, 'out/main'), { recursive: true })
  fs.mkdirSync(path.join(root, 'out/preload'), { recursive: true })
  fs.writeFileSync(path.join(root, 'package.json'), '{}\n')
  fs.writeFileSync(path.join(root, 'out/main/index.js'), [
    "import { createRequire } from 'node:module'",
    "import { app } from 'electron'",
    "import docx from 'docx'",
    "const server = await import('@hono/node-server')",
    "const local = await import('./local.js')",
    'const requireFromHere = createRequire(import.meta.url)',
    "requireFromHere('bindings')",
    "requireFromHere('original-fs')",
    "requireFromHere.resolve('ws')",
    "createRequire(import.meta.url)('undici')",
  ].join('\n'))
  fs.writeFileSync(path.join(root, 'out/preload/index.mjs'), "const zod = require('zod')\n")
  const parser = require('@babel/parser')
  const roots = collectRuntimeExternalPackageRoots(root, { parse: parser.parse })
  assert.deepEqual(roots, ['@hono/node-server', 'bindings', 'docx', 'undici', 'ws', 'zod'])
  assert.throws(() => assertPackagedRuntimeDependencies(root, [
    'node_modules/@hono/node-server/package.json',
    'node_modules/bindings/package.json',
    'node_modules/undici/package.json',
    'node_modules/ws/package.json',
    'node_modules/zod/package.json',
  ], { parse: parser.parse, resolveRuntimeClosure: () => [] }), /missing external runtime dependency: docx/)
  assert.throws(() => assertPackagedRuntimeDependencies(root, [
    'node_modules/@hono/node-server/package.json',
    'node_modules/bindings/package.json',
    'node_modules/docx/package.json',
    'node_modules/undici/package.json',
    'node_modules/ws/package.json',
    'node_modules/zod/package.json',
  ], { parse: parser.parse }), /closure resolver is required/)
})

test('runtime dependency collector respects lexical shadowing of require aliases', () => {
  const parser = require('@babel/parser')
  const traverse = require('@babel/traverse').default
  const roots = collectRuntimeExternalPackageRoots(process.cwd(), {
    parse: parser.parse,
    traverse,
    sources: [
      [
        "import { createRequire } from 'node:module'",
        'const req = createRequire(import.meta.url)',
        "req('docx')",
        "function local(req) { req('not-a-package-call') }",
        "function shadow(require) { require('also-not-a-package-call') }",
        "function shadowFactory(createRequire) { req('@hono/node-server') }",
      ].join('\n'),
      [
        "const req = require('node:module').createRequire(__filename)",
        "function shadow(require) { req('ws') }",
      ].join('\n'),
      [
        "import { createRequire as makeRequire } from 'node:module'",
        "const req = makeRequire(import.meta.url)",
        "req('bindings')",
        "makeRequire(import.meta.url)('undici')",
      ].join('\n'),
      [
        "const { createRequire: makeRequire } = require('node:module')",
        "const req = makeRequire(__filename)",
        "req('zod')",
        "const direct = require('node:module').createRequire",
        "direct(__filename)('yaml')",
        "const Module = require('node:module')",
        "Module.createRequire(__filename)('ws')",
      ].join('\n'),
    ],
  })
  assert.deepEqual(roots, ['@hono/node-server', 'bindings', 'docx', 'undici', 'ws', 'yaml', 'zod'])
})

test('packaged runtime dependency closure rejects a missing internal module', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ready-runtime-closure-'))
  const appRoot = path.join(root, 'app')
  fs.symlinkSync(path.join(__dirname, '../../node_modules'), path.join(root, 'node_modules'), 'dir')
  fs.mkdirSync(path.join(appRoot, 'out/main'), { recursive: true })
  fs.mkdirSync(path.join(appRoot, 'node_modules/docx'), { recursive: true })
  fs.writeFileSync(path.join(appRoot, 'out/main/index.js'), "require('docx')\n")
  fs.writeFileSync(path.join(appRoot, 'package.json'), '{}\n')
  fs.writeFileSync(path.join(appRoot, 'node_modules/docx/package.json'), JSON.stringify({
    name: 'docx', version: '1.0.0', main: 'index.js', dependencies: { '@types/node': '^22.0.0' },
  }))
  fs.writeFileSync(path.join(appRoot, 'node_modules/docx/index.js'), "require('./missing-internal.js')\n")
  const asarPath = path.join(root, 'app.asar')
  await require('@electron/asar').createPackage(appRoot, asarPath)
  const electron = require('electron')
  let failure
  try {
    resolvePackagedRuntimeDependencyClosure(electron, asarPath, ['docx'], root)
  } catch (error) {
    failure = error
  }
  assert.equal(failure?.message, 'missing packaged module ./missing-internal.js from node_modules/docx/index.js')
})

test('packaged runtime dependency closure accepts an import-only package entry', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ready-runtime-import-only-'))
  const appRoot = path.join(root, 'app')
  fs.symlinkSync(path.join(__dirname, '../../node_modules'), path.join(root, 'node_modules'), 'dir')
  fs.mkdirSync(path.join(appRoot, 'out/main'), { recursive: true })
  fs.mkdirSync(path.join(appRoot, 'node_modules/rsshub/dist-lib'), { recursive: true })
  fs.writeFileSync(path.join(appRoot, 'out/main/index.js'), "import { init } from 'rsshub'\n")
  fs.writeFileSync(path.join(appRoot, 'package.json'), '{}\n')
  fs.writeFileSync(path.join(appRoot, 'node_modules/rsshub/package.json'), JSON.stringify({
    name: 'rsshub',
    version: '1.0.0',
    exports: { '.': { import: './dist-lib/pkg.mjs' } },
    peerDependencies: { electron: '^42.0.0' },
  }))
  fs.writeFileSync(path.join(appRoot, 'node_modules/rsshub/dist-lib/pkg.mjs'), 'export const init = () => {}\n')
  const asarPath = path.join(root, 'app.asar')
  await require('@electron/asar').createPackage(appRoot, asarPath)
  const closure = resolvePackagedRuntimeDependencyClosure(require('electron'), asarPath, ['rsshub'], root)
  assert.ok(closure.includes('file:node_modules/rsshub/dist-lib/pkg.mjs'))
})

test('packaged runtime dependency closure covers static require variants and rejects directories without entries', async () => {
  const variants = [
    "const req=require('node:module').createRequire(__filename); req('./missing.js')",
    "require('node:module').createRequire(__filename)('./missing.js')",
    'require(`./missing.js`)',
    "module.require('./missing.js')",
    "require('./subdir')",
  ]
  for (const [index, source] of variants.entries()) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), `ready-runtime-variant-${index}-`))
    const appRoot = path.join(root, 'app')
    fs.symlinkSync(path.join(__dirname, '../../node_modules'), path.join(root, 'node_modules'), 'dir')
    fs.mkdirSync(path.join(appRoot, 'out/main'), { recursive: true })
    fs.mkdirSync(path.join(appRoot, 'node_modules/docx/subdir'), { recursive: true })
    fs.writeFileSync(path.join(appRoot, 'out/main/index.js'), "require('docx')\n")
    fs.writeFileSync(path.join(appRoot, 'package.json'), '{}\n')
    fs.writeFileSync(path.join(appRoot, 'node_modules/docx/package.json'), JSON.stringify({
      name: 'docx', version: '1.0.0', main: 'index.js',
    }))
    fs.writeFileSync(path.join(appRoot, 'node_modules/docx/index.js'), `${source}\n`)
    fs.writeFileSync(path.join(appRoot, 'node_modules/docx/subdir/placeholder.txt'), 'not an entry\n')
    const asarPath = path.join(root, 'app.asar')
    await require('@electron/asar').createPackage(appRoot, asarPath)
    assert.throws(
      () => resolvePackagedRuntimeDependencyClosure(require('electron'), asarPath, ['docx'], root),
      (error) => error?.message?.startsWith('missing packaged module ') === true,
    )
  }
})

test('resource inventory rejects a lost executable mode', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ready-resource-mode-'))
  const source = path.join(root, 'source')
  const mounted = path.join(root, 'mounted')
  fs.mkdirSync(source)
  fs.mkdirSync(mounted)
  fs.writeFileSync(path.join(source, 'run.sh'), '#!/bin/sh\n', { mode: 0o755 })
  fs.writeFileSync(path.join(mounted, 'run.sh'), '#!/bin/sh\n', { mode: 0o644 })
  assert.throws(() => assertResourceTree(source, mounted, { label: 'fixture' }), /resource mismatch: run\.sh/)
})

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ready-structural-receipt-'))
  fs.mkdirSync(path.join(root, 'exports'), { recursive: true })
  fs.mkdirSync(path.join(root, 'assets/codex-runtime'), { recursive: true })
  fs.writeFileSync(path.join(root, 'exports/Ready-1.0.0-arm64.dmg'), 'dmg-one')
  fs.writeFileSync(path.join(root, 'assets/codex-runtime/runtime-manifest.json'), '{}\n')
  return root
}

test('receipt writer rejects same-size artifact replacement during inspection', () => {
  const root = fixture()
  const artifact = path.join(root, 'exports/Ready-1.0.0-arm64.dmg')
  assert.throws(() => verifyAndWriteReceipt({
    root,
    sourceManifest: () => ({ version: 2, digest: 'source', head: 'head', branch: 'branch', files: [], appVersion: '1.0.0' }),
    contractFactory: () => ({ appVersion: '1.0.0', arch: 'arm64', artifactRel: 'exports/Ready-1.0.0-arm64.dmg' }),
    inspectPackage: () => {
      fs.writeFileSync(artifact, 'dmg-two')
      return { ...verification, runtimeManifestSha256: require('../release-package-identity.cjs').sha256File(path.join(root, 'assets/codex-runtime/runtime-manifest.json')) }
    },
    toolchain: { node: 'v26.0.0', npm: '11.12.1', platform: 'darwin', architecture: 'arm64' },
  }), /packaged DMG changed/)
  assert.equal(fs.existsSync(path.join(root, 'exports/release-structural-receipts')), false)
})

test('existing receipt revalidation rejects changed mounted readback', () => {
  const root = fixture()
  const identity = require('../release-package-identity.cjs')
  const artifactPath = path.join(root, 'exports/Ready-1.0.0-arm64.dmg')
  const artifact = identity.captureRegularFile(artifactPath, root)
  const runtime = identity.captureRegularFile(path.join(root, 'assets/codex-runtime/runtime-manifest.json'), root)
  assert.throws(() => verifyExistingStructuralReceipt({
    root,
    receiptLoader: () => ({
      ok: true,
      receipt: {
        artifact,
        runtimeManifestSha256: runtime.sha256,
        verification: { marker: 'old' },
      },
      contract: {},
      artifactPath,
      currentSource: { version: 2, head: 'head', branch: 'branch', appVersion: '1.0.0', digest: 'source', files: [] },
    }),
    inspectPackage: () => ({ marker: 'new' }),
    sourceManifest: () => ({ version: 2, head: 'head', branch: 'branch', appVersion: '1.0.0', digest: 'source', files: [] }),
  }), /readback no longer matches/)
})

test('receipt writer passes only a pinned descriptor to package inspection', () => {
  const root = fixture()
  let inspected = null
  const receipt = verifyAndWriteReceipt({
    root,
    sourceManifest: () => ({ version: 2, digest: 'source', head: 'head', branch: 'branch', files: [], appVersion: '1.0.0' }),
    contractFactory: () => ({ appVersion: '1.0.0', arch: 'arm64', artifactRel: 'exports/Ready-1.0.0-arm64.dmg' }),
    inspectPackage: (_root, _contract, dmgPath, options) => {
      inspected = { dmgPath, descriptor: options.inheritedDmgDescriptor }
      return {
        ...verification,
        runtimeManifestSha256: require('../release-package-identity.cjs')
          .sha256File(path.join(root, 'assets/codex-runtime/runtime-manifest.json')),
      }
    },
    toolchain: { node: 'v26.0.0', npm: '11.12.1', platform: 'darwin', architecture: 'arm64' },
  })
  assert.equal(inspected.dmgPath, '/dev/fd/3')
  assert.equal(Number.isInteger(inspected.descriptor), true)
  assert.equal(receipt.artifact.bytes, 7)
})

test('existing receipt revalidation rejects replacement before mounted readback', () => {
  assert.throws(() => verifyExistingStructuralReceipt({
    root: '/tmp',
    receiptLoader: () => ({
      ok: true,
      receipt: {
        artifact: { bytes: 1, sha256: 'old-artifact' },
        runtimeManifestSha256: 'old-runtime',
        verification: { marker: 'old' },
      },
      contract: {},
      artifactPath: '/tmp/artifact',
      currentSource: { version: 2, head: 'head', branch: 'branch', appVersion: '1.0.0', digest: 'source', files: [] },
    }),
    captureIdentity: (file) => ({ bytes: 1, sha256: file.includes('runtime-manifest') ? 'new-runtime' : 'new-artifact' }),
    inspectPackage: () => ({ marker: 'old' }),
  }), /no longer matches the structural receipt before readback/)
})

test('existing receipt revalidation rejects source drift during mounted readback', () => {
  const root = fixture()
  const identity = require('../release-package-identity.cjs')
  const artifactPath = path.join(root, 'exports/Ready-1.0.0-arm64.dmg')
  const artifact = identity.captureRegularFile(artifactPath, root)
  const runtime = identity.captureRegularFile(path.join(root, 'assets/codex-runtime/runtime-manifest.json'), root)
  assert.throws(() => verifyExistingStructuralReceipt({
    root,
    receiptLoader: () => ({
      ok: true,
      receipt: { artifact, runtimeManifestSha256: runtime.sha256, verification: { marker: 'same' } },
      contract: {},
      artifactPath,
      currentSource: { version: 2, head: 'head', branch: 'branch', appVersion: '1.0.0', digest: 'source', files: [] },
    }),
    inspectPackage: () => ({ marker: 'same' }),
    sourceManifest: () => ({
      version: 2,
      head: 'head',
      branch: 'branch',
      appVersion: '1.0.0',
      digest: 'changed',
      files: [],
    }),
  }), /source tree changed while existing structural package was being revalidated/)
})
