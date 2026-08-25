// Every structural change a scenario can undergo, as pure functions over
// { nodes, edges }, plus the tool descriptors that expose them to an agent.
//
// There is one rule this file exists to enforce: an agent edit and a hand edit
// are the SAME operation on the same document. The inspector, the + on a wire,
// the composer and (eventually) a real model calling `graph_connect` all land
// here, so there is no second implementation of "add a step" that can drift
// from the one the UI uses, and no mutation that skips undo.
//
// Pure on purpose. Each op takes the current graph and returns the next one,
// which is what lets App wrap the whole set in one snapshot/undo boundary and
// what lets the tools be tested without a canvas.

import type { Edge, Node, XYPosition } from '@xyflow/react'

import { freeRow, freeSpot, RANK_GAP, tidyLayout, widthOf } from './layout'
import type { NodeData } from './nodes'
import { freshRuntime } from './protocol'
import type { RunPlan } from './run.fake'
import {
  type Arm,
  defaultConfig,
  describePredicate,
  type EdgeDef,
  FIELD_LABEL,
  hasField,
  type KindField,
  NEW_BRANCH,
  type Predicate,
  pruneConfig,
  type Scenario,
  type ScenarioStep,
  STEP_KINDS,
  type StepConfig,
  type StepDef,
  type StepKind
} from './scenario'

export interface Graph {
  nodes: Node[]
  edges: Edge[]
}

/** What every op reports back: the next graph, plus a line fit for the composer
 *  transcript and the applied-edit chip. `ok: false` leaves the graph alone —
 *  a refused edit is a normal outcome, not an exception. */
export interface OpResult {
  ok: boolean
  graph: Graph
  message: string
  /** Short mutation summary, e.g. `+ step lint → gate`. Absent when nothing moved. */
  edit?: string
  /** Set by ops that mint something, so a caller can select it. */
  focus?: string
}

const fail = (graph: Graph, message: string): OpResult => ({ ok: false, graph, message })

const dataOf = (n: Node) => n.data as unknown as NodeData

export const stepById = (g: Graph, id: string) => g.nodes.find(n => n.id === id)

export const stepNodes = (g: Graph) => g.nodes.filter(n => !!dataOf(n)?.def)

/** Resolve a step the way a person would name it: by id first, then by title,
 *  case-insensitively. An agent that says "the visual judge" should not have to
 *  know we called it `judge`. */
export function resolveStep(g: Graph, ref: string): Node | undefined {
  const needle = ref.trim().toLowerCase()
  const steps = stepNodes(g)

  return (
    steps.find(n => n.id.toLowerCase() === needle) ??
    steps.find(n => dataOf(n).config.title.toLowerCase() === needle) ??
    steps.find(n => dataOf(n).config.title.toLowerCase().includes(needle))
  )
}

/** Stable, free, and readable. Ids are what gate rules and `needs:` refer to,
 *  so a minted one is derived from the title rather than a counter — `step-3`
 *  tells a later reader nothing, and an agent authoring a graph would have to
 *  invent names for its own conditions anyway. */
export function mintId(g: Graph, from: string): string {
  const base =
    from
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '_')
      .replace(/^_+|_+$/g, '')
      .slice(0, 24) || 'step'

  if (!stepById(g, base)) {
    return base
  }

  for (let i = 2; ; i++) {
    if (!stepById(g, `${base}_${i}`)) {
      return `${base}_${i}`
    }
  }
}

const edgeIdFor = (source: string, target: string) => `${source}->${target}`

// ---------------------------------------------------------------------------
// Steps
// ---------------------------------------------------------------------------

export interface AddStepInput {
  kind: StepKind
  title?: string
  goal?: string
  /** Splice into this wire: the new step takes its place in the middle. */
  onEdge?: string
  /** Wire straight out of this step. */
  after?: string
  /** Wire straight into this step. */
  before?: string
  position?: XYPosition
  config?: Partial<StepConfig>
}

