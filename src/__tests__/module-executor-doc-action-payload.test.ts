import assert from 'node:assert/strict'
import test, { describe, it } from 'node:test'

import {
  classifyDocActionMutationOutcome,
  classifyDocActionFailureReason,
  performDocAction,
  type DocActionPayload,
} from '../renderer/modules/agent/documentActions'
import { executeModuleToolAction } from '../renderer/modules/agent/moduleExecutor'
import { useDocTabs } from '../renderer/stores/useDocTabs'
import { useMode } from '../renderer/stores/useMode'
import { shouldApplyAsyncDocumentLoad } from '../renderer/components/document/documentLoadGuard'

function buildGuideFenceFixture(): string {
  return [
    '# 指引',
    '',
    '```show-widget',
    JSON.stringify({
      id: 'widget_guide_fixed',
      title: '指引',
      widget_code: '<div class="p-4"><h3>heading</h3><p>body</p></div>',
      component_spec: {
        component: 'info_card',
        props: { heading: 'heading', body: 'body', tone: 'neutral' },
      },
    }),
    '```',
    '',
  ].join('\n')
}

describe('classifyDocActionFailureReason', () => {
  it('id-like target 的"未找到与你选择的卡片对应的 widget"归类为 target_not_resolved', () => {
    const action: DocActionPayload = { type: 'update_widget', target: 'widget_deadbeef00', componentSpecPatch: {} }
    const summary = '未找到与你选择的卡片对应的 widget（当前文档共有 1 个 widget），请重新选择卡片或在消息里提供标题。'
    assert.equal(classifyDocActionFailureReason(action, summary), 'target_not_resolved')
  })

  it('空文档 + id-like target 的"先插入"文案归类为 target_not_resolved', () => {
    const action: DocActionPayload = { type: 'update_widget', target: 'widget_abc123', componentSpecPatch: {} }
    const summary = '当前文档里还没有 widget，请先插入一个再发起修改。'
    assert.equal(classifyDocActionFailureReason(action, summary), 'target_not_resolved')
  })

  it('非 id 兜底"请用标题或序号重试"归类为 target_not_resolved', () => {
    const action: DocActionPayload = { type: 'update_widget', target: '未知标题', componentSpecPatch: {} }
    const summary = '未找到可更新的 widget，请用标题或序号重试（当前文档共有 3 个 widget）。'
    assert.equal(classifyDocActionFailureReason(action, summary), 'target_not_resolved')
  })

  it('数字序号未找到文案归类为 target_not_resolved', () => {
    const action: DocActionPayload = { type: 'update_widget', target: '9', componentSpecPatch: {} }
    const summary = '未找到序号为 9 的 widget'
    assert.equal(classifyDocActionFailureReason(action, summary), 'target_not_resolved')
  })

  it('标题模糊未找到文案归类为 target_not_resolved', () => {
    const action: DocActionPayload = { type: 'update_widget', target: '不存在', componentSpecPatch: {} }
    const summary = '未找到标题匹配“不存在”的 widget'
    assert.equal(classifyDocActionFailureReason(action, summary), 'target_not_resolved')
  })

  it('成功更新文案返回 null', () => {
    const action: DocActionPayload = { type: 'update_widget', target: 'widget_guide_fixed', componentSpecPatch: {} }
    const summary = '已更新 widget（字段级 patch）：指引（笔记.md）'
    assert.equal(classifyDocActionFailureReason(action, summary), null)
  })

  it('非 update_widget action 返回 null（即使 summary 里含关键词）', () => {
    const action: DocActionPayload = { type: 'list_widgets' }
    const summary = '未找到标题匹配“x”的 widget'
    assert.equal(classifyDocActionFailureReason(action, summary), null)
  })

  it('空 summary 返回 null', () => {
    const action: DocActionPayload = { type: 'update_widget', target: 'widget_x', componentSpecPatch: {} }
    assert.equal(classifyDocActionFailureReason(action, ''), null)
  })
})

describe('classifyDocActionMutationOutcome', () => {
  it('save_tab skip does not claim a verified document save', () => {
    const outcome = classifyDocActionMutationOutcome(
      { type: 'save_tab' },
      '文档未改动，已跳过保存：/tmp/ready-report.md',
    )
    assert.equal(outcome.documentSaved, false)
  })
})

