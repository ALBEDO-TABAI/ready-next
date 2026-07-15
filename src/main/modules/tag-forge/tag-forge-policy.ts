import { existsSync,readFileSync } from 'fs'
import { join,resolve } from 'path'
import { parse as parseYaml } from 'yaml'

export const TAG_FACETS = ['form', 'domain', 'entity', 'use', 'state'] as const
export type TagFacet = typeof TAG_FACETS[number]

export interface TagLexiconEntry {
  id: string
  facet: TagFacet
  label: string
  aliases: string[]
  definition?: string
  status: 'active' | 'pending' | 'deprecated'
}

export interface TagForgePolicy {
  version: string
  tagsPerDoc: [number, number]
  automaticState: string
  facetOpenness: Record<TagFacet, 'closed' | 'semi_open' | 'open'>
  explicitAutoAdmitConfidence: number
  explicitReviewConfidence: number
  explicitAutoAdmitFacets: TagFacet[]
  broadLabelBlacklist: string[]
  entries: TagLexiconEntry[]
}

export interface TagProposal {
  facet: TagFacet
  label: string
  evidenceCode: string
  evidenceExcerpt?: string | null
  confidence: number
}

export interface ValidatedTag {
  tagId: string
  facet: TagFacet
  label: string
  confidence: number
  evidenceCode: string
  resolution: 'exact' | 'alias' | 'pending'
}

export interface TagValidationResult {
  active: ValidatedTag[]
  pending: TagProposal[]
  rejected: Array<{ proposal: TagProposal; reason: string }>
  contentComplete: boolean
  missingContentFacets: Array<'form' | 'topic'>
  sparse: boolean
}

export interface RejectedTagProposal {
  facet: TagFacet
  label: string
}

export function evaluateControlledContentLabels(
  policy: TagForgePolicy,
  labels: readonly string[],
  overlay: readonly TagLexiconEntry[] = [],
): { complete: boolean; facets: TagFacet[]; formCount: number } {
  const entries = [...policy.entries, ...overlay].filter((entry) => entry.status === 'active' && entry.facet !== 'state')
  assertUniqueActiveTagSurfaces(entries)
  const matched = labels.flatMap((label) => resolveActiveTagEntry(entries, label) ?? [])
  const facets = [...new Set(matched.map((entry) => entry.facet))]
  const formCount = new Set(matched.filter((entry) => entry.facet === 'form').map((entry) => entry.id)).size
  return { complete: formCount === 1 && (facets.includes('domain') || facets.includes('entity')), facets, formCount }
}

export function resolveTagForgeLexiconPath():string{
  const resources=(process as NodeJS.Process&{resourcesPath?:string}).resourcesPath
  const candidates=[resources?join(resources,'embedded-skills/tag-forge/tag-lexicon.yaml'):'',resolve(process.cwd(),'assets/embedded-skills/tag-forge/tag-lexicon.yaml')].filter(Boolean)
  const found=candidates.find(existsSync);if(!found)throw new Error('tag-forge lexicon resource missing');return found
}
export function loadTagForgePolicy(path = resolveTagForgeLexiconPath()): TagForgePolicy {
  const parsed = parseYaml(readFileSync(path, 'utf8')) as Record<string, any>
  const config = parsed.config ?? {}
  const openness = config.facet_openness ?? {}
  const entries = Array.isArray(parsed.entries) ? parsed.entries.map(normalizeEntry).filter(Boolean) as TagLexiconEntry[] : []
  assertUniqueActiveTagSurfaces(entries)
  return {
    version: String(parsed.version ?? '0'),
    tagsPerDoc: normalizePair(config.tags_per_doc, [2, 15]),
    automaticState: String(config.automatic_state || '待整理'),
    facetOpenness: Object.fromEntries(TAG_FACETS.map((facet) => [facet, normalizeOpenness(openness[facet])])) as TagForgePolicy['facetOpenness'],
    explicitAutoAdmitConfidence: normalizeConfidence(config.explicit_auto_admit_confidence, 0.92),
    explicitReviewConfidence: normalizeConfidence(config.explicit_review_confidence, 0.65),
    explicitAutoAdmitFacets: normalizeFacets(config.explicit_auto_admit_facets),
    broadLabelBlacklist: stringList(config.broad_label_blacklist),
    entries,
  }
}

