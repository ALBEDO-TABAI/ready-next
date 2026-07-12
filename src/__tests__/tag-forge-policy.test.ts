import assert from 'node:assert/strict'
import test from 'node:test'
import { loadTagForgePolicy, validateTagProposals } from '../main/modules/tag-forge/tag-forge-policy'

const policy=loadTagForgePolicy()

test('Tag Forge policy is machine-owned and resolves aliases only within their facet',()=>{
  assert.deepEqual(policy.tagsPerDoc,[3,7])
  assert.equal(policy.automaticState,'待整理')
  const result=validateTagProposals(policy,[
    {facet:'domain',label:'抗老',evidenceCode:'body_topic',confidence:.9},
    {facet:'entity',label:'抗老',evidenceCode:'wrong_facet',confidence:.9},
    {facet:'entity',label:'SK-II',evidenceCode:'brand',confidence:.8},
  ],'automatic')
  assert.deepEqual(result.active.map((tag)=>tag.label),['护肤/抗衰','SKII','待整理'])
  assert.equal(result.pending.some((tag)=>tag.facet==='entity'&&tag.label==='抗老'),true)
})

test('automatic mode fixes state, rejects model privilege claims, blacklist, and excess pending terms',()=>{
  const result=validateTagProposals(policy,[
    {facet:'state',label:'精选',evidenceCode:'model_claim',confidence:1},
    {facet:'form',label:'资料',evidenceCode:'generic',confidence:1},
    {facet:'domain',label:'新领域一',evidenceCode:'topic',confidence:.8},
    {facet:'entity',label:'新实体二',evidenceCode:'entity',confidence:.7},
    {facet:'use',label:'新用途三',evidenceCode:'use',confidence:.6},
  ],'automatic')
  assert.equal(result.active.filter((tag)=>tag.facet==='state')[0]?.label,'待整理')
  assert.equal(result.pending.length,2)
  assert.deepEqual(result.rejected.map((item)=>item.reason),['automatic_state_is_code_owned','broad_label_blacklisted','pending_quota_exceeded'])
  assert.equal(result.sparse,true)
})

test('unknown closed form stays pending-free while approved overlay remains separate from seed',()=>{
  const unknown=validateTagProposals(policy,[{facet:'form',label:'发明的新形态',evidenceCode:'form',confidence:.9}],'explicit')
  assert.equal(unknown.pending.length,0)
  assert.equal(unknown.rejected[0]?.reason,'closed_facet_unknown')
  const overlay=validateTagProposals(policy,[{facet:'entity',label:'Ready',evidenceCode:'entity',confidence:.9}],'explicit',[{id:'ready',facet:'entity',label:'Ready',aliases:['ready-app'],status:'active'}])
  assert.equal(overlay.active[0]?.tagId,'ready')
  assert.equal(policy.entries.some((entry)=>entry.id==='ready'),false)
})

test('mutually exclusive explicit states are not silently chosen',()=>{
  const result=validateTagProposals(policy,[{facet:'state',label:'精选',evidenceCode:'state',confidence:.9},{facet:'state',label:'已归档',evidenceCode:'state',confidence:.8}],'explicit')
  assert.equal(result.active.length,0);assert.deepEqual(result.rejected.map((item)=>item.reason),['ambiguous_state_requires_review','ambiguous_state_requires_review'])
})