describe('performDocAction · document target safety', () => {
  it('rejects set_content without an explicit tool target instead of overwriting a saved visible document', async () => {
    useDocTabs.setState({
      tabs: [
        { id: 'doc-source', path: '/tmp/source-book.md', title: 'source-book.md', content: '# Source\n\nOriginal text\n', isDirty: false },
      ],
      activeTabId: 'doc-source',
      splitTabId: null,
    })

    const result = await performDocAction({ type: 'set_content', content: '# Notes\n' })

    assert.match(result, /文档写入已拒绝/)
    assert.equal(useDocTabs.getState().tabs[0]?.content, '# Source\n\nOriginal text\n')
  })

  it('rejects other mutating writes without an explicit tool target on a saved visible document', async () => {
    useDocTabs.setState({
      tabs: [
        { id: 'doc-source', path: '/tmp/source-book.md', title: 'source-book.md', content: '# Source\n\nOriginal text\n', isDirty: false },
      ],
      activeTabId: 'doc-source',
      splitTabId: null,
    })

    const result = await performDocAction({ type: 'append_content', content: '\n# Notes\n' })

    assert.match(result, /文档写入已拒绝/)
    assert.equal(useDocTabs.getState().tabs[0]?.content, '# Source\n\nOriginal text\n')
  })

  it('does not fall back to the visible document when the remembered tool target disappears', async () => {
    useDocTabs.setState({
      tabs: [
        { id: 'doc-source', path: '/tmp/source-book.md', title: 'source-book.md', content: '# Source\n\nOriginal text\n', isDirty: false },
      ],
      activeTabId: 'doc-source',
      splitTabId: null,
    })

    await performDocAction({ type: 'new_tab', title: 'target', path: '/tmp/target.md' })
    useDocTabs.setState({
      tabs: [
        { id: 'doc-source', path: '/tmp/source-book.md', title: 'source-book.md', content: '# Source\n\nOriginal text\n', isDirty: false },
      ],
      activeTabId: 'doc-source',
      splitTabId: null,
    })

    const result = await performDocAction({ type: 'set_content', content: '# Notes\n' })

    assert.match(result, /文档写入已拒绝/)
    assert.equal(useDocTabs.getState().tabs[0]?.content, '# Source\n\nOriginal text\n')
  })
})