export function addStep(g: Graph, input: AddStepInput): OpResult {
  const spec = STEP_KINDS.find(k => k.kind === input.kind)

  if (!spec) {
    return fail(g, `There's no "${input.kind}" kind — use agent, gate, human or wait.`)
  }

  const title = input.title?.trim() || spec.title
  const id = mintId(g, title)
  const def: StepDef = { id, kind: input.kind, title, doing: spec.doing }

  const config: StepConfig = {
    ...defaultConfig(def),
    ...(input.goal !== undefined ? { goal: input.goal } : {}),
    ...input.config,
    title
  }

  let edges = g.edges
  let wiring = ''
  // A tool almost never sends a position — an agent has no business knowing
  // the canvas's geometry. So the step is placed next to whatever it was
  // wired to, one rank along in the direction the flow runs, and nudged clear
  // of anything already sitting there. Nothing the author placed by hand moves.
  let anchor: Node | undefined
  let lead = 1

  if (input.onEdge) {
    const split = g.edges.find(e => e.id === input.onEdge)

    if (!split) {
      return fail(g, `There's no wire called "${input.onEdge}".`)
    }

    edges = [
      ...g.edges.filter(e => e.id !== split.id),
      newEdge(split.source, id, { sourceHandle: split.sourceHandle ?? undefined }),
      newEdge(id, split.target, { targetHandle: split.targetHandle ?? undefined })
    ]
    wiring = ` between ${split.source} and ${split.target}`
    anchor = stepById(g, split.source)
  } else {
    const links: Edge[] = []

    if (input.after) {
      const from = resolveStep(g, input.after)

      if (!from) {
        return fail(g, `There's no step called "${input.after}".`)
      }

      links.push(newEdge(from.id, id))
      anchor = from
    }

    if (input.before) {
      const to = resolveStep(g, input.before)

      if (!to) {
        return fail(g, `There's no step called "${input.before}".`)
      }

      links.push(newEdge(id, to.id))

      if (!anchor) {
        anchor = to
        lead = -1
      }
    }

    edges = [...g.edges, ...links]

    if (links.length) {
      wiring = ` ${input.after ? `after ${input.after}` : ''}${
        input.after && input.before ? ' and' : ''
      }${input.before ? ` before ${input.before}` : ''}`
    }
  }

  const position =
    input.position ??
    (anchor
      ? freeRow(g.nodes, {
          x: anchor.position.x + lead * (widthOf(anchor) + RANK_GAP),
          y: anchor.position.y
        })
      : freeSpot(g.nodes, { x: 0, y: 0 }))

  const node: Node = {
    id,
    type: input.kind,
    position,
    data: { def, config, rt: freshRuntime(), selected: false } satisfies NodeData
  }

  return {
    ok: true,
    graph: armWires({ nodes: [...g.nodes, node], edges }),
    message: `Added ${title}${wiring}.`,
    edit: `+ step ${id}`,
    focus: id
  }
}

/** Give every wire leaving a gate an arm to leave by.
 *
 *  `connect` mints one as it goes, but the wires addStep lays down — splicing
 *  onto an edge, or hanging a step off an `after` — are built directly, and a
 *  gate wire with no handle is one the card can't draw and the run can't
 *  follow. Splice a gate into the middle of a flow and the work stopped there
 *  silently: the gate picked an arm, the arm named no wire, and everything
 *  downstream just never ran. */
function armWires(g: Graph): Graph {
  const gates = new Set(
    stepNodes(g)
      .filter(n => dataOf(n).def.kind === 'gate')
      .map(n => n.id)
  )

  if (!gates.size) {
    return g
  }

  let nodes = g.nodes
  const taken = new Set(g.edges.filter(e => e.sourceHandle).map(e => `${e.source}/${e.sourceHandle}`))

  const edges = g.edges.map(e => {
    if (!gates.has(e.source)) {
      return e
    }

    const arms = armsOf({ nodes, edges: g.edges }, e.source)
    const named = e.sourceHandle && e.sourceHandle !== NEW_BRANCH

    if (named && arms.some(a => a.id === e.sourceHandle)) {
      return e
    }

    // The spare arm if there is one, a fresh one if there isn't — same choice
    // connect makes, so a wire laid down here is indistinguishable from a drawn
    // one.
    const spare = arms.find(a => !taken.has(`${e.source}/${a.id}`))

    const arm: Arm = spare ?? {
      id: freeArmId(
        arms.map(a => a.id),
        isLoop(e) ? 'loop' : 'pass'
      ),
      when: guessWhen(arms, isLoop(e))
    }

    if (!spare) {
      nodes = withArms({ nodes, edges: g.edges }, e.source, [...arms, arm])
    }

    taken.add(`${e.source}/${arm.id}`)

    return { ...e, sourceHandle: arm.id }
  })

  return { nodes, edges }
}

/** n8n's delete: a card with one hop in and one hop out reconnects its
 *  neighbours, so A → X → B becomes A → B with the ports preserved. Anything
 *  branching just loses its wires — healing a 2-in/2-out gate into four new
 *  edges would invent a topology nobody drew. */
