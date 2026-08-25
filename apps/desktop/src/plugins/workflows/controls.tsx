// The node editor's control vocabulary.
//
// Every knob a scenario step can expose is one of these. They exist as named
// components rather than inline markup so the inspector and anything the
// composer generates render the SAME control for the same kind of value —
// which is what keeps an agent edit and a hand edit indistinguishable.
//
// Each one is a thin adapter over the app's primitive, so the canvas inherits
// the host's control chrome (`controlVariants` / `desktop-input-chrome`)
// instead of carrying a second one. The names below are the canvas vocabulary;
// the pixels are the app's.
//
// Choosing between them:
//
//   Field        wrapper: label + control + hint. Everything else goes inside one.
//   TextInput    a short string (node name)
//   TextArea     prose the model reads (goal)
//   Select       one of many, where the list is long or grows (model, profile)
//   Segmented    one of 2-3, where seeing all options matters (role, on-fail)
//   Switch       a boolean that changes how the node BEHAVES (blind, approval)
//   Checkbox     a boolean that marks a row in a list (field required)
//   Stepper      a bounded number you nudge (budgets, retries)
//   TagInput     free-form multi-value (skills to preload)
//   ReadOnly     a value the canvas derives; shown for orientation, not editing
//
// Switch vs Checkbox is a real distinction, not a style choice: a switch reads
// as "this mode is on", a checkbox as "this item is included".

import {
  cn,
  Codicon,
  controlVariants,
  Input,
  SegmentedControl,
  SelectContent,
  SelectGroup,
  SelectLabel,
  SelectTrigger,
  SelectValue,
  Textarea,
  Checkbox as UICheckbox,
  Select as UISelect,
  SelectItem as UISelectItem,
  Stepper as UIStepper,
  Switch as UISwitch
} from '@hermes/plugin-sdk'
import { type ComponentProps, type ReactNode, useState } from 'react'

/** React Flow drags the card under any pointer press it owns; every control
 *  inside a node has to opt out. */
const NODRAG = 'nodrag'

/* ------------------------------------------------------------- controls --- */

export function TextInput({
  value,
  onChange,
  placeholder
}: {
  value: string
  onChange: (v: string) => void
  placeholder?: string
}) {
  return (
    <Input
      className={NODRAG}
      onChange={e => onChange(e.target.value)}
      placeholder={placeholder}
      size="sm"
      value={value}
    />
  )
}

export function TextArea({
  value,
  onChange,
  rows = 4,
  placeholder
}: {
  value: string
  onChange: (v: string) => void
  rows?: number
  placeholder?: string
}) {
  return (
    <Textarea
      className={cn(NODRAG, 'min-h-0 resize-y')}
      onChange={e => onChange(e.target.value)}
      placeholder={placeholder}
      rows={rows}
      size="sm"
      value={value}
    />
  )
}

/** Options are bare strings where the value reads fine on its own (a model
 *  slug, a step id) and {value,label} where it doesn't ("all-pass" wants to say
 *  "All pass"). One control either way, so nothing grows a second select. */
export type Option = string | { value: string; label: string }
/** A headed run of options — the native `optgroup`. */
export type OptionGroup = { label: string; options: readonly Option[] }

const valueOf = (o: Option) => (typeof o === 'string' ? o : o.value)
const labelOf = (o: Option) => (typeof o === 'string' ? o : o.label)

const isGrouped = (o: readonly (Option | OptionGroup)[]): o is readonly OptionGroup[] =>
  typeof o[0] === 'object' && o[0] !== null && 'options' in o[0]

/** Radix keeps "" for "nothing is selected" and throws on an item that uses it,
 *  but an empty value here is a real choice — "inherit from the profile" — so
 *  it travels under a sentinel and is unwrapped at the boundary. */
const EMPTY = '\u0000empty'

