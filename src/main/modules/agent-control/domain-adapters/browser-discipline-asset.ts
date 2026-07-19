import { createHash } from 'node:crypto'
import type { ToolDefinition } from '../tools-runtime/tool-definition'
import { PromptAssetLoader } from '../prompt-assets/loader'
import { promptAssetRoots } from '../prompt-assets/roots'

export const BROWSER_DISCIPLINE_MAJOR = 6
export const MAX_BROWSER_TEXT_ACTIVATION_CHARS = 64_000

export interface BrowserDisciplineBundle {
  major: number
  digest: string
  text: string
  toolCount: number
  textCatalogChars: number
}

let cachedDiscipline: string | null = null

export function loadBrowserDisciplineText(): string {
  if (cachedDiscipline !== null) return cachedDiscipline
  const loader = new PromptAssetLoader({ roots: promptAssetRoots() })
  cachedDiscipline = loader.render('browser/discipline').trim()
  if (!cachedDiscipline) throw new Error('browser_discipline_asset_empty')
  return cachedDiscipline
}

function trustedBrowserPageFacts(requestEnvelope: unknown): Record<string, unknown> | null {
  if (!requestEnvelope || typeof requestEnvelope !== 'object' || Array.isArray(requestEnvelope)) return null
  const hints = (requestEnvelope as { environmentHints?: unknown }).environmentHints
  if (!hints || typeof hints !== 'object' || Array.isArray(hints)) return null
  const page = (hints as { browserPageRef?: unknown }).browserPageRef
  if (!page || typeof page !== 'object' || Array.isArray(page)) return null
  const value = page as Record<string, unknown>
  const required = ['tabId', 'physicalTargetToken', 'mainFrameId', 'mainFrameDocumentToken'] as const
  if (required.some((key) => typeof value[key] !== 'string' || !String(value[key]).trim())) return null
  return {
    workbenchMode: (hints as { workbenchMode?: unknown }).workbenchMode === 'browser' ? 'browser' : null,
    tabId: value.tabId,
  }
}

export function formatCompleteTextToolCatalog(definitions: readonly ToolDefinition[]): string {
  return definitions.map((definition) => JSON.stringify({
    name: definition.name,
    description: definition.description || definition.name,
    parameters: definition.schema && definition.schema.type === 'object'
      ? definition.schema
      : { type: 'object', properties: {}, additionalProperties: false },
  })).join('\n')
}

/** Single source for initial Browser exposure and same-run `use_browser` activation. */
export function buildBrowserDisciplineBundle(input: {
  definitions: readonly ToolDefinition[]
  requestEnvelope: unknown
  activation: 'initial' | 'same_run'
  includeCompleteTextCatalog: boolean
}): BrowserDisciplineBundle {
  const discipline = loadBrowserDisciplineText()
  const pageFacts = trustedBrowserPageFacts(input.requestEnvelope)
  const catalog = input.includeCompleteTextCatalog
    ? formatCompleteTextToolCatalog(input.definitions)
    : ''
  const text = [
    `Browser activation fact: ${JSON.stringify({
      contract: 'ready_browser_activation_v1',
      activation: input.activation,
      disciplineMajor: BROWSER_DISCIPLINE_MAJOR,
      page: pageFacts,
    })}`,
    discipline,
    catalog ? `Complete text-tool catalog (one complete JSON object per line):\n${catalog}` : '',
  ].filter(Boolean).join('\n\n')
  if (input.includeCompleteTextCatalog && text.length > MAX_BROWSER_TEXT_ACTIVATION_CHARS) {
    throw new Error(`browser_text_activation_budget_exceeded:${text.length}`)
  }
  return {
    major: BROWSER_DISCIPLINE_MAJOR,
    digest: createHash('sha256').update(text).digest('hex'),
    text,
    toolCount: input.definitions.length,
    textCatalogChars: catalog.length,
  }
}