export function validateTagProposals(
  policy: TagForgePolicy,
  proposals: readonly TagProposal[],
  mode: 'automatic' | 'explicit',
  overlay: readonly TagLexiconEntry[] = [],
  reviewedRejections: readonly RejectedTagProposal[] = [],
): TagValidationResult {
  const entries = [...policy.entries, ...overlay].filter((entry) => entry.status === 'active')
  assertUniqueActiveTagSurfaces(entries)
  const activeById = new Map<string, ValidatedTag>()
  const pendingByKey = new Map<string, TagProposal>()
  const rejected: TagValidationResult['rejected'] = []
  for (const raw of proposals) {
    const proposal = normalizeProposal(raw)
    if (!proposal) continue
    if (mode === 'automatic' && proposal.facet === 'state') {
      rejected.push({ proposal, reason: 'automatic_state_is_code_owned' })
      continue
    }
    if (mode === 'explicit' && proposal.facet === 'state') {
      rejected.push({ proposal, reason: 'workflow_state_is_not_content_tag' })
      continue
    }
    if (policy.broadLabelBlacklist.some((item) => same(item, proposal.label))) {
      rejected.push({ proposal, reason: 'broad_label_blacklisted' })
      continue
    }
    const resolved = resolveActiveTagEntry(entries, proposal.label)
    if (resolved && resolved.facet !== proposal.facet) {
      rejected.push({ proposal, reason: 'cross_facet_label_collision' })
      continue
    }
    if (resolved) {
      const exact = same(resolved.label, proposal.label)
      const candidate: ValidatedTag = { tagId: resolved.id, facet: resolved.facet, label: resolved.label, confidence: proposal.confidence, evidenceCode: proposal.evidenceCode, resolution: exact ? 'exact' : 'alias' }
      const current = activeById.get(resolved.id)
      if (!current || compareValidatedDedup(candidate, current) < 0) activeById.set(resolved.id, candidate)
      continue
    }
    if (reviewedRejections.some((item) => item.facet === proposal.facet && same(item.label, proposal.label))) {
      rejected.push({ proposal, reason: 'user_rejected_pending' })
      continue
    }
    if (mode === 'automatic' && policy.facetOpenness[proposal.facet] === 'closed') {
      rejected.push({ proposal, reason: 'closed_facet_unknown' })
      continue
    }
    if (mode === 'explicit' && proposal.confidence < policy.explicitReviewConfidence) {
      rejected.push({ proposal, reason: 'low_confidence_ignored' })
      continue
    }
    const key = proposalKey(proposal)
    const current = pendingByKey.get(key)
    if (!current || compareProposal(proposal, current) < 0) pendingByKey.set(key, proposal)
  }

  const active = [...activeById.values()]
  const candidates = [...pendingByKey.values()].sort(compareProposal)

  if (mode === 'automatic') {
    const state = entries.find((entry) => entry.facet === 'state' && entry.label === policy.automaticState)
    if (!state) throw new Error('automatic state is missing from active lexicon')
    active.push({ tagId: state.id, facet: 'state', label: state.label, confidence: 1, evidenceCode: 'automatic_new_document_state', resolution: 'exact' })
  }

  const selectedForm = active
    .filter((tag) => tag.facet === 'form')
    .sort(compareValidated)
    .slice(0, 1)
  const selectedTopic = active
    .filter((tag) => tag.facet === 'domain' || tag.facet === 'entity')
    .sort(compareValidated)
    .slice(0, 1)
  const requiredContentIds = new Set([...selectedForm, ...selectedTopic].map((tag) => tag.tagId))
  const selectedContent = [
    ...selectedForm,
    ...selectedTopic,
    ...active
      .filter((tag) => tag.facet !== 'state' && !requiredContentIds.has(tag.tagId))
      .sort(compareValidated)
      .slice(0, Math.max(0, policy.tagsPerDoc[1] - requiredContentIds.size)),
  ].sort((a, b) => TAG_FACETS.indexOf(a.facet) - TAG_FACETS.indexOf(b.facet) || compareValidated(a, b))
  const selectedState = active
    .filter((tag) => tag.facet === 'state')
    .sort((a, b) => b.confidence - a.confidence)
    .slice(0, 1)
  const missingContentFacets: Array<'form' | 'topic'> = []
  if (!selectedContent.some((tag) => tag.facet === 'form')) missingContentFacets.push('form')
  if (!selectedContent.some((tag) => tag.facet === 'domain' || tag.facet === 'entity')) missingContentFacets.push('topic')
  const contentComplete = missingContentFacets.length === 0
  return { active: [...selectedContent, ...selectedState], pending: candidates, rejected, contentComplete, missingContentFacets, sparse: !contentComplete }
}