export function Select({
  value,
  onChange,
  options,
  placeholder,
  title,
  className,
  label
}: {
  value: string
  onChange: (v: string) => void
  options: readonly Option[] | readonly OptionGroup[]
  /** Shown as the empty choice — e.g. "inherit from profile". */
  placeholder?: string
  title?: string
  className?: string
  /** For the triggers that carry no visible label of their own. */
  label?: string
}) {
  const groups: readonly OptionGroup[] = !options.length
    ? []
    : isGrouped(options)
      ? options
      : [{ label: '', options: options as readonly Option[] }]

  return (
    <UISelect onValueChange={v => onChange(v === EMPTY ? '' : v)} value={value === '' ? EMPTY : value}>
      <SelectTrigger aria-label={label} className={cn(NODRAG, className)} size="sm" title={title}>
        <SelectValue placeholder={placeholder} />
      </SelectTrigger>
      <SelectContent>
        {placeholder !== undefined && <UISelectItem value={EMPTY}>{placeholder}</UISelectItem>}
        {groups.map((g, i) => (
          <SelectGroup key={g.label || i}>
            {g.label && <SelectLabel>{g.label}</SelectLabel>}
            {g.options.map(o => (
              <UISelectItem key={valueOf(o)} value={valueOf(o)}>
                {labelOf(o)}
              </UISelectItem>
            ))}
          </SelectGroup>
        ))}
      </SelectContent>
    </UISelect>
  )
}

export function Segmented<T extends string>({
  value,
  onChange,
  options
}: {
  value: T
  onChange: (v: T) => void
  options: readonly { value: T; label: string }[]
}) {
  return (
    <SegmentedControl
      className={cn(NODRAG, 'w-full')}
      onChange={onChange}
      options={options.map(o => ({ id: o.value, label: o.label }))}
      value={value}
    />
  )
}

export function Switch({
  checked,
  onChange,
  title,
  hint
}: {
  checked: boolean
  onChange: (v: boolean) => void
  title: string
  hint?: string
}) {
  return (
    <label className="flex flex-col gap-1">
      <span className="flex items-center gap-2">
        <UISwitch checked={checked} className={NODRAG} onCheckedChange={onChange} />
        <span className="text-[0.6875rem] leading-4 text-(--ui-text-primary)">{title}</span>
      </span>
      {hint && <span className="text-[0.6875rem] leading-4 text-(--ui-text-tertiary)">{hint}</span>}
    </label>
  )
}

export function Checkbox({
  checked,
  onChange,
  label
}: {
  checked: boolean
  onChange: (v: boolean) => void
  label: string
}) {
  return (
    <label className="flex items-center gap-2">
      <UICheckbox checked={checked} className={NODRAG} onCheckedChange={v => onChange(v === true)} />
      <span className="text-[0.6875rem] leading-4 text-(--ui-text-primary)">{label}</span>
    </label>
  )
}

/** The app's Stepper, wearing the canvas's drag opt-out. */
export function Stepper(props: ComponentProps<typeof UIStepper>) {
  return <UIStepper {...props} className={NODRAG} />
}

export function TagInput({
  values,
  onChange,
  placeholder
}: {
  values: string[]
  onChange: (v: string[]) => void
  placeholder?: string
}) {
  const [draft, setDraft] = useState('')

  const commit = () => {
    const t = draft.trim().replace(/,$/, '')

    if (t && !values.includes(t)) {
      onChange([...values, t])
    }

    setDraft('')
  }

  return (
    <div className={cn(controlVariants({ size: 'sm' }), NODRAG, 'flex flex-wrap items-center gap-1')}>
      {values.map(v => (
        <span
          className="inline-flex items-center gap-1 rounded-[3px] bg-(--ui-bg-tertiary) px-1.5 py-0.5 text-[0.6875rem] leading-4"
          key={v}
        >
          {v}
          <button
            aria-label={`Remove ${v}`}
            className="text-(--ui-text-tertiary) transition-colors hover:text-foreground"
            onClick={() => onChange(values.filter(x => x !== v))}
            type="button"
          >
            <Codicon name="close" size="0.625rem" />
          </button>
        </span>
      ))}
      <input
        className="min-w-16 flex-1 border-0 bg-transparent text-xs leading-4 outline-none placeholder:text-muted-foreground"
        onBlur={commit}
        onChange={e => setDraft(e.target.value)}
        onKeyDown={e => {
          if (e.key === 'Enter' || e.key === ',') {
            e.preventDefault()
            commit()
          } else if (e.key === 'Backspace' && !draft && values.length) {
            onChange(values.slice(0, -1))
          }
        }}
        placeholder={values.length ? '' : placeholder}
        value={draft}
      />
    </div>
  )
}

export function ReadOnly({ children }: { children: ReactNode }) {
  return <span className="text-xs leading-4 text-(--ui-text-tertiary)">{children}</span>
}
