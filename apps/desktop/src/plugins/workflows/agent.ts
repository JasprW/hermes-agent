// The composer's agent, faked.
//
// The ONE thing this file must get right is its output shape: it returns TOOL
// CALLS, never mutations. Everything it decides is expressed as
// `{ name: "graph_connect", args: {...} }` and handed to the same dispatcher a
// real model's tool calls would go through. That keeps the seam honest — the
// place a provider drops in is `interpret`, and nothing downstream of it
// knows or cares that today's planner is a pile of regexes.
//
// So: no setNodes here, no graph objects returned, no privileged knowledge of
// this particular scenario. It reads the live graph only to resolve names the
// way a model would after calling graph_get.

import { type Graph, resolveStep, stepNodes } from './graph'
import type { ToolArgs } from './graph-tools'
import { MODEL_OPTIONS, ON_FAIL_OPTIONS, PROFILES, type StepKind, type WaitUntil } from './scenario'

export interface PlannedCall {
  name: string
  args: ToolArgs
}

export interface Plan {
  calls: PlannedCall[]
  /** Said instead of running anything — used when nothing matched. */
  reply?: string
}

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

export function interpret(text: string, g: Graph): Plan {
  // Matching happens against the downcased sentence; names are read from the
  // original, so a step the author called "Legal Review" keeps its capitals.
  const raw = text.trim()
  const t = raw.toLowerCase()
  const call = (name: string, args: ToolArgs = {}): Plan => ({ calls: [{ name, args }] })
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

    return { calls: [{ name: 'graph_add_step', args }] }
  }

  // ---- config ------------------------------------------------------------
  const step = target()
  const patch = (p: ToolArgs): Plan => call('graph_update_step', { step, patch: p })

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

  return {
    calls: [],
    reply:
      'I can build it, run it, or change it — try “add a lint step between implement and gate”, ' +
      '“connect judge to ship”, “make the visual judge blind”, “allow 3 takes”, “check it”, or “run it”.'
  }
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
