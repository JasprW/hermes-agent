import type { ReactNode } from 'react'

import { cn } from '@/lib/utils'

// Shared form-field primitive for dialog forms: a label stacked above its
// control, with an optional inline "(optional)" tag. Pair with FieldHint for
// help text below the control. This is the single field language for every form
// dialog (cron, webhooks, profiles, …) — don't hand-roll label+control stacks
// or reach for the settings-surface ListRow inside a dialog. Stack Fields in a
// `grid gap-4` form; pair two across with `grid items-start gap-4 sm:grid-cols-2`.
export function Field({
  children,
  className,
  htmlFor,
  label,
  optional,
  optionalLabel,
  row,
  tip
}: {
  children: ReactNode
  className?: string
  htmlFor?: string
  label: ReactNode
  optional?: boolean
  optionalLabel?: string
  /** Label beside the control rather than above it, on the same 6rem column
   *  `SidePanelMeta` uses — so a panel's editable rows line up with its
   *  read-only ones. For a run of small controls (a number, a switch) where a
   *  full-width row each is mostly empty space. NOT for anything that needs the
   *  width: prose, a select with long options, a segmented control. */
  row?: boolean
  /** Hover guidance. For a panel of knobs, where a `FieldHint` under every one
   *  would triple its height, this keeps the help off the surface until asked. */
  tip?: string
}) {
  // A <label> is only valid around ONE control; a segmented control or a
  // stepper is several, so those get a plain div and an unassociated caption.
  const Tag = htmlFor === undefined ? 'div' : 'label'

  return (
    <div
      className={cn(row ? 'grid grid-cols-[6rem_minmax(0,1fr)] items-center gap-x-3' : 'grid gap-1.5', className)}
      title={tip}
    >
      <Tag
        className={cn('flex gap-2 text-xs font-medium text-foreground', row ? 'items-center' : 'items-baseline')}
        {...(htmlFor ? { htmlFor, id: `${htmlFor}-label` } : {})}
      >
        {label}
        {optional && optionalLabel && (
          <span className="text-[0.65rem] font-normal text-muted-foreground">{optionalLabel}</span>
        )}
      </Tag>
      {children}
    </div>
  )
}

export function FieldHint({ children, error }: { children: ReactNode; error?: boolean }) {
  return (
    <p className={cn('text-[0.66rem] leading-4', error ? 'text-destructive' : 'text-muted-foreground')}>{children}</p>
  )
}
