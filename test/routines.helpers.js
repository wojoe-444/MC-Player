// Test rig for brain/routines: the excavation rig's mock bot (dig, drops, pickup) plus crops, planting, beds and sleeping.
const fs = require('fs')
const os = require('os')
const path = require('path')
const { Vec3 } = require('vec3')
const { mockBot } = require('./mock-bot')
const { extend, fakeCtx, waitFor, wait } = require('./excavation.helpers')
const { Scheduler, PRIORITY } = require('../brain/scheduler')
const safehand = require('../brain/safehand')
const stateStore = require('../brain/routines/state')
const createFarm = require('../brain/routines/farm')
const createSleep = require('../brain/routines/sleep')
const baseConfig = require('../brain/routines/config.json')

const SITE = { name: 'home farm', x: -1067, y: 160, z: 2360 }
const HOUSE_CHEST = baseConfig.farm.houseChest
const BED = [-1058, 160, 2341]
const tick = () => new Promise(r => setImmediate(r))
const CROP_DROPS = { wheat: [['wheat', 1], ['wheat_seeds', 1]], carrots: [['carrot', 3]], potatoes: [['potato', 3]], beetroots: [['beetroot', 1], ['beetroot_seeds', 1]] }
const SEED_TO_CROP = { wheat_seeds: 'wheat', carrot: 'carrots', potato: 'potatoes', beetroot_seeds: 'beetroots' }

function extendRoutines(bot) {
  extend(bot)
  bot.seedDrop = 1; bot.placeMode = 'ok'; bot.sleepError = null
  bot.time = { timeOfDay: 1000, day: 7, age: 5 * 24000 + 1000 }
  const baseFind = bot.findBlocks
  bot.findBlocks = (o) => {      // honour { point }
    if (!o.point) return baseFind(o)
    const saved = bot.entity.position; bot.entity.position = o.point
    try { return baseFind(o) } finally { bot.entity.position = saved }
  }
  bot.dig = async (b) => {
    bot.assertLos(b, 'dig')
    const { x, y, z } = b.position
    bot.actions.push(['dig', b.name, x, y, z]); bot.digs++
    if (b.name === 'sugar_cane' || b.name === 'bamboo') {      // breaking a cane / bamboo block brings the whole stalk above it down: one item per block
      let top = y; while (bot.blockAt(new Vec3(x, top + 1, z)).name === b.name) top++
      bot.heldWhenDug = bot.heldItem && bot.heldItem.name
      for (let yy = y; yy <= top; yy++) { bot.setBlock(x, yy, z, 'air'); bot.addItemEntity(x + 0.5, y + 0.2, z + 0.5, b.name, 1) }
      if (bot.onDig) bot.onDig(bot.digs, b)
      await tick(); return
    }
    for (const [name, n] of CROP_DROPS[b.name] || [[b.name, 1]]) {
      const count = name.endsWith('_seeds') ? bot.seedDrop : n
      if (count > 0) bot.addItemEntity(x + 0.5, y + 0.2, z + 0.5, name, count)
    }
    bot.setBlock(x, y, z, 'air')
    if (bot.onDig) bot.onDig(bot.digs, b)
    await tick()
  }
  bot.placeBlock = async (ref, face) => {
    bot.assertLos(ref, 'place on')
    const held = bot.heldItem
    if (held && held.name === 'chest') {          // a work-site chest: a real container appears
      const t = ref.position.offset(face.x, face.y, face.z)
      if (bot.blockAt(t).name !== 'air') throw new Error('target cell is not empty')
      bot.actions.push(['place', 'chest', t.x, t.y, t.z]); bot.addChest(t.x, t.y, t.z, 27, {}); bot.take('chest', 1); return
    }
    bot.actions.push(['place', held && held.name, ref.position.x, ref.position.y + 1, ref.position.z])
    if (bot.placeMode === 'fail') throw new Error('Event blockUpdate did not fire within timeout of 5000ms')
    if (held && held.name === 'bamboo') {          // a bamboo item makes a sapling on the block
      const t = ref.position.offset(face.x, face.y, face.z)
      if (bot.blockAt(t).name !== 'air') throw new Error('target cell is not empty')
      bot.setBlock(t.x, t.y, t.z, 'bamboo_sapling'); bot.take('bamboo', 1); return
    }
    const crop = SEED_TO_CROP[held && held.name]
    if (!crop) throw new Error('not a seed: ' + (held && held.name))
    bot.setBlock(ref.position.x, ref.position.y + 1, ref.position.z, crop, { age: 0 }); bot.take(held.name, 1)
    if (bot.placeMode === 'timeout-but-placed') throw new Error('Event blockUpdate did not fire within timeout of 5000ms')
  }
  bot.sleep = async (bed) => {
    bot.assertLos(bed, 'sleep in')
    if (bot.sleepError) throw new Error(bot.sleepError)
    const t = bot.time.timeOfDay
    if (t < 12542 || t >= 23460) throw new Error("it's not night")
    bot.isSleeping = true; bot.actions.push(['sleep', bed.position.x, bed.position.y, bed.position.z]); bot.emit('sleep')
  }
  bot.wake = async () => { bot.isSleeping = false; bot.actions.push(['wake']); bot.emit('wake') }
  bot.nightSkips = () => { bot.time.timeOfDay = 100; bot.time.age += 12000; bot.isSleeping = false; bot.emit('wake') }
  return bot
}

