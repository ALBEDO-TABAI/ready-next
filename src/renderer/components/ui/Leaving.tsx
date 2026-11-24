import { useRef, type HTMLAttributes } from 'react'
import { useLeaveAsGhost } from './leave'

/** A div that fades out in place as an inert copy when it unmounts (motion language M2): for hand-placed floats. */
export function LeavingDiv(props: HTMLAttributes<HTMLDivElement> & { 'data-float-motion'?: string }) {
  const ref = useRef<HTMLDivElement>(null)
  useLeaveAsGhost(ref)
  return <div ref={ref} {...props} />
}
