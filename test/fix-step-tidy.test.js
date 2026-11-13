// Work order step-tidy: 5 of 16 runs time out walking to scaffold cells, 51 scaffold clusters stand, and goals thrash. The scaffold pass of the tidy
// step (brain/autopilot/plan.js, the step's run) walks to each cell with S.mine(b, { dig: false, force }) and no `escalate` option. S.mine defaults
// escalate to true (brain/autopilot/skills.js), so S.approach makes two escalating go-tos (look-at, then stand-near), and each of those runs nav's
// digging rounds (plan, by hand, sidestep: brain/nav/reach.js) until its cap of 120 s. A cell that no plain walk reaches therefore costs about 240 s,
// which is the whole tidy budget. The StepTimeout ends the step at the next check, the cell is remembered as stuck, and the next visit walks to the
// same highest unreachable cell first, so the reachable pillar below it never gets its turn. Every other walk in plan.js passes escalate: false
// (torch-spacing did so after the same fault, #343); the scaffold walk did not.
// The test drives the real tidy step on the real goals picker with a made-up world and a virtual clock. The step's budget is enforced the way
// skills.js S.check enforces it. The fake S.mine charges each walk what S.approach would spend with the escalate flag it was given.
'use strict'
const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('fs')
const os = require('os')
const path = require('path')
const { EventEmitter } = require('events')
const { Vec3 } = require('vec3')

const BUDGET = 240000          // the tidy step's budget (plan.js: budget 240000); G.step sets S.stepDeadline from it
const PLAIN = 12000            // one go-to without escalation (S.approach: ms 12000 when escalate is false)
const ESCALATING = 120000      // one escalating go-to (S.goto: maxMs is Math.max(120000, ms * 4), so 120 s for the look-at go-to)
const key = (x, y, z) => `${x},${y},${z}`
const BB = (name) => (/^(air|cave_air|void_air)$/.test(name) ? 'empty' : 'block')

// a tiny world ('x,y,z' -> block name, anything else is air), the real tidy step, and a virtual clock. `reach(x, y, z)` says whether a plain walk gets there.
function rig({ clusters, reach }) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fix-step-tidy-'))
  const world = new Map([['12,64,12', 'red_bed']])
  for (const c of clusters) for (const [x, y, z] of c.cells) world.set(key(x, y, z), 'cobblestone')
  const name = (x, y, z) => world.get(key(x, y, z)) || 'air'
  const bot = new EventEmitter()
  bot.entity = { position: new Vec3(12.5, 64, 12.5) }
  bot.time = { day: 3, timeOfDay: 6000 }
  bot.health = 20; bot.food = 20
  bot.registry = { blocksArray: [], blocksByName: {} }
  bot.findBlocks = () => []
  bot._leftovers = { scaffold: () => clusters, trees: () => [], scan() {}, last() {} }
  const block = (x, y, z) => { const n = name(x, y, z); return { name: n, boundingBox: BB(n), position: new Vec3(x, y, z) } }
  const api = { statePath: (f) => path.join(dir, f), profile: { get: () => ({ role: 'hillclimber', steps: null }) } }
  const walks = []                                      // every walk the step made to a cell: where, and whether it was allowed to escalate
  const base = {
    bot, goals: { GoalNear: function () {} }, v: (x, y, z) => new Vec3(x, y, z),
    block: (p) => block(p.x, p.y, p.z),
    flo: (p) => new Vec3(Math.floor(p.x), Math.floor(p.y), Math.floor(p.z)),
    isAir: (b) => !!b && /^(air|cave_air|void_air)$/.test(b.name),
    isLiquid: () => false, isNight: () => false, dist: () => 0, say() {}, wait: async () => {}, pickup: async () => 0,
    isAbort: () => false,
    vt: 0, stepDeadline: 0,                             // virtual time spent in the step (the real clock is not used)
    check() { if (base.stepDeadline && base.vt > base.stepDeadline) { base.stepDeadline = 0; const e = new Error('step time budget used up'); e.name = 'StepTimeout'; throw e } },
    // what S.mine does for a scaffold cell: the look-at go-to, then the stand-near one when the first fails (skills.js S.approach). A go-to with
    // escalate on runs its digging rounds to the cap before it gives up; with escalate off it makes one plain attempt
    mine: async (b, opts = {}) => {
      const { x, y, z } = b.position, ok = reach(x, y, z), escalate = opts.escalate !== false
      walks.push({ x, y, z, escalate })
      base.check()
      base.vt += ok ? 1000 : 2 * (escalate ? ESCALATING : PLAIN)
      base.check()
      if (!ok) return false
      world.set(key(x, y, z), 'air'); return true
    },
  }
  const S = new Proxy(base, { get: (t, k) => (k in t ? t[k] : () => 0) })
  const G = require('../brain/autopilot/goals')(S, {}, api, () => {})
  G.state.home = [12, 64, 12]
  require('../brain/autopilot/plan')(G, S, {}, api, () => {})
  const tidy = G.steps.find(s => s.id === 'tidy')
  return { tidy, S, name, walks, dispose: () => { try { G.dispose && G.dispose() } catch {} } }
}

