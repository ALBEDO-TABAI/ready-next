export async function readBody(req) {
  const parts = []
  let size = 0
  for await (const part of req) {
    size += part.length
    if (size > 8 * 1024 * 1024) throw new Error('请求超过 8MB')
    parts.push(part)
  }
  const bytes = Buffer.concat(parts)
  const type = req.headers['content-type'] || ''
  if (type.startsWith('application/json'))
    return { fields: JSON.parse(bytes.toString()), files: [] }
  if (!type.startsWith('multipart/form-data'))
    return { fields: Object.fromEntries(new URLSearchParams(bytes.toString())), files: [] }
  const boundary = /boundary=(?:"([^"]+)"|([^;]+))/.exec(type)
  if (!boundary) throw new Error('缺少 multipart boundary')
  const marker = Buffer.from(`--${boundary[1] || boundary[2]}`)
  const fields = {}
  const files = []
  let start = bytes.indexOf(marker)
  while (start !== -1) {
    start += marker.length
    if (bytes.subarray(start, start + 2).toString() === '--') break
    const next = bytes.indexOf(Buffer.concat([Buffer.from('\r\n'), marker]), start)
    const headerEnd = bytes.indexOf('\r\n\r\n', start)
    if (next === -1 || headerEnd === -1 || headerEnd >= next) throw new Error('无效 multipart')
    const headers = bytes.subarray(start, headerEnd).toString()
    const name = /\bname="([^"]+)"/.exec(headers)?.[1]
    const filename = /\bfilename="([^"]*)"/.exec(headers)?.[1]
    const data = bytes.subarray(headerEnd + 4, next)
    if (name && filename !== undefined) files.push({ field: name, filename, bytes: data })
    else if (name) fields[name] = data.toString()
    start = next + 2
  }
  return { fields, files }
}
