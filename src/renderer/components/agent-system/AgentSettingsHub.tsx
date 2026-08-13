import PersonalityEditor from '../personality/PersonalityEditor'
import AgentSystemStudio from './AgentSystemStudio'

export default function AgentSettingsHub() {
  return (
    <div className="flex flex-col gap-5">
      <div className="text-[12px] leading-5" style={{ color: 'var(--text-light)' }}>
        这里保存的是历史人格资料，便于查阅和整理；不会改变当前 Codex 的身份、语气、知识或任务分配。
      </div>
      <PersonalityEditor />
      <AgentSystemStudio />
    </div>
  )
}
