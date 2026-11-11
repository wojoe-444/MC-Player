// Work order leftover-trees (again): trees cut only part of the way up, and the tidy step never gets to them. plan.js runs the tidy step in two parts,
// the scaffold blocks first and the half-felled trees last, and both share the step's time budget (240 s, set by goals.js G.step). Walking to a scaffold
// block that cannot be reached takes most of a minute, so two or three of them use the whole budget; the next S.check throws StepTimeout (skills.js), the
// step ends inside the scaffold pass, and engine.finishRemnant is never asked about the trees. The same trees then stand for hours.
// The test drives the real tidy step (plan() on the real goals picker) with a made-up world and a virtual clock.
'use strict'
const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('fs')
const os = require('os')
const path = require('path')
const { EventEmitter } = require('events')
const { Vec3 } = require('vec3')

const BUDGET = 240000        // the tidy step's budget (plan.js: budget 240000); G.step sets S.stepDeadline from it
const MINE_COST = 90000      // an unreachable scaffold block: its walks run out their time before it gives up
const key = (x, y, z) => `${x},${y},${z}`
const BB = (name) => (/^(air|cave_air|void_air)$/.test(name) ? 'empty' : 'block')

// a tiny world ('x,y,z' -> block name, anything else is air), the real tidy step, and a finishRemnant that records what it is asked
function rig({ scaffold = [], trees = [], reachable = false }) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fix-leftover-trees-tidy-'))
  const world = new Map([['12,64,12', 'red_bed']])
  for (const [x, y, z] of scaffold) world.set(key(x, y, z), 'cobblestone')
  const name = (x, y, z) => world.get(key(x, y, z)) || 'air'
  const bot = new EventEmitter()
  bot.entity = { position: new Vec3(12.5, 64, 12.5) }
  bot.time = { day: 3, timeOfDay: 6000 }
  bot.health = 20; bot.food = 20
  bot.registry = { blocksArray: [], blocksByName: {} }
  bot.findBlocks = () => []
  const clusters = scaffold.map(([x, y, z]) => ({ id: `scaffold@${x},${y},${z}`, what: 'scaffold', kind: 'stray', n: 1, h: 1, w: 1, d: 1, cells: [[x, y, z]] }))
  bot._leftovers = { scaffold: () => clusters, trees: () => trees, scan() {}, last() {} }
  const block = (x, y, z) => { const n = name(x, y, z); return { name: n, boundingBox: BB(n), position: new Vec3(x, y, z) } }
  const calls = []
  const api = {
    statePath: (f) => path.join(dir, f), profile: { get: () => ({ role: 'hillclimber', steps: null }) },
    treefarm: { engine: { finishRemnant: async (ctx, pos, o) => { calls.push({ pos: [pos.x, pos.y, pos.z], logs: o && o.logs }); return { status: 'done', logs: 3, left: 0 } } } },
  }
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
      base.check(); base.vt += reachable ? 1000 : MINE_COST; base.check()
      if (!reachable) return false
      world.set(key(b.position.x, b.position.y, b.position.z), 'air'); return true
    },
  }
  const S = new Proxy(base, { get: (t, k) => (k in t ? t[k] : () => 0) })
  const G = require('../brain/autopilot/goals')(S, {}, api, () => {})
  G.state.home = [12, 64, 12]
  require('../brain/autopilot/plan')(G, S, {}, api, () => {})
  const tidy = G.steps.find(s => s.id === 'tidy')
  return { tidy, calls, S, dispose: () => { try { G.dispose && G.dispose() } catch {} } }
}

// what goals.js G.step does around a step: the budget, and a StepTimeout ends the step (it is not an error)
async function runStep(r) {
  r.S.vt = 0; r.S.stepDeadline = BUDGET
  try { await r.tidy.run() } catch (e) { if (!e || e.name !== 'StepTimeout') throw e } finally { r.S.stepDeadline = 0 }
}

const remnant = { id: 'tree@16,66,16', what: 'tree', kind: 'cut', n: 3, species: 'oak', h: 3, leaves: 40, pos: [16, 66, 16], by: 'Smeo444', via: 'autopilot', logs: [[16, 66, 16], [16, 67, 16], [16, 68, 16]] }
const SCAFFOLD = [[20, 64, 20], [24, 64, 24], [28, 64, 28]]

test('a half-felled tree near home is handed to the engine even when three scaffold blocks there cannot be reached (their walks use the step budget first)', async () => {
  const r = rig({ scaffold: SCAFFOLD, trees: [remnant] })
  try {
    await runStep(r)
    assert.deepStrictEqual(r.calls.map(c => c.pos), [[16, 66, 16]], 'finishRemnant was never asked about the tree: the scaffold pass ran the budget out first')
  } finally { r.dispose() }
})

test('control: with no scaffold to take down, the same tree is handed to the engine', async () => {
  const r = rig({ scaffold: [], trees: [remnant] })
  try {
    await runStep(r)
    assert.deepStrictEqual(r.calls.map(c => c.pos), [[16, 66, 16]])
  } finally { r.dispose() }
})

test('control: with scaffold blocks that are quick to reach, the tree is handed to the engine after them', async () => {
  const r = rig({ scaffold: SCAFFOLD, trees: [remnant], reachable: true })
  try {
    await runStep(r)
    assert.deepStrictEqual(r.calls.map(c => c.pos), [[16, 66, 16]])
    assert.strictEqual(r.S.vt < BUDGET, true, 'the scaffold blocks were quick')
  } finally { r.dispose() }
})
