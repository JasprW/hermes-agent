import '@xyflow/react/dist/style.css'

import { Badge, cn, Codicon, composerDockCard, useTheme } from '@hermes/plugin-sdk'
import {
  Background,
  BackgroundVariant,
  type Connection,
  ControlButton,
  Controls,
  type Edge,
  type EdgeChange,
  MiniMap,
  type Node,
  type NodeChange,
  Panel,
  ReactFlow,
  ReactFlowProvider,
  useEdgesState,
  useNodesState,
  useReactFlow,
  useStore
} from '@xyflow/react'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'

import { type AddAt, addStep, AddStepProvider, KindPicker } from './add-step'
import { interpret } from './agent'
import { AskDialog } from './ask'
import { type AgentReply, Composer } from './composer'
// The node editor's shared controls. `Field` is aliased because this file
// already has a `Field` for the read-only Data tab rows.
import { Field as Fld, Segmented, Select, Stepper, Switch } from './controls'
import { CutEdgeProvider, edgeTypes } from './edges'
import {
  addArm,
  armsOf,
  armTargets,
  connect,
  disconnect,
  type Graph,
  type OpResult,
  removeArm,
  removeStep,
  renameStep,
  runPlan,
  setBranch,
  setKind,
  updateStep
} from './graph'
import { callTool, type RunControl } from './graph-tools'
import { KindMark, kindMarkOf } from './kind-mark'
import { tidyLayout } from './layout'
import { LiveLog } from './livelog'
import { type NodeData, nodeTypes } from './nodes'
import { usePlayer } from './player'
import { type EdgeState, feedLine, type FeedLine, freshRuntime, type StepRuntime } from './protocol'
import {
  type Check,
  CHECK_FIELDS,
  CHECK_OPS,
  defaultConfig,
  defaultPredicate,
  EDGE_DEFS,
  hasField,
  JOIN_OPTIONS,
  MODEL_OPTIONS,
  ON_FAIL_OPTIONS,
  type OnFail,
  type Predicate,
  PREDICATE_MODES,
  type PredicateMode,
  STEP_DEFS,
  STEP_KINDS,
  type StepConfig,
  type StepKind,
  WAIT_KIND_OPTIONS,
  type WaitKind
} from './scenario'
import { Timeline } from './timeline'
import { useUndoRedo } from './use-undo-redo'

// Steps the agent adds mid-session have no runtime in the event stream — they
// read as idle until the next run includes them.
const IDLE_RT: StepRuntime = freshRuntime()

// Keep the graph clear of the floating chrome that is ALWAYS there: the brand
// mark up top, the timeline + composer along the bottom, the live log's lane on
// the right. Panels that toggle (minimap, event log, inspector) are deliberately
// NOT reserved for — they float over the canvas and the graph stays put, because
// re-framing the whole graph every time you open a panel is worse than the
// overlap it avoids.
const FIT = {
  // The brand panel bottoms out at 66px (16px margin + 51px tall), so 56px
  // left the top rank grazing it.
  padding: { top: '78px', right: '150px', bottom: '208px', left: '40px' }
} as const

// Matches the todo tool's injection markers (format_for_injection).
const TODO_MARK: Record<string, string> = {
  completed: '[x]',
  in_progress: '[>]',
  pending: '[ ]',
  cancelled: '[~]'
}

function buildInitialNodes(): Node[] {
  const raw: Node[] = STEP_DEFS.map(def => ({
    id: def.id,
    type: def.kind,
    position: { x: 0, y: 0 }, // placeholder — Dagre owns the layout
    data: {
      def,
      config: defaultConfig(def),
      rt: freshRuntime(),
      selected: false
    } satisfies NodeData
  }))

  // Dagre is the single source of truth for arrangement (same fn as Tidy up).
  return tidyLayout(raw, buildInitialEdges())
}

function buildInitialEdges(): Edge[] {
  return EDGE_DEFS.map(e => ({
    id: e.id,
    source: e.source,
    target: e.target,
    sourceHandle: e.sourceHandle,
    targetHandle: e.targetHandle,
    type: 'data',
    data: { state: 'idle' as EdgeState, loop: e.loop }
  }))
}

// The floating panels are positioned independently by React Flow, so nothing
// stops them overlapping each other. Rather than hardcode offsets that rot the
// moment a panel changes size (the composer grows as you talk to it, the rail
// changes with its button count), measure the two anchors and publish them as
// CSS vars — the same trick chat uses to keep the thread clear of its composer.
function useChromeMetrics() {
  useEffect(() => {
    const root = document.documentElement

    const targets = new Map<string, string>([
      ['.run-panel', '--run-panel-h'],
      ['.react-flow__controls', '--rail-h']
    ])

    const obs = new ResizeObserver(entries => {
      for (const e of entries) {
        for (const [sel, cssVar] of targets) {
          if ((e.target as Element).matches(sel)) {
            root.style.setProperty(cssVar, `${Math.round(e.contentRect.height)}px`)
          }
        }
      }
    })

    // The rail and run panel mount with the canvas; re-query on each frame the
    // effect runs so a remounted panel is picked up.
    for (const sel of targets.keys()) {
      const el = document.querySelector(sel)

      if (el) {
        obs.observe(el)
      }
    }

    return () => obs.disconnect()
  }, [])
}

