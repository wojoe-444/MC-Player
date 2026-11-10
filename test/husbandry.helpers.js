// Test rig for brain/husbandry: the shared mock bot plus a flat grass world, fences/gates/torches that can be placed, animals that follow food and can be fed, bred,
// sheared and hit, drops that are picked up by walking over them, and a stone wall where glow lichen can be placed, bone-mealed and sheared.
const fs = require('fs')
const os = require('os')
const path = require('path')
const { Vec3 } = require('vec3')
const { mockBot, mcData } = require('./mock-bot')
const los = require('../brain/los')
const createEngine = require('../brain/husbandry/engine')
const stateStore = require('../brain/husbandry/state')
const baseConfig = require('../brain/husbandry/config.json')
const herd = require('../brain/husbandry/herd')

const GROUND_Y = 63
const wait = (ms) => new Promise(r => setTimeout(r, ms))
const fakeCtx = (over = {}) => ({ state: {}, resumed: false, aborted: false, checkpoint() {}, progress() {}, onAbort: () => () => {}, sleep: wait, ...over })
const FOOD_OF = {}
for (const n of herd.NAMES) FOOD_OF[n] = herd.SPECIES[n].foods
const FACE_PROP = { '0,-1': 'south', '0,1': 'north', '1,0': 'west', '-1,0': 'east' }     // lichen on the wall behind it: the wall is at -f, so the face points that way

