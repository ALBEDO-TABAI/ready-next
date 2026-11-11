import { readFileSync } from 'node:fs'

export const escapeHtml = value =>
  String(value ?? '').replace(
    /[&<>"']/g,
    c =>
      ({
        '&': '&amp;',
        '<': '&lt;',
        '>': '&gt;',
        '"': '&quot;',
        "'": '&#39;',
      })[c],
  )

// Only local template keys are expanded here; ORIGIN_* belongs to the response writer.
export function template(path, values = {}) {
  const source = readFileSync(new URL(`../sites/${path}`, import.meta.url), 'utf8')
  return source.replace(/\{\{([a-z][a-zA-Z0-9_]*)\}\}/g, (_, key) => {
    if (!Object.hasOwn(values, key)) throw new Error(`模板 ${path} 缺少 ${key}`)
    return String(values[key])
  })
}
