import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import test from 'node:test'
import { DOCUMENT_SCHEMAS } from '../main/modules/tools/schemas/document-schemas'
import { getDocumentAnthropicTools } from '../main/modules/tools/document-tools'
import { loadTagForgePolicy } from '../main/modules/tag-forge/tag-forge-policy'
import { buildTagForgeCreationContent, creationFrontmatterRevision, matchesTagForgeCreationContent, validateTagForgeCreationProposals, verifyTagForgeCreationFinalContent } from '../main/modules/tag-forge/tag-forge-creation-validation'
import { parseDocumentGraph } from '../shared/document-graph-parse'

test('new document save accepts semantic Tag Forge proposals but rejects state and project claims',()=>{
  const valid={tabId:'doc',tagProposals:[
    {facet:'form',label:'教程',evidenceCode:'form',evidenceExcerpt:'教程',confidence:.9},
    {facet:'domain',label:'AI工作流',evidenceCode:'topic',evidenceExcerpt:'AI 工作流',confidence:.9},
  ]}
  assert.equal(DOCUMENT_SCHEMAS.document_save_tab.safeParse(valid).success,true)
  assert.equal(DOCUMENT_SCHEMAS.document_save_tab.safeParse({tabId:'existing'}).success,true)
  assert.equal(DOCUMENT_SCHEMAS.document_save_tab.safeParse({...valid,tagProposals:[valid.tagProposals[0]]}).success,true)
  assert.equal(DOCUMENT_SCHEMAS.document_save_tab.safeParse({...valid,tagProposals:[]}).success,false)
  assert.equal(DOCUMENT_SCHEMAS.document_save_tab.safeParse({...valid,tagProposals:valid.tagProposals.map(({evidenceExcerpt:_,...proposal})=>proposal)}).success,false)
  assert.equal(DOCUMENT_SCHEMAS.document_save_tab.safeParse({...valid,tagProposals:[{facet:'state',label:'精选',evidenceCode:'claim',evidenceExcerpt:'精选',confidence:1},valid.tagProposals[1]]}).success,false)
  assert.equal(DOCUMENT_SCHEMAS.document_save_tab.safeParse({...valid,tagProposals:[{facet:'project',label:'Ready',evidenceCode:'claim',evidenceExcerpt:'Ready',confidence:1},valid.tagProposals[1]]}).success,false)
  const definition=getDocumentAnthropicTools().find((tool)=>tool.name==='document_save_tab') as {description?:string;input_schema?:{properties?:Record<string,{items?:{properties?:Record<string,unknown>;required?:string[]}}>} }|undefined
  assert.match(definition?.description??'',/tagProposals/)
  const proposalItems=definition?.input_schema?.properties?.tagProposals?.items
  assert.deepEqual(Object.keys(proposalItems?.properties??{}),['facet','label','evidenceCode','evidenceExcerpt','confidence'])
  assert.deepEqual(proposalItems?.required,['facet','label','evidenceCode','evidenceExcerpt','confidence'])
})

test('new document creation requires body-backed form and topic but ignores a bad optional proposal',()=>{
  const policy=loadTagForgePolicy()
  const content='# AI 工作流教程\n\n这是一份 AI 工作流教程。'
  const complete=validateTagForgeCreationProposals(policy,[
    {facet:'form',label:'教程',evidenceCode:'form',evidenceExcerpt:'工作流教程',confidence:.95},
    {facet:'domain',label:'AI工作流',evidenceCode:'topic',evidenceExcerpt:'AI 工作流',confidence:.95},
    {facet:'use',label:'团队分享',evidenceCode:'use',evidenceExcerpt:'并不存在的摘录',confidence:.8},
  ],content)
  assert.equal(complete.ok,true)
  if(complete.ok)assert.deepEqual(complete.tags.filter((tag)=>tag.facet!=='state').map((tag)=>tag.label),['教程','AI工作流'])

  const stateOnly=validateTagForgeCreationProposals(policy,[],content)
  assert.equal(stateOnly.ok,false)
  if(!stateOnly.ok)assert.deepEqual(stateOnly.missingContentFacets,['form','topic'])

  const manualFrontmatter=validateTagForgeCreationProposals(policy,[
    {facet:'form',label:'教程',evidenceCode:'form',evidenceExcerpt:'教程',confidence:.95},
    {facet:'domain',label:'护肤',evidenceCode:'topic',evidenceExcerpt:'护肤',confidence:.95},
  ],'---\ntags: [教程]\n---\n# 无关正文\n\n护肤内容。')
  assert.equal(manualFrontmatter.ok,true)
  if(manualFrontmatter.ok)assert.equal(manualFrontmatter.tags.some((tag)=>tag.label==='教程'),true)
})

