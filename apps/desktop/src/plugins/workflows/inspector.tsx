/**
 * The step detail panel — n8n's step view, at a side panel's width.
 *
 * Two tabs, and the split between them is the point: Config is the step as
 * AUTHORED and is editable, Data is the step as RUN and is read-only. Which
 * controls Config offers is asked of the schema (`hasField`) rather than of
 * the kind, so a field that moves between kinds can't leave a stale editor
 * behind on the one it left.
 *
 * Every edit leaves here as a graph op, the same ones the canvas and the agent
 * call. The panel never reaches into node data itself.
 */

import {
  Callout,
  Codicon,
  Field,
  FieldHint,
  SidePanelAction,
  SidePanelBody,
  SidePanelClose,
  SidePanelHeader,
  SidePanelMeta,
  SidePanelMetaRow,
  SidePanelSection,
  TextTab
} from '@hermes/plugin-sdk'
import type { Node } from '@xyflow/react'
import { useEffect, useMemo, useState } from 'react'

import { Segmented, Select, Stepper, Switch } from './controls'
import {
  addArm,
  armsOf,
  armTargets,
  type Graph,
  type OpResult,
  removeArm,
  renameStep,
  setBranch,
  setKind,
  validate
} from './graph'
import { KindMark, kindMarkOf } from './kind-mark'
import type { NodeData } from './nodes'
import type { StepRuntime } from './protocol'
import {
  type Check,
  CHECK_FIELDS,
  CHECK_OPS,
  defaultPredicate,
  hasField,
  JOIN_OPTIONS,
  MODEL_OPTIONS,
  ON_FAIL_OPTIONS,
  type OnFail,
  type Predicate,
  PREDICATE_MODES,
  type PredicateMode,
  STEP_KINDS,
  type StepConfig,
  WAIT_KIND_OPTIONS,
  type WaitKind
} from './scenario'

// Matches the todo tool's injection markers (format_for_injection).
const TODO_MARK: Record<string, string> = {
  completed: '[x]',
  in_progress: '[>]',
  pending: '[ ]',
  cancelled: '[~]'
}

// ---------------------------------------------------------------------------
/** The step id, edited in place. Committed on blur or Enter rather than per
 *  keystroke, because a rename rewrites every wire and rule that names it —
 *  doing that mid-word would renumber the graph six times for one edit. */
function IdField({ id, onRename }: { id: string; onRename: (next: string) => OpResult }) {
  const [draft, setDraft] = useState(id)
  useEffect(() => setDraft(id), [id])

  const commit = () => {
    if (draft !== id && !onRename(draft).ok) {
      setDraft(id)
    }
  }

  return (
    <input
      className="ins-sub ins-id"
      onBlur={commit}
      onChange={e => setDraft(e.target.value)}
      onKeyDown={e => {
        if (e.key === 'Enter') {
          e.currentTarget.blur()
        }

        if (e.key === 'Escape') {
          setDraft(id)
        }
      }}
      spellCheck={false}
      title="The id conditions and hand-offs refer to."
      value={draft}
    />
  )
}

/** One comparison. n8n's filter row is `[left] [operator] [right]` on one line,
 *  but that's built for the NDV modal — at the inspector's width three controls
 *  in a row shrink to ellipses, which is what made this panel unreadable. Same
 *  parts, folded onto two lines: what to look at, then what it has to be. */
function ConditionRow({
  check,
  steps,
  onChange,
  onRemove
}: {
  check: Check
  steps: Node[]
  onChange: (next: Check) => void
  onRemove: () => void
}) {
  return (
    <div className="cond">
      <Select onChange={v => onChange({ ...check, step: v })} options={steps.map(n => n.id)} value={check.step} />
      <Select
        onChange={v => onChange({ ...check, field: v as Check['field'] })}
        options={CHECK_FIELDS}
        value={check.field}
      />
      <Select onChange={v => onChange({ ...check, op: v as Check['op'] })} options={CHECK_OPS} value={check.op} />
      <input
        className="inp"
        onChange={e => onChange({ ...check, value: e.target.value })}
        placeholder="PASS"
        value={check.value}
      />
      <button className="cond-cut" onClick={onRemove} title="Remove this condition">
        <Codicon name="close" size={10} />
      </button>
    </div>
  )
}

/** A gate's routing table IS its outgoing wires, so this edits the edges rather
 *  than some table that would then have to agree with them. Order is source
 *  order and first match wins, which is why the fallback arm reads last.
 *
 *  Shaped after n8n's Routing Rules: one block per arm, the destination named
 *  at its head, the condition underneath, and an "add condition" affordance
 *  inside the block rather than a toolbar somewhere else. */