// one visit the way goals.js runs the step: the budget is set first, and a StepTimeout ends the run (it is not an error)
async function visit(r) {
  r.S.vt = 0; r.S.stepDeadline = BUDGET
  try { await r.tidy.run() } catch (e) { if (!e || e.name !== 'StepTimeout') throw e } finally { r.S.stepDeadline = 0 }
}

const PILLAR = [[16, 64, 16], [16, 65, 16], [16, 66, 16]]                       // a 3 high pillar by home, within plain reach
const OUT = [[20, 70, 20], [22, 70, 22], [24, 70, 24]]                          // single blocks high in the air, out of plain reach
const onList = (list, [x, y, z]) => list.some(([a, b, c]) => a === x && b === y && c === z)
const clusters = [
  { id: 'scaffold@16,64,16', what: 'scaffold', kind: 'pillar', n: 3, h: 3, w: 1, d: 1, cells: PILLAR },
  ...OUT.map(([x, y, z]) => ({ id: `scaffold@${x},${y},${z}`, what: 'scaffold', kind: 'stray', n: 1, h: 1, w: 1, d: 1, cells: [[x, y, z]] })),
]

test('a pillar within reach comes down in the first visit, although three blocks out of reach sit above it: their walks do not use up the step budget', async () => {
  const r = rig({ clusters, reach: (x, y, z) => onList(PILLAR, [x, y, z]) })
  try {
    await visit(r)
    for (const [x, y, z] of PILLAR) assert.strictEqual(r.name(x, y, z), 'air', `${x},${y},${z} still stands after the first visit: the escalating walks to the blocks out of reach used the whole budget, and the pillar never got a turn`)
  } finally { r.dispose() }
})

test('the walks to scaffold cells do not escalate: a cell that no plain walk reaches is given up within its plain attempts', async () => {
  const r = rig({ clusters, reach: (x, y, z) => onList(PILLAR, [x, y, z]) })
  try {
    await visit(r)
    assert.ok(r.walks.length > 0, 'the first visit made no walk to a scaffold cell at all')
    const escalating = r.walks.filter(w => w.escalate).map(w => `${w.x},${w.y},${w.z}`)
    assert.deepEqual(escalating, [], `the walks to ${escalating.join(' ')} were allowed to escalate (digging and building for up to two minutes each)`)
  } finally { r.dispose() }
})

test('control: the same pillar with nothing out of reach comes down in one visit', async () => {
  const r = rig({ clusters: clusters.slice(0, 1), reach: () => true })
  try {
    await visit(r)
    for (const [x, y, z] of PILLAR) assert.strictEqual(r.name(x, y, z), 'air', `${x},${y},${z} still stands`)
  } finally { r.dispose() }
})
