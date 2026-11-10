// Test rig for brain/treefarm: the excavation rig's mock bot (dig, drops, line of sight) plus a flat grass world, trees, placing blocks,
// a tiny jump/fall physics, chests and the real brain/los.js helpers.
const fs = require('fs')
const os = require('os')
const path = require('path')
const { Vec3 } = require('vec3')
const { mockBot } = require('./mock-bot')
const { extend, fakeCtx, wait } = require('./excavation.helpers')
const { Scheduler, PRIORITY } = require('../brain/scheduler')
const safehand = require('../brain/safehand')
const los = require('../brain/los')
const util = require('../brain/util')
const stateStore = require('../brain/treefarm/state')
const createEngine = require('../brain/treefarm/engine')
const baseConfig = require('../brain/treefarm/config.json')

const GROUND_Y = 63                       // grass_block layer; trees and the bot stand at y64
const STORAGE = [[10, 64, 10], [12, 64, 10]]
const SOLID_BELOW = (bot, x, y, z) => { const b = bot.blockAt(new Vec3(Math.floor(x), Math.floor(y), Math.floor(z))); return !!b && b.boundingBox !== 'empty' }

function extendTrees(bot) {
  extend(bot)
  bot.placeMode = 'ok'
  const baseFind = bot.findBlocks
  bot.findBlocks = (o) => {
    if (!o.point) return baseFind(o)
    const saved = bot.entity.position; bot.entity.position = o.point
    try { return baseFind(o) } finally { bot.entity.position = saved }
  }
  // leaf `distance` like the game: steps (max 7) from the nearest log through leaves; 7 means the leaf is doomed to decay
  const logCells = new Set(), leafCells = new Map()
  let leafDist = null
  const baseSet = bot.setBlock
  bot.setBlock = (x, y, z, name, props = {}) => {
    baseSet(x, y, z, name, props)
    const k = `${x},${y},${z}`
    logCells.delete(k); leafCells.delete(k)
    if (/_log$/.test(name)) logCells.add(k); else if (/_leaves$/.test(name)) leafCells.set(k, props.persistent === true)
    leafDist = null
  }
  const distances = () => {
    if (leafDist) return leafDist
    leafDist = new Map()
    let frontier = [...logCells]
    for (let d = 1; d <= 6 && frontier.length; d++) {
      const next = []
      for (const k of frontier) {
        const [x, y, z] = k.split(',').map(Number)
        for (const [a, b, c] of [[1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1]]) {
          const nk = `${x + a},${y + b},${z + c}`
          if (leafCells.has(nk) && !leafDist.has(nk)) { leafDist.set(nk, d); next.push(nk) }
        }
      }
      frontier = next
    }
    return leafDist
  }
  const baseBlockAt = bot.blockAt
  bot.blockAt = (p) => {
    const b = baseBlockAt(p)
    if (/sapling|short_grass/.test(b.name)) b.boundingBox = 'empty'
    if (/_leaves$/.test(b.name)) { const k = `${p.x},${p.y},${p.z}`; const persistent = leafCells.get(k) === true; b.getProperties = () => ({ persistent, distance: distances().get(k) ?? 7 }) }
    return b
  }
  // items settle on the ground like in the game
  const baseAdd = bot.addItemEntity
  bot.addItemEntity = (x, y, z, name, count) => {
    let yy = Math.floor(y)
    while (yy > 0 && !SOLID_BELOW(bot, x, yy - 1, z)) yy--
    return baseAdd(x, yy + 0.2, z, name, count)
  }
  // breaking a leaf drops a stick (the real drops are random; saplings and apples are set up by the tests)
  const baseDig = bot.dig
  bot.dig = async (b, force) => {
    if (!/_leaves$/.test(b.name)) return baseDig(b, force)
    bot.assertLos(b, 'dig')
    const { x, y, z } = b.position
    bot.actions.push(['dig', b.name, x, y, z]); bot.digs++
    bot.setBlock(x, y, z, 'air'); bot.addItemEntity(x + 0.5, y + 0.5, z + 0.5, 'stick', 1)
    if (bot.onDig) bot.onDig(bot.digs, b)
  }
  bot.placeBlock = async (ref, face) => {
    bot.assertLos(ref, 'place on')
    const held = bot.heldItem, at = ref.position.plus(face)
    bot.actions.push(['place', held && held.name, at.x, at.y, at.z])
    if (bot.placeMode === 'fail') throw new Error('Event blockUpdate did not fire within timeout of 5000ms')
    if (!held) throw new Error('nothing in hand')
    const f = bot.entity.position.floored()
    if (f.x === at.x && f.z === at.z && bot.entity.position.y < at.y + 1 - 1e-6 && !/sapling/.test(held.name)) throw new Error('entity in the way')   // the server refuses blocks inside us
    if (held.name === 'chest') bot.addChest(at.x, at.y, at.z, 27, {}); else bot.setBlock(at.x, at.y, at.z, held.name, {})
    bot.take(held.name, 1)
  }
  // jump and fall: 0.25 blocks per 10 ms tick (a jump peaks 1.25 above where it started)
  bot.physics = false                  // this rig's own step machine below does the jumping; the excavation mock's jumpLoop would fight it
  let phase = 'ground', apex = 0, hold = 0
  const timer = setInterval(() => {
    for (const e of Object.values(bot.entities)) if (e.name === 'item') {            // dropped items fall and are picked up when touched
      let yy = Math.floor(e.position.y)
      while (yy > 0 && !SOLID_BELOW(bot, e.position.x, yy - 1, e.position.z)) yy--
      e.position.y = Math.min(e.position.y, yy + 0.2)
    }
    bot.pickup()
    const p = bot.entity.position
    if (!bot.entity.velocity) bot.entity.velocity = { x: 0, y: 0, z: 0 }
    const vel = bot.entity.velocity
    const supported = () => SOLID_BELOW(bot, p.x, p.y - 0.001, p.z) && Math.abs(p.y - Math.round(p.y)) < 1e-6
    // a small state machine like a real jump: rise 0.25 a step to +1.25, hang at the top for 4 steps (the real one stays above +1.0 for about 6 ticks), fall 0.25 a step
    // until something solid is under the feet. Every step emits physicsTick like mineflayer, with the vertical velocity set.
    if (phase === 'ground') { if (bot.controlStates.jump && supported()) { phase = 'up'; apex = p.y + 1.25 } else if (!supported()) phase = 'down' }
    if (phase === 'up') { vel.y = 0.25; p.y = Math.min(apex, p.y + 0.25); if (p.y >= apex) { phase = 'hold'; hold = 4 } }
    else if (phase === 'hold') { vel.y = 0; if (--hold <= 0) phase = 'down' }
    else if (phase === 'down') {
      let top = Math.floor(p.y - 0.001)
      while (top > 0 && !SOLID_BELOW(bot, p.x, top - 1, p.z)) top--
      p.y = Math.max(top, p.y - 0.25); vel.y = -0.25
      if (p.y <= top) { p.y = top; vel.y = 0; phase = 'ground' }
    } else vel.y = 0
    bot.entity.onGround = phase === 'ground'
    bot.emit('physicsTick')
  }, 10)
  if (timer.unref) timer.unref()
  bot.stopPhysics = () => clearInterval(timer)
  // where a walk ends: the goal cell for GoalBlock, otherwise the nearest standable cell
  const standable = (c) => { const f = bot.blockAt(c), h = bot.blockAt(c.offset(0, 1, 0)), g = bot.blockAt(c.offset(0, -1, 0)); return f.boundingBox === 'empty' && h.boundingBox === 'empty' && g.boundingBox !== 'empty' }
  bot.arriveAt = (goal) => {
    if (goal.x === undefined) return null
    const gc = new Vec3(Math.floor(goal.x), Math.floor(goal.y), Math.floor(goal.z))
    if (goal instanceof bot.goals.GoalBlock) return gc.offset(0.5, 0, 0.5)
    const cands = []
    for (let dx = -3; dx <= 3; dx++) for (let dz = -3; dz <= 3; dz++) for (let dy = -3; dy <= 3; dy++) {
      const c = gc.offset(dx, dy, dz)
      if (standable(c)) cands.push({ c, d: c.distanceTo(gc) + (c.equals(gc) ? 0 : 0.01) })
    }
    cands.sort((a, b) => a.d - b.d)
    return cands[0] ? cands[0].c.offset(0.5, 0, 0.5) : null
  }
  return bot
}

