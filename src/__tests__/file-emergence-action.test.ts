import assert from 'node:assert/strict'
import test from 'node:test'

import { executeFileEmergenceAction,type FileEmergenceActionDeps } from '../renderer/modules/file-emergence/emergenceAction'

function deps(existing:string[]){const opened:string[]=[];const groups:string[][]=[];const revealed:string[]=[];const value:FileEmergenceActionDeps={pathExists:async(path)=>existing.includes(path),openPath:(path)=>opened.push(path),openProjectGroup:(paths)=>groups.push([...paths]),revealPath:async(path)=>{revealed.push(path)}};return{value,opened,groups,revealed}}

test('all three file emergence exits open their real target and project group uses resolved members',async()=>{
  const artifact=deps(['/w/done.md']);assert.equal((await executeFileEmergenceAction({kind:'open_artifact',ref:'/w/done.md'},artifact.value)).success,true);assert.deepEqual(artifact.opened,['/w/done.md'])
  const project=deps(['/w/main.md']);assert.equal((await executeFileEmergenceAction({kind:'open_project',ref:'p1',targetPath:'/w/main.md'},project.value)).success,true);assert.deepEqual(project.opened,['/w/main.md'])
  const group=deps(['/w/main.md','/w/a.md','/w/b.md']);assert.equal((await executeFileEmergenceAction({kind:'open_project_group',ref:'p1',targetPath:'/w/main.md',memberPaths:['/w/a.md','/w/b.md']},group.value)).success,true);assert.deepEqual(group.groups,[['/w/main.md','/w/a.md','/w/b.md']]);assert.deepEqual(group.revealed,['/w/main.md'])
})

test('missing action targets fail visibly instead of becoming dead buttons',async()=>{
  const missing=deps([])
  assert.deepEqual(await executeFileEmergenceAction({kind:'open_project',ref:'p1'},missing.value),{success:false,error:'这个项目暂时没有可打开的文件'})
  assert.deepEqual(await executeFileEmergenceAction({kind:'open_artifact',ref:'/gone.md'},missing.value),{success:false,error:'目标文件已移动或删除'})
})
