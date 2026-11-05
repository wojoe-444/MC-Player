// brain/clearbox: clear every block in a box (Walter's task, 2026-11-01) and keep what comes out in chests on the jobsite.
// A scheduler task built on the autopilot's body skills (S.mine / S.goto / S.craft ...). Top layer first, serpentine rows, progress saved every few cells.
//   chat: "clear box" / "excavate the box" (start or resume), "clearbox status", "clearbox stop"
//   state: brain/state/clearbox.json  (box, layer, index, chests, counters)
// Rules kept: line of sight comes from S.mine (reach + view before every dig), never digs next to lava, skips water-adjacent cells (a breach would flood the box),
// never breaks our own chests, nothing is thrown away (the bag is emptied into chests when it fills).
const fs = require('fs')
const { Vec3 } = require('vec3')

const BOX = { x1: 148, x2: 169, y1: 70, y2: 90, z1: 444, z2: 519 }
const KEEP_TOOL = /_(pickaxe|axe|shovel|hoe|sword)$|^(shield|bow|arrow|torch|crafting_table|chest|stick|furnace|bucket|water_bucket)$|_(helmet|chestplate|leggings|boots)$/
const FOOD = /^(bread|cooked_[a-z_]+|apple|baked_potato|carrot|melon_slice|golden_carrot|sweet_berries|cookie|pumpkin_pie)$/

