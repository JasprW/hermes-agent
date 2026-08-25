import { Button, cn, Codicon, composerFill, composerSurfaceGlass, PRIMARY_ICON_BTN } from '@hermes/plugin-sdk'
// The primary control on the canvas: you tell an agent what to build, to run
// it, or to change it, and it edits the scenario while you watch. Direct
// manipulation (drag, inspector) and agent edits are the same operations
// against the same document — this is the collaboration surface, not a chat
// bolted onto a dashboard.
//
// It wears the app's composer chrome rather than one of its own: same fill,
// same glass, same 2xl capsule, same primary send button. A second input style
// in the same window is how a plugin starts looking bolted on.
//
// `onSend` runs a real turn: the model is handed the graph's own tool schema
// and the open scenario, and whatever it calls lands as a document mutation.
import { type KeyboardEvent, useEffect, useRef, useState } from 'react'

export interface AgentReply {
  reply: string
  /** One-line summary of the graph mutation, shown as an applied-edit chip. */
  edit?: string
}

interface Turn {
  role: 'user' | 'agent'
  text: string
  edit?: string
}

export function Composer({
  onSend,
  phase
}: {
  onSend: (text: string) => Promise<AgentReply>
  phase: 'idle' | 'running' | 'done'
}) {
  const [turns, setTurns] = useState<Turn[]>([])
  const [draft, setDraft] = useState('')
  const [thinking, setThinking] = useState(false)
  const logRef = useRef<HTMLDivElement>(null)
  const inputRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    logRef.current?.scrollTo({ top: logRef.current.scrollHeight })
  }, [turns, thinking])

  const submit = async (text: string) => {
    const t = text.trim()

    if (!t || thinking) {
      return
    }

    setTurns(prev => [...prev, { role: 'user', text: t }])
    setDraft('')
    setThinking(true)

    try {
      const { reply, edit } = await onSend(t)
      setTurns(prev => [...prev, { role: 'agent', text: reply, edit }])
    } finally {
      setThinking(false)
      inputRef.current?.focus()
    }
  }

  const onKey = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      void submit(draft)
    }
  }

  return (
    <div
      className={cn(
        composerFill,
        composerSurfaceGlass,
        'flex flex-col rounded-2xl border border-(--ui-stroke-secondary)'
      )}
      data-slot="composer-surface"
    >
      {turns.length > 0 && (
        <div className="cmp-log" ref={logRef}>
          {turns.map((t, i) => (
            <div className={`cmp-turn r-${t.role}`} key={i}>
              <span className="cmp-who">{t.role === 'user' ? 'you' : 'hermes'}</span>
              <span className="cmp-text">
                {t.text}
                {t.edit && <span className="cmp-edit">{t.edit}</span>}
              </span>
            </div>
          ))}
          {thinking && (
            <div className="cmp-turn r-agent">
              <span className="cmp-who">hermes</span>
              <span className="cmp-text cmp-thinking">
                <i />
                <i />
                <i />
              </span>
            </div>
          )}
        </div>
      )}

      <div className="flex items-center gap-1.5 px-(--composer-surface-pad-x) py-(--composer-surface-pad-y)">
        <input
          className="min-w-0 flex-1 bg-transparent text-xs leading-5 text-foreground outline-none placeholder:text-muted-foreground"
          onChange={e => setDraft(e.target.value)}
          onKeyDown={onKey}
          placeholder={
            phase === 'running'
              ? 'Ask for a change — it applies to the next take…'
              : 'Build, run, or change this scenario…'
          }
          ref={inputRef}
          value={draft}
        />
        <Button
          aria-label="Send"
          className={PRIMARY_ICON_BTN}
          disabled={!draft.trim() || thinking}
          onClick={() => void submit(draft)}
          title="Send (↵)"
        >
          <Codicon name="arrow-up" size="0.875rem" />
        </Button>
      </div>
    </div>
  )
}
