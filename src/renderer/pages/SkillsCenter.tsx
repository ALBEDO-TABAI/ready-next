import { ChevronLeft } from 'lucide-react'
import { useNavigate } from 'react-router-dom'
import SkillsCenterPanel from '../components/layout/SkillsCenterPanel'
import { Button } from '../components/ui'
import './skills-center.css'

// The skills centre as a page of its own, at the same level as settings (W2 §2.3). It belongs to the
// assistant: the assistant's header and ⌘K open it; it no longer takes the sidebar.
export default function SkillsCenter() {
  const navigate = useNavigate()
  return (
    <div className="skills-center-page settings-page-shell rn-ui">
      <header className="skills-center-page__header drag-region" data-liquid-shell="settings-header">
        <Button className="no-drag" variant="ghost" size="sm" icon={<ChevronLeft strokeWidth={2} />} onClick={() => navigate('/')}>
          返回
        </Button>
        <h1 className="skills-center-page__title">技能中心</h1>
      </header>
      <main className="skills-center-page__body">
        <SkillsCenterPanel>
          {({ header, body }) => (
            <section className="skills-center-page__panel" aria-label="技能">
              <div className="skills-center-page__panel-head">{header}</div>
              <div className="skills-center-page__panel-body">{body}</div>
            </section>
          )}
        </SkillsCenterPanel>
      </main>
    </div>
  )
}
