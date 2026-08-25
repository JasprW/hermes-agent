// The wire boundary between the canvas and whatever runs the scenario.
//
// Shaped on purpose like the Smithers gateway's run-event log
// (`_smithers_events`: run_id, seq, timestamp_ms, type, payload_json), so a
// real Smithers backend can drive this UI through a thin adapter instead of a
// rewrite. Checked against a live gateway run of our own north star
// (run-1784922888902): every SMITHERS_NATIVE type below is one it actually
// emits, keyed the same way — (runId, stepId, take).
//
// NAMING: the event type names are the ENGINE's and are deliberately left
// verbatim — `NodeStarted`, `FrameCommitted`, `iteration`. They're a contract
// with a system we don't own. Everything the *canvas* says is in the canvas's
// own lexicon: scenario, run, step, take, checkpoint, split, replay. Where the
// two meet, the adapter translates and the field comment says so.
//
// The HERMES_EXT types are the gap. Smithers keeps join/branch decisions in JS
// closures, so its wire never sees them: that run produced zero gate steps and
// zero edges. Those events are the canvas's own, and they're the whole cost of
// the translation — small, and on our side of the line.
//
// Nothing here knows how the run is produced. The scripted demo in
// run.fake.ts is one adapter; a kanban-backed executor or a Smithers gateway
// would be others.

import type { OnFail } from './scenario'

/** The shape of the thing being run — which steps exist and how they're wired.
 *
 *  The reducer used to read this off the static STEP_DEFS/EDGE_DEFS, which
 *  meant the world had exactly the six steps the starter scenario ships with.
 *  Every event
 *  about a step you added landed on `steps[id] === undefined` and was dropped,
 *  so a node you drew could never light up no matter what the engine said
 *  about it. The canvas has never seen an engine; it hadn't seen the graph
 *  either. */
export interface RunShape {
  steps: string[]
  edges: { id: string; source: string; target: string; loop?: boolean }[]
}

// ---------------------------------------------------------------------------
// Payload pieces
// ---------------------------------------------------------------------------

/** A single tool call the subagent makes (Hermes `get_activity_summary()`). */
export interface ToolCall {
  name: string
  arg: string
}

/** Mirror of the todo tool's item shape. */
export type TodoStatus = 'pending' | 'in_progress' | 'completed' | 'cancelled'
export interface TodoItem {
  id: string
  content: string
  status: TodoStatus
}

export type Verdict = 'PASS' | 'FAIL' | null

/** Every step event is addressed the way Smithers addresses it. */
interface NodeRef {
  nodeId: string
  /** The engine's word for a take. Wire-level name, kept verbatim. */
  iteration: number
}

// ---------------------------------------------------------------------------
// Events
// ---------------------------------------------------------------------------

export type EventType =
  // --- Smithers emits these today, verbatim --------------------------------
  | 'RunStarted'
  | 'RunFinished'
  | 'NodePending'
  | 'NodeStarted'
  | 'NodeFinished'
  | 'NodeFailed'
  | 'AgentTraceEvent'
  | 'AgentTraceSummary'
  | 'TaskOutput'
  | 'TokenUsage'
  | 'FrameCommitted'
  | 'SnapshotCaptured'
  // --- canvas extensions: no Smithers equivalent on the wire ---------------
  | 'GateEvaluated'
  | 'NodeSkipped'
  | 'LoopAdvanced'
  | 'TodoUpdated'
  | 'HumanWaiting'
  | 'HumanResponded'
  | 'WaitStarted'
  | 'WaitResolved'

/** Types the canvas has to synthesize because the engine doesn't report them. */
export const HERMES_EXT: ReadonlySet<EventType> = new Set<EventType>([
  'GateEvaluated',
  'NodeSkipped',
  'LoopAdvanced',
  'TodoUpdated',
  // Smithers wire-wise a HumanTask is just a task that stays running; the
  // park/resume pair is the canvas's own so a card can say "waiting on you".
  'HumanWaiting',
  'HumanResponded',
  // The same pair for the other thing a run parks on. A wait and a human step
  // both stop the run dead, but "waiting on you" is wrong over a timer, so the
  // world gets its own two events rather than borrowing the person's.
  'WaitStarted',
  'WaitResolved'
])

