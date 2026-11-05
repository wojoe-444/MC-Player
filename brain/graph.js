// Behavior graphs that live INSIDE one scheduler task (P6 of the architecture taxonomy).
//
// A graph is a way to write down what one job does (states, the edges between them, which state is active), not another arbiter: it never submits
// tasks, never has a priority, never decides what runs next on the bot. The scheduler still owns "what runs"; the task that runs the graph is stopped,
// paused and resumed like any other (ctx.checkpoint() between states). The graph is exported to brain/state/behavior-tree.json in the shape the
// dashboard's Behavior tab already reads (the same contract as plugin-eval/behavior-view.js for mineflayer-statemachine graphs).
//
//   const g = createGraph({ name: 'mining', file: api.statePath('behavior-tree.json'),
//     nodes: { descend: { label: 'go down', entry: true, run: async (ctx, g) => ... return 'dig' },
//              dig:     { label: 'dig the strip', run: async (ctx, g) => ... return g.done() } },
//     edges: [{ from: 'descend', to: 'dig', label: 'at depth' }, { from: 'dig', to: 'ascend', label: 'bag full' }] })
//   scheduler.submit({ name: 'mining', ..., run: (ctx) => g.run(ctx) })
//
// A node's run() returns the id of the next node, g.done(), or nothing (the same node runs again). Nodes may carry `parent` to nest (display only).
// Strict by default: moving along an edge that was not declared throws, so the exported graph is always true.
const fs = require('fs')
const path = require('path')

const DONE = Symbol('done')

function createGraph({ name = 'graph', nodes, edges = [], file = null, history = 40, now = Date.now, strict = true, log = () => {} }) {
  const ids = Object.keys(nodes || {})
  if (!ids.length) throw new Error('graph needs nodes')
  const entry = ids.find(i => nodes[i].entry) || ids[0]
  const edgeKey = (a, b) => a + '\u0000' + b
  const allowed = new Set(edges.map(e => edgeKey(e.from, e.to)))
  for (const e of edges) if (!nodes[e.from] || !nodes[e.to]) throw new Error(`edge ${e.from} -> ${e.to} names an unknown node`)
  let current = null, hist = [], stRef = null

  const chain = (id) => { const out = []; for (let n = id; n; n = nodes[n] && nodes[n].parent) out.unshift(n); return out }
  function doc() {
    return {
      updatedAt: new Date(now()).toISOString(), machine: name,
      nodes: ids.map(id => ({ id, label: nodes[id].label || id, ...(nodes[id].parent ? { parent: nodes[id].parent } : {}), ...(id === entry ? { entry: true } : {}), ...(nodes[id].type ? { type: nodes[id].type } : {}) })),
      transitions: edges.map(e => ({ from: e.from, to: e.to, ...(e.label ? { label: e.label } : {}) })),
      active: current ? chain(current) : [], history: hist.slice()
    }
  }
  function write() {
    if (!file) return
    try { fs.mkdirSync(path.dirname(file), { recursive: true }); const tmp = file + '.tmp'; fs.writeFileSync(tmp, JSON.stringify(doc())); fs.renameSync(tmp, file) } catch { /* an export must never break the bot */ }
  }
  function enter(to) {
    if (current && to !== current) {
      if (strict && !allowed.has(edgeKey(current, to))) throw new Error(`behavior ${name}: no edge ${current} -> ${to}`)
      hist.push({ at: new Date(now()).toISOString(), from: current, to }); if (hist.length > history) hist.shift()
    }
    current = to; if (stRef) stRef.behavior = to; write()
  }

  // Runs until a node returns g.done(). Pass the scheduler's ctx; an abort surfaces as the AbortError ctx.checkpoint() throws. A resumed task continues
  // in the node it was in (state lives in ctx.state.behavior), it does not start over.
  async function run(ctx) {
    const st = ctx && ctx.state ? ctx.state : {}
    stRef = st
    const start = (ctx && ctx.resumed && st.behavior && nodes[st.behavior]) ? st.behavior : entry
    current = null; enter(start)
    try {
      for (;;) {
        if (ctx && ctx.checkpoint) ctx.checkpoint()
        const next = await nodes[current].run(ctx, api)
        if (next === DONE) { current = null; write(); return { status: 'done' } }
        if (next && next !== current) { if (!nodes[next]) throw new Error(`behavior ${name}: unknown node ${next}`); enter(next) }
        else if (ctx && ctx.sleep) await ctx.sleep(0)
      }
    } catch (e) { write(); throw e }      // keep the last active state in the export when the task is stopped
  }

  const api = { name, run, doc, done: () => DONE, get current() { return current }, ids }
  return api
}

module.exports = { createGraph, DONE }