test('high-confidence body-backed new topics are admitted provisionally for creation',()=>{
  const result=validateTagForgeCreationProposals(loadTagForgePolicy(),[
    {facet:'form',label:'参考资料',evidenceCode:'form',evidenceExcerpt:'技术参考资料',confidence:.96},
    {facet:'entity',label:'HTML-in-Canvas API',evidenceCode:'entity',evidenceExcerpt:'HTML-in-Canvas API',confidence:.99},
  ],'# HTML-in-Canvas API 技术参考资料')
  assert.equal(result.ok,true)
  if(result.ok)assert.deepEqual(result.admittedEntries.map((entry)=>entry.label),['HTML-in-Canvas API'])
})

test('high-confidence cross-language normalization uses a real excerpt without asking the user',()=>{
  const content='# Quiet Mid-Century Interior\n\nRaw textures and soft light shape the interior. CGI reference.'
  const result=validateTagForgeCreationProposals(loadTagForgePolicy(),[
    {facet:'form',label:'参考资料',evidenceCode:'form',evidenceExcerpt:'CGI reference',confidence:.99},
    {facet:'domain',label:'现代中世纪',evidenceCode:'style',evidenceExcerpt:'Mid-Century Interior',confidence:.96},
    {facet:'use',label:'柔和光线',evidenceCode:'light',evidenceExcerpt:'soft light',confidence:.96},
    {facet:'use',label:'材质表现',evidenceCode:'material',evidenceExcerpt:'Raw textures',confidence:.8},
  ],content)
  assert.equal(result.ok,true)
  if(!result.ok)return
  assert.deepEqual(result.admittedEntries.map((entry)=>entry.label),['现代中世纪','柔和光线'])
  assert.equal(result.tags.some((tag)=>tag.label==='材质表现'),false)
})

test('creation auto-admits exact body-backed open terms within the document limit without a run budget',()=>{
  const policy=loadTagForgePolicy()
  const proposals=[
    {facet:'form' as const,label:'参考资料',evidenceCode:'form',evidenceExcerpt:'技术参考资料',confidence:.9},
    {facet:'domain' as const,label:'AI工作流',evidenceCode:'domain',evidenceExcerpt:'AI 工作流',confidence:.9},
    {facet:'entity' as const,label:'CanvasKit API',evidenceCode:'entity',evidenceExcerpt:'CanvasKit API',confidence:.7},
    {facet:'entity' as const,label:'WebGPU API',evidenceCode:'entity',evidenceExcerpt:'WebGPU API',confidence:.65},
    {facet:'use' as const,label:'性能对比',evidenceCode:'use',evidenceExcerpt:'性能对比',confidence:.8},
    {facet:'use' as const,label:'低置信用途',evidenceCode:'use',evidenceExcerpt:'低置信用途',confidence:.64},
  ]
  const body='# CanvasKit API 与 WebGPU API 技术参考资料\n\n用于 AI 工作流的性能对比，低置信用途。'
  const admitted=validateTagForgeCreationProposals(policy,proposals,body)
  assert.equal(admitted.ok,true)
  if(admitted.ok){
    assert.deepEqual(admitted.admittedEntries.map((entry)=>entry.label).sort(),['CanvasKit API','WebGPU API','性能对比'].sort())
    assert.equal(admitted.tags.filter((tag)=>tag.facet!=='state').length,5)
    assert.equal(admitted.tags.some((tag)=>tag.label==='低置信用途'),false)
  }
  const capped=validateTagForgeCreationProposals(policy,[
    ...proposals,
    {facet:'entity',label:'Skia API',evidenceCode:'entity',evidenceExcerpt:'Skia API',confidence:.69},
    {facet:'domain',label:'浏览器图形',evidenceCode:'domain',evidenceExcerpt:'浏览器图形',confidence:.68},
  ],`${body}\n\nSkia API 属于浏览器图形技术。`)
  assert.equal(capped.ok,true)
  if(capped.ok){assert.equal(capped.tags.filter((tag)=>tag.facet!=='state').length,7);assert.equal(capped.admittedEntries.length,5)}
})

