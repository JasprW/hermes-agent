// The composer's turn engine.
//
// The ONE thing this file must get right is its output shape: it produces TOOL
// CALLS, never mutations. Everything it decides is expressed as
// `{ name: "graph_connect", args: {...} }` and handed to `callTool` — the same
// dispatcher the inspector and the canvas go through. An agent edit and a hand
// edit are the same operation on the same document, and nothing downstream
// knows which one it was.
//
// The model gets `GRAPH_TOOLS` verbatim as its contract and the open scenario
// as its context, so it is describing the graph in the same schema the canvas
// stores it in. What comes back is applied, validated, and — if the model
// authored something the schema says is broken — handed back once with the
// problems attached. That repair round is the difference between "generates a
// workflow" and "generates a workflow that runs".

import { host } from '@hermes/plugin-sdk'

import { type Graph, type OpResult, resolveStep, stepNodes, toScenario, validate } from './graph'
import { callTool, GRAPH_TOOLS, type RunControl, type ToolArgs } from './graph-tools'
import { MODEL_OPTIONS, ON_FAIL_OPTIONS, PROFILES, type StepKind, type WaitUntil } from './scenario'

export interface PlannedCall {
  name: string
  args: ToolArgs
}

export interface TurnResult {
  graph: Graph
  reply: string
  /** One-line summary of what changed, shown as an applied-edit chip. */
  edit?: string
  focus?: string
}

// ---------------------------------------------------------------------------
// The contract
// ---------------------------------------------------------------------------

/** What the model is told it is and what it may do. The tool list is the same
 *  JSON Schema the descriptors already publish, so there is exactly one
 *  definition of the surface and it can't drift from what `callTool` accepts. */
const CONTRACT = [
  'You edit agent workflows on a node canvas. A workflow is a graph of steps —',
  'agent (a model does the work), human (a person does, and the run parks),',
  'gate (branches on what already happened), wait (holds for the world).',
  '',
  'Reply with ONLY a JSON array of tool calls, each `{"tool": name, "args": {...}}`.',
  'No prose, no markdown fence. An empty array means you have nothing to do.',
  '',
  'Rules that keep a graph runnable:',
  '- Every step must be reachable from a step with no inputs.',
  '- A gate needs at least two outputs, and one of them must be `always` —',
  '  the catch-all, added last, or some verdicts route nowhere.',
  '- Only a gate may start a rework loop; a loop from anything else never runs.',
  '- Every agent and human step needs a goal. Every wait needs an `until`.',
  '- Prefer the surgical tools for a change to an existing graph, and',
  '  `graph_set_scenario` only when authoring a whole workflow at once.',
  '',
  `Profiles: ${PROFILES.join(', ')}. Models: ${MODEL_OPTIONS.join(', ')}.`,
  `On failure: ${ON_FAIL_OPTIONS.map(o => o.value).join(', ')}.`,
  '',
  'Tools:',
  JSON.stringify(GRAPH_TOOLS)
].join('\n')

/** One model call. Kept separate from the loop below so the repair round is
 *  visibly the same call with more context, not a second code path. */
async function ask(input: string): Promise<PlannedCall[]> {
  const { text } = await host.request<{ text?: string }>('llm.oneshot', {
    instructions: CONTRACT,
    input,
    temperature: 0.2,
    max_tokens: 4096
  })

  return parseCalls(text ?? '')
}

/** Models fence JSON however they like. Take the outermost array and ignore
 *  everything around it rather than failing a good plan over a stray sentence. */
function parseCalls(text: string): PlannedCall[] {
  const start = text.indexOf('[')
  const end = text.lastIndexOf(']')

  if (start < 0 || end <= start) {
    return []
  }

  let parsed: unknown

  try {
    parsed = JSON.parse(text.slice(start, end + 1))
  } catch {
    return []
  }

  if (!Array.isArray(parsed)) {
    return []
  }

  const known = new Set(GRAPH_TOOLS.map(t => t.name))

  return parsed
    .map(c => c as { tool?: unknown; name?: unknown; args?: unknown })
    .map(c => ({
      name: typeof c.tool === 'string' ? c.tool : typeof c.name === 'string' ? c.name : '',
      args: (c.args ?? {}) as ToolArgs
    }))
    .filter(c => known.has(c.name))
}

