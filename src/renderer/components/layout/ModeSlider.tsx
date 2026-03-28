import { useMode } from '../../stores/useMode'
import { motion } from 'framer-motion'

export default function ModeSlider() {
  const { appMode } = useMode()
  const isReady = appMode === 'ready'

  // Disabled - frozen in Workbench mode
  const handleToggle = () => {
    // Do nothing - frozen
  }

  return (
    <motion.button
      onClick={handleToggle}
      disabled={true}
      className="glass-surface-card morph-segmented-track relative h-[28px] w-[90px] overflow-hidden rounded-[16px] opacity-50 cursor-not-allowed"
      style={{
        border: '1px solid var(--surface-border)',
      }}
      title="模式切换已禁用"
    >
      <motion.span
        className="pointer-events-none absolute"
        animate={{
          x: isReady ? 0 : 38,
          opacity: 0.6,
        }}
        transition={{ duration: 0 }}
        style={{
          left: 10,
          top: 9,
          zIndex: 2,
          fontSize: 11,
          lineHeight: 1,
          fontWeight: 600,
          color: isReady ? 'var(--text-secondary)' : 'var(--color-green)',
          whiteSpace: 'nowrap',
        }}
      >
        {isReady ? '工作台' : 'Ready'}
      </motion.span>

      {/* Knob - frozen in current position */}
      <motion.div
        animate={{ x: isReady ? 50 : 2 }}
        transition={{ duration: 0 }}
        className="absolute h-[22px] w-[30px] rounded-[11px]"
        style={{
          left: 2,
          top: 2,
          zIndex: 1,
          border: '1px solid var(--surface-border)',
          background: isReady
            ? 'color-mix(in srgb, var(--color-green-light) 45%, var(--surface-floating-bg))'
            : 'var(--surface-floating-bg)',
          boxShadow: 'var(--lg-shadow-contact)',
          opacity: 0.6,
        }}
      />
    </motion.button>
  )
}