function extend(bot, opts) {
  const sim = { breeding: true, nextId: 1000, loves: {}, log: [], escapes: 0 }
  bot.sim = sim
  const key = (p) => `${Math.floor(p.x)},${Math.floor(p.y)},${Math.floor(p.z)}`
  const nameAt = (x, y, z) => bot.blockAt(new Vec3(x, y, z)).name
  const propsAt = (x, y, z) => bot.blockAt(new Vec3(x, y, z)).getProperties()

  // ---- placing ----
  bot.placeBlock = async (ref, face) => {
    const held = bot.heldItem; if (!held) throw new Error('nothing in hand')
    const dest = ref.position.plus(face)
    const eye = bot.entity.position.offset(0, 1.62, 0)
    if (eye.distanceTo(dest.offset(0.5, 0.5, 0.5)) > 6) throw new Error('too far to place')
    if (bot.blockAt(dest).name !== 'air' && !/^(short_grass|snow)$/.test(bot.blockAt(dest).name)) throw new Error('the cell is taken')
    if (bot.placeMode === 'timeout') { bot.setBlock(dest.x, dest.y, dest.z, held.name); bot.take(held.name, 1); throw new Error('Event blockUpdate did not fire within timeout') }   // placed but reported late
    const props = {}
    const clearRay = !!los.canSee(bot, ref)
    let name = held.name
    if (name === 'glow_lichen') { const k = `${face.x},${face.z}`; Object.assign(props, { [FACE_PROP[k] || 'north']: true }) }
    bot.setBlock(dest.x, dest.y, dest.z, name, props)
    bot.take(held.name, 1)
    bot.actions.push(['place', name, `${dest.x},${dest.y},${dest.z}`, Math.round(eye.distanceTo(dest.offset(0.5, 0.5, 0.5)) * 10) / 10, clearRay])
    bot.emit('blockPlaced', null, bot.blockAt(dest))
  }
  // ---- gates and bone meal ----
  bot.activateBlock = async (block) => {
    const p = block.position, b = bot.blockAt(p)
    bot.actions.push(['activate', b.name, `${p.x},${p.y},${p.z}`, bot.heldItem && bot.heldItem.name])
    if (/fence_gate$/.test(b.name)) { const pr = b.getProperties(); bot.setBlock(p.x, p.y, p.z, b.name, { ...pr, open: !pr.open }); return }
    if (b.name === 'glow_lichen' && bot.heldItem && bot.heldItem.name === 'bone_meal') {
      bot.take('bone_meal', 1)
      if (bot.growBlocked) return
      // spread: the first free neighbour in the wall's plane (same attached face), else a second face on the same block
      const pr = b.getProperties(), face = Object.keys(pr).find(k => pr[k]); const have = Object.keys(pr).filter(k => pr[k])
      for (const [dx, dy, dz] of [[1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1]]) {
        const q = new Vec3(p.x + dx, p.y + dy, p.z + dz)
        if (bot.blockAt(q).name !== 'air') continue
        const behind = { north: [0, 0, -1], south: [0, 0, 1], east: [1, 0, 0], west: [-1, 0, 0] }[face]
        if (!behind || bot.blockAt(q.offset(...behind)).name === 'air') continue
        bot.setBlock(q.x, q.y, q.z, 'glow_lichen', { [face]: true }); return
      }
      const extra = ['up', 'down'].find(f => !pr[f]); if (extra && have.length < 3) bot.setBlock(p.x, p.y, p.z, 'glow_lichen', { ...pr, [extra]: true })
    }
  }
  bot.dig = async (block) => {
    const p = block.position, b = bot.blockAt(p)
    if (b.name === 'glow_lichen') {
      if (!bot.heldItem || bot.heldItem.name !== 'shears') { bot.setBlock(p.x, p.y, p.z, 'air'); return }        // no drop without shears
      const faces = Object.values(b.getProperties()).filter(Boolean).length || 1
      bot.setBlock(p.x, p.y, p.z, 'air'); addDrop('glow_lichen', faces, p.offset(0.5, 0.2, 0.5))
    } else bot.setBlock(p.x, p.y, p.z, 'air')
  }

  // ---- entities ----
  const addDrop = (name, count, pos) => { const id = sim.nextId++; bot.entities[id] = { id, name: 'item', displayName: 'Item', type: 'other', position: pos, height: 0.25, itemName: name, count }; return id }
  bot.addAnimal = (name, x, z, { baby = false, sheared = false, y = 64 } = {}) => {
    const id = sim.nextId++
    const e = { id, name, type: 'animal', position: new Vec3(x + 0.5, y, z + 0.5), height: baby ? 0.7 : 1.4, health: 10, metadata: [] }
    if (baby) e.metadata[16] = true
    if (name === 'sheep') e.metadata[17] = sheared ? 0x10 : 0
    bot.entities[id] = e; return e
  }
  bot.animalsNamed = (name) => Object.values(bot.entities).filter(e => e.name === name)
  bot.addHostile = (name, x, z) => { const id = sim.nextId++; bot.entities[id] = { id, name, type: 'hostile', position: new Vec3(x + 0.5, 64, z + 0.5), height: 1.8 }; return bot.entities[id] }
  bot.nearestEntity = (match) => Object.values(bot.entities).filter(e => e !== bot.entity && match(e)).sort((a, b) => a.position.distanceTo(bot.entity.position) - b.position.distanceTo(bot.entity.position))[0] || null

  bot.activateEntity = async (e) => {
    const held = bot.heldItem; if (!held || !bot.entities[e.id]) return
    if (bot.entity.position.distanceTo(e.position) > 4) throw new Error('too far')
    bot.actions.push(['useOn', e.name, e.id, held.name])
    if (held.name === 'shears' && e.name === 'sheep' && !e.metadata[16] && !(e.metadata[17] & 0x10)) { e.metadata[17] |= 0x10; addDrop('white_wool', 2, e.position.offset(0, 0.3, 0)); return }
    if ((FOOD_OF[e.name] || []).includes(held.name) && !e.metadata[16]) {
      bot.take(held.name, 1)
      sim.loves[e.id] = Date.now()
      const mate = Object.values(bot.entities).find(o => o.id !== e.id && o.name === e.name && !o.metadata[16] && sim.loves[o.id] && Date.now() - sim.loves[o.id] < 30000 && o.position.distanceTo(e.position) < 8)
      if (mate && sim.breeding) {
        delete sim.loves[e.id]; delete sim.loves[mate.id]
        bot.addAnimal(e.name, Math.floor(e.position.x), Math.floor(e.position.z), { baby: true })
      }
    }
  }
  bot.attack = (e) => {
    bot.actions.push(['attack', e.name, e.id, bot.heldItem && bot.heldItem.name])
    if (!bot.entities[e.id]) return
    if (bot.entity.position.distanceTo(e.position) > 3.6) return                    // out of reach: a miss
    e.health -= /sword/.test((bot.heldItem && bot.heldItem.name) || '') ? 5 : 1
    if (e.health <= 0) { delete bot.entities[e.id]; const drop = { cow: 'beef', pig: 'porkchop', sheep: 'mutton', chicken: 'chicken' }[e.name]; if (drop) addDrop(drop, 1, e.position.offset(0, 0.2, 0)) }
  }

  // ---- walking: animals follow a bot that holds their food, but not through closed fences or gates ----
  const baseGoto = bot.tryGoto
  const blockedBetween = (a, b) => {
    const d = b.minus(a), n = Math.ceil(d.norm() * 4)
    for (let i = 1; i <= n; i++) {
      const p = a.plus(d.scaled(i / n)), x = Math.floor(p.x), z = Math.floor(p.z)
      for (const y of [64]) {
        const nm = nameAt(x, y, z)
        if (/_fence$/.test(nm)) return true
        if (/_fence_gate$/.test(nm) && !propsAt(x, y, z).open) return true
      }
    }
    return false
  }
  bot.tryGoto = async (goal, label = '') => {
    const old = bot.entity.position.clone()
    const held = bot.heldItem && bot.heldItem.name
    const r = await baseGoto(goal, label)
    const now = bot.entity.position
    // dropped items under the bot's feet are picked up
    for (const e of Object.values(bot.entities)) if (e.name === 'item' && e.position.distanceTo(now) < 1.6) { bot.give(e.itemName, e.count); delete bot.entities[e.id] }
    if (held) {
      for (const e of Object.values(bot.entities)) {
        if (!(FOOD_OF[e.name] || []).includes(held) || e.metadata[16]) continue
        if (e.position.distanceTo(old) > 9) continue
        const dir = now.minus(old); const len = dir.norm() || 1
        const target = now.minus(dir.scaled(1.5 / len)); target.y = e.position.y
        // followers walk the bot's trail: straight on when the way is open, otherwise to where the bot was and on from there (through the gate it opened)
        if (blockedBetween(e.position, target) && (blockedBetween(e.position, old) || blockedBetween(old, target))) continue
        e.position = target.offset(((e.id % 5) - 2) * 0.2, 0, ((e.id % 3) - 1) * 0.2)
      }
    }
    return r
  }
  return bot
}