interface Envelope {
  runId: string
  seq: number
  ts: number
}

export type ProtoEvent =
  | (Envelope & { type: 'RunStarted'; payload: { scenario: string } })
  | (Envelope & { type: 'RunFinished'; payload: { state: 'succeeded' | 'failed' } })
  | (Envelope & { type: 'NodePending'; payload: NodeRef })
  | (Envelope & {
      type: 'NodeStarted'
      payload: NodeRef & { input: string; maxIters: number; loop?: boolean }
    })
  | (Envelope & { type: 'NodeFinished'; payload: NodeRef })
  | (Envelope & { type: 'NodeFailed'; payload: NodeRef & { error: string } })
  | (Envelope & {
      type: 'AgentTraceEvent'
      payload: NodeRef & { tool: ToolCall }
    })
  | (Envelope & {
      type: 'AgentTraceSummary'
      payload: NodeRef & { summary: string; verdict?: Verdict }
    })
  | (Envelope & {
      type: 'TaskOutput'
      payload: NodeRef & { output: Record<string, unknown> }
    })
  | (Envelope & { type: 'TokenUsage'; payload: NodeRef & { tokens: number } })
  | (Envelope & { type: 'FrameCommitted'; payload: { frameNo: number; label: string } })
  | (Envelope & { type: 'SnapshotCaptured'; payload: { frameNo: number } })
  | (Envelope & {
      type: 'GateEvaluated'
      payload: NodeRef & {
        inputs: { nodeId: string; verdict: Verdict }[]
        decision: 'pass' | 'fail'
        route: string
        summary: string
      }
    })
  | (Envelope & { type: 'NodeSkipped'; payload: NodeRef & { reason: string } })
  | (Envelope & {
      type: 'HumanWaiting'
      payload: NodeRef & {
        prompt: string
        /** Who it's parked on, for the card and the prompt. */
        who: string
        /** What a "no" means here, so the answer can be honoured rather than
         *  assumed. It's the step's own on-failure setting: a denial IS the
         *  failure. */
        onFail: OnFail
      }
    })
  | (Envelope & {
      type: 'HumanResponded'
      payload: NodeRef & { decision: 'approved' | 'denied'; by: string }
    })
  | (Envelope & {
      type: 'WaitStarted'
      payload: NodeRef & { until: string; label: string }
    })
  | (Envelope & { type: 'WaitResolved'; payload: NodeRef & { by: string } })
  | (Envelope & {
      type: 'LoopAdvanced'
      payload: { loopId: string; iteration: number; to: string; feedback: string }
    })
  | (Envelope & { type: 'TodoUpdated'; payload: NodeRef & { todos: TodoItem[] } })

// ---------------------------------------------------------------------------
// Derived state — everything the canvas draws is a fold over the event stream.
// ---------------------------------------------------------------------------

export type StepStatus =
  | 'idle'
  | 'queued'
  | 'running'
  | 'waiting' // parked on a person (or the world) — the run is not working
  | 'done'
  | 'failed'
  | 'looping'

export interface StepRuntime {
  status: StepStatus
  currentTool: ToolCall | null
  toolCalls: ToolCall[]
  todos: TodoItem[]
  iterations: number
  maxIters: number
  tokens: number
  /** Which take this is — 1-based. A gate rejection sends the step back for
   *  another one, the way a director calls take 2. */
  take: number
  startedAt: number | null
  durationMs: number | null
  verdict: Verdict
  input: string | null
  summary: string | null
  output: Record<string, unknown> | null
  skipped: string | null
}

export type EdgeState = 'idle' | 'active' | 'done' | 'loop'
export type RunPhase = 'idle' | 'running' | 'done'

/** A URL a step produced, ready to surface on the card. */
export interface StepLink {
  /** The output key it came from, e.g. `pr_url`. */
  key: string
  href: string
  /** Short human label — the origin + last path segment, e.g. `github.com/…/1234`. */
  label: string
}

