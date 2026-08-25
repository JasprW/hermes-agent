// Stands in for a gateway client: it holds the event stream, and everything the
// UI shows is a fold over a prefix of it.
//
// Two separate things live here. Running the scenario appends events to the
// log — forward only, an LLM can't be rewound. REPLAY applies fewer events:
// seeking the playhead re-renders the world as it was, with no history store
// and no snapshot format. The canvas is the live surface; the timeline replays
// the past.
//
// The scrubbing asymmetry is the one StarCraft II documents for its own
// replays: rewinding to any point is instant, but going forward only reaches
// what has already been simulated.
//
// Pause is "when available", the way LangGraph interrupts and Prefect pauses
// work: a run suspends at a step boundary, never mid-LLM. Requesting a pause
// lets whatever is in flight finish and stops the next dispatch; resume picks
// up exactly there. In real Hermes this is the executor not spawning the next
// delegate_task (kanban's needs_input block); here it's the pump not
// scheduling the next NodeStarted.

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'

import { type Checkpoint, checkpointsOf, type ProtoEvent, reduceEvents, type RunShape, type World } from './protocol'
import { buildTimeline, type RunPlan, type TimelineStep } from './run.fake'
import type { OnFail } from './scenario'

/** none → (pause requested) pausing → (boundary reached) paused → resume. */
export type PauseState = 'none' | 'pausing' | 'paused'

/** A question the run is parked on. The stream stops here and does not move
 *  again until someone answers — which is the difference between a human step
 *  and a sleep. */
export interface Question {
  nodeId: string
  prompt: string
  who: string
  onFail: OnFail
}

/** Structural equality over the JSON-shaped values a StepRuntime holds. Written
 *  generically rather than as a field list so it can't rot the next time a
 *  field lands on StepRuntime. */
function sameValue(a: unknown, b: unknown): boolean {
  if (a === b) {
    return true
  }

  if (a === null || b === null || typeof a !== 'object' || typeof b !== 'object') {
    return false
  }

  if (Array.isArray(a) !== Array.isArray(b)) {
    return false
  }

  const av = a as Record<string, unknown>
  const bv = b as Record<string, unknown>
  const keys = Object.keys(av)

  if (keys.length !== Object.keys(bv).length) {
    return false
  }

  return keys.every(k => sameValue(av[k], bv[k]))
}

export interface Player {
  events: ProtoEvent[]
  world: World
  checkpoints: Checkpoint[]
  /** Events applied to the current view. */
  head: number
  /** True when the view is pinned to the tail of the stream. */
  live: boolean
  /** The scenario is executing (events still arriving or holding at a pause). */
  running: boolean
  pauseState: PauseState
  /** Set while the run is parked on a person. */
  asking: Question | null
  /** The parked question is off screen — hidden, not answered. Lives here
   *  rather than in the view because the run is what's blocked by it: the
   *  transport has to know that "carry on" means "bring the question back". */
  deferred: boolean
  /** Put the question away to go look at the graph. The run stays parked. */
  defer: () => void
  /** Bring a deferred question back. */
  reveal: () => void
  /** Answer the parked question and let the run move again. */
  respond: (decision: 'approved' | 'denied') => void
  /** Event timestamp the view is frozen at, or null while live. */
  frozenAt: number | null
  start: () => void
  reset: () => void
  /** Suspend at the next safe point — before the next step dispatch. */
  requestPause: () => void
  resume: () => void
  seek: (head: number) => void
  stepCheckpoint: (dir: -1 | 1) => void
  goLive: () => void
}

/** The reducer only needs to know which steps and wires exist. */
const shapeOf = (plan: RunPlan): RunShape => ({
  steps: plan.steps.map(s => s.id),
  edges: plan.edges
})

/** The run is built from the graph at the moment you press play, not once at
 *  mount. That's the honest model — you run what's on the canvas — and it's why
 *  the shape travels with it: seeking replays the log against the graph the run
 *  was built from, so editing mid-replay can't retune the past. */
