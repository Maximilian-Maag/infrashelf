import { useId, type InputHTMLAttributes } from 'react'

interface InputProps extends InputHTMLAttributes<HTMLInputElement> {
  label: string
  error?: string
  hint?: string
}

export function Input({ label, error, hint, id, className = '', ...props }: InputProps) {
  const generatedId = useId()
  const inputId = id ?? generatedId
  const errorId = `${inputId}-error`
  const hintId = `${inputId}-hint`
  const describedBy = error ? errorId : hint ? hintId : undefined
  return (
    <div className="flex flex-col gap-1">
      <label htmlFor={inputId} className="text-sm font-medium text-slate-700">
        {label}
        {/* red-600, not red-500. red-500 is #fb2c36 — 3.82:1 on white and
            3.65:1 on the slate-50 body, under the 4.5:1 AA needs. axe cannot
            see it: `color-contrast` gates on hasRealTextChildren, which strips
            punctuation before deciding an element has text, so a lone "*" is
            excluded from the check by construction (#185). The e2e suite
            measures glyph-only markers itself for that reason. */}
        {props.required && <span className="ml-1 text-red-600">*</span>}
      </label>
      <input
        id={inputId}
        aria-invalid={error ? true : undefined}
        aria-describedby={describedBy}
        // min-h-11 is the WCAG 2.5.5 target size. A text field is a pointer
        // target like any other, and px-3 py-2 on text-sm came to 38px.
        className={`min-h-11 rounded-lg border px-3 py-2 text-sm text-slate-900 placeholder-slate-500 focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent disabled:bg-slate-50 disabled:text-slate-600 ${
          error ? 'border-red-400 bg-red-50' : 'border-slate-300'
        } ${className}`}
        {...props}
      />
      {hint && !error && <p id={hintId} className="text-xs text-slate-600">{hint}</p>}
      {error && <p id={errorId} className="text-xs text-red-600">{error}</p>}
    </div>
  )
}
