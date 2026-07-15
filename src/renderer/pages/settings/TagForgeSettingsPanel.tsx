import { useEffect,useState } from 'react'
import { TAG_FORGE_AUTO_SETTING_KEY } from '../../../shared/tag-forge'
import { SettingsSwitch } from './settings-shared'
import { SETTINGS_CARD_STYLE } from '../../components/settings/settings-theme'

export function TagForgeSettingsPanel(){
  const [enabled,setEnabled]=useState(true);const[error,setError]=useState('')
  useEffect(()=>{void window.electronAPI.settings.get(TAG_FORGE_AUTO_SETTING_KEY).then((setting)=>{setEnabled(setting.data!=='false')})},[])
  const toggle=async()=>{const next=!enabled;const result=await window.electronAPI.settings.set(TAG_FORGE_AUTO_SETTING_KEY,String(next));if(result.success)setEnabled(next);else setError(result.error||'保存失败')}
  return <div className="space-y-4">
    <div style={SETTINGS_CARD_STYLE} className="flex items-center justify-between gap-6 p-4"><div><div className="text-sm font-medium" style={{color:'var(--text-title)'}}>新文档自动建立标签</div><div className="mt-1 text-xs leading-5" style={{color:'var(--text-muted)'}}>只处理 Agent 本轮真实新建并最终保存的 Markdown；普通编辑不会重新打标。</div></div><SettingsSwitch checked={enabled} onChange={()=>{void toggle()}} /></div>
    {error&&<div className="text-xs" style={{color:'var(--color-red)'}}>{error}</div>}
  </div>
}
