// Room excavation, requested by Walter: carve the open rectangle (floor y=136) up to 6 blocks tall (dig y138..y141).
// Only digs inside the footprint columns that are already open at y136 and y137. Never places blocks.
// Skips: liquids/liquid neighbours, falling-block columns (sand/gravel), containers, doors, anything undiggable.
// State is saved to exc-state.json so the job resumes after a reconnect.
const fs = require('fs')
const Vec3 = require('vec3').Vec3

const BOX = { x1: -1069, x2: -1053, z1: 2299, z2: 2343 }
const FLOOR_Y = 136              // first open layer (the intended floor surface)
const DIG_FROM = 138, DIG_TO = 141 // 6 blocks of height = y136..y141
const STATE_FILE = 'exc-state.json'
const GRAVITY = /(^|_)(sand|gravel|concrete_powder)$/
const NEVER = /(chest|barrel|shulker_box|furnace|smoker|blast_furnace|hopper|dropper|dispenser|door|gate|bed$|sign|torch|lantern|spawner|beacon|crafting_table|bedrock|obsidian|portal|command_block|lectern|jukebox|bell|rail)/
const JUNK = new Set(['cobblestone', 'stone', 'dirt', 'grass_block', 'coarse_dirt', 'podzol', 'andesite', 'diorite', 'granite', 'deepslate', 'cobbled_deepslate', 'tuff', 'gravel', 'sand', 'rooted_dirt', 'mud', 'clay', 'calcite', 'dripstone_block'])

