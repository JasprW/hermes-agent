// A fake backend. Everything here is scripted — no model calls, no database.
//
// Its only contract with the UI is the event stream in protocol.ts, which is
// the point: this adapter and a real one (kanban-backed executor, or a Smithers
// gateway relaying `_smithers_events`) are interchangeable behind that
// boundary. The canvas has never seen an engine.
//
// It executes THE GRAPH. What each step does is scripted — the tool calls, the
// token counts, the verdicts — but which steps run, in what order, and where a
// gate sends the work are all read off the scenario you drew. That split is the
// point: the content is fake, the topology is not, so a step you add runs and a
// wire you move changes the run.
//
// It used to be a straight-line script over six hardcoded ids, which meant the
// canvas could author a graph it could not execute.
//
// The north star is still the north star, and still deterministic: implement →
// [code review ‖ visual judge] → quality gate → back for another take with
// feedback → ship. It just falls out of the wiring now instead of being spelled.

import type { ProtoEvent, TodoItem, ToolCall, Verdict } from './protocol'
import { type Arm, type Predicate, type StepConfig, type StepKind, type WaitUntil } from './scenario'

/** The scenario, reduced to what running it needs. Built by the caller from the
 *  live graph so this module never has to know about React Flow. */
export interface RunPlan {
  name: string
  steps: { id: string; kind: StepKind; config: StepConfig }[]
  edges: { id: string; source: string; target: string; sourceHandle?: string; loop?: boolean }[]
}

// A step in the timeline: an event minus the envelope the player stamps on.
type Bare<T> = T extends { type: infer K; payload: infer P } ? { type: K; payload: P } : never
export type TimelineStep = Bare<ProtoEvent> & { atMs: number }

// ---------------------------------------------------------------------------
// Per-step scripts — what each delegate_task subagent does: an optional todo
// plan, then a sequence of real tool calls (each = one iteration), and the
// summary it returns. Tool names match the Hermes registry (terminal, read_file,
// write_file, patch, search_files, browser_navigate, browser_screenshot,
// vision_analyze, delegate_task, todo), plus figma.* for an MCP call.
// ---------------------------------------------------------------------------
interface ToolStep {
  todo?: string // which plan item this advances
  tool: ToolCall
  tokens?: number
  ms?: number
}

interface StepTake {
  input: string
  plan?: TodoItem[]
  steps: ToolStep[]
  verdict?: Verdict
  summary: string
  output?: Record<string, unknown>
  maxIters: number
  loop?: boolean // entered via the feedback edge
}

const todo = (id: string, content: string): TodoItem => ({
  id,
  content,
  status: 'pending'
})

