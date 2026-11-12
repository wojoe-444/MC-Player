// Work order step-iron: the iron goal rides the shaft down to a bottom cell that has no ladder in it, and its walk to that cell never ends
// (the nav stuck line at y -5, the 45 s idle alarms). L._dig (brain/autopilot/ladder.js) records the bottom at the level whose ladder would
// not hang: that is an air cell the bot dropped into. L.down then walks to the recorded bottom as an exact block, which nothing can stand on.
// These tests drive the real ladder module on a made-up shaft (rock around it, a 1-wide column, the bot and the server stubbed):
//   1. a dig whose next ladder will not hang records the bottom on the last cell that has a ladder;
//   2. the ride down aims at a cell the bot can stand in, also for a shaft recorded with an air bottom (the one already in the state);
//   3. control: a shaft whose bottom holds a ladder is ridden to that bottom, as before.
'use strict'
const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('fs')
const os = require('os')
const path = require('path')
const { EventEmitter } = require('events')
const { Vec3 } = require('vec3')

// the shared registry goes to a scratch file (the ladder module reads this once, when it is loaded)
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'fix-step-iron-'))
process.env.BOT_REGISTRY = path.join(scratch, 'registry.json')

const key = (x, y, z) => `${x},${y},${z}`
const BB = (n) => (/^(air|cave_air|ladder|torch)$/.test(n) ? 'empty' : 'block')
const v = (x, y, z) => new Vec3(x, y, z)
// rock in a 5 x 5 box from y -12 to y 30, air elsewhere
const rock = (x, y, z) => (Math.abs(x) <= 2 && Math.abs(z) <= 2 && y >= -12 && y <= 30 ? 'stone' : 'air')

class GoalBlock { constructor (x, y, z) { this.x = x; this.y = y; this.z = z } }
class GoalNear { constructor (x, y, z, r) { this.x = x; this.y = y; this.z = z; this.r = r } }

// a made-up world: `cells` overrides the rock; `noHangAt` is a y where the server refuses a ladder (a ladder that will not hang there)
function rig({ cells = new Map(), startY, noHangAt = null, ladders = 40 }) {
  const name = (x, y, z) => (cells.has(key(x, y, z)) ? cells.get(key(x, y, z)) : rock(x, y, z))
  const block = (x, y, z) => { const n = name(x, y, z); return { name: n, boundingBox: BB(n), position: v(x, y, z) } }
  const bot = new EventEmitter()
  bot.entity = { position: v(0.5, startY, 0.5), velocity: v(0, 0, 0), yaw: 0, onGround: true }
  bot.username = 'test-bot'; bot.spawnPoint = { x: 0, z: 0 }; bot.controlState = {}; bot.health = 20; bot.food = 20
  bot.setControlState = () => {}; bot.clearControlStates = () => {}; bot.lookAt = async () => {}
  const seen = []
  let ladderCount = ladders
  const S = {
    bot, goals: { GoalBlock, GoalNear }, v,
    block: (p) => block(p.x, p.y, p.z),
    flo: (p) => v(Math.floor(p.x), Math.floor(p.y), Math.floor(p.z)),
    dist: (p) => bot.entity.position.distanceTo(p),
    isLiquid: () => false, isWaterish: () => false,
    check () {}, wait: async () => {}, pickup: async () => true,
    count: (n) => (n === 'ladder' ? ladderCount : 0),
    items: () => [{ name: 'cobblestone', count: 8 }],
    craft: async () => false,
    // the bot digs the block under its feet and drops into the hole
    digBlock: async (b) => {
      if (b.name !== 'stone') return false
      cells.set(key(b.position.x, b.position.y, b.position.z), 'air'); bot.entity.position = v(0.5, b.position.y, 0.5); return true
    },
    placeAgainst: async (ref, face, what) => {
      const t = ref.position.offset(face.x, face.y, face.z)
      if (what === 'ladder' && t.y === noHangAt) return false
      if (name(t.x, t.y, t.z) !== 'air') return false
      if (what === 'ladder') ladderCount--
      cells.set(key(t.x, t.y, t.z), what); return true
    },
    goto: async (goal) => {
      seen.push({ kind: goal.constructor.name, x: goal.x, y: goal.y, z: goal.z })
      if (goal instanceof GoalNear) { bot.entity.position = v(goal.x + 0.5, goal.y, goal.z + 0.5); return { ok: true } }
      // a block goal is reached only on a cell the bot can stand in: a ladder, or air with a solid block under it
      const here = block(goal.x, goal.y, goal.z), floor = block(goal.x, goal.y - 1, goal.z)
      if (here.name !== 'ladder' && !(here.boundingBox === 'empty' && floor.boundingBox === 'block')) return { ok: false, why: 'noPath' }
      bot.entity.position = v(goal.x + 0.5, goal.y, goal.z + 0.5); return { ok: true }
    },
  }
  const L = require('../brain/autopilot/ladder')(bot, S, S.goals, v, () => {})
  return { L, bot, seen, name: (x, y, z) => name(x, y, z), ladderCount: () => ladderCount }
}

