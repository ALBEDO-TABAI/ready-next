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
  status: 'active' | 'pending' | 'deprecated'
}

export interface TagForgePolicy {
  version: string
  tagsPerDoc: [number, number]
  newTagsPerRun: number
  newTagsPerDoc: number
  automaticState: string
  facetOpenness: Record<TagFacet, 'closed' | 'semi_open' | 'open'>
  automaticAllowedFacets: TagFacet[]
  automaticForbiddenStateLabels: string[]
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
  sparse: boolean
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
  return {
    version: String(parsed.version ?? '0'),
    tagsPerDoc: normalizePair(config.tags_per_doc, [3, 7]),
    newTagsPerRun: positiveInt(config.new_tags_per_run, 10),
    newTagsPerDoc: positiveInt(config.new_tags_per_doc, 2),
    automaticState: String(config.automatic_state || '待整理'),
    facetOpenness: Object.fromEntries(TAG_FACETS.map((facet) => [facet, normalizeOpenness(openness[facet])])) as TagForgePolicy['facetOpenness'],
    automaticAllowedFacets: normalizeFacets(config.automatic_allowed_facets),
    automaticForbiddenStateLabels: stringList(config.automatic_forbidden_state_labels),
    broadLabelBlacklist: stringList(config.broad_label_blacklist),
    entries: Array.isArray(parsed.entries) ? parsed.entries.map(normalizeEntry).filter(Boolean) as TagLexiconEntry[] : [],
  }
}

export function validateTagProposals(
  policy: TagForgePolicy,
  proposals: readonly TagProposal[],
  mode: 'automatic' | 'explicit',
  overlay: readonly TagLexiconEntry[] = [],
): TagValidationResult {
  const entries = [...policy.entries, ...overlay].filter((entry) => entry.status === 'active')
  const active: ValidatedTag[] = []
  const pending: TagProposal[] = []
  const rejected: TagValidationResult['rejected'] = []
  const seen = new Set<string>()
  let pendingCount = 0
  const explicitStateLabels=new Set(proposals.filter((item)=>item?.facet==='state').map((item)=>String(item.label||'').trim()).filter(Boolean))

  for (const raw of proposals) {
    const proposal = normalizeProposal(raw)
    if (!proposal) continue
    if (mode === 'automatic' && proposal.facet === 'state') {
      rejected.push({ proposal, reason: 'automatic_state_is_code_owned' })
      continue
    }
    if(mode==='explicit'&&proposal.facet==='state'&&explicitStateLabels.size>1){rejected.push({proposal,reason:'ambiguous_state_requires_review'});continue}
    if (policy.broadLabelBlacklist.some((item) => same(item, proposal.label))) {
      rejected.push({ proposal, reason: 'broad_label_blacklisted' })
      continue
    }
    const sameFacet = entries.filter((entry) => entry.facet === proposal.facet)
    const exact = sameFacet.find((entry) => same(entry.label, proposal.label))
    const alias = exact ?? sameFacet.find((entry) => entry.aliases.some((item) => same(item, proposal.label)))
    if (alias) {
      if (mode === 'automatic' && alias.facet === 'state' && policy.automaticForbiddenStateLabels.includes(alias.label)) {
        rejected.push({ proposal, reason: 'privileged_state_rejected' })
        continue
      }
      if (!seen.has(alias.id)) {
        seen.add(alias.id)
        active.push({ tagId: alias.id, facet: alias.facet, label: alias.label, confidence: proposal.confidence, evidenceCode: proposal.evidenceCode, resolution: exact ? 'exact' : 'alias' })
      }
      continue
    }
    if (policy.facetOpenness[proposal.facet] === 'closed') {
      rejected.push({ proposal, reason: 'closed_facet_unknown' })
      continue
    }
    if (pendingCount >= policy.newTagsPerDoc) {
      rejected.push({ proposal, reason: 'pending_quota_exceeded' })
      continue
    }
    pending.push(proposal)
    pendingCount += 1
  }

  if (mode === 'automatic') {
    const state = entries.find((entry) => entry.facet === 'state' && entry.label === policy.automaticState)
    if (!state) throw new Error('automatic state is missing from active lexicon')
    active.push({ tagId: state.id, facet: 'state', label: state.label, confidence: 1, evidenceCode: 'automatic_new_document_state', resolution: 'exact' })
  }

  const byFacetLimit: Record<TagFacet, number> = { form: 1, domain: 2, entity: 3, use: 2, state: 1 }
  const selected = TAG_FACETS.flatMap((facet) => active
    .filter((tag) => tag.facet === facet)
    .sort((a, b) => b.confidence - a.confidence)
    .slice(0, byFacetLimit[facet]))
    .slice(0, policy.tagsPerDoc[1])
  return { active: selected, pending, rejected, sparse: selected.length < policy.tagsPerDoc[0] }
}

function normalizeEntry(value:any):TagLexiconEntry|null{if(!value||!TAG_FACETS.includes(value.facet)||!String(value.id||'').trim()||!String(value.label||'').trim())return null;return{id:String(value.id),facet:value.facet,label:String(value.label).trim(),aliases:stringList(value.aliases),status:value.status==='pending'||value.status==='deprecated'?value.status:'active'}}
function normalizeProposal(value:TagProposal):TagProposal|null{if(!value||!TAG_FACETS.includes(value.facet)||!String(value.label||'').trim()||!String(value.evidenceCode||'').trim())return null;return{facet:value.facet,label:String(value.label).trim().slice(0,80),evidenceCode:String(value.evidenceCode).trim().slice(0,64),evidenceExcerpt:value.evidenceExcerpt?String(value.evidenceExcerpt).slice(0,160):null,confidence:Math.max(0,Math.min(1,Number(value.confidence)||0))}}
function stringList(v:unknown):string[]{return Array.isArray(v)?v.map(String).map((x)=>x.trim()).filter(Boolean):[]}
function normalizeFacets(v:unknown):TagFacet[]{return stringList(v).filter((x):x is TagFacet=>TAG_FACETS.includes(x as TagFacet))}
function normalizePair(v:unknown,f:[number,number]):[number,number]{return Array.isArray(v)&&v.length===2?[positiveInt(v[0],f[0]),positiveInt(v[1],f[1])]:f}
function positiveInt(v:unknown,f:number):number{const n=Math.floor(Number(v));return Number.isFinite(n)&&n>0?n:f}
function normalizeOpenness(v:unknown):'closed'|'semi_open'|'open'{return v==='open'||v==='semi_open'?v:'closed'}
function same(a:string,b:string):boolean{return a.trim().toLocaleLowerCase()===b.trim().toLocaleLowerCase()}