describe('executeModuleToolAction · document.updateWidget payload 合约', () => {
  function makeParams(tool: string, args: Record<string, unknown>) {
    return {
      scopeId: 'test-scope',
      agentName: 'test-agent',
      tool,
      args,
      runId: 'test-run',
      activateWorkbenchMode: () => {},
      upsertScopeRunState: () => {},
      getScopeRunState: () => null,
    }
  }

  it('patch 失败分支把 ok: false / reason: target_not_resolved 并入 payload', async () => {
    const store = useDocTabs.getState()
    const tab = store.tabs[0]
    store.setTabContent(tab.id, buildGuideFenceFixture())

    const result = await executeModuleToolAction(makeParams('document.updateWidget', {
      target: 'widget_deadbeef00',
      componentSpecPatch: { props: { tone: 'warning' } },
      tabId: tab.id,
    }))

    assert.equal(result.handled, true)
    assert.ok(result.payload, 'payload 应存在')
    const payload = result.payload!
    assert.equal(payload.intent, 'document.updateWidget')
    assert.equal(typeof payload.summary, 'string')
    assert.match(payload.summary as string, /未找到与你选择的卡片对应的 widget/)
    assert.equal(payload.ok, false)
    assert.equal(payload.reason, 'target_not_resolved')
  })

  it('patch 成功分支 payload 只含 summary（不出现 ok/reason）', async () => {
    const store = useDocTabs.getState()
    const tab = store.tabs[0]
    store.setTabContent(tab.id, buildGuideFenceFixture())

    const result = await executeModuleToolAction(makeParams('document.updateWidget', {
      target: 'widget_guide_fixed',
      componentSpecPatch: { props: { tone: 'warning' } },
      tabId: tab.id,
    }))

    assert.equal(result.handled, true)
    const payload = result.payload!
    assert.match(payload.summary as string, /已更新 widget（字段级 patch）/)
    assert.equal(payload.ok, undefined)
    assert.equal(payload.reason, undefined)
  })

  it('mutation 成功分支 payload 带结构化文档身份和保存状态', async () => {
    useDocTabs.setState({
      tabs: [
        { id: 'doc-target', path: '/tmp/agent-target.md', title: 'agent-target.md', content: '# 标题\n\n旧内容\n', isDirty: false },
      ],
      activeTabId: 'doc-target',
      splitTabId: null,
    })

    const result = await executeModuleToolAction(makeParams('document.replaceExact', {
      target: '旧内容',
      replacement: '新内容',
      tabId: 'doc-target',
    }))

    assert.equal(result.handled, true)
    const payload = result.payload!
    assert.equal(payload.mutated, true)
    assert.deepEqual(payload.document, {
      tabId: 'doc-target',
      title: 'agent-target.md',
      path: '/tmp/agent-target.md',
      dirty: true,
      requiresSave: true,
      saveState: 'dirty',
    })
    assert.equal(payload.documentTabId, 'doc-target')
    assert.equal(payload.documentPath, '/tmp/agent-target.md')
    assert.equal(payload.documentRequiresSave, true)
  })

  it('save_tab 失败分支把 trace 和步骤标成 error', async () => {
    const previousWindow = (globalThis as { window?: unknown }).window
    let latestState: { phase?: string; steps?: Array<{ status?: string }> } | null = null
    ;(globalThis as { window?: unknown }).window = {
      electronAPI: {
        document: {
          readFile: async () => ({ success: true, content: '' }),
          writeFile: async () => ({ success: false, error: 'permission denied' }),
        },
      },
    }
    try {
      useDocTabs.setState({
        tabs: [
          { id: 'doc-target', path: '/tmp/agent-target.md', title: 'agent-target.md', content: '# 标题\n', isDirty: true },
        ],
        activeTabId: 'doc-target',
        splitTabId: null,
      })

      const result = await executeModuleToolAction({
        ...makeParams('document.saveTab', { tabId: 'doc-target' }),
        upsertScopeRunState: (_scopeId, updater) => {
          latestState = updater(latestState as never) as typeof latestState
        },
        getScopeRunState: () => latestState as never,
      })

      assert.equal(result.handled, true)
      assert.equal(result.payload?.ok, false)
      assert.equal(result.payload?.reason, 'document_action_failed')
      assert.equal(latestState?.phase, 'error')
      assert.equal(latestState?.steps?.at(-1)?.status, 'error')
    } finally {
      ;(globalThis as { window?: unknown }).window = previousWindow
    }
  })

  it('no_match mutation 分支把 trace 和步骤标成 error', async () => {
    let latestState: { phase?: string; steps?: Array<{ status?: string }> } | null = null
    useDocTabs.setState({
      tabs: [
        { id: 'doc-target', path: '/tmp/agent-target.md', title: 'agent-target.md', content: buildGuideFenceFixture(), isDirty: false },
      ],
      activeTabId: 'doc-target',
      splitTabId: null,
    })

    const result = await executeModuleToolAction({
      ...makeParams('document.removeWidget', { target: 'missing_card', tabId: 'doc-target' }),
      upsertScopeRunState: (_scopeId, updater) => {
        latestState = updater(latestState as never) as typeof latestState
      },
      getScopeRunState: () => latestState as never,
    })

    assert.equal(result.handled, true)
    assert.equal(result.payload?.mutationReason, 'no_match')
    assert.equal(latestState?.phase, 'error')
    assert.equal(latestState?.steps?.at(-1)?.status, 'error')
  })

  it('非 update_widget 动作即使 summary 命中关键词也不会被错误标记', async () => {
    // performDocAction 直接走 list_widgets，不受 classifier 影响
    const summary = await performDocAction({ type: 'list_widgets' })
    assert.equal(typeof summary, 'string')
    assert.equal(classifyDocActionFailureReason({ type: 'list_widgets' }, summary), null)
  })

  it('new Markdown prepares durable tags after its path is known and completes the final save',async()=>{
    const previousWindow=(globalThis as {window?:unknown}).window;const writes:Array<{path:string;content:string}>=[];const preparationPayloads:Array<Record<string,unknown>>=[]
    useDocTabs.setState({tabs:[{id:'base',path:null,title:'base',content:'',isDirty:false}],activeTabId:'base',splitTabId:null})
    useMode.setState({workbenchMode:'document'})
    ;(globalThis as {window?:unknown}).window={localStorage:{getItem:()=>'/tmp'},electronAPI:{document:{readFile:async()=>({success:false}),writeFile:async(path:string,content:string)=>{writes.push({path,content});return{success:true}}},tagForge:{prepareCreation:async(payload:Record<string,unknown>)=>{preparationPayloads.push(payload);return{success:true,data:{receiptId:'receipt-1',content:'---\ntags:\n  - 教程\n  - AI工作流\nready_state: 待整理\n---\n# 新文档\n\nAI 工作流教程',tags:['教程','AI工作流'],workflowState:'待整理'}}},finalizeCreation:async()=>({success:true,data:{receiptId:'receipt-1',revision:'hash',path:'/tmp/new.md',status:'completed'}})}}}
    try{
      const tagForgeAPI=(globalThis as any).window.electronAPI.tagForge
      await executeModuleToolAction({...makeParams('document.newTab',{title:'new'}),tagForgeAPI});const tabId=useDocTabs.getState().tabs.find((tab)=>tab.title==='new')!.id
      await executeModuleToolAction({...makeParams('document.setContent',{tabId,content:'# 新文档\n\nAI 工作流教程'}),tagForgeAPI})
      const saved=await executeModuleToolAction({...makeParams('document.saveTab',{tabId,path:'/tmp/new.md',tagProposals:[{facet:'form',label:'教程',evidenceCode:'form',evidenceExcerpt:'工作流教程',confidence:.9},{facet:'domain',label:'AI工作流',evidenceCode:'topic',evidenceExcerpt:'AI 工作流',confidence:.9}]}),tagForgeAPI})
      assert.equal(preparationPayloads.length,1);assert.equal(preparationPayloads[0]?.content,'# 新文档\n\nAI 工作流教程');assert.equal(preparationPayloads[0]?.path,'/tmp/new.md');assert.equal(preparationPayloads[0]?.creationPending,true);assert.equal(saved.payload?.tagForgeStatus,'completed');assert.equal(saved.payload?.tagForgeEnrichmentRequired,false);assert.equal(useDocTabs.getState().tabs.find((tab)=>tab.id===tabId)?.tagForgeCreationPending,undefined);assert.equal(writes.length,2);assert.match(writes[1]!.content,/tags:\n  - 教程\n  - AI工作流/);assert.match(writes[1]!.content,/ready_state: 待整理/);assert.match(writes[1]!.content,/AI 工作流教程/)
    }finally{;(globalThis as {window?:unknown}).window=previousWindow}
  })
  it('Save As establishes the receipt after the dialog chooses a path without asking the user twice',async()=>{
    const previousWindow=(globalThis as any).window;const dialogWrites:string[]=[];const finalWrites:string[]=[];const preparedPaths:string[]=[]
    useDocTabs.setState({tabs:[{id:'save-as-base',path:null,title:'save-as-base',content:'',isDirty:false}],activeTabId:'save-as-base',splitTabId:null});useMode.setState({workbenchMode:'document'})
    const api:any={prepareCreation:async(payload:Record<string,unknown>)=>{preparedPaths.push(String(payload.path));return{success:true,data:{receiptId:'save-as-receipt',content:'---\ntags:\n  - 教程\n  - AI工作流\nready_state: 待整理\n---\n# Save As\n\nAI 工作流教程',tags:['教程','AI工作流'],workflowState:'待整理'}}},finalizeCreation:async()=>({success:true,data:{receiptId:'save-as-receipt',revision:'save-as-hash',path:'/tmp/chosen.md',status:'completed'}})}
    ;(globalThis as any).window={localStorage:{getItem:()=>'/tmp'},electronAPI:{document:{saveFileAs:async({content}:{content:string})=>{dialogWrites.push(content);return{success:true,path:'/tmp/chosen.md'}},readFile:async()=>({success:false}),writeFile:async(_path:string,content:string)=>{finalWrites.push(content);return{success:true}}},tagForge:api}}
    try{await executeModuleToolAction({...makeParams('document.newTab',{title:'save-as'}),tagForgeAPI:api});const tabId=useDocTabs.getState().tabs.find((tab)=>tab.title==='save-as')!.id;await executeModuleToolAction({...makeParams('document.setContent',{tabId,content:'# Save As\n\nAI 工作流教程'}),tagForgeAPI:api});const result=await executeModuleToolAction({...makeParams('document.saveTab',{tabId,tagProposals:[{facet:'form',label:'教程',evidenceCode:'form',evidenceExcerpt:'工作流教程',confidence:.95},{facet:'domain',label:'AI工作流',evidenceCode:'topic',evidenceExcerpt:'AI 工作流',confidence:.95}]}),tagForgeAPI:api});assert.deepEqual(preparedPaths,['/tmp/chosen.md']);assert.equal(dialogWrites.length,1);assert.equal(finalWrites.length,1);assert.match(finalWrites[0]!,/tags:\n  - 教程/);assert.equal(result.payload?.tagForgeStatus,'completed');assert.equal(result.payload?.documentPath,'/tmp/chosen.md')}finally{(globalThis as any).window=previousWindow}
  })
  it('an existing document cannot mint a creation receipt merely by carrying tag proposals',async()=>{
    const previousWindow=(globalThis as any).window;const writes:string[]=[];const preparations:Array<Record<string,unknown>>=[]
    useDocTabs.setState({tabs:[{id:'existing-doc',path:'/tmp/existing.md',title:'existing.md',content:'# 已有文档\n\nAI 工作流教程',isDirty:true}],activeTabId:'existing-doc',splitTabId:null});useMode.setState({workbenchMode:'document'})
    const api:any={prepareCreation:async(payload:Record<string,unknown>)=>{preparations.push(payload);return{success:true,data:null}},finalizeCreation:async()=>{throw new Error('must not finalize')}}
    ;(globalThis as any).window={localStorage:{getItem:()=>'/tmp'},electronAPI:{document:{readFile:async()=>({success:false}),writeFile:async(_path:string,content:string)=>{writes.push(content);return{success:true}}},tagForge:api}}
    try{const result=await executeModuleToolAction({...makeParams('document.saveTab',{tabId:'existing-doc',tagProposals:[{facet:'form',label:'教程',evidenceCode:'form',evidenceExcerpt:'工作流教程',confidence:.95},{facet:'domain',label:'AI工作流',evidenceCode:'topic',evidenceExcerpt:'AI 工作流',confidence:.95}]}),tagForgeAPI:api});assert.equal(preparations.length,1);assert.equal(preparations[0]?.creationPending,false);assert.equal(result.payload?.tagForgeReceiptId,undefined);assert.equal(result.payload?.tagForgeStatus,undefined);assert.equal(writes.length,1);assert.doesNotMatch(writes[0]!,/^---\ntags:/)}finally{(globalThis as any).window=previousWindow}
  })
  it('opening an existing path in a new tab does not mark it as a newly created document',async()=>{
    const previousWindow=(globalThis as any).window;const preparations:Array<Record<string,unknown>>=[]
    useDocTabs.setState({tabs:[{id:'existing-path-base',path:null,title:'base',content:'',isDirty:false}],activeTabId:'existing-path-base',splitTabId:null});useMode.setState({workbenchMode:'document'})
    const api:any={prepareCreation:async(payload:Record<string,unknown>)=>{preparations.push(payload);return{success:true,data:null}},finalizeCreation:async()=>{throw new Error('must not finalize')}}
    ;(globalThis as any).window={localStorage:{getItem:()=>'/tmp'},electronAPI:{document:{readFile:async()=>({success:true,content:'# 已有文档'}),writeFile:async()=>({success:true})},tagForge:api}}
    try{await executeModuleToolAction({...makeParams('document.newTab',{title:'existing-path',path:'/tmp/existing-path.md'}),tagForgeAPI:api});const tab=useDocTabs.getState().tabs.find((item)=>item.path==='/tmp/existing-path.md')!;assert.equal(tab.tagForgeCreationPending,undefined);await executeModuleToolAction({...makeParams('document.setContent',{tabId:tab.id,content:'# 已有文档\n\nAI 工作流教程'}),tagForgeAPI:api});await executeModuleToolAction({...makeParams('document.saveTab',{tabId:tab.id,tagProposals:[{facet:'form',label:'教程',evidenceCode:'form',evidenceExcerpt:'教程',confidence:.95},{facet:'domain',label:'AI工作流',evidenceCode:'topic',evidenceExcerpt:'AI 工作流',confidence:.95}]}),tagForgeAPI:api});assert.equal(preparations.length,1);assert.equal(preparations[0]?.creationPending,false)}finally{(globalThis as any).window=previousWindow}
  })
  it('prepare transport null and rejection remain retryable without clearing creation ownership',async()=>{
    const previousWindow=(globalThis as any).window
    try{for(const mode of ['null','throw'] as const){let finalized=0;useDocTabs.setState({tabs:[{id:`transport-base-${mode}`,path:null,title:'base',content:'',isDirty:false}],activeTabId:`transport-base-${mode}`,splitTabId:null});useMode.setState({workbenchMode:'document'});const api:any={prepareCreation:async()=>{if(mode==='throw')throw new Error('transport lost');return null},finalizeCreation:async()=>{finalized+=1;return{success:true}}};(globalThis as any).window={localStorage:{getItem:()=>'/tmp'},electronAPI:{document:{readFile:async()=>({success:false,errorCode:'FILE_NOT_FOUND'}),writeFile:async()=>({success:true})},tagForge:api}};await executeModuleToolAction({...makeParams('document.newTab',{title:`transport-${mode}`}),tagForgeAPI:api});const tabId=useDocTabs.getState().tabs.find((tab)=>tab.title===`transport-${mode}`)!.id;await executeModuleToolAction({...makeParams('document.setContent',{tabId,content:'# AI 工作流教程'}),tagForgeAPI:api});const result=await executeModuleToolAction({...makeParams('document.saveTab',{tabId,path:`/tmp/transport-${mode}.md`}),tagForgeAPI:api});assert.equal(result.payload?.done,false);assert.equal(result.payload?.errorKind,'tag_forge_prepare_unavailable');assert.equal(result.payload?.recoverable,true);assert.equal(finalized,0);assert.equal(useDocTabs.getState().tabs.find((tab)=>tab.id===tabId)?.tagForgeCreationPending,true)}}finally{(globalThis as any).window=previousWindow}
  })
  it('finalize failure refreshes a clean open tab from the external disk truth',async()=>{
    const previousWindow=(globalThis as any).window;const external='# 外部修改\n\n用户同时修改了磁盘文档。'
    useDocTabs.setState({tabs:[{id:'external-base',path:null,title:'base',content:'',isDirty:false}],activeTabId:'external-base',splitTabId:null});useMode.setState({workbenchMode:'document'})
    const api:any={prepareCreation:async()=>({success:true,data:{receiptId:'external-receipt',content:'---\ntags:\n  - 教程\n  - AI工作流\nready_state: 待整理\n---\n# AI 工作流教程',tags:['教程','AI工作流'],workflowState:'待整理'}}),finalizeCreation:async()=>({success:false,error:'post_index_disk_mismatch'})}
    ;(globalThis as any).window={localStorage:{getItem:()=>'/tmp'},electronAPI:{document:{readFile:async()=>({success:true,content:external}),writeFile:async()=>({success:true})},tagForge:api}}
    try{await executeModuleToolAction({...makeParams('document.newTab',{title:'external-doc'}),tagForgeAPI:api});const tabId=useDocTabs.getState().tabs.find((tab)=>tab.title==='external-doc')!.id;await executeModuleToolAction({...makeParams('document.setContent',{tabId,content:'# AI 工作流教程'}),tagForgeAPI:api});const result=await executeModuleToolAction({...makeParams('document.saveTab',{tabId,path:'/tmp/external-doc.md'}),tagForgeAPI:api});const tab=useDocTabs.getState().tabs.find((item)=>item.id===tabId)!;assert.equal(result.payload?.done,false);assert.equal(result.payload?.errorKind,'tag_forge_finalize_failed');assert.equal(tab.content,external);assert.equal(tab.isDirty,false);assert.equal(tab.tagForgeCreationPending,true)}finally{(globalThis as any).window=previousWindow}
  })
  it('automatic tag failure preserves the body and reuses its receipt on the successful retry',async()=>{
    const writes:Array<{content:string}>=[];let preparations=0;let finalizations=0;useDocTabs.setState({tabs:[{id:'base2',path:null,title:'base2',content:'',isDirty:false}],activeTabId:'base2',splitTabId:null});useMode.setState({workbenchMode:'document'})
    const api:any={prepareCreation:async()=>{preparations+=1;return preparations===1?{success:false,data:{receiptId:'receipt-failed'},error:'缺少完整标签',errorKind:'insufficient_content_tags',missingContentFacets:['form','topic']}:{success:true,data:{receiptId:'receipt-failed',content:'---\ntags:\n  - 参考资料\n  - AI工作流\nready_state: 待整理\n---\n# 正文仍要保存\n\nAI 工作流参考资料',tags:['参考资料','AI工作流'],workflowState:'待整理'}}},finalizeCreation:async()=>{finalizations+=1;return{success:true,data:{receiptId:'receipt-failed',revision:'hash',path:'/tmp/failed-tag.md',status:'completed'}}}}
    const previousWindow=(globalThis as any).window;(globalThis as any).window={localStorage:{getItem:()=>'/tmp'},electronAPI:{document:{readFile:async()=>({success:false}),writeFile:async(_path:string,content:string)=>{writes.push({content});return{success:true}}},tagForge:api}}
    try{await executeModuleToolAction({...makeParams('document.newTab',{title:'failed-tag'}),tagForgeAPI:api});const tabId=useDocTabs.getState().tabs.find((tab)=>tab.title==='failed-tag')!.id;await executeModuleToolAction({...makeParams('document.setContent',{tabId,content:'# 正文仍要保存\n\nAI 工作流参考资料'}),tagForgeAPI:api});const first=await executeModuleToolAction({...makeParams('document.saveTab',{tabId,path:'/tmp/failed-tag.md'}),tagForgeAPI:api});assert.equal(first.payload?.tagForgeStatus,'failed_retryable');assert.equal(first.payload?.tagForgeEnrichmentRequired,true);assert.equal(first.payload?.tagForgeReceiptId,'receipt-failed');assert.equal(first.payload?.done,false);assert.equal(finalizations,0);assert.match(writes[0]!.content,/正文仍要保存/);const second=await executeModuleToolAction({...makeParams('document.saveTab',{tabId,path:'/tmp/failed-tag.md',tagProposals:[{facet:'form',label:'参考资料',evidenceCode:'form',evidenceExcerpt:'参考资料',confidence:.95},{facet:'domain',label:'AI工作流',evidenceCode:'topic',evidenceExcerpt:'AI 工作流',confidence:.95}]}),tagForgeAPI:api});assert.equal(second.payload?.tagForgeStatus,'completed');assert.equal(second.payload?.tagForgeEnrichmentRequired,false);assert.equal(finalizations,1);assert.equal(preparations,2);assert.match(writes.at(-1)!.content,/tags:\n  - 参考资料\n  - AI工作流/)}finally{(globalThis as any).window=previousWindow}
  })
})