export default function WorkflowsPage() {
  return (
    <ReactFlowProvider>
      <Flow />
    </ReactFlowProvider>
  )
}

function Flow() {
  // React Flow paints its own chrome (background dots, controls, minimap) from
  // a light/dark switch of its own, so it needs the mode the host actually
  // resolved — 'system' would leave it guessing.
  const { resolvedMode } = useTheme()
  useChromeMetrics()
  // The run is built from whatever is on the canvas when you press play, so the
  // player reads the graph through a ref rather than taking it as a prop — it's
  // mounted above the node state, and re-arming it on every keystroke would
  // rebuild the timeline while you type.
  const graphRef = useRef<Graph>({ nodes: [], edges: [] })
  const planOf = useCallback(() => runPlan(graphRef.current, 'figma-to-pr'), [])
  const player = usePlayer(planOf)
  // Deferring hides the question without answering it — the run stays parked
  // and the run panel keeps the way back. Cleared whenever there's no question,
  // so a deferral can't outlive the run it belonged to.
  const [deferred, setDeferred] = useState(false)

  if (!player.asking && deferred) {
    setDeferred(false)
  }

  const { world, frozenAt, live } = player
  const { steps: runtime, edges: edgeState, phase } = world

  // The feed is part of the view, so it rewinds with the playhead.
  const lines = useMemo(() => {
    const out: FeedLine[] = []

    for (const e of player.events.slice(0, player.head)) {
      const line = feedLine(e)

      if (line) {
        out.push(line)
      }
    }

    return out
  }, [player.events, player.head])

  // useNodesState takes a value, not a lazy initializer, so an inline
  // buildInitialNodes() call would re-run a full Dagre layout on every render
  // of this component and throw the result away — React only keeps the first.
  const [nodes, setNodes, onNodesChange] = useNodesState(useMemo(buildInitialNodes, []))
  const [edges, setEdges, onEdgesChange] = useEdgesState(useMemo(buildInitialEdges, []))
  const [selected, setSelected] = useState<string | null>(null)
  const [draft, setDraft] = useState<AddAt | null>(null)
  const [logOpen, setLogOpen] = useState(false)
  const [mapOpen, setMapOpen] = useState(false)
  const feedRef = useRef<HTMLDivElement>(null)
  // The + lives on the edge; adding a step unmounts that edge under the
  // pointer, so the mouseup lands on the pane and would clear the selection
  // we just made. Swallow the next pane click after an add.
  const ignorePaneClick = useRef(false)
  const { fitView, screenToFlowPosition } = useReactFlow()

  // Undo/redo are keyboard-only (⌘Z / ⌘⇧Z, bound inside the hook) — the canvas
  // takes the snapshots, the rail doesn't need buttons for them.
  const { takeSnapshot } = useUndoRedo({
    nodes,
    edges,
    setNodes,
    setEdges
  })

  // Snapshot before structural mutations so cmd/ctrl+z reverts them. Drags
  // snapshot on drag-start (one entry per drag); deletions snapshot the
  // pre-remove graph the moment a "remove" change arrives.
  const handleNodesChange = useCallback(
    (changes: NodeChange[]) => {
      if (changes.some(c => c.type === 'remove')) {
        takeSnapshot()
      }

      onNodesChange(changes)
    },
    [onNodesChange, takeSnapshot]
  )

  const handleEdgesChange = useCallback(
    (changes: EdgeChange[]) => {
      if (changes.some(c => c.type === 'remove')) {
        takeSnapshot()
      }

      onEdgesChange(changes)
    },
    [onEdgesChange, takeSnapshot]
  )

  // Two frames: the first lets React commit the new nodes, the second lets
  // React Flow measure them. Fitting on one frame uses fallback sizes and
  // leaves freshly added nodes tucked under the composer.
  const refit = useCallback(() => {
    window.requestAnimationFrame(() => window.requestAnimationFrame(() => fitView({ ...FIT, duration: 400 })))
  }, [fitView])

  const tidy = useCallback(() => {
    takeSnapshot()
    setNodes(ns => tidyLayout(ns, edges))
    refit()
  }, [edges, refit, setNodes, takeSnapshot])

  // On-load layout only. buildInitialNodes() lays out against the fallback
  // constants in layout.ts, which don't match the real cards, so the first
  // paint is approximate — this re-tidies ONCE, the moment React Flow has
  // measured every card, so what you SEE on load is already tidy.
  //
  // The trigger is the measurement itself, not useNodesInitialized: the
  // signature changes the moment real dimensions land, which is precisely the
  // instant a correct layout is possible.
  //
  // After that, positions belong to the user. Adding, splicing, and deleting
  // all place or nudge locally (see add-step.tsx / removeNode) — the only
  // global re-layout left is the explicit Tidy button.
  const didAutoTidy = useRef(false)
  const measuredSig = nodes.map(n => `${n.id}:${n.measured?.width ?? 0}x${n.measured?.height ?? 0}`).join()
  const allMeasured = nodes.length > 0 && nodes.every(n => n.measured?.width && n.measured?.height)

  // eslint-disable-next-line no-restricted-syntax -- `didAutoTidy` is a one-shot latch, not a mirrored atom.
  useEffect(() => {
    if (!allMeasured || didAutoTidy.current) {
      return
    }

    didAutoTidy.current = true
    setNodes(ns => tidyLayout(ns, edges))
    refit()
    // measuredSig is the real dependency — it changes when a card's measured
    // size lands. eslint can't see that it stands in for `nodes`.
  }, [allMeasured, measuredSig, edges, refit, setNodes])

  // sync run state -> node.data (preserves dragged positions + edited config).
  //
  // A card that hasn't moved keeps its exact node object. React Flow re-renders
  // a node when its data changes, so spreading a new `data` onto all of them
  // every event meant one step starting re-rendered the entire graph.
  useEffect(() => {
    setNodes(ns => {
      let dirty = false

      const next = ns.map(n => {
        const d = n.data as Partial<NodeData>
        const sel = n.id === selected
        const rt = runtime[n.id] ?? IDLE_RT

        if (d.rt === rt && d.frozenAt === frozenAt && d.selected === sel) {
          return n
        }

        dirty = true

        return { ...n, data: { ...n.data, rt, frozenAt, selected: sel } }
      })

      return dirty ? next : ns
    })
  }, [frozenAt, runtime, selected, setNodes])

  useEffect(() => {
    setEdges(es => {
      let dirty = false

      const next = es.map(e => {
        const state = edgeState[e.id] as EdgeState

        if ((e.data as { state?: EdgeState })?.state === state) {
          return e
        }

        dirty = true

        return { ...e, data: { ...e.data, state } }
      })

      return dirty ? next : es
    })
  }, [edgeState, setEdges])

  useEffect(() => {
    if (live) {
      feedRef.current?.scrollTo({ top: feedRef.current.scrollHeight })
    }
  }, [lines, live])

  const updateConfig = (id: string, patch: Partial<StepConfig>) => {
    takeSnapshot()
    const op = updateStep({ nodes, edges }, id, patch)

    if (op.ok) {
      setNodes(op.graph.nodes)
    }
  }

  // Click + / double-click only names WHERE. The picker names WHAT — otherwise
  // the seed's gate/human/wait can never be minted, only edited.
  const requestAdd = useCallback((where: AddAt) => {
    ignorePaneClick.current = true
    setDraft(where)
    window.setTimeout(() => {
      ignorePaneClick.current = false
    }, 80)
  }, [])

  const confirmAdd = useCallback(
    (kind: StepKind) => {
      if (!draft) {
        return
      }

      const next = addStep(nodes, edges, draft, kind)
      setDraft(null)

      if (!next.id) {
        return
      }

      takeSnapshot()
      setNodes(next.nodes)
      setEdges(next.edges)
      ignorePaneClick.current = true
      setSelected(next.id)
      window.setTimeout(() => {
        ignorePaneClick.current = false
      }, 80)
    },
    [draft, edges, nodes, setEdges, setNodes, takeSnapshot]
  )

  // ONE commit path for every structural edit — the connect gesture, a delete,
  // the inspector, and every tool the composer's agent calls. Undo, selection
  // and the transcript all hang off this, so nothing can mutate the document
  // and leave one of the three behind.
  const graph = useMemo<Graph>(() => ({ nodes, edges }), [nodes, edges])
  graphRef.current = graph

  const applyOp = useCallback(
    (op: OpResult) => {
      if (!op.ok) {
        return op
      }

      takeSnapshot()
      setNodes(op.graph.nodes)
      setEdges(op.graph.edges)

      if (op.focus) {
        setSelected(op.focus)
      }

      return op
    },
    [setEdges, setNodes, takeSnapshot]
  )

  // Drawing a wire. The gesture had no handler at all before, which meant a
  // deleted connector could never be put back and two existing steps could
  // never be joined — the one hole that stopped this being a real editor.
  const onConnect = useCallback(
    (c: Connection) => {
      if (aborted.current) {
        return
      }

      applyOp(
        connect(graph, {
          source: c.source,
          target: c.target,
          sourceHandle: c.sourceHandle ?? undefined,
          targetHandle: c.targetHandle ?? undefined
        })
      )
    },
    [applyOp, graph]
  )

  // Refuse the connection during the drag rather than after the drop, so the
  // wire never snaps into place and then vanishes.
  const isValidConnection = useCallback(
    (c: Connection | Edge) =>
      !!c.source &&
      !!c.target &&
      c.source !== c.target &&
      !edges.some(e => e.source === c.source && e.target === c.target),
    [edges]
  )

  // Dragging a live endpoint onto another port re-routes rather than forcing a
  // cut-then-draw; dragging it into empty canvas cuts the wire.
  //
  // React Flow only tells you a reconnect LANDED. Dropping on nothing fires
  // nothing at all, so the wire silently springs back and the obvious way to
  // unplug something does nothing. The flag is the documented way to tell the
  // two endings apart: onReconnect marks it handled, and whatever reaches
  // onReconnectEnd unmarked was dropped in space.
  const landed = useRef(true)

  const onReconnectStart = useCallback(() => {
    landed.current = false
  }, [])

  const onReconnect = useCallback(
    (old: Edge, c: Connection) => {
      landed.current = true

      if (aborted.current) {
        return
      }

      const cut = disconnect(graph, old.id)

      if (!cut.ok) {
        return
      }

      applyOp(
        connect(cut.graph, {
          source: c.source,
          target: c.target,
          sourceHandle: c.sourceHandle ?? undefined,
          targetHandle: c.targetHandle ?? undefined
        })
      )
    },
    [applyOp, graph]
  )

  const onReconnectEnd = useCallback(
    (_: unknown, edge: Edge) => {
      if (!landed.current) {
        applyOp(disconnect(graph, edge.id))
      }

      landed.current = true
    },
    [applyOp, graph]
  )

  // Escape drops the wire you're dragging. React Flow has no abort — the drag
  // only ends on pointerup — so we fake the pointerup and flag the drop as one
  // to ignore. Both flags matter: `aborted` stops a wire being drawn when you
  // happen to be over a valid port, and `landed` stops a reconnect being read
  // as dropped-in-space, which would cut the wire you were trying to keep.
  const aborted = useRef(false)
  const connecting = useStore(s => s.connection.inProgress)

  const onConnectStart = useCallback(() => {
    aborted.current = false
  }, [])

  const onConnectEnd = useCallback(() => {
    aborted.current = false
  }, [])

  // eslint-disable-next-line no-restricted-syntax -- the ref writes are inside the key handler, not a mirror of `connecting`.
  useEffect(() => {
    if (!connecting) {
      return
    }

    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') {
        return
      }

      e.preventDefault()
      e.stopPropagation()
      aborted.current = true
      landed.current = true
      document.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }))
    }

    // Capture, so the drag dies before anything else reads the same Escape.
    window.addEventListener('keydown', onKey, true)

    return () => window.removeEventListener('keydown', onKey, true)
  }, [connecting])

  // Deleting goes through the same primitive as the tools, so the keyboard and
  // an agent heal the flow identically. Returning false stops React Flow from
  // also removing what we've already removed.
  const onBeforeDelete = useCallback(
    async ({ nodes: dropNodes, edges: dropEdges }: { nodes: Node[]; edges: Edge[] }) => {
      if (!dropNodes.length) {
        return true
      }

      let next: Graph = graph

      for (const n of dropNodes) {
        const op = removeStep(next, n.id)

        if (op.ok) {
          next = op.graph
        }
      }

      if (dropEdges.length) {
        next = {
          ...next,
          edges: next.edges.filter(e => !dropEdges.some(d => d.id === e.id))
        }
      }

      applyOp({ ok: true, graph: next, message: '' })

      return false
    },
    [applyOp, graph]
  )

  const cutEdge = useCallback((id: string) => applyOp(disconnect(graph, id)), [applyOp, graph])

  const removeNode = useCallback((id: string) => applyOp(removeStep(graph, id)), [applyOp, graph])

  // The composer's agent. `interpret` plans TOOL CALLS and `callTool` runs them
  // against the same primitives the inspector and the canvas use — so a real
  // model drops in by replacing the planner, and nothing about how an edit
  // lands has to change. The transcript reports whatever the tools reported.
  const handleAgentTurn = useCallback(
    (text: string): AgentReply => {
      const plan = interpret(text, graph)

      if (!plan.calls.length) {
        return { reply: plan.reply ?? "I didn't follow that." }
      }

      const runControl: RunControl = {
        running: player.running,
        paused: player.pauseState === 'paused',
        start: player.start,
        pause: player.requestPause,
        resume: player.resume,
        reset: player.reset
      }

      let next = graph
      const said: string[] = []
      const edits: string[] = []
      let moved = false
      let focus: string | undefined

      for (const c of plan.calls) {
        const op = callTool(next, runControl, c.name, c.args)
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

        if (op.graph !== next) {
          next = op.graph
          moved = true
        }
      }

      if (moved) {
        applyOp({ ok: true, graph: next, message: '', focus })
      }

      return { reply: said.join(' '), edit: edits.join(', ') || undefined }
    },
    [applyOp, graph, player]
  )

  // Add a step where you point. The canvas route is ComfyUI's gesture —
  // double-click empty canvas — not a Space-armed placement mode: a mode you
  // can be in is a mode you can be stuck in, and Space is already the
  // transport key.
  const placeAt = useCallback(
    (e: { clientX: number; clientY: number }) => {
      requestAdd({
        on: 'canvas',
        at: screenToFlowPosition({ x: e.clientX, y: e.clientY })
      })
    },
    [requestAdd, screenToFlowPosition]
  )

  const transport = useCallback(() => {
    if (!player.running) {
      player.start()
    } else if (player.pauseState === 'none') {
      player.requestPause()
    } else if (player.pauseState === 'paused') {
      player.resume()
    }
    // "pausing": the request is already in flight — the key waits with you.
  }, [player])

  // Space → run / pause / resume. K still does the same. Cmd/Ctrl+Shift+L
  // tidies. Camera is scroll/pinch + the tidy/fit button — Space is a verb.
  // (Undo/redo keys live in useUndoRedo.)
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.shiftKey && e.key.toLowerCase() === 'l') {
        e.preventDefault()
        tidy()

        return
      }

      if (e.metaKey || e.ctrlKey || e.altKey) {
        return
      }

      const t = e.target as HTMLElement | null

      if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT' || t.isContentEditable)) {
        return
      }

      if (e.code === 'Space' || e.key.toLowerCase() === 'k') {
        e.preventDefault()
        transport()
      }
    }

    window.addEventListener('keydown', onKey)

    return () => window.removeEventListener('keydown', onKey)
  }, [tidy, transport])

  const selNode = useMemo(() => (selected ? nodes.find(n => n.id === selected) : null), [nodes, selected])

  // The live log names steps the way their cards do, renames included.
  const nodeTitles = useMemo(() => {
    const out: Record<string, string> = {}

    for (const n of nodes) {
      const cfg = (n.data as NodeData).config

      if (cfg) {
        out[n.id] = cfg.title
      }
    }

    return out
  }, [nodes])

  const askTitle = player.asking ? (nodeTitles[player.asking.nodeId] ?? player.asking.nodeId) : ''

  return (
    <div className="wf-root">
      {/* A real header row rather than a panel floating over the graph: the
          scenario's name is chrome, and floating it on top of the canvas made
          it read as another node. Same row the Kanban plugin's board wears, so
          two plugin pages read as siblings. Theme and mode are the host's —
          they live in Settings, not on this page. */}
      <header className="flex shrink-0 flex-wrap items-center gap-2 px-4 py-2">
        <h1 className="text-sm font-semibold text-foreground">Workflows</h1>
        <Badge variant="muted">figma → code → review → PR</Badge>
      </header>

      <div
        className="canvas-wrap"
        /* ComfyUI's add gesture: double-click on EMPTY canvas opens the kind
           picker under the cursor. Caught here because React Flow exposes no
           pane double-click prop — the target check keeps double-clicks on
           cards, wires and panels meaning whatever those things say they mean. */
        onDoubleClick={e => {
          if ((e.target as HTMLElement).classList.contains('react-flow__pane')) {
            placeAt(e)
          }
        }}
      >
        <AddStepProvider value={requestAdd}>
          <CutEdgeProvider value={cutEdge}>
            <ReactFlow
              colorMode={resolvedMode}
              /* n8n's `connection-radius`, triple React Flow's default 20. A 9px
           socket you have to hit dead-on is why dropping a wire felt like
           threading a needle; at 60 the socket comes to meet you, and the
           connectingto highlight tells you it has. */
              connectionRadius={60}
              deleteKeyCode={['Backspace', 'Delete']}
              edges={edges}
              edgeTypes={edgeTypes}
              elevateNodesOnSelect
              fitView
              fitViewOptions={FIT}
              isValidConnection={isValidConnection}
              maxZoom={1.75}
              minZoom={0.35}
              multiSelectionKeyCode={['Meta', 'Control']}
              /* React Flow defaults nodeClickDistance to 0, which forwards to d3's
           .clickDistance(0): the click is swallowed if the pointer moves even
           one pixel between press and release. A trackpad almost always drifts
           a pixel or two, so selecting a node silently failed and you'd click
           again — the "dead zone". A few pixels of slack is what every native
           control allows. paneClickDistance gets the same treatment so
           deselecting doesn't have the identical problem. */
              nodeClickDistance={4}
              /* A node's y is its CENTRE, not its top edge. React Flow renders at
           `position.y - height * origin[1]`, so a card that grows takes half
           the new height off its top and half off its bottom instead of
           unrolling downward from a pinned corner.
           
           That matters because the handles sit at 50% and the cards in a rank
           are centre-aligned: growing downward walked every handle down with
           the card, so the whole graph's wiring sagged and re-settled each time
           a step produced a line. With the centre fixed, a card can change
           height without a single edge moving.
           
           Done with the library's own origin rather than a compensating
           transform on the card: origin feeds `positionAbsolute`, so bounds,
           fitView, hit-testing and edge geometry all agree. A CSS transform
           would move the paint and leave React Flow's model behind it. */
              nodeOrigin={[0, 0.5]}
              nodes={nodes}
              nodesDraggable
              nodeTypes={nodeTypes}
              onBeforeDelete={onBeforeDelete}
              onConnect={onConnect}
              onConnectEnd={onConnectEnd}
              onConnectStart={onConnectStart}
              onEdgesChange={handleEdgesChange}
              onNodeClick={(_, n) => setSelected(n.id)}
              onNodeDragStart={() => takeSnapshot()}
              onNodesChange={handleNodesChange}
              onPaneClick={() => {
                if (ignorePaneClick.current) {
                  ignorePaneClick.current = false

                  return
                }

                if (draft) {
                  setDraft(null)

                  return
                }

                setSelected(null)
              }}
              onReconnect={onReconnect}
              onReconnectEnd={onReconnectEnd}
              onReconnectStart={onReconnectStart}
              onSelectionDragStart={() => takeSnapshot()}
              panActivationKeyCode={null}
              paneClickDistance={4}
              proOptions={{ hideAttribution: true }}
              /* Default 10px puts the grab ring almost entirely under the node's own
           handle, so the gesture that unplugs a wire was reachable only in a
           couple of pixels of fringe. Matched to the edge's hit stroke. */
              reconnectRadius={22}
              selectionKeyCode="Shift"
              zoomActivationKeyCode={['Meta', 'Control']}
              /* Double-click on empty canvas adds a step there — see the wrapper's
           onDoubleClick; React Flow has no pane double-click prop. Its default
           spend of the gesture (zoom) is turned off to make room. */
              zoomOnDoubleClick={false}
            >
              <Background gap={20} size={1.3} variant={BackgroundVariant.Dots} />

              <LiveLog hidden={logOpen} lines={lines} titles={nodeTitles} />

              {selNode && (
                <Panel className="inspector" position="top-right">
                  <Inspector
                    graph={graph}
                    node={selNode}
                    onChange={patch => updateConfig(selNode.id, patch)}
                    onClose={() => setSelected(null)}
                    onDelete={() => {
                      setSelected(null)
                      removeNode(selNode.id)
                    }}
                    onOp={applyOp}
                    rt={runtime[selNode.id]}
                  />
                </Panel>
              )}

              {/* The app's composer dock, borrowed whole: a card fused to the top of
            the capsule (the chat's status stack is the same shape) carrying the
            transport, and the composer itself below it. Same fill, same glass,
            same seam — this reads as the app's input, because it is. */}
              <Panel className="run-panel" position="bottom-center">
                {player.asking && deferred && (
                  <button className="ask-back" onClick={() => setDeferred(false)}>
                    <Codicon name="bell" />
                    {askTitle} is waiting on you
                  </button>
                )}
                <div
                  className={cn(composerDockCard('top'), 'mx-2 overflow-hidden rounded-b-none border-b-transparent')}
                >
                  <Timeline p={player} />
                </div>
                <Composer onSend={handleAgentTurn} phase={live ? phase : 'running'} />
              </Panel>

              {player.asking && (
                <AskDialog
                  {...player.asking}
                  onDefer={() => setDeferred(true)}
                  onRespond={d => {
                    setDeferred(false)
                    player.respond(d)
                  }}
                  open={!deferred}
                  title={askTitle}
                />
              )}

              {logOpen && (
                <Panel className="glass log-panel pop" position="bottom-right">
                  <div className="feed-head">
                    <span className="feed-title">{player.live ? 'events' : 'replay'}</span>
                    <span className="feed-count">
                      {player.head}
                      {player.live ? '' : ` / ${player.events.length}`}
                    </span>
                    <button className="feed-x" onClick={() => setLogOpen(false)} title="Hide">
                      ×
                    </button>
                  </div>
                  <div className="feed" ref={feedRef}>
                    {lines.length === 0 && <div className="feed-empty">nothing yet — ask Hermes to run it…</div>}
                    {lines.map((l, i) => (
                      <FeedRow key={i} l={l} />
                    ))}
                  </div>
                </Panel>
              )}

              {mapOpen && (
                <MiniMap
                  className="pop"
                  nodeBorderRadius={8}
                  nodeClassName={n => `st-${(n.data as NodeData).rt?.status ?? 'idle'}`}
                  nodeStrokeWidth={2}
                  pannable
                  position="bottom-left"
                  style={{ width: 184, height: 122 }}
                  zoomable
                />
              )}
              {/* Zoom is scroll/pinch and undo is ⌘Z, so neither needs a button. What's
            left is the three things with no gesture: arrange the graph, and the
            two panels that toggle. */}
              <Controls
                orientation="horizontal"
                position="bottom-left"
                showFitView={false}
                showInteractive={false}
                showZoom={false}
              >
                <ControlButton onClick={tidy} title="Tidy up & fit (⌘⇧L)">
                  <Codicon name="layout" />
                </ControlButton>
                <ControlButton
                  className={mapOpen ? 'active' : ''}
                  onClick={() => setMapOpen(o => !o)}
                  title={mapOpen ? 'Hide minimap' : 'Show minimap'}
                >
                  <Codicon name="map" />
                </ControlButton>
                <ControlButton
                  className={logOpen ? 'active' : ''}
                  onClick={() => setLogOpen(o => !o)}
                  title={logOpen ? 'Hide event log' : 'Show event log'}
                >
                  <Codicon name="output" />
                </ControlButton>
              </Controls>
            </ReactFlow>
          </CutEdgeProvider>
        </AddStepProvider>
      </div>
      {draft && <KindPicker at={draft.at} onClose={() => setDraft(null)} onPick={confirmAdd} />}
    </div>
  )
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
    <div className="fld">
      <span className="fld-label">Routing rules</span>
      <span className="fld-hint">Taken in order — the first rule that matches wins.</span>

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
    </div>
  )
}

