import { useEffect,useState } from 'react'
import { TAG_FORGE_AUTO_SETTING_KEY } from '../../../shared/tag-forge'
import { Switch } from '../../components/ui'
import { SettingsCard, SettingsNotice, SettingsRow } from './settings-shared'

export function TagForgeSettingsPanel(){
  const [enabled,setEnabled]=useState(true);const[error,setError]=useState('')
  useEffect(()=>{void window.electronAPI.settings.get(TAG_FORGE_AUTO_SETTING_KEY).then((setting)=>{setEnabled(setting.data!=='false')})},[])
  const toggle=async()=>{const next=!enabled;const result=await window.electronAPI.settings.set(TAG_FORGE_AUTO_SETTING_KEY,String(next));if(result.success)setEnabled(next);else setError(result.error||'保存失败')}
  return <div className="flex flex-col gap-3">
    <SettingsCard>
      <SettingsRow label="新文档自动建立标签" description="只处理 Agent 本轮真实新建并最终保存的 Markdown；普通编辑不会重新打标。">
        <Switch label="新文档自动建立标签" checked={enabled} onChange={()=>{void toggle()}} />
      </SettingsRow>
    </SettingsCard>
    {error&&<SettingsNotice tone="danger" title={error} />}
  </div>
}