describe('performDocAction · save_tab disk drift', () => {
  it('目标路径还不存在时不能把读取失败当成已保存，必须写出文件', async () => {
    const previousWindow = (globalThis as { window?: unknown }).window
    const writes: Array<{ path: string; content: string }> = []
    ;(globalThis as { window?: unknown }).window = {
      electronAPI: {
        document: {
          readFile: async () => ({ success: false, error: 'ENOENT' }),
          writeFile: async (path: string, content: string) => {
            writes.push({ path, content })
            return { success: true }
          },
        },
      },
    }
    try {
      useDocTabs.setState({
        tabs: [
          { id: 'doc-target', path: '/tmp/new-target.md', title: 'new-target.md', content: '# 新笔记\n', isDirty: false },
        ],
        activeTabId: 'doc-target',
        splitTabId: null,
      })

      const result = await performDocAction({ type: 'save_tab', tabId: 'doc-target' })

      assert.match(result, /已保存文档/)
      assert.deepEqual(writes, [{ path: '/tmp/new-target.md', content: '# 新笔记\n' }])
    } finally {
      ;(globalThis as { window?: unknown }).window = previousWindow
    }
  })

  it('dirty 标记已清但磁盘内容不同步时仍会写回文件', async () => {
    const previousWindow = (globalThis as { window?: unknown }).window
    const writes: Array<{ path: string; content: string }> = []
    ;(globalThis as { window?: unknown }).window = {
      electronAPI: {
        document: {
          readFile: async () => ({ success: true, content: '\n' }),
          writeFile: async (path: string, content: string) => {
            writes.push({ path, content })
            return { success: true }
          },
        },
      },
    }
    try {
      const store = useDocTabs.getState()
      const tab = store.tabs[0]
      store.setActiveTab(tab.id)
      store.setTabPath(tab.id, '/tmp/agent-target.md')
      store.setTabContent(tab.id, '# 新内容\n')
      store.markTabSaved(tab.id)

      const result = await performDocAction({ type: 'save_tab', tabId: tab.id })

      assert.match(result, /已保存文档/)
      assert.deepEqual(writes, [{ path: '/tmp/agent-target.md', content: '# 新内容\n' }])
    } finally {
      ;(globalThis as { window?: unknown }).window = previousWindow
    }
  })

  it('工具写入后即使编辑器异步加载把标签重置为干净态，保存仍使用待落盘内容', async () => {
    const previousWindow = (globalThis as { window?: unknown }).window
    const writes: Array<{ path: string; content: string }> = []
    ;(globalThis as { window?: unknown }).window = {
      electronAPI: {
        document: {
          readFile: async () => ({ success: true, content: '\n' }),
          writeFile: async (path: string, content: string) => {
            writes.push({ path, content })
            return { success: true }
          },
        },
      },
    }
    try {
      const store = useDocTabs.getState()
      const tab = store.tabs[0]
      store.setActiveTab(tab.id)
      store.setTabPath(tab.id, '/tmp/agent-target.md')
      store.setTabContent(tab.id, '\n')
      store.markTabSaved(tab.id)

      await performDocAction({ type: 'set_content', content: '# 人物关系图\n', tabId: tab.id })
      store.setTabContent(tab.id, '\n')
      store.markTabSaved(tab.id)

      const result = await performDocAction({ type: 'save_tab', tabId: tab.id })

      assert.match(result, /已保存文档/)
      assert.deepEqual(writes, [{ path: '/tmp/agent-target.md', content: '# 人物关系图\n' }])
      const savedTab = useDocTabs.getState().tabs.find((item) => item.id === tab.id)
      assert.equal(savedTab?.content, '# 人物关系图\n')
      assert.equal(savedTab?.isDirty, false)
    } finally {
      ;(globalThis as { window?: unknown }).window = previousWindow
    }
  })
})

