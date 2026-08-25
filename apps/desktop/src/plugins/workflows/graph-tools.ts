// The scenario as a TOOL SURFACE.
//
// Everything an agent is allowed to do to a workflow, named and typed the way a
// model receives tools. The handlers are thin: each one validates its arguments
// and calls the corresponding primitive in graph.ts — the same primitive the
// inspector and the canvas call — so there is no privileged path. If a tool can
// do it, a person can do it by hand, and vice versa.
//
// `parameters` is JSON Schema because that is what every provider's tool-calling
// API takes. Nothing here reads it at runtime; it exists so this file can be
// handed to a model verbatim, and so the built-in planner and a real model are
// describing the same contract.

import {
  addArm,
  addStep,
  connect,
  disconnect,
  type Graph,
  type OpResult,
  removeArm,
  removeStep,
  renameStep,
  setBranch,
  setKind,
  setScenario,
  stepNodes,
  toScenario,
  updateStep,
  validate
} from './graph'
import {
  KIND_FIELDS,
  MODEL_OPTIONS,
  ON_FAIL_OPTIONS,
  type Predicate,
  PROFILES,
  type Scenario,
  STEP_KINDS,
  type StepConfig,
  type StepKind
} from './scenario'

export interface ToolDef {
  name: string
  description: string
  parameters: Record<string, unknown>
}

const stepRef = {
  type: 'string',
  description: "A step's id or its title — 'judge' and 'Visual Judge' both work."
}

const armRef = {
  type: 'string',
  description: "An output's id on the gate, e.g. 'pass', 'loop' or 'pass_2'."
}

const armName = {
  type: 'string',
  description: "Short output name, e.g. 'ship it' or 'rework'."
}

const kindRef = {
  type: 'string',
  enum: STEP_KINDS.map(k => k.kind),
  description: STEP_KINDS.map(k => `${k.kind} — ${k.blurb}`).join('; ')
}

const predicateSchema = {
  type: 'object',
  description:
    'When this arm out of a gate is taken. Presets cover the common shapes; ' +
    "'checks' is for checkable rules; 'prose' is read and ruled on by the gate agent itself.",
  properties: {
    mode: { type: 'string', enum: ['all-pass', 'any-fail', 'always', 'checks', 'prose'] },
    join: { type: 'string', enum: ['all', 'any'], description: 'checks only.' },
    checks: {
      type: 'array',
      description: 'checks only.',
      items: {
        type: 'object',
        properties: {
          step: stepRef,
          field: { type: 'string', enum: ['verdict', 'status'] },
          op: { type: 'string', enum: ['is', 'is not'] },
          value: { type: 'string' }
        },
        required: ['step', 'field', 'op', 'value']
      }
    },
    source: { type: 'string', description: 'prose only — what the gate should weigh.' }
  },
  required: ['mode']
} as const

const configSchema = {
  type: 'object',
  description: "Any subset of a step's config. Only the keys you send change.",
  properties: {
    title: { type: 'string' },
    goal: {
      type: 'string',
      description: "The task body — the agent's instruction, or the human's question."
    },
    profile: { type: 'string', enum: [...PROFILES], description: 'The specialist that runs it.' },
    model: { type: 'string', enum: [...MODEL_OPTIONS] },
    blind: {
      type: 'boolean',
      description: 'Withhold upstream output, so the step judges the artifact and not the reasoning.'
    },
    maxIterations: { type: 'integer', minimum: 1, maximum: 200 },
    maxRetries: { type: 'integer', minimum: 0, maximum: 10 },
    timeoutMins: { type: 'integer', minimum: 0, maximum: 180, description: '0 means no cap.' },
    onFail: { type: 'string', enum: ON_FAIL_OPTIONS.map(o => o.value) },
    maxLoops: { type: 'integer', minimum: 1, maximum: 20, description: 'Gate re-delegation cap.' },
    assignee: { type: 'string', description: 'Human steps: who the run parks on.' },
    until: {
      type: 'object',
      description: 'Wait steps: what the world has to do first.',
      properties: {
        type: { type: 'string', enum: ['timer', 'event', 'poll'] },
        spec: { type: 'string', description: "e.g. '24h', 'github.pull_request.merged', 'every 5m'." }
      },
      required: ['type', 'spec']
    }
  }
} as const