// opts: pos, winter, config overrides
function rig({ pos = [5, 64, 5], inv = {}, config = {}, now = Date.now, craft = null, size = 60, winter = true, noSafehand = false } = {}) {
  const bot = extend(mockBot({ pos }))
  for (let x = -15; x <= size; x++) for (let z = -15; z <= size; z++) bot.setBlock(x, GROUND_Y, z, 'grass_block')
  for (const [k, n] of Object.entries(inv)) bot.give(k, n)
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'husb-'))
  const file = path.join(dir, 'husbandry-state.json')
  const state = stateStore.load({ file }); state.winter = winter
  const save = () => stateStore.save(file, state)
  const said = [], logs = []
  const C = JSON.parse(JSON.stringify(baseConfig))
  const merge = (a, b) => { for (const [k, v] of Object.entries(b)) { if (v && typeof v === 'object' && !Array.isArray(v)) merge(a[k] = a[k] || {}, v); else a[k] = v } return a }
  merge(C, { swingMs: 3, cullMsPerAnimal: 1500, lure: { hopWaitMs: 3, ms: 20000 }, breedWatch: { tries: 3, ms: 5 }, ...config })
  const engine = createEngine({
    bot, say: (t) => said.push(t), goals: bot.goals, tryGoto: bot.tryGoto, safehand: { ensureSafeForMove: async () => {} }, stopNav() {},
    canSee: (t) => los.canSee(bot, t), ensureLineOfSight: null, craft, config: C, state, save, now, log: (m) => logs.push(m)
  })
  return { bot, engine, state, said, logs, dir, file, C, save }
}
// a finished pen record (the fence ring is placed by the test through the blueprint when `build`)
function buildNow(bot, pen) {
  const bp = require('../brain/husbandry/blueprint')
  for (const s of bp.pen({ x: pen.ox, y: pen.oy, z: pen.oz }, { w: pen.w, d: pen.d, wood: pen.wood })) bot.setBlock(s.x, s.y, s.z, s.block, /gate/.test(s.block) ? { open: false } : {})
}
const PEN = { id: 'pen1', ox: 10, oy: 64, oz: 10, w: 7, d: 7, wood: 'birch', built: true, lit: true }

module.exports = { rig, extend, fakeCtx, wait, buildNow, PEN, GROUND_Y, mcData }
