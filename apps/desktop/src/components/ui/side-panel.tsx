/**
 * A detail panel pinned to the edge of the surface it belongs to — the Kanban
 * task drawer, the Workflows step inspector.
 *
 * NOT `Sheet`. That one is a Radix dialog: portalled, `fixed` to the viewport,
 * backdropped, focus-trapped. It's for something you answer and dismiss. This
 * is for something you consult WHILE you keep working — the board still takes
 * a drag, the canvas still takes a click — so it's absolute inside its own
 * container, has no overlay, and steals no focus. Two plugins arrived at the
 * same hand-rolled div before this existed; the point of the primitive is that
 * the third one doesn't have to.
 *
 * The container needs `position: relative` (and a definite height) — the panel
 * fills its cross axis, so it's exactly as tall as whatever it's pinned to.
 */

import {
  type ComponentProps,
  createContext,
  type ReactNode,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState
} from 'react'

import { Codicon } from '@/components/ui/codicon'
import { edgeMask, scrollEdges } from '@/components/ui/fade-scroll'
import { useResizeObserver } from '@/hooks/use-resize-observer'
import { useI18n } from '@/i18n'
import { cn } from '@/lib/utils'

// Only so `SidePanelClose` can sit anywhere in the subtree — a detail panel's
// close button is usually buried in a header row full of other actions, and
// threading `onClose` down to it is the kind of prop that gets forgotten.
const CloseContext = createContext<(() => void) | undefined>(undefined)

export interface SidePanelProps extends ComponentProps<'aside'> {
  /** Which edge it's pinned to. */
  side?: 'left' | 'right'
  /** Esc closes it, and `SidePanelClose` calls it. Omit for a panel that
   *  can't be dismissed. */
  onClose?: () => void
}

export function SidePanel({ children, className, onClose, side = 'right', ...props }: SidePanelProps) {
  // Esc, because there's no backdrop to click off — the whole point of a
  // non-modal panel is that clicking outside it does something else.
  useEffect(() => {
    if (!onClose) {
      return
    }

    const onKey = (event: KeyboardEvent) => event.key === 'Escape' && onClose()
    window.addEventListener('keydown', onKey)

    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  return (
    <CloseContext.Provider value={onClose}>
      <aside
        className={cn(
          'absolute inset-y-0 z-20 flex w-[26rem] flex-col bg-(--ui-bg-elevated) duration-150 ease-out animate-in fade-in',
          side === 'right' && 'right-0 border-l border-(--ui-stroke-tertiary) slide-in-from-right-4',
          side === 'left' && 'left-0 border-r border-(--ui-stroke-tertiary) slide-in-from-left-4',
          className
        )}
        data-slot="side-panel"
        {...props}
      >
        {children}
      </aside>
    </CloseContext.Provider>
  )
}

/**
 * The title block — a column, because the header is two rows: chrome on top
 * (status, id, the action cluster pushed right with `ml-auto`) and the subject
 * on its own line under it. Keeping the title out of the chrome row is what
 * lets it wrap to two lines without squeezing the buttons.
 */
export function SidePanelHeader({ className, ...props }: ComponentProps<'header'>) {
  return (
    <header
      className={cn('flex flex-col gap-2 px-4 pt-3.5 pb-3', className)}
      data-slot="side-panel-header"
      {...props}
    />
  )
}

/** What the panel is about, on the header's second row. */
export function SidePanelTitle({ className, ...props }: ComponentProps<'h2'>) {
  return (
    <h2
      className={cn('text-sm leading-snug font-semibold text-foreground', className)}
      data-slot="side-panel-title"
      {...props}
    />
  )
}

/** The chrome row above the title — status, ids, and the actions. */
export function SidePanelToolbar({ className, ...props }: ComponentProps<'div'>) {
  return <div className={cn('flex items-center gap-2', className)} data-slot="side-panel-toolbar" {...props} />
}

/** The scrolling remainder. Takes the leftover height and nothing more, so a
 *  long body scrolls inside the panel rather than pushing the header off. */
export function SidePanelBody({ className, fade = false, ...props }: { fade?: boolean } & ComponentProps<'div'>) {
  const ref = useRef<HTMLDivElement>(null)
  const [edges, setEdges] = useState({ above: false, below: false })

  const measure = useCallback(() => {
    if (!fade || !ref.current) {
      return
    }

    const next = scrollEdges(ref.current)

    setEdges(prev => (prev.above === next.above && prev.below === next.below ? prev : next))
  }, [fade])

  useResizeObserver(measure, ref)

  return (
    <div
      className={cn('min-h-0 flex-1 overflow-y-auto px-4 pb-4', className)}
      data-slot="side-panel-body"
      onScroll={measure}
      ref={ref}
      style={{ maskImage: edgeMask(edges) }}
      {...props}
    />
  )
}

/** The one label style a detail surface uses for a field or a section — small,
 *  loud tracking, quaternary. Exported as a class because it lands on plain
 *  spans and legends as often as it does on a Section. */
export const SIDE_PANEL_LABEL = 'text-[0.62rem] font-semibold uppercase tracking-[0.14em] text-(--ui-text-quaternary)'

/** A labelled group inside the body. `action` rides the label's right edge —
 *  an "add" or "clear" that belongs to this group and nothing else. */
export function SidePanelSection({
  action,
  children,
  className,
  label,
  ...props
}: { action?: ReactNode; label: ReactNode } & ComponentProps<'section'>) {
  return (
    <section className={cn('flex flex-col gap-1.5', className)} data-slot="side-panel-section" {...props}>
      <div className="flex items-center justify-between">
        <div className={SIDE_PANEL_LABEL}>{label}</div>
        {action}
      </div>
      {children}
    </section>
  )
}

/** One row of the label/value table a panel opens with. Renders as a fragment
 *  so the rows share one grid — the labels line up down the column, which is
 *  the whole reason the table is a grid and not a stack of flex rows. */
export function SidePanelMetaRow({ children, label }: { children: ReactNode; label: ReactNode }) {
  return (
    <>
      <span className="text-(--ui-text-quaternary)">{label}</span>
      <span className="min-w-0 truncate text-(--ui-text-secondary)">{children}</span>
    </>
  )
}

/** The grid `SidePanelMetaRow` expects around it. */
export function SidePanelMeta({ className, ...props }: ComponentProps<'div'>) {
  return (
    <div
      className={cn('grid grid-cols-[6rem_minmax(0,1fr)] gap-x-3 gap-y-1 text-[0.71rem]', className)}
      data-slot="side-panel-meta"
      {...props}
    />
  )
}

/** The square hover-fill icon button a panel header's actions wear. */
export function SidePanelAction({ className, ...props }: ComponentProps<'button'>) {
  return (
    <button
      className={cn(
        'grid size-6 place-items-center rounded text-(--ui-text-tertiary) transition-colors hover:bg-(--chrome-action-hover) hover:text-foreground',
        className
      )}
      data-slot="side-panel-action"
      type="button"
      {...props}
    />
  )
}

export function SidePanelClose({ className, onClick, ...props }: ComponentProps<'button'>) {
  const { t } = useI18n()
  const close = useContext(CloseContext)

  return (
    <SidePanelAction
      aria-label={t.common.close}
      className={className}
      data-slot="side-panel-close"
      onClick={event => {
        onClick?.(event)
        close?.()
      }}
      {...props}
    >
      <Codicon name="close" size="0.9rem" />
    </SidePanelAction>
  )
}