export function removeStep(g: Graph, ref: string): OpResult {
  const node = resolveStep(g, ref)

  if (!node) {
    return fail(g, `There's no step called "${ref}".`)
  }

  const ins = g.edges.filter(e => e.target === node.id && !isLoop(e))
  const outs = g.edges.filter(e => e.source === node.id && !isLoop(e))
  const kept = g.edges.filter(e => e.source !== node.id && e.target !== node.id)

  const heal =
    ins.length === 1 &&
    outs.length === 1 &&
    ins[0].source !== outs[0].target &&
    !kept.some(e => e.source === ins[0].source && e.target === outs[0].target)
      ? [
          newEdge(ins[0].source, outs[0].target, {
            sourceHandle: ins[0].sourceHandle ?? undefined,
            targetHandle: outs[0].targetHandle ?? undefined
          })
        ]
      : []

  return {
    ok: true,
    graph: {
      nodes: g.nodes.filter(n => n.id !== node.id),
      edges: [...kept, ...heal]
    },
    message: `Removed ${dataOf(node).config.title}.`,
    edit: `− step ${node.id}`
  }
}

export function updateStep(g: Graph, ref: string, patch: Partial<StepConfig>): OpResult {
  const node = resolveStep(g, ref)

  if (!node) {
    return fail(g, `There's no step called "${ref}".`)
  }

  if (!Object.keys(patch).length) {
    return fail(g, 'Nothing to change.')
  }

  // A patch is cut to the kind before it lands. Saying so matters more than
  // silently dropping it: "set the model on this timer" is a misunderstanding
  // worth answering, and an agent that gets told which knob doesn't exist can
  // pick the step it actually meant.
  const { kind } = dataOf(node).def
  const keys = Object.keys(pruneConfig(kind, patch))
  const refused = Object.keys(patch).filter(k => !keys.includes(k))

  if (!keys.length) {
    return fail(g, `${kind} steps have no ${listOf(refused)}.`)
  }

  return {
    ok: true,
    graph: {
      nodes: g.nodes.map(n =>
        n.id === node.id
          ? {
              ...n,
              data: { ...n.data, config: { ...dataOf(n).config, ...pruneConfig(kind, patch) } }
            }
          : n
      ),
      edges: g.edges
    },
    message: refused.length
      ? `Updated ${dataOf(node).config.title} — ${kind} steps have no ${listOf(refused)}.`
      : `Updated ${dataOf(node).config.title}.`,
    edit: `${node.id} · ${keys.join(', ')}`,
    focus: node.id
  }
}

/** "a", "a and b", "a, b and c" — for naming the knobs a kind doesn't have, in
 *  the words the panel uses rather than the wire names. */
function listOf(keys: string[]): string {
  const xs = keys.map(k => FIELD_LABEL[k as KindField] ?? k)

  if (xs.length < 2) {
    return xs[0] ?? ''
  }

  return `${xs.slice(0, -1).join(', ')} and ${xs[xs.length - 1]}`
}

/** Renaming the id rewrites every reference to it — wires, handles and any gate
 *  rule that names it. The id is the only handle the rest of the scenario has
 *  on a step, so a rename that missed one would quietly break routing. */
export function renameStep(g: Graph, ref: string, nextId: string): OpResult {
  const node = resolveStep(g, ref)

  if (!node) {
    return fail(g, `There's no step called "${ref}".`)
  }

  const clean = nextId
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')

  if (!clean) {
    return fail(g, 'An id needs at least one letter or number.')
  }

  if (clean === node.id) {
    return fail(g, "That's already its id.")
  }

  if (stepById(g, clean)) {
    return fail(g, `"${clean}" is already taken.`)
  }

  const swap = (id: string) => (id === node.id ? clean : id)

  return {
    ok: true,
    graph: {
      nodes: g.nodes.map(n => {
        const arms = (n.data as NodeData).config.arms

        const renamed = arms?.map(a => ({
          ...a,
          when: renamePredicate(a.when, node.id, clean) ?? a.when
        }))

        const data = {
          ...n.data,
          ...(renamed ? { config: { ...(n.data as NodeData).config, arms: renamed } } : {}),
          ...(n.id === node.id ? { def: { ...dataOf(n).def, id: clean } } : {})
        }

        return n.id === node.id ? { ...n, id: clean, data } : { ...n, data }
      }),
      edges: g.edges.map(e => {
        if (e.source !== node.id && e.target !== node.id) {
          return e
        }

        const source = swap(e.source)
        const target = swap(e.target)

        return { ...e, id: edgeIdFor(source, target), source, target }
      })
    },
    message: `Renamed ${node.id} to ${clean}.`,
    edit: `${node.id} → ${clean}`,
    focus: clean
  }
}

