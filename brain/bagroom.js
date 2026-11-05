// Bag room: keep the bag from filling up. Whenever fewer than `minFree` slots are free (before a job starts, and by a routine every 20 s) it
//   1. sends smeltables to the furnace input chests (api.depositSmeltables, honours brain/state/reserved.json);
//   2. stashes everything that is not needed into the nearest base chests with space (Walter, 04:34: "any of the chests in the base are fine"):
//      the mine storage chests (brain/mining/config.json), the house chest, and any other chest/barrel within `radius` blocks, except the furnace stations'
//      own fuel/input/output chests. Worn armor, tools, food, torches, ladders, planks/logs/sticks, ingots, buckets, cobblestone (above the 48 reserve is
//      smeltable), reserved.json amounts and the seeds/food stack the farm needs stay on the bot.
//   3. nothing is ever thrown on the ground; if every chest is full the job starts anyway and Walter is told once.
const fs = require('fs')
const path = require('path')
const { Vec3 } = require('vec3')
const smeltables = require('./smeltables')

const KEEP = new RegExp([
  '_(pickaxe|axe|shovel|hoe|sword)$', '^(shield|bow|crossbow|arrow|spectral_arrow|trident|fishing_rod|flint_and_steel|shears|elytra|compass|clock|map|filled_map|lead|name_tag)$',
  '(^|_)bucket$', '^torch$', '^soul_torch$', '^lantern$', '^ladder$', '^crafting_table$', '^furnace$', '^chest$', '^barrel$', '^bed$|_bed$',
  '_planks$', '^stick$', '_log$', '_ingot$', '^netherite_scrap$', '^golden_apple$', '^enchanted_golden_apple$', '^totem_of_undying$', '^ender_pearl$',
  '^white_wool$', '^bone_meal$'
].join('|'))
const ARMOR = /^(netherite|diamond|iron|chainmail|golden|leather|turtle)_(helmet|chestplate|leggings|boots)$/
const SEEDS = /^(wheat_seeds|beetroot_seeds|melon_seeds|pumpkin_seeds|torchflower_seeds|pitcher_pod)$/
const KEEP_COAL = 16, KEEP_SAPLINGS = 16, KEEP_SEEDS = 16, KEEP_WHEAT = 16, KEEP_FOOD = 64

// inventory: [{name,count}] (worn armor is not in the inventory list) -> [{name,count}] to stash in chests.
function plan(inventory, opts = {}) {
  let reserved = opts.reserved
  if (!reserved) { try { reserved = JSON.parse(fs.readFileSync(path.join(__dirname, 'state', 'reserved.json'), 'utf8').replace(/^﻿/, '')) } catch { reserved = {} } }
  const total = {}
  for (const it of inventory) total[it.name] = (total[it.name] || 0) + it.count
  for (const [n, k] of Object.entries(reserved)) if (typeof k === 'number' && total[n]) total[n] = Math.max(0, total[n] - k)
  let saplings = 0, foodRoom = KEEP_FOOD
  const out = []
  // food: cooked food first (best first), then bread/crops; the stack the bot keeps is 64 in total, the rest is stashed
  const FOOD_ORDER = [...smeltables.COOKED_FOOD]
  const foodKeep = {}
  for (const n of FOOD_ORDER) { if (!total[n]) continue; const k = Math.min(total[n], foodRoom); foodKeep[n] = k; foodRoom -= k }
  for (const [name, count] of Object.entries(total)) {
    let n = 0
    if (ARMOR.test(name)) n = count                                   // spare armor (the worn pieces are not in the inventory list)
    else if (name === 'coal' || name === 'charcoal') n = Math.max(0, count - KEEP_COAL)
    else if (/_sapling$|^mangrove_propagule$/.test(name)) { const keep = Math.min(count, Math.max(0, KEEP_SAPLINGS - saplings)); saplings += keep; n = count - keep }
    else if (SEEDS.test(name)) n = Math.max(0, count - KEEP_SEEDS)
    else if (name === 'wheat') n = Math.max(0, count - KEEP_WHEAT)
    else if (name in foodKeep) n = total[name] - foodKeep[name]
    else if (name === 'potato') n = 0                                    // seed potatoes: smeltables.plan keeps 16 and handles the rest
    else if (KEEP.test(name) || smeltables.isSmeltable(name)) n = 0
    else n = count
    if (n > 0) out.push({ name, count: n })
  }
  return out
}

