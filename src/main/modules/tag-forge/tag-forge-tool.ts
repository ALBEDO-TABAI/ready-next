import { isAbsolute,relative,resolve } from 'path'
import type { SearchEngine } from '../search-engine/indexer'
import { FileProjectIdentityRepository } from '../repositories/file-project-identity-repository'
import { TagForgeRepository } from '../repositories/tag-forge-repository'
import { loadTagForgePolicy,validateTagProposals,type TagProposal } from './tag-forge-policy'
import { rollbackControlledWrite,writeControlledTags } from './tag-forge-writer'

export interface TagForgeToolContext {
  workspaceRoots?:string[]|null
  runId?:string|null
  requestModuleToolAction?:(tool:string,args:Record<string,unknown>)=>Promise<Record<string,unknown>>
}

export async function executeTagForgeApply(args:Record<string,unknown>,engine:SearchEngine,context?:TagForgeToolContext):Promise<string>{
  const path=typeof args.path==='string'?args.path:'';const mode=args.mode==='automatic'?'automatic':args.mode==='explicit'?'explicit':null
  const expectedRevision=typeof args.expectedRevision==='string'?args.expectedRevision:'';const receiptId=typeof args.receiptId==='string'?args.receiptId:''
  if(!path||!mode||!expectedRevision||!Array.isArray(args.proposals))return json({ok:false,errorKind:'invalid_tag_forge_input'})
  const root=workspaceRootFor(path,engine,context?.workspaceRoots);if(!root)return json({ok:false,errorKind:'workspace_boundary_rejected',error:'path is outside any known workspace'})
  const db=engine.getRepository().getConnection();const identities=new FileProjectIdentityRepository(db);const file=identities.ensureFile({workspaceRoot:root,path});const repo=new TagForgeRepository(db)
  if(context?.requestModuleToolAction){const lease=await context.requestModuleToolAction('tagForge.checkRevision',{path,expectedRevision});if(lease.ok===false)return json({ok:false,status:mode==='automatic'?'failed_retryable':'failed_terminal',errorKind:'open_tab_revision_conflict'})}
  const runId=context?.runId??''
  if(mode==='automatic'){
    const receipt=receiptId&&runId?repo.getEligibleReceipt(receiptId,runId):null
    if(!receipt||receipt.fileKey!==file.fileKey)return json({ok:false,errorKind:'creation_receipt_required'})
    if(receipt.finalSaveHash!==expectedRevision)return json({ok:false,errorKind:'final_save_revision_mismatch'})
  }
  const policy=loadTagForgePolicy();const proposals=args.proposals.filter((item):item is TagProposal=>Boolean(item&&typeof item==='object'))
  const validated=validateTagProposals(policy,proposals,mode,repo.listOverlay(),repo.listRejected());repo.addPending(validated.pending,runId||null)
  const pending=validated.pending.map((item)=>({facet:item.facet,label:item.label}));const rejected=validated.rejected.map((item)=>({label:item.proposal.label,reason:item.reason}))
  if(mode==='explicit'&&pending.length)return json({ok:true,status:'waiting_review',reviewRequired:true,reviewLocation:'设置 > 文档标签',path,tags:[],pending,rejected,revision:expectedRevision})
  if(mode==='explicit'&&validated.active.length===0)return json({ok:false,status:'failed_terminal',errorKind:'no_active_tags',path,pending,rejected})
  const before=repo.listAssignments(file.fileKey);const previousAuto=before.filter((item)=>item.ownership==='automatic').map((item)=>item.label);const suppressed=before.filter((item)=>item.ownership==='automatic'&&item.suppressed).map((item)=>item.label)
  try{
    const written=await writeControlledTags({path,workspaceRoot:root,expectedRevision,selectedTags:validated.active,previousAutomaticLabels:previousAuto,suppressedAutomaticLabels:suppressed})
    if(context?.requestModuleToolAction){const sync=await context.requestModuleToolAction('tagForge.applyContent',{path,content:written.content,revision:written.revision});if(sync.ok===false){await rollbackControlledWrite(written.path,written.revision,written.originalContent);throw Object.assign(new Error('open_tab_revision_conflict'),{code:'open_tab_revision_conflict'})}}
    repo.replaceAutomaticAssignments(file.fileKey,validated.active,mode==='automatic'?'tag_forge_auto':'tag_forge_explicit',policy.version)
    await engine.indexDocument(root,path,written.content)
    const indexed=db.prepare(`SELECT d.frontmatter_json AS frontmatter FROM documents d JOIN workspaces w ON w.id=d.workspace_id WHERE w.root=? AND d.path=?`).get<{frontmatter:string|null}>(root,path)
    const indexedTags=(()=>{try{const value=JSON.parse(indexed?.frontmatter||'{}').tags;return Array.isArray(value)?value.map(String):[]}catch{return[]}})()
    if(JSON.stringify(indexedTags)!==JSON.stringify(written.tags))throw Object.assign(new Error('index_readback_mismatch'),{code:'index_readback_mismatch'})
    repo.markReadback(file.fileKey);if(mode==='automatic'&&receiptId)repo.markReceipt(receiptId,validated.sparse?'completed_sparse':'completed')
    return json({ok:true,status:validated.sparse?'completed_sparse':'completed',path,tags:written.tags,pending,rejected,revision:written.revision})
  }catch(error){const code=typeof (error as {code?:unknown})?.code==='string'?(error as {code:string}).code:'tag_write_failed';if(mode==='automatic'&&receiptId)repo.markReceipt(receiptId,'failed_retryable',code);return json({ok:false,status:mode==='automatic'?'failed_retryable':'failed_terminal',errorKind:code})}
}

function workspaceRootFor(path:string,engine:SearchEngine,roots:string[]|null|undefined):string|null{
  if(!isAbsolute(path))return null;const target=resolve(path);const candidates=Array.isArray(roots)?roots.map((root)=>resolve(root)):[]
  return (candidates.length?candidates.find((root)=>inside(target,root)):engine.findWorkspaceRootForPath(target))??null
}
function inside(target:string,root:string):boolean{const rel=relative(root,target);return rel===''||(!rel.startsWith('..')&&!isAbsolute(rel))}
function json(value:unknown):string{return JSON.stringify(value,null,2)}