const renamePredicate = (p: Predicate | undefined, from: string, to: string): Predicate | undefined =>
  p?.mode === 'checks' ? { ...p, checks: p.checks.map(c => (c.step === from ? { ...c, step: to } : c)) } : p

// ---------------------------------------------------------------------------
// Wires
// ---------------------------------------------------------------------------

export const isLoop = (e: Edge) => Boolean((e.data as { loop?: boolean })?.loop)

// ---------------------------------------------------------------------------
// Arms — a gate's outputs
//
// The gate owns them; a wire only names one. Everything that used to read a
// condition off an edge reads it off the arm the edge leaves by, so an arm can
// sit there unwired while you decide where it goes.
// ---------------------------------------------------------------------------

export const armsOf = (g: Graph, gateId: string): Arm[] =>
  (g.nodes.find(n => n.id === gateId)?.data as NodeData | undefined)?.config.arms ?? []

/** What the canvas prints beside an output: the name you gave it, or the
 *  condition itself when you haven't. */
export const armLabel = (a: Arm) => a.label?.trim() || describePredicate(a.when)

/** Rewrite a gate's arms in place. */
function withArms(g: Graph, gateId: string, arms: Arm[]): Node[] {
  return g.nodes.map(n =>
    n.id === gateId ? { ...n, data: { ...n.data, config: { ...(n.data as NodeData).config, arms } } } : n
  )
}

function newEdge(
  source: string,
  target: string,
  opts: { sourceHandle?: string; targetHandle?: string; loop?: boolean } = {}
): Edge {
  return {
    id: edgeIdFor(source, target),
    source,
    target,
    ...(opts.sourceHandle ? { sourceHandle: opts.sourceHandle } : {}),
    ...(opts.targetHandle ? { targetHandle: opts.targetHandle } : {}),
    type: 'data',
    data: { state: 'idle', loop: opts.loop }
  }
}

/** The first unclaimed id in the `pass`, `pass_2`, `pass_3` series. Appends
 *  what it hands out, so a caller naming several arms in one pass doesn't have
 *  to rebuild the list between them. */
function freeArmId(taken: string[], wanted: string): string {
  let name = wanted

  for (let i = 2; taken.includes(name); i++) {
    name = `${wanted}_${i}`
  }

  taken.push(name)

  return name
}

/** The condition a brand-new arm starts on. A gate's first forward output is
 *  the happy path, so "all pass" is the useful guess; anything after it is the
 *  else, because first match wins and a second "all pass" would sit there
 *  unreachable behind the first. A rework arm tests the opposite. */
function guessWhen(existing: Arm[], loop: boolean): Predicate {
  if (loop) {
    return { mode: 'any-fail' }
  }

  return existing.some(a => a.when.mode !== 'any-fail') ? { mode: 'always' } : { mode: 'all-pass' }
}

/** Add an output to a gate. Unwired — which is the whole point: you can lay
 *  out a routing table and then decide where each arm goes. */
export function addArm(g: Graph, ref: string, when?: Predicate, label?: string): OpResult {
  const gate = resolveStep(g, ref)

  if (!gate) {
    return fail(g, `There's no step called "${ref}".`)
  }

  if (dataOf(gate).def.kind !== 'gate') {
    return fail(g, `${gate.id} isn't a gate, so it has one output, not a table of them.`)
  }

  const arms = armsOf(g, gate.id)

  const arm: Arm = {
    id: freeArmId(
      arms.map(a => a.id),
      'pass'
    ),
    when: when ?? guessWhen(arms, false),
    ...(label ? { label } : {})
  }

  return {
    ok: true,
    graph: { nodes: withArms(g, gate.id, [...arms, arm]), edges: g.edges },
    message: `Added an output to ${gate.id}: "${armLabel(arm)}". Wire it to say where it goes.`,
    edit: `${gate.id} · + ${armLabel(arm)}`
  }
}

/** Drop an output, and whatever was wired to it — the wire has no port to
 *  leave by once the arm is gone. */
