import assert from 'node:assert/strict'
import { mkdtemp, readFile, symlink, writeFile } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import test from 'node:test'
import { parseDocumentGraph } from '../shared/document-graph-parse'
import { revisionOf, writeControlledTags } from '../main/modules/tag-forge/tag-forge-writer'

const selected=[
  {tagId:'reference-doc',facet:'form' as const,label:'参考资料',confidence:.9,evidenceCode:'form',resolution:'exact' as const},
  {tagId:'ai-workflow',facet:'domain' as const,label:'AI工作流',confidence:.8,evidenceCode:'domain',resolution:'exact' as const},
  {tagId:'inbox',facet:'state' as const,label:'待整理',confidence:1,evidenceCode:'state',resolution:'exact' as const},
]

test('secure writer atomically merges manual tags, replaces owned tags, removes top tag lines, and is idempotent',async()=>{
  const root=await mkdtemp(join(tmpdir(),'tag-forge-writer-'));const path=join(root,'doc.md')
  const before='---\ntitle: Demo\ntags: [用户标签, 旧自动]\n---\n#旧自动 #重复\n\n正文不丢失\n'
  await writeFile(path,before)
  const first=await writeControlledTags({path,workspaceRoot:root,expectedRevision:revisionOf(before),selectedTags:selected,previousAutomaticLabels:['旧自动'],suppressedAutomaticLabels:[]})
  assert.deepEqual(first.tags,['用户标签','参考资料','AI工作流','待整理'])
  assert.equal(first.content.includes('#旧自动 #重复'),false);assert.equal(first.content.includes('正文不丢失'),true)
  const second=await writeControlledTags({path,workspaceRoot:root,expectedRevision:first.revision,selectedTags:selected,previousAutomaticLabels:selected.map((tag)=>tag.label),suppressedAutomaticLabels:[]})
  assert.equal(second.content,first.content)
})

test('writer rejects stale revision and workspace symlink without touching body',async()=>{
  const root=await mkdtemp(join(tmpdir(),'tag-forge-root-'));const outside=await mkdtemp(join(tmpdir(),'tag-forge-out-'));const target=join(outside,'secret.md');const link=join(root,'linked.md')
  await writeFile(target,'机密正文');await symlink(target,link)
  await assert.rejects(()=>writeControlledTags({path:link,workspaceRoot:root,expectedRevision:revisionOf('机密正文'),selectedTags:selected,previousAutomaticLabels:[],suppressedAutomaticLabels:[]}),/symlink_or_non_file_rejected/)
  assert.equal(await readFile(target,'utf8'),'机密正文')
  const real=join(root,'real.md');await writeFile(real,'v1');
  await assert.rejects(()=>writeControlledTags({path:real,workspaceRoot:root,expectedRevision:revisionOf('older'),selectedTags:selected,previousAutomaticLabels:[],suppressedAutomaticLabels:[]}),/revision_conflict/)
  assert.equal(await readFile(real,'utf8'),'v1')
})

test('suppressed automatic labels are not restored on retry',async()=>{
  const root=await mkdtemp(join(tmpdir(),'tag-forge-suppress-'));const path=join(root,'doc.md');const before='---\ntags: [参考资料, 待整理]\n---\n正文'
  await writeFile(path,before);const result=await writeControlledTags({path,workspaceRoot:root,expectedRevision:revisionOf(before),selectedTags:selected,previousAutomaticLabels:['参考资料','AI工作流','待整理'],suppressedAutomaticLabels:['AI工作流']})
  assert.deepEqual(parseDocumentGraph(result.content).frontmatter?.tags,['参考资料','待整理'])
})
