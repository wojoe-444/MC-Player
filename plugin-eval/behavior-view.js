// behavior-view.js: writes a mineflayer-statemachine graph + active state to brain/state/behavior-tree.json for the dashboard.
// Read-only export. Atomic (tmp + rename). Never throws into the bot loop.
// usage:  const bsm = new BotStateMachine(bot, root);  const view = attachBehaviorView(bsm, '<stateDir>/behavior-tree.json')
const fs = require('fs')
const path = require('path')
const { NestedStateMachine } = require('mineflayer-statemachine')

function attachBehaviorView(bsm, file, opts = {}) {
  const maxHist = opts.history || 40
  const ids = new Map()      // state object -> unique id
  const used = new Set()
  const nodes = [], transitions = [], history = []
  const label = (s) => s.label || s.stateName || 'state'
  const idOf = (s, parentId) => {
    if (ids.has(s)) return ids.get(s)
    let base = (parentId ? parentId + '/' : '') + label(s), id = base, n = 2
    while (used.has(id)) id = base + '#' + n++
    used.add(id); ids.set(s, id); return id
  }
  function walk(machine, parentId) {
    for (const s of machine.states) {
      const id = idOf(s, parentId)
      if (nodes.some(n => n.id === id)) continue
      const node = { id, label: label(s) }
      if (parentId) node.parent = parentId
      if (s === machine.enter) node.entry = true
      nodes.push(node)
      if (s instanceof NestedStateMachine) walk(s, id)
    }
    for (const t of machine.transitions) {
      const tr = { from: idOf(t.parentState, parentId), to: idOf(t.childState, parentId) }
      if (t.name) tr.label = t.name
      transitions.push(tr)
    }
  }
  walk(bsm.rootStateMachine, null)

  function activePath() {
    const out = []
    let m = bsm.rootStateMachine
    while (m && m.activeState) { out.push(ids.get(m.activeState)); m = m.activeState instanceof NestedStateMachine ? m.activeState : null }
    return out
  }
  let prevLeaf = null
  function write(record) {
    try {
      const active = activePath()
      const leaf = active[active.length - 1] || null
      if (leaf && nodes.some(n => n.parent === leaf)) return // nested machine just entered, inner state not set yet
      if (record && leaf !== prevLeaf) { history.push({ at: new Date().toISOString(), from: prevLeaf, to: leaf }); if (history.length > maxHist) history.shift() }
      prevLeaf = leaf
      const doc = { updatedAt: new Date().toISOString(), machine: opts.machine || 'root', nodes, transitions, active, history }
      fs.mkdirSync(path.dirname(file), { recursive: true })
      const tmp = file + '.tmp'
      fs.writeFileSync(tmp, JSON.stringify(doc))
      fs.renameSync(tmp, file)
    } catch (e) { /* export must never break the bot */ }
  }
  bsm.on('stateChanged', () => write(true))
  const timer = setInterval(() => write(false), opts.everyMs || 5000)
  timer.unref && timer.unref()
  write(true)
  return { write, stop: () => clearInterval(timer) }
}
module.exports = { attachBehaviorView }