export function usePlayer(planOf: () => RunPlan): Player {
  // A ref, not state: start() builds the timeline and enters the pump in the
  // same tick, so a state setter would hand the pump the previous render's
  // timeline — on the first run, an empty one, and the run would end before it
  // began. Nothing renders the timeline; only the pump reads it.
  const timelineRef = useRef<TimelineStep[]>([])
  // The shape does render — the world is folded against it — so it's state.
  const [shape, setShape] = useState<RunShape>(() => shapeOf(planOf()))

  const [events, setEvents] = useState<ProtoEvent[]>([])
  const [head, setHead] = useState<number | null>(null) // null = follow tail
  const [running, setRunning] = useState(false)
  const [pauseState, setPauseState] = useState<PauseState>('none')

  const nextRef = useRef(0) // next timeline index to emit
  const timerRef = useRef<number | null>(null)
  const runIdRef = useRef('run-idle')
  const pumpRef = useRef<() => void>(() => {})
  const eventsRef = useRef<ProtoEvent[]>([])
  const headRef = useRef(0)
  const pauseRef = useRef<PauseState>('none')
  const activeRef = useRef(new Set<string>()) // steps currently mid-flight
  const [asking, setAsking] = useState<Question | null>(null)
  const askingRef = useRef<Question | null>(null)
  const askAtRef = useRef(0) // index of the HumanWaiting we're parked on
  const [deferred, setDeferred] = useState(false)

  const stop = useCallback(() => {
    if (timerRef.current != null) {
      window.clearTimeout(timerRef.current)
    }

    timerRef.current = null
  }, [])

  const setPause = (s: PauseState) => {
    pauseRef.current = s
    setPauseState(s)
  }

  // Every arrival and every clearing goes through here, so a deferral can
  // never outlive the question it was about.
  const ask = (q: Question | null) => {
    askingRef.current = q
    setAsking(q)
    setDeferred(false)
  }

  const append = (step: TimelineStep, seq: number, payload?: object) =>
    setEvents(prev => [
      ...prev,
      {
        runId: runIdRef.current,
        seq,
        ts: Date.now(),
        type: step.type,
        payload: { ...step.payload, ...payload }
      } as ProtoEvent
    ])

  // Walk the timeline, appending one event per scheduled tick.
  pumpRef.current = () => {
    const timeline = timelineRef.current
    const i = nextRef.current

    if (i >= timeline.length) {
      setRunning(false)

      if (pauseRef.current !== 'none') {
        setPause('none')
      } // finished first

      return
    }

    const step = timeline[i]

    // "Pause when available": the safe point is before a step dispatch while
    // nothing else is mid-flight. In-flight work always finishes — the stream
    // is linear, so holding a NodeStarted mid-fan-out would freeze a sibling's
    // trace too, which a real scheduler wouldn't do.
    if (pauseRef.current === 'pausing' && step.type === 'NodeStarted' && activeRef.current.size === 0) {
      setPause('paused')

      return // resume() re-enters the pump right here
    }

    // The park. The executor writes the approved branch down because that's the
    // branch with a rest-of-the-run, but it is NOT allowed to answer on your
    // behalf — the stream stops on the question and stays there. This is the
    // whole reason `human` is a kind, and it used to elapse on a timer, which
    // made every approval a 2.6s sleep wearing a person's name.
    if (step.type === 'HumanResponded' && !askingRef.current) {
      const j = timeline
        .slice(0, i)
        .findLastIndex(s => s.type === 'HumanWaiting' && s.payload.nodeId === step.payload.nodeId)

      const w = timeline[j]

      if (w?.type === 'HumanWaiting') {
        askAtRef.current = j
        ask(w.payload)

        return
      }
    }

    const prevAt = i === 0 ? 0 : timeline[i - 1].atMs
    const delay = Math.max(0, timeline[i].atMs - prevAt)
    timerRef.current = window.setTimeout(() => {
      nextRef.current = i + 1
      const p = step.payload as { nodeId?: string }

      if (step.type === 'NodeStarted' && p.nodeId) {
        activeRef.current.add(p.nodeId)
      }

      if ((step.type === 'NodeFinished' || step.type === 'NodeFailed' || step.type === 'GateEvaluated') && p.nodeId) {
        activeRef.current.delete(p.nodeId)
      }

      append(step, i)
      pumpRef.current()
    }, delay)
  }

  useEffect(() => stop, [stop])

  const start = useCallback(() => {
    stop()
    const plan = planOf()
    timelineRef.current = buildTimeline(plan)
    setShape(shapeOf(plan))
    runIdRef.current = `run-${Date.now()}`
    nextRef.current = 0
    activeRef.current.clear()
    setPause('none')
    ask(null)
    setEvents([])
    setHead(null)
    setRunning(true)
    pumpRef.current()
  }, [planOf, stop])

  const reset = useCallback(() => {
    stop()
    nextRef.current = 0
    activeRef.current.clear()
    setPause('none')
    ask(null)
    setEvents([])
    setHead(null)
    setRunning(false)
  }, [stop])

  const respond = useCallback(
    (decision: 'approved' | 'denied') => {
      const q = askingRef.current

      if (!q) {
        return
      }

      const i = nextRef.current
      const step = timelineRef.current[i]

      if (!step || step.type !== 'HumanResponded') {
        return
      }

      ask(null)
      activeRef.current.delete(q.nodeId)
      append(step, i, { decision, by: q.who })

      if (decision === 'approved') {
        nextRef.current = i + 1
        pumpRef.current()

        return
      }

      // A "no" is this step failing, so what happens next is the step's own
      // on-failure setting rather than a rule the dialog invents. Only retry
      // has anywhere to go — asking again — and the rest stop the run, because
      // the branch nobody wrote down is the one where the work continues past a
      // refusal.
      if (q.onFail === 'retry') {
        // Back to the question itself, which the parallel branches mean isn't
        // always the event right before the answer.
        nextRef.current = askAtRef.current
        pumpRef.current()

        return
      }

      stop()
      nextRef.current = timelineRef.current.length
      setEvents(prev => [
        ...prev,
        {
          runId: runIdRef.current,
          seq: i + 1,
          ts: Date.now(),
          type: 'RunFinished',
          payload: { state: 'failed' }
        } as ProtoEvent
      ])
      setRunning(false)
    },
    [stop]
  )

  const requestPause = useCallback(() => {
    // Parked on a person, so there is nothing in flight to pause — and the
    // pump won't be re-entered until the question is answered, which is the
    // only place 'pausing' ever resolves. Accepting the request here left the
    // transport pulsing on "pausing" with no way out but a restart, and it's
    // the first thing you reach for after putting the dialog away.
    if (askingRef.current) {
      return
    }

    if (timerRef.current == null) {
      return
    } // no run in flight

    if (pauseRef.current !== 'none') {
      return
    }

    setPause('pausing')
  }, [])

  // Resuming always returns to the tail. You paused by reaching into history;
  // pressing play means "carry on from now", not "replay from where I was
  // looking" — the log only moves forward, so a head left in the past would
  // just sit there while new events piled up behind it.
  const resume = useCallback(() => {
    if (pauseRef.current !== 'paused') {
      return
    }

    setHead(null)
    setPause('none')
    pumpRef.current()
  }, [])

  // Replay: detach the view from the tail. The run is untouched.
  //
  // Scrubbing to the very end re-attaches instead of pinning the head there.
  // That's what makes a "go live" button unnecessary — the end of the track IS
  // live, so dragging back to it resumes following the run, and a run that
  // keeps appending stays visible rather than stopping at a stale head.
  //
  // Touching the scrubber while events are still arriving also PAUSES the run.
  // Watching the tail while replaying the past is incoherent: the track keeps
  // growing under the playhead, so the point you dragged to slides away from
  // you. Reaching into the replay is an unambiguous "hold on" — same reason
  // every video player stops advancing when you grab the scrubber.
  const seek = useCallback((h: number) => {
    const total = eventsRef.current.length
    const clamped = Math.max(0, Math.min(h, total))

    if (clamped >= total) {
      headRef.current = total
      setHead(null)

      return
    }

    if (timerRef.current != null && pauseRef.current === 'none') {
      setPause('pausing')
    }

    headRef.current = clamped
    setHead(clamped)
  }, [])

  // Back to now. Kept on the Player because the composer's "resume"/"go live"
  // intents call it; the timeline has no button for it by design.
  const goLive = useCallback(() => {
    setHead(null)
  }, [])

  const checkpoints = useMemo(() => checkpointsOf(events), [events])
  const effHead = head ?? events.length

  // Mirrored so consecutive clicks step instead of all resolving against the
  // head from the last render.
  eventsRef.current = events
  headRef.current = effHead

  const stepCheckpoint = useCallback(
    (dir: -1 | 1) => {
      const from = headRef.current
      const stops = checkpointsOf(eventsRef.current).map(c => c.at + 1)
      const next = dir === -1 ? [...stops].reverse().find(s => s < from) : stops.find(s => s > from)

      if (next != null) {
        seek(next)
      } else if (dir === 1) {
        goLive()
      }
    },
    [goLive, seek]
  )

  // reduceEvents replays the log from zero, so every step comes back as a fresh
  // object on every event — including the six that didn't move. Consumers key
  // off identity (a node's `data.rt` changing is what re-renders its card), so
  // a two-step run was re-rendering the whole graph forty times a second.
  //
  // The replay stays: it's what makes seeking free, and it's O(steps), not the
  // cost anyone was paying. What changes is the handoff — a step whose new
  // object is structurally identical to last frame's is handed back the OLD
  // object, so only the steps that actually moved change hands.
  const prevWorld = useRef<World | null>(null)

  const world: World = useMemo(() => {
    const next = reduceEvents(events, shape, effHead)
    const prev = prevWorld.current

    if (prev) {
      for (const id in next.steps) {
        if (sameValue(prev.steps[id], next.steps[id])) {
          next.steps[id] = prev.steps[id]
        }
      }
    }

    prevWorld.current = next

    return next
  }, [events, effHead, shape])

  return {
    events,
    world,
    checkpoints,
    head: effHead,
    live: head == null,
    running,
    pauseState,
    asking,
    deferred,
    defer: useCallback(() => setDeferred(true), []),
    reveal: useCallback(() => setDeferred(false), []),
    respond,
    frozenAt: head == null ? null : (events[effHead - 1]?.ts ?? null),
    start,
    reset,
    requestPause,
    resume,
    seek,
    stepCheckpoint,
    goLive
  }
}