/** The graph as the model sees it. The whole scenario, because the tools
 *  address steps by id and it can't invent ids it hasn't been shown. */
const describe = (g: Graph) => JSON.stringify(toScenario(g))

// ---------------------------------------------------------------------------
// A turn
// ---------------------------------------------------------------------------

/** Run one composer turn against the graph.
 *
 *  Plan, apply, validate, and if the result is broken, hand the problems back
 *  for one repair round. One round, not a loop: a model that can't fix its own
 *  output given the exact complaint won't fix it on the fourth try either, and
 *  the author is sitting there watching. */
export async function runTurn(text: string, graph: Graph, run: RunControl): Promise<TurnResult> {
  // A throw (no gateway, no model, a refusal) and an empty plan land in the
  // same place: the built-in planner, which covers the common single-verb asks
  // so the canvas stays usable with the gateway down.
  let calls = await ask(`Open workflow:\n${describe(graph)}\n\nAsk:\n${text}`).catch((): PlannedCall[] => [])

  if (!calls.length) {
    calls = interpret(text, graph)
  }

  if (!calls.length) {
    return {
      graph,
      reply:
        'I can build it, run it, or change it — try “add a lint step between implement and gate”, ' +
        '“connect judge to ship”, “make the visual judge blind”, “allow 3 takes”, “check it”, or “run it”.'
    }
  }

  const first = apply(graph, run, calls)

  // Only worth repairing what the model just authored, and only when the
  // schema calls it an error — a warning is a note about an unfinished graph,
  // which is a perfectly reasonable thing to be handed mid-edit.
  const broken = validate(first.graph).filter(p => p.level === 'error')

  if (!broken.length || first.graph === graph) {
    return first
  }

  try {
    const fixes = await ask(
      `Workflow you just produced:\n${describe(first.graph)}\n\n` +
        `It doesn't run. Fix exactly these, changing nothing else:\n` +
        broken.map(p => `- ${p.message}`).join('\n')
    )

    if (fixes.length) {
      const repaired = apply(first.graph, run, fixes)

      return { ...repaired, reply: first.reply, edit: repaired.edit ?? first.edit }
    }
  } catch {
    // Keep the first pass. A graph with a known problem beats no graph, and
    // the inspector already shows what's wrong with it.
  }

  return first
}

/** Run a plan, folding each tool's result into the next call's graph. */
function apply(graph: Graph, run: RunControl, calls: PlannedCall[]): TurnResult {
  let next = graph
  const said: string[] = []
  const edits: string[] = []
  let focus: string | undefined

  for (const c of calls) {
    const op: OpResult = callTool(next, run, c.name, c.args)
    said.push(op.message)

    if (!op.ok) {
      continue
    }

    if (op.edit) {
      edits.push(op.edit)
    }

    if (op.focus) {
      focus = op.focus
    }

    next = op.graph
  }

  return { graph: next, reply: said.join(' '), edit: edits.join(', ') || undefined, focus }
}

// ---------------------------------------------------------------------------
// Offline planner
//
// The fallback when there's no model to ask: a pile of regexes over the single
// verb the sentence leads with. It reads the live graph only to resolve names,
// the way a model would after calling graph_get, and it emits the same tool
// calls — so the seam stays honest and the canvas is usable with the gateway
// down.
// ---------------------------------------------------------------------------

const KIND_WORDS: [RegExp, StepKind][] = [
  [/\bgate\b|\bbranch\b|\brouter?\b|\bdecision\b/, 'gate'],
  [/\bhuman\b|\bperson\b|\bapprovals?\b|\bsign[- ]?off\b|\bmanual\b/, 'human'],
  [/\bwait\b|\bdelay\b|\btimer\b|\bpoll\b|\bsleep\b/, 'wait'],
  [/\bagent\b|\bstep\b|\btask\b|\bvalidator\b|\bcheck\b/, 'agent']
]

const kindIn = (t: string): StepKind | undefined => KIND_WORDS.find(([re]) => re.test(t))?.[1]