/**
 * Find the first URL a step emitted, so the canvas can link to it directly.
 *
 * A run's whole point is usually the artifact at the end — a PR, a preview, a
 * dashboard. Making that reachable only through select → Data tab → read the
 * value buries the one thing you came for behind three clicks. This scans the
 * structured output generically rather than special-casing `pr_url`, so any
 * step that returns a URL gets a link for free.
 */
export function stepLink(output: Record<string, unknown> | null): StepLink | null {
  if (!output) {
    return null
  }

  for (const [key, value] of Object.entries(output)) {
    if (typeof value !== 'string') {
      continue
    }

    if (!/^https?:\/\//i.test(value)) {
      continue
    }

    try {
      const u = new URL(value)
      const tail = u.pathname.split('/').filter(Boolean).pop()

      return {
        key,
        href: value,
        label: tail ? `${u.host}/…/${tail}` : u.host
      }
    } catch {
      // Malformed URL — skip it rather than rendering a dead link.
    }
  }

  return null
}

/**
 * A durable boundary you can scrub to — the engine's `FrameCommitted`.
 *
 * "Checkpoint", not "frame": a frame is a ~16ms display tick to anyone with
 * emulator, TAS, or video literacy, and this is a semantic save point, not a
 * time quantum. Checkpoint already means "the place you resume from" in both
 * games and software, so it needs no explaining in either direction.
 */
export interface Checkpoint {
  no: number
  label: string
  /** Index into the event array, so seeking a checkpoint is seeking an event. */
  at: number
}

export interface World {
  phase: RunPhase
  /** Highest take reached by any step in the run so far. */
  take: number
  steps: Record<string, StepRuntime>
  edges: Record<string, EdgeState>
  /** Timestamp of the last applied event — the clock while time-travelling. */
  clockTs: number | null
}

export const freshRuntime = (): StepRuntime => ({
  status: 'idle',
  currentTool: null,
  toolCalls: [],
  todos: [],
  iterations: 0,
  maxIters: 0,
  tokens: 0,
  take: 0,
  startedAt: null,
  durationMs: null,
  verdict: null,
  input: null,
  summary: null,
  output: null,
  skipped: null
})

function initialRuntime(shape: RunShape): Record<string, StepRuntime> {
  return Object.fromEntries(shape.steps.map(id => [id, freshRuntime()]))
}

function initialEdgeState(shape: RunShape): Record<string, EdgeState> {
  return Object.fromEntries(shape.edges.map(e => [e.id, 'idle' as EdgeState]))
}

/** All checkpoints present in a stream (the scrubber's stops). */
export function checkpointsOf(events: ProtoEvent[]): Checkpoint[] {
  const out: Checkpoint[] = []
  events.forEach((e, at) => {
    if (e.type === 'FrameCommitted') {
      out.push({ no: e.payload.frameNo, label: e.payload.label, at })
    }
  })

  return out
}

/**
 * Fold `count` events into the world the canvas renders. Replaying a prefix is
 * the whole time-travel mechanism — there is no separate historical store.
 */
