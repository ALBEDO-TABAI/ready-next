import assert from 'node:assert/strict'
import test from 'node:test'
import { evaluateControlledContentLabels, loadTagForgePolicy, validateTagProposals } from '../main/modules/tag-forge/tag-forge-policy'

const policy=loadTagForgePolicy()

test('Tag Forge policy is machine-owned and resolves aliases only within their facet',()=>{
  assert.deepEqual(policy.tagsPerDoc,[2,15])
  assert.equal(policy.automaticState,'待整理')
  const result=validateTagProposals(policy,[
    {facet:'domain',label:'抗老',evidenceCode:'body_topic',confidence:.9},
    {facet:'entity',label:'抗老',evidenceCode:'wrong_facet',confidence:.9},
    {facet:'entity',label:'SK-II',evidenceCode:'brand',confidence:.8},
  ],'automatic')
  assert.deepEqual(result.active.map((tag)=>tag.label),['护肤/抗衰','SKII','待整理'])
  assert.equal(result.pending.some((tag)=>tag.facet==='entity'&&tag.label==='抗老'),false)
  assert.equal(result.rejected.some((item)=>item.reason==='cross_facet_label_collision'),true)
  assert.equal(result.contentComplete,false)
  assert.deepEqual(result.missingContentFacets,['form'])
})

test('workflow state never satisfies the explicit content completion gate',()=>{
  const stateOnly=validateTagProposals(policy,[{facet:'state',label:'待整理',evidenceCode:'state',confidence:1}],'explicit')
  assert.equal(stateOnly.contentComplete,false)
  assert.deepEqual(stateOnly.missingContentFacets,['form','topic'])
  const complete=validateTagProposals(policy,[
    {facet:'form',label:'参考资料',evidenceCode:'form',confidence:.95},
    {facet:'entity',label:'Claude',evidenceCode:'entity',confidence:.95},
    {facet:'state',label:'待整理',evidenceCode:'state',confidence:1},
  ],'explicit')
  assert.equal(complete.contentComplete,true)
  assert.equal(complete.sparse,false)
})

test('low-confidence unknown terms are ignored instead of interrupting the user',()=>{
  const result=validateTagProposals(policy,[
    {facet:'form',label:'参考资料',evidenceCode:'form',confidence:.95},
    {facet:'domain',label:'模糊的新领域',evidenceCode:'topic',confidence:.4},
  ],'explicit')
  assert.equal(result.pending.length,0)
  assert.equal(result.rejected[0]?.reason,'low_confidence_ignored')
})

test('pending candidates are preserved while automatic adoption is limited elsewhere',()=>{
  const result=validateTagProposals(policy,[
    {facet:'state',label:'精选',evidenceCode:'model_claim',confidence:1},
    {facet:'form',label:'资料',evidenceCode:'generic',confidence:1},
    {facet:'domain',label:'新领域一',evidenceCode:'topic',confidence:.8},
    {facet:'entity',label:'新实体二',evidenceCode:'entity',confidence:.7},
    {facet:'use',label:'新用途三',evidenceCode:'use',confidence:.6},
  ],'automatic')
  assert.equal(result.active.filter((tag)=>tag.facet==='state')[0]?.label,'待整理')
  assert.deepEqual(result.pending.map((item)=>item.label),['新领域一','新实体二','新用途三'])
  assert.deepEqual(result.rejected.map((item)=>item.reason),['automatic_state_is_code_owned','broad_label_blacklisted'])
  assert.equal(result.sparse,true)
})

test('unknown closed form requires explicit review while automatic tagging still rejects it',()=>{
  const automatic=validateTagProposals(policy,[{facet:'form',label:'发明的新形态',evidenceCode:'form',confidence:.9}],'automatic')
  assert.equal(automatic.pending.length,0)
  assert.equal(automatic.rejected[0]?.reason,'closed_facet_unknown')
  const explicit=validateTagProposals(policy,[{facet:'form',label:'发明的新形态',evidenceCode:'form',confidence:.9}],'explicit')
  assert.equal(explicit.pending[0]?.label,'发明的新形态')
  assert.equal(explicit.rejected.length,0)
  const overlay=validateTagProposals(policy,[{facet:'entity',label:'Ready',evidenceCode:'entity',confidence:.9}],'explicit',[{id:'ready',facet:'entity',label:'Ready',aliases:['ready-app'],status:'active'}])
  assert.equal(overlay.active[0]?.tagId,'ready')
  assert.equal(policy.entries.some((entry)=>entry.id==='ready'),false)
})

test('a term explicitly rejected by the user is not proposed for review again',()=>{
  const result=validateTagProposals(
    policy,
    [{facet:'form',label:'读书笔记',evidenceCode:'form',confidence:.9}],
    'explicit',
    [],
    [{facet:'form',label:'读书笔记'}],
  )
  assert.equal(result.pending.length,0)
  assert.equal(result.rejected[0]?.reason,'user_rejected_pending')
})

