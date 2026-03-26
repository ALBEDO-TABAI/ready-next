import { useState } from 'react'
import { Plus, Save } from 'lucide-react'
import { SETTINGS_INPUT_STYLE, SETTINGS_PRIMARY_BUTTON_STYLE, SETTINGS_TEXTAREA_STYLE } from '../settings/settings-theme'

const fieldStyle = {
  ...SETTINGS_INPUT_STYLE,
}

const primaryButtonStyle = {
  ...SETTINGS_PRIMARY_BUTTON_STYLE,
}

export default function MemoryCreator() {
  const [scopeId, setScopeId] = useState('')
  const [category, setCategory] = useState<'summary' | 'learning'>('summary')
  const [title, setTitle] = useState('')
  const [content, setContent] = useState('')
  const [tags, setTags] = useState('')
  const [priority, setPriority] = useState(0)
  const [creating, setCreating] = useState(false)
  const [message, setMessage] = useState('')

  const handleCreate = async () => {
    if (!scopeId || !title || !content) {
      setMessage('请填写所有必填字段')
      return
    }

    setCreating(true)
    setMessage('')

    try {
      const result = await window.electronAPI.memory.createFromConversation({
        scopeId,
        category,
        title,
        content,
        tags: tags ? tags.split(',').map((t) => t.trim()) : undefined,
        priority,
      })

      if (result.success && result.data) {
        setMessage(`✓ 记忆创建成功: ${result.data.memoryId}`)
        // Reset form
        setTitle('')
        setContent('')
        setTags('')
        setPriority(0)
      } else {
        setMessage(`✗ 创建失败: ${result.error || '未知错误'}`)
      }
    } catch (err) {
      setMessage(`✗ 创建失败: ${err instanceof Error ? err.message : String(err)}`)
    } finally {
      setCreating(false)
    }
  }

  return (
    <div
      className="flex flex-col"
      style={{
        gap: 18,
      }}
    >
      <div className="flex items-center gap-2 mb-6">
        <Plus className="w-5 h-5" style={{ color: 'var(--color-blue)' }} />
        <h3 className="text-[15px] font-medium" style={{ color: 'var(--text-title)' }}>
          创建记忆
        </h3>
      </div>

      <div className="space-y-4">
        <div>
          <label className="text-[12px] block mb-2" style={{ color: 'var(--text-body)' }}>
            Scope ID *
          </label>
          <input
            type="text"
            value={scopeId}
            onChange={(e) => setScopeId(e.target.value)}
            placeholder="输入 Scope ID"
            className="w-full border rounded-lg text-[13px]"
            style={{
              ...fieldStyle,
              padding: '10px 14px',
            }}
          />
        </div>

        <div>
          <label className="text-[12px] block mb-2" style={{ color: 'var(--text-body)' }}>
            类别 *
          </label>
          <select
            value={category}
            onChange={(e) => setCategory(e.target.value as 'summary' | 'learning')}
            className="w-full border rounded-lg text-[13px]"
            style={{
              ...fieldStyle,
              padding: '10px 14px',
            }}
          >
            <option value="summary">摘要 (会话级)</option>
            <option value="learning">学习 (全局)</option>
          </select>
        </div>

        <div>
          <label className="text-[12px] block mb-2" style={{ color: 'var(--text-body)' }}>
            标题 *
          </label>
          <input
            type="text"
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            placeholder="记忆标题"
            className="w-full border rounded-lg text-[13px]"
            style={{
              ...fieldStyle,
              padding: '10px 14px',
            }}
          />
        </div>

        <div>
          <label className="text-[12px] block mb-2" style={{ color: 'var(--text-body)' }}>
            内容 *
          </label>
          <textarea
            value={content}
            onChange={(e) => setContent(e.target.value)}
            placeholder="记忆内容"
            rows={6}
            className="w-full border rounded-lg text-[13px]"
            style={{
              ...SETTINGS_TEXTAREA_STYLE,
              padding: '10px 14px',
            }}
          />
        </div>

        <div>
          <label className="text-[12px] block mb-2" style={{ color: 'var(--text-body)' }}>
            标签 (逗号分隔)
          </label>
          <input
            type="text"
            value={tags}
            onChange={(e) => setTags(e.target.value)}
            placeholder="标签1, 标签2, 标签3"
            className="w-full border rounded-lg text-[13px]"
            style={{
              ...fieldStyle,
              padding: '10px 14px',
            }}
          />
        </div>

        <div>
          <label className="text-[12px] block mb-2" style={{ color: 'var(--text-body)' }}>
            优先级
          </label>
          <input
            type="number"
            value={priority}
            onChange={(e) => setPriority(parseInt(e.target.value) || 0)}
            className="w-full border rounded-lg text-[13px]"
            style={{
              ...fieldStyle,
              padding: '10px 14px',
            }}
          />
        </div>

        {message && (
          <div
            className="text-[12px] p-3 rounded-lg"
            style={{
              background: message.startsWith('✓') ? 'var(--color-green-light)' : 'var(--color-red-light)',
              color: message.startsWith('✓') ? 'var(--color-green)' : 'var(--color-red)',
            }}
          >
            {message}
          </div>
        )}

        <button
          onClick={() => void handleCreate()}
          disabled={creating}
          className="w-full border rounded-xl transition-all flex items-center justify-center gap-2 disabled:opacity-50 disabled:cursor-not-allowed hover:opacity-90"
          style={{
            ...primaryButtonStyle,
            padding: '12px 16px',
            fontSize: '13px',
          }}
        >
          <Save className="w-4 h-4" />
          {creating ? '创建中...' : '创建记忆'}
        </button>
      </div>
    </div>
  )
}