/** Words that end a name rather than belong to it, so "called Soak after ship"
 *  yields "Soak" and not a step whose title is the rest of the sentence. */
const TAIL = /\s+\b(?:after|before|between|and|then|that|which|to|for|with|in|on|from)\b.*$/i

/** Pull a quoted or "called X" name out of the sentence. */
function titleIn(t: string): string | undefined {
  const quoted = t.match(/["“']([^"”']{2,48})["”']/)

  if (quoted) {
    return quoted[1].trim()
  }

  const called = t.match(/\b(?:called|named)\s+([a-z0-9][\w .&-]{1,40})/i)

  if (called) {
    return called[1]
      .replace(TAIL, '')
      .trim()
      .replace(/\s+(step|node|gate)$/i, '')
  }

  return undefined
}

/** Tokens too generic to identify a step by. */
const NOISE = new Set(['step', 'node', 'gate', 'task', 'the', 'and', 'ui', 'new'])

const tokens = (s: string) =>
  s
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(w => w.length > 2 && !NOISE.has(w))

/** Every step the sentence names, in the order they appear — how connect and
 *  disconnect find their two ends.
 *
 *  Matches claim their span of the sentence longest-first, because step names
 *  nest: in "connect legal review to gate" the word "review" sits inside
 *  "legal review", and taking it would wire the wrong pair. Whoever covers
 *  more of the text wins the characters, and nothing else may reuse them.
 *
 *  Exact ids and titles go first; the loose single-word pass only runs if that
 *  found fewer than two, so a shared word like "ship" in one step's title
 *  can't drag in a step the sentence never mentioned. */
function mentioned(g: Graph, t: string): string[] {
  const steps = stepNodes(g)
  const titleOf = (n: (typeof steps)[number]) => (n.data as { config: { title: string } }).config.title.toLowerCase()

  const claimed: [number, number][] = []
  const hits: { at: number; id: string }[] = []

  const take = (id: string, at: number, len: number) => {
    if (at < 0 || hits.some(h => h.id === id)) {
      return
    }

    if (claimed.some(([s, e]) => at < e && at + len > s)) {
      return
    }

    claimed.push([at, at + len])
    hits.push({ at, id })
  }

  const exact = steps
    .flatMap(n =>
      [n.id.toLowerCase(), titleOf(n)].map(needle => ({
        id: n.id,
        at: t.indexOf(needle),
        len: needle.length
      }))
    )
    .filter(c => c.at >= 0)
    .sort((a, b) => b.len - a.len)

  for (const c of exact) {
    take(c.id, c.at, c.len)
  }

  if (hits.length < 2) {
    const said = new Set(tokens(t))

    for (const n of steps) {
      const word = [...tokens(n.id), ...tokens(titleOf(n))].find(w => said.has(w))

      if (word) {
        take(n.id, t.indexOf(word), word.length)
      }
    }
  }

  return hits.sort((a, b) => a.at - b.at).map(h => h.id)
}

/** The sentence with one step's own name struck out. */
function unnamed(g: Graph, t: string, id: string): string {
  const node = stepNodes(g).find(n => n.id === id)
  const title = (node?.data as { config: { title: string } } | undefined)?.config.title ?? ''

  return [id, title].filter(Boolean).reduce((s, name) => s.split(name.toLowerCase()).join(' '), t)
}

const num = (t: string, re: RegExp) => {
  const m = t.match(re)

  return m ? Number(m[1]) : undefined
}