test('a dig whose next ladder will not hang records the shaft bottom on the last cell that has a ladder, not on the air cell it failed in', async () => {
  const cells = new Map()
  for (let y = 12; y <= 30; y++) cells.set(key(0, y, 0), 'air')      // the shaft's top cell and the air above it
  const r = rig({ cells, startY: 12, noHangAt: 7 })
  const sh = await r.L.dig(v(0, 12, 0), 4)
  assert.ok(sh && sh.bottom, 'the dig returns a shaft record')
  assert.equal(r.name(0, 8, 0), 'ladder', 'the last ladder hung at y8')
  assert.equal(r.name(0, 7, 0), 'air', 'no ladder hangs at y7')
  assert.equal(sh.bottom[1], 8, `the recorded bottom is y${sh.bottom[1]}: an air cell with no ladder in it`)
})

test('the ride down aims at a cell the bot can stand in: a shaft recorded with an air bottom is ridden to the ladder above it', async () => {
  const cells = new Map()
  for (let y = -9; y <= 10; y++) cells.set(key(0, y, 0), 'ladder')
  cells.set(key(0, -6, 0), 'air')                                       // the air cell under the ladders: the recorded bottom
  for (let y = 11; y <= 30; y++) cells.set(key(0, y, 0), 'air')
  const r = rig({ cells, startY: 10 })
  const sh = { id: 'test-shaft', entry: [0, 10, 0], bottom: [0, -6, 0], wall: [1, 0] }
  const ok = await r.L.down(sh)
  const aim = r.seen.filter(g => g.kind === 'GoalBlock').pop()
  assert.ok(aim, 'the ride walks to the bottom')
  assert.equal(r.name(aim.x, aim.y, aim.z), 'ladder', `the ride aimed at y${aim.y}, an air cell with no ladder: nothing holds the bot there, so the walk never ends`)
  assert.equal(ok, true, 'the ride down reaches the bottom')
})

test('control: a shaft whose bottom holds a ladder is ridden to that bottom, as before', async () => {
  const cells = new Map()
  for (let y = -9; y <= 10; y++) cells.set(key(0, y, 0), 'ladder')
  for (let y = 11; y <= 30; y++) cells.set(key(0, y, 0), 'air')
  const r = rig({ cells, startY: 10 })
  const sh = { id: 'test-shaft', entry: [0, 10, 0], bottom: [0, -5, 0], wall: [1, 0] }
  assert.equal(await r.L.down(sh), true, 'the ride down reaches the bottom')
  const aim = r.seen.filter(g => g.kind === 'GoalBlock').pop()
  assert.equal(aim.y, -5, 'the walk goes to the recorded bottom')
})
