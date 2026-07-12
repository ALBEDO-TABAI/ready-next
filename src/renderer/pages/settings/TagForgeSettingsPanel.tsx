import { useCallback,useEffect,useState } from 'react'
import { TAG_FORGE_AUTO_SETTING_KEY } from '../../../shared/tag-forge'
import { SettingsSwitch } from './settings-shared'
import { SETTINGS_CARD_STYLE,SETTINGS_SECONDARY_BUTTON_STYLE } from '../../components/settings/settings-theme'

type Pending={proposalId:string;facet:string;label:string;evidenceCode:string;evidenceExcerpt:string|null}
export function TagForgeSettingsPanel(){
  const [enabled,setEnabled]=useState(true);const[pending,setPending]=useState<Pending[]>([]);const[error,setError]=useState('')
  const refresh=useCallback(async()=>{const [setting,items]=await Promise.all([window.electronAPI.settings.get(TAG_FORGE_AUTO_SETTING_KEY),window.electronAPI.tagForge.listPending()]);setEnabled(setting.data!=='false');setPending(items.success?items.data??[]:[]);if(!items.success)setError(items.error||'读取待审核标签失败')},[])
  useEffect(()=>{void refresh()},[refresh])
  const toggle=async()=>{const next=!enabled;const result=await window.electronAPI.settings.set(TAG_FORGE_AUTO_SETTING_KEY,String(next));if(result.success)setEnabled(next);else setError(result.error||'保存失败')}
  const review=async(proposalId:string,decision:'approve'|'reject')=>{const result=await window.electronAPI.tagForge.reviewPending({proposalId,decision});if(result.success)await refresh();else setError(result.error||'审核失败')}
  return <div className="space-y-4">
    <div style={SETTINGS_CARD_STYLE} className="flex items-center justify-between gap-6 p-4"><div><div className="text-sm font-medium" style={{color:'var(--text-title)'}}>新文档自动建立标签</div><div className="mt-1 text-xs leading-5" style={{color:'var(--text-muted)'}}>只处理 Agent 本轮真实新建并最终保存的 Markdown；普通编辑不会重新打标。</div></div><SettingsSwitch checked={enabled} onChange={()=>{void toggle()}} /></div>
    <div style={SETTINGS_CARD_STYLE} className="p-4"><div className="text-sm font-medium" style={{color:'var(--text-title)'}}>待审核新词 <span style={{color:'var(--text-muted)'}}>({pending.length})</span></div>
      {pending.length===0?<div className="mt-3 text-xs" style={{color:'var(--text-muted)'}}>当前没有待审核词条。</div>:<div className="mt-3 space-y-2">{pending.map((item)=><div key={item.proposalId} className="flex items-center justify-between gap-3 rounded-lg px-3 py-2" style={{background:'var(--bg-secondary)'}}><div><div className="text-sm" style={{color:'var(--text-title)'}}>{item.label} <span className="text-xs" style={{color:'var(--text-muted)'}}>{item.facet}</span></div><div className="text-xs" style={{color:'var(--text-muted)'}}>{item.evidenceExcerpt||item.evidenceCode}</div></div><div className="flex gap-2"><button style={SETTINGS_SECONDARY_BUTTON_STYLE} onClick={()=>{void review(item.proposalId,'reject')}}>废弃</button><button style={SETTINGS_SECONDARY_BUTTON_STYLE} onClick={()=>{void review(item.proposalId,'approve')}}>转正</button></div></div>)}</div>}
    </div>{error&&<div className="text-xs" style={{color:'var(--color-red)'}}>{error}</div>}
  </div>
}
