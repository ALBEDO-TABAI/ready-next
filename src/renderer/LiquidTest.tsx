import { useRef } from 'react'
import {
  Bell,
  Compass,
  FolderKanban,
  Inbox,
  MessageSquare,
  Plus,
  Search,
  Sparkles,
} from 'lucide-react'
import {
  LIQUID_CONTENT_SHELL_STYLE,
  LIQUID_CONTROL_PILL_STYLE,
  LIQUID_ICON_DISC_STYLE,
  LIQUID_INACTIVE_CHROME_STYLE,
  LIQUID_PANEL_SHELL_STYLE,
  LIQUID_TEXT_SHADOW,
  LiquidBackdropScene,
  LiquidGlassPrimitive,
  LiquidSceneProvider,
} from './components/ui/LiquidGlassScene'

const sidebarItems = [
  { label: 'Inbox', meta: '12', icon: Inbox },
  { label: 'Design queue', meta: '4', icon: FolderKanban, active: true },
  { label: 'Explore', meta: 'New', icon: Compass },
  { label: 'Messages', meta: '3', icon: MessageSquare },
]

const highlightCards = [
  { title: 'Launch review', body: 'Collect visual feedback for the sidebar motion pass.' },
  { title: 'Asset sync', body: 'Bring in icons, copy blocks, and the next gradient draft.' },
]