function flatWorld(bot, half = 40) {
  for (let x = -half; x <= half; x++) for (let z = -half; z <= half; z++) bot.setBlock(x, GROUND_Y, z, 'grass_block')
}

// A natural tree. kind 'oak' (round crown), 'spruce' (cone), or 'dark_oak' (2x2 trunk). Returns the log positions.
function growTree(bot, { x, z, h = 6, species = 'oak', natural = true, y0 = 64, thick = false }) {
  const logs = []
  const cols = thick ? [[0, 0], [1, 0], [0, 1], [1, 1]] : [[0, 0]]
  for (const [dx, dz] of cols) bot.setBlock(x + dx, y0 - 1, z + dz, 'grass_block')
  for (let y = y0; y < y0 + h; y++) for (const [dx, dz] of cols) { bot.setBlock(x + dx, y, z + dz, `${species}_log`, { axis: 'y' }); logs.push(new Vec3(x + dx, y, z + dz)) }
  if (natural) {
    const top = y0 + h
    for (let y = top - 3; y <= top; y++) {
      const r = species === 'spruce' ? Math.max(0, Math.min(2, top - y)) : (y >= top - 1 ? 1 : 2)
      for (let dx = -r; dx <= r + (thick ? 1 : 0); dx++) for (let dz = -r; dz <= r + (thick ? 1 : 0); dz++) {
        if (bot.blockAt(new Vec3(x + dx, y, z + dz)).name !== 'air') continue
        bot.setBlock(x + dx, y, z + dz, `${species}_leaves`, { persistent: false, distance: 1 })
      }
    }
  }
  return logs
}