const KIND_ORDER = STEP_KINDS.map(k => k.kind)

export const GRAPH_TOOLS: ToolDef[] = [
  {
    name: 'graph_get',
    description:
      'Read the whole scenario — every step with its config, and every wire with its branch condition. Call this before editing so ids and current values are known.',
    parameters: { type: 'object', properties: {} }
  },
  {
    name: 'graph_add_step',
    description:
      'Add a step. Give it a place in the flow with exactly one of on_edge (splice into a wire), after, or before; omit all three to leave it unwired.',
    parameters: {
      type: 'object',
      properties: {
        kind: kindRef,
        title: { type: 'string' },
        goal: { type: 'string' },
        on_edge: { type: 'string', description: "Wire id, e.g. 'implement->review'." },
        after: stepRef,
        before: stepRef,
        config: configSchema
      },
      required: ['kind', 'title']
    }
  },
  {
    name: 'graph_update_step',
    // Spelled out from KIND_FIELDS rather than prose, so the tool can't promise
    // a knob the op will refuse. Every kind has different ones and a patch is
    // cut to the step's kind before it lands.
    description:
      "Change a step's config. Send only the keys you want changed. Which keys a step has depends on its kind — " +
      KIND_ORDER.map(k => `${k}: ${KIND_FIELDS[k].join(', ')}`).join('; ') +
      '. Anything else is refused.',
    parameters: {
      type: 'object',
      properties: { step: stepRef, patch: configSchema },
      required: ['step', 'patch']
    }
  },
  {
    name: 'graph_rename_step',
    description:
      "Change a step's id, rewriting every wire and gate rule that names it. The id is what conditions refer to, so prefer a readable one.",
    parameters: {
      type: 'object',
      properties: { step: stepRef, new_id: { type: 'string' } },
      required: ['step', 'new_id']
    }
  },
  {
    name: 'graph_set_kind',
    description:
      "Turn a step into a different kind, keeping its name, its instruction and its wiring. Config that only means something to the old kind is dropped; a gate's branch conditions do not survive being turned into anything else.",
    parameters: {
      type: 'object',
      properties: { step: stepRef, kind: kindRef },
      required: ['step', 'kind']
    }
  },
  {
    name: 'graph_remove_step',
    description:
      'Delete a step. Whatever fed it is wired to whatever it fed, so a chain shortens rather than breaking.',
    parameters: { type: 'object', properties: { step: stepRef }, required: ['step'] }
  },
  {
    name: 'graph_connect',
    description:
      'Wire one step into another. A wire that closes a cycle becomes a rework loop automatically. Out of a gate, pass `when` to say which verdicts take this arm.',
    parameters: {
      type: 'object',
      properties: { source: stepRef, target: stepRef, when: predicateSchema },
      required: ['source', 'target']
    }
  },
  {
    name: 'graph_disconnect',
    description: 'Cut the wire between two steps.',
    parameters: {
      type: 'object',
      properties: { source: stepRef, target: stepRef },
      required: ['source', 'target']
    }
  },
  {
    name: 'graph_add_arm',
    description:
      "Add an output to a gate. The output exists whether or not anything is wired to it, so you can lay out a whole routing table and then connect the arms. Outputs are taken in order, so add the catch-all ('always') last.",
    parameters: {
      type: 'object',
      properties: {
        gate: stepRef,
        when: predicateSchema,
        name: armName
      },
      required: ['gate']
    }
  },
  {
    name: 'graph_remove_arm',
    description: 'Drop an output from a gate, along with any wire leaving by it.',
    parameters: {
      type: 'object',
      properties: { gate: stepRef, arm: armRef },
      required: ['gate', 'arm']
    }
  },
  {
    name: 'graph_set_branch',
    description:
      "Set the condition on one of a gate's outputs, and/or name it. Naming is worth doing whenever the condition is longer than a few words — the name is what the canvas prints beside the port. Identify the output by its id, or by a step it routes to.",
    parameters: {
      type: 'object',
      properties: {
        gate: stepRef,
        arm: armRef,
        target: { type: 'string', description: 'Instead of `arm`: a step this output routes to.' },
        when: predicateSchema,
        name: armName
      },
      required: ['gate']
    }
  },
  {
    name: 'graph_set_scenario',
    description:
      "Replace the whole scenario with one you've authored. Use this to build a workflow from scratch; use the surgical tools to change an existing one. Steps without a position are laid out for you.",
    parameters: {
      type: 'object',
      properties: {
        scenario: {
          type: 'object',
          properties: {
            steps: {
              type: 'array',
              items: {
                type: 'object',
                properties: {
                  id: { type: 'string' },
                  kind: { type: 'string', enum: STEP_KINDS.map(k => k.kind) },
                  config: configSchema
                },
                required: ['id', 'kind', 'config']
              }
            },
            edges: {
              type: 'array',
              items: {
                type: 'object',
                properties: {
                  source: { type: 'string' },
                  target: { type: 'string' },
                  when: predicateSchema
                },
                required: ['source', 'target']
              }
            }
          },
          required: ['steps', 'edges']
        }
      },
      required: ['scenario']
    }
  },
  {
    name: 'graph_validate',
    description:
      "Check the scenario for unreachable steps, gates that don't branch, missing defaults and empty goals. Read-only.",
    parameters: { type: 'object', properties: {} }
  },
  {
    name: 'run_control',
    description: 'Drive the run: start it, pause at the next safe point, resume, or clear it.',
    parameters: {
      type: 'object',
      properties: { action: { type: 'string', enum: ['start', 'pause', 'resume', 'reset'] } },
      required: ['action']
    }
  }
]

