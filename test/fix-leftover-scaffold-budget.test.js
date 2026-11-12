// Work order leftover-scaffold (again, after #331 and #336): scaffolding pillars stood for hours while the tidy step ran. The scaffold pass of the
// tidy step (brain/autopilot/plan.js, the step's run) takes the list top first, and a block that cannot be reached is walked to first on every visit:
// its walk runs out the step's budget (about 90 s of walks, as fix-leftover-trees-tidy models it), the step ends at the next S.check, and the
// reachable blocks behind it never get a turn. Nothing is remembered from one visit to the next, so the same tops come first again.
// The test drives the real tidy step (plan() on the real goals picker) with a made-up world and a virtual clock: a pillar within reach, and three
// single blocks high in the air above home that cannot be reached. Two visits, as the step runs every few minutes in daylight.
'use strict'
const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('fs')
const os = require('os')
const path = require('path')
const { EventEmitter } = require('events')
const { Vec3 } = require('vec3')

const BUDGET = 240000        // the tidy step's budget (plan.js: budget 240000); G.step sets S.stepDeadline from it
const MINE_COST = 90000      // a block that cannot be reached: its walks run out their time before it gives up
const key = (x, y, z) => `${x},${y},${z}`
const BB = (name) => (/^(air|cave_air|void_air)$/.test(name) ? 'empty' : 'block')

// a tiny world ('x,y,z' -> block name, anything else is air), the real tidy step and a virtual clock. `reach(x, y, z)` says whether a block can be reached.
function rig({ clusters, reach }) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fix-leftover-scaffold-budget-'))
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
  const base = {
    bot, goals: { GoalNear: function () {} }, v: (x, y, z) => new Vec3(x, y, z),
    block: (p) => block(p.x, p.y, p.z),
    flo: (p) => new Vec3(Math.floor(p.x), Math.floor(p.y), Math.floor(p.z)),
    isAir: (b) => !!b && /^(air|cave_air|void_air)$/.test(b.name),
    isLiquid: () => false, isNight: () => false, dist: () => 0, say() {}, wait: async () => {}, pickup: async () => 0,
    isAbort: () => false,
    vt: 0, stepDeadline: 0,                                   // virtual time spent in the step (the real clock is not used)
    check() { if (base.stepDeadline && base.vt > base.stepDeadline) { base.stepDeadline = 0; const e = new Error('step time budget used up'); e.name = 'StepTimeout'; throw e } },
    // the real mine checks the step budget at every walk; a block that cannot be reached costs its walks before it gives up
    mine: async (b) => {
      const { x, y, z } = b.position, ok = reach(x, y, z)
      base.check(); base.vt += ok ? 1000 : MINE_COST; base.check()
      if (!ok) return false
      world.set(key(x, y, z), 'air'); return true
    },
  }
  const S = new Proxy(base, { get: (t, k) => (k in t ? t[k] : () => 0) })
  const G = require('../brain/autopilot/goals')(S, {}, api, () => {})
  G.state.home = [12, 64, 12]
  require('../brain/autopilot/plan')(G, S, {}, api, () => {})
  const tidy = G.steps.find(s => s.id === 'tidy')
  return { tidy, S, name, dispose: () => { try { G.dispose && G.dispose() } catch {} } }
}

// what goals.js G.step does around a step: the budget, and a StepTimeout ends the step (it is not an error)
async function visit(r) {
  r.S.vt = 0; r.S.stepDeadline = BUDGET
  try { await r.tidy.run() } catch (e) { if (!e || e.name !== 'StepTimeout') throw e } finally { r.S.stepDeadline = 0 }
}

const PILLAR = [[16, 64, 16], [16, 65, 16], [16, 66, 16]]                       // a 3 high pillar by home, within reach
const OUT = [[20, 70, 20], [22, 70, 22], [24, 70, 24]]                          // single blocks high in the air, out of reach
const onList = (list, [x, y, z]) => list.some(([a, b, c]) => a === x && b === y && c === z)
const clusters = [
  { id: 'scaffold@16,64,16', what: 'scaffold', kind: 'pillar', n: 3, h: 3, w: 1, d: 1, cells: PILLAR },
  ...OUT.map(([x, y, z]) => ({ id: `scaffold@${x},${y},${z}`, what: 'scaffold', kind: 'stray', n: 1, h: 1, w: 1, d: 1, cells: [[x, y, z]] })),
]

test('a pillar within reach comes down by the second visit, although three blocks out of reach sit above it (their walks used the budget of each visit)', async () => {
  const r = rig({ clusters, reach: (x, y, z) => onList(PILLAR, [x, y, z]) })
  try {
    await visit(r)
    await visit(r)
    for (const [x, y, z] of PILLAR) assert.strictEqual(r.name(x, y, z), 'air', `${x},${y},${z} still stands after two visits: the blocks out of reach are walked to first every visit, the budget ends the step there, and the pillar is never reached`)
  } finally { r.dispose() }
})

test('control: the same pillar with nothing out of reach comes down in one visit', async () => {
  const r = rig({ clusters: clusters.slice(0, 1), reach: () => true })
  try {
    await visit(r)
    for (const [x, y, z] of PILLAR) assert.strictEqual(r.name(x, y, z), 'air', `${x},${y},${z} still stands`)
  } finally { r.dispose() }
})

test('a block that was out of reach is still taken down once it can be reached (it is remembered, not dropped)', async () => {
  let open = false
  const r = rig({ clusters, reach: (x, y, z) => onList(PILLAR, [x, y, z]) || (open && onList(OUT, [x, y, z])) })
  try {
    await visit(r)
    await visit(r)
    open = true
    await visit(r)
    for (const [x, y, z] of OUT) assert.strictEqual(r.name(x, y, z), 'air', `${x},${y},${z} still stands once it can be reached`)
  } finally { r.dispose() }
})
