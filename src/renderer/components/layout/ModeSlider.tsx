import { useMode } from '../../stores/useMode'
import { useNavigate } from 'react-router-dom'
import { motion, useReducedMotion } from 'framer-motion'
import { useTheme } from '../../stores/useTheme'

export default function ModeSlider() {
  const { appMode, toggleMode } = useMode()
  const navigate = useNavigate()
  const skin = useTheme((state) => state.skin)
  const isLiquid = skin === 'liquid-glass'
  const reduceMotion = useReducedMotion()
  const isReady = appMode === 'ready'

  const handleToggle = () => {
    toggleMode()
    // Navigate to the other mode's route
    navigate(appMode === 'workbench' ? '/ready' : '/')
  }

  return (
    <motion.button
      onClick={handleToggle}
      whileHover={isLiquid && !reduceMotion ? { y: -1 } : undefined}
      whileTap={isLiquid && !reduceMotion ? { scale: 0.985, y: 0 } : undefined}
      className="glass-surface-card morph-segmented-track relative h-[28px] w-[90px] overflow-hidden rounded-[16px]"
      style={{
        border: '1px solid var(--surface-border)',
      }}
    >
      <motion.span
        className="pointer-events-none absolute"
        animate={{
          x: isReady ? 0 : 38,
          opacity: 1,
        }}
        transition={reduceMotion ? { duration: 0.01 } : { duration: 0.18, ease: 'easeOut' }}
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

      {/* Knob */}
      <motion.div
        animate={{ x: isReady ? 50 : 2 }}
        transition={reduceMotion
          ? { duration: 0.01 }
          : { type: 'spring', stiffness: 420, damping: 22, mass: 0.62 }}
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
        }}
      />
    </motion.button>
  )
}
