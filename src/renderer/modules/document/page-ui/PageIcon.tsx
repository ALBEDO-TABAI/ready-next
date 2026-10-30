import { FileText, Folder } from 'lucide-react'
import { DynamicIcon, iconNames, type IconName } from 'lucide-react/dynamic'

function isIconName(name: string): name is IconName { return iconNames.some(icon => icon === name) }
export function PageIcon({ value, folder = false }: { value?: string; folder?: boolean }) {
  if (value?.startsWith('lucide:')) {
    const name = value.slice(7)
    if (isIconName(name)) return <DynamicIcon key={name} name={name} size={16} aria-label={value} />
    return <span title={`未知图标：${value}`}>◇</span>
  }
  if (value && !/[/.\\]/.test(value)) return <span aria-hidden="true">{value}</span>
  const Icon = folder ? Folder : FileText
  return <Icon size={16} aria-hidden="true" />
}

export function PageIconOptions({ id }: { id: string }) {
  return <datalist id={id}>{['📄', '🌱', '💡', 'lucide:book-open', 'lucide:star', 'lucide:heart', 'lucide:camera'].map(value => <option key={value} value={value} />)}</datalist>
}
