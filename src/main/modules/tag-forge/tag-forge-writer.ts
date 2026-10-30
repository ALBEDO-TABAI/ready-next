import { lstat, readFile, realpath } from 'fs/promises'
import { isAbsolute, relative } from 'path'
import { applyDocumentOperation, readDocumentSource } from '../../../shared/document-operations'
import { documentVersion, publishDocumentContent, restoreDocumentContent, withDocumentPathLock } from '../document-engine/document-write-service'
import type { ValidatedTag } from './tag-forge-policy'
import { extractLeadingHashtagLabels, stripLeadingHashtagLines } from './tag-forge-content-tags'

export interface TagForgeWriteResult {
  path: string
  content: string
  revision: string
  tags: string[]
  workflowState: string | null
  originalContent: string
}

export async function prepareControlledTags(input:{
  path:string
  workspaceRoot:string
  expectedRevision:string
  selectedTags:readonly ValidatedTag[]
  previousAutomaticLabels:readonly string[]
  suppressedAutomaticLabels:readonly string[]
  workflowStates?:ReadonlyArray<{label:string;aliases:readonly string[]}>
  defaultWorkflowState?:string|null
  readyProject?:string|null
}):Promise<TagForgeWriteResult>{
  if(!isAbsolute(input.path)||!isAbsolute(input.workspaceRoot))throw codeError('invalid_path')
  const pathStat=await lstat(input.path)
  if(pathStat.isSymbolicLink()||!pathStat.isFile())throw codeError('symlink_or_non_file_rejected')
  const [rootReal,pathReal]=await Promise.all([realpath(input.workspaceRoot),realpath(input.path)])
  const rel=relative(rootReal,pathReal)
  if(rel.startsWith('..')||isAbsolute(rel))throw codeError('workspace_boundary_rejected')
  if(!input.path.toLowerCase().endsWith('.md'))throw codeError('markdown_only')
  const content=await readFile(pathReal,'utf8')
  if(revisionOf(content)!==input.expectedRevision)throw codeError('revision_conflict')
  const graph=readDocumentSource(content)
  const frontmatter={...(graph.frontmatter??{})}
  const frontmatterTags=Array.isArray(frontmatter.tags)?frontmatter.tags.filter((tag):tag is string=>typeof tag==='string').map(clean):[]
  const inlineTags=extractLeadingHashtagLabels(graph.body)
  const current=unique([...frontmatterTags,...inlineTags])
  const previousAuto=new Set(input.previousAutomaticLabels.map(key))
  const suppressed=new Set(input.suppressedAutomaticLabels.map(key))
  const stateByKey=new Map<string,string>()
  for(const state of input.workflowStates??[]){stateByKey.set(key(state.label),clean(state.label));for(const alias of state.aliases)stateByKey.set(key(alias),clean(state.label))}
  for(const state of input.selectedTags.filter((tag)=>tag.facet==='state'))stateByKey.set(key(state.label),clean(state.label))
  const stateLabels=new Set(stateByKey.keys())
  const manual=current.filter((label)=>!previousAuto.has(key(label))&&!stateLabels.has(key(label)))
  const automatic=input.selectedTags.filter((tag)=>tag.facet!=='state').map((tag)=>tag.label).filter((label)=>!suppressed.has(key(label)))
  const tags=unique([...manual,...automatic])
  if(tags.length)frontmatter.tags=tags;else delete frontmatter.tags
  const selectedState=input.selectedTags.find((tag)=>tag.facet==='state'&&!suppressed.has(key(tag.label)))?.label
  const currentState=typeof frontmatter.ready_state==='string'&&!suppressed.has(key(frontmatter.ready_state))?(stateByKey.get(key(frontmatter.ready_state))??clean(frontmatter.ready_state)):null
  const legacyStateRaw=current.find((label)=>stateLabels.has(key(label))&&!suppressed.has(key(label)))??null
  const legacyState=legacyStateRaw?(stateByKey.get(key(legacyStateRaw))??legacyStateRaw):null
  const previousStateRaw=input.previousAutomaticLabels.find((label)=>stateLabels.has(key(label))&&!suppressed.has(key(label)))??null
  const previousState=previousStateRaw?(stateByKey.get(key(previousStateRaw))??previousStateRaw):null
  const defaultState=input.defaultWorkflowState?.trim()&&!suppressed.has(key(input.defaultWorkflowState))?clean(input.defaultWorkflowState):null
  const workflowState=selectedState??currentState??legacyState??previousState??defaultState
  if(workflowState)frontmatter.ready_state=workflowState;else delete frontmatter.ready_state
  if(input.readyProject?.trim())frontmatter.ready_project=input.readyProject.trim()
  const body=stripLeadingHashtagLines(graph.body)
  const bodyStart=graph.bodyStart
  const source=applyDocumentOperation(content,{type:'replaceRange',start:bodyStart,end:content.length,expectedText:graph.body,replacement:body})
  const fields:Record<string,unknown>={}
  const remove:string[]=[]
  for(const name of ['tags','ready_state','ready_project']){
    if(Object.prototype.hasOwnProperty.call(frontmatter,name))fields[name]=frontmatter[name]
    else if(name!=='ready_project')remove.push(name)
  }
  const next=applyDocumentOperation(source,{type:'setFrontmatterFields',set:fields,remove})
  return{path:pathReal,content:next,revision:revisionOf(next),tags,workflowState:workflowState??null,originalContent:content}
}

// Scoped writer API retained for callers that only need a file publication. The
// full Tag Forge product transaction uses prepareControlledTags + the service.
export async function writeControlledTags(input:Parameters<typeof prepareControlledTags>[0]):Promise<TagForgeWriteResult>{
  return withDocumentPathLock(input.path,async()=>{
    const result=await prepareControlledTags(input)
    try{await publishDocumentContent(result.path,result.content)}catch(error){
      await restoreDocumentContent(result.path,result.revision,result.originalContent)
      throw error
    }
    return result
  })
}

export const revisionOf = documentVersion
function clean(v:string):string{return v.trim().replace(/^#/,'')}
function key(v:string):string{return clean(v).toLocaleLowerCase()}
function unique(values:string[]):string[]{const seen=new Set<string>();return values.filter((value)=>{const k=key(value);if(!k||seen.has(k))return false;seen.add(k);return true})}
function codeError(code:string):Error{return Object.assign(new Error(code),{code})}
