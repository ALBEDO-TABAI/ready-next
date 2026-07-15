import { useDocTabs } from '../../stores/useDocTabs'
import { useMode } from '../../stores/useMode'
import { useWorkspace } from '../../stores/useWorkspace'
import { requestWorkbenchModeOpen } from '../workbench/mode-transition'

export type FileEmergenceAction = {
  kind: 'open_project' | 'open_artifact' | 'open_project_group'
  ref: string
  targetPath?: string | null
  memberPaths?: string[]
}

export interface FileEmergenceActionDeps {
  pathExists(path:string):Promise<boolean>
  openPath(path:string):void
  openProjectGroup(paths:readonly string[],targetPath:string):void
  revealPath(path:string):Promise<void>
}

export async function executeFileEmergenceAction(
  action: FileEmergenceAction,
  deps: FileEmergenceActionDeps = productionDeps(),
): Promise<{success:true}|{success:false;error:string}> {
  const targetPath = action.kind === 'open_artifact' ? action.ref : action.targetPath
  if (!targetPath) return {success:false,error:'这个项目暂时没有可打开的文件'}
  if (!await deps.pathExists(targetPath)) return {success:false,error:'目标文件已移动或删除'}
  try {
    if (action.kind === 'open_project_group') {
      const members = Array.from(new Set([targetPath,...(action.memberPaths ?? [])]))
      const existing:string[]=[]
      for(const path of members.slice(0,3)) if(await deps.pathExists(path)) existing.push(path)
      deps.openProjectGroup(existing,targetPath)
    } else deps.openPath(targetPath)
    await deps.revealPath(targetPath)
    return {success:true}
  } catch(error) {
    // silent-catch: open/reveal failures are returned to the caller as the action's structured failure result.
    return {success:false,error:error instanceof Error?error.message:String(error)}
  }
}

function productionDeps(): FileEmergenceActionDeps {
  return {
    pathExists: async(path)=>Boolean((await window.electronAPI?.document?.stat?.(path).catch(()=>null))?.success),
    openPath: (path)=>openDocumentPaths([path],path,false),
    openProjectGroup: (paths,targetPath)=>openDocumentPaths(paths,targetPath,true),
    revealPath: async(path)=>{
      const workspace=useWorkspace.getState()
      workspace.setSidePanelVariant('files')
      workspace.selectFile(path)
      await workspace.revealFile(path)
    },
  }
}

function openDocumentPaths(paths:readonly string[],targetPath:string,group:boolean):void {
  const docTabs=useDocTabs.getState()
  const ids=paths.map((path)=>docTabs.ensureTabForPath(path)).filter((id):id is string=>Boolean(id))
  if(group&&ids.length>=2){
    const state=useDocTabs.getState();const already=state.tabs.find((tab)=>tab.id===ids[0])?.groupId
    if(!already){state.createTabGroupFromDrop(ids[0],ids[1]);const groupId=useDocTabs.getState().tabs.find((tab)=>tab.id===ids[0])?.groupId;for(const id of ids.slice(2))if(groupId)useDocTabs.getState().addTabToGroup(id,groupId)}
  }
  const targetId=useDocTabs.getState().ensureTabForPath(targetPath)
  if(targetId)useDocTabs.getState().setActiveTab(targetId)
  useMode.getState().setAppMode('workbench')
  requestWorkbenchModeOpen('document')
}
