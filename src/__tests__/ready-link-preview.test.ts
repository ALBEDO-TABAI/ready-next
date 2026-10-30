import assert from 'node:assert/strict'
import test from 'node:test'
import { Readable } from 'node:stream'
import { gzipSync } from 'node:zlib'
import { fetchPublic, publicAddress, publicURL, resolvePublicAddresses } from '../main/modules/link-preview/fetch-public'
import { parsePreview } from '../main/modules/link-preview'

test('preview rejects internal literals and every redirect before contacting it', async () => {
  for (const url of ['http://127.0.0.1', 'http://2130706433', 'http://[::1]', 'http://[::ffff:127.0.0.1]', 'http://169.254.169.254', 'http://localhost.', 'file:///etc/passwd', 'https://user:secret@example.com']) assert.throws(() => publicURL(url))
  for (const ip of ['10.0.0.1', '100.64.0.1', '192.168.1.1', 'fc00::1', 'fe80::1', '2002:7f00:1::']) assert.equal(publicAddress(ip), false)
  assert.equal(publicAddress('8.8.8.8'), true)
  let calls = 0
  await assert.rejects(fetchPublic('https://example.com', { transport: async () => {
    calls++; return { status: 302, location: 'http://127.0.0.1/secret', type: '', body: Readable.from([]) }
  } }), /public/)
  assert.equal(calls, 1)
  await assert.rejects(resolvePublicAddresses('public.example', async () => [{ address: '8.8.8.8', family: 4 }, { address: '127.0.0.1', family: 4 }]), /Private/)
  await assert.rejects(resolvePublicAddresses('public.example', async () => [{ address: '::ffff:192.168.1.1', family: 6 }]), /Private/)
})
test('preview timeout and decompressed byte limit apply to the entire response', async () => {
  await assert.rejects(fetchPublic('https://example.com', { timeoutMs: 10, transport: async () => new Promise(() => undefined) }), /timed out/)
  await assert.rejects(fetchPublic('https://example.com', { maxBytes: 100, transport: async () => ({
    status: 200, type: 'text/html', encoding: 'gzip', body: Readable.from([gzipSync(Buffer.alloc(10000, 65))]),
  }) }), /too large/)
})
test('preview is inert text; unsafe images and publisher scripts never run', () => {
  const preview = parsePreview('<title>Safe title</title><meta property="og:description" content="&lt;img src=x onerror=alert(1)&gt;"><meta property="og:image" content="javascript:alert(1)"><script>throw new Error("executed")</script>', 'https://example.com')
  assert.equal(preview.title, 'Safe title')
  assert.equal(preview.description, '<img src=x onerror=alert(1)>')
  assert.equal(preview.imageUrl, undefined)
})
