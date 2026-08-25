/**
 * Workflows — a node canvas for authoring and running agent scenarios: steps,
 * gates, waits and human approvals wired into a graph you can edit by hand or
 * by asking. A `/workflows` page, a sidebar row, and a palette entry.
 *
 * The canvas is schema-driven: `scenario.ts` names every field a step can
 * carry, `graph.ts` is the only thing that mutates the document, and
 * `graph-tools.ts` publishes those same mutations as tool descriptors — so an
 * agent edit and a hand edit are the same operation. `run.fake.ts` walks the
 * live graph to produce a run; nothing about the playback is scripted.
 *
 * Ships OFF by default (`defaultEnabled: false`): it inventories in
 * Settings ▸ Plugins and registers nothing until the user flips the switch.
 */

import './workflows.css'

import {
  type HermesPlugin,
  host,
  PALETTE_AREA,
  type PaletteContribution,
  type RouteContribution,
  ROUTES_AREA,
  SIDEBAR_NAV_AREA,
  type SidebarNavContribution
} from '@hermes/plugin-sdk'

import { bindDocuments } from './documents'
import WorkflowsPage from './page'

const PATH = '/workflows'

const plugin: HermesPlugin = {
  id: 'workflows',
  name: 'Workflows',
  description: 'Node canvas for agent scenarios — author a graph of steps, gates and approvals, then run it.',
  defaultEnabled: false,
  register(ctx) {
    ctx.onDispose(bindDocuments(ctx.storage))

    ctx.registerMany([
      {
        id: 'page',
        area: ROUTES_AREA,
        data: { path: PATH } satisfies RouteContribution,
        render: () => <WorkflowsPage />
      },
      {
        id: 'nav',
        area: SIDEBAR_NAV_AREA,
        order: 55,
        data: { codicon: 'type-hierarchy-sub', label: 'Workflows', path: PATH } satisfies SidebarNavContribution
      },
      {
        id: 'open',
        area: PALETTE_AREA,
        data: {
          id: 'workflows.open',
          label: 'Workflows: Open canvas',
          keywords: ['workflow', 'scenario', 'graph', 'canvas', 'nodes'],
          run: () => host.navigate(PATH)
        } satisfies PaletteContribution
      }
    ])
  }
}

export default plugin