export function reduceEvents(events: ProtoEvent[], shape: RunShape, count = events.length): World {
  const steps = initialRuntime(shape)
  const edges = initialEdgeState(shape)
  let phase: RunPhase = 'idle'
  let take = 0
  let clockTs: number | null = null
  // A loop-back edge is lit from the moment the run advances to the next take
  // until its target actually restarts. The engine reports the bump; the edge
  // is ours.
  let loopTarget: string | null = null

  for (let i = 0; i < Math.min(count, events.length); i++) {
    const e = events[i]
    clockTs = e.ts
    const p = e.payload as Partial<NodeRef>
    const rt = p.nodeId ? steps[p.nodeId] : undefined

    switch (e.type) {
      case 'RunStarted':
        phase = 'running'
        take = 1

        break

      case 'RunFinished':
        phase = 'done'

        break

      case 'NodePending':
        if (rt) {
          Object.assign(rt, freshRuntime(), {
            status: 'queued' as StepStatus,
            take: e.payload.iteration + 1
          })
        }

        break

      case 'NodeStarted':
        if (rt) {
          rt.status = e.payload.loop ? 'looping' : 'running'
          rt.startedAt = e.ts
          rt.durationMs = null
          rt.input = e.payload.input
          rt.maxIters = e.payload.maxIters
          rt.take = e.payload.iteration + 1
          rt.skipped = null
        }

        if (loopTarget === e.payload.nodeId) {
          loopTarget = null
        }

        take = Math.max(take, e.payload.iteration + 1)

        break

      case 'AgentTraceEvent':
        if (rt) {
          rt.currentTool = e.payload.tool
          rt.toolCalls = [...rt.toolCalls, e.payload.tool]
          rt.iterations += 1
        }

        break

      case 'TokenUsage':
        if (rt) {
          rt.tokens += e.payload.tokens
        }

        break

      case 'TodoUpdated':
        if (rt) {
          rt.todos = e.payload.todos.map(t => ({ ...t }))
        }

        break

      case 'AgentTraceSummary':
        if (rt) {
          rt.summary = e.payload.summary
          rt.verdict = e.payload.verdict ?? null
        }

        break

      case 'TaskOutput':
        if (rt) {
          rt.output = e.payload.output
        }

        break

      case 'NodeFinished':
        if (rt) {
          // The wire says "finished" whether the agent approved or rejected —
          // a FAIL is a value in its structured output, not a task error. The
          // canvas is what turns a rejecting validator red.
          rt.status = rt.verdict === 'FAIL' ? 'failed' : 'done'
          rt.currentTool = null
          rt.durationMs = rt.startedAt != null ? e.ts - rt.startedAt : null
        }

        break

      case 'NodeFailed':
        if (rt) {
          rt.status = 'failed'
          rt.currentTool = null
          rt.summary = e.payload.error
          rt.durationMs = rt.startedAt != null ? e.ts - rt.startedAt : null
        }

        break

      case 'NodeSkipped':
        // Held over, not re-run — it keeps the take number and telemetry of
        // the take that satisfied it.
        if (rt) {
          rt.skipped = e.payload.reason
        }

        break

      case 'GateEvaluated':
        if (rt) {
          rt.verdict = e.payload.decision === 'pass' ? 'PASS' : 'FAIL'
          rt.summary = e.payload.summary
          rt.input = e.payload.inputs.map(v => `${v.nodeId} ${v.verdict ?? '—'}`).join(' · ')
          rt.status = e.payload.decision === 'pass' ? 'done' : 'looping'
          rt.currentTool = null
          rt.durationMs = rt.startedAt != null ? e.ts - rt.startedAt : null
        }

        break

      case 'HumanWaiting':
        // The run parks. startedAt keeps ticking — elapsed-while-blocked is
        // the one number a waiting card owes you.
        if (rt) {
          rt.status = 'waiting'
          rt.summary = e.payload.prompt

          if (rt.startedAt == null) {
            rt.startedAt = e.ts
          }
        }

        break

      case 'WaitStarted':
        if (rt) {
          rt.status = 'waiting'
          rt.input = e.payload.until
          rt.summary = e.payload.label
          rt.take = e.payload.iteration + 1

          if (rt.startedAt == null) {
            rt.startedAt = e.ts
          }
        }

        break

      case 'WaitResolved':
        if (rt) {
          // A wait has no opinion, so it reports no verdict — it either came
          // back or the run is still sitting on it.
          rt.status = 'done'
          rt.summary = e.payload.by
          rt.durationMs = rt.startedAt != null ? e.ts - rt.startedAt : null
        }

        break

      case 'HumanResponded':
        if (rt) {
          rt.verdict = e.payload.decision === 'approved' ? 'PASS' : 'FAIL'
          rt.status = e.payload.decision === 'approved' ? 'done' : 'failed'
          rt.summary = `${e.payload.decision} · ${e.payload.by}`
          rt.durationMs = rt.startedAt != null ? e.ts - rt.startedAt : null
        }

        break

      case 'LoopAdvanced':
        loopTarget = e.payload.to
        take = e.payload.iteration + 1

        break

      case 'FrameCommitted':

      case 'SnapshotCaptured':
        break
    }
  }

  // Edges follow from step state: a link is live while its target is queued
  // behind a finished source, and settled once the target has run.
  for (const def of shape.edges) {
    if (def.loop) {
      edges[def.id] = loopTarget === def.target ? 'loop' : 'idle'

      continue
    }

    const src = steps[def.source]
    const tgt = steps[def.target]
    const srcSettled = src.status === 'done' || src.status === 'failed'

    if (tgt.status === 'queued') {
      edges[def.id] = srcSettled ? 'active' : 'idle'
    } else if (tgt.status !== 'idle') {
      edges[def.id] = 'done'
    } else {
      edges[def.id] = 'idle'
    }
  }

  return { phase, take, steps, edges, clockTs }
}