test('workflow states submitted as content proposals are always rejected',()=>{
  const result=validateTagProposals(policy,[{facet:'state',label:'精选',evidenceCode:'state',confidence:.9},{facet:'state',label:'已归档',evidenceCode:'state',confidence:.8}],'explicit')
  assert.equal(result.active.length,0);assert.deepEqual(result.rejected.map((item)=>item.reason),['workflow_state_is_not_content_tag','workflow_state_is_not_content_tag'])
})

test('every active label surface has one meaning and canonical labels win',()=>{
  const result=validateTagProposals(policy,[
    {facet:'form',label:'教学',evidenceCode:'form',confidence:.9},
    {facet:'use',label:'教学',evidenceCode:'use',confidence:.9},
    {facet:'domain',label:'胡迪尼',evidenceCode:'domain',confidence:.9},
    {facet:'entity',label:'胡迪尼',evidenceCode:'entity',confidence:.9},
  ],'explicit')
  assert.deepEqual(result.active.map((tag)=>tag.label),['Houdini','教学'])
  assert.deepEqual(result.rejected.map((item)=>item.reason),['cross_facet_label_collision','cross_facet_label_collision'])
  assert.equal(evaluateControlledContentLabels(policy,['教学','AI工作流']).complete,false)
  assert.equal(evaluateControlledContentLabels(policy,['收藏','AI工作流']).complete,true)
  assert.equal(evaluateControlledContentLabels(policy,['教程','胡迪尼']).complete,true)
  assert.throws(()=>validateTagProposals(policy,[],'explicit',[
    {id:'conflicting-teaching',facet:'domain',label:'教学',aliases:[],status:'active'},
  ]),/duplicate active tag surface/)
})

test('final content evaluation detects duplicate forms instead of treating them as complete',()=>{
  const result=evaluateControlledContentLabels(policy,['教程','参考资料','AI工作流'])
  assert.equal(result.formCount,2)
  assert.equal(result.complete,false)
})

test('all eligible pending labels remain deterministic regardless of proposal order',()=>{
  const proposals=[
    {facet:'form' as const,label:'参考资料',evidenceCode:'form',confidence:.95},
    {facet:'use' as const,label:'新用途甲',evidenceCode:'use',confidence:.8},
    {facet:'use' as const,label:'新用途乙',evidenceCode:'use',confidence:.8},
    {facet:'domain' as const,label:'关键新领域',evidenceCode:'topic',confidence:.99},
  ]
  const permutations=proposals.flatMap((first,index)=>proposals.filter((_,other)=>other!==index).map((second)=>[first,second,...proposals.filter((item)=>item!==first&&item!==second)]))
  const outcomes=permutations.map((items)=>validateTagProposals(policy,items,'explicit').pending.map((item)=>`${item.facet}:${item.label}`))
  for(const outcome of outcomes){assert.equal(outcome.length,3);assert.equal(outcome.includes('domain:关键新领域'),true);assert.deepEqual(outcome,outcomes[0])}
})

test('active content shares one deterministic safety limit without starving later facets',()=>{
  const form={facet:'form' as const,label:'教程',evidenceCode:'form',confidence:.9}
  const entries=policy.entries.filter((entry)=>entry.facet!=='form'&&entry.facet!=='state').slice(0,18)
  const proposals=entries.map((entry,index)=>({facet:entry.facet,label:entry.label,evidenceCode:'content',confidence:index === entries.length - 1 ? .99 : .8}))
  const forward=validateTagProposals(policy,[form,...proposals],'explicit').active.map((tag)=>tag.label)
  const reverse=validateTagProposals(policy,[form,...proposals.toReversed()],'explicit').active.map((tag)=>tag.label)
  assert.equal(forward.length,15)
  assert.equal(forward.includes(entries.at(-1)?.label??''),true)
  assert.deepEqual(reverse,forward)
})

test('required topic survives the shared cap even when optional uses have higher confidence',()=>{
  const uses=Array.from({length:20},(_,index)=>({id:`use-${index}`,facet:'use' as const,label:`用途${index}`,aliases:[],status:'active' as const}))
  const result=validateTagProposals(policy,[
    {facet:'form',label:'教程',evidenceCode:'form',confidence:.99},
    {facet:'domain',label:'AI工作流',evidenceCode:'topic',confidence:.1},
    ...uses.map((entry)=>({facet:'use' as const,label:entry.label,evidenceCode:'use',confidence:.99})),
  ],'explicit',uses)
  assert.equal(result.active.filter((tag)=>tag.facet!=='state').length,15)
  assert.equal(result.active.some((tag)=>tag.label==='AI工作流'),true)
  assert.equal(result.contentComplete,true)
})