describe('performDocAction · background document targets', () => {
  it('simulates a read-then-write task without letting an early ambiguous write touch visible panes', async () => {
    const previousWindow = (globalThis as { window?: unknown }).window
    const writes: Array<{ path: string; content: string }> = []
    ;(globalThis as { window?: unknown }).window = {
      electronAPI: {
        document: {
          readFile: async () => ({ success: false, error: 'ENOENT' }),
          writeFile: async (path: string, content: string) => {
            writes.push({ path, content })
            return { success: true }
          },
        },
      },
    }
    try {
      useDocTabs.setState({
        tabs: [
          { id: 'doc-a', path: '/tmp/visible-source.md', title: 'visible-source.md', content: '# Source\n\nKeep this.\n', isDirty: false },
          { id: 'doc-b', path: '/tmp/visible-side.md', title: 'visible-side.md', content: '# Side\n\nKeep this too.\n', isDirty: false },
        ],
        activeTabId: 'doc-a',
        splitTabId: 'doc-b',
      })

      const earlyWrite = await performDocAction({ type: 'set_content', content: '# Wrong target\n' })
      assert.match(earlyWrite, /文档写入已拒绝/)
      assert.equal(useDocTabs.getState().tabs.find((item) => item.id === 'doc-a')?.content, '# Source\n\nKeep this.\n')
      assert.equal(useDocTabs.getState().tabs.find((item) => item.id === 'doc-b')?.content, '# Side\n\nKeep this too.\n')

      await performDocAction({ type: 'new_tab', title: 'target-note', path: '/tmp/target-note.md' })
      await performDocAction({ type: 'set_content', content: '# Target note\n\nFinished.\n' })
      const saved = await performDocAction({ type: 'save_tab' })

      assert.match(saved, /已保存文档/)
      assert.deepEqual(writes, [{ path: '/tmp/target-note.md', content: '# Target note\n\nFinished.\n' }])
      assert.equal(useDocTabs.getState().activeTabId, 'doc-a')
      assert.equal(useDocTabs.getState().splitTabId, 'doc-b')
      assert.equal(useDocTabs.getState().tabs.find((item) => item.id === 'doc-a')?.content, '# Source\n\nKeep this.\n')
      assert.equal(useDocTabs.getState().tabs.find((item) => item.id === 'doc-b')?.content, '# Side\n\nKeep this too.\n')
    } finally {
      ;(globalThis as { window?: unknown }).window = previousWindow
    }
  })

  it('updates a visible split-pane target when the tool carries that tab id', async () => {
    const previousWindow = (globalThis as { window?: unknown }).window
    const writes: Array<{ path: string; content: string }> = []
    ;(globalThis as { window?: unknown }).window = {
      electronAPI: {
        document: {
          readFile: async (path: string) => ({ success: true, content: path.endsWith('B.md') ? '# B old\n' : '' }),
          writeFile: async (path: string, content: string) => {
            writes.push({ path, content })
            return { success: true }
          },
        },
      },
    }
    try {
      useDocTabs.setState({
        tabs: [
          { id: 'doc-a', path: '/tmp/A.md', title: 'A.md', content: '# A\n', isDirty: false },
          { id: 'doc-b', path: '/tmp/B.md', title: 'B.md', content: '# B old\n', isDirty: false },
        ],
        activeTabId: 'doc-a',
        splitTabId: 'doc-b',
      })

      await performDocAction({ type: 'set_content', tabId: 'doc-b', content: '# B updated\n' })
      const saved = await performDocAction({ type: 'save_tab', tabId: 'doc-b' })

      assert.match(saved, /已保存文档/)
      assert.deepEqual(writes, [{ path: '/tmp/B.md', content: '# B updated\n' }])
      assert.equal(useDocTabs.getState().activeTabId, 'doc-a')
      assert.equal(useDocTabs.getState().splitTabId, 'doc-b')
      assert.equal(useDocTabs.getState().tabs.find((item) => item.id === 'doc-a')?.content, '# A\n')
      assert.equal(useDocTabs.getState().tabs.find((item) => item.id === 'doc-b')?.content, '# B updated\n')
    } finally {
      ;(globalThis as { window?: unknown }).window = previousWindow
    }
  })

  it('creates and writes a target document without stealing the visible panes', async () => {
    const previousWindow = (globalThis as { window?: unknown }).window
    const writes: Array<{ path: string; content: string }> = []
    ;(globalThis as { window?: unknown }).window = {
      electronAPI: {
        document: {
          readFile: async () => ({ success: true, content: '' }),
          writeFile: async (path: string, content: string) => {
            writes.push({ path, content })
            return { success: true }
          },
        },
      },
    }
    try {
      useDocTabs.setState({
        tabs: [
          { id: 'doc-a', path: '/tmp/A.md', title: 'A.md', content: '# A\n', isDirty: false },
          { id: 'doc-b', path: '/tmp/B.md', title: 'B.md', content: '# B\n', isDirty: false },
        ],
        activeTabId: 'doc-a',
        splitTabId: 'doc-b',
      })

      const created = await performDocAction({
        type: 'new_tab',
        title: 'C',
        path: '/tmp/C.md',
      })
      assert.match(created, /C\.md/)
      assert.equal(useDocTabs.getState().activeTabId, 'doc-a')
      assert.equal(useDocTabs.getState().splitTabId, 'doc-b')

      await performDocAction({ type: 'set_content', content: '# C\n' })
      const target = useDocTabs.getState().tabs.find((item) => item.path === '/tmp/C.md')
      assert.equal(target?.content, '# C\n')
      assert.equal(useDocTabs.getState().activeTabId, 'doc-a')
      assert.equal(useDocTabs.getState().splitTabId, 'doc-b')

      const saved = await performDocAction({ type: 'save_tab' })
      assert.match(saved, /已保存文档/)
      assert.deepEqual(writes, [{ path: '/tmp/C.md', content: '# C\n' }])
      assert.equal(useDocTabs.getState().activeTabId, 'doc-a')
      assert.equal(useDocTabs.getState().splitTabId, 'doc-b')
    } finally {
      ;(globalThis as { window?: unknown }).window = previousWindow
    }
  })

  it('refreshes an already visible split-pane target without changing the primary pane', async () => {
    const previousWindow = (globalThis as { window?: unknown }).window
    ;(globalThis as { window?: unknown }).window = {
      electronAPI: {
        document: {
          readFile: async () => ({ success: true, content: '# B refreshed\n' }),
        },
      },
    }
    try {
      useDocTabs.setState({
        tabs: [
          { id: 'doc-a', path: '/tmp/A.md', title: 'A.md', content: '# A\n', isDirty: false },
          { id: 'doc-b', path: '/tmp/B.md', title: 'B.md', content: '# B old\n', isDirty: false },
        ],
        activeTabId: 'doc-a',
        splitTabId: 'doc-b',
      })

      const opened = await performDocAction({ type: 'open_tab', path: '/tmp/B.md' })

      assert.match(opened, /已打开并载入文档/)
      const split = useDocTabs.getState().tabs.find((item) => item.id === 'doc-b')
      assert.equal(split?.content, '# B refreshed\n')
      assert.equal(split?.isDirty, false)
      assert.equal(useDocTabs.getState().activeTabId, 'doc-a')
      assert.equal(useDocTabs.getState().splitTabId, 'doc-b')
    } finally {
      ;(globalThis as { window?: unknown }).window = previousWindow
    }
  })
})

