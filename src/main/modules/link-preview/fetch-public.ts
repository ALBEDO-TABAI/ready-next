import http from 'node:http'
import https from 'node:https'
import { lookup } from 'node:dns/promises'
import { BlockList, isIP } from 'node:net'
import { createBrotliDecompress, createGunzip, createInflate } from 'node:zlib'
import type { Readable } from 'node:stream'

const blocked = new BlockList()
for (const [address, prefix] of [
  ['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8],
  ['169.254.0.0', 16], ['172.16.0.0', 12], ['192.0.0.0', 24], ['192.0.2.0', 24],
  ['192.168.0.0', 16], ['198.18.0.0', 15], ['198.51.100.0', 24], ['203.0.113.0', 24], ['224.0.0.0', 3],
] as const) blocked.addSubnet(address, prefix, 'ipv4')
const globalV6 = new BlockList()
globalV6.addSubnet('2000::', 3, 'ipv6')
for (const [address, prefix] of [['2001::', 23], ['2001:db8::', 32], ['2002::', 16], ['3fff::', 20]] as const) blocked.addSubnet(address, prefix, 'ipv6')
export function publicAddress(address: string): boolean {
  const family = isIP(address)
  return family === 4 ? !blocked.check(address, 'ipv4')
    : family === 6 && globalV6.check(address, 'ipv6') && !blocked.check(address, 'ipv6')
}
export function publicURL(input: string, base?: string): URL {
  const url = new URL(input, base), host = url.hostname.replace(/^\[|\]$/g, '').toLowerCase().replace(/\.$/, '')
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password
    || (url.port && !['80', '443'].includes(url.port)) || host === 'localhost' || host.endsWith('.localhost')
    || (!host.includes('.') && !isIP(host)) || (isIP(host) && !publicAddress(host))) throw new Error('Only public web addresses are allowed')
  url.hash = ''
  return url
}
export async function resolvePublicAddresses(host: string, resolver: (host: string) => Promise<Array<{ address: string; family: number }>> = host => lookup(host, { all: true })) {
  const addresses = await resolver(host)
  if (!addresses.length || addresses.some(address => !publicAddress(address.address))) throw new Error('Private network address rejected')
  return addresses
}
export interface PublicResponse { url: string; type: string; body: Buffer }
export interface PublicTransportResponse { status: number; location?: string; type: string; encoding?: string; body: Readable }
export type PublicTransport = (url: URL, signal: AbortSignal) => Promise<PublicTransportResponse>
const requestPublic: PublicTransport = (url, signal) => new Promise((resolve, reject) => {
  const request = (url.protocol === 'https:' ? https : http).get(url, {
    signal, agent: false, headers: { 'user-agent': 'Ready-LinkPreview/1.0', 'accept-encoding': 'gzip, deflate, br' },
    // DNS is resolved and checked at the actual connection, not in a separate preflight.
    lookup(host, options, callback) {
      resolvePublicAddresses(host).then(addresses => {
        if (options.all) callback(null, addresses)
        else callback(null, addresses[0].address, addresses[0].family)
      }).catch(error => callback(error, []))
    },
  }, response => resolve({ status: response.statusCode || 0, location: response.headers.location,
    type: response.headers['content-type'] || '', encoding: response.headers['content-encoding'], body: response }))
  request.on('error', reject)
})

export async function fetchPublic(input: string, options: { timeoutMs?: number; maxBytes?: number; transport?: PublicTransport } = {}): Promise<PublicResponse> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(new Error('Preview timed out')), options.timeoutMs ?? 8000)
  const maxBytes = options.maxBytes ?? 3 * 1024 * 1024
  let stream: Readable | undefined
  const run = async (): Promise<PublicResponse> => {
    let url = publicURL(input)
    for (let hop = 0; hop <= 4; hop++) {
      const response = await (options.transport ?? requestPublic)(url, controller.signal)
      stream = response.body
      if (controller.signal.aborted) { stream.destroy(); throw controller.signal.reason }
      if (response.status >= 300 && response.status < 400 && response.location) {
        stream.destroy(); url = publicURL(response.location, url.href); continue
      }
      if (response.status < 200 || response.status >= 300) throw new Error(`Preview HTTP ${response.status}`)
      const encoding = response.encoding?.toLowerCase()
      const decoder = encoding === 'gzip' ? createGunzip() : encoding === 'br' ? createBrotliDecompress() : encoding === 'deflate' ? createInflate() : undefined
      if (encoding && encoding !== 'identity' && !decoder) throw new Error('Unsupported content encoding')
      const decoded = decoder ? stream.pipe(decoder) : stream
      if (decoder) stream.on('error', error => decoder.destroy(error))
      const chunks: Buffer[] = []; let size = 0
      try {
        for await (const chunk of decoded) {
          const bytes = Buffer.from(chunk); size += bytes.length
          if (size > maxBytes) throw new Error('Preview resource too large')
          chunks.push(bytes)
        }
        return { url: url.href, type: response.type, body: Buffer.concat(chunks) }
      } finally { decoded.destroy(); stream.destroy() }
    }
    throw new Error('Too many redirects')
  }
  let onAbort: () => void = () => undefined
  const aborted = new Promise<never>((_, reject) => {
    onAbort = () => { stream?.destroy(controller.signal.reason); reject(controller.signal.reason) }
    controller.signal.addEventListener('abort', onAbort, { once: true })
  })
  try { return await Promise.race([run(), aborted]) }
  finally { clearTimeout(timer); controller.signal.removeEventListener('abort', onAbort); stream?.destroy() }
}