const TAKES: Record<string, StepTake> = {
  implement_1: {
    input: 'goal · board: Marketing Site v3',
    plan: [
      todo('t1', 'Pull Figma frames + tokens'),
      todo('t2', 'Scaffold Hero / Nav / Pricing'),
      todo('t3', 'Apply tokens + responsive'),
      todo('t4', 'Write files + build')
    ],
    steps: [
      { todo: 't1', tool: { name: 'figma.get_design_context', arg: '12 frames' }, tokens: 1400 },
      { todo: 't1', tool: { name: 'read_file', arg: 'tokens.json' }, tokens: 600 },
      { todo: 't2', tool: { name: 'write_file', arg: 'src/Hero.tsx' }, tokens: 1500 },
      { todo: 't2', tool: { name: 'write_file', arg: 'src/Nav.tsx' }, tokens: 1200 },
      { todo: 't3', tool: { name: 'patch', arg: 'src/theme.css → tokens' }, tokens: 900 },
      { todo: 't3', tool: { name: 'write_file', arg: 'src/Pricing.tsx' }, tokens: 1300 },
      { todo: 't4', tool: { name: 'terminal', arg: 'npm run build' }, tokens: 500 }
    ],
    summary: 'diff +468 −0 · 8 files',
    output: { files: 8, diff: '+468 −0' },
    maxIters: 40
  },
  review_1: {
    input: 'goal · diff +468 (8 files)',
    steps: [
      { tool: { name: 'read_file', arg: 'engineering-rules.md' }, tokens: 500 },
      { tool: { name: 'search_files', arg: 'inline styles' }, tokens: 600 },
      { tool: { name: 'search_files', arg: 'naming + imports' }, tokens: 500 },
      { tool: { name: 'read_file', arg: 'diff (8 files)' }, tokens: 700 }
    ],
    verdict: 'PASS',
    summary: 'PASS · 2 nits (non-blocking)',
    output: { verdict: 'PASS', issues: ['naming: 2 nits (non-blocking)'] },
    maxIters: 20
  },
  judge_1: {
    input: 'goal · running app (no diff)',
    steps: [
      { tool: { name: 'browser_navigate', arg: 'localhost:5173' }, tokens: 400 },
      { tool: { name: 'browser_screenshot', arg: '5 viewports' }, tokens: 500 },
      { tool: { name: 'vision_analyze', arg: 'pixel-diff vs Figma' }, tokens: 900 },
      { tool: { name: 'vision_analyze', arg: 'type scale + spacing' }, tokens: 700 }
    ],
    verdict: 'FAIL',
    summary: 'FAIL · H1 400≠700 · pad 16≠24px',
    output: {
      verdict: 'FAIL',
      deltas: { h1_weight: '400 → 700', section_padding: '16 → 24px' }
    },
    maxIters: 20
  },
  // Only the FAILED validator gets another take; review stays satisfied.
  implement_2: {
    input: 'goal · judge feedback: H1→700, pad→24px',
    loop: true,
    plan: [todo('r1', 'Apply judge feedback'), todo('r2', 'Rebuild + verify')],
    steps: [
      { todo: 'r1', tool: { name: 'patch', arg: 'H1 font-weight 400→700' }, tokens: 800 },
      { todo: 'r1', tool: { name: 'patch', arg: 'section padding 16→24px' }, tokens: 700 },
      { todo: 'r2', tool: { name: 'terminal', arg: 'npm run build' }, tokens: 400 }
    ],
    summary: 'diff +19 −7 · 2 files',
    output: { files: 2, diff: '+19 −7' },
    maxIters: 40
  },
  judge_2: {
    input: 'goal · re-render (visual fix only)',
    steps: [
      { tool: { name: 'browser_navigate', arg: 'localhost:5173' }, tokens: 350 },
      { tool: { name: 'vision_analyze', arg: 'pixel-diff ≤ 0.4%' }, tokens: 650 },
      { tool: { name: 'vision_analyze', arg: 'type scale matches' }, tokens: 500 }
    ],
    verdict: 'PASS',
    summary: 'PASS · matches design',
    output: { verdict: 'PASS', deltas: { pixel_diff: '≤ 0.4%' } },
    maxIters: 20
  },
  ship_1: {
    input: 'goal · approved build (take 2)',
    plan: [todo('s1', 'Branch + commit'), todo('s2', 'Push + open PR')],
    steps: [
      { todo: 's1', tool: { name: 'terminal', arg: 'git checkout -b feat/site-v3' }, tokens: 250 },
      { todo: 's1', tool: { name: 'terminal', arg: 'git commit -m "feat(site): …"' }, tokens: 300 },
      { todo: 's2', tool: { name: 'terminal', arg: 'git push -u origin' }, tokens: 250 },
      { todo: 's2', tool: { name: 'terminal', arg: 'gh pr create' }, tokens: 300 }
    ],
    summary: 'PR #1234 opened',
    output: { pr_url: 'https://github.com/org/site/pull/1234', branch: 'feat/site-v3' },
    maxIters: 15
  }
}

