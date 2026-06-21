export type BrowserReadonlyScriptTemplateName =
  | 'read_text'
  | 'read_attr'
  | 'read_all_text'
  | 'count_selector'
  | 'exists_selector'
  | 'read_rect'
  | 'read_meta'

export interface BrowserReadonlyScriptTemplateRequest {
  template: string
  selector?: unknown
  attr?: unknown
  name?: unknown
}

export type BrowserReadonlyScriptTemplateResult =
  | { ok: true; template: BrowserReadonlyScriptTemplateName; code: string }
  | { ok: false; reason: string; template?: string }

const TEMPLATE_NAMES: readonly BrowserReadonlyScriptTemplateName[] = [
  'read_text',
  'read_attr',
  'read_all_text',
  'count_selector',
  'exists_selector',
  'read_rect',
  'read_meta',
]

function templateName(value: unknown): BrowserReadonlyScriptTemplateName | null {
  const raw = typeof value === 'string' ? value.trim() : ''
  return (TEMPLATE_NAMES as readonly string[]).includes(raw)
    ? raw as BrowserReadonlyScriptTemplateName
    : null
}

function nonEmptyString(value: unknown): string {
  return typeof value === 'string' ? value.trim() : ''
}

function js(value: unknown): string {
  return JSON.stringify(value)
}

function wrapTemplate(template: BrowserReadonlyScriptTemplateName, body: string): string {
  return `
    (() => {
      const __READY_READONLY_SCRIPT_TEMPLATE__ = ${js(template)}
      void __READY_READONLY_SCRIPT_TEMPLATE__
      ${body}
    })()
  `
}

export function compileBrowserReadonlyScriptTemplate(
  request: BrowserReadonlyScriptTemplateRequest,
): BrowserReadonlyScriptTemplateResult {
  const name = templateName(request.template)
  if (!name) return { ok: false, reason: 'unknown_template', template: request.template }

  if (name === 'read_meta') {
    const metaName = nonEmptyString(request.name)
    if (!metaName) return { ok: false, reason: 'missing_name', template: name }
    return {
      ok: true,
      template: name,
      code: wrapTemplate(name, `
        const name = ${js(metaName)}
        if (name === 'title') return document.title || ''
        if (name === 'href') return location.href || ''
        if (name === 'readyState') return document.readyState || ''
        const wanted = name.startsWith('meta:') ? name.slice(5) : name
        const metas = Array.from(document.querySelectorAll('meta'))
        const found = metas.find((item) => item.getAttribute('name') === wanted || item.getAttribute('property') === wanted)
        return found?.getAttribute('content') ?? null
      `),
    }
  }

  const selector = nonEmptyString(request.selector)
  if (!selector) return { ok: false, reason: 'missing_selector', template: name }

  if (name === 'read_text') {
    return {
      ok: true,
      template: name,
      code: wrapTemplate(name, `
        const el = document.querySelector(${js(selector)})
        return el?.textContent ?? null
      `),
    }
  }

  if (name === 'read_attr') {
    const attr = nonEmptyString(request.attr)
    if (!attr) return { ok: false, reason: 'missing_attr', template: name }
    return {
      ok: true,
      template: name,
      code: wrapTemplate(name, `
        const el = document.querySelector(${js(selector)})
        return el?.getAttribute(${js(attr)}) ?? null
      `),
    }
  }

  if (name === 'read_all_text') {
    return {
      ok: true,
      template: name,
      code: wrapTemplate(name, `
        return Array.from(document.querySelectorAll(${js(selector)})).map((el) => el.textContent ?? '')
      `),
    }
  }

  if (name === 'count_selector') {
    return {
      ok: true,
      template: name,
      code: wrapTemplate(name, `
        return document.querySelectorAll(${js(selector)}).length
      `),
    }
  }

  if (name === 'exists_selector') {
    return {
      ok: true,
      template: name,
      code: wrapTemplate(name, `
        return Boolean(document.querySelector(${js(selector)}))
      `),
    }
  }

  return {
    ok: true,
    template: name,
    code: wrapTemplate(name, `
      const el = document.querySelector(${js(selector)})
      if (!el) return null
      const rect = el.getBoundingClientRect()
      return {
        x: rect.x,
        y: rect.y,
        width: rect.width,
        height: rect.height,
        top: rect.top,
        right: rect.right,
        bottom: rect.bottom,
        left: rect.left,
      }
    `),
  }
}