export function interpret(text: string, g: Graph): PlannedCall[] {
  // Matching happens against the downcased sentence; names are read from the
  // original, so a step the author called "Legal Review" keeps its capitals.
  const raw = text.trim()
  const t = raw.toLowerCase()
  const call = (name: string, args: ToolArgs = {}): PlannedCall[] => [{ name, args }]
  const names = mentioned(g, t)
  // Unqualified "make it blind" means the step the sentence named, and failing
  // that the first one — the planner knows nothing about which scenario is open.
  const target = () => names[0] ?? stepNodes(g)[0]?.id

  // ---- run control -------------------------------------------------------
  if (/\b(pause|hold on|hold it)\b/.test(t)) {
    return call('run_control', { action: 'pause' })
  }

  if (/\b(resume|continue|unpause|carry on)\b/.test(t)) {
    return call('run_control', { action: 'resume' })
  }

  if (/\b(reset|clear|start over|wipe)\b/.test(t)) {
    return call('run_control', { action: 'reset' })
  }

  if (/\b(run|re-?run|start|go|execute|kick ?off)\b/.test(t) && !/\badd\b/.test(t)) {
    return call('run_control', { action: 'start' })
  }

  // ---- read-only ---------------------------------------------------------
  if (/\b(validate|check it|problems?|wrong|sound|sanity)\b/.test(t)) {
    return call('graph_validate')
  }

  if (/\b(what|show|describe|list|explain)\b/.test(t) && !/\badd\b|\bmake\b/.test(t)) {
    return call('graph_get')
  }

  // ---- topology ----------------------------------------------------------
  // Before add and remove, both of which would otherwise claim the sentence
  // and mint or delete a whole step where an output was asked for.
  if (/\b(output|branch|arm|routing rule)\b/.test(t) && names.length) {
    if (/\b(add|another|new|create)\b/.test(t)) {
      return call('graph_add_arm', { gate: names[0] })
    }

    if (/\b(remove|delete|drop)\b/.test(t)) {
      const arm = /\b(?:output|branch|arm)\s+["']?([\w-]+)["']?/.exec(t)?.[1]

      if (arm) {
        return call('graph_remove_arm', { gate: names[0], arm })
      }
    }
  }

  if (/\b(disconnect|unwire|unlink|detach|cut)\b/.test(t) && names.length >= 2) {
    return call('graph_disconnect', { source: names[0], target: names[1] })
  }

  if (/\b(connect|wire|link|feed|route|join)\b/.test(t) && names.length >= 2) {
    return call('graph_connect', { source: names[0], target: names[1] })
  }

  if (/\b(remove|delete|drop|get rid of)\b/.test(t) && names.length) {
    return call('graph_remove_step', { step: names[0] })
  }

  // Before add, or "make gate a human step" reads as a request for a new one.
  // The kind comes from the sentence with the subject's own name struck out —
  // "turn the quality gate into a human step" names its subject with a kind
  // word, and reading the whole sentence picks the thing it already is.
  if (/\b(turn|convert|change|make)\b/.test(t) && names.length) {
    const kind = kindIn(unnamed(g, t, names[0]))
    // "make soak poll every 5m" is the one sentence that reads as both. `poll`
    // and `timer` name a kind AND a wait condition, so on a step that's already
    // a wait the conversion is a no-op and the rest of the line is the point —
    // fall through and let the config rules have it.
    const restating = kind === kindOf(g, names[0])

    if (kind && !(restating && readUntil(t))) {
      return call('graph_set_kind', { step: names[0], kind })
    }
  }

  if (/\b(rename|call it)\b/.test(t) && names.length) {
    const to = titleIn(raw)

    if (to) {
      return call('graph_rename_step', { step: names[0], new_id: to })
    }
  }

  if (/\b(add|insert|create|new|put)\b/.test(t)) {
    const kind = kindIn(t) ?? 'agent'

    const title =
      titleIn(raw) ??
      (/\blint\b|\btypecheck\b|\btsc\b/.test(t)
        ? 'Lint & Types'
        : kind === 'gate'
          ? 'Gate'
          : kind === 'human'
            ? 'Approval'
            : kind === 'wait'
              ? 'Wait'
              : 'Step')

    // "after X" / "before Y" / "between X and Y" place it; otherwise it lands
    // unwired and the author drags it where they want.
    const after = t.match(/\bafter\s+([\w .&-]{2,40})/)?.[1]?.trim()
    const before = t.match(/\b(?:before|ahead of)\s+([\w .&-]{2,40})/)?.[1]?.trim()
    const between = t.match(/\bbetween\s+([\w .&-]+?)\s+and\s+([\w .&-]{2,40})/)

    const args: ToolArgs = { kind, title }

    if (between) {
      const a = resolveStep(g, between[1].trim())
      const b = resolveStep(g, between[2].trim())

      if (a && b) {
        args.on_edge = `${a.id}->${b.id}`
      }
    } else {
      const a = after ? resolveStep(g, after) : undefined
      const b = before ? resolveStep(g, before) : undefined

      if (a) {
        args.after = a.id
      }

      if (b) {
        args.before = b.id
      }

      if (!a && !b && names.length) {
        args.after = names[0]
      }
    }

    if (/\blint\b|\btypecheck\b/.test(t)) {
      args.goal = 'Run the linter and the type checker on the diff. Return PASS/FAIL with the failing rules.'
    }

    return [{ name: 'graph_add_step', args }]
  }

  // ---- config ------------------------------------------------------------
  const step = target()
  const patch = (p: ToolArgs): PlannedCall[] => call('graph_update_step', { step, patch: p })

  if (/\bblind\b/.test(t)) {
    return patch({ blind: !/\b(not|no longer|un)\s*blind\b|\bsighted\b/.test(t) })
  }

  const model = MODEL_OPTIONS.find(m => t.includes(m.toLowerCase()))

  if (model) {
    return patch({ model })
  }

  const profile = PROFILES.find(p => new RegExp(`\\b${p}\\b`).test(t))

  if (profile && /\bprofile\b|\bas the\b|\brun .* as\b/.test(t)) {
    return patch({ profile })
  }

  const takes = num(t, /(\d+)\s*(?:take|loop|attempt)/)

  if (takes != null) {
    const gate = stepNodes(g).find(n => (n.data as { def: { kind: string } }).def.kind === 'gate')

    return call('graph_update_step', { step: gate?.id ?? step, patch: { maxLoops: takes } })
  }

  // What the step does when it can't finish. Read before the retry count so
  // "retry on failure" sets the policy rather than being mined for a number it
  // doesn't have.
  const onFail = ON_FAIL_OPTIONS.find(o => new RegExp(`\\b${o.value}\\b`).test(t))?.value

  if (onFail && /\bfail(ure|s)?\b|\bon fail/.test(t)) {
    return patch({ onFail })
  }

  const retries = num(t, /(\d+)\s*retr/)

  if (retries != null) {
    return patch({ maxRetries: retries })
  }

  const iters = num(t, /(\d+)\s*(?:iteration|tool ?call)/)

  if (iters != null) {
    return patch({ maxIterations: iters })
  }

  // What a wait is holding out for. Read before the timeout rule, which would
  // otherwise swallow "wait 30 minutes" as a wall-clock cap on the step. check
  // asks every wait for this, so there has to be a way to say it.
  const until = readUntil(t)

  if (until) {
    return patch({ until })
  }

  const timeout = num(t, /(\d+)\s*(?:min|minute)/)

  if (timeout != null) {
    return patch({ timeoutMins: timeout })
  }

  return []
}

function kindOf(g: Graph, ref: string): StepKind | undefined {
  const node = resolveStep(g, ref)

  return node ? (node.data as { def: { kind: StepKind } }).def.kind : undefined
}

/** The three shapes a wait comes in, read off how it's said. Each is named by
 *  its own giveaway rather than by the word "wait", which is the kind and not
 *  the condition: "every 5m" is a poll however you introduce it. */
function readUntil(t: string): WaitUntil | null {
  const poll = t.match(/\bevery\s+(\d+\s*[smhd]\w*)/)

  if (poll) {
    return { type: 'poll', spec: `every ${tight(poll[1])}` }
  }

  // A dotted path is how every product names an external event.
  const event = t.match(/\b([a-z][\w-]*(?:\.[\w-]+){1,})\b/)

  if (event && !/\bpoll\b/.test(t)) {
    return { type: 'event', spec: event[1] }
  }

  const timer = t.match(/\b(?:for|after|wait)\s+(\d+\s*[smhd]\w*)/) ?? t.match(/\b(\d+\s*[smhd])\b/)

  if (timer) {
    return { type: 'timer', spec: tight(timer[1]) }
  }

  return null
}

/** "5 m" and "5 minutes" both mean 5m, and the spec reads better tight. */
function tight(s: string): string {
  const m = s.match(/(\d+)\s*([smhd])/)

  return m ? `${m[1]}${m[2]}` : s.replace(/\s+/g, '')
}