// The gate's own work: read the group's verdicts, then route.
const GATE_STEPS: ToolStep[] = [
  { tool: { name: 'join: all validators must pass', arg: '' }, tokens: 150 },
  { tool: { name: 'delegate_task', arg: 'route' }, tokens: 150 }
]

// ---------------------------------------------------------------------------
// Executor
// ---------------------------------------------------------------------------
const PLAN_MS = 480
const STEP_MS = 620
const PEND_MS = 460
const WRAP_MS = 150
const LOOP_MS = 900
const PARK_MS = 2600 // a demo-scale pause; real runs park for hours
// A backstop the topology can't argue with. maxLoops caps the loops a gate
// owns; this catches whatever a graph does that nobody thought of, so a run
// ends instead of the tab.
const MAX_EVENTS = 4000
// A take's wall clock, in the only unit the scripts have: tool calls. Nothing
// here burns real minutes, so a budget in minutes needs a rate to bite at all.
const MINS_PER_CALL = 3

const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s)

/** What an unscripted step does. Every step outside the starter scenario is
 *  made of these, so a step you draw behaves like a step rather than nothing. */
function improvise(kind: StepKind, config: StepConfig, take: number, reportsVerdict: boolean): StepTake {
  const what = config.title.toLowerCase()

  return {
    input: config.goal?.trim() ? `goal · ${clip(config.goal, 44)}` : `goal · ${what}`,
    steps: [
      { tool: { name: 'read_file', arg: 'upstream output' }, tokens: 480 },
      { tool: { name: 'terminal', arg: what }, tokens: 620 }
    ],
    // Only a step feeding a gate owes one — that's what a validator IS, and a
    // gate with no verdicts to read routes everything down its fallback.
    verdict: reportsVerdict ? 'PASS' : undefined,
    summary: reportsVerdict ? 'PASS' : `${what} · done`,
    maxIters: config.maxIterations ?? (kind === 'agent' ? 20 : 8),
    loop: take > 0
  }
}

/** Tool calls a take makes — the plan is one of them, same as on the card. */
const callsOf = (spec: StepTake) => spec.steps.length + (spec.plan?.length ? 1 : 0)

/** How much of a take its budgets allow, and what to say when they don't allow
 *  all of it. Whichever cap bites first wins, so a step reports the budget it
 *  actually ran out of rather than the first one declared. */
function budget(config: StepConfig, calls: number): { allowed: number; error: string | null } {
  const caps: { at: number; error: string }[] = []
  const { maxIterations: iters, timeoutMins: mins } = config

  if (iters) {
    caps.push({ at: iters, error: `spent its ${iters}-iteration budget` })
  }

  if (mins) {
    caps.push({ at: Math.floor(mins / MINS_PER_CALL), error: `timed out after ${mins}m` })
  }

  const hit = caps.filter(c => c.at < calls).sort((a, b) => a.at - b.at)[0]

  return hit ? { allowed: hit.at, error: hit.error } : { allowed: calls, error: null }
}

/** Does this arm's condition hold, given what fed the gate this take? */
function holds(when: Predicate, inputs: { nodeId: string; verdict: Verdict }[]): boolean {
  switch (when.mode) {
    case 'always':
      return true

    case 'all-pass':
      return inputs.length > 0 && inputs.every(i => i.verdict !== 'FAIL')

    case 'any-fail':
      return inputs.some(i => i.verdict === 'FAIL')

    case 'checks':
      return when.checks.every(c => {
        const got = inputs.find(i => i.nodeId === c.step)?.verdict ?? null
        const is = String(got) === c.value

        return c.op === 'is' ? is : !is
      })

    case 'prose':
      // A judgement call the orchestrator would make by reading the summaries.
      // Nothing here can read them, so it stands in as the optimistic case and
      // the run stays deterministic.
      return inputs.every(i => i.verdict !== 'FAIL')
  }
}