// A diagonal branch of logs leaving the trunk at height y, with a ball of natural leaves around it. Returns the log positions.
function addBranch(bot, { x, z, y, dx, dz, len = 4, species = 'oak' }) {
  const logs = []
  for (let i = 1; i <= len; i++) { const p = new Vec3(x + i * dx, y + Math.floor(i / 2), z + i * dz); bot.setBlock(p.x, p.y, p.z, `${species}_log`, { axis: 'y' }); logs.push(p) }
  for (const p of logs) for (let a = -1; a <= 1; a++) for (let b = -1; b <= 1; b++) for (let c = -1; c <= 1; c++) {
    const q = p.offset(a, b, c)
    if (bot.blockAt(q).name === 'air') bot.setBlock(q.x, q.y, q.z, `${species}_leaves`, { persistent: false, distance: 1 })
  }
  return logs
}

const countBlocks = (bot, name, box = 20) => {
  let n = 0
  for (let x = -box; x <= box; x++) for (let y = 60; y <= 100; y++) for (let z = -box; z <= box; z++) if (bot.blockAt(new Vec3(x, y, z)).name === name) n++
  return n
}
const blockName = (bot, x, y, z) => bot.blockAt(new Vec3(x, y, z)).name

function rig({ pos = [0, 64, 0], config = {}, storage = true, inv = { iron_axe: 1, dirt: 20, oak_sapling: 4, spruce_sapling: 4 }, sites = [], depositStub = null, requestChest = null, now } = {}) {
  const bot = extendTrees(mockBot({ pos }))
  flatWorld(bot)
  for (const [n, c] of Object.entries(inv)) bot.give(n, c)
  if (storage) for (const s of STORAGE) bot.addChest(...s, 54, {})
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tf-'))
  const file = path.join(dir, 'treefarm-state.json')
  const state = stateStore.load({ file })
  const save = () => stateStore.save(file, state)
  const said = [], nav = { stops: 0 }
  const sh = safehand({ bot })
  const cfg = { ...baseConfig, keepLogs: 32, storage: STORAGE, dropWaitMs: 0, plantWaitMs: 0, logWaitMs: 0, descendMaxMs: 6000, ...config }
  const stop = () => { nav.stops++ }
  const deposits = []
  const depositSmeltables = depositStub === false ? null : (depositStub || (async (o) => {      // stand-in for api.depositSmeltables: logs above 32 vanish into "the furnace chest"
    deposits.push(o)
    const moved = {}
    for (const i of [...bot.inventory.items()]) if (/_log$/.test(i.name)) { const extra = bot.count(i.name) - 32; if (extra > 0) { bot.take(i.name, extra); moved[i.name] = extra } }
    return { moved, left: [], full: false }
  }))
  const engine = createEngine({
    bot, say: (t) => said.push(t), goals: bot.goals, tryGoto: bot.tryGoto, safehand: sh, stopNav: stop,
    gotoNear: (o) => util.gotoNear({ bot, goals: bot.goals, tryGoto: bot.tryGoto, stop, ...o }),
    canSee: (t) => los.canSee(bot, t),
    ensureLineOfSight: (o) => los.ensureLineOfSight({ bot, goals: bot.goals, tryGoto: bot.tryGoto, stop, ...o }),
    depositSmeltables, requestChest, config: cfg, state, save, sitesFn: () => sites, now: now || Date.now
  })
  return { bot, engine, state, save, said, dir, file, cfg, nav, sh, sites, deposits, stop: () => bot.stopPhysics() }
}

module.exports = { rig, extendTrees, mockBot, growTree, addBranch, countBlocks, blockName, flatWorld, fakeCtx, wait, STORAGE, GROUND_Y, Scheduler, PRIORITY }
