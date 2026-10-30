import { useEffect, useRef, type HTMLAttributes } from 'react'
import { attachGlass } from './glass'

export function Glass({ className = '', ...props }: HTMLAttributes<HTMLDivElement>) {
  const ref = useRef<HTMLDivElement>(null)
  useEffect(() => ref.current ? attachGlass(ref.current) : undefined, [])
  return <div {...props} ref={ref} className={`rn-glass ${className}`} />
}