export function removeArm(g: Graph, ref: string, armId: string): OpResult {
  const gate = resolveStep(g, ref)

  if (!gate) {
    return fail(g, `There's no step called "${ref}".`)
  }

  const arms = armsOf(g, gate.id)
  const arm = arms.find(a => a.id === armId)

  if (!arm) {
    return fail(g, `${gate.id} has no "${armId}" output.`)
  }

  return {
    ok: true,
    graph: {
      nodes: withArms(
        g,
        gate.id,
        arms.filter(a => a.id !== armId)
      ),
      edges: g.edges.filter(e => !(e.source === gate.id && e.sourceHandle === armId))
    },
    message: `Dropped ${gate.id}'s "${armLabel(arm)}" output.`,
    edit: `${gate.id} · − ${armLabel(arm)}`
  }
}

export interface ConnectInput {
  source: string
  target: string
  when?: Predicate
  sourceHandle?: string
  targetHandle?: string
}

export function connect(g: Graph, input: ConnectInput): OpResult {
  const from = resolveStep(g, input.source)
  const to = resolveStep(g, input.target)

  if (!from) {
    return fail(g, `There's no step called "${input.source}".`)
  }

  if (!to) {
    return fail(g, `There's no step called "${input.target}".`)
  }

  if (from.id === to.id) {
    return fail(g, "A step can't feed itself.")
  }

  if (g.edges.some(e => e.source === from.id && e.target === to.id)) {
    return fail(g, `${from.id} already feeds ${to.id}.`)
  }

  // A wire that closes a cycle is a rework loop, and the canvas draws those
  // differently (deep belly under the flow, amber, held out of Dagre so the
  // graph still has a rank order to lay out). Detect it here rather than
  // asking the author to classify their own edge.
  const loop = reaches(g, to.id, from.id)
  const gate = dataOf(from)?.def?.kind === 'gate'

  // Out of a gate the wire has to leave by an arm. Naming one that already
  // exists claims it; the spare port (or a tool with no opinion) mints a new
  // one. Two wires can share an arm — that's a fan-out on one condition — so
  // claiming isn't exclusive.
  let nodes = g.nodes
  let sourceHandle = input.sourceHandle

  if (gate) {
    const arms = armsOf(g, from.id)
    const asked = input.sourceHandle
    const claimed = asked && asked !== NEW_BRANCH ? arms.find(a => a.id === asked) : undefined

    if (claimed) {
      sourceHandle = claimed.id

      if (input.when) {
        nodes = withArms(
          g,
          from.id,
          arms.map(a => (a.id === claimed.id ? { ...a, when: input.when! } : a))
        )
      }
    } else {
      const arm: Arm = {
        id: freeArmId(
          arms.map(a => a.id),
          loop ? 'loop' : 'pass'
        ),
        when: input.when ?? guessWhen(arms, loop)
      }

      sourceHandle = arm.id
      nodes = withArms(g, from.id, [...arms, arm])
    }
  }

  const edge = newEdge(from.id, to.id, {
    loop,
    sourceHandle,
    targetHandle: input.targetHandle ?? (loop ? 'loopback' : undefined)
  })

  return {
    ok: true,
    graph: { nodes, edges: [...g.edges, edge] },
    message: loop ? `Wired ${from.id} back to ${to.id} as a rework loop.` : `Wired ${from.id} into ${to.id}.`,
    edit: `${from.id} → ${to.id}`
  }
}

export function disconnect(g: Graph, source: string, target?: string): OpResult {
  const edge = target
    ? g.edges.find(e => (e.source === source && e.target === target) || e.id === edgeIdFor(source, target))
    : g.edges.find(e => e.id === source)

  if (!edge) {
    return fail(g, "There's no wire like that to cut.")
  }

  return {
    ok: true,
    graph: { nodes: g.nodes, edges: g.edges.filter(e => e.id !== edge.id) },
    message: `Cut ${edge.source} → ${edge.target}.`,
    edit: `− ${edge.source} → ${edge.target}`
  }
}

/** Turn a step into a different kind of step.
 *
 *  The kind decides which config fields mean anything and how many outputs the
 *  card has, so this rebuilds the config from the kind's defaults and keeps
 *  only what survives the change — the name, the instruction, and the wiring.
 *
 *  The wiring is the part that can't be skipped. A gate names each arm's port
 *  after the branch it is ("pass", "loop_2"); every other kind has exactly one
 *  output, called "out". Leave those handles alone and the wires point at
 *  ports the card no longer renders, which reads as edges flying to a corner. */
