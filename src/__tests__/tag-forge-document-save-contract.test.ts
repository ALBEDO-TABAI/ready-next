import assert from 'node:assert/strict'
import test from 'node:test'
import { DOCUMENT_SCHEMAS } from '../main/modules/tools/schemas/document-schemas'
import { getDocumentAnthropicTools } from '../main/modules/tools/document-tools'

test('new document save accepts semantic Tag Forge proposals but rejects state and project claims',()=>{
  const valid={tabId:'doc',tagProposals:[{facet:'domain',label:'AI工作流',evidenceCode:'topic',confidence:.9}]}
  assert.equal(DOCUMENT_SCHEMAS.document_save_tab.safeParse(valid).success,true)
  assert.equal(DOCUMENT_SCHEMAS.document_save_tab.safeParse({...valid,tagProposals:[{facet:'state',label:'精选',evidenceCode:'claim',confidence:1}]}).success,false)
  assert.equal(DOCUMENT_SCHEMAS.document_save_tab.safeParse({...valid,tagProposals:[{facet:'project',label:'Ready',evidenceCode:'claim',confidence:1}]}).success,false)
  const definition=getDocumentAnthropicTools().find((tool)=>tool.name==='document_save_tab') as {description?:string}|undefined
  assert.match(definition?.description??'',/tagProposals/)
})
