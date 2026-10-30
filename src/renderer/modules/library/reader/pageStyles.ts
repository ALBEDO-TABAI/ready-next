/** DOM and WebGL use one sheet stylesheet. SVG rasters cannot fetch web fonts. */
let pending: Promise<string> | undefined
export function pageStyles(): Promise<string> {
  if (!pending) {
    pending = Promise.all([
      fetch(new URL('./page.css', import.meta.url)).then(response => { if (!response.ok) throw new Error('书页样式读取失败'); return response.text() }),
      fetch(new URL('../../../design/next/fonts/GeistMono.woff2', import.meta.url)).then(response => { if (!response.ok) throw new Error('书页字体读取失败'); return response.arrayBuffer() }),
    ]).then(([css, font]) => {
      let binary = ''
      const bytes = new Uint8Array(font)
      for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000))
      return `@font-face { font-family: 'RN Mono'; src: url(data:font/woff2;base64,${btoa(binary)}) format('woff2'); font-weight: 100 900; }\n${css}`
    }).catch(error => { pending = undefined; throw error })
  }
  return pending
}
