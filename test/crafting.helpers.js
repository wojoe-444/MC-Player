// Test rig for brain/crafting: the shared mock bot plus mineflayer-style recipes (bot.craft follows plugins/craft.js: the recipe is
// run `count` times, a table is required for 3x3 recipes and has to be within reach) and the real brain/index.js wiring.
const fs = require('fs')
const os = require('os')
const path = require('path')
const { Vec3 } = require('vec3')
const { mockBot, mcData } = require('./mock-bot')
const attach = require('../brain')

const wait = (ms) => new Promise(r => setTimeout(r, ms))
const MODULE = path.join(__dirname, '..', 'brain', 'crafting', 'index.js')

function addCrafting(bot) {
  bot.craftCalls = []
  bot.craft = async (recipe, count, table) => {
    if (recipe.requiresTable) {
      if (!table) throw new Error('Recipe requires craftingTable, but one was not supplied')
      if (bot.entity.position.distanceTo(table.position) > 6) throw new Error('crafting table is out of reach')
    }
    if (bot.craftFail && bot.craftFail(recipe, count, table)) { bot.actions.push(['craft-ignored', mcData.items[recipe.result.id].name, count, !!table]); return }   // the server ignores it: nothing happens, no error
    for (let i = 0; i < count; i++) {
      for (const d of recipe.delta) if (d.count < 0 && bot.count(mcData.items[d.id].name) < -d.count) throw new Error('missing ingredient')
      for (const d of recipe.delta) { const n = mcData.items[d.id].name; if (d.count < 0) bot.take(n, -d.count); else bot.give(n, d.count) }
    }
    bot.craftCalls.push([mcData.items[recipe.result.id].name, count, !!table])
    bot.actions.push(['craft', mcData.items[recipe.result.id].name, count, !!table])
  }
  // bot.placeBlock(reference, face): puts the held block next to the reference block, like mineflayer (needs the block in hand)
  bot.placeBlock = async (ref, face) => {
    if (!bot.heldItem) throw new Error('must be holding an item to place')
    const at = ref.position.plus(face)
    if (bot.blockAt(at).name !== 'air') throw new Error('target is not empty')
    bot.setBlock(at.x, at.y, at.z, bot.heldItem.name)
    bot.take(bot.heldItem.name, 1)
    bot.actions.push(['place', bot.heldItem && bot.heldItem.name, at.x, at.y, at.z])
  }
  return bot
}

// chest = [x, y, z, size, items]; index = chests whose contents the bot "knows" (defaults to the real contents)
function rig({ pos = [-1045, 128, 2276], bag = {}, chests = [], index = null, table = [-1051, 151, 2320], legacyCraft = false, fast = null, extra = {} } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'crafting-'))
  const bot = addCrafting(mockBot({ pos }))
  for (const [n, c] of Object.entries(bag)) bot.give(n, c)
  if (fast) require('./crafting.fast.helpers').addFastServer(bot, fast)
  for (const [x, y, z, size, items] of chests) bot.addChest(x, y, z, size, items)
  if (table) bot.setBlock(...table, 'crafting_table')
  const idx = {}
  for (const c of (index || chests)) idx[`${c[0]},${c[1]},${c[2]}`] = { items: c[4], slots: c[3], at: 1000 }
  fs.writeFileSync(path.join(dir, 'chest-index.json'), JSON.stringify(idx))
  const said = [], calls = []
  const legacy = []
  const brain = attach({
    bot, say: (t) => { said.push(t); bot.say(t) }, goals: bot.goals, tryGoto: extra.tryGoto || bot.tryGoto, stopNav: () => { bot.pathfinder.setGoal(null) },
    navigateRaw: () => {}, navActive: () => false,
    handleCommand: (u, t) => { legacy.push(t); return false },
    farm: { isBusy: () => false, stop() {}, storeCrops: async () => {}, harvest: async () => {} },
    excavation: { isRunning: () => false, stop() {}, start: async () => {}, resume: async () => {}, status() {} },
    routines: { farm: false, lastFarmRun: 0 }, saveRoutines: () => {}, dir, stateDir: path.join(dir, 'state'),
    jobs: { bedRoutine: async () => {}, ...(legacyCraft ? { craftToolSet: async () => { calls.push('craftToolSet') } } : {}) },
    stopAllLegacy: () => {}, idleAfterMs: 50, moduleEntries: [{ name: 'crafting', path: MODULE }], ...extra.deps
  })
  const route = (text, opts = { handleCommand: (u, t) => { legacy.push(t); return false } }) => brain.route('OGWO', text, opts)
  // wait until the craft task has left the scheduler
  const settle = async (ms = 3000) => { const t0 = Date.now(); await wait(20); while (Date.now() - t0 < ms) { const s = brain.scheduler.status(); if (!s.running && !s.queue.length) return; await wait(15) } throw new Error('craft task did not finish: ' + JSON.stringify(brain.scheduler.status())) }
  return { brain, bot, dir, said, calls, legacy, route, settle, wait, stop: () => brain.stop() }
}

module.exports = { rig, addCrafting, wait, mcData, Vec3, MODULE }
