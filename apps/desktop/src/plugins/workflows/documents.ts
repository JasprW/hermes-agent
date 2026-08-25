/**
 * The workflows you have, and which one is open.
 *
 * A canvas holds one scenario, so everything else — the switcher, the empty
 * state, the agent's idea of "the workflow" — needs somewhere the set of them
 * lives. That's here, and it's deliberately small: a list of scenarios by id,
 * a pointer at one of them, and the four things you can do to the list.
 *
 * `Scenario` is the stored shape rather than React Flow's nodes and edges,
 * because it's the schema `graph.ts`, `graph-tools.ts` and the agent already
 * agree on, and it round-trips losslessly through `toScenario`/`fromScenario`
 * — card positions included. Persistence is the plugin's own namespaced
 * storage: no backend, and nothing of this leaves the machine.
 */

import { atom } from '@hermes/plugin-sdk'

import type { Scenario } from './scenario'

export interface WorkflowDoc {
  id: string
  name: string
  scenario: Scenario
}

/** Every workflow, oldest first — the order the switcher lists them in. */
export const $workflows = atom<WorkflowDoc[]>([])

/** The open one. `null` when there are none, which is the empty state. */
export const $currentId = atom<string | null>(null)

const DOCS_KEY = 'documents'
const CURRENT_KEY = 'currentId'

/** Ids are minted from the name so the storage is legible when you go looking,
 *  and suffixed only on collision. */
function mintId(name: string, taken: WorkflowDoc[]): string {
  const base =
    name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-|-$/g, '') || 'workflow'

  let id = base

  for (let n = 2; taken.some(d => d.id === id); n++) {
    id = `${base}-${n}`
  }

  return id
}

export function createWorkflow(name: string, scenario: Scenario): string {
  const docs = $workflows.get()
  const doc: WorkflowDoc = { id: mintId(name, docs), name, scenario }

  $workflows.set([...docs, doc])
  $currentId.set(doc.id)

  return doc.id
}

export function renameWorkflow(id: string, name: string): void {
  $workflows.set($workflows.get().map(d => (d.id === id ? { ...d, name } : d)))
}

/** Deleting the open one falls through to its neighbour, and to the empty
 *  state when it was the last. Nothing else is allowed to leave `$currentId`
 *  pointing at a workflow that no longer exists. */
export function removeWorkflow(id: string): void {
  const docs = $workflows.get()
  const next = docs.filter(d => d.id !== id)

  $workflows.set(next)

  if ($currentId.get() === id) {
    const at = docs.findIndex(d => d.id === id)
    $currentId.set(next[Math.min(at, next.length - 1)]?.id ?? null)
  }
}

/** Save the open canvas back. Called on every committed edit, so the switcher
 *  and storage never show a stale copy of the thing you're looking at. */
export function saveWorkflow(id: string, scenario: Scenario): void {
  $workflows.set($workflows.get().map(d => (d.id === id ? { ...d, scenario } : d)))
}

export interface DocStorage {
  get: <T>(key: string, fallback: T) => T
  set: (key: string, value: unknown) => void
}

/** Hydrate from the plugin's storage and write back as it changes. Returns the
 *  unsubscribe, for `ctx.onDispose`.
 *
 *  The write is trailing-debounced because a card drag republishes the whole
 *  document every frame, and serialising a scenario into localStorage sixty
 *  times a second is felt in the drag. The atom stays immediate — the switcher
 *  reads that, and it should never lag the canvas. */
export function bindDocuments(storage: DocStorage): () => void {
  $workflows.set(storage.get<WorkflowDoc[]>(DOCS_KEY, []))
  $currentId.set(storage.get<string | null>(CURRENT_KEY, null))

  let timer = 0

  const unsubs = [
    $workflows.listen(docs => {
      window.clearTimeout(timer)
      timer = window.setTimeout(() => storage.set(DOCS_KEY, docs), 400)
    }),
    // Switching is a discrete act and there's nothing to coalesce, so it lands
    // at once — a reload right after a switch must reopen what you switched to.
    $currentId.listen(id => storage.set(CURRENT_KEY, id))
  ]

  return () => {
    window.clearTimeout(timer)
    unsubs.forEach(off => off())
  }
}