// ---------------------------------------------------------------------------
// Activity feed projection — the human-readable view of the same stream.
// ---------------------------------------------------------------------------

export interface FeedLine {
  step: string
  /** Colours the line's dot in the feed. The kind IS the visual marker — the
   *  feed used to also carry a per-line glyph, which was redundant with it. */
  kind: 'start' | 'tool' | 'ok' | 'fail' | 'loop' | 'data'
  msg: string
  ext: boolean
  ts: number
}

/** Infra chatter the timeline shows as ticks and the feed leaves out. */
const FEED_HIDDEN: ReadonlySet<EventType> = new Set<EventType>([
  'TokenUsage',
  'SnapshotCaptured',
  'FrameCommitted',
  'NodePending',
  'TodoUpdated',
  'TaskOutput',
  'NodeFinished'
])

export function feedLine(e: ProtoEvent): FeedLine | null {
  if (FEED_HIDDEN.has(e.type)) {
    return null
  }

  const ext = HERMES_EXT.has(e.type)
  const base = { ext, ts: e.ts }

  switch (e.type) {
    case 'RunStarted':
      return { ...base, step: 'run', kind: 'start', msg: e.payload.scenario }

    case 'RunFinished':
      return { ...base, step: 'run', kind: 'ok', msg: `run ${e.payload.state}` }

    case 'NodeStarted':
      return {
        ...base,
        step: e.payload.nodeId,
        kind: 'start',
        msg: `delegate_task spawned · ${e.payload.input}`
      }
    case 'AgentTraceEvent': {
      const t = e.payload.tool

      return {
        ...base,
        step: e.payload.nodeId,
        kind: 'tool',
        msg: `${t.name}${t.arg ? ` · ${t.arg}` : ''}`
      }
    }

    case 'AgentTraceSummary':
      return {
        ...base,
        step: e.payload.nodeId,
        kind: e.payload.verdict === 'FAIL' ? 'fail' : 'ok',
        msg: e.payload.summary
      }

    case 'NodeFailed':
      return {
        ...base,
        step: e.payload.nodeId,
        kind: 'fail',
        msg: e.payload.error
      }

    case 'NodeSkipped':
      return {
        ...base,
        step: e.payload.nodeId,
        kind: 'data',
        msg: `skipped · ${e.payload.reason}`
      }

    case 'GateEvaluated':
      return {
        ...base,
        step: e.payload.nodeId,
        kind: e.payload.decision === 'pass' ? 'ok' : 'loop',
        msg: e.payload.summary
      }

    case 'LoopAdvanced':
      return {
        ...base,
        step: e.payload.loopId,
        kind: 'loop',
        msg: `take ${e.payload.iteration + 1} → ${e.payload.to} · ${e.payload.feedback}`
      }

    case 'HumanWaiting':
      return {
        ...base,
        step: e.payload.nodeId,
        kind: 'data',
        msg: `waiting on you · ${e.payload.prompt}`
      }

    case 'HumanResponded':
      return {
        ...base,
        step: e.payload.nodeId,
        kind: e.payload.decision === 'approved' ? 'ok' : 'fail',
        msg: `${e.payload.decision} · ${e.payload.by}`
      }

    case 'WaitStarted':
      return {
        ...base,
        step: e.payload.nodeId,
        kind: 'data',
        msg: `waiting on ${e.payload.label}`
      }

    case 'WaitResolved':
      return { ...base, step: e.payload.nodeId, kind: 'ok', msg: e.payload.by }

    default:
      return null
  }
}