// Inspector — n8n-style step detail view. Config tab is editable; Data tab
// shows the live run I/O + telemetry.
// ---------------------------------------------------------------------------
function Inspector({
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

  // Edge fades: only show a fade where content is actually clipped.
  const scrollRef = useRef<HTMLDivElement>(null)
  const [fade, setFade] = useState({ top: false, bottom: false })

  const onScroll = useCallback(() => {
    const el = scrollRef.current

    if (!el) {
      return
    }

    const top = el.scrollTop > 2
    const bottom = el.scrollTop + el.clientHeight < el.scrollHeight - 2
    setFade(f => (f.top === top && f.bottom === bottom ? f : { top, bottom }))
  }, [])

  useEffect(() => {
    onScroll()
  }, [tab, node.id, rt, onScroll])

  // Which controls exist is the schema's answer, not the panel's. Every one of
  // these used to be an `isAgent &&`, which is the same question asked in a
  // place that couldn't be checked against the config it was editing.
  const has = (f: keyof StepConfig) => hasField(def.kind, f)
  const isGate = def.kind === 'gate'
  const isHuman = def.kind === 'human'
  const budgets = (['maxIterations', 'maxRetries', 'timeoutMins'] as const).some(has)

  return (
    <div className="ins">
      <div className="ins-head">
        <KindMark kind={kindMarkOf(def)} />
        <div className="ins-headtext">
          <div className="ins-title">{config.title}</div>
          {/* The id is editable because it is not decoration: gate rules and
              `needs:` name a step by it, so a minted `step_2` has to be
              renameable to something a condition can be read against. */}
          <IdField id={def.id} onRename={next => onOp(renameStep(graph, def.id, next))} />
        </div>
        <button className="ins-close" onClick={onDelete} title="Delete this step">
          <Codicon name="trash" size={13} />
        </button>
        <button className="ins-close" onClick={onClose}>
          ×
        </button>
      </div>

      <div className="ins-tabs">
        <button className={tab === 'config' ? 'on' : ''} onClick={() => setTab('config')}>
          Config
        </button>
        <button className={tab === 'data' ? 'on' : ''} onClick={() => setTab('data')}>
          Data
        </button>
      </div>

      <div className="ins-body nodrag">
        <div
          className={`ins-scroll nowheel${fade.top ? ' fade-top' : ''}${fade.bottom ? ' fade-bottom' : ''}`}
          onScroll={onScroll}
          ref={scrollRef}
        >
          {tab === 'config' ? (
            <>
              {/* n8n's panel discipline: labels + controls, no prose. Guidance
                lives on hover (title=), so the panel is as tall as its knobs.
                The one hint that survives inline is the gate's routing rule —
                that's content, not help. */}
              <label className="fld">
                <span className="fld-label">Name</span>
                <input className="inp" onChange={e => onChange({ title: e.target.value })} value={config.title} />
              </label>

              {/* The kind was the one thing about a step you couldn't change
                after minting it, which made picking wrong at creation a
                delete-and-rewire. Four options, so they're all on show —
                which kind a step is decides what the rest of this panel even
                offers, and that's not a choice to hide behind a click. */}
              <Fld label="Type" tip="What runs this step. Changing it keeps the name, the instruction and the wiring.">
                <Segmented
                  onChange={k => onOp(setKind(graph, def.id, k))}
                  options={STEP_KINDS.map(k => ({ value: k.kind, label: k.title }))}
                  value={def.kind}
                />
              </Fld>

              {/* Only the steps that DO something get a prose instruction. A
                wait's Waiting-on pair and a gate's routing rules are each that
                step's whole instruction already, and a prose field beside
                either one just invited a second description of it — free to
                drift from the one the run actually follows. */}
              {has('goal') && (
                <label
                  className="fld"
                  title={
                    isHuman
                      ? "Shown when the run parks here. Your answer is this step's output."
                      : "Sent to delegate_task as the subagent's goal. The hand-off to the next step is templated from the scenario."
                  }
                >
                  <span className="fld-label">{isHuman ? 'Ask' : 'Goal'}</span>
                  <textarea
                    className="inp ta"
                    onChange={e => onChange({ goal: e.target.value })}
                    rows={3}
                    value={config.goal ?? ''}
                  />
                </label>
              )}

              {has('model') && (
                <label className="fld" title="Overrides the model for this step only.">
                  <span className="fld-label">Model</span>
                  <select
                    className="inp"
                    onChange={e => onChange({ model: e.target.value })}
                    value={config.model ?? ''}
                  >
                    <option value="">inherit</option>
                    {MODEL_OPTIONS.map(m => (
                      <option key={m} value={m}>
                        {m}
                      </option>
                    ))}
                  </select>
                </label>
              )}

              {budgets && (
                <>
                  <div className="ins-sep">budgets</div>
                  {/* One row each — the stacked Stepper blocks spent 3× the
                    height saying min/max/step the tooltip can. A human gets
                    only the clock: you don't hand a person an iteration
                    budget, and you don't re-dispatch one either. */}
                  <div className="fld-grid">
                    {has('maxIterations') && (
                      <Fld label="Iterations" tip="Tool-call budget before the subagent must stop.">
                        <Stepper
                          max={200}
                          min={1}
                          onChange={v => onChange({ maxIterations: v })}
                          step={5}
                          value={config.maxIterations ?? 20}
                        />
                      </Fld>
                    )}
                    {has('maxRetries') && (
                      <Fld label="Retries" tip="Takes before the step reports failed.">
                        <Stepper
                          max={10}
                          min={0}
                          onChange={v => onChange({ maxRetries: v })}
                          value={config.maxRetries ?? 1}
                        />
                      </Fld>
                    )}
                    {has('timeoutMins') && (
                      <Fld
                        label="Timeout"
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
                      </Fld>
                    )}
                  </div>
                </>
              )}

              {/* Workers only. On failure means "this step tried and couldn't",
                which needs a step that tries — a gate reads verdicts that
                already exist and a wait watches the clock; neither spends
                anything, so neither has an attempt to lose. On a gate the
                control was answering a question it doesn't have: what happens
                when nothing matches is the "Anything else" arm's job, and it's
                already flagged by check when there isn't one. */}
              {has('onFail') && (
                <Fld
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
                </Fld>
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
                <label className="fld" title="Who the run parks on. Empty means whoever is watching.">
                  <span className="fld-label">Assignee</span>
                  <input
                    className="inp"
                    onChange={e => onChange({ assignee: e.target.value })}
                    placeholder="anyone"
                    value={config.assignee ?? ''}
                  />
                </label>
              )}

              {has('until') && (
                <>
                  <Fld label="Waiting on" tip="What the world has to do before the run moves on.">
                    <Segmented
                      onChange={(v: WaitKind) => onChange({ until: { type: v, spec: config.until?.spec ?? '' } })}
                      options={WAIT_KIND_OPTIONS.map(o => ({ value: o.value, label: o.label }))}
                      value={config.until?.type ?? 'timer'}
                    />
                  </Fld>
                  <label
                    className="fld"
                    title={WAIT_KIND_OPTIONS.find(o => o.value === (config.until?.type ?? 'timer'))?.hint}
                  >
                    <span className="fld-label">Condition</span>
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
                  </label>
                </>
              )}

              {has('maxLoops') && (
                <Fld label="Max takes" tip="How many takes the gate may send back before giving up.">
                  <Stepper max={20} min={1} onChange={v => onChange({ maxLoops: v })} value={config.maxLoops ?? 0} />
                </Fld>
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
                {rt.tokens > 0 && (
                  <span>{rt.tokens >= 1000 ? `${(rt.tokens / 1000).toFixed(1)}k` : rt.tokens} tok</span>
                )}
                {rt.maxIters > 0 && rt.iterations > 0 && (
                  <span>
                    {rt.iterations}/{rt.maxIters} iters
                  </span>
                )}
                {rt.take > 1 && <span>take {rt.take}</span>}
              </div>

              <Field label={isGate ? 'children' : 'input'}>{rt.input ?? '—'}</Field>
              <Field label={isGate ? 'decision' : 'summary'}>{rt.summary ?? '—'}</Field>

              {rt.output && (
                <>
                  <div className="ins-sep">
                    output
                    <span className="sep-count">{Object.keys(rt.output).length} fields</span>
                  </div>
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
                </>
              )}

              {rt.todos.length > 0 && (
                <>
                  {/* "plan" is the todo tool's own word for this checklist, and
                    it stays scoped to the step. The scenario is the authored
                    artifact; a plan is what one agent wrote for itself. */}
                  <div className="ins-sep">
                    plan · todo tool
                    <span className="sep-count">
                      {rt.todos.filter(t => t.status === 'completed').length}/{rt.todos.length}
                    </span>
                  </div>
                  <ul className="todolist">
                    {rt.todos.map(t => (
                      <li className={`todo-item st-${t.status}`} key={t.id}>
                        <span className="todo-mark">{TODO_MARK[t.status]}</span>
                        <span className="todo-text">{t.content}</span>
                      </li>
                    ))}
                  </ul>
                </>
              )}

              {rt.toolCalls.length > 0 && (
                <>
                  <div className="ins-sep">
                    activity
                    <span className="sep-count">{rt.toolCalls.length}</span>
                  </div>
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
                </>
              )}
            </>
          )}
        </div>
      </div>
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

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="ins-field">
      <div className="ins-label">{label}</div>
      <div className="ins-value">{children}</div>
    </div>
  )
}

function FeedRow({ l }: { l: FeedLine }) {
  const time = new Date(l.ts).toLocaleTimeString([], {
    minute: '2-digit',
    second: '2-digit'
  })

  return (
    <div className={`feed-row k-${l.kind}`}>
      <span className="feed-time">{time}</span>
      <span className="feed-dot" />
      <span className="feed-node">{l.step}</span>
      <span className="feed-msg">{l.msg}</span>
      {l.ext && (
        <span className="feed-ext" title="Canvas-side event — no engine reports this">
          ext
        </span>
      )}
    </div>
  )
}