export function setKind(g: Graph, ref: string, kind: StepKind): OpResult {
  const node = resolveStep(g, ref)

  if (!node) {
    return fail(g, `There's no step called "${ref}".`)
  }

  const spec = STEP_KINDS.find(k => k.kind === kind)

  if (!spec) {
    return fail(g, `There's no "${kind}" kind — use agent, gate, human or wait.`)
  }

  const data = dataOf(node)
  const was = data.def.kind

  if (was === kind) {
    return fail(g, `${node.id} is already a ${kind}.`)
  }

  const def: StepDef = { ...data.def, kind, doing: spec.doing }

  // Whatever the two kinds share comes across — the name always, the
  // instruction and the timeout between an agent and a human — and the new
  // kind's defaults fill what it gained. Everything else is dropped by the
  // prune rather than by a list here, so a step converted twice can't arrive
  // back carrying a knob it lost on the way out.
  const config: StepConfig = {
    ...defaultConfig(def),
    ...pruneConfig(kind, data.config)
  } as StepConfig

  // Becoming a gate gives every wire already leaving an arm to leave by;
  // ceasing to be one collapses them all onto the single output every other
  // kind has. Skip either and the wires point at ports the card no longer
  // renders, which reads as edges flying off to a corner.
  let edges = g.edges

  if (kind === 'gate') {
    // The wires already leaving decide the table — one arm each, replacing the
    // pass/fail pair a gate is born with, which is only right for a gate made
    // from nothing. Keeping both is what duplicated the ids.
    const out = g.edges.filter(e => e.source === node.id)

    if (out.length) {
      const taken: string[] = []
      const arms: Arm[] = []

      for (const e of out) {
        const loop = isLoop(e)

        const arm: Arm = {
          id: freeArmId(taken, loop ? 'loop' : 'pass'),
          when: guessWhen(arms, loop)
        }

        arms.push(arm)
        edges = edges.map(x => (x.id === e.id ? { ...x, sourceHandle: arm.id } : x))
      }

      config.arms = arms
    }
  } else if (was === 'gate') {
    edges = g.edges.map(e => (e.source === node.id ? { ...e, sourceHandle: 'out' } : e))
  }

  return {
    ok: true,
    graph: {
      nodes: g.nodes.map(n => (n.id === node.id ? { ...n, type: kind, data: { ...n.data, def, config } } : n)),
      edges
    },
    message: `${node.id} is a ${kind} step now.`,
    edit: `${node.id} · ${was} → ${kind}`
  }
}

/** Edit one output on a gate: its condition, its name, or both. */
export function setBranch(g: Graph, ref: string, armId: string, patch: { when?: Predicate; label?: string }): OpResult {
  const gate = resolveStep(g, ref)

  if (!gate) {
    return fail(g, `There's no step called "${ref}".`)
  }

  const arms = armsOf(g, gate.id)

  if (!arms.some(a => a.id === armId)) {
    return fail(g, `${gate.id} has no "${armId}" output.`)
  }

  const next = arms.map(a => (a.id === armId ? { ...a, ...patch } : a))
  const arm = next.find(a => a.id === armId)!

  return {
    ok: true,
    graph: { nodes: withArms(g, gate.id, next), edges: g.edges },
    message: `Updated ${gate.id}'s "${armLabel(arm)}" output.`,
    edit: `${gate.id} · ${armLabel(arm)}`
  }
}

/** Where an arm's wires go, if it has any. An arm with none is a rule you've
 *  written down and not yet pointed anywhere — legal, and flagged by check. */
export const armTargets = (g: Graph, gateId: string, armId: string): Edge[] =>
  g.edges.filter(e => e.source === gateId && (e.sourceHandle ?? '') === armId)

/** Can `from` reach `to` following forward wires? Used to tell a rework loop
 *  from an ordinary wire, and to find steps the run can never arrive at. */