module.exports = function register(api) {
  const { bot, scheduler, PRIORITY } = api
  const file = api.statePath('clearbox.json')
  const log = (m) => api.log('clearbox', m)
  const say = (t) => { try { api.say(t) } catch {} }
  const sleep = (ms) => new Promise(r => setTimeout(r, ms))
  const fresh = () => ({ active: false, box: { ...BOX }, layer: BOX.y2, idx: 0, chests: [], dug: 0, skipped: {}, unloads: 0, treeSpot: null, startedAt: null, done: false })
  let st = fresh()
  try { st = { ...st, ...JSON.parse(fs.readFileSync(file, 'utf8')) } } catch {}
  const save = () => { try { fs.writeFileSync(file, JSON.stringify(st)) } catch {} }
  const ap = () => bot._ap
  const key = (p) => `${p.x},${p.y},${p.z}`
  const chestSet = () => new Set(st.chests.map(c => c.join(',')))

  const W = () => st.box.x2 - st.box.x1 + 1, D = () => st.box.z2 - st.box.z1 + 1
  function cellAt(layer, idx) {
    const w = W(), row = Math.floor(idx / w), col = idx % w
    return new Vec3(row % 2 === 0 ? st.box.x1 + col : st.box.x2 - col, layer, st.box.z1 + row)
  }
  const layerSize = () => W() * D()

  let running = false, stopFlag = false, lastIdx = -1, lastMove = Date.now()


  // S.craft sometimes ends in 'missing ingredient' (mixed plank/log types, no table yet). Fallback: place a table, make planks/sticks from what is in the bag, craft with whatever recipe the bag can satisfy.
  async function craftAny(S, name, n = 1) {
    if (S.count(name) >= n) return true
    try { if (await S.craft(name, n)) return true } catch (e) { if (S.isAbort(e)) throw e }
    const mcData = require('minecraft-data')(bot.version)
    let tbl = S.tableNear(4.5)
    const mk = async (nm, k, table) => { const it = mcData.itemsByName[nm]; if (!it) return false; const rs = bot.recipesFor(it.id, null, k, table || null); if (!rs.length) return false; try { await bot.craft(rs[0], k, table || undefined); return true } catch { return false } }
    const logItem = () => bot.inventory.items().find(i => /_log$/.test(i.name))
    const planksOf = () => S.planks()
    if (!tbl) {
      if (!S.has('crafting_table')) { if (planksOf() < 4 && logItem()) await mk(logItem().name.replace('_log', '_planks'), 1); const pl = bot.inventory.items().find(i => /_planks$/.test(i.name)); if (pl) await mk('crafting_table', 1) }
      if (S.has('crafting_table')) { const placed = await S.placeNear('crafting_table'); if (placed) tbl = placed }
    }
    const needPlanks = ({ wooden_pickaxe: 3, wooden_axe: 3, wooden_sword: 2, chest: 8 })[name] || 1
    if (planksOf() < needPlanks && logItem()) await mk(logItem().name.replace('_log', '_planks'), Math.ceil((needPlanks - planksOf()) / 4) + 1, tbl)
    if (/_(pickaxe|axe|sword)$/.test(name) && S.count('stick') < 2 && planksOf() >= 2) await mk('stick', 1, tbl)
    return await mk(name, n, tbl)
  }

  // ---------------- supplies ----------------
  const count = (S, re) => S.count(re)
  async function toTreeSpot(S, goals) {
    const t = st.treeSpot; if (!t) return false
    const r = await S.goto(new goals.GoalNear(t[0], t[1], t[2], 3), { dig: true, ms: 120000 })
    return !!r.ok
  }
  async function getWood(S, goals, want) {
    // logs for tools and chests: chop what is in view, else walk back to where trees stood
    let got = await S.chopTree(want, { ms: 90000 })
    if (!got && await toTreeSpot(S, goals)) got = await S.chopTree(want, { ms: 120000 })
    if (!got) {
      // look for trees from the surface around the box
      for (const [dx, dz] of [[-30, 0], [30, 0], [0, -40], [0, 40], [-60, -30], [60, 30]]) {
        const r = await S.goto(new goals.GoalNear(st.box.x1 + 10 + dx, 100, st.box.z1 + 30 + dz, 4), { dig: true, ms: 90000 })
        if (!r.ok) continue
        got = await S.chopTree(want, { ms: 120000 })
        if (got) break
      }
    }
    if (got) { const p = bot.entity.position; st.treeSpot = [Math.floor(p.x), Math.floor(p.y), Math.floor(p.z)]; save() }
    return got
  }
  async function ensureTools(S, goals) {
    // pickaxe: wooden first (logs), stone as soon as there is cobble; keep a spare
    const wood = () => S.logs() * 4 + S.planks()
    if (S.toolTier('pickaxe') < 1) {
      if (wood() < 12) await getWood(S, goals, 6)
      await craftAny(S, 'wooden_pickaxe', 1)
    }
    const cobble = count(S, /^(cobblestone|cobbled_deepslate)$/)
    if (S.toolTier('pickaxe') < 2 && cobble >= 3) {
      if (wood() < 4) await getWood(S, goals, 4)
      await craftAny(S, 'stone_pickaxe', 1)
    }
    if (cobble >= 12 && S.count(/^stone_pickaxe$/) < 2 && wood() >= 4) await craftAny(S, 'stone_pickaxe', 2)
    if (S.count(/_sword$/) < 1 && (cobble >= 2 || wood() >= 4)) await craftAny(S, cobble >= 2 ? 'stone_sword' : 'wooden_sword', 1)
    return S.toolTier('pickaxe') >= 1
  }
  async function ensureFood(S, goals) {
    if (bot.food >= 14) return
    for (let i = 0; i < 3 && bot.food < 19 && S.foodPoints() > 0; i++) { if (!(await S.eat())) break; await S.wait(250) }
    if (bot.food > 8 || S.foodPoints() > 0) return
    // out of food: surface, hunt, eat what comes (cook when a furnace is at hand)
    st.status = 'hunting for food'; save()
    const p = bot.entity.position
    if (p.y < 90) await S.goto(new (require('mineflayer-pathfinder').goals.GoalNear)(st.box.x1 + 10, 100, st.box.z1 - 4, 6), { dig: true, ms: 90000 })
    for (let i = 0; i < 4; i++) {
      const a = S.animals(undefined, 48); if (!a.length) break
      await S.kill(a[0])
      await S.pickup(10, 4000)
      if (S.rawFood() >= 4) break
    }
    try { if (S.rawFood() >= 2 && S.count(/^(coal|charcoal)$/) + S.logs() >= 2 && (S.has('furnace') || S.count(/cobblestone/) >= 8)) { await craftAny(S, 'furnace', 1); for (const n of ['beef', 'porkchop', 'mutton', 'chicken', 'rabbit']) { const c = S.count(n); if (c) await S.smelt(n, c) } } } catch {}
    for (let i = 0; i < 4 && bot.food < 19; i++) { if (!(await S.eat())) break; await S.wait(250) }
  }

  // ---------------- torches (Walter keeps some in a chest; M.torch lights dark spots as we go) ----------------
  async function fetchTorches(S, goals) {
    const c = st.torchChest; if (!c) return false
    const pos = new Vec3(c[0], c[1], c[2])
    const r = await S.goto(new goals.GoalLookAtBlock(pos, bot.world, { reach: 3.5 }), { dig: true, ms: 90000 })
    const b = bot.blockAt(pos)
    if (!r.ok || !b || !/chest|barrel/.test(b.name)) { log('torch chest not reachable or gone'); return false }
    let ch; try { ch = await bot.openContainer(b) } catch { return false }
    let got = 0
    try { for (const it of ch.containerItems()) { if (it.name !== 'torch' || got >= 64) continue; const n = Math.min(it.count, 64 - got); try { await ch.withdraw(it.type, null, n); got += n } catch {} } } finally { try { ch.close() } catch {} }
    log('took ' + got + ' torches from the chest')
    return got > 0
  }

  // ---------------- chests ----------------
  async function depositInto(S, block) {
    let ch
    try { ch = await bot.openContainer(block) } catch (e) { return 0 }
    let moved = 0
    try {
      const keepCobble = 24
      for (const it of bot.inventory.items()) {
        if (KEEP_TOOL.test(it.name) || FOOD.test(it.name)) continue
        let n = it.count
        if (/^(cobblestone)$/.test(it.name)) n = Math.max(0, it.count - keepCobble)
        if (/_(log|planks)$/.test(it.name)) { const have = S.logs() * 4 + S.planks(); if (have <= 40) continue }
        if (n <= 0) continue
        try { await ch.deposit(it.type, null, n); moved += n } catch { break }
      }
    } finally { try { ch.close() } catch {} }
    return moved
  }
  async function unload(S, goals) {
    st.status = 'unloading'; save()
    const near = st.chests.map(c => new Vec3(c[0], c[1], c[2])).filter(c => bot.entity.position.distanceTo(c) < 40).sort((a, b) => bot.entity.position.distanceTo(a) - bot.entity.position.distanceTo(b))
    for (const c of near.slice(0, 3)) {
      const b = bot.blockAt(c); if (!b || b.name !== 'chest') continue
      const r = await S.goto(new goals.GoalLookAtBlock(c, bot.world, { reach: 3.5 }), { dig: true, ms: 30000 })
      if (!r.ok) continue
      await depositInto(S, b)
      if (S.freeSlots() > 12) { st.unloads++; save(); return true }
    }
    // a new chest next to where we are
    for (let tries = 0; tries < 3 && S.freeSlots() <= 12; tries++) {
      if (!S.has('chest')) {
        if (S.logs() * 4 + S.planks() < 12) await getWood(S, goals, 6)
        await craftAny(S, 'chest', 1)
      }
      if (!S.has('chest')) { log('no chest to place (no wood)'); break }
      const placed = await S.placeNear('chest')
      if (!placed) { log('could not place a chest here'); break }
      const p = placed.position || placed
      st.chests.push([p.x, p.y, p.z]); save()
      log(`chest #${st.chests.length} at ${p.x},${p.y},${p.z}`)
      const b = bot.blockAt(new Vec3(p.x, p.y, p.z))
      if (b) await depositInto(S, b)
    }
    st.unloads++; save()
    return S.freeSlots() > 4
  }

  // ---------------- the dig ----------------
  const SKIP = /^(bedrock|barrier|chest|trapped_chest|barrel|furnace|crafting_table|spawner|end_portal_frame|reinforced_deepslate|command_block)$/
  async function run(ctx) {
    const a = ap(); if (!a || !a.S) { log('autopilot skills not loaded'); return { status: 'done' } }
    const S = a.S, M = a.M; S.ctx = ctx
    const { goals } = S
    running = true; stopFlag = false
    st.active = true; st.startedAt = st.startedAt || Date.now(); save()
    try {
      let lastReport = Date.now(), n = 0
      const chests = chestSet()
      while (!stopFlag && st.layer >= st.box.y1) {
        ctx.checkpoint(); S.ctx = ctx
        if (st.idx >= layerSize()) { st.layer--; st.idx = 0; save(); say(`Box: layer y${st.layer + 1} done, ${st.dug} blocks cleared so far.`); continue }
        if (n++ % 12 === 0 || bot.food <= 6) {
          if (!(await ensureTools(S, goals))) { st.status = 'no pickaxe'; save(); await S.wait(5000); continue }
          await ensureFood(S, goals)
          if (S.count('torch') < 8 && st.torchChest && Date.now() - (st.torchAt || 0) > 300000) { st.torchAt = Date.now(); await fetchTorches(S, goals) }
          if (S.freeSlots() <= 4) { const ok = await unload(S, goals); if (!ok) { st.status = 'bag full and no chest'; save(); await S.wait(8000); continue } }
        }
        const hs = S.hostilesNear(8)
        if (hs.length && (bot.health < 12 || hs.length > 2)) { try { await M.defend(hs) } catch {} continue }
        const c = cellAt(st.layer, st.idx)
        const k = key(c)
        st.idx++
        if (chestSet().has(k)) continue
        const b = bot.blockAt(c)
        if (!b) {
          // not loaded: walk next to it so the chunk streams in, then look again
          await S.goto(new goals.GoalNear(c.x, c.y + 1, c.z, 6), { dig: true, ms: 60000 })
          st.idx--; if (!bot.blockAt(c)) { st.idx++; st.skipped.unloaded = (st.skipped.unloaded || 0) + 1 }
          continue
        }
        if (b.boundingBox === 'empty' && b.name !== 'water' && b.name !== 'lava') { if (st.idx % 10 === 0) save(); continue }
        if (SKIP.test(b.name)) { st.skipped[b.name] = (st.skipped[b.name] || 0) + 1; continue }
        const h = S.hazardNear(c, 1)
        if (h.lava || b.name === 'lava' || b.name === 'water' || h.water) { st.skipped.liquid = (st.skipped.liquid || 0) + 1; continue }
        st.status = `y${c.y} ${st.idx}/${layerSize()}`
        let ok = false; const tm = Date.now()
        try { ok = await S.mine(b, { dig: true, pick: false }) } catch (e) { if (S.isAbort(e)) throw e; log('mine error ' + e.message) }
        st.mineMs = (st.mineMs || 0) + (Date.now() - tm); st.mineN = (st.mineN || 0) + 1
        if (ok) { st.dug++; if (st.dug % 8 === 0) await S.pickup(8, 2500); if (st.dug % 6 === 0 && S.has('torch')) { try { await M.torch() } catch {} } } else { st.skipped.fail = (st.skipped.fail || 0) + 1 }
        if (st.idx % 6 === 0) save()
        if (Date.now() - lastReport > 20 * 60000) { lastReport = Date.now(); say(`Box clearing: ${st.dug} blocks, layer y${st.layer}, ${st.chests.length} chests.`) }
      }
      if (!stopFlag && st.layer < st.box.y1) {
        st.done = true; st.active = false; st.status = 'done'; save()
        if (S.freeSlots() < 30) await unload(S, goals)
        say(`Box cleared: ${st.dug} blocks dug, ${st.chests.length} chests on the jobsite.`)
      }
    } finally { running = false; save() }
    return { status: 'done' }
  }

  function start(box) {
    if (box) { st = { ...fresh(), box: { ...box } } }
    if (st.done) st = { ...fresh(), box: st.box }
    st.active = true; save(); ensureTask()
  }
  function ensureTask() {
    if (!st.active || running) return
    try {
      const s = scheduler.status()
      if ((s.running && s.running.name === 'clearbox') || (s.queue || []).some(t => t.name === 'clearbox') || (s.parked || []).some(t => t.name === 'clearbox')) return
      scheduler.submit({ name: 'clearbox', key: 'clearbox', priority: PRIORITY.EXCAVATE, onUserStop: 'park', run, abort: () => { try { ap().S.stopMoving() } catch {} } })
    } catch (e) { log('submit failed ' + e.message) }
  }
  const timer = setInterval(() => {
    try {
      if (st.idx !== lastIdx || st.layer !== st._lastLayer) { lastIdx = st.idx; st._lastLayer = st.layer; lastMove = Date.now() }
      // stall watchdog: a cell that eats 3+ minutes (pillar loops, unreachable spots) is abandoned; the dig loop already moved past it
      if (running && Date.now() - lastMove > 180000) { st.skipped.stall = (st.skipped.stall || 0) + 1; lastMove = Date.now(); log('stall: abandoning the current cell'); try { scheduler.cancel('clearbox', 'stall') } catch {} }
      if (st.active && bot.entity && bot.health > 0) ensureTask()
    } catch {}
  }, 15000)
  if (timer.unref) timer.unref()

  const STARTRE = /\b(?:clear|excavate|empty|dig\s*out)\b.*\b(?:box|area|site|zone)\b|^\W*clear\s*box\b|^\W*clearbox\s*(?:start|resume)?\W*$/i
  const STATUSRE = /^\W*clearbox\s+status\W*$|\bbox\s+status\b/i
  const TORCHRE = /torchw*D{0,24}(-?d+)[ ,]+(-?d+)[ ,]+(-?d+)/i
  const STOPRE = /^\W*clearbox\s+(?:stop|pause)\W*$|\b(?:stop|pause)\b.*\b(?:clearing|box|excavat)/i
  try {
    api.commands.add({ name: 'clearbox', help: 'clear box | clearbox status | clearbox stop', risk: 'low',
      match: (t) => STARTRE.test(t) || STATUSRE.test(t) || STOPRE.test(t) || TORCHRE.test(t),
      run(user, text) {
        const tm = TORCHRE.exec(text); if (tm && !STOPRE.test(text) && !STATUSRE.test(text)) { st.torchChest = [Number(tm[1]), Number(tm[2]), Number(tm[3])]; st.torchAt = 0; save(); return say('Torch chest noted at ' + st.torchChest.join(' ') + '. I will fetch torches from it.') }
        if (STATUSRE.test(text)) return say(`Box: ${st.dug} dug, layer y${st.layer} ${st.idx}/${layerSize()}, ${st.chests.length} chests, ${st.active ? 'active' : st.done ? 'done' : 'stopped'}${st.status ? ' (' + st.status + ')' : ''}.`)
        if (STOPRE.test(text)) { stopFlag = true; st.active = false; save(); try { scheduler.cancel('clearbox', 'chat stop') } catch {} return say('Stopped clearing the box. Say "clear box" to resume.') }
        start(); say('Clearing the box now.')
      } })
  } catch (e) { log('command not added: ' + e.message) }

  const handle = {
    name: 'clearbox',
    start() { if (st.active) ensureTask() },
    stop() { clearInterval(timer); stopFlag = true },
    status: () => ({ active: st.active, done: st.done, dug: st.dug, layer: st.layer, idx: st.idx, chests: st.chests.length, status: st.status, skipped: st.skipped }),
    startJob: start, state: () => st
  }
  bot._clearbox = handle
  return handle
}
module.exports.meta = require('./meta.json')
