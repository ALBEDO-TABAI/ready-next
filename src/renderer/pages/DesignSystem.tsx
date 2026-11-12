import { useState, type ReactNode } from 'react'
import { Bold, Copy, FileText, Inbox, Italic, Link2, MoreHorizontal, Plus, Search, Trash2 } from 'lucide-react'
import {
  Button, Checkbox, Chip, confirmDialog, EmptyState, IconButton, Input, Kbd, ListRow, MenuList, openMenu, ResizeHandle,
  ScrollArea, SectionHeader, Segmented, Select, showToast, Skeleton, Switch, Tabs, Textarea, Toolbar, ToolbarSeparator, tooltip,
  anchorOf, RefCapsule, type MenuEntry,
} from '../components/ui'
import './design-system.css'

// The primitives showcase (W1-T4): every primitive and state, in both themes side by side, with a
// local "reduce transparency" switch. It is the authority for how the primitives look and the fixed
// screen of the design matrix. Experimental route (#/design-system); never the default entry.

const MENU: MenuEntry[] = [
  { kind: 'group', label: '页面' },
  { id: 'open', label: '在新标签打开', icon: <FileText />, hint: '⌘↵', onSelect: () => showToast('已在新标签打开') },
  { id: 'copy', label: '复制链接', icon: <Link2 />, hint: '⌘L', onSelect: () => showToast('链接已复制') },
  { id: 'fav', label: '收藏', checked: true, onSelect: () => showToast('已取消收藏') },
  { kind: 'separator' },
  { id: 'dup', label: '创建副本', icon: <Copy />, disabled: true, onSelect: () => {} },
  { id: 'del', label: '移到回收站', icon: <Trash2 />, danger: true, onSelect: () => showToast('已移到回收站', { actions: [{ label: '撤销', onClick: () => showToast('已恢复') }] }) },
]

function Specimen({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="ds-specimen">
      <h3 className="ds-specimen__title">{title}</h3>
      <div className="ds-specimen__body">{children}</div>
    </section>
  )
}