const placed = (bot) => bot.actions.filter(a => a[0] === 'place')
const blockName = (bot, x, y, z) => bot.blockAt(new Vec3(x, y, z)).name
const ageAt = (bot, x, y, z) => bot.blockAt(new Vec3(x, y, z)).getProperties().age

// A farm row at y160 over farmland (y159). spec: [{ crop, age, x, z }]
function plantCrops(bot, spec) { for (const c of spec) { const y = c.y ?? 160; bot.setBlock(c.x, y - 1, c.z, c.floor || 'farmland'); bot.setBlock(c.x, y, c.z, c.crop, { age: c.age }) } }
// sugar cane stalks on sand: spec [{ x, z, h }] (y160 up)
function plantCane(bot, spec, y = 160) { for (const c of spec) { bot.setBlock(c.x, y - 1, c.z, 'sand'); for (let i = 0; i < c.h; i++) bot.setBlock(c.x, y + i, c.z, 'sugar_cane', { age: 0 }) } }
// bamboo stalks (spec [{ x, z, h }], y160 up) on grass
function plantBamboo(bot, spec, y = 160) { for (const c of spec) { bot.setBlock(c.x, y - 1, c.z, 'grass_block'); for (let i = 0; i < c.h; i++) bot.setBlock(c.x, y + i, c.z, 'bamboo', { age: 0 }) } }
// grass ground for bamboo to go on
function grass(bot, { x0 = -1062, x1 = -1056, z0 = 2362, z1 = 2368, y = 159 } = {}) { for (let x = x0; x <= x1; x++) for (let z = z0; z <= z1; z++) bot.setBlock(x, y, z, 'grass_block') }
// plain stone ground at y159 and a stone wall (the field's edge) so a work-site chest has somewhere to stand against
function ground(bot, { x0 = -1080, x1 = -1056, z0 = 2345, z1 = 2375, wallX = -1074 } = {}) {
  for (let x = x0; x <= x1; x++) for (let z = z0; z <= z1; z++) { if (bot.blockAt(new Vec3(x, 159, z)).name === 'air') bot.setBlock(x, 159, z, 'stone') }
  for (let z = z0; z <= z1; z++) for (const y of [160, 161, 162]) bot.setBlock(wallX, y, z, 'stone')
}
const row = (crop, age, n, x0 = -1070, z = 2358, y = 160) => Array.from({ length: n }, (_, i) => ({ crop, age, x: x0 + i, z, y }))

function rig({ pos = [-1060, 160, 2345], config = {}, sites, houseChest = true, night = false, legacy = {}, state: seedState = null, now, craft = null } = {}) {
  const bot = extendRoutines(mockBot({ pos }))
  if (night) bot.time.timeOfDay = 14000
  if (houseChest) bot.addChest(...HOUSE_CHEST, 54, {})
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rt-'))
  const file = path.join(dir, 'routines-state.json')
  const legacyRoutineFile = path.join(dir, 'routine-state.json'), legacySleepFile = path.join(dir, 'sleep-state.json')
  for (const [f, v] of Object.entries(legacy)) fs.writeFileSync(path.join(dir, f), JSON.stringify(v))
  const state = stateStore.load({ file, legacyRoutineFile, legacySleepFile })
  if (seedState) Object.assign(state.farm, seedState.farm || {}), Object.assign(state.sleep, seedState.sleep || {})
  const save = () => stateStore.save(file, state)
  const cfg = { ...baseConfig, farm: { ...baseConfig.farm, dropWaitMs: 0, plantWaitMs: 0, craftPollMs: 5, ...(config.farm || {}) }, sleep: { ...baseConfig.sleep, pollMs: 5, pingAfterMs: 30, giveUpAfterMs: 90, retryAfterGiveUpMs: 60, retryAfterFailureMs: 60, ...(config.sleep || {}) } }
  const said = []
  const nav = { stops: 0 }
  const sh = safehand({ bot })
  const common = { bot, say: (t) => said.push(t), goals: bot.goals, tryGoto: bot.tryGoto, safehand: sh, stopNav: () => { nav.stops++ }, config: cfg, state, save, now: now || Date.now }
  const farm = createFarm({ ...common, sitesFn: () => sites || [SITE], waypointFn: () => null, craft })
  const sleep = createSleep({ ...common, ownerName: 'OGWO' })
  const scheduler = new Scheduler({ graceMs: 300, idleAfterMs: 0 })
  const PR = PRIORITY
  const submitFarm = (opts = {}) => scheduler.submit({ name: 'farm', key: 'farm', priority: PR.CHAT, onUserStop: 'cancel', abort: () => farm.abort(), run: (ctx) => farm.run(ctx, opts) })
  const submitSleep = (opts = {}) => scheduler.submit({ name: 'sleep', key: 'sleep', priority: PR.SLEEP, onUserStop: 'cancel', abort: () => sleep.abort(), run: (ctx) => sleep.run(ctx, opts) })
  return { bot, farm, sleep, state, said, dir, file, legacyRoutineFile, legacySleepFile, scheduler, nav, cfg, sh, save, submitFarm, submitSleep, PR }
}

module.exports = { plantBamboo, grass, plantCane, ground, rig, extendRoutines, plantCrops, row, placed, blockName, ageAt, fakeCtx, waitFor, wait, SITE, HOUSE_CHEST, BED, baseConfig, PRIORITY, Scheduler }
