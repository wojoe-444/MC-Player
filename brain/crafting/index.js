// brain/crafting: native "craft <item> [count]" and a better "find <thing>" (see README.md and brain/INTERFACE.md).
//   craft: mineflayer recipes, ingredients from the bag then the indexed chests (only what is needed), walks to a crafting table.
//   find:  bag + chest-index.json + loaded blocks, nearest first, no stripping of a trailing "s".
const fs = require('fs')
const path = require('path')
const { resolve, parseCount } = require('./names')
const makeChests = require('./chests').create
const makeCrafter = require('./craft')
const makeFinder = require('./find')
const config = require('./config.json')

const readJson = (file, fallback) => { try { return JSON.parse(fs.readFileSync(file, 'utf8').replace(/^﻿/, '')) } catch { return fallback } }

// same normalisation as brain/index.js and join.js (the text the command table is tested against)
const FILLER = /\b(hey|yo|claude|bot|ozogo444|please|pls|plz|can you|could you|would you|will you|can u|go ahead and|just|now|for me)\b/g
const normalize = (text) => String(text).toLowerCase().replace(/[^\w\s',.-]/g, ' ').replace(FILLER, ' ').replace(/\s+/g, ' ').trim()

const CRAFT = /^(craft|create|make)\s+(?:me\s+|us\s+)?(.+?)[.!?]*$/
const TOOLSET = /^(?:(?:a|the|my|basic|stone|wooden|full|new|some)\s+)*(?:tool ?sets?|tool ?kits?|tools)$/
const FIND = /^(?:find|locate|search for|look for|where (?:is|are|can i find)|where's)\s+(?:me\s+)?(?:(?:the|all|any|some|a|an)\s+)*(.+?)[.!?]*$/
const NOT_A_THING = /^(?:you|me|it|us|my|your|there|here|him|her|them|that|this|something|anything|everything|out)\b/

function register(api) {
  const { bot, say } = api
  const reg = bot.registry
  const log = (m) => api.log('crafting', m)

  const furnaceCfg = readJson(path.join(__dirname, '..', 'furnace-config.json'), {})
  const chests = makeChests({ dir: api.dir, overlayFile: api.statePath('crafting-chests.json'), indexFile: config.chestIndexFile, furnaceConfig: furnaceCfg, rules: { ...config, reserved: require('../storage-model').makeReserved(process.env.BOT_REGISTRY || path.join(__dirname, '..', '..', '..', 'bot-shared', 'registry.json')) }, now: api.now, log })
  const Recipe = require('prismarine-recipe')(reg).Recipe
  const recipeCache = new Map()
  const recipesOf = (id) => { if (!recipeCache.has(id)) recipeCache.set(id, Recipe.find(id, null)); return recipeCache.get(id) }

  const crafter = makeCrafter({ api, chests, config, recipesOf })
  const finder = makeFinder({ api, chests, config, outFile: api.statePath('find-last.txt') })
  const itemNames = new Set(reg.itemsArray.map(i => i.name))

  // For other modules (excavation's pickaxes ...): craft inside the caller's own task, nothing is said in chat.
  //   const r = await api.crafting.craft(ctx, 'stone_pickaxe', 2, { chests: false, placeTable: false })   // -> { ok, made, text }
  api.crafting = {
    craft: (ctx, name, count, opts) => crafter.craftNow(ctx, name, count, opts),
    // several items in one visit to the table: craftMany(ctx, [{ name, count }, ...], opts) -> { ok, text, results }
    craftMany: (ctx, list, opts) => crafter.craftMany(ctx, list, opts),
    // the old join.js craftToolSet (stone kit, wooden when there is no cobblestone), through the same planner and nav
    toolSet: (ctx, opts) => crafter.toolSet(ctx, opts),
    // can the bag alone make `count` of it right now? -> { ok, missing:[...], needsTable }
    canCraft(name, count = 1) {
      const id = reg.itemsByName[name] && reg.itemsByName[name].id
      if (id == null) return { ok: false, missing: [name], needsTable: false }
      const { p } = crafter.planFor(id, count, new Set(), false)
      return { ok: p.ok, missing: require('./planner').tally(p.missing, (i) => reg.items[i].name), needsTable: p.needsTable }
    }
  }

  // ---------- craft ----------
  function parseCraft(t) {
    const m = CRAFT.exec(t)
    if (!m) return null
    const verb = m[1]
    const rest = m[2].replace(/^yourself\s+(?:(?:an?|some)\s+)?/, '')
    if (TOOLSET.test(rest)) return { verb, toolset: true }                // "craft tool set" / "make yourself some tools": the old tool-set job, now done here
    const { count, what } = parseCount(rest, config.maxCount)
    if (!what) return null
    if (TOOLSET.test(what)) return { verb, toolset: true }
    return { verb, what, count }
  }
  const claimsCraft = (t) => {
    const p = parseCraft(t)
    if (!p) return false
    if (p.toolset) return true
    if (p.verb === 'craft') return true                                   // "craft <anything>" is ours, even a misspelled item (the legacy job would craft a tool set)
    const r = resolve(itemNames, p.what, { fuzzy: false })
    return r.matches.length > 0                                          // "make ..." only for real items
  }
  function runCraft(user, text, t) {
    const p = parseCraft(t || normalize(text))
    if (!p) return false
    if (p.toolset) { say('Making a basic tool set.'); crafter.startToolSet(); return true }
    const d = crafter.decide(p.what, p.count)
    if (d.kind === 'say') { say(d.text); return true }
    if (d.kind === 'missing') { say(crafter.missingLine(d)); return true }
    if (d.asked && d.asked > d.count) say(`I can only make ${d.count} of ${d.asked} ${d.name.replace(/_/g, ' ')} right now.`)
    const trip = d.p.take.size > 0 || d.p.needsTable
    if (trip) say(`${d.note || ''}On it: ${d.count} ${d.name.replace(/_/g, ' ')}${d.p.take.size ? ', fetching the ingredients from chests' : ''}.`.slice(0, 230))
    else if (d.note) say(d.note.trim())
    crafter.start(d)
    return true
  }
  api.commands.add({
    name: 'craft-item', help: 'craft <item> [count]', risk: 'high',
    match: (user, t) => claimsCraft(t),
    run: (user, text, t) => { runCraft(user, text, t) }
  })

  // ---------- find ----------
  function parseFind(t) {
    const m = FIND.exec(t)
    if (!m) return null
    let what = m[1].trim()
    if (NOT_A_THING.test(what) || /^furnaces?$/.test(what)) return null    // "find furnaces" stays the legacy cluster survey
    what = what.replace(/^(?:\d+\s*(?:x\s*)?)/, '')
    return what || null
  }
  api.commands.add({
    name: 'find-item', help: 'find <item>', risk: 'low',
    match: (user, t) => { const w = parseFind(t); return !!w && finder.knows(w) },
    run: (user, text, t) => { const w = parseFind(t || normalize(text)); if (w) finder.run(w) }
  })

  // The integrator's built-in 'craft' command (tool set) matches any line containing "craft" and is registered before module
  // commands, so it would swallow "craft glass pane". Until its match is narrowed (README), answer those lines from onChat.
  let shadowed = false
  const owner = api.ownerName || null
  return {
    name: 'crafting',
    start() {
      try {
        shadowed = api.commands.list().some(c => c.name === 'craft')
        if (shadowed) log('built-in "craft" (tool set) command is registered first; handling "craft <item>" from onChat until its match is narrowed')
      } catch { /* list() missing in an old harness */ }
    },
    onChat(user, text) {
      if (!shadowed || (owner && user !== owner)) return false
      const t = normalize(text)
      if (!claimsCraft(t)) return false
      return runCraft(user, text, t)
    },
    status() { return { chestsKnown: chests.entries().length, shadowedByBuiltInCraft: shadowed, fast: { recipes: crafter.book.size(), batches: crafter.fast.batches, crafts: crafter.fast.crafts, fails: crafter.fast.fails, off: crafter.fast.broken } } }
  }
}

module.exports = register
module.exports.meta = require('./meta.json')
module.exports.normalize = normalize