export default function LiquidTest() {
  const containerRef = useRef<HTMLDivElement>(null)

  return (
    <LiquidSceneProvider mouseContainer={containerRef}>
      <div
        ref={containerRef}
        className="relative h-full overflow-auto bg-[#050821] text-slate-100"
      >
        <LiquidBackdropScene />
        <div className="relative mx-auto grid min-h-screen w-full max-w-6xl grid-cols-1 gap-0 px-4 py-4 md:grid-cols-[1.15fr_0.85fr] md:px-8 md:py-8">
        <div className="relative overflow-hidden rounded-t-[30px] border border-white/10 md:rounded-l-[30px] md:rounded-r-none">
          <div className="absolute inset-0 bg-[linear-gradient(180deg,rgba(7,9,28,0.26)_0%,rgba(7,9,28,0.08)_100%)]" />
          <div className="relative flex min-h-[860px] items-start justify-start p-6 md:p-10">
            <aside
              className="w-full max-w-[340px] rounded-[32px] p-4 md:p-5"
              style={LIQUID_PANEL_SHELL_STYLE}
            >
              <div className="flex items-start justify-between gap-4">
                <div>
                  <div className="text-[11px] font-medium uppercase tracking-[0.28em] text-white/58">Lab</div>
                  <h1 className="mt-2 text-[28px] font-semibold tracking-tight text-white" style={{ textShadow: LIQUID_TEXT_SHADOW }}>
                    Liquid Glass Sidebar
                  </h1>
                </div>

                <LiquidGlassPrimitive
                  id="add-button"
                  tone="button"
                  style={{ width: 44 }}
                  innerClassName="flex h-11 w-11 items-center justify-center"
                >
                  <Plus size={18} />
                </LiquidGlassPrimitive>
              </div>

              <div className="mt-5">
                <LiquidGlassPrimitive
                  id="search"
                  tone="button"
                  innerClassName="flex items-center gap-3 px-4 py-3"
                >
                  <Search size={16} />
                  <span className="text-sm text-white/88">Search boards and notes</span>
                </LiquidGlassPrimitive>
              </div>

              <div className="mt-6">
                <div className="px-2 text-[11px] font-semibold uppercase tracking-[0.28em] text-white/50">
                  Workspace
                </div>
                <div className="mt-3 space-y-2">
                  {sidebarItems.map((item) => {
                    const Icon = item.icon
                    const content = (
                      <>
                        <div
                          className="flex h-10 w-10 items-center justify-center rounded-full border border-white/12 bg-white/6 text-white/95"
                          style={{ boxShadow: 'inset 0 1px 0 rgba(255,255,255,0.08)' }}
                        >
                          <Icon size={18} />
                        </div>
                        <div className="min-w-0 flex-1">
                          <div className="truncate text-sm font-medium text-white">{item.label}</div>
                          <div className="truncate text-xs text-white/52">Sidebar sample item</div>
                        </div>
                        <div className="rounded-full border border-white/12 bg-white/6 px-2.5 py-1 text-[11px] font-medium text-white/82">
                          {item.meta}
                        </div>
                      </>
                    )

                    if (item.active) {
                      return (
                        <LiquidGlassPrimitive
                          key={item.label}
                          id="active-nav"
                          tone="button"
                          innerClassName="flex items-center gap-3 px-3 py-3"
                        >
                          {content}
                        </LiquidGlassPrimitive>
                      )
                    }

                    return (
                      <button
                        key={item.label}
                        type="button"
                        className="flex w-full items-center gap-3 rounded-[24px] border px-3 py-3 text-left transition-[background-color,border-color,color] duration-200 hover:bg-white/7"
                        style={LIQUID_INACTIVE_CHROME_STYLE}
                      >
                        {content}
                      </button>
                    )
                  })}
                </div>
              </div>

              <div className="mt-6">
                <LiquidGlassPrimitive
                  id="focus-card"
                  tone="card"
                  innerClassName="min-h-[212px] px-5 py-5"
                >
                  <div className="flex h-full flex-col justify-between">
                    <div>
                      <div className="flex items-center gap-2 text-sm font-medium text-white/88">
                        <Sparkles size={16} />
                        Focus card
                      </div>
                      <div className="mt-4 text-[24px] font-semibold leading-8 tracking-tight text-white">
                        Polish the motion language
                      </div>
                    </div>
                    <p className="max-w-[240px] text-sm leading-6 text-white/78">
                      This temporary page isolates the glass effect so we can verify the sidebar feel without touching the current workbench UI.
                    </p>
                  </div>
                </LiquidGlassPrimitive>
              </div>

              <div className="mt-6">
                <LiquidGlassPrimitive
                  id="alert-card"
                  tone="button"
                  innerClassName="flex items-center justify-between gap-4 px-4 py-4"
                >
                  <div>
                    <div className="text-[11px] uppercase tracking-[0.24em] text-white/56">Alerts</div>
                    <div className="mt-1 text-sm font-medium text-white">2 quick updates waiting</div>
                  </div>
                  <div
                    className="flex h-10 w-10 items-center justify-center rounded-full border border-white/12 bg-white/6 text-white/92"
                          style={LIQUID_ICON_DISC_STYLE}
                        >
                          <Bell size={17} />
                        </div>
                    </LiquidGlassPrimitive>
                  </div>
                </aside>
              </div>
        </div>

        <div
          className="rounded-b-[30px] border border-t-0 border-white/10 px-6 py-8 md:rounded-l-none md:rounded-r-[30px] md:border-l-0 md:border-t md:px-8"
            style={LIQUID_CONTENT_SHELL_STYLE}
          >
          <div className="flex items-center justify-between gap-4">
            <div>
              <h2 className="text-2xl font-bold text-white">Glassy Boi but Sidebar</h2>
              <p className="mt-3 max-w-md text-sm leading-6 text-white/62">
                This pass chases the Max Rovensky demo more directly: glass is concentrated in the button and card primitives, while the surrounding shell stays restrained.
              </p>
            </div>
                <div className="rounded-[16px] border px-3 py-2 text-xs uppercase tracking-[0.26em] text-white/60" style={LIQUID_CONTROL_PILL_STYLE}>
                  Inspired
                </div>
              </div>

          <div className="mt-8 flex rounded-[14px] border border-white/8 bg-white/5 p-1">
            <button className="flex-1 rounded-[10px] bg-blue-500 px-4 py-2 text-sm font-medium text-white shadow-lg">
              Sidebar Card
            </button>
            <button className="flex-1 rounded-[10px] px-4 py-2 text-sm font-medium text-white/68 transition-colors hover:bg-white/8 hover:text-white">
              Glass Button
            </button>
          </div>

          <div className="mt-8 space-y-7">
            <section>
              <div className="text-sm font-semibold text-white/88">What changed</div>
              <div className="mt-3 grid gap-3">
                    <div className="rounded-[18px] border px-4 py-4" style={LIQUID_CONTROL_PILL_STYLE}>
                  <div className="text-xs uppercase tracking-[0.24em] text-white/52">Primitive split</div>
                  <div className="mt-2 text-sm leading-6 text-white/78">
                    The outer sidebar is no longer pretending to be one giant slab of glass. Search, active state, plus button, and key cards now each carry the effect independently.
                  </div>
                </div>
                    <div className="rounded-[18px] border px-4 py-4" style={LIQUID_CONTROL_PILL_STYLE}>
                  <div className="text-xs uppercase tracking-[0.24em] text-white/52">Demo-like optics</div>
                  <div className="mt-2 text-sm leading-6 text-white/78">
                    Button primitives use stronger displacement and blur, higher saturation, and the library&apos;s dual ring highlight. Content uses restrained tint and fine micro-noise.
                  </div>
                </div>
              </div>
            </section>

            <section>
              <div className="text-sm font-semibold text-white/88">Preview notes</div>
              <div className="mt-3 grid gap-4 md:grid-cols-2">
                {highlightCards.map((card) => (
                  <div
                    key={card.title}
                    className="rounded-[20px] border p-5"
                    style={LIQUID_CONTROL_PILL_STYLE}
                  >
                    <div className="text-xs font-medium uppercase tracking-[0.24em] text-white/52">Preview note</div>
                    <div className="mt-3 text-lg font-semibold text-white">{card.title}</div>
                    <p className="mt-2 text-sm leading-6 text-white/70">{card.body}</p>
                  </div>
                ))}
              </div>
            </section>
          </div>
        </div>
        </div>
      </div>
    </LiquidSceneProvider>
  )
}
