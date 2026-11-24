// The motion tokens for script (motion language M1, docs/superpowers/plans/2026-11-24-ready-next-motion-language-implementation.md):
// Element.animate() and framer-motion take numbers, not CSS variables. These mirror tokens.css exactly
// (src/__tests__/motion-tokens.test.ts holds them together); CSS uses the --rn-* variables themselves.

/** Durations in milliseconds: --rn-d-1 … --rn-d-5, --rn-d-release, --rn-d-flash. */
export const MOTION_MS = { d1: 120, d2: 200, d3: 320, d4: 480, d5: 640, release: 520, flash: 1200 } as const

/** Cubic-bézier control points: --rn-ease-out, -in, -std, -in-out. */
export const EASE = {
  out: [0.22, 1, 0.36, 1],
  in: [0.32, 0, 0.67, 0],
  std: [0.2, 0.8, 0.2, 1],
  inOut: [0.65, 0, 0.35, 1],
} as const satisfies Record<string, readonly [number, number, number, number]>

/** The same curves as CSS easing strings, for Element.animate(). */
export const EASE_CSS = {
  out: `cubic-bezier(${EASE.out.join(', ')})`,
  in: `cubic-bezier(${EASE.in.join(', ')})`,
  std: `cubic-bezier(${EASE.std.join(', ')})`,
  inOut: `cubic-bezier(${EASE.inOut.join(', ')})`,
} as const

/**
 * framer-motion: the one spring of the interface (motion language M2) — a selection pill gliding to its new tab or
 * segment, settling in about --rn-d-2 with the barest overshoot (bounce .1; the old pills overshot ~15%).
 */
export const SPRING_UI = { type: 'spring', visualDuration: 0.25, bounce: 0.1 } as const
export const SPRING_INDICATOR = SPRING_UI
export const SPRING_PILL = SPRING_UI
/** framer-motion under reduced motion: changes land at once. */
export const REDUCED_TRANSITION = { duration: 0 } as const

/** The system's reduced-motion setting, read once per call. */
export function prefersReducedMotion(): boolean {
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return false
  try {
    return window.matchMedia('(prefers-reduced-motion: reduce)').matches
  } catch {
    // silent-catch: a window whose matchMedia throws (tests, odd embeds) simply gets full motion.
    return false
  }
}

/** Scrolls glide unless the system asks for reduced motion (M5): pass as `behavior` to scrollTo / scrollIntoView. */
export function scrollBehavior(): ScrollBehavior {
  return prefersReducedMotion() ? 'auto' : 'smooth'
}

/** "Here it is": a block, row or mark briefly tinted with the accent and let go (after a jump to it). */
export function flashElement(element: Element | null | undefined, color = 'var(--rn-accent-soft)') {
  if (!element || typeof (element as HTMLElement).animate !== 'function') return
  ;(element as HTMLElement).animate(
    [{ backgroundColor: color }, { backgroundColor: 'transparent' }],
    { duration: prefersReducedMotion() ? MOTION_MS.d3 : MOTION_MS.flash, easing: EASE_CSS.out },
  )
}
