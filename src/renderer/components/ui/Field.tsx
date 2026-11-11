import { forwardRef, type InputHTMLAttributes, type SelectHTMLAttributes, type TextareaHTMLAttributes } from 'react'
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