test('new document creation uses the same fifteen-tag safety limit',()=>{
  const labels=Array.from({length:20},(_,index)=>`新建连接${String(index).padStart(2,'0')}`)
  const result=validateTagForgeCreationProposals(loadTagForgePolicy(),[
    {facet:'form',label:'参考资料',evidenceCode:'form',evidenceExcerpt:'参考资料',confidence:.99},
    ...labels.map((label)=>({facet:'domain' as const,label,evidenceCode:'domain',evidenceExcerpt:label,confidence:.99})),
  ],`# 参考资料\n\n${labels.join(' ')}`)
  assert.equal(result.ok,true)
  if(result.ok){assert.equal(result.tags.filter((tag)=>tag.facet!=='state').length,15);assert.equal(result.admittedEntries.length,14)}
})

test('creation preserves manual aliases without admitting or writing their canonical duplicates',()=>{
  const policy=loadTagForgePolicy()
  const content='---\ntags: [指南, Corona Renderer]\n---\n# AI 工作流教程\n\n这份教程使用 Corona Renderer 讲解 AI 工作流。'
  const result=validateTagForgeCreationProposals(policy,[
    {facet:'form',label:'教程',evidenceCode:'form',evidenceExcerpt:'教程',confidence:.99},
    {facet:'domain',label:'AI工作流',evidenceCode:'topic',evidenceExcerpt:'AI 工作流',confidence:.99},
    {facet:'entity',label:'Corona Renderer',evidenceCode:'renderer',evidenceExcerpt:'Corona Renderer',confidence:.99},
  ],content)
  assert.equal(result.ok,true)
  if(!result.ok)return
  assert.deepEqual(result.admittedEntries,[])
  assert.deepEqual(result.tags.filter((tag)=>tag.facet!=='state').map((tag)=>tag.label),['指南','AI工作流'])
  assert.equal(result.preservedManualTagIds.length,2)
  const built=buildTagForgeCreationContent(policy,content,result.tags)
  assert.deepEqual(parseDocumentGraph(built).frontmatter?.tags,['指南','Corona Renderer','AI工作流'])
  assert.equal(verifyTagForgeCreationFinalContent(policy,built,result.tags,result.bodyRevision).ok,true)
})

test('creation accepts complete manual coverage without making the model repeat it',()=>{
  const policy=loadTagForgePolicy()
  const content='---\ntags: [指南, AI工作流]\n---\n# 已打标文档\n\n正文保持不变。'
  const result=validateTagForgeCreationProposals(policy,[],content)
  assert.equal(result.ok,true)
  if(result.ok)assert.deepEqual(result.tags.filter((tag)=>tag.facet!=='state').map((tag)=>tag.label),['指南','AI工作流'])
})

test('fourteen manual tags remain separate from fifteen automatic creation tags',()=>{
  const policy=loadTagForgePolicy()
  const manual=['指南','Corona Renderer',...Array.from({length:12},(_,index)=>`导入标签${String(index).padStart(2,'0')}`)]
  const automatic=Array.from({length:15},(_,index)=>`自动连接${String(index).padStart(2,'0')}`)
  const content=`---\ntags: [${manual.join(', ')}]\n---\n# 教程\n\n${automatic.join(' ')}`
  const result=validateTagForgeCreationProposals(policy,[
    {facet:'form',label:'教程',evidenceCode:'form',evidenceExcerpt:'教程',confidence:.99},
    ...automatic.map((label)=>({facet:'domain' as const,label,evidenceCode:'topic',evidenceExcerpt:label,confidence:.99})),
  ],content)
  assert.equal(result.ok,true)
  if(!result.ok)return
  assert.equal(result.admittedEntries.length,15)
  assert.equal(result.tags.filter((tag)=>tag.facet!=='state'&&!result.preservedManualTagIds.includes(tag.tagId)).length,15)
  const diskTags=parseDocumentGraph(buildTagForgeCreationContent(policy,content,result.tags)).frontmatter?.tags as string[]
  assert.equal(diskTags.length,29)
  assert.deepEqual(diskTags.slice(0,manual.length),manual)
  assert.equal(diskTags.includes('教程'),false)
})