function install({ bot, api, say, log = () => {}, now = Date.now, minFree = 6, targetFree = 12, storageChests = null, radius = 48, maxChests = 8, cooldownMs = 2 * 60000, furnaceConfig = null }) {
  const mining = (storageChests || (() => { try { return require('./mining/config.json').storageChests } catch { return [] } })()).map(a => new Vec3(a[0], a[1], a[2]))
  const house = new Vec3(-1064, 160, 2326)
  let fcfg = furnaceConfig
  if (!fcfg) { try { fcfg = require('./furnace-config.json') } catch { fcfg = { stations: [] } } }
  // the furnace stations' own chests (fuel/input/output, including the other half of a double chest) are never used as a stash
  const forbidden = new Set()
  const k3 = (p) => `${p[0]},${p[1]},${p[2]}`
  for (const st of fcfg.stations || []) for (const u of st.units || []) for (const role of ['fuel', 'input', 'output']) {
    const p = u[role]; if (!p) continue
    for (const [dx, dz] of [[0, 0], [1, 0], [-1, 0], [0, 1], [0, -1]]) forbidden.add(k3([p[0] + dx, p[1], p[2] + dz]))
  }
  let lastTry = 0, lastWarn = 0
  const free = () => bot.inventory.emptySlotCount()
  const have = (n) => bot.inventory.items().filter(i => i.name === n).reduce((s, i) => s + i.count, 0)
  const sleep = (ms) => new Promise(r => setTimeout(r, ms))
  const itemId = (n) => bot.registry.itemsByName[n].id
  const dist = (p) => bot.entity.position.distanceTo(p)

  function candidates() {
    const seen = new Set(), out = []
    const add = (p) => {
      const k = k3([p.x, p.y, p.z]); if (seen.has(k) || forbidden.has(k)) return
      // the other half of a double chest is the same container
      for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) if (seen.has(k3([p.x + dx, p.y, p.z + dz]))) { seen.add(k); return }
      seen.add(k); out.push(p)
    }
    for (const p of mining) add(p)
    add(house)
    try {
      const ids = ['chest', 'barrel', 'trapped_chest'].map(n => bot.registry.blocksByName[n] && bot.registry.blocksByName[n].id).filter(Boolean)
      for (const p of bot.findBlocks({ matching: ids, maxDistance: radius, count: 60 })) add(p)
    } catch {}
    return out.sort((a, b) => dist(a) - dist(b)).slice(0, maxChests + 4)
  }

  async function storeSpare(ctx) {
    const moved = {}
    let visited = 0
    for (const pos of candidates()) {
      if (free() >= targetFree || visited >= maxChests) break
      const todo = plan(bot.inventory.items())
      if (!todo.length) break
      ctx && ctx.checkpoint()
      try { if (!(await api.gotoNear({ pos, ctx, label: 'a base chest', ms: 60000 }))) continue } catch (e) { if (e && e.name === 'AbortError') throw e; continue }
      const blk = bot.blockAt(pos)
      if (!blk || !/chest|barrel/.test(blk.name)) continue
      if (api.ensureLineOfSight && !(await api.ensureLineOfSight({ ctx, target: blk, label: 'the chest' }))) continue
      visited++
      let win, misses = 0
      try {
        win = await bot.openContainer(blk)
        for (const t of todo) {
          if (free() >= targetFree || misses >= 3) break
          const before = have(t.name)
          try { await win.deposit(itemId(t.name), null, t.count) } catch (e) { log(`bag-room: deposit ${t.name}: ${e.message}`) }
          for (let i = 0; i < 8 && have(t.name) === before; i++) await sleep(100)
          await sleep(120)
          const got = before - have(t.name)
          if (got > 0) { moved[t.name] = (moved[t.name] || 0) + got; misses = 0 } else misses++
        }
      } catch (e) { log('bag-room: ' + e.message) } finally { try { win && win.close() } catch {} }
    }
    return moved
  }

  // Before a task starts, and from the routine.
  async function makeRoom(ctx, task) {
    if (free() >= minFree) return { skipped: true }
    if (now() - lastTry < cooldownMs && free() >= 3) return { skipped: 'cooldown' }
    lastTry = now()
    const before = free()
    log(`bag-room: ${free()} free slots (${task && task.name}); making room`)
    const result = { smelt: {}, stored: {} }
    try {
      if (api.depositSmeltables) { const r = await api.depositSmeltables({ ctx, force: true, quiet: true }); result.smelt = r.moved || {} }
      if (free() < minFree) result.stored = await storeSpare(ctx)
    } catch (e) { if (e && e.name === 'AbortError') throw e; log('bag-room failed: ' + e.message) }
    const gained = free() - before
    const bits = [...Object.entries(result.smelt), ...Object.entries(result.stored)].map(([n, c]) => `${c} ${n}`)
    if (bits.length) { say(`Made room (${gained} slots): ${bits.slice(0, 5).join(', ')}${bits.length > 5 ? ', ...' : ''}.`.slice(0, 220)); log('bag-room: ' + bits.join(', ')) }
    if (free() < 3 && now() - lastWarn > 10 * 60000) { lastWarn = now(); say(`My bag is nearly full (${free()} free) and the chests around had no room or were out of reach. Tell me where to put things.`.slice(0, 220)) }
    return result
  }

  return { makeRoom, plan: () => plan(bot.inventory.items()), candidates, free }
}

module.exports = install
module.exports.plan = plan
module.exports.KEEP = KEEP
