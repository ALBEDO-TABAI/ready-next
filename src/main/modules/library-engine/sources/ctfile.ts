import { writeFile } from 'node:fs/promises'
import { join, extname } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { z } from 'zod'
import type { DownloadContext } from '../source-jobs'
import { epubFromArchive, epubFromZip } from './ctfile-archive'
export const CTFILE_SENTINEL = 'READY_OPTIONAL_CTFILE_IMPLEMENTATION_V1'
const API = 'https://urlapi.ctfile.com/api/v2'
const USER_AGENT = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36'
const MAX_ARCHIVE = 256 * 1024 * 1024
const payloadSchema = z.object({ code: z.number().optional(), msg: z.string().optional(), message: z.string().optional(), data: z.unknown().optional() })
const addressSchema = z.object({ code: z.number(), downurl: z.string().optional(), message: z.string().optional(), msg: z.string().optional(), remaining_seconds: z.coerce.number().optional(), requires_captcha: z.boolean().optional(), challenge_type: z.string().optional() })
const fileSchema = z.object({ file_name: z.string(), file_size_bytes: z.coerce.number().positive(), verifycode: z.union([z.string(), z.number()]).optional(), file_id: z.union([z.string(), z.number()]), userid: z.union([z.string(), z.number()]), file_chk: z.string(), start_time: z.coerce.number().nonnegative().optional(), wait_seconds: z.coerce.number().nonnegative().default(0) })
export function parseLink(link: string): { origin: string; id: string; passcode: string; link: string } {
  const url = new URL(link), match = url.pathname.match(/^\/f\/([\w-]+)\/?$/)
  if (url.protocol !== 'https:' || url.username || url.password || url.port || !/(^|\.)ctfile\.com$/i.test(url.hostname) || !match) throw new Error('不是有效的城通网盘文件链接')
  return { origin: url.origin, id: match[1], passcode: url.searchParams.get('p') || '', link }
}
async function bytes(response: Response, limit: number): Promise<Buffer> {
  if (!response.body) throw new Error('下载响应为空')
  const reader = response.body.getReader(), chunks: Uint8Array[] = []
  let length = 0
  try {
    while (true) {
      const part = await reader.read(); if (part.done) break
      length += part.value.length
      if (length > limit) throw new Error('下载内容超过大小限制')
      chunks.push(part.value)
    }
    return Buffer.concat(chunks)
  } finally { await reader.cancel() }
}
export async function downloadCtfile(link: string, directory: string, signal: AbortSignal, context: DownloadContext, request: typeof fetch = fetch): Promise<string> {
  const share = parseLink(link)
  const requestContext = { kind: 'file', id: share.id, folder_id: '0', fk: '', passcode: share.passcode, type_id: '0' }
  const fetchFile = (url: string, options: RequestInit = {}) => {
    if (new URL(url).protocol !== 'https:') throw new Error('下载地址必须使用 HTTPS')
    const headers = new Headers(options.headers)
    headers.set('user-agent', USER_AGENT)
    if (!headers.has('referer')) headers.set('referer', share.link)
    return request(url, { ...options, headers, signal: AbortSignal.any([signal, AbortSignal.timeout(120_000)]) })
  }
  const call = async (route: string, params?: Record<string, string>, body?: unknown) => {
    const url = new URL(API + route)
    for (const [key, value] of Object.entries(params || {})) url.searchParams.set(key, value)
    const response = await fetchFile(url.href, { method: body ? 'POST' : 'GET', headers: { origin: share.origin, referer: share.link, 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined })
    return payloadSchema.parse(await response.json())
  }
  const resource = await call('/resource', requestContext)
  if (resource.code !== 200) throw new Error(resource.message || resource.msg || '分享已失效或提取码不正确')
  const data = z.object({ file: fileSchema, capabilities: z.object({ download: z.boolean().optional(), canDownload: z.boolean().optional(), vip_required: z.boolean().optional() }).default({}) }).parse(resource.data)
  if (data.capabilities.download === false || data.capabilities.canDownload === false || data.capabilities.vip_required) throw new Error('这个分享不允许访客下载')
  const file = data.file
  const wait = async (seconds: number) => {
    if (!Number.isFinite(seconds) || seconds < 0 || seconds > 600) throw new Error('网盘等待时间异常')
    for (let left = Math.ceil(seconds); left > 0; left--) {
      context.progress(0, `网盘要求等 ${left} 秒`); await delay(1000, undefined, { signal })
    }
  }
  const elapsed = file.start_time === undefined ? 0 : Math.max(0, Date.now() / 1000 - file.start_time)
  await wait(Math.max(0, file.wait_seconds - elapsed))
  let answer: { challenge: string; captcha_answer: string } | undefined
  let downloadUrl: string | undefined
  for (let n = 0; n < 12; n++) {
    const response = await call('/download', undefined, { context: requestContext, mb: false, app: false, verifycode: String(file.verifycode || ''), ...answer, original_file: { file_id: file.file_id, userid: file.userid, file_chk: file.file_chk, start_time: file.start_time, wait_seconds: file.wait_seconds } })
    const raw = z.record(z.string(), z.unknown()).parse(response.data ?? response)
    const result = addressSchema.parse({ ...raw, code: raw.code ?? response.code })
    if (result.code === 200 && result.downurl) { downloadUrl = result.downurl; break }
    if (result.code === 218) { await wait(result.remaining_seconds ?? 5); continue }
    if (result.code === 217 || result.requires_captcha) {
      const cap = await call('/captcha', { type: result.challenge_type || 'download' })
      const challenge = z.object({ challenge: z.string(), image_url: z.string() }).parse(cap.data)
      const image = await fetchFile(new URL(challenge.image_url, API + '/').href)
      const mime = image.headers.get('content-type')?.split(';')[0]
      if (!image.ok || !mime || !['image/png', 'image/jpeg', 'image/webp', 'image/gif'].includes(mime)) throw new Error('验证码图片无效')
      answer = { challenge: challenge.challenge, captcha_answer: await context.captcha(`data:${mime};base64,${(await bytes(image, 2 * 1024 * 1024)).toString('base64')}`) }
      continue
    }
    throw new Error(result.message || result.msg || `网盘拒绝下载（${result.code}），请手动下载`)
  }
  if (!downloadUrl) throw new Error(`${CTFILE_SENTINEL}: 网盘一直没有返回下载地址`)
  const url = downloadUrl
  let downloaded = 0
  const entry = extname(file.file_name).toLowerCase() === '.zip' ? await epubFromZip({
    size: file.file_size_bytes,
    read: async (start, end) => {
      if (!Number.isSafeInteger(start) || start < 0 || end < start || end >= file.file_size_bytes) throw new Error('ZIP 字节范围无效')
      const response = await fetchFile(url, { headers: { Range: `bytes=${start}-${end}`, referer: share.link } })
      if (response.status !== 206 || response.headers.get('content-range') !== `bytes ${start}-${end}/${file.file_size_bytes}`) {
        await response.body?.cancel(); throw new Error('服务器不支持准确的分段下载，请去网盘手动下载')
      }
      const chunk = await bytes(response, end - start + 1)
      if (chunk.length !== end - start + 1) throw new Error('分段下载不完整')
      downloaded += chunk.length; context.progress(Math.min(95, downloaded / file.file_size_bytes * 100), '正在取回 EPUB')
      return chunk
    },
  }) : await (async () => {
    if (file.file_size_bytes > MAX_ARCHIVE) throw new Error('压缩包过大，请手动下载')
    const response = await fetchFile(url)
    if (!response.ok) throw new Error(`下载失败 HTTP ${response.status}`)
    const archive = await bytes(response, MAX_ARCHIVE)
    if (archive.length !== file.file_size_bytes) throw new Error('下载不完整')
    context.extracting()
    if (extname(file.file_name).toLowerCase() === '.epub') return { name: file.file_name, bytes: archive }
    return epubFromArchive(archive, directory, signal)
  })()
  const path = join(directory, 'book.epub')
  await writeFile(path, entry.bytes)
  return path
}
