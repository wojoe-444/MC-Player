// Minimal in-memory stand-in for a mineflayer bot, enough to exercise brain/ modules offline.
// Uses the real 1.21.6 registry from minecraft-data so item/block names and ids are genuine.
const EventEmitter = require('events')
const { Vec3 } = require('vec3')
const mcData = require('minecraft-data')('1.21.6')

const STACK = { bucket: 16, lava_bucket: 1, water_bucket: 1, cobblestone: 64, stone: 64, glass: 64, smooth_stone: 64 }
const stackOf = (n) => STACK[n] || (/_sword|_pickaxe|_axe$/.test(n) ? 1 : 64)

function mockBot(opts = {}) {
  const bot = new EventEmitter()
  bot.registry = mcData
  bot.version = '1.21.6'
  bot.entity = { position: new Vec3(...(opts.pos || [0, 64, 0])), onGround: true, yaw: 0, pitch: 0, height: 1.8 }
  bot.health = opts.health ?? 20
  bot.food = opts.food ?? 20
  bot.game = { dimension: 'overworld', gameMode: 'survival' }
  bot.time = { timeOfDay: 1000, day: 7 }
  bot.username = 'OzoGo444'
  bot.players = {}
  bot.entities = {}
  bot.isSleeping = false
  bot.heldItem = null
  bot.controlStates = {}
  bot.clearControlStates = () => { bot.controlStates = {} }
  bot.setControlState = (k, v) => { bot.controlStates[k] = v }
  bot.pathfinder = { _goal: null, setGoal(g) { this._goal = g }, isMoving() { return !!this._goal }, setMovements() {} }
  bot.actions = []   // everything the module did, for assertions

  // ---- inventory ----
  const slots = []            // plain list of {name,count}
  const mkItem = (name, count) => ({ name, count, type: mcData.itemsByName[name].id, displayName: name })
  bot.inventory = {
    items: () => slots.filter(Boolean),
    emptySlotCount: () => 36 - slots.filter(Boolean).length,
    _slots: slots
  }
  bot.give = (name, count = 1) => {
    let left = count
    for (const s of slots) { if (s && s.name === name && s.count < stackOf(name) && left > 0) { const a = Math.min(left, stackOf(name) - s.count); s.count += a; left -= a } }
    while (left > 0) { const a = Math.min(left, stackOf(name)); slots.push(mkItem(name, a)); left -= a }
  }
  bot.take = (name, count) => {
    let left = count
    for (const s of [...slots]) { if (s && s.name === name && left > 0) { const a = Math.min(left, s.count); s.count -= a; left -= a; if (!s.count) slots.splice(slots.indexOf(s), 1) } }
    if (bot.heldItem && !slots.includes(bot.heldItem)) bot.heldItem = null
    return count - left
  }
  bot.count = (name) => slots.filter(s => s && s.name === name).reduce((a, s) => a + s.count, 0)
  bot.equip = async (item, dest) => {
    if (typeof item === 'string') item = slots.find(s => s && s.name === item)
    if (!item) throw new Error('no item to equip')
    bot.heldItem = item; bot.actions.push(['equip', item.name]); bot.emit('heldItemChanged', item)
  }
  bot.unequip = async () => { bot.heldItem = null; bot.actions.push(['unequip']); bot.emit('heldItemChanged', null) }

  // ---- world ----
  const blocks = new Map()    // "x,y,z" -> {name, props}
  const k = (p) => `${p.x},${p.y},${p.z}`
  bot.setBlock = (x, y, z, name, props = {}) => blocks.set(`${x},${y},${z}`, { name, props })
  bot.blockAt = (p) => {
    // like real mineflayer: a plain {x,y,z} object throws "pos.floored is not a function"
    if (!p || typeof p.floored !== 'function') throw new TypeError('pos.floored is not a function')
    const b = blocks.get(k(p)); const name = b ? b.name : 'air'
    return { name, position: new Vec3(p.x, p.y, p.z), type: mcData.blocksByName[name]?.id, getProperties: () => (b ? b.props : {}), boundingBox: name === 'air' ? 'empty' : 'block' }
  }
  bot.findBlocks = ({ matching, maxDistance = 32, count = 1 }) => {
    const ids = new Set([].concat(matching)); const out = []
    for (const [key, b] of blocks) {
      const id = mcData.blocksByName[b.name]?.id
      if (!ids.has(id)) continue
      const [x, y, z] = key.split(',').map(Number)
      if (bot.entity.position.distanceTo(new Vec3(x, y, z)) <= maxDistance) out.push(new Vec3(x, y, z))
    }
    return out.slice(0, count)
  }
  // minimal raycast: first non-air block along the segment (stepping 0.05), like bot.world.raycast
  bot.world = {
    raycast(from, dir, range) {
      const start = `${Math.floor(from.x)},${Math.floor(from.y)},${Math.floor(from.z)}`   // the eye is in air: ignore the cell it starts in (the mock teleports the bot onto block coordinates)
      for (let t = 0; t <= range; t += 0.05) {
        const p = from.plus(dir.scaled(t)), fp = new Vec3(Math.floor(p.x), Math.floor(p.y), Math.floor(p.z))
        if (k(fp) === start) continue
        const b = blocks.get(k(fp)); if (b && b.name !== 'air') return { position: fp, name: b.name }
      }
      return null
    }
  }
  bot.lookAt = async () => {}
  bot.canSeeBlock = () => true

  // ---- containers ----
  const chests = new Map()    // key -> {slots: [{name,count}|null], size}
  bot.addChest = (x, y, z, size = 27, items = {}) => {
    const c = { size, slots: Array(size).fill(null) }
    for (const [n, cnt] of Object.entries(items)) {
      let left = cnt
      while (left > 0) { const a = Math.min(left, stackOf(n)); c.slots[c.slots.findIndex(s => !s)] = { name: n, count: a }; left -= a }
    }
    chests.set(`${x},${y},${z}`, c); blocks.set(`${x},${y},${z}`, { name: 'chest', props: {} })
    return c
  }
  bot.chestItems = (x, y, z) => { const t = {}; for (const s of chests.get(`${x},${y},${z}`).slots) if (s) t[s.name] = (t[s.name] || 0) + s.count; return t }
  bot.openContainer = async (block) => {
    const c = chests.get(k(block.position))
    if (!c) throw new Error('no container at ' + k(block.position))
    if (bot.entity.position.distanceTo(block.position.offset(0.5, 0.5, 0.5)) > 5) throw new Error('too far to open ' + k(block.position))
    bot.actions.push(['open', k(block.position)])
    const items = () => c.slots.filter(Boolean).map(s => ({ ...s, type: mcData.itemsByName[s.name].id }))
    return {
      inventoryStart: c.size,
      slots: c.slots,
      containerItems: items,
      async withdraw(type, meta, count) {
        const name = mcData.items[type].name; let left = count
        for (let i = 0; i < c.slots.length && left > 0; i++) { const s = c.slots[i]; if (s && s.name === name) { const a = Math.min(left, s.count); s.count -= a; left -= a; if (!s.count) c.slots[i] = null } }
        if (left === count) throw new Error('nothing to withdraw')
        bot.give(name, count - left); bot.actions.push(['withdraw', name, count - left, k(block.position)])
      },
      async deposit(type, meta, count) {
        const name = mcData.items[type].name
        const have = bot.count(name); const n = Math.min(count, have); if (!n) throw new Error('nothing to deposit')
        let left = n
        for (const s of c.slots) { if (s && s.name === name && s.count < stackOf(name) && left > 0) { const a = Math.min(left, stackOf(name) - s.count); s.count += a; left -= a } }
        while (left > 0) { const i = c.slots.findIndex(s => !s); if (i < 0) break; const a = Math.min(left, stackOf(name)); c.slots[i] = { name, count: a }; left -= a }
        if (left === n) throw new Error('chest full')
        bot.take(name, n - left); bot.actions.push(['deposit', name, n - left, k(block.position)])
      },
      close() { bot.actions.push(['close', k(block.position)]) }
    }
  }

  // ---- cauldrons: empty bucket + lava_cauldron -> lava bucket + cauldron ----
  bot.activateBlock = async (block) => {
    const b = blocks.get(k(block.position)); bot.actions.push(['activate', block.name, k(block.position), bot.heldItem && bot.heldItem.name])
    if (b && b.name === 'lava_cauldron' && bot.heldItem && bot.heldItem.name === 'bucket') {
      const held = bot.heldItem
      held.count -= 1
      if (held.count === 0) { slots.splice(slots.indexOf(held), 1); slots.push(mkItem('lava_bucket', 1)); bot.heldItem = slots[slots.length - 1] }   // last bucket: lava ends up in hand
      else slots.push(mkItem('lava_bucket', 1))
      blocks.set(k(block.position), { name: 'cauldron', props: {} })
    }
  }
  bot.lavaHeldWhileMoving = []
  // goals / goto
  bot.goals = {
    GoalNear: class { constructor(x, y, z, r) { Object.assign(this, { x, y, z, r }) } },
    GoalFollow: class { constructor(e, r) { this.entity = e; this.r = r } },
    GoalInvert: class { constructor(g) { this.goal = g } },
    GoalBlock: class { constructor(x, y, z) { Object.assign(this, { x, y, z }) } },
    GoalNearXZ: class { constructor(x, z, r) { Object.assign(this, { x, z, r }) } }
  }
  // tryGoto teleports next to the goal, and records whether lava was held "while walking"
  bot.tryGoto = async (goal, label = '') => {
    if (bot.heldItem && bot.heldItem.name === 'lava_bucket') bot.lavaHeldWhileMoving.push(label)
    bot.actions.push(['goto', label, goal.x, goal.y, goal.z])
    if (goal.x !== undefined) bot.entity.position = new Vec3(goal.x + 0.5, goal.y, goal.z + 0.5)
    return { ok: true, secs: 0.1 }
  }
  bot.attack = (e) => { bot.actions.push(['attack', e.name]) }
  bot.chatLog = []
  bot.say = (t) => bot.chatLog.push(t)
  return bot
}

module.exports = { mockBot, mcData }
