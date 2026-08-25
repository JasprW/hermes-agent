import '@xyflow/react/dist/style.css'

import {
  Button,
  cn,
  Codicon,
  composerDockCard,
  EmptyState,
  PageHeader,
  PageHeaderActions,
  PageHeaderCount,
  PageHeaderTitle,
  PageShell,
  SidePanel,
  Tip,
  useTheme,
  useValue
} from '@hermes/plugin-sdk'
import {
  Background,
  BackgroundVariant,
  type Connection,
  type Edge,
  type EdgeChange,
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
import { type CSSProperties, useCallback, useEffect, useMemo, useRef, useState } from 'react'

import { type AddAt, addStep, AddStepProvider, KindPicker } from './add-step'
import { runTurn } from './agent'
import { AskDialog } from './ask'
import { type AgentReply, Composer } from './composer'
import { FlowDirProvider } from './direction'
import { $currentId, $workflows, createWorkflow, saveWorkflow, type WorkflowDoc } from './documents'
import { CutEdgeProvider, edgeTypes } from './edges'
import {
  connect,
  disconnect,
  fromScenario,
  type Graph,
  type OpResult,
  removeStep,
  runPlan,
  stepNodes,
  toScenario,
  updateStep
} from './graph'
import { Inspector } from './inspector'
import { DEFAULT_DIR, type FlowDir, tidyLayout } from './layout'
import { LiveLog } from './livelog'
import { type NodeData, nodeTypes } from './nodes'
import { usePlayer } from './player'
import { type EdgeState, feedLine, type FeedLine, freshRuntime, type StepRuntime } from './protocol'
import { blankScenario, starterScenario, type StepConfig, type StepKind } from './scenario'
import { WorkflowSwitcher } from './switcher'
import { Timeline } from './timeline'
import { useUndoRedo } from './use-undo-redo'

// Steps the agent adds mid-session have no runtime in the event stream — they
// read as idle until the next run includes them.
const IDLE_RT: StepRuntime = freshRuntime()

// One width, two consumers: the panel wears it, and the canvas reads it as a
// CSS var so the run dock re-centres on what's left of the canvas.
const INSPECTOR_REM = '17.5rem'
const INSPECTOR_WIDTH = 'w-[17.5rem]'

// Keep the graph clear of the floating chrome that is ALWAYS there: the brand
// mark up top, the timeline + composer along the bottom, the live log's lane on
// the right. The inspector is deliberately NOT reserved for — it floats over
// the canvas and the graph stays put, because re-framing the whole graph every
// time you open a panel is worse than the overlap it avoids.
const FIT = {
  // The brand panel bottoms out at 66px (16px margin + 51px tall), so 56px
  // left the top rank grazing it.
  padding: { top: '78px', right: '150px', bottom: '208px', left: '40px' }
} as const

export default function WorkflowsPage() {
  const docs = useValue($workflows)
  const currentId = useValue($currentId)
  const doc = docs.find(d => d.id === currentId)

  if (!doc) {
    return <FirstWorkflow />
  }

  // Keyed on the document: switching workflows is a fresh canvas, not a
  // re-render of this one. Undo history, selection and the run all belong to
  // the workflow you were looking at, and carrying any of them across would be
  // a bug in every case.
  return (
    <ReactFlowProvider key={doc.id}>
      <Flow doc={doc} />
    </ReactFlowProvider>
  )
}

/** Nothing authored yet. Two ways in: an empty canvas, or the scenario the
 *  plugin ships with — which is the faster way to learn what a gate is. */
function FirstWorkflow() {
  return (
    <PageShell className="wf-root">
      <PageHeader>
        <PageHeaderTitle>Workflows</PageHeaderTitle>
      </PageHeader>
      <EmptyState
        action={
          <div className="flex items-center gap-2">
            <Button onClick={() => createWorkflow('Untitled workflow', blankScenario())} size="sm">
              <Codicon name="add" size="0.75rem" />
              Create your first workflow
            </Button>
            <Button onClick={() => createWorkflow('Figma → PR', starterScenario())} size="sm" variant="outline">
              Start from an example
            </Button>
          </div>
        }
        description="A workflow is a graph of steps an agent runs — work, checks, branches, and the places a person has to say yes. Build one by hand, or ask for it."
        icon="type-hierarchy-sub"
        title="No workflows yet"
      />
    </PageShell>
  )
}

function Flow({ doc }: { doc: WorkflowDoc }) {
  // React Flow paints its own chrome (background dots, controls, minimap) from
  // a light/dark switch of its own, so it needs the mode the host actually
  // resolved — 'system' would leave it guessing.
  const { resolvedMode } = useTheme()
  // The run is built from whatever is on the canvas when you press play, so the
  // player reads the graph through a ref rather than taking it as a prop — it's
  // mounted above the node state, and re-arming it on every keystroke would
  // rebuild the timeline while you type.
  const graphRef = useRef<Graph>({ nodes: [], edges: [] })
  const planOf = useCallback(() => runPlan(graphRef.current, 'figma-to-pr'), [])
  const player = usePlayer(planOf)

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
  // fromScenario() call would rebuild the whole graph on every render of this
  // component and throw the result away — React only keeps the first. The
  // document is fixed for this canvas's life (the page keys on its id), so
  // there's nothing for the memo to depend on.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const seed = useMemo(() => fromScenario(doc.scenario), [])
  const [nodes, setNodes, onNodesChange] = useNodesState(seed.nodes)
  const [edges, setEdges, onEdgesChange] = useEdgesState(seed.edges)
  const [selected, setSelected] = useState<string | null>(null)
  const [draft, setDraft] = useState<AddAt | null>(null)
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

  // Which way the ranks run. Dagre's own `rankdir` does the work — the handles
  // follow it (see nodes.tsx), so nothing here computes a position by hand.
  const [dir, setDirState] = useState<FlowDir>(DEFAULT_DIR)
  const vertical = dir === 'TB'

  const tidy = useCallback(
    (to: FlowDir = dir) => {
      takeSnapshot()
      setNodes(ns => tidyLayout(ns, edges, to))
      refit()
    },
    [dir, edges, refit, setNodes, takeSnapshot]
  )

  // Flipping direction without re-laying out would leave every card where the
  // other orientation put it, wired through its own neighbours — so the toggle
  // IS a tidy, just one that changes rankdir on the way through.
  const setDir = useCallback(
    (to: FlowDir) => {
      setDirState(to)
      tidy(to)
    },
    [tidy]
  )

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
    setNodes(ns => tidyLayout(ns, edges, dir))
    refit()
    // measuredSig is the real dependency — it changes when a card's measured
    // size lands. eslint can't see that it stands in for `nodes`.
  }, [allMeasured, measuredSig, dir, edges, refit, setNodes])

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

      const next = addStep(nodes, edges, draft, kind, dir)
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
    [dir, draft, edges, nodes, setEdges, setNodes, takeSnapshot]
  )

  // ONE commit path for every structural edit — the connect gesture, a delete,
  // the inspector, and every tool the composer's agent calls. Undo, selection
  // and the transcript all hang off this, so nothing can mutate the document
  // and leave one of the three behind.
  const graph = useMemo<Graph>(() => ({ nodes, edges }), [nodes, edges])
  const stepCount = stepNodes(graph).length
  graphRef.current = graph

  // The document IS the canvas, so it's written back whenever the canvas
  // changes — no save button, and the switcher can't show you a stale step
  // count. `toScenario` drops runtime and keeps positions, so a round-trip
  // through storage returns the graph you left.
  useEffect(() => {
    saveWorkflow(doc.id, toScenario(graph))
  }, [doc.id, graph])

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

  // The composer's agent. `runTurn` plans TOOL CALLS against the graph's own
  // schema and `callTool` runs them through the same primitives the inspector
  // and the canvas use — so an agent edit and a hand edit are one operation.
  // The transcript reports whatever the tools reported.
  const handleAgentTurn = useCallback(
    async (text: string): Promise<AgentReply> => {
      const turn = await runTurn(text, graph, {
        running: player.running,
        paused: player.pauseState === 'paused',
        start: player.start,
        pause: player.requestPause,
        resume: player.resume,
        reset: player.reset
      })

      if (turn.graph !== graph) {
        applyOp({ ok: true, graph: turn.graph, message: '', focus: turn.focus })
      }

      return { reply: turn.reply, edit: turn.edit }
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
    // Parked on a person. Nothing the transport can do will move the run —
    // only the answer will — so the key that means "carry on" puts the
    // question back in front of you rather than doing nothing.
    if (player.asking) {
      player.reveal()

      return
    }

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
    <PageShell className="wf-root" style={{ '--wf-inspector': selNode ? INSPECTOR_REM : '0rem' } as CSSProperties}>
      {/* A real header row rather than a panel floating over the graph: the
          scenario's name is chrome, and floating it on top of the canvas made
          it read as another node. Literally the Kanban board's header now, so
          two plugin pages read as siblings. Theme and mode are the host's —
          they live in Settings, not on this page. */}
      <PageHeader>
        <PageHeaderTitle>Workflows</PageHeaderTitle>
        <WorkflowSwitcher />
        <PageHeaderCount>{stepCount}</PageHeaderCount>
        <PageHeaderActions>
          {/* A divided box, not an arrow: the icon has to say "arrangement",
              and a lone chevron on a header button says "this opens something".
              It shows the layout you'd GET.
              
              The LABEL, though, names the control and doesn't change with it.
              You click this with the tip already open, so a label that swapped
              between two different-length strings resized and re-centred its
              bubble on every press — a flicker right under the header, for a
              state the icon is already showing. */}
          <Tip label="Flip layout direction">
            <Button
              aria-label="Flip layout direction"
              onClick={() => setDir(vertical ? 'LR' : 'TB')}
              size="icon-xs"
              variant="ghost"
            >
              <Codicon
                className="grid size-3.5 place-items-center"
                name={vertical ? 'split-vertical' : 'split-horizontal'}
                size="0.85rem"
              />
            </Button>
          </Tip>
        </PageHeaderActions>
      </PageHeader>

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
        <FlowDirProvider value={dir}>
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

                <LiveLog lines={lines} titles={nodeTitles} />

                {/* The app's composer dock, borrowed whole: a card fused to the top of
            the capsule (the chat's status stack is the same shape) carrying the
            transport, and the composer itself below it. Same fill, same glass,
            same seam — this reads as the app's input, because it is. */}
                <Panel className="run-panel" position="bottom-center">
                  {player.asking && player.deferred && (
                    <button className="ask-back" onClick={player.reveal}>
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
                    onDefer={player.defer}
                    onRespond={player.respond}
                    open={!player.deferred}
                    title={askTitle}
                  />
                )}
              </ReactFlow>
            </CutEdgeProvider>
          </AddStepProvider>
        </FlowDirProvider>
      </div>

      {/* Last child of the page root, exactly where the Kanban board hangs its
          task drawer — so it pins to the whole page and bleeds past the header,
          rather than starting below it as another inset canvas panel.

          Narrower than that drawer's 26rem: it holds prose and a run log, this
          holds a column of knobs. */}
      {selNode && (
        <SidePanel className={INSPECTOR_WIDTH} onClose={() => setSelected(null)}>
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
        </SidePanel>
      )}

      {draft && <KindPicker at={draft.at} onClose={() => setDraft(null)} onPick={confirmAdd} />}
    </PageShell>
  )
}