test('creation migrates workflow state aliases out of visible tags and preserves an explicit state',()=>{
  const policy=loadTagForgePolicy()
  const legacy='---\ntags: [未读, 指南, AI工作流]\n---\n# 已打标文档'
  const legacyResult=validateTagForgeCreationProposals(policy,[],legacy)
  assert.equal(legacyResult.ok,true)
  if(!legacyResult.ok)return
  const migrated=parseDocumentGraph(buildTagForgeCreationContent(policy,legacy,legacyResult.tags)).frontmatter
  assert.deepEqual(migrated?.tags,['指南','AI工作流'])
  assert.equal(migrated?.ready_state,'待整理')

  const favorite='---\ntags: [五星, 指南, AI工作流]\n---\n# 已打标文档'
  const favoriteResult=validateTagForgeCreationProposals(policy,[],favorite)
  assert.equal(favoriteResult.ok,true)
  if(!favoriteResult.ok)return
  const favoriteMigrated=parseDocumentGraph(buildTagForgeCreationContent(policy,favorite,favoriteResult.tags)).frontmatter
  assert.deepEqual(favoriteMigrated?.tags,['指南','AI工作流'])
  assert.equal(favoriteMigrated?.ready_state,'精选')

  const explicit='---\ntags: [未读, 指南, AI工作流]\nready_state: 精选\n---\n# 已打标文档'
  const explicitResult=validateTagForgeCreationProposals(policy,[],explicit)
  assert.equal(explicitResult.ok,true)
  if(!explicitResult.ok)return
  const preserved=parseDocumentGraph(buildTagForgeCreationContent(policy,explicit,explicitResult.tags)).frontmatter
  assert.deepEqual(preserved?.tags,['指南','AI工作流'])
  assert.equal(preserved?.ready_state,'精选')
})

test('creation snapshot reuse is invalidated by a frontmatter-only alias edit',()=>{
  const original='---\ntags: [教程, AI工作流]\n---\n# 正文'
  const aliasEdit='---\ntags: [指南, AI工作流]\n---\n# 正文'
  const reordered='---\ntags: [AI工作流, 教程]\n---\n# 正文'
  const snapshot={
    bodyRevision:createHash('sha256').update(parseDocumentGraph(original).body).digest('hex'),
    frontmatterRevision:creationFrontmatterRevision(original),
  }
  assert.equal(matchesTagForgeCreationContent(snapshot,original),true)
  assert.equal(matchesTagForgeCreationContent(snapshot,reordered),true)
  assert.equal(matchesTagForgeCreationContent(snapshot,aliasEdit),false)
})

test('a manual alias added during retry replaces only the old automatic surface',()=>{
  const policy=loadTagForgePolicy()
  const body='# AI 工作流教程\n\n这是一份 AI 工作流教程。'
  const first=validateTagForgeCreationProposals(policy,[
    {facet:'form',label:'教程',evidenceCode:'form',evidenceExcerpt:'教程',confidence:.99},
    {facet:'domain',label:'AI工作流',evidenceCode:'topic',evidenceExcerpt:'AI 工作流',confidence:.99},
  ],body)
  assert.equal(first.ok,true)
  if(!first.ok)return
  const written=buildTagForgeCreationContent(policy,body,first.tags)
  const edited=written.replace('  - AI工作流','  - AI工作流\n  - 指南')
  const retry=validateTagForgeCreationProposals(policy,[],edited)
  assert.equal(retry.ok,true)
  if(!retry.ok)return
  const previousAutomatic=first.tags.filter((tag)=>tag.facet!=='state'&&!first.preservedManualTagIds.includes(tag.tagId))
  const rebuilt=buildTagForgeCreationContent(policy,edited,retry.tags,[],previousAutomatic)
  assert.deepEqual((parseDocumentGraph(rebuilt).frontmatter?.tags as string[]).sort(),['AI工作流','指南'].sort())

  const manual='---\ntags: [教程, 指南, AI工作流]\n---\n'+body
  const manualResult=validateTagForgeCreationProposals(policy,[],manual)
  assert.equal(manualResult.ok,true)
  if(manualResult.ok)assert.deepEqual(parseDocumentGraph(buildTagForgeCreationContent(policy,manual,manualResult.tags)).frontmatter?.tags,['教程','指南','AI工作流'])
})

