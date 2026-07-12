import { createHash, randomUUID } from 'crypto'
import { lstat, readFile, realpath, rename, unlink, writeFile } from 'fs/promises'
import { dirname, isAbsolute, join, relative } from 'path'
import { parseDocumentGraph } from '../../../shared/document-graph-parse'
import { writeFrontmatter } from '../../../shared/document-graph-parse-frontmatter-writer'
import type { ValidatedTag } from './tag-forge-policy'

export interface TagForgeWriteResult {
  path: string
  content: string
  revision: string
  tags: string[]
  originalContent: string
}

export async function writeControlledTags(input:{
  path:string
  workspaceRoot:string
  expectedRevision:string
  selectedTags:readonly ValidatedTag[]
  previousAutomaticLabels:readonly string[]
  suppressedAutomaticLabels:readonly string[]
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
  const graph=parseDocumentGraph(content)
  const frontmatter={...(graph.frontmatter??{})}
  const current=Array.isArray(frontmatter.tags)?frontmatter.tags.filter((tag):tag is string=>typeof tag==='string').map(clean):[]
  const previousAuto=new Set(input.previousAutomaticLabels.map(key))
  const suppressed=new Set(input.suppressedAutomaticLabels.map(key))
  const manual=current.filter((label)=>!previousAuto.has(key(label)))
  const automatic=input.selectedTags.map((tag)=>tag.label).filter((label)=>!suppressed.has(key(label)))
  const tags=unique([...manual,...automatic])
  if(tags.length)frontmatter.tags=tags;else delete frontmatter.tags
  if(input.readyProject?.trim())frontmatter.ready_project=input.readyProject.trim()
  const body=stripTopTagLines(graph.body)
  const next=writeFrontmatter(body,frontmatter)
  const tmp=join(dirname(pathReal),`.${randomUUID()}.tag-forge.tmp`)
  try{await writeFile(tmp,next,{encoding:'utf8',flag:'wx'});await rename(tmp,pathReal)}catch(error){await unlink(tmp).catch(()=>undefined);throw error}
  const readback=await readFile(pathReal,'utf8')
  if(readback!==next)throw codeError('disk_readback_mismatch')
  const parsed=parseDocumentGraph(readback);const parsedTags=Array.isArray(parsed.frontmatter?.tags)?parsed.frontmatter!.tags as unknown[]:[]
  if(JSON.stringify(parsedTags.map(String))!==JSON.stringify(tags))throw codeError('frontmatter_readback_mismatch')
  return{path:pathReal,content:readback,revision:revisionOf(readback),tags,originalContent:content}
}

export async function rollbackControlledWrite(path:string,writtenRevision:string,originalContent:string):Promise<void>{
  const stat=await lstat(path);if(!stat.isFile()||stat.isSymbolicLink())throw codeError('rollback_target_invalid')
  const current=await readFile(path,'utf8');if(revisionOf(current)!==writtenRevision)throw codeError('rollback_revision_conflict')
  const tmp=join(dirname(path),`.${randomUUID()}.tag-forge.rollback.tmp`);try{await writeFile(tmp,originalContent,{encoding:'utf8',flag:'wx'});await rename(tmp,path)}catch(error){await unlink(tmp).catch(()=>undefined);throw error}
}

export function revisionOf(content:string):string{return createHash('sha256').update(content).digest('hex')}
function stripTopTagLines(body:string):string{const lines=body.replace(/^\uFEFF/,'').split(/\r?\n/);let index=0;while(index<lines.length&&lines[index].trim()==='')index++;while(index<lines.length&&/^(?:#[\p{L}\p{N}_\-/]+\s*){1,20}$/u.test(lines[index].trim()))index++;return lines.slice(index).join('\n').replace(/^\n+/,'')}
function clean(v:string):string{return v.trim().replace(/^#/,'')}
function key(v:string):string{return clean(v).toLocaleLowerCase()}
function unique(values:string[]):string[]{const seen=new Set<string>();return values.filter((value)=>{const k=key(value);if(!k||seen.has(k))return false;seen.add(k);return true})}
function codeError(code:string):Error{return Object.assign(new Error(code),{code})}