export function buildTimeline(plan: RunPlan): TimelineStep[] {
  const out: TimelineStep[] = []
  const at = (atMs: number, step: Bare<ProtoEvent>) => out.push({ atMs, ...step } as TimelineStep)

  const byId = new Map(plan.steps.map(s => [s.id, s]))
  const kindOf = (id: string) => byId.get(id)?.kind
  const configOf = (id: string) => byId.get(id)?.config ?? ({ title: id } as StepConfig)
  // A wire that runs against the flow is a loop whether or not it says so — the
  // authored graph flags them, one you draw by hand doesn't.
  const forward = plan.edges.filter(e => !e.loop)
  const preds = (id: string) => forward.filter(e => e.target === id).map(e => e.source)
  const feedsGate = (id: string) => forward.some(e => e.source === id && kindOf(e.target) === 'gate')

  let checkpointNo = 0

  const checkpoint = (atMs: number, label: string) => {
    // `FrameCommitted` is the engine's wire name and stays verbatim; the canvas
    // reads these as checkpoints.
    at(atMs, { type: 'FrameCommitted', payload: { frameNo: checkpointNo, label } })
    at(atMs + 1, { type: 'SnapshotCaptured', payload: { frameNo: checkpointNo } })
    checkpointNo += 1
  }

  // Run one subagent's whole life, returning when it finished.
  const runStep = (
    nodeId: string,
    iteration: number,
    spec: StepTake,
    startAt: number,
    cap: { allowed: number; error: string | null }
  ): number => {
    let t = startAt
    at(t, {
      type: 'NodeStarted',
      payload: {
        nodeId,
        iteration,
        input: spec.input,
        // The panel's number, not the script's, so tightening the budget shows
        // on the card the moment the step runs under it.
        maxIters: configOf(nodeId).maxIterations ?? spec.maxIters,
        loop: spec.loop
      }
    })
    let used = 0

    const todos = spec.plan?.map(x => ({ ...x })) ?? []

    const pushTodos = (atMs: number) =>
      at(atMs, {
        type: 'TodoUpdated',
        payload: { nodeId, iteration, todos: todos.map(x => ({ ...x })) }
      })

    if (todos.length) {
      pushTodos(t + 5)
      t += PLAN_MS
      at(t, {
        type: 'AgentTraceEvent',
        payload: { nodeId, iteration, tool: { name: 'todo', arg: `plan · ${todos.length} tasks` } }
      })
      at(t, { type: 'TokenUsage', payload: { nodeId, iteration, tokens: 120 } })
      used += 1
    }

    let active: string | null = null

    for (const step of spec.steps) {
      if (used >= cap.allowed) {
        break
      }

      used += 1
      t += step.ms ?? STEP_MS

      if (step.todo && step.todo !== active) {
        const prev = todos.find(x => x.id === active)

        if (prev) {
          prev.status = 'completed'
        }

        const next = todos.find(x => x.id === step.todo)

        if (next) {
          next.status = 'in_progress'
        }

        active = step.todo
        pushTodos(t - 40)
      }

      at(t, { type: 'AgentTraceEvent', payload: { nodeId, iteration, tool: step.tool } })
      at(t, { type: 'TokenUsage', payload: { nodeId, iteration, tokens: step.tokens ?? 700 } })
    }

    if (active) {
      const last = todos.find(x => x.id === active)

      if (last) {
        last.status = 'completed'
      }

      pushTodos(t + 30)
    }

    t += WRAP_MS

    // A budget breach isn't a verdict — the step never got to an opinion. It
    // reports the wire's own failure event, which is the one the card already
    // knows how to draw red.
    if (cap.error) {
      at(t, { type: 'NodeFailed', payload: { nodeId, iteration, error: cap.error } })

      return t
    }

    at(t, {
      type: 'AgentTraceSummary',
      payload: { nodeId, iteration, summary: spec.summary, verdict: spec.verdict }
    })

    if (spec.output) {
      at(t + 5, { type: 'TaskOutput', payload: { nodeId, iteration, output: spec.output } })
    }

    at(t + 20, { type: 'NodeFinished', payload: { nodeId, iteration } })

    return t + 20
  }

  // A person. Nothing computes, and nothing here decides — the player holds the
  // stream on the HumanWaiting and doesn't emit the answer until someone gives
  // one. The approved branch is what's written down because it's the one that
  // has a rest-of-the-run; a denial ends it, which needs no script.
  const runHuman = (nodeId: string, iteration: number, startAt: number): number => {
    const c = configOf(nodeId)
    const who = c.assignee?.trim() || 'you'
    at(startAt, {
      type: 'HumanWaiting',
      payload: {
        nodeId,
        iteration,
        prompt: c.goal?.trim() || `${c.title} — approve?`,
        who,
        onFail: c.onFail ?? 'halt'
      }
    })
    const t = startAt + PARK_MS
    at(t, {
      type: 'HumanResponded',
      payload: { nodeId, iteration, decision: 'approved', by: who }
    })

    return t
  }

  // The world. Same park, different reason — and the reason is the one thing a
  // wait card has to say, so it goes on the wire.
  const runWait = (nodeId: string, iteration: number, startAt: number): number => {
    const u: WaitUntil = configOf(nodeId).until ?? { type: 'timer', spec: '' }
    const label = u.spec.trim() || u.type
    at(startAt, {
      type: 'WaitStarted',
      payload: { nodeId, iteration, until: `${u.type} · ${label}`, label }
    })
    const t = startAt + PARK_MS
    at(t, {
      type: 'WaitResolved',
      payload: {
        nodeId,
        iteration,
        by: u.type === 'timer' ? 'elapsed' : u.type === 'event' ? 'event received' : 'poll returned'
      }
    })

    return t
  }

  // A gate reads the verdicts of everything feeding it and takes the first arm
  // whose condition holds. That IS the routing table — there's no second place
  // that decides where the work goes.
  const runGate = (
    nodeId: string,
    iteration: number,
    startAt: number,
    inputs: { nodeId: string; verdict: Verdict }[]
  ): { at: number; arm: Arm | null; route: string | null; culprit: string | null } => {
    let t = startAt
    at(t, {
      type: 'NodeStarted',
      payload: {
        nodeId,
        iteration,
        input: inputs.map(v => `${v.nodeId} ${v.verdict ?? '—'}`).join(' · '),
        maxIters: 8,
        loop: false
      }
    })

    for (const step of GATE_STEPS) {
      t += 380
      at(t, { type: 'AgentTraceEvent', payload: { nodeId, iteration, tool: step.tool } })
      at(t, { type: 'TokenUsage', payload: { nodeId, iteration, tokens: step.tokens ?? 150 } })
    }

    t += WRAP_MS

    const arms = configOf(nodeId).arms ?? []
    const arm = arms.find(a => holds(a.when, inputs)) ?? null
    const route = (arm && plan.edges.find(e => e.source === nodeId && e.sourceHandle === arm.id)?.target) ?? null
    const culprit = inputs.find(i => i.verdict === 'FAIL')
    const why = culprit ? `${culprit.nodeId} FAIL` : 'group PASS'
    at(t, {
      type: 'GateEvaluated',
      payload: {
        nodeId,
        iteration,
        inputs,
        decision: culprit ? 'fail' : 'pass',
        route: route ?? '',
        summary: `${why} → ${route ? configOf(route).title : 'nowhere'}`
      }
    })

    return { at: t, arm, route, culprit: culprit?.nodeId ?? null }
  }

  const pending = (atMs: number, ids: string[], iteration: number) =>
    ids.forEach(nodeId => at(atMs, { type: 'NodePending', payload: { nodeId, iteration } }))

  // ---- the walk ------------------------------------------------------------
  at(0, { type: 'RunStarted', payload: { scenario: plan.name } })
  checkpoint(10, 'run start')

  const entries = plan.steps.filter(s => preds(s.id).length === 0).map(s => s.id)
  // A graph that's all cycle has no entry; start it somewhere rather than not
  // at all.
  let queue = entries.length ? entries : plan.steps.slice(0, 1).map(s => s.id)

  const ran = new Set<string>()
  const satisfied = new Set<string>() // passed on an earlier take, held over
  const tries = new Map<string, number>() // retries spent on a failing step
  // A retry re-runs the take that failed, so the script has to be the one that
  // failed — not the next one in the sequence, which is a different take.
  const retrying = new Map<string, StepTake>()
  const verdicts = new Map<string, Verdict>()
  const take = new Map<string, number>()
  let t = 120
  let loops = 0
  let failed = false
  let halted = false
  // Everything reachable is queued up front, the way a scheduler does it.
  pending(t, queue, 0)

  while (queue.length && out.length < MAX_EVENTS) {
    const ready = queue.filter(id => preds(id).every(p => ran.has(p) || satisfied.has(p) || !byId.has(p)))

    // Nothing can proceed — a join waiting on a branch that never runs.
    if (!ready.length) {
      break
    }

    queue = queue.filter(id => !ready.includes(id))

    const start = t + PEND_MS
    let end = start
    const routed: string[] = []

    for (const id of ready) {
      const kind = kindOf(id) ?? 'agent'
      const n = take.get(id) ?? 0

      if (kind === 'gate') {
        const inputs = preds(id).map(p => ({ nodeId: p, verdict: verdicts.get(p) ?? null }))
        const g = runGate(id, n, start, inputs)
        end = Math.max(end, g.at)
        ran.add(id)
        take.set(id, n + 1)
        verdicts.set(id, g.culprit ? 'FAIL' : 'PASS')

        // The gate chose an arm that goes nowhere, so the work stops here. That
        // has to end the run as failed rather than as quietly finished — check
        // warns about an unwired arm, but a run that drops half the graph and
        // reports success is the canvas lying about what happened.
        if (!g.route) {
          at(g.at + 40, {
            type: 'NodeFailed',
            payload: {
              nodeId: id,
              iteration: n,
              error: g.arm
                ? `"${g.arm.label ?? g.arm.id}" isn't wired anywhere`
                : 'no arm matched, so the work has nowhere to go'
            }
          })
          failed = true

          continue
        }

        // Sending work somewhere that already ran is what a loop IS — the
        // authored graph flags that edge, a hand-drawn one doesn't, so it's
        // read off the run rather than off the wire.
        if (ran.has(g.route)) {
          const cap = configOf(id).maxLoops ?? 5

          if (loops >= cap) {
            at(g.at + 40, {
              type: 'NodeFailed',
              payload: { nodeId: id, iteration: n, error: `gave up after ${cap} takes` }
            })
            failed = true

            continue
          }

          loops += 1
          at(g.at + 60, {
            type: 'LoopAdvanced',
            payload: {
              loopId: id,
              iteration: loops,
              to: g.route,
              feedback: g.culprit ? `${g.culprit} feedback` : 'another take'
            }
          })
          // The body of the loop runs again — except whatever already passed.
          // Not re-running a satisfied validator is the whole point of the
          // design: its tokens aren't spent twice.
          const body = between(g.route, id, forward)

          for (const b of body) {
            ran.delete(b)

            if (b !== g.route && b !== id && verdicts.get(b) === 'PASS') {
              satisfied.add(b)
              at(g.at + 90, {
                type: 'NodeSkipped',
                payload: {
                  nodeId: b,
                  iteration: loops,
                  reason: `satisfied · PASS on take ${take.get(b) ?? 1}`
                }
              })
            }
          }

          const rerun = body.filter(b => !satisfied.has(b))
          rerun.forEach(b => take.set(b, loops))
          pending(g.at + 120, rerun, loops)
          checkpoint(g.at + 140, `take ${loops + 1}`)
          end = Math.max(end, g.at + LOOP_MS)
          queue.push(g.route)

          continue
        }

        routed.push(g.route)

        continue
      }

      const config = configOf(id)
      const spec = retrying.get(id) ?? TAKES[`${id}_${n + 1}`] ?? improvise(kind, config, n, feedsGate(id))
      // Only a worker has a budget to blow. A person's clock is wall-clock and
      // the run parks on it; a wait is the clock.
      const cap = kind === 'agent' ? budget(config, callsOf(spec)) : { allowed: Infinity, error: null }

      const finish =
        kind === 'human'
          ? runHuman(id, n, start)
          : kind === 'wait'
            ? runWait(id, n, start)
            : runStep(id, n, spec, start, cap)

      end = Math.max(end, finish)
      take.set(id, n + 1)

      if (cap.error) {
        const spent = tries.get(id) ?? 0

        // Retries come first and the policy after — "takes before the step
        // reports failed", then "what the run does when it exhausts them".
        if (spent < (config.maxRetries ?? 0)) {
          tries.set(id, spent + 1)
          retrying.set(id, spec)
          at(finish + 40, { type: 'NodePending', payload: { nodeId: id, iteration: n + 1 } })
          queue.push(id)
          end = Math.max(end, finish + PEND_MS)

          continue
        }

        retrying.delete(id)
        ran.add(id)
        verdicts.set(id, 'FAIL')

        // Route hands the failure to the graph — a downstream gate reads FAIL
        // and picks its arm, which is exactly what a rejecting validator does,
        // so the run's outcome is whatever the rest of it produces rather than
        // a foregone failure. Halt has nowhere to hand it, and retry has
        // nothing left to try.
        if (config.onFail === 'route') {
          routed.push(...forward.filter(e => e.source === id).map(e => e.target))
        } else {
          failed = true
          halted = true
        }

        continue
      }

      retrying.delete(id)
      ran.add(id)
      // A wait has no opinion; a person's is their answer, which the player
      // holds the stream for.
      verdicts.set(id, kind === 'wait' ? null : kind === 'human' ? 'PASS' : (spec.verdict ?? null))
      routed.push(...forward.filter(e => e.source === id).map(e => e.target))
    }

    t = end
    checkpoint(t + 20, ready.length === 1 ? configOf(ready[0]).title : `${ready.length} steps`)

    if (halted) {
      break
    }

    for (const next of routed) {
      if (byId.has(next) && !queue.includes(next)) {
        queue.push(next)
      }
    }

    if (queue.length) {
      pending(
        t + 60,
        queue.filter(id => (take.get(id) ?? 0) === 0),
        0
      )
    }
  }

  at(t + 40, { type: 'RunFinished', payload: { state: failed ? 'failed' : 'succeeded' } })
  checkpoint(t + 60, 'run finished')

  // Parallel branches were built on their own clocks; interleave them.
  return out
    .map((s, i) => ({ s, i }))
    .sort((a, b) => a.s.atMs - b.s.atMs || a.i - b.i)
    .map(({ s }) => s)
}

/** Every step on a path from `from` to `to` — the body of a loop, which is what
 *  has to run again when a gate sends work back. */
function between(from: string, to: string, edges: { source: string; target: string }[]): string[] {
  const body = new Set<string>()

  const walk = (id: string, path: string[]): boolean => {
    if (id === to) {
      ;[...path, id].forEach(p => body.add(p))

      return true
    }

    if (path.includes(id)) {
      return false
    }

    // Every branch is walked, not just until one hits — a loop body is all of
    // them. `.some()` would stop at the first.
    return edges
      .filter(e => e.source === id)
      .map(e => walk(e.target, [...path, id]))
      .includes(true)
  }

  walk(from, [])

  return [...body]
}