function BranchEditor({ graph, gateId, onOp }: { graph: Graph; gateId: string; onOp: (op: OpResult) => OpResult }) {
  const arms = armsOf(graph, gateId)
  const steps = graph.nodes.filter(n => n.id !== gateId && !!(n.data as NodeData)?.def)
  const titleOf = (id: string) => (graph.nodes.find(n => n.id === id)?.data as NodeData)?.config.title ?? id

  return (
    <Field label="Routing rules">
      <FieldHint>Taken in order — the first rule that matches wins.</FieldHint>

      {arms.map(arm => {
        const when = arm.when
        const set = (when: Predicate) => onOp(setBranch(graph, gateId, arm.id, { when }))
        const goes = armTargets(graph, gateId, arm.id)

        return (
          <div className="rule" key={arm.id}>
            {/* n8n's Rename Output, promoted to the rule's title. The
                condition is the precise label for an arm and the useless one —
                it says what the arm tests, not what it's for — so the name
                leads, and it's the name the canvas prints.
                
                Unnamed, the title falls back to where the arm goes and the
                destination line drops: an arm has one identity, and printing
                it twice is what made this panel read as filler. */}
            <div className="rule-head">
              <input
                className="rule-name"
                onChange={ev => onOp(setBranch(graph, gateId, arm.id, { label: ev.target.value }))}
                placeholder={goes.map(e => titleOf(e.target)).join(', ') || 'Unnamed output'}
                title="What the canvas calls this output."
                value={arm.label ?? ''}
              />
              <button
                className="cond-cut"
                onClick={() => onOp(removeArm(graph, gateId, arm.id))}
                title="Remove this output"
              >
                <Codicon name="close" size={10} />
              </button>
            </div>
            {/* Where the arm goes — but only when the title above isn't
                already saying it. Unnamed, the title falls back to the
                destination, and printing it twice is what made this panel read
                as filler. Unwired there's no destination to fall back to, so
                the line carries the nudge instead: an arm without a target is
                the normal middle of authoring one, not an error. */}
            {(!goes.length || !!arm.label?.trim()) && (
              <div className={`rule-to${goes.length ? '' : ' is-open'}`}>
                {goes.length
                  ? `→ ${goes.map(e => titleOf(e.target)).join(', ')}`
                  : 'Not wired — drag this output on the canvas.'}
              </div>
            )}

            <Select
              onChange={m => set(defaultPredicate(m as PredicateMode))}
              options={PREDICATE_MODES.map(p => ({ value: p.value, label: p.label }))}
              title={PREDICATE_MODES.find(p => p.value === when.mode)?.hint}
              value={when.mode}
            />

            {when.mode === 'prose' && (
              <textarea
                className="inp ta"
                onChange={ev => set({ mode: 'prose', source: ev.target.value })}
                placeholder="What the gate should weigh before taking this arm…"
                rows={2}
                value={when.source}
              />
            )}

            {when.mode === 'checks' && (
              <>
                {when.checks.map((c, i) => (
                  <div className="cond-wrap" key={i}>
                    {/* The combinator sits BETWEEN conditions, the way n8n
                        stacks them — it belongs to the pair, not to a row. */}
                    {i > 0 && (
                      <div className="cond-join">
                        <Select
                          onChange={v => set({ ...when, join: v as 'all' | 'any' })}
                          options={JOIN_OPTIONS}
                          value={when.join}
                        />
                      </div>
                    )}
                    <ConditionRow
                      check={c}
                      onChange={next => set({ ...when, checks: when.checks.map((x, j) => (j === i ? next : x)) })}
                      onRemove={() => set({ ...when, checks: when.checks.filter((_, j) => j !== i) })}
                      steps={steps}
                    />
                  </div>
                ))}
                <button
                  className="rule-add"
                  onClick={() =>
                    set({
                      ...when,
                      checks: [...when.checks, { step: steps[0]?.id ?? '', field: 'verdict', op: 'is', value: 'PASS' }]
                    })
                  }
                >
                  <Codicon name="add" size={10} /> Add condition
                </button>
              </>
            )}
          </div>
        )
      })}

      <button className="rules-add" onClick={() => onOp(addArm(graph, gateId))}>
        <Codicon name="add" size={10} /> Add routing rule
      </button>
    </Field>
  )
}

