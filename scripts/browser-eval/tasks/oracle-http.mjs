import { request } from 'node:http'
import { readFile } from 'node:fs/promises'
import { basename } from 'node:path'

export function createOracleHttp() {
  const cookies = new Map()
  async function send(address, method = 'GET', body, headers = {}, redirects = 0) {
    const url = new URL(address)
    if (url.protocol !== 'http:' || url.hostname !== '127.0.0.1')
      throw new Error('oracle 仅允许回环 HTTP')
    if (redirects > 10) throw new Error('重定向过多')
    const jar = cookies.get(url.origin) || new Map()
    const response = await new Promise((resolve, reject) => {
      const req = request(
        url,
        {
          method,
          headers: {
            ...headers,
            ...(jar.size
              ? { Cookie: [...jar].map(([key, value]) => `${key}=${value}`).join('; ') }
              : {}),
            ...(body ? { 'Content-Length': body.length } : {}),
          },
        },
        res => {
          const chunks = []
          res.on('data', chunk => chunks.push(chunk))
          res.on('error', reject)
          res.on('end', () => {
            const buffer = Buffer.concat(chunks)
            resolve({
              status: res.statusCode,
              headers: res.headers,
              text: buffer.toString(),
              buffer,
            })
          })
        },
      )
      req.setTimeout(10000, () => req.destroy(new Error('HTTP 请求超时')))
      req.on('error', reject)
      req.end(body)
    })
    for (const cookie of response.headers['set-cookie'] || []) {
      const [pair] = cookie.split(';')
      const split = pair.indexOf('=')
      if (pair.slice(split + 1)) jar.set(pair.slice(0, split), pair.slice(split + 1))
      else jar.delete(pair.slice(0, split))
    }
    cookies.set(url.origin, jar)
    if ([302, 303].includes(response.status) && response.headers.location)
      return send(new URL(response.headers.location, url).href, 'GET', undefined, {}, redirects + 1)
    return response
  }
  return {
    setCookie({ name, value, url }) {
      const origin = new URL(url).origin
      const jar = cookies.get(origin) || new Map()
      jar.set(name, value)
      cookies.set(origin, jar)
    },
    get: url => send(url),
    postForm: (url, fields) =>
      send(url, 'POST', Buffer.from(new URLSearchParams(fields).toString()), {
        'Content-Type': 'application/x-www-form-urlencoded',
      }),
    postJson: (url, body) =>
      send(url, 'POST', Buffer.from(JSON.stringify(body)), { 'Content-Type': 'application/json' }),
    async postMultipart(url, fields, files) {
      const boundary = 'ready-eval-multipart-boundary-2026'
      const chunks = []
      for (const [key, value] of Object.entries(fields))
        chunks.push(
          Buffer.from(
            `--${boundary}\r\nContent-Disposition: form-data; name="${key}"\r\n\r\n${value}\r\n`,
          ),
        )
      for (const file of files) {
        const bytes = file.buffer || file.bytes || (await readFile(file.path))
        const name = file.filename || file.name || basename(file.path)
        chunks.push(
          Buffer.from(
            `--${boundary}\r\n` +
              `Content-Disposition: form-data; name="${file.field || 'file'}"; filename="${name}"\r\n` +
              `Content-Type: ${file.contentType || 'application/octet-stream'}\r\n\r\n`,
          ),
          bytes,
          Buffer.from('\r\n'),
        )
      }
      chunks.push(Buffer.from(`--${boundary}--\r\n`))
      return send(url, 'POST', Buffer.concat(chunks), {
        'Content-Type': `multipart/form-data; boundary=${boundary}`,
      })
    },
  }
}