// ---------------------------------------------------------------------------
// Dispatch
// ---------------------------------------------------------------------------

export type ToolArgs = Record<string, unknown>

/** Run control isn't a graph edit, so it can't return a graph. The player is
 *  handed in and these report back in the same shape as everything else. */
export interface RunControl {
  running: boolean
  paused: boolean
  start: () => void
  pause: () => void
  resume: () => void
  reset: () => void
}

const str = (a: ToolArgs, k: string) => (typeof a[k] === 'string' ? (a[k] as string) : undefined)

export function callTool(graph: Graph, run: RunControl, name: string, args: ToolArgs = {}): OpResult {
  const no = (m: string): OpResult => ({ ok: false, graph, message: m })

  switch (name) {
    case 'graph_get': {
      const s = toScenario(graph)

      return {
        ok: true,
        graph,
        message: `${s.steps.length} steps, ${s.edges.length} wires: ${s.steps.map(x => x.id).join(', ')}.`
      }
    }

    case 'graph_add_step': {
      const kind = str(args, 'kind')

      if (!kind) {
        return no('graph_add_step needs a kind.')
      }

      return addStep(graph, {
        kind: kind as StepKind,
        title: str(args, 'title'),
        goal: str(args, 'goal'),
        onEdge: str(args, 'on_edge'),
        after: str(args, 'after'),
        before: str(args, 'before'),
        config: args.config as Partial<StepConfig> | undefined
      })
    }

    case 'graph_update_step': {
      const step = str(args, 'step')

      if (!step) {
        return no('graph_update_step needs a step.')
      }

      return updateStep(graph, step, (args.patch as Partial<StepConfig>) ?? {})
    }

    case 'graph_rename_step': {
      const step = str(args, 'step')
      const next = str(args, 'new_id')

      if (!step || !next) {
        return no('graph_rename_step needs a step and a new_id.')
      }

      return renameStep(graph, step, next)
    }

    case 'graph_set_kind': {
      const step = str(args, 'step')
      const kind = str(args, 'kind')

      if (!step || !kind) {
        return no('graph_set_kind needs a step and a kind.')
      }

      return setKind(graph, step, kind as StepKind)
    }

    case 'graph_remove_step': {
      const step = str(args, 'step')

      if (!step) {
        return no('graph_remove_step needs a step.')
      }

      return removeStep(graph, step)
    }

    case 'graph_connect': {
      const source = str(args, 'source')
      const target = str(args, 'target')

      if (!source || !target) {
        return no('graph_connect needs a source and a target.')
      }

      return connect(graph, { source, target, when: args.when as Predicate | undefined })
    }

    case 'graph_disconnect': {
      const source = str(args, 'source')
      const target = str(args, 'target')

      if (!source) {
        return no('graph_disconnect needs a source.')
      }

      return disconnect(graph, source, target)
    }

    case 'graph_add_arm': {
      const gate = str(args, 'gate')

      if (!gate) {
        return no('graph_add_arm needs a gate.')
      }

      return addArm(graph, gate, args.when as Predicate | undefined, str(args, 'name'))
    }

    case 'graph_remove_arm': {
      const gate = str(args, 'gate')
      const arm = str(args, 'arm')

      if (!gate || !arm) {
        return no('graph_remove_arm needs a gate and an arm.')
      }

      return removeArm(graph, gate, arm)
    }

    case 'graph_set_branch': {
      const gate = str(args, 'gate') ?? str(args, 'source')
      const when = args.when as Predicate | undefined
      const label = str(args, 'name')

      if (!gate) {
        return no('graph_set_branch needs a gate.')
      }

      if (!when && label === undefined) {
        return no('graph_set_branch needs a condition or a name.')
      }

      // Addressable either way: by the output's own id, or by somewhere it
      // goes — which is how you'd say it out loud, and all an agent knows
      // before it has read the gate back.
      const target = str(args, 'target')
      const arm = str(args, 'arm') ?? graph.edges.find(e => e.source === gate && e.target === target)?.sourceHandle

      if (!arm) {
        return no(target ? `There's no wire from ${gate} to ${target}.` : 'graph_set_branch needs an arm or a target.')
      }

      return setBranch(graph, gate, arm, {
        ...(when ? { when } : {}),
        ...(label !== undefined ? { label } : {})
      })
    }

    case 'graph_set_scenario': {
      const scenario = args.scenario as Scenario | undefined

      if (!scenario) {
        return no('graph_set_scenario needs a scenario.')
      }

      return setScenario(graph, scenario)
    }

    case 'graph_validate': {
      const problems = validate(graph)

      return {
        ok: true,
        graph,
        message: problems.length
          ? problems.map(p => `${p.level === 'error' ? '✗' : '!'} ${p.message}`).join(' ')
          : `Looks sound — ${stepNodes(graph).length} steps, nothing unreachable.`
      }
    }

    case 'run_control': {
      switch (str(args, 'action')) {
        case 'start':
          run.start()

          return { ok: true, graph, message: 'Running it.' }

        case 'pause':
          if (!run.running) {
            return no('Nothing is running to pause.')
          }

          run.pause()

          return { ok: true, graph, message: 'Pausing when available.' }

        case 'resume':
          if (!run.paused) {
            return no('Nothing is paused.')
          }

          run.resume()

          return { ok: true, graph, message: 'Resumed.' }

        case 'reset':
          run.reset()

          return { ok: true, graph, message: 'Cleared the run. The scenario is untouched.' }

        default:
          return no('run_control takes start, pause, resume or reset.')
      }
    }

    default:
      return no(`There's no tool called ${name}. Available: ${GRAPH_TOOLS.map(t => t.name).join(', ')}.`)
  }
}