module.exports = function install({ bot, say, goals, tryGoto, isDoorName }) {
  let running = false, stopFlag = false
  let state = { active: false, done: [], dug: 0, skipped: {}, startedAt: null }
  try { state = { ...state, ...JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')) } } catch {}
  const save = () => fs.writeFileSync(STATE_FILE, JSON.stringify(state))
  const log = (s) => fs.appendFileSync('excavate.log', `${new Date().toISOString()} ${s}\n`)
  const sleep = (ms) => new Promise(r => setTimeout(r, ms))
  const key = (x, z) => `${x},${z}`
  const solid = (b) => b && b.boundingBox !== 'empty'
  const isLiquid = (b) => b && (b.name === 'water' || b.name === 'lava' || b.name === 'bubble_column')
  const skip = (why) => { state.skipped[why] = (state.skipped[why] || 0) + 1 }

  function footprint() {
    const cols = []
    for (let x = BOX.x1; x <= BOX.x2; x++) for (let z = BOX.z1; z <= BOX.z2; z++) {
      const f = bot.blockAt(new Vec3(x, FLOOR_Y - 1, z)), a = bot.blockAt(new Vec3(x, FLOOR_Y, z)), b = bot.blockAt(new Vec3(x, FLOOR_Y + 1, z))
      if (solid(f) && !isLiquid(f) && a && a.boundingBox === 'empty' && b && b.boundingBox === 'empty' && !isLiquid(a) && !isLiquid(b)) cols.push({ x, z })
    }
    return cols
  }

  function groupsOf(cols) {
    const set = new Map(cols.map(c => [key(c.x, c.z), c]))
    const groups = []
    let flip = false
    for (let gx = BOX.x1; gx <= BOX.x2; gx += 3) {
      const row = []
      for (let gz = BOX.z1; gz <= BOX.z2; gz += 3) {
        const members = []
        for (let x = gx; x < gx + 3; x++) for (let z = gz; z < gz + 3; z++) { const c = set.get(key(x, z)); if (c) members.push(c) }
        if (!members.length) continue
        const cx = gx + 1, cz = gz + 1
        const stand = members.slice().sort((a, b) => Math.hypot(a.x - cx, a.z - cz) - Math.hypot(b.x - cx, b.z - cz))[0]
        row.push({ id: `${gx},${gz}`, members, stand })
      }
      groups.push(...(flip ? row.reverse() : row)); flip = !flip
    }
    return groups
  }

  // Pre-scan: what is in the volume to be dug, and what hazards are adjacent.
  function prescan(cols) {
    const tally = {}, hazards = { liquidAdjacent: 0, gravityColumns: 0 }
    for (const c of cols) {
      let gravity = false
      for (let y = DIG_FROM; y <= DIG_TO + 1; y++) {
        const b = bot.blockAt(new Vec3(c.x, y, c.z)); if (!b) continue
        if (GRAVITY.test(b.name)) gravity = true
        if (y <= DIG_TO) {
          tally[b.name] = (tally[b.name] || 0) + 1
          for (const [dx, dy, dz] of [[1,0,0],[-1,0,0],[0,1,0],[0,0,1],[0,0,-1]]) if (isLiquid(bot.blockAt(new Vec3(c.x + dx, y + dy, c.z + dz)))) { hazards.liquidAdjacent++; break }
        }
      }
      if (gravity) hazards.gravityColumns++
    }
    return { tally, hazards }
  }

  const durLeft = (it) => { const max = bot.registry.items[it.type].maxDurability; return max ? max - (it.durabilityUsed || 0) : 999 }
  const tools = () => bot.inventory.items().filter(i => /_(pickaxe|shovel|axe)$/.test(i.name) && durLeft(i) >= 3)
  const pickaxeUses = () => bot.inventory.items().filter(i => /_pickaxe$/.test(i.name)).reduce((s, i) => s + durLeft(i), 0)

  async function equipBest(block) {
    let best = null, bestT = Infinity
    for (const it of tools()) {
      const t = block.digTime(it.type, false, false, false, [], {})
      if (t < bestT) { bestT = t; best = it }
    }
    if (!best) return false
    if (!bot.heldItem || bot.heldItem.type !== best.type) await bot.equip(best, 'hand')
    return true
  }

  // Walter's instruction: when the inventory gets full, put the cobblestone into one of the automatic furnaces.
  // Keeps a small reserve (for crafting pickaxes). If a furnace has a hopper above it, the hopper is the input.
  const cobbleCount = () => bot.inventory.items().filter(i => i.name === 'cobblestone').reduce((s, i) => s + i.count, 0)
  const RESERVE = 48
  let lastDepositFail = 0
  async function dropJunkIfFull() {
    if (bot.inventory.emptySlotCount() > 6) return
    if (cobbleCount() > RESERVE && Date.now() - lastDepositFail > 120000) {
      const moved = await depositCobble()
      if (moved === 0) lastDepositFail = Date.now()
    }
    if (bot.inventory.emptySlotCount() <= 3) {
      // Still nearly full: drop only dirt-like junk (never cobblestone), so digging can continue.
      for (const it of bot.inventory.items()) {
        if (!['dirt', 'grass_block', 'coarse_dirt', 'gravel', 'sand', 'rooted_dirt', 'mud', 'clay'].includes(it.name)) continue
        try { await bot.tossStack(it) } catch {}
        await sleep(120)
      }
    }
    if (bot.inventory.emptySlotCount() === 0) throw new Error('INVENTORY_FULL')
  }

  async function depositCobble() {
    const cobbleType = bot.registry.itemsByName.cobblestone.id
    const furnaceId = bot.registry.blocksByName.furnace.id
    const me = bot.entity.position
    const pts = bot.findBlocks({ matching: furnaceId, maxDistance: 128, count: 60 }).sort((a, b) => a.distanceTo(me) - b.distanceTo(me))
    if (!pts.length) { say('My inventory is nearly full but I cannot find any furnace within 128 blocks to put the cobblestone in.'); return 0 }
    let movedTotal = 0
    const tried = new Set()
    for (const p of pts.slice(0, 12)) {
      if (cobbleCount() <= RESERVE || stopFlag) break
      const fb = bot.blockAt(p), above = bot.blockAt(p.offset(0, 1, 0))
      const target = above && above.name === 'hopper' ? above : fb
      const k = target.position.toString(); if (tried.has(k)) continue; tried.add(k)
      const r = await tryGoto(new goals.GoalNear(target.position.x, target.position.y, target.position.z, 3), 'a furnace', 60000)
      if (!r.ok) { log(`furnace ${k} unreachable: ${r.err}`); continue }
      const before = cobbleCount()
      try {
        if (target.name === 'hopper') {
          const c = await bot.openContainer(target)
          try { while (cobbleCount() > RESERVE) { await c.deposit(cobbleType, null, Math.min(64, cobbleCount() - RESERVE)) } } catch {} finally { c.close() }
        } else {
          const f = await bot.openFurnace(target)
          try {
            const cur = f.inputItem()
            const space = cur ? (cur.type === cobbleType ? 64 - cur.count : 0) : 64
            if (space > 0) await f.putInput(cobbleType, null, Math.min(space, cobbleCount() - RESERVE))
          } catch (e) { log(`putInput failed: ${e.message}`) } finally { f.close() }
        }
      } catch (e) { log(`furnace ${k} error: ${e.message}`) }
      const moved = before - cobbleCount()
      if (moved > 0) { movedTotal += moved; say(`Put ${moved} cobblestone into the ${target.name} at ${target.position.x}, ${target.position.y}, ${target.position.z}.`) }
    }
    if (movedTotal === 0) say('I could not put any cobblestone into the furnaces (they look full or unreachable). I will keep digging and tell you if my inventory fills up.')
    else log(`deposited ${movedTotal} cobblestone`)
    return movedTotal
  }

  // Restock pickaxes at a crafting table when the remaining durability gets low.
  async function restock() {
    if (pickaxeUses() >= 60) return true
    const cobble = bot.inventory.items().filter(i => i.name === 'cobblestone').reduce((s, i) => s + i.count, 0)
    const planks = bot.inventory.items().filter(i => i.name.endsWith('_planks')).reduce((s, i) => s + i.count, 0)
    const sticks = bot.inventory.items().filter(i => i.name === 'stick').reduce((s, i) => s + i.count, 0)
    const want = Math.min(8, Math.floor(cobble / 3), Math.floor((sticks + Math.floor(planks / 2) * 4) / 2))
    if (want < 1) { say('I am out of materials for more pickaxes (need cobblestone, planks or sticks). Pausing the excavation.'); return false }
    const table = bot.findBlock({ matching: bot.registry.blocksByName.crafting_table.id, maxDistance: 96 })
    if (!table) { say('My pickaxes are nearly worn out and I cannot find a crafting table to make more. Pausing the excavation.'); return false }
    const r = await tryGoto(new goals.GoalNear(table.position.x, table.position.y, table.position.z, 2), 'the crafting table', 60000)
    if (!r.ok) { say(`Could not reach a crafting table to make more pickaxes (${r.err}). Pausing.`); return false }
    const craft = async (name, n) => { const rec = bot.recipesFor(bot.registry.itemsByName[name].id, null, 1, table)[0]; if (!rec) throw new Error('no recipe ' + name); await bot.craft(rec, n, table) }
    try {
      const needSticks = want * 2 - sticks
      if (needSticks > 0) { const crafts = Math.ceil(needSticks / 4); const lp = bot.inventory.items().find(i => i.name.endsWith('_planks')); await craft('stick', crafts) }
      for (let i = 0; i < want; i++) await craft('stone_pickaxe', 1)
      say(`Restocked: crafted ${want} stone pickaxes.`)
      return true
    } catch (e) { say(`Could not craft pickaxes: ${e.message}`.slice(0, 200)); return false }
  }

  const groundItems = () => Object.values(bot.entities).filter(e => e.name === 'item' && e.position.distanceTo(bot.entity.position) < 24).length
  const MAX_GROUND_ITEMS = 30 // Walter: do not let items pile up on the ground

  async function collectDrops() {
    for (let i = 0; i < 6; i++) {
      if (stopFlag || bot.inventory.emptySlotCount() < 2) return
      const item = bot.nearestEntity(e => e.name === 'item' && e.position.distanceTo(bot.entity.position) < 6 && e.position.y > FLOOR_Y - 2)
      if (!item) return
      await tryGoto(new goals.GoalNear(item.position.x, item.position.y, item.position.z, 0.8), 'a drop', 4000)
    }
  }

  async function digColumnBlock(x, y, z) {
    const b = bot.blockAt(new Vec3(x, y, z))
    if (!b || b.boundingBox === 'empty') return
    if (isLiquid(b) || NEVER.test(b.name) || !b.diggable) return skip(`protected:${b.name}`)
    for (const [dx, dy, dz] of [[1,0,0],[-1,0,0],[0,1,0],[0,0,1],[0,0,-1]]) {
      const n = bot.blockAt(new Vec3(x + dx, y + dy, z + dz))
      if (isLiquid(n)) return skip('liquid-adjacent')
    }
    if (!bot.canDigBlock(b)) return skip('out-of-reach')
    if (!(await equipBest(b))) throw new Error('NO_TOOL')
    await bot.dig(b, true)
    state.dug++
  }

  const HOSTILE = /^(zombie|skeleton|creeper|spider|cave_spider|husk|drowned|witch|pillager|vindicator|phantom|slime|silverfish|enderman|zombie_villager|stray|bogged|breeze)$/
  function danger() {
    if (bot.health < 8) return `health is ${Math.round(bot.health)}/20`
    const m = bot.nearestEntity(e => HOSTILE.test(e.name || '') && e.position.distanceTo(bot.entity.position) < 6)
    return m ? `a ${m.name} is near` : null
  }

  async function run(resume) {
    if (running) return say('The excavation is already running. Say "excavation status" for progress or "stop" to pause.')
    running = true; stopFlag = false
    try {
      const cols = footprint()
      if (!cols.length) { say('I cannot find the room footprint from here. Make sure I am inside the room (floor y136).'); return }
      const { tally, hazards } = prescan(cols)
      const top = Object.entries(tally).sort((a, b) => b[1] - a[1]).slice(0, 5).map(([n, c]) => `${c} ${n}`).join(', ')
      if (!resume) {
        state = { active: true, done: [], dug: 0, skipped: {}, startedAt: new Date().toISOString() }
        say(`Plan: carve the room to 6 blocks tall (dig y138-141) over ${cols.length} open columns (x ${BOX.x1}..${BOX.x2}, z ${BOX.z1}..${BOX.z2}). About ${Object.values(tally).reduce((a, b) => a + b, 0)} blocks: ${top}.`)
        say(`Hazards: ${hazards.liquidAdjacent} blocks next to liquid (I'll skip those), ${hazards.gravityColumns} columns with sand/gravel (skipped). Say "stop" any time.`)
        log(`START cols=${cols.length} tally=${JSON.stringify(tally)} hazards=${JSON.stringify(hazards)}`)
      } else say('Resuming the excavation.')
      save()
      const groups = groupsOf(cols).filter(g => !state.done.includes(g.id))
      let n = 0
      const total = groups.length + state.done.length
      for (const g of groups) {
        if (stopFlag) { say(`Paused. ${state.done.length}/${total} sections done, ${state.dug} blocks dug.`); save(); return }
        const d = danger()
        if (d) { say(`Pausing: ${d}. Tell me "resume excavation" when it is safe.`); state.active = false; save(); return }
        if (!(await restock())) { state.active = false; save(); return }
        await dropJunkIfFull()
        const r = await tryGoto(new goals.GoalBlock(g.stand.x, FLOOR_Y, g.stand.z), `section ${g.id}`, 30000)
        if (!r.ok) { skip('unreachable-section'); log(`unreachable ${g.id}: ${r.err}`); state.done.push(g.id); continue }
        // columns whose y138..142 contains sand/gravel are skipped entirely
        for (const c of g.members) {
          if (stopFlag) break
          let gravity = false
          for (let y = DIG_FROM; y <= DIG_TO + 1; y++) { const b = bot.blockAt(new Vec3(c.x, y, c.z)); if (b && GRAVITY.test(b.name)) gravity = true }
          if (gravity) { skip('gravity-column'); continue }
          for (let y = DIG_FROM; y <= DIG_TO; y++) {
            try { await digColumnBlock(c.x, y, c.z) }
            catch (e) {
              if (e.message === 'NO_TOOL') { if (!(await restock())) { state.active = false; save(); return } y--; continue }
              skip('dig-error'); log(`dig error ${c.x},${y},${c.z}: ${e.message}`)
            }
          }
        }
        await collectDrops()
        if (groundItems() > MAX_GROUND_ITEMS) {
          await collectDrops(); await collectDrops()
          const left = groundItems()
          if (left > MAX_GROUND_ITEMS) {
            say(`Pausing: ${left} items are lying on the ground near me and I can't pick them up (inventory nearly full?). I'd rather not leave a pile. Tell me where to put things, then say "resume excavation".`)
            state.done.push(g.id); state.active = false; save(); return
          }
        }
        state.done.push(g.id); n++
        save()
        if (n % 10 === 0) say(`Progress: ${state.done.length}/${total} sections, ${state.dug} blocks dug.`)
      }
      state.active = false; save()
      const sk = Object.entries(state.skipped).map(([k, v]) => `${v} ${k}`).join(', ')
      say(`Excavation finished: ${state.dug} blocks dug. ${sk ? 'Skipped: ' + sk + '.' : 'Nothing skipped.'}`)
      log(`DONE dug=${state.dug} skipped=${JSON.stringify(state.skipped)}`)
    } catch (e) {
      if (e.message === 'INVENTORY_FULL') { say('My inventory is completely full and the furnaces would not take more cobblestone. Pausing the excavation; tell me where to put things or say "resume excavation".'); state.active = false }
      else say(`Excavation stopped by an error: ${e.message}`.slice(0, 200))
      log(`ERROR ${e.stack}`); save()
    } finally { running = false }
  }

  return {
    start: () => run(false),
    resume: () => run(true),
    stop: () => { stopFlag = true },
    isRunning: () => running,
    shouldAutoResume: () => state.active && !running,
    status: () => say(running ? `Excavating: ${state.done.length} sections done, ${state.dug} blocks dug.` : `Not running. ${state.done.length} sections done, ${state.dug} blocks dug${state.active ? ' (paused, say "resume excavation")' : ''}.`)
  }
}
