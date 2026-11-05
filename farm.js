// Farm harvesting + eating, per Walter: take food from his farm, always replant what is taken (carrots can be eaten directly,
// wheat becomes bread). Only mature crops over farmland are touched. Immature crops and everything else are left alone.
const Vec3 = require('vec3').Vec3
const fs = require('fs')

const CROPS = {
  wheat: { maxAge: 7, seed: 'wheat_seeds' },
  carrots: { maxAge: 7, seed: 'carrot' },
  potatoes: { maxAge: 7, seed: 'potato' },
  beetroots: { maxAge: 3, seed: 'beetroot_seeds' }
}
const FOOD_ORDER = ['cooked_beef', 'cooked_porkchop', 'cooked_mutton', 'cooked_chicken', 'cooked_salmon', 'cooked_cod', 'baked_potato', 'bread', 'golden_carrot', 'carrot', 'apple', 'melon_slice', 'beetroot', 'sweet_berries']
const STACK_GOAL = 64

module.exports = function install({ bot, say, goals, tryGoto }) {
  let busy = false, stopFlag = false, eating = false
  const sleep = (ms) => new Promise(r => setTimeout(r, ms))
  const count = (name) => bot.inventory.items().filter(i => i.name === name).reduce((s, i) => s + i.count, 0)
  const foodCount = () => FOOD_ORDER.reduce((s, n) => s + count(n), 0)

  async function eatIfHungry() {
    if (eating || !bot.entity || bot.food === undefined || bot.food > 14 || bot.isSleeping || bot.noAutoEat) return
    const item = FOOD_ORDER.map(n => bot.inventory.items().find(i => i.name === n)).find(Boolean)
    if (!item) return
    eating = true
    try { await bot.equip(item, 'hand'); await bot.consume() } catch (e) { /* interrupted or full */ } finally { eating = false }
  }
  setInterval(() => eatIfHungry().catch(() => {}), 4000)

  async function collectNear(p) {
    for (let i = 0; i < 6; i++) {
      const it = bot.nearestEntity(e => e.name === 'item' && e.position.distanceTo(p) < 5)
      if (!it) return
      await tryGoto(new goals.GoalNear(it.position.x, it.position.y, it.position.z, 0.7), 'a drop', 4000)
    }
  }

  async function harvest(opts = {}) {
    if (busy) return say('Already harvesting.')
    busy = true; stopFlag = false
    const got = {}, replanted = {}
    let skippedNoSeed = 0, actions = 0
    try {
      const origin = bot.entity.position.clone()
      const cropIds = Object.keys(CROPS).map(n => bot.registry.blocksByName[n]?.id).filter(Boolean)
      const mature = () => bot.findBlocks({ matching: cropIds, maxDistance: 40, count: 400 }).filter(p => {
        const b = bot.blockAt(p); if (!b || !CROPS[b.name]) return false
        const floor = bot.blockAt(p.offset(0, -1, 0)); if (!floor || floor.name !== 'farmland') return false
        const age = b.getProperties().age
        return age >= CROPS[b.name].maxAge
      }).sort((a, b) => a.distanceTo(origin) - b.distanceTo(origin))
      const first = mature()
      if (!first.length) { say('I do not see any ripe crops within 40 blocks of here.'); return }
      say(`Found ${first.length} ripe crops. Harvesting and replanting, aiming for about a stack of food.`)
      for (let p of first) {
        if (stopFlag) break
        if (foodCount() >= STACK_GOAL && actions >= 20) break
        if (actions >= 150) break
        const b = bot.blockAt(p)
        if (!b || !CROPS[b.name] || b.getProperties().age < CROPS[b.name].maxAge) continue
        const name = b.name, seed = CROPS[name].seed
        const r = await tryGoto(new goals.GoalNear(p.x, p.y, p.z, 2), 'a crop', 15000)
        if (!r.ok) continue
        const farmland = bot.blockAt(p.offset(0, -1, 0))
        const before = { [seed]: count(seed) }
        try {
          await bot.dig(b, true)
          actions++
          got[name] = (got[name] || 0) + 1
          await sleep(350)
          await collectNear(p.offset(0.5, 0, 0.5))
          const s = bot.inventory.items().find(i => i.name === seed)
          if (!s) { skippedNoSeed++; continue }
          await bot.equip(s, 'hand')
          await bot.placeBlock(farmland, new Vec3(0, 1, 0))
          replanted[name] = (replanted[name] || 0) + 1
        } catch (e) { console.log('FARM_ERROR', name, p.toString(), e.message) }
      }
      const g = Object.entries(got).map(([n, c]) => `${c} ${n}`).join(', ') || 'nothing'
      const rp = Object.entries(replanted).map(([n, c]) => `${c} ${n}`).join(', ') || 'nothing'
      say(`Harvest done. Picked ${g}; replanted ${rp}${skippedNoSeed ? `; ${skippedNoSeed} could not be replanted (no seed left)` : ''}. Food on me: ${foodCount()}. Wheat: ${count('wheat')}.`)
    } catch (e) {
      say(`Harvest stopped: ${e.message}`.slice(0, 200)); console.log('HARVEST_ERROR', e.stack)
    } finally { busy = false }
    if (opts.store && !stopFlag) { try { await storeCrops() } catch (e) { say(`Storing failed: ${e.message}`.slice(0, 160)) } }
  }

  // After harvesting, put the crops in a chest in Walter's house. Keeps a stack of food (64) and 16 of each seed for replanting.
  const CROP_ITEMS = new Set(['wheat', 'carrot', 'potato', 'beetroot', 'wheat_seeds', 'beetroot_seeds', 'poisonous_potato', 'baked_potato', 'bread'])
  const KEEP_FOOD = 64, KEEP_SEED = 16
  function findHouseChest() {
    let ref = new Vec3(-1068, 159, 2337) // Xaero waypoint "House"
    try { const w = JSON.parse(fs.readFileSync('waypoints.json', 'utf8').replace(/^﻿/, '')); if (w.house) ref = new Vec3(w.house.x, w.house.y, w.house.z) } catch {}
    const ids = ['chest', 'barrel'].map(n => bot.registry.blocksByName[n].id)
    const pts = bot.findBlocks({ matching: ids, maxDistance: 160, count: 300 }).filter(p => p.distanceTo(ref) <= 30 && Math.abs(p.y - ref.y) <= 8)
    pts.sort((a, b) => a.distanceTo(ref) - b.distanceTo(ref))
    return pts[0] ? bot.blockAt(pts[0]) : null
  }
  async function storeCrops() {
    const chest = findHouseChest()
    if (!chest) { say('I could not find a chest within 30 blocks of the house to store the crops in.'); return false }
    const r = await tryGoto(new goals.GoalNear(chest.position.x, chest.position.y, chest.position.z, 3), 'the house chest', 90000)
    if (!r.ok && bot.entity.position.distanceTo(chest.position.offset(0.5, 0.5, 0.5)) > 4.8) { say(`I could not reach the house chest (${r.err}).`); return false }
    const moved = {}
    let cont
    try {
      cont = await bot.openContainer(chest)
      let foodLeft = KEEP_FOOD
      for (const it of bot.inventory.items()) {
        if (!CROP_ITEMS.has(it.name)) continue
        let n = it.count
        if (FOOD_ORDER.includes(it.name)) { const keep = Math.min(n, foodLeft); foodLeft -= keep; n -= keep }
        else if (it.name.endsWith('_seeds')) n = Math.max(0, n - KEEP_SEED)
        if (n > 0) { try { await cont.deposit(it.type, null, n); moved[it.name] = (moved[it.name] || 0) + n } catch (e) { say(`The chest is full or refused ${it.name}: ${e.message}`.slice(0, 160)); break } }
      }
    } catch (e) { say(`Could not open the house chest: ${e.message}`.slice(0, 160)); return false } finally { if (cont) cont.close() }
    const d = Object.entries(moved).map(([n, c]) => `${c} ${n}`).join(', ')
    say(d ? `Stored in the house chest at ${chest.position.x}, ${chest.position.y}, ${chest.position.z}: ${d}. I kept ${Math.min(KEEP_FOOD, foodCount())} food.` : 'Nothing extra to store; I kept the food I need.')
    return true
  }

  return { harvest, storeCrops, stop: () => { stopFlag = true }, isBusy: () => busy, foodCount }
}