test('creation reserves a full document slot for the required topic',()=>{
  const uses=Array.from({length:14},(_,index)=>`用途连接${String(index).padStart(2,'0')}`)
  const topic='室内设计连接'
  const result=validateTagForgeCreationProposals(loadTagForgePolicy(),[
    {facet:'form',label:'参考资料',evidenceCode:'form',evidenceExcerpt:'参考资料',confidence:.99},
    ...uses.map((label)=>({facet:'use' as const,label,evidenceCode:'use',evidenceExcerpt:label,confidence:.99})),
    {facet:'domain',label:topic,evidenceCode:'topic',evidenceExcerpt:topic,confidence:.65},
  ],`# 参考资料\n\n${uses.join(' ')} ${topic}`)
  assert.equal(result.ok,true)
  if(!result.ok)return
  const contentTags=result.tags.filter((tag)=>tag.facet!=='state')
  assert.equal(contentTags.length,15)
  assert.equal(contentTags.some((tag)=>tag.label===topic),true)
  assert.equal(uses.filter((label)=>contentTags.some((tag)=>tag.label===label)).length,13)
})

test('creation final readback verifies automatic tags without rejecting preserved manual tags',()=>{
  const policy=loadTagForgePolicy()
  const body='# AI 工作流教程\n\n这是一份 AI 工作流教程。'
  const validated=validateTagForgeCreationProposals(policy,[
    {facet:'form',label:'教程',evidenceCode:'form',evidenceExcerpt:'工作流教程',confidence:.95},
    {facet:'domain',label:'AI工作流',evidenceCode:'topic',evidenceExcerpt:'AI 工作流',confidence:.95},
  ],body)
  assert.equal(validated.ok,true)
  if(!validated.ok)return
  const wrap=(tags:string[],nextBody=body)=>`---\ntags:\n${tags.map((tag)=>`  - ${tag}`).join('\n')}\nready_state: 待整理\n---\n${nextBody}`
  const built=buildTagForgeCreationContent(policy,'---\ntags: [旧标签]\ntitle: 保留\n---\n'+body,validated.tags)
  assert.match(built,/tags:\n {2}- 旧标签\n {2}- 教程\n {2}- AI工作流/)
  assert.match(built,/title: 保留/)
  assert.match(built,/ready_state: 待整理/)
  assert.equal(verifyTagForgeCreationFinalContent(policy,wrap(['教程','AI工作流']),validated.tags,validated.bodyRevision).ok,true)
  assert.equal(verifyTagForgeCreationFinalContent(policy,wrap(['教程','AI工作流'],'# 正文被替换'),validated.tags,validated.bodyRevision).ok,false)
  assert.equal(verifyTagForgeCreationFinalContent(policy,wrap(['教程','参考资料','AI工作流']),validated.tags,validated.bodyRevision).ok,true)
  assert.equal(verifyTagForgeCreationFinalContent(policy,wrap(['手工标签','教程','AI工作流','团队分享']),validated.tags,validated.bodyRevision).ok,true)
  assert.equal(verifyTagForgeCreationFinalContent(policy,wrap(['手工标签','教程']),validated.tags,validated.bodyRevision).ok,false)
  assert.equal(verifyTagForgeCreationFinalContent(policy,wrap(['教程','AI工作流','AI工作流']),validated.tags,validated.bodyRevision).ok,false)
})
