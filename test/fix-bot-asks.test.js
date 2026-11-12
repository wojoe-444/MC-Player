// Work order bot-asks: the bot asked Walter to clear a dirt block in its laddered shaft ("It blocks the ladder, and my trips stop there").
// The iron step (brain/autopilot/plan.js, the step's run) rides the shaft with LD.down from the surface and never clears a block that ended up
// in the shaft column. Only pursue called LD.clearPlug (brain/autopilot/ladder.js), so an iron trip stopped at the plug and gave up after three
// tries. The test drives the real iron step on a made-up shaft (entry y65, bottom y-10, a dirt plug at y-6) and checks that the plug is
// cleared before the ride down. The fake pathfinder never moves the bot, so the ride itself is not simulated; the plug clearing is recorded
// through LD.clearPlug, the one entry point the step must call.
'use strict'
const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('fs')
const os = require('os')
const path = require('path')
const { EventEmitter } = require('events')
const { Vec3 } = require('vec3')

const key = (x, y, z) => `${x},${y},${z}`
const BB = (name) => (/^(air|cave_air|void_air)$/.test(name) ? 'empty' : 'block')

// a made-up world: the home bed at 6,64,6; the shaft's entry at 0,65,0 with its bottom at 0,-10,0; a dirt plug at 0,-6,0 when asked for
function rig({ plug }) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fix-bot-asks-'))
  const blocks = new Map([[key(6, 64, 6), 'red_bed']])
  if (plug) blocks.set(key(0, -6, 0), 'dirt')
  const name = (x, y, z) => blocks.get(key(x, y, z)) || 'air'
  const block = (x, y, z) => { const n = name(x, y, z); return { name: n, boundingBox: BB(n), position: new Vec3(x, y, z) } }
  const bot = new EventEmitter()
  bot.entity = { position: new Vec3(3.5, 70, 3.5), onGround: true, yaw: 0 }
  bot.time = { day: 3, timeOfDay: 6000 }
  bot.health = 20; bot.food = 20; bot.registry = { blocksArray: [] }; bot.findBlocks = () => []; bot.controlState = {}
  bot.setControlState = () => {}; bot.clearControlStates = () => {}; bot.lookAt = async () => {}
  const inv = [{ name: 'iron_pickaxe', count: 2 }, { name: 'torch', count: 16 }, { name: 'iron_ingot', count: 20 }]
  const count = (w) => inv.filter(i => (w instanceof RegExp ? w.test(i.name) : i.name === w)).reduce((n, i) => n + i.count, 0)
  const events = []
  const base = {
    bot, goals: { GoalNear: class { constructor (x, y, z) { this.x = x; this.y = y; this.z = z } }, GoalBlock: class { constructor (x, y, z) { this.x = x; this.y = y; this.z = z } } },
    v: (x, y, z) => new Vec3(x, y, z), flo: (p) => new Vec3(Math.floor(p.x), Math.floor(p.y), Math.floor(p.z)),
    block: (p) => block(p.x, p.y, p.z), isAir: (b) => !!b && /^(air|cave_air|void_air)$/.test(b.name),
    isLiquid: () => false, isWaterish: () => false, dist: (p) => bot.entity.position.distanceTo(p), check() {}, wait: async () => {}, say() {},
    count, has: (n) => count(n) > 0, items: () => inv.slice(), toolTier: () => 3, foodPoints: () => 20, rawFood: () => 0, freeSlots: () => 20,
    isNight: () => false, skyVisible: () => false, underground: () => true,
    // the pathfinder: the bot never gets there (the plug in the column stops the walk); every go-to is recorded
    goto: async (goal) => { events.push(['goto', goal.y]); return { ok: false, why: 'noPath' } },
  }
  const S = new Proxy(base, { get: (t, k) => (k in t ? t[k] : () => 0) })
  const api = { statePath: (f) => path.join(dir, f), profile: { get: () => ({ role: 'hillclimber', steps: null }) } }
  const prevReg = process.env.BOT_REGISTRY
  process.env.BOT_REGISTRY = path.join(dir, 'registry.json')   // no shared registry here: the shaft is the one the state names
  const G = require('../brain/autopilot/goals')(S, {}, api, () => {})
  G.state.home = [6, 64, 6]
  G.state.mine = { entry: [0, 65, 0], bottom: [0, -10, 0], wall: [1, 0], ladder: true, shaft: 'test-shaft', dir0: 0, path: [] }
  const M = {}
  require('../brain/autopilot/plan')(G, S, M, api, () => {})
  const iron = G.steps.find(s => s.id === 'iron')
  return {
    G, iron, M, events, dispose: () => { try { G.dispose && G.dispose() } catch {} ; if (prevReg === undefined) delete process.env.BOT_REGISTRY; else process.env.BOT_REGISTRY = prevReg }
  }
}

test('the iron trip clears the dirt plug in its shaft before it rides down (the plug stopped every trip, the bot asked Walter)', async () => {
  const r = rig({ plug: true })
  try {
    assert.ok(r.iron, 'the iron step exists')
    assert.ok(r.iron.need(), 'the iron step wants to go (bag, torches, food, home all set)')
    r.M.LD.clearPlug = async (sh) => { r.events.push(['clearPlug', sh.id]); return 0 }
    await r.iron.run()
    const order = r.events.map(e => e[0])
    assert.ok(order.includes('clearPlug'), 'the iron trip rode toward the dirt plug at y-6 without clearing it (only pursue cleared plugs)')
    assert.equal(order[0], 'clearPlug', 'the plug is cleared before the ride down, not after it')
  } finally { r.dispose() }
})

test('control: an iron trip with a clear shaft still rides down to the bottom (no plug: the step goes on as before)', async () => {
  const r = rig({ plug: false })
  try {
    assert.ok(r.iron.need(), 'the iron step wants to go')
    await r.iron.run()
    const gotos = r.events.filter(e => e[0] === 'goto').map(e => e[1])
    assert.ok(gotos.length >= 1, 'the trip made no walk to the shaft at all')
    assert.equal(gotos[0], 65, 'the first walk is to the shaft entry at y65')
  } finally { r.dispose() }
})
