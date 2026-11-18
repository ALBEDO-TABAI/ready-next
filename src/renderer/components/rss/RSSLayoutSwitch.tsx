import { AlignJustify, LayoutGrid } from 'lucide-react'
import { Segmented } from '../ui/Toggle'
import { useRSSLayout, type RSSLayoutSurface } from '../../stores/useRSSLayout'

/** 列表 / 图册 for one 资讯 surface; the surface remembers the choice. */
export default function RSSLayoutSwitch({ surface }: { surface: RSSLayoutSurface }) {
  const layout = useRSSLayout(state => state.layouts[surface]), setLayout = useRSSLayout(state => state.setLayout)
  return <Segmented className="rss-layout-switch" label="版式" value={layout} onChange={value => setLayout(surface, value)}
    options={[{ value: 'list', label: '列表', icon: <AlignJustify /> }, { value: 'gallery', label: '图册', icon: <LayoutGrid /> }]} />
}