// Inspector — n8n-style step detail view. Config tab is editable; Data tab
// shows the live run I/O + telemetry.
// ---------------------------------------------------------------------------
export function Inspector({
  node,
  rt,
  graph,
  onClose,
  onChange,
  onOp,
  onDelete
}: {
  node: Node
  rt: StepRuntime
  graph: Graph
  onClose: () => void
  onChange: (patch: Partial<StepConfig>) => void
  onOp: (op: OpResult) => OpResult
  onDelete: () => void
}) {
  const { def, config } = node.data as NodeData
  const [tab, setTab] = useState<'config' | 'data'>('config')

  // Which controls exist is the schema's answer, not the panel's. Every one of
  // these used to be an `isAgent &&`, which is the same question asked in a
  // place that couldn't be checked against the config it was editing.
  const has = (f: keyof StepConfig) => hasField(def.kind, f)
  const isGate = def.kind === 'gate'
  const isHuman = def.kind === 'human'
  const budgets = (['maxIterations', 'maxRetries', 'timeoutMins'] as const).some(has)
  const problems = useMemo(() => validate(graph).filter(p => p.step === def.id), [graph, def.id])

  return (
    <div className="ins">
      {/* Tighter than the panel default — this column is narrow, and a step's
          header is one row rather than the Kanban drawer's stacked title. */}
      <SidePanelHeader className="flex-row items-center gap-2 px-3 pt-3 pb-1.5">
        <KindMark kind={kindMarkOf(def)} />
        <div className="ins-headtext">
          <div className="ins-title">{config.title}</div>
          {/* The id is editable because it is not decoration: gate rules and
              `needs:` name a step by it, so a minted `step_2` has to be
              renameable to something a condition can be read against. */}
          <IdField id={def.id} onRename={next => onOp(renameStep(graph, def.id, next))} />
        </div>
        <SidePanelAction onClick={onDelete} title="Delete this step">
          <Codicon name="trash" size="0.8rem" />
        </SidePanelAction>
        <SidePanelClose onClick={onClose} />
      </SidePanelHeader>

      {/* The app's own tab treatment (TextTab): flat text, underline at 4px
          offset, no track or pill. This used to be a hand-rolled copy of it. */}
      <div className="flex flex-none gap-3 px-3 pb-1">
        <TextTab active={tab === 'config'} onClick={() => setTab('config')}>
          Config
        </TextTab>
        <TextTab active={tab === 'data'} onClick={() => setTab('data')}>
          Data
        </TextTab>
      </div>

      <SidePanelBody className="nodrag nowheel flex flex-col gap-4 px-3" fade>
        {tab === 'config' ? (
          <>
            {/* What `check` already knew about this step, said where you can
                  act on it. The whole list only ever reached the composer as a
                  tool result, so a half-wired gate looked fine until you ran
                  it. Same Callout the Kanban drawer shows a diagnostic in. */}
            {problems.map((p, i) => (
              <Callout
                icon={p.level === 'error' ? 'error' : 'warning'}
                key={i}
                title={p.message}
                tone={p.level === 'error' ? 'var(--destructive, #f87171)' : '#fbbf24'}
              />
            ))}

            {/* n8n's panel discipline: labels + controls, no prose. Guidance
                lives on hover (title=), so the panel is as tall as its knobs.
                The one hint that survives inline is the gate's routing rule —
                that's content, not help. */}
            <Field label="Name">
              <input className="inp" onChange={e => onChange({ title: e.target.value })} value={config.title} />
            </Field>

            {/* The kind was the one thing about a step you couldn't change
                after minting it, which made picking wrong at creation a
                delete-and-rewire. Four options, so they're all on show —
                which kind a step is decides what the rest of this panel even
                offers, and that's not a choice to hide behind a click. */}
            <Field label="Type" tip="What runs this step. Changing it keeps the name, the instruction and the wiring.">
              <Segmented
                onChange={k => onOp(setKind(graph, def.id, k))}
                options={STEP_KINDS.map(k => ({ value: k.kind, label: k.title }))}
                value={def.kind}
              />
            </Field>

            {/* Only the steps that DO something get a prose instruction. A
                wait's Waiting-on pair and a gate's routing rules are each that
                step's whole instruction already, and a prose field beside
                either one just invited a second description of it — free to
                drift from the one the run actually follows. */}
            {has('goal') && (
              <Field
                label={isHuman ? 'Ask' : 'Goal'}
                tip={
                  isHuman
                    ? "Shown when the run parks here. Your answer is this step's output."
                    : "Sent to delegate_task as the subagent's goal. The hand-off to the next step is templated from the scenario."
                }
              >
                <textarea
                  className="inp ta"
                  onChange={e => onChange({ goal: e.target.value })}
                  rows={3}
                  value={config.goal ?? ''}
                />
              </Field>
            )}

            {has('model') && (
              <Field label="Model" tip="Overrides the model for this step only.">
                <select className="inp" onChange={e => onChange({ model: e.target.value })} value={config.model ?? ''}>
                  <option value="">inherit</option>
                  {MODEL_OPTIONS.map(m => (
                    <option key={m} value={m}>
                      {m}
                    </option>
                  ))}
                </select>
              </Field>
            )}

            {budgets && (
              /* One row each — the stacked Stepper blocks spent 3× the
                   height saying min/max/step the tooltip can. A human gets
                   only the clock: you don't hand a person an iteration
                   budget, and you don't re-dispatch one either. */
              <SidePanelSection label="Budgets">
                <div className="fld-grid">
                  {has('maxIterations') && (
                    <Field label="Iterations" row tip="Tool-call budget before the subagent must stop.">
                      <Stepper
                        max={200}
                        min={1}
                        onChange={v => onChange({ maxIterations: v })}
                        step={5}
                        value={config.maxIterations ?? 20}
                      />
                    </Field>
                  )}
                  {has('maxRetries') && (
                    <Field label="Retries" row tip="Takes before the step reports failed.">
                      <Stepper
                        max={10}
                        min={0}
                        onChange={v => onChange({ maxRetries: v })}
                        value={config.maxRetries ?? 1}
                      />
                    </Field>
                  )}
                  {has('timeoutMins') && (
                    <Field
                      label="Timeout"
                      row
                      tip={
                        isHuman
                          ? 'How long the run parks here before nobody answering counts as a failure. ∞ = wait forever.'
                          : 'Wall-clock cap on a single take. ∞ = no cap.'
                      }
                    >
                      <Stepper
                        max={180}
                        min={0}
                        onChange={v => onChange({ timeoutMins: v })}
                        step={5}
                        suffix={(config.timeoutMins ?? 0) > 0 ? 'min' : undefined}
                        unboundedAtMin
                        value={config.timeoutMins ?? 0}
                      />
                    </Field>
                  )}
                </div>
              </SidePanelSection>
            )}

            {/* Workers only. On failure means "this step tried and couldn't",
                which needs a step that tries — a gate reads verdicts that
                already exist and a wait watches the clock; neither spends
                anything, so neither has an attempt to lose. On a gate the
                control was answering a question it doesn't have: what happens
                when nothing matches is the "Anything else" arm's job, and it's
                already flagged by check when there isn't one. */}
            {has('onFail') && (
              <Field
                label="On failure"
                tip={
                  isHuman
                    ? 'What the run does if nobody answers in time.'
                    : 'What the run does when this step exhausts its retries.'
                }
              >
                <Segmented
                  onChange={(v: OnFail) => onChange({ onFail: v })}
                  options={ON_FAIL_OPTIONS}
                  value={config.onFail ?? 'retry'}
                />
              </Field>
            )}

            {has('blind') && (
              <Switch
                checked={!!config.blind}
                onChange={v => onChange({ blind: v })}
                title="Blind to upstream output"
              />
            )}

            {has('arms') && <BranchEditor gateId={def.id} graph={graph} onOp={onOp} />}

            {has('assignee') && (
              <Field label="Assignee" tip="Who the run parks on. Empty means whoever is watching.">
                <input
                  className="inp"
                  onChange={e => onChange({ assignee: e.target.value })}
                  placeholder="anyone"
                  value={config.assignee ?? ''}
                />
              </Field>
            )}

            {has('until') && (
              <>
                <Field label="Waiting on" tip="What the world has to do before the run moves on.">
                  <Segmented
                    onChange={(v: WaitKind) => onChange({ until: { type: v, spec: config.until?.spec ?? '' } })}
                    options={WAIT_KIND_OPTIONS.map(o => ({ value: o.value, label: o.label }))}
                    value={config.until?.type ?? 'timer'}
                  />
                </Field>
                <Field
                  label="Condition"
                  tip={WAIT_KIND_OPTIONS.find(o => o.value === (config.until?.type ?? 'timer'))?.hint}
                >
                  <input
                    className="inp"
                    onChange={e =>
                      onChange({
                        until: { type: config.until?.type ?? 'timer', spec: e.target.value }
                      })
                    }
                    placeholder={
                      (config.until?.type ?? 'timer') === 'timer'
                        ? '24h'
                        : (config.until?.type ?? 'timer') === 'event'
                          ? 'github.pull_request.merged'
                          : 'every 5m'
                    }
                    value={config.until?.spec ?? ''}
                  />
                </Field>
              </>
            )}

            {has('maxLoops') && (
              <Field label="Max takes" tip="How many takes the gate may send back before giving up.">
                <Stepper max={20} min={1} onChange={v => onChange({ maxLoops: v })} value={config.maxLoops ?? 0} />
              </Field>
            )}
          </>
        ) : (
          <>
            {/* One meta line, the way the desktop's run ticker reports a turn —
                status · verdict · spend · take. The old "debrief" grid of four
                stat tiles was a dashboard; nothing in the GUI reports numbers
                as tiles. */}
            <div className="data-meta">
              <span className={`verdict-inline status-${rt.status}`}>
                {rt.status}
                {rt.verdict ? ` · ${rt.verdict}` : ''}
              </span>
              {rt.durationMs != null && <span>{(rt.durationMs / 1000).toFixed(1)}s</span>}
              {rt.tokens > 0 && <span>{rt.tokens >= 1000 ? `${(rt.tokens / 1000).toFixed(1)}k` : rt.tokens} tok</span>}
              {rt.maxIters > 0 && rt.iterations > 0 && (
                <span>
                  {rt.iterations}/{rt.maxIters} iters
                </span>
              )}
              {rt.take > 1 && <span>take {rt.take}</span>}
            </div>

            <SidePanelMeta>
              <SidePanelMetaRow label={isGate ? 'Children' : 'Input'}>{rt.input ?? '—'}</SidePanelMetaRow>
              <SidePanelMetaRow label={isGate ? 'Decision' : 'Summary'}>{rt.summary ?? '—'}</SidePanelMetaRow>
            </SidePanelMeta>

            {rt.output && (
              <SidePanelSection action={<Count n={Object.keys(rt.output).length} />} label="Output">
                <ul className="outlist">
                  {Object.entries(rt.output).map(([k, v]) => (
                    <li className="out-row" key={k}>
                      <span className="out-key">{k}</span>
                      <span className={`out-val${k === 'verdict' ? ` v-${String(v).toLowerCase()}` : ''}`}>
                        {renderFieldValue(v)}
                      </span>
                    </li>
                  ))}
                </ul>
              </SidePanelSection>
            )}

            {/* "Plan" is the todo tool's own word for this checklist, and it
                  stays scoped to the step. The scenario is the authored
                  artifact; a plan is what one agent wrote for itself. */}
            {rt.todos.length > 0 && (
              <SidePanelSection
                action={<Count n={`${rt.todos.filter(t => t.status === 'completed').length}/${rt.todos.length}`} />}
                label="Plan · todo tool"
              >
                <ul className="todolist">
                  {rt.todos.map(t => (
                    <li className={`todo-item st-${t.status}`} key={t.id}>
                      <span className="todo-mark">{TODO_MARK[t.status]}</span>
                      <span className="todo-text">{t.content}</span>
                    </li>
                  ))}
                </ul>
              </SidePanelSection>
            )}

            {rt.toolCalls.length > 0 && (
              <SidePanelSection action={<Count n={rt.toolCalls.length} />} label="Activity">
                <ul className="calllist">
                  {rt.toolCalls.map((c, i) => (
                    <li className="call-item" key={i}>
                      <span className="call-name">{c.name}</span>
                      {c.arg && <span className="call-arg">{c.arg}</span>}
                    </li>
                  ))}
                  {rt.currentTool && (rt.status === 'running' || rt.status === 'looping') && (
                    <li className="call-item live">
                      <span className="call-name">{rt.currentTool.name}</span>
                      {rt.currentTool.arg && <span className="call-arg">{rt.currentTool.arg}</span>}
                    </li>
                  )}
                </ul>
              </SidePanelSection>
            )}
          </>
        )}
      </SidePanelBody>
    </div>
  )
}

function renderFieldValue(v: unknown): React.ReactNode {
  if (Array.isArray(v)) {
    return v.length ? v.join(', ') : '[]'
  }

  if (v !== null && typeof v === 'object') {
    return (
      <span className="out-obj">
        {Object.entries(v as Record<string, unknown>).map(([k, val]) => (
          <span className="out-obj-row" key={k}>
            <span className="out-obj-k">{k}</span>
            {String(val)}
          </span>
        ))}
      </span>
    )
  }

  // A URL in structured output is an artifact you want to open, not a string
  // to select and paste. Same treatment as the card's link.
  if (typeof v === 'string' && /^https?:\/\//i.test(v)) {
    return (
      <a className="node-link" href={v} rel="noreferrer" target="_blank">
        {v}
      </a>
    )
  }

  return String(v)
}

/** The tally that rides a section label's right edge — how many fields, how
 *  many of the plan's steps are done. */
function Count({ n }: { n: number | string }) {
  return <span className="text-[0.62rem] tabular-nums text-(--ui-text-quaternary)">{n}</span>
}
