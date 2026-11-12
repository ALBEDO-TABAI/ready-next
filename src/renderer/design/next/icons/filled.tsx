// Filled twins of the Lucide glyphs the icon rail selects (W1 §3.2: @tabler/icons-react retired; DL8 rail rule:
// the selected glyph glows white and a closed shape swaps to its filled variant). Each one is drawn on Lucide's own
// geometry — the silhouette is filled and stroked at the outline's width, so outline → filled does not jump — and
// the inner lines are cut out with a mask, so they read on any tile colour.
import { Star, type LucideProps } from 'lucide-react'
import { useId, type ReactNode, type SVGProps } from 'react'

export type FilledIconProps = Omit<SVGProps<SVGSVGElement>, 'ref'> & { size?: number | string }

// The mask id carries the glyph's name: useId is only unique within one React root, and two roots that reuse an id
// then still point at the same shape's mask.
function FilledGlyph({ name, size = 24, strokeWidth = 1.8, silhouette, holes, ...rest }: FilledIconProps & { name: string; silhouette: ReactNode; holes?: ReactNode }) {
  const maskId = `rn-glyph-${name}-${useId().replace(/[^a-zA-Z0-9_-]/g, '')}`
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="currentColor"
      stroke="currentColor"
      strokeWidth={strokeWidth}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      {...rest}
    >
      {holes ? (
        <mask id={maskId} maskUnits="userSpaceOnUse" x="-2" y="-2" width="28" height="28">
          <rect x="-2" y="-2" width="28" height="28" fill="#fff" stroke="none" />
          <g fill="none" stroke="#000" strokeWidth={strokeWidth}>{holes}</g>
        </mask>
      ) : null}
      <g mask={holes ? `url(#${maskId})` : undefined}>{silhouette}</g>
    </svg>
  )
}

export function FileTextFilled(props: FilledIconProps) {
  return (
    <FilledGlyph
      {...props}
      name="file-text"
      silhouette={<path d="M15 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7Z" />}
      holes={<><path d="M14 2v4a2 2 0 0 0 2 2h4" /><path d="M10 9H8" /><path d="M16 13H8" /><path d="M16 17H8" /></>}
    />
  )
}

export function CalendarFilled(props: FilledIconProps) {
  return (
    <FilledGlyph
      {...props}
      name="calendar"
      silhouette={<><rect width="18" height="18" x="3" y="4" rx="2" /><path d="M8 2v4" fill="none" /><path d="M16 2v4" fill="none" /></>}
      holes={<path d="M3 10h18" />}
    />
  )
}

export function GlobeFilled(props: FilledIconProps) {
  return (
    <FilledGlyph
      {...props}
      name="globe"
      silhouette={<circle cx="12" cy="12" r="10" />}
      holes={<><path d="M12 2a14.5 14.5 0 0 0 0 20 14.5 14.5 0 0 0 0-20" /><path d="M2 12h20" /></>}
    />
  )
}

export function FolderFilled(props: FilledIconProps) {
  return (
    <FilledGlyph
      {...props}
      name="folder"
      silhouette={<path d="M20 20a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.9a2 2 0 0 1-1.69-.9L9.6 3.9A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2Z" />}
    />
  )
}

/** Lucide's star with its outline filled: the silhouette is already exact. */
export function StarFilled(props: LucideProps) {
  return <Star fill="currentColor" {...props} />
}
