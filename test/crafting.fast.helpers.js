// A toy server for brain/crafting's fast path: recipe book (displays), craft_recipe_request, shift-click on the result slot, windows for the
// table and the bag grid, and a per-click latency, so the number of round trips can be compared with mineflayer's click-by-click craft().
// Assumptions about vanilla (documented in brain/crafting/README.md): a request with makeAll=false fills one set, and adds one more set to a
// grid that already holds that recipe; shift-click on the result crafts as many sets as the grid holds.
const EventEmitter = require('events')
const { mcData } = require('./mock-bot')
const Recipe = require('prismarine-recipe')(mcData).Recipe

const sleep = (ms) => new Promise(r => setTimeout(r, ms))
const nameOf = (id) => mcData.items[id].name

// A table / bag window with the slot layout of the real ones: 0 result, 1..9 (or 1..4) grid.
function makeWindow(id, type) { const w = new EventEmitter(); Object.assign(w, { id, type, slots: new Array(46).fill(null), selectedItem: null }); return w }

function addFastServer(bot, { latency = 0, items = [], tagged = true, mode = 'vanilla', slowModel = true } = {}) {
  const stats = { clicks: 0, requests: 0, opens: 0, slowCrafts: 0, slowClicks: 0, ms: 0 }
  bot.fastStats = stats
  bot._client = new EventEmitter()
  bot._recipeBook = new Map()
  bot.inventory.id = 0
  bot.inventory.type = 'minecraft:inventory'
  bot.inventory.slots = new Array(46).fill(null)
  bot.currentWindow = null

  // recipe book: one display per item (tag ingredients when the item has several variants, like the real server)
  const byDisplay = new Map()
  let nextId = 1
  for (const name of items) {
    const id = mcData.itemsByName[name].id
    const variants = Recipe.find(id, null)
    if (!variants.length) continue
    const r0 = variants[0]
    const shaped = !!r0.inShape
    const ingredients = shaped ? r0.inShape.flat().map(x => (x.id === -1 ? { type: 'empty' } : (tagged && variants.length > 1 ? { type: 'tag', data: 'minecraft:any' } : { type: 'item', data: x.id }))) : r0.ingredients.map(x => ({ type: 'item', data: x.id }))
    const display = { type: shaped ? 'crafting_shaped' : 'crafting_shapeless', data: { width: shaped ? Math.max(...r0.inShape.map(r => r.length)) : undefined, height: shaped ? r0.inShape.length : undefined, ingredients, result: { type: 'item', data: id }, craftingStation: { type: 'empty' } } }
    const did = nextId++
    bot._recipeBook.set(did, display)
    byDisplay.set(did, { variants, shaped })
  }

  const gridSlots = (w) => (w === bot.inventory ? [1, 2, 3, 4] : [1, 2, 3, 4, 5, 6, 7, 8, 9])
  const widthOf = (w) => (w === bot.inventory ? 2 : 3)
  const layoutOf = (rec, w) => {   // grid slot -> ingredient id for one set of the recipe
    const out = new Map()
    if (rec.inShape) rec.inShape.forEach((row, y) => row.forEach((x, xi) => { if (x.id !== -1) out.set(1 + xi + widthOf(w) * y, x.id) }))
    else rec.ingredients.forEach((x, i) => out.set(1 + i, x.id))
    return out
  }
  const updateResult = (w) => {
    // result = the recipe whose layout matches the grid
    w.slots[0] = null
    for (const { variants } of byDisplay.values()) for (const rec of variants) {
      const lay = layoutOf(rec, w)
      const ok = gridSlots(w).every(s => (lay.has(s) ? w.slots[s] && mcData.itemsByName[w.slots[s].name].id === lay.get(s) : !w.slots[s]))
      if (ok && lay.size) { w.slots[0] = { name: nameOf(rec.result.id), count: rec.result.count, rec }; return }
    }
  }
  const win = () => bot.currentWindow || bot.inventory

  bot._client.write = (packet, data) => {
    if (packet !== 'craft_recipe_request') return
    stats.requests++
    const w = win()
    if (data.windowId !== w.id) return
    const entry = byDisplay.get(data.recipeId)
    if (!entry) return
    if (mode === 'ignore') return
    const grid = gridSlots(w)
    const filled = grid.filter(s => w.slots[s])
    // does the grid already hold one of this recipe's layouts?
    let rec = null
    if (filled.length) {
      for (const v of entry.variants) { const lay = layoutOf(v, w); if (lay.size === filled.length && [...lay].every(([s, i]) => w.slots[s] && mcData.itemsByName[w.slots[s].name].id === i)) { rec = v; break } }
      if (!rec) { for (const s of filled) { bot.give(w.slots[s].name, w.slots[s].count); w.slots[s] = null } }
    }
    const maxSets = (v) => { const lay = layoutOf(v, w); const need = new Map(); for (const i of lay.values()) need.set(i, (need.get(i) || 0) + 1); return Math.max(0, Math.min(64, ...[...need].map(([i, k]) => Math.floor(bot.count(nameOf(i)) / k)))) }
    const add = (v, n) => {
      const lay = layoutOf(v, w)
      if (n < 1 || maxSets(v) < n) return false
      for (const [s, i] of lay) { const nm = nameOf(i); bot.take(nm, n); w.slots[s] = w.slots[s] ? { ...w.slots[s], count: w.slots[s].count + n } : { name: nm, count: n } }
      return true
    }
    if (rec) {
      const cur = Math.min(...[...layoutOf(rec, w).keys()].map(s => w.slots[s].count))
      if (cur < 64) add(rec, mode === 'fillmax' ? maxSets(rec) : 1)
    } else {
      // first variant the bag can supply (the server picks from what the player holds)
      for (const v of entry.variants) { if (add(v, mode === 'fillmax' ? maxSets(v) : 1)) break }
    }
    updateResult(w)
  }

  bot.clickWindow = async (slot, button, mode) => {
    const w = win()
    stats.clicks++; stats.ms += latency
    if (latency) await sleep(latency)
    if (mode === 1 && slot === 0 && w.slots[0]) {
      const r = w.slots[0].rec
      const lay = layoutOf(r, w)
      const sets = Math.min(...[...lay.keys()].map(s => w.slots[s].count))
      bot.give(nameOf(r.result.id), sets * r.result.count)
      for (const s of lay.keys()) { w.slots[s].count -= sets; if (!w.slots[s].count) w.slots[s] = null }
      updateResult(w)
    } else if (mode === 1 && slot >= 1 && slot <= 9 && w.slots[slot]) {
      bot.give(w.slots[slot].name, w.slots[slot].count); w.slots[slot] = null; updateResult(w)
    }
  }
  bot.activateBlock = async (block) => {
    stats.opens++; stats.ms += latency
    if (latency) await sleep(latency)
    const w = makeWindow(7, 'minecraft:crafting')
    bot.currentWindow = w
    setImmediate(() => bot.emit('windowOpen', w))
  }
  bot.closeWindow = (w) => {
    for (const s of gridSlots(w)) if (w.slots[s]) { bot.give(w.slots[s].name, w.slots[s].count); w.slots[s] = null }
    w.slots[0] = null
    if (bot.currentWindow === w) bot.currentWindow = null
  }

  // the slow way, mineflayer's craft(): its click count per craft, modelled from the algorithm in plugins/craft.js
  // (pick up + place for every filled slot, put the rest away, take the result, put it away) plus opening the table
  if (slowModel) {
    const realCraft = bot.craft
    bot.craft = async (recipe, count, table) => {
      const occupied = recipe.inShape ? recipe.inShape.flat().filter(x => x.id !== -1) : recipe.ingredients
      const kinds = new Set(occupied.map(x => x.id)).size
      const picks = kinds === 1 ? 1 : occupied.length
      const clicks = picks + occupied.length + 1 + 2
      stats.slowCrafts += count; stats.slowClicks += clicks * count
      if (table) { stats.opens++; stats.ms += latency; if (latency) await sleep(latency) }
      if (latency) await sleep(latency * clicks * count)
      stats.ms += latency * clicks * count
      return realCraft(recipe, count, table)
    }
  }
  return bot
}

module.exports = { addFastServer, makeWindow }
