import { forwardRef, type CSSProperties, type InputHTMLAttributes, type SelectHTMLAttributes, type TextareaHTMLAttributes } from 'react'
import { ChevronDown } from 'lucide-react'

// Field (W1 §5): a recessed slot with a hairline; focus deepens the edge in ink, never the accent.
export const Input = forwardRef<HTMLInputElement, InputHTMLAttributes<HTMLInputElement>>(
  ({ className = '', ...rest }, ref) => <input ref={ref} className={`rn-field ${className}`.trim()} {...rest} />,
)
Input.displayName = 'Input'

export const Textarea = forwardRef<HTMLTextAreaElement, TextareaHTMLAttributes<HTMLTextAreaElement>>(
  ({ className = '', ...rest }, ref) => <textarea ref={ref} className={`rn-field ${className}`.trim()} {...rest} />,
)
Textarea.displayName = 'Textarea'

export interface SelectProps extends SelectHTMLAttributes<HTMLSelectElement> {
  options: { value: string; label: string }[]
}

export const Select = forwardRef<HTMLSelectElement, SelectProps>(({ options, className = '', ...rest }, ref) => (
  <span className="rn-select">
    <select ref={ref} className={`rn-field ${className}`.trim()} {...rest}>
      {options.map(option => <option key={option.value} value={option.value}>{option.label}</option>)}
    </select>
    <ChevronDown aria-hidden="true" />
  </span>
))
Select.displayName = 'Select'

/** A range on a hairline track; the part up to the knob is drawn in ink (the value, not the signal colour). */
export const Slider = forwardRef<HTMLInputElement, Omit<InputHTMLAttributes<HTMLInputElement>, 'type'>>(({ className = '', style, onInput, ...rest }, ref) => {
  const min = Number(rest.min ?? 0), max = Number(rest.max ?? 100)
  const at = (value: number) => `${max > min ? Math.min(100, Math.max(0, (value - min) / (max - min) * 100)) : 0}%`
  return <input ref={ref} type="range" className={`rn-range ${className}`.trim()} style={{ ...style, '--rn-range-at': at(Number(rest.value ?? rest.defaultValue ?? min)) } as CSSProperties}
    // An uncontrolled slider has no re-render to move its fill, so the fill follows the input itself as well.
    onInput={event => { event.currentTarget.style.setProperty('--rn-range-at', at(Number(event.currentTarget.value))); onInput?.(event) }} {...rest} />
})
Slider.displayName = 'Slider'