export function resolveActiveTagEntry(
  entries: readonly TagLexiconEntry[],
  label: string,
): TagLexiconEntry | null {
  const active = entries.filter((entry) => entry.status === 'active')
  const exact = active.filter((entry) => same(entry.label, label))
  if (exact.length > 0) return exact.length === 1 ? exact[0] : null
  const aliases = active.filter((entry) => entry.aliases.some((alias) => same(alias, label)))
  return aliases.length === 1 ? aliases[0] : null
}

function assertUniqueActiveTagSurfaces(entries: readonly TagLexiconEntry[]): void {
  const owners = new Map<string, string>()
  for (const entry of entries) {
    if (entry.status !== 'active') continue
    for (const surface of [entry.label, ...entry.aliases]) {
      const normalized = surface.trim().toLocaleLowerCase()
      const owner = owners.get(normalized)
      if (owner && owner !== entry.id) throw new Error(`duplicate active tag surface: ${surface}`)
      owners.set(normalized, entry.id)
    }
  }
}

function normalizeEntry(value:any):TagLexiconEntry|null{if(!value||!TAG_FACETS.includes(value.facet)||!String(value.id||'').trim()||!String(value.label||'').trim())return null;return{id:String(value.id),facet:value.facet,label:String(value.label).trim(),aliases:stringList(value.aliases),definition:String(value.def||'').trim(),status:value.status==='pending'||value.status==='deprecated'?value.status:'active'}}
function normalizeProposal(value:TagProposal):TagProposal|null{if(!value||!TAG_FACETS.includes(value.facet)||!String(value.label||'').trim()||!String(value.evidenceCode||'').trim())return null;return{facet:value.facet,label:String(value.label).trim().slice(0,80),evidenceCode:String(value.evidenceCode).trim().slice(0,64),evidenceExcerpt:value.evidenceExcerpt?String(value.evidenceExcerpt).slice(0,160):null,confidence:Math.max(0,Math.min(1,Number(value.confidence)||0))}}
function stringList(v:unknown):string[]{return Array.isArray(v)?v.map(String).map((x)=>x.trim()).filter(Boolean):[]}
function normalizeFacets(v:unknown):TagFacet[]{return stringList(v).filter((x):x is TagFacet=>TAG_FACETS.includes(x as TagFacet))}
function normalizePair(v:unknown,f:[number,number]):[number,number]{return Array.isArray(v)&&v.length===2?[positiveInt(v[0],f[0]),positiveInt(v[1],f[1])]:f}
function positiveInt(v:unknown,f:number):number{const n=Math.floor(Number(v));return Number.isFinite(n)&&n>0?n:f}
function normalizeOpenness(v:unknown):'closed'|'semi_open'|'open'{return v==='open'||v==='semi_open'?v:'closed'}
function normalizeConfidence(v:unknown,f:number):number{const n=Number(v);return Number.isFinite(n)?Math.max(0,Math.min(1,n)):f}
function same(a:string,b:string):boolean{return a.trim().toLocaleLowerCase()===b.trim().toLocaleLowerCase()}
function proposalKey(proposal:TagProposal):string{return`${proposal.facet}:${proposal.label.trim().toLocaleLowerCase()}`}
function compareProposal(a:TagProposal,b:TagProposal):number{return b.confidence-a.confidence||TAG_FACETS.indexOf(a.facet)-TAG_FACETS.indexOf(b.facet)||a.label.localeCompare(b.label)||a.evidenceCode.localeCompare(b.evidenceCode)||String(a.evidenceExcerpt||'').localeCompare(String(b.evidenceExcerpt||''))}
function compareValidated(a:ValidatedTag,b:ValidatedTag):number{return b.confidence-a.confidence||Number(b.resolution==='exact')-Number(a.resolution==='exact')||a.label.localeCompare(b.label)||a.evidenceCode.localeCompare(b.evidenceCode)}
function compareValidatedDedup(a:ValidatedTag,b:ValidatedTag):number{return Number(b.resolution==='exact')-Number(a.resolution==='exact')||compareValidated(a,b)}