function reaches(g: Graph, from: string, to: string): boolean {
  const seen = new Set<string>()
  const stack = [from]

  while (stack.length) {
    const at = stack.pop()!

    if (at === to) {
      return true
    }

    if (seen.has(at)) {
      continue
    }

    seen.add(at)

    for (const e of g.edges) {
      if (e.source === at && !isLoop(e)) {
        stack.push(e.target)
      }
    }
  }

  return false
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

export interface Problem {
  level: 'error' | 'warning'
  /** Names the offending step, so the message stands alone in a tool result. */
  message: string
  /** Which step it's about, for a caller showing one step's problems rather
   *  than the whole list. Absent when it's about the scenario as a whole. */
  step?: string
}

/** What's wrong with the scenario as authored — the things you'd otherwise only
 *  discover by running it. Deliberately not enforced at edit time: a graph is
 *  allowed to be half-built while you build it. */
export function validate(g: Graph): Problem[] {
  const steps = stepNodes(g)
  const problems: Problem[] = []

  if (!steps.length) {
    return [{ level: 'warning', message: 'The scenario is empty.' }]
  }

  const entries = steps.filter(n => !g.edges.some(e => e.target === n.id && !isLoop(e)))

  if (!entries.length) {
    problems.push({ level: 'error', message: 'Nothing starts the run — every step has an input.' })
  }

  for (const n of steps) {
    const id = n.id
    const { def, config } = dataOf(n)

    if (entries.length && !entries.includes(n) && !entries.some(s => reaches(g, s.id, id))) {
      problems.push({ level: 'error', message: `${id} can't be reached from a start.`, step: id })
    }

    // Deciding when to stop going round is a gate's job — `max takes` is the
    // only place the schema keeps that number. A rework loop drawn straight out
    // of a step has nothing to end it, so the run doesn't follow it, and the
    // wire sits on the canvas looking like it does something.
    if (def.kind !== 'gate' && g.edges.some(e => e.source === id && isLoop(e))) {
      problems.push({
        level: 'warning',
        message: `${id}'s rework loop doesn't leave from a gate, so nothing decides when to stop — the run won't take it.`,
        step: id
      })
    }

    if (def.kind === 'gate') {
      const arms = config.arms ?? []

      if (arms.length < 2) {
        problems.push({
          level: 'warning',
          message: `${id} is a gate with ${arms.length === 1 ? 'one output' : 'no outputs'} — it isn't branching.`,
          step: id
        })
      }

      if (arms.length && !arms.some(a => a.when.mode === 'always')) {
        problems.push({
          level: 'warning',
          message: `${id} has no default arm, so some verdicts route nowhere.`,
          step: id
        })
      }

      arms.forEach(a => {
        const where = `${id}'s "${armLabel(a)}" output`

        // An arm can outlive its wire — that's what lets you write the table
        // before you wire it — but a rule the run can't follow is worth saying.
        if (!armTargets(g, id, a.id).length) {
          problems.push({ level: 'warning', message: `${where} isn't wired anywhere.`, step: id })
        }

        if (a.when.mode === 'checks' && !a.when.checks.length) {
          problems.push({ level: 'warning', message: `${where} has no conditions yet.`, step: id })
        }

        if (a.when.mode === 'prose' && !a.when.source.trim()) {
          problems.push({
            level: 'warning',
            message: `${where} has nothing for the gate to read.`,
            step: id
          })
        }
      })
    }

    // Asked of the schema rather than the kind, so a field that moves between
    // kinds doesn't leave a check behind pointed at a step that no longer has
    // it — or, worse, stop being checked on the kind it moved to.
    if (hasField(def.kind, 'until') && !config.until?.spec.trim()) {
      problems.push({ level: 'warning', message: `${id} doesn't say what it waits for.`, step: id })
    }

    if (hasField(def.kind, 'goal') && !config.goal?.trim()) {
      problems.push({
        level: 'warning',
        message: `${id} has no ${def.kind === 'human' ? 'question' : 'goal'}.`,
        step: id
      })
    }
  }

  return problems
}

/** The graph, reduced to what running it needs.
 *
 *  The executor takes this rather than the graph itself so it never has to know
 *  about React Flow — same reason toScenario exists, and the same boundary. */
export function runPlan(g: Graph, name: string): RunPlan {
  return {
    name,
    steps: stepNodes(g).map(n => {
      const { def, config } = dataOf(n)

      return { id: n.id, kind: def.kind, config }
    }),
    edges: g.edges.map(e => ({
      id: e.id,
      source: e.source,
      target: e.target,
      sourceHandle: e.sourceHandle ?? undefined,
      loop: isLoop(e)
    }))
  }
}

// ---------------------------------------------------------------------------
// Serialization
// ---------------------------------------------------------------------------

export function toScenario(g: Graph): Scenario {
  return {
    version: 1,
    steps: stepNodes(g).map((n): ScenarioStep => {
      const { def, config } = dataOf(n)

      return {
        id: n.id,
        kind: def.kind,
        config,
        position: { x: Math.round(n.position.x), y: Math.round(n.position.y) },
        icon: def.icon,
        doing: def.doing
      }
    }),
    // A wire carries no routing of its own any more — it names the arm it
    // leaves by, and the arm travels with the gate's config.
    edges: stepEdges(g).map((e): EdgeDef => ({
      id: e.id,
      source: e.source,
      target: e.target,
      sourceHandle: e.sourceHandle ?? undefined,
      targetHandle: e.targetHandle ?? undefined,
      loop: isLoop(e)
    }))
  }
}

const stepEdges = (g: Graph) => {
  const ids = new Set(stepNodes(g).map(n => n.id))

  return g.edges.filter(e => ids.has(e.source) && ids.has(e.target))
}

/** Rebuild a graph from an authored scenario. Anything the scenario doesn't
 *  place gets laid out, which is what lets an agent send a whole workflow
 *  without knowing the first thing about the canvas's geometry. */
/** Reconcile each gate's outputs with the wires leaving it, before either is
 *  built — a wire names the port it expects and the gate has to actually have
 *  it, or the canvas draws a wire from nowhere.
 *
 *  A payload that declares its outputs is taken at its word, and anything its
 *  wires ask for on top is added. A payload that declares none gets a table
 *  read off the wires, which is what lets an agent send a whole scenario
 *  without stating the routing twice. */
function gateWiring(s: Scenario) {
  const arms = new Map<string, Arm[]>()
  const handles = new Map<string, string>()

  for (const step of s.steps) {
    if (step.kind !== 'gate') {
      continue
    }

    const mine: Arm[] = (step.config.arms ?? []).map(a => ({ ...a }))

    for (const e of s.edges) {
      if (e.source !== step.id) {
        continue
      }

      const id =
        e.sourceHandle ||
        freeArmId(
          mine.map(a => a.id),
          e.loop ? 'loop' : 'pass'
        )

      // Two wires on one id is a fan-out sharing a condition, not a second arm.
      if (!mine.some(a => a.id === id)) {
        mine.push({ id, when: guessWhen(mine, !!e.loop) })
      }

      handles.set(e.id || edgeIdFor(e.source, e.target), id)
    }

    if (mine.length) {
      arms.set(step.id, mine)
    }
  }

  return { arms, handles }
}

export function fromScenario(s: Scenario): Graph {
  const wires = gateWiring(s)

  const nodes: Node[] = s.steps.map(step => {
    const def: StepDef = {
      id: step.id,
      kind: step.kind,
      title: step.config.title,
      icon: step.icon,
      doing: step.doing,
      profile: step.config.profile,
      model: step.config.model
    }

    // Authored config is an overlay on the kind's defaults, never a
    // replacement, and it's cut to the kind on the way in — a payload from an
    // older schema (or a hand-written one) can otherwise seed every reader
    // with fields the kind stopped having.
    const config: StepConfig = {
      ...defaultConfig(def),
      ...pruneConfig(step.kind, step.config)
    } as StepConfig

    if (step.kind === 'gate') {
      config.arms = wires.arms.get(step.id) ?? config.arms
    }

    return {
      id: step.id,
      type: step.kind,
      position: step.position ?? { x: 0, y: 0 },
      data: { def, config, rt: freshRuntime(), selected: false } satisfies NodeData
    }
  })

  const edges: Edge[] = s.edges.map(e => {
    const id = e.id || edgeIdFor(e.source, e.target)
    const sourceHandle = wires.handles.get(id) ?? e.sourceHandle

    return {
      id,
      source: e.source,
      target: e.target,
      ...(sourceHandle ? { sourceHandle } : {}),
      ...(e.targetHandle ? { targetHandle: e.targetHandle } : {}),
      type: 'data',
      data: { state: 'idle', loop: e.loop }
    }
  })

  const placed = s.steps.every(step => step.position) ? nodes : tidyLayout(nodes, edges)

  return { nodes: placed, edges }
}

/** Swap the whole scenario for another one. The counterpart to graph_get: an
 *  agent that wants to author a workflow outright shouldn't have to express it
 *  as thirty surgical edits. */
export function setScenario(g: Graph, s: Scenario): OpResult {
  if (!s?.steps?.length) {
    return fail(g, 'A scenario needs at least one step.')
  }

  return {
    ok: true,
    graph: fromScenario({ ...s, version: 1 }),
    message: `Replaced the scenario — ${s.steps.length} steps, ${s.edges?.length ?? 0} wires.`,
    edit: `scenario · ${s.steps.length} steps`
  }
}
