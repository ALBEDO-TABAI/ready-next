import assert from 'node:assert/strict'
import test from 'node:test'
import { Readable } from 'node:stream'
import { gzipSync } from 'node:zlib'
import { fetchPublic, publicAddress, publicURL, resolvePublicAddresses } from '../main/modules/link-preview/fetch-public'
import { parsePreview } from '../main/modules/link-preview'

test('preview rejects internal literals and every redirect before contacting it', async () => {
  for (const url of ['http://198.18.0.1', 'http://198.19.255.255', 'http://127.0.0.1', 'http://2130706433', 'http://[::1]', 'http://[::ffff:127.0.0.1]', 'http://169.254.169.254', 'http://localhost.', 'file:///etc/passwd', 'https://user:secret@example.com']) assert.throws(() => publicURL(url))
  for (const ip of ['10.0.0.1', '100.64.0.1', '192.168.1.1', 'fc00::1', 'fe80::1', '2002:7f00:1::']) assert.equal(publicAddress(ip), false)
  assert.equal(publicAddress('8.8.8.8'), true)
  let calls = 0
  await assert.rejects(fetchPublic('https://example.com', { transport: async () => {
    calls++; return { status: 302, location: 'http://127.0.0.1/secret', type: '', body: Readable.from([]) }
  } }), /内网地址/)
  assert.equal(calls, 1)
  await assert.rejects(resolvePublicAddresses('public.example', async () => [{ address: '8.8.8.8', family: 4 }, { address: '127.0.0.1', family: 4 }]), /内网地址/)
  await assert.rejects(resolvePublicAddresses('public.example', async () => [{ address: '::ffff:192.168.1.1', family: 6 }]), /内网地址/)
})

test('fake-IP requires a domain, safe answers and a fake-IP control; the control expires in two minutes', async () => {
  let control = '198.18.0.2', probes = 0, time = 0
  let answers = ['198.19.255.254', '8.8.8.8']
  const resolver = async (host: string) => {
    if (host === 'example.com') { probes++; return [{ address: control, family: 4 }] }
    return (host === 'internal.example' ? ['10.0.0.1'] : answers).map(address => ({ address, family: 4 }))
  }
  const resolve = (host = 'preview.example') => resolvePublicAddresses(host, resolver, () => time)
  assert.equal((await resolve()).length, 2)
  await resolve(); assert.equal(probes, 1)
  for (const host of ['198.18.0.1', '198.19.255.255']) await assert.rejects(resolve(host), /内网地址/)
  for (const address of ['10.0.0.1', '192.168.0.1', '203.0.113.1']) {
    answers = ['198.18.0.3', address]
    await assert.rejects(resolve(), /内网地址/)
  }
  answers = ['198.18.0.3']; control = '8.8.8.8'; time = 120000
  await assert.rejects(resolve(), /内网地址/); assert.equal(probes, 2)
  await assert.rejects(resolve(), /内网地址/); assert.equal(probes, 2)
  control = '198.18.0.2'; time = 240000
  await resolve(); assert.equal(probes, 3)
  await assert.rejects(fetchPublic('https://preview.example', { transport: async url => {
    await resolve(url.hostname)
    return { status: 302, location: 'http://192.168.0.1/secret', type: '', body: Readable.from([]) }
  } }), /内网地址/)
  await assert.rejects(fetchPublic('https://preview.example', { transport: async url => {
    await resolve(url.hostname)
    return { status: 302, location: 'https://internal.example/secret', type: '', body: Readable.from([]) }
  } }), /内网地址/)
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