describe('shouldApplyAsyncDocumentLoad', () => {
  it('异步加载完成前标签已被写入时不覆盖现有内容', () => {
    const initial = { id: 'tab-1', path: '/tmp/新文档.md', content: '', isDirty: false }
    const current = { id: 'tab-1', path: '/tmp/新文档.md', content: '# 已写入\n', isDirty: true }

    assert.equal(shouldApplyAsyncDocumentLoad(initial, current), false)
  })

  it('同一标签未被修改时允许提交加载结果', () => {
    const initial = { id: 'tab-1', path: '/tmp/新文档.md', content: '', isDirty: false }
    const current = { id: 'tab-1', path: '/tmp/新文档.md', content: '', isDirty: false }

    assert.equal(shouldApplyAsyncDocumentLoad(initial, current), true)
  })
})

test('DOC_ACTION_TARGET_NOT_RESOLVED_PATTERNS 覆盖所有 P-6 文案与 resolveWidgetRecord 错误', () => {
  // 防回归：若 documentActions.ts 的失败文案变更，这里必须同步 classifier 的正则
  const copySamples = [
    '未找到与你选择的卡片对应的 widget（当前文档共有 2 个 widget），请重新选择卡片或在消息里提供标题。',
    '当前文档里还没有 widget，请先插入一个再发起修改。',
    '未找到可更新的 widget，请用标题或序号重试（当前文档共有 5 个 widget）。',
    '未找到序号为 7 的 widget',
    '未找到标题匹配“任意标题”的 widget',
  ]
  for (const copy of copySamples) {
    const reason = classifyDocActionFailureReason(
      { type: 'update_widget', target: 'x', componentSpecPatch: {} },
      copy,
    )
    assert.equal(reason, 'target_not_resolved', `未被归类：${copy}`)
  }
})