function Column({ theme }: { theme: 'light' | 'dark' }) {
  const [on, setOn] = useState(true)
  const [checked, setChecked] = useState<boolean | 'mixed'>('mixed')
  const [view, setView] = useState<'list' | 'board' | 'calendar'>('list')
  const [tab, setTab] = useState('a')
  const [tabs, setTabs] = useState([{ id: 'a', label: '新书发布', closable: true }, { id: 'b', label: '选题库', closable: true }, { id: 'c', label: '一个很长很长的页面标题会被截断', closable: true }])
  const [row, setRow] = useState('pages')
  const [width, setWidth] = useState(160)
  return (
    <div className="ds-column rn-ui" data-theme={theme}>
      <h2 className="ds-column__title">{theme === 'light' ? '浅色' : '深色'}</h2>

      <Specimen title="材质：玻璃 · 纸 · 台 · 浮层">
        <div className="ds-materials">
          <div className="ds-material rn-glass-root"><span>玻璃</span></div>
          <div className="ds-material rn-sheet"><span>纸</span></div>
          <div className="ds-material rn-well"><span>台</span></div>
          <div className="ds-material rn-float"><span>浮层</span></div>
        </div>
      </Specimen>

      <Specimen title="按钮">
        <div className="ds-row">
          <Button variant="primary">保存</Button>
          <Button>取消</Button>
          <Button variant="ghost" icon={<Plus />}>新建</Button>
          <Button variant="danger" icon={<Trash2 />}>删除</Button>
          <Button disabled>不可用</Button>
        </div>
        <div className="ds-row">
          <Button size="sm" variant="primary">小号</Button>
          <Button size="sm">小号</Button>
          <IconButton title="搜索" icon={<Search />} {...tooltip('搜索', '⌘K')} />
          <IconButton title="加粗" icon={<Bold />} active />
          <IconButton title="斜体" icon={<Italic />} active={false} />
          <IconButton title="更多" size="sm" icon={<MoreHorizontal />} />
          <IconButton title="新建" size="lg" icon={<Plus />} />
        </div>
      </Specimen>

      <Specimen title="输入">
        <div className="ds-stack">
          <Input placeholder="搜索页面…" aria-label="搜索页面" />
          <Input defaultValue="RSS 的筛子理论" aria-label="标题" />
          <Input defaultValue="缺少日期" aria-invalid="true" aria-label="出错的输入" />
          <Input placeholder="不可用" disabled aria-label="不可用的输入" />
          <Select aria-label="排序" options={[{ value: 'recent', label: '最近编辑' }, { value: 'title', label: '标题' }]} defaultValue="recent" />
          <Textarea placeholder="写点什么…" aria-label="备注" />
        </div>
      </Specimen>

      <Specimen title="开关 · 勾选 · 分段">
        <div className="ds-row">
          <Switch label="减少透明" checked={on} onChange={setOn} />
          <Switch label="关闭的开关" checked={false} onChange={() => {}} />
          <Switch label="不可用的开关" checked disabled onChange={() => {}} />
        </div>
        <div className="ds-row">
          <Checkbox label="部分选中" checked={checked} onChange={value => setChecked(value)} />
          <Checkbox label="未选中" checked={false} onChange={() => {}} />
          <Checkbox label="选中" checked onChange={() => {}} />
        </div>
        <Segmented label="视图" value={view} onChange={setView} options={[{ value: 'list', label: '列表' }, { value: 'board', label: '看板' }, { value: 'calendar', label: '日历' }]} />
      </Specimen>

      <Specimen title="标签">
        <Tabs label="打开的页面" items={tabs} value={tab} onChange={setTab} onClose={id => setTabs(items => items.filter(item => item.id !== id))} />
      </Specimen>

      <Specimen title="列表行 · 小节标题 · 工具条">
        <div className="ds-list">
          <SectionHeader title="页面" actions={<IconButton title="新建页面" size="sm" icon={<Plus />} />} />
          {[['home', '主页', '今天'], ['pages', '新书发布', '3'], ['db', '选题库', '5'], ['inbox', '暂存', '12']].map(([id, label, meta]) => (
            <ListRow key={id} icon={<FileText />} label={label} meta={meta} current={row === id} onClick={() => setRow(id)} />
          ))}
        </div>
        <Toolbar label="格式">
          <IconButton title="加粗" icon={<Bold />} />
          <IconButton title="斜体" icon={<Italic />} />
          <ToolbarSeparator />
          <IconButton title="链接" icon={<Link2 />} />
          <Button size="sm" variant="ghost" onClick={event => openMenu(anchorOf(event.currentTarget), MENU, { label: '页面操作' })}>更多</Button>
        </Toolbar>
      </Specimen>

      <Specimen title="菜单（静态）">
        <div className="rn-float ds-menu-frame"><MenuList items={MENU} label="页面操作示例" onDone={() => {}} /></div>
      </Specimen>

      <Specimen title="胶囊 · 键帽">
        <div className="ds-row">
          <Chip icon={<FileText />}>新书发布</Chip>
          <Chip onClick={() => showToast('筛选：AI')}>AI</Chip>
          <Kbd>⌘K</Kbd><Kbd>⌘⇧P</Kbd>
        </div>
      </Specimen>

      <Specimen title="引用胶囊（W6）">
        <p className="ds-prose">相关：<RefCapsule reference={{ kind: 'page', id: 'ds-page' }} title="新书发布" />、<RefCapsule reference={{ kind: 'page', id: 'ds-db' }} typeHint="数据库" title="选题库" />、<RefCapsule reference={{ kind: 'canvas', id: 'ds-board' }} title="灵感" />、<RefCapsule reference={{ kind: 'book-location', book: 'ds-book', loc: 'c2:0+1' }} title="城市漫游者 · 第 3 章" />、<RefCapsule reference={{ kind: 'event', id: 'ds-event' }} title="封面评审" />、<RefCapsule reference={{ kind: 'day', date: '2026-11-14' }} title="11月14日" />、<RefCapsule reference={{ kind: 'rss-item', id: 'ds-article' }} title="RSS 没有死，只是换了读法" />、<RefCapsule reference={{ kind: 'web', url: 'https://example.com/' }} title="example.com" />、<RefCapsule reference={{ kind: 'conversation', id: 'ds-chat' }} title="筛子讨论" />、<RefCapsule reference={{ kind: 'fastcard', id: 'ds-card' }} title="一个好的筛子" />。</p>
      </Specimen>

      <Specimen title="浮层：菜单 · 提示 · 对话框 · 通知">
        <div className="ds-row">
          <Button size="sm" onClick={event => openMenu(anchorOf(event.currentTarget), MENU, { label: '页面操作' })}>打开菜单</Button>
          <Button size="sm" onClick={async () => { const ok = await confirmDialog({ title: '移到回收站？', body: '《新书发布》和它的 2 个子页面会移到回收站，30 天内可以恢复。', confirmLabel: '移到回收站', danger: true }); showToast(ok ? '已移到回收站' : '已取消') }}>打开对话框</Button>
          <Button size="sm" onClick={() => showToast('已保存到资料库')}>显示通知</Button>
          <Button size="sm" {...tooltip('这是一条提示', '⌘/')}>悬停看提示</Button>
        </div>
      </Specimen>

      <Specimen title="空状态 · 骨架 · 滚动区 · 拖拽分隔">
        <div className="ds-split">
          <ScrollArea className="ds-scroll" style={{ width }}>
            {Array.from({ length: 14 }, (_, i) => <div key={i} className="ds-scroll__line">第 {i + 1} 行</div>)}
          </ScrollArea>
          <ResizeHandle label="调整宽度" onResize={delta => setWidth(value => Math.max(100, Math.min(260, value + delta)))} />
          <div className="ds-stack ds-grow">
            <EmptyState icon={<Inbox />} title="暂存是空的" body="在任何地方选中内容，按 ⌘⇧S 收下。" />
            <Skeleton width="80%" /><Skeleton width="60%" /><Skeleton width="70%" />
          </div>
        </div>
      </Specimen>
    </div>
  )
}

export default function DesignSystem() {
  const [reduced, setReduced] = useState(false)
  return (
    <div className="ds-page rn-ui" data-design-system-page data-transparency={reduced ? 'reduced' : undefined}>
      <header className="ds-header">
        <h1>Ready Next 基元</h1>
        <label className="ds-header__toggle">减少透明 <Switch label="预览减少透明" checked={reduced} onChange={setReduced} /></label>
      </header>
      <div className="ds-columns">
        <Column theme="light" />
        <Column theme="dark" />
      </div>
    </div>
  )
}
