import { deflateSync } from 'node:zlib'

/** A real, tiny PNG (grey pixels), built here so no binary fixture is checked in. */
export function png(width = 2, height = 2): Buffer {
  const chunk = (type: string, data: Buffer) => {
    const body = Buffer.concat([Buffer.from(type, 'latin1'), data]), out = Buffer.alloc(body.length + 8)
    out.writeUInt32BE(data.length, 0); body.copy(out, 4)
    let crc = 0xffffffff
    for (const byte of body) { crc ^= byte; for (let k = 0; k < 8; k++) crc = crc & 1 ? (crc >>> 1) ^ 0xedb88320 : crc >>> 1 }
    out.writeUInt32BE((crc ^ 0xffffffff) >>> 0, body.length + 4)
    return out
  }
  const header = Buffer.alloc(13); header.writeUInt32BE(width, 0); header.writeUInt32BE(height, 4); header.set([8, 2, 0, 0, 0], 8)
  return Buffer.concat([Buffer.from('89504e470d0a1a0a', 'hex'), chunk('IHDR', header), chunk('IDAT', deflateSync(Buffer.alloc((width * 3 + 1) * height, 0x80))), chunk('IEND', Buffer.alloc(0))])
}
