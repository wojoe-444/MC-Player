// "craft <item> [count]": plan with brain/crafting/planner.js, take only the missing ingredients out of the indexed chests, walk to a
// crafting table when a recipe needs one and craft with mineflayer's own recipes. Runs as one scheduler task (PRIORITY.CHAT, "stop"
// cancels it). Never digs, places or breaks anything, never takes lava buckets or the furnace stations' stock (see chests.js).
const { resolve, pretty } = require('./names')
const { plan, maxFeasible, tally } = require('./planner')
const { Vec3 } = require('vec3')
const { dimOf, sleep } = require('../util')
const { createRecipeBook } = require('./recipebook')

const withTimeout = (p, ms, what) => { let t; return Promise.race([p, new Promise((_, rej) => { t = setTimeout(() => rej(new Error(`${what} timed out`)), ms) })]).finally(() => clearTimeout(t)) }

module.exports = function createCrafter({ api, chests, config, recipesOf }) {
  const { bot, say, scheduler, PRIORITY } = api
  const reg = bot.registry
  const idOf = (name) => reg.itemsByName[name] && reg.itemsByName[name].id
  const nameOf = (id) => reg.items[id].name
  const itemNames = new Set(reg.itemsArray.map(i => i.name))
  const maxCount = config.maxCount || 2304
  const clip = (t) => String(t).slice(0, 230)
  const book = createRecipeBook(bot)
  const fast = { fails: 0, broken: false, bad: new Set(), batches: 0, crafts: 0, ms: 0 }

  const have = (name) => bot.inventory.items().filter(i => i.name === name).reduce((s, i) => s + i.count, 0)
  const invMap = () => { const m = new Map(); for (const i of bot.inventory.items()) { const id = idOf(i.name); if (id != null) m.set(id, (m.get(id) || 0) + i.count) } return m }
  const inOverworld = () => !dimOf(bot) || dimOf(bot) === 'overworld'

  // can these items be added to the inventory? (partial stacks first, then empty slots)
  function canFit(additions) {
    let empty = bot.inventory.emptySlotCount()
    const items = bot.inventory.items()
    for (const [name, n] of additions) {
      const stack = (reg.itemsByName[name] && reg.itemsByName[name].stackSize) || 64
      let left = n
      for (const i of items) if (i.name === name && i.count < stack && left > 0) left -= Math.min(left, stack - i.count)
      if (left > 0) { const slots = Math.ceil(left / stack); if (slots > empty) return false; empty -= slots }
    }
    return true
  }

  function planArgs(target, skip, useChests = true) {
    const list = useChests && inOverworld() ? chests.entries() : []
    return { registry: reg, recipesOf, target, inventory: invMap(), chests: chests.totals(list, reg, skip), maxDepth: 3, _list: list }
  }
  const planFor = (target, count, skip = new Set(), useChests = true) => { const a = planArgs(target, skip, useChests); return { p: plan({ ...a, count }), list: a._list, a } }

  // ---------- deciding what to do with the words Walter typed ----------
  // -> { kind:'unknown'|'say'|'ask'|'run', ... }
  function decide(what, count) {
    const r = resolve(itemNames, what)
    if (!r.matches.length) return { kind: 'say', text: `I don't know an item called "${what}".` }
    const craftable = r.matches.filter(n => recipesOf(idOf(n)).length)
    if (!craftable.length) {
      const n = r.matches[0]
      return { kind: 'say', text: `${pretty(n)} can't be crafted${/(ingot|glass|brick|cooked|baked|smooth|charcoal)/.test(n) ? ' (it is smelted)' : ' (it has no crafting recipe)'}.` }
    }
    const note = r.rank === 3 ? `Taking that as ${pretty(craftable[0])}. ` : ''
    const results = craftable.map(name => {
      const id = idOf(name)
      const { p, a } = planFor(id, count)
      const max = p.ok ? count : maxFeasible({ ...a }, count)
      return { name, id, p, max }
    })
    const doable = results.filter(x => x.max > 0)
    if (doable.length > 1) {
      // several materials/tiers are makeable right now: do not guess; prefer a candidate that can do the whole count
      const full = doable.filter(x => x.max >= count)
      if (full.length === 1) return { kind: 'run', ...full[0], count, note }
      return { kind: 'say', text: clip(`Which one? ${doable.slice(0, 6).map(x => pretty(x.name)).join(', ')}${doable.length > 6 ? ', ...' : ''}.`) }
    }
    if (doable.length === 1) return { kind: 'run', ...doable[0], count: Math.min(count, doable[0].max), asked: count, note }
    // nothing makeable: report what is missing for the closest candidate
    const best = results.slice().sort((x, y) => sum(x.p.missing) - sum(y.p.missing))[0]
    return { kind: 'missing', ...best, count, note }
  }
  const sum = (m) => [...m.values()].reduce((s, n) => s + n, 0)

  function missingLine(d, extra = '', useChests = true) {
    const list = tally(d.p.missing, nameOf).slice(0, 4).join(', ')
    const known = useChests && inOverworld() ? chests.entries().length : 0
    const where = !useChests ? 'I checked my bag' : known ? `I checked my bag and ${known} indexed chest${known === 1 ? '' : 's'} (say "index chests" to refresh)` : 'I checked my bag (no chests are indexed yet, say "index chests")'
    return clip(`${d.note || ''}Can't craft ${d.count} ${pretty(d.name)}: missing ${list || 'ingredients'}.${extra} ${where}.`)
  }

  // ---------- execution ----------
  // Walter's survival-legit rule: no chest and no crafting table is used without a clear line from the bot's eye. The integrator's
  // api.ensureLineOfSight (brain/los.js) walks to a spot with a view when a wall is in the way and says false when there is none.
  // Without that helper the module fails closed: it leaves chests and tables alone.
  async function ensureView(ctx, pos) {
    if (typeof api.ensureLineOfSight !== 'function') { api.log('crafting', 'api.ensureLineOfSight is missing; not opening containers'); return false }
    await api.safehand.ensureSafeForMove()
    ctx.progress('checking line of sight')
    return !!(await api.ensureLineOfSight({ ctx, target: pos, label: 'a spot with a clear view' }))
  }
  const viewNote = (noView) => noView.length ? ` No clear line to ${noView.length === 1 ? 'the chest' : 'some chests'} at ${noView.slice(0, 2).join(' and ')} (walls in the way), so I left ${noView.length === 1 ? 'it' : 'them'} alone.` : ''

  async function findTable(ctx, opts = {}) {
    const tableId = reg.blocksByName.crafting_table.id
    const me = bot.entity.position
    const seen = new Set(), cands = []
    const near = bot.findBlocks({ matching: tableId, maxDistance: opts.tableRadius || config.tableSearchRadius || 64, count: 16 }) || []
    for (const p of near.sort((a, b) => a.distanceTo(me) - b.distanceTo(me))) { seen.add(String(p)); cands.push(p) }
    for (const k of config.knownTables || []) { const p = new Vec3(k[0], k[1], k[2]); if (!seen.has(String(p)) && me.distanceTo(p) <= (opts.tableRadius || config.knownTableMaxDistance || 400)) cands.push(p) }
    for (const pos of cands.slice(0, 3)) {
      await api.safehand.ensureSafeForMove()
      ctx.progress('walking to a crafting table')
      const ok = await api.gotoNear({ pos, radius: 2, label: 'the crafting table', ctx, ms: 60000 })
      if (!ok) continue
      const blk = bot.blockAt(pos)
      if (blk && blk.name === 'crafting_table' && await ensureView(ctx, pos)) return blk
    }
    return null
  }

  async function gather(ctx, route, skip, taken, noView) {
    let i = 0
    for (const stop of route) {
      ctx.checkpoint()
      ctx.progress(`chests ${++i}/${route.length}`)
      await api.safehand.ensureSafeForMove()
      const near = await api.gotoNear({ pos: stop.pos, radius: 3, label: 'a chest', ctx, ms: 60000 })
      if (!near) { skip.add(stop.key); api.log('crafting', `could not reach chest ${stop.key}`); continue }
      const blk = bot.blockAt(stop.pos)
      if (!blk || !chests.CHEST_NAMES.has(blk.name)) { if (blk) chests.gone(stop.key); skip.add(stop.key); continue }
      if (!await ensureView(ctx, stop.pos)) { skip.add(stop.key); noView.push(stop.key); api.log('crafting', `no clear line to chest ${stop.key}`); continue }
      let win
      try {
        win = await bot.openContainer(blk)
        const seen = {}
        for (const it of win.containerItems()) seen[it.name] = (seen[it.name] || 0) + it.count
        for (const [name, want] of stop.take) {
          if (!chests.allowed(stop.pos, name)) continue
          const n = Math.min(want, seen[name] || 0)
          if (n <= 0) continue
          await win.withdraw(idOf(name), null, n)
          seen[name] -= n
          if (!seen[name]) delete seen[name]
          taken.set(name, (taken.get(name) || 0) + n)
        }
        chests.observe(stop.key, seen)
      } catch (e) { skip.add(stop.key); api.log('crafting', `chest ${stop.key}: ${e.message}`) }
      finally { try { win && win.close() } catch {} }
    }
  }

  // What the crafting window looked like when a craft produced nothing: written to idle.log so the next failure explains itself.
  function dumpState(what, name) {
    try {
      const w = bot.currentWindow || bot.inventory
      const list = (win, a, b) => { const o = []; for (let i = a; i <= b; i++) { const it = win.slots && win.slots[i]; if (it) o.push(`${i}:${it.name}x${it.count}`) } return o.join(' ') || '-' }
      const grid = w === bot.inventory ? list(w, 0, 4) : list(w, 0, 9)
      api.log('crafting', `DIAG ${what}: window=${w.type || 'inventory'} cursor=${w.selectedItem ? w.selectedItem.name + 'x' + w.selectedItem.count : '-'} grid=[${grid}] bag: ${name}=${have(name)} sticks=${have('stick')} planks=${bot.inventory.items().filter(i => /_planks$/.test(i.name)).map(i => i.name + 'x' + i.count).join(',') || '-'}`)
    } catch (e) { api.log('crafting', `DIAG failed: ${e.message}`) }
  }
  // Give back whatever a failed craft left in the grid or on the cursor (closing a table window returns its grid by itself).
  async function recover() {
    try {
      if (bot.currentWindow) { try { bot.closeWindow(bot.currentWindow) } catch {} await sleep(200) }
      const inv = bot.inventory
      if (inv.selectedItem && typeof bot.putSelectedItemRange === 'function') await bot.putSelectedItemRange(inv.inventoryStart, inv.inventoryEnd, inv, null)
      if (inv.slots && typeof bot.putAway === 'function') for (let sl = 1; sl <= 4; sl++) if (inv.slots[sl]) await bot.putAway(sl)
    } catch (e) { api.log('crafting', `recover: ${e.message}`) }
  }

  // mineflayer's craft() waits for the server's slot update after every click (default 20 s each) and the server sometimes never sends one
  // (live 2026-10-26: "Event updateSlot:0 did not fire within timeout of 20000ms"). Rather than abandoning a craft that is half way through its
  // clicks, nudge those waits after a short soft deadline by emitting the slot events on the open window; the craft then finishes its own
  // bookkeeping (closes the window, puts things away) and the product check below says whether the server really crafted.
  async function craftUnstuck(recipe, n, table) {
    const p = bot.craft(recipe, n, table)
    let settled = false
    p.then(() => { settled = true }, () => { settled = true })
    const t0 = Date.now(), soft = config.craftSoftWaitMs || 1500
    const timer = setInterval(() => {
      if (settled || Date.now() - t0 < soft) return
      try {
        const w = bot.currentWindow || bot.inventory
        if (w && typeof w.emit === 'function') { for (let i = 0; i < (w.slots ? w.slots.length : 46); i++) w.emit(`updateSlot:${i}`, null, w.slots && w.slots[i]) }
      } catch { /* best effort */ }
    }, 300)
    try { return await withTimeout(p, (config.craftTimeoutMs || 10000) + 1000 * n, 'crafting') } finally { clearInterval(timer); p.catch(() => {}) }
  }

  // Crafts `times` of `recipe` and checks that the product really arrived in the bag. If it did not (the server ignored a craft), gives
  // the grid back and tries again a safer way: one craft per call, then the other grid (bag 2x2 <-> table) when the recipe fits both.
  async function doCraft(ctx, recipe, times, table, lazyTable) {
    const name = nameOf(recipe.result.id), per = recipe.result.count
    const goal = have(name) + times * per
    const attempts = [{ table, n: config.craftChunk || 16 }]
    if (times > 1) attempts.push({ table, n: 1 })
    if (!recipe.requiresTable) attempts.push({ table: table ? null : 'lazy', n: 1 })
    let lastErr = null, tried = 0
    for (const at of attempts) {
      let tb = at.table
      if (tb === 'lazy') { tb = lazyTable ? await lazyTable() : null; if (!tb) continue }
      tried++
      try {
        while (have(name) < goal) {
          ctx.checkpoint()
          const n = Math.min(at.n, Math.ceil((goal - have(name)) / per))
          const before = have(name), want = before + n * per
          await craftUnstuck(recipe, n, tb)
          for (let k = 0; k < 20 && have(name) < want; k++) await sleep(100)   // the server confirms the slots a moment later
          if (have(name) < want) {
            dumpState(`${n}x ${name} ${tb ? 'at table' : 'in bag grid'} before=${before} want=${want}`, name)
            if (have(name) <= before) throw new Error(`the ${pretty(name)} did not show up in my bag`)
            // part of the batch arrived: keep going with what is still missing instead of starting over
          }
        }
        return
      } catch (e) {
        if (e && e.name === 'AbortError') throw e
        lastErr = e
        api.log('crafting', `${name}: ${e.message}${tried < attempts.length ? ', trying another way' : ''}`)
        await recover()
        if (have(name) >= goal) return
      }
    }
    throw new Error(`${lastErr ? lastErr.message : 'no way to craft it'}${tried > 1 ? ` (tried ${tried} ways, details in idle.log)` : ''}`)
  }

  // Only for callers whose job allows placing (api.crafting.craft(..., { placeTable: true })): put a crafting table on the floor next to the
  // bot, from the bag or crafted from planks. Never replaces or breaks a block, needs air above the floor block and a clear view of it.
  const NO_PLACE_ON = /(chest|barrel|furnace|smoker|door|gate|ladder|sign|rail|torch|lantern|bed|sapling|farmland|lava|water|fire|glass_pane|bars|hopper|dropper|dispenser|spawner|portal|slab|stairs|trapdoor)/
  async function placeTable(ctx, opts = {}) {
    if (!have('crafting_table')) {
      ctx.progress('making a crafting table')
      const r = await execute(ctx, { name: 'crafting_table', count: 1, goal: null }, { chests: false })
      if (!r.ok) { api.log('crafting', `no table to place: ${r.text}`); return null }
    }
    const item = bot.inventory.items().find(i => i.name === 'crafting_table')
    if (!item || typeof bot.placeBlock !== 'function') return null
    await api.safehand.ensureSafeForMove()
    const me = bot.entity.position
    const fx = Math.floor(me.x), fy = Math.floor(me.y), fz = Math.floor(me.z)
    const cands = []
    for (let dx = -2; dx <= 2; dx++) for (let dz = -2; dz <= 2; dz++) {
      if (!dx && !dz) continue
      const ref = new Vec3(fx + dx, fy - 1, fz + dz)
      const b = bot.blockAt(ref), a1 = bot.blockAt(ref.offset(0, 1, 0)), a2 = bot.blockAt(ref.offset(0, 2, 0))
      if (!b || b.boundingBox !== 'block' || NO_PLACE_ON.test(b.name)) continue
      if (!a1 || a1.name !== 'air' || !a2 || a2.name !== 'air') continue
      cands.push({ ref, d: Math.abs(dx) + Math.abs(dz) })
    }
    cands.sort((a, b) => a.d - b.d)
    for (const { ref } of cands.slice(0, 4)) {
      ctx.checkpoint()
      if (!await ensureView(ctx, ref)) continue
      try {
        await bot.equip(item, 'hand')
        await bot.placeBlock(bot.blockAt(ref), new Vec3(0, 1, 0))
      } catch (e) { api.log('crafting', `placing a table at ${ref}: ${e.message}`); continue }
      await sleep(150)
      const t = bot.blockAt(ref.offset(0, 1, 0))
      if (t && t.name === 'crafting_table') { api.log('crafting', `placed a crafting table at ${t.position}`); return t }
    }
    return null
  }

  // ---------- fast bulk crafting (server-side recipe fill + shift-click) ----------
  // One table session per job: the table window is opened once and reused for every step and every batch.
  const newSession = () => ({ table: null, win: null })
  async function openTableWindow(ctx, session) {
    if (session.win && bot.currentWindow === session.win) return session.win
    if (bot.currentWindow) { try { bot.closeWindow(bot.currentWindow) } catch {} await sleep(100) }
    const opened = new Promise((resolve, reject) => {
      const t = setTimeout(() => { bot.removeListener('windowOpen', on); reject(new Error('the crafting table did not open')) }, 4000)
      const on = (w) => { clearTimeout(t); resolve(w) }
      bot.once('windowOpen', on)
    })
    await bot.activateBlock(session.table)
    const w = await opened
    if (!String(w.type || '').startsWith('minecraft:crafting')) { try { bot.closeWindow(w) } catch {} throw new Error(`that was not a crafting table (${w.type})`) }
    session.win = w
    return w
  }
  async function closeSession(session) {
    if (session && session.win) { try { bot.closeWindow(session.win) } catch {} session.win = null; await sleep(60) }
  }

  const gridOf = (win) => (win === bot.inventory ? [1, 2, 3, 4] : [1, 2, 3, 4, 5, 6, 7, 8, 9])
  function gridInfo(win) {
    const counts = gridOf(win).map(i => win.slots[i]).filter(Boolean).map(it => it.count)
    return { filled: counts.length, min: counts.length ? Math.min(...counts) : 0, max: counts.length ? Math.max(...counts) : 0 }
  }
  async function waitFor(cond, ms) {
    const t0 = Date.now()
    while (Date.now() - t0 < ms) { if (cond()) return true; await sleep(15) }
    return cond()
  }
  async function returnGrid(win) {
    for (const i of gridOf(win)) if (win.slots[i]) { try { await bot.clickWindow(i, 0, 1) } catch (e) { api.log('crafting', `returning grid slot ${i}: ${e.message}`) } }
    await waitFor(() => gridInfo(win).filled === 0, 1500)
  }
  const stackLimit = (recipe) => Math.min(64, ...recipe.delta.filter(d => d.count < 0).map(d => (reg.items[d.id] && reg.items[d.id].stackSize) || 64))

  // Craft `times` of `recipe` with the server filling the grid: one request per set (each adds one set to every slot), one shift-click on
  // the result. Returns 'done', or 'skip' when the fast way does not apply, or 'failed' after cleaning up so the caller can use the slow way.
  async function fastStep(ctx, recipe, times, session, table, allowSmall = false) {
    const rid = recipe.result.id, name = nameOf(rid), per = recipe.result.count
    if (config.fastCraft === false || fast.broken || fast.bad.has(rid) || (times < (config.fastMinCrafts || 3) && !session.win && !allowSmall)) return 'skip'
    const disp = book.find(recipe)
    if (!disp || !bot._client || typeof bot._client.write !== 'function') return 'skip'
    const goal = have(name) + times * per
    const t0 = Date.now()
    let win
    try {
      if (table) { session.table = table; win = await openTableWindow(ctx, session) } else { if (bot.currentWindow) { try { bot.closeWindow(bot.currentWindow) } catch {} await sleep(100) } win = bot.inventory }
      const cap = stackLimit(recipe)
      for (let guard = 0; have(name) < goal && guard < 8; guard++) {
        ctx.checkpoint()
        if (gridInfo(win).filled) await returnGrid(win)
        const sets = Math.min(cap, Math.ceil((goal - have(name)) / per))
        const before = have(name), want = before + sets * per
        for (let i = 0; i < sets; i++) bot._client.write('craft_recipe_request', { windowId: win.id, recipeId: disp.id, makeAll: false })
        const filled = await waitFor(() => gridInfo(win).min >= sets, 1500 + 40 * sets)
        const gi = gridInfo(win)
        if (!filled || gi.max > sets) throw new Error(`the server filled the grid with ${gi.min}..${gi.max} sets instead of ${sets}`)
        await bot.clickWindow(0, 0, 1)                                  // shift-click the result: crafts everything in the grid
        await waitFor(() => have(name) >= want, 2500)
        if (have(name) < want) { dumpState(`fast ${sets}x ${name}`, name); throw new Error(`the ${pretty(name)} did not show up in my bag`) }
        fast.batches++; fast.crafts += sets
      }
      if (gridInfo(win).filled) await returnGrid(win)
      fast.ms += Date.now() - t0
      return have(name) >= goal ? 'done' : 'failed'
    } catch (e) {
      if (e && e.name === 'AbortError') throw e
      fast.fails++; fast.bad.add(rid)
      if (fast.fails >= 3) fast.broken = true
      api.log('crafting', `fast crafting of ${name} failed (${e.message}); ${fast.broken ? 'fast crafting is off until restart' : 'using the slow way for it'}`)
      try { if (win && win.slots) await returnGrid(win) } catch {}
      await closeSession(session)
      await recover()
      return have(name) >= goal ? 'done' : 'failed'
    }
  }

  // The crafting job itself. Never talks: returns { ok, made, text } and the caller says text (the chat command) or uses it in its own
  // message (other modules through api.crafting.craft). opts: { chests: true } use indexed chests too; { placeTable: false } may put down a
  // crafting table when none is reachable (needs one in the bag or 4 planks; off unless the caller's job allows placing).
  const NOCTX = { checkpoint() {}, progress() {}, onAbort: () => () => {}, sleep }
  async function execute(ctx, st, opts = {}) {
    ctx = ctx || NOCTX
    const session = opts.session || newSession()
    const useChests = opts.chests !== false
    const id = idOf(st.name)
    // "count" means this many more: remember the target total so a preempted job that resumes does not craft twice
    if (st.goal == null) { st.before = have(st.name); st.goal = st.before + st.count }
    const skip = new Set(), taken = new Map(), noView = []
    const made = () => have(st.name) - st.before
    const done = (ok, text, extra) => ({ ok, text: clip(text), made: made(), ...extra })
    const plans = (n) => planFor(id, n, skip, useChests)
    const none = (want, p) => done(false, missingLine({ name: st.name, count: want, p }, viewNote(noView), useChests), { missing: tally(p.missing, nameOf) })
    try {
      let partialFrom = null
      for (let round = 0; useChests && round < 4; round++) {
        ctx.checkpoint()
        const want = st.goal - have(st.name)
        if (want <= 0) break
        let { p: pl, list, a } = plans(want)
        if (!pl.ok) {
          const n = maxFeasible({ ...a }, want)
          if (n === 0) return none(want, pl)
          partialFrom = want
          pl = plan({ ...a, count: n })
        }
        const p = pl
        if (!p.take.size) break
        // items have to come out of chests first; make sure they fit in the bag and the product will too
        const additions = new Map([...p.take].map(([iid, c]) => [nameOf(iid), c]))
        additions.set(st.name, p.yield)
        if (!canFit(additions)) return done(false, `My bag is too full for ${pretty(st.name)}: I would have to take ${tally(p.take, nameOf).join(', ')}. Please clear a few slots.`)
        const route = chests.assign(list, reg, p.take, bot.entity.position, skip)
        if (!route.length) break
        await gather(ctx, route, skip, taken, noView)
      }
      // final plan from what is in the bag now
      ctx.checkpoint()
      const want = st.goal - have(st.name)
      if (want <= 0) return done(true, `I already have ${have(st.name)} ${pretty(st.name)}.`)
      const fin = plans(want)
      let use = fin.p, count = want
      if (!use.ok) {
        count = maxFeasible({ ...fin.a }, want)
        if (count === 0) return none(want, fin.p)
        use = plan({ ...fin.a, count })
        partialFrom = want
      }
      if (use.take.size) return done(false, `The chests did not have everything (${tally(use.take, nameOf).join(', ')} not found). Say "index chests" to refresh my list.${viewNote(noView)}`)
      if (!canFit(new Map([[st.name, use.yield]]))) return done(false, `My bag has no room for the ${pretty(st.name)}. Please clear a few slots.`)
      let table = session.table || null
      if (use.needsTable && !table) {
        table = await findTable(ctx, opts)
        if (!table && opts.placeTable && st.name !== 'crafting_table') table = await placeTable(ctx, opts)
        if (table) session.table = table
        if (!table) return done(false, `I can't reach a crafting table with a clear line (tried within ${opts.tableRadius || config.tableSearchRadius || 64} blocks and the known one at ${(config.knownTables || [[0, 0, 0]])[0].join(', ')})${opts.placeTable ? ' and could not put one down' : ''}.`)
      }
      let i = 0
      for (const step of use.steps) {
        ctx.progress(`crafting ${++i}/${use.steps.length}: ${pretty(nameOf(step.id))}`)
        const r = await fastStep(ctx, step.recipe, step.times, session, table, use.steps.length > 1 || !!opts.session)
        if (r === 'done') continue
        await closeSession(session)     // mineflayer's craft() opens its own table window
        await doCraft(ctx, step.recipe, step.times, table, () => findTable(ctx, { ...opts, tableRadius: Math.min(opts.tableRadius || 64, 64) }))
      }
      const from = taken.size ? ` Took ${[...taken].map(([k, v]) => `${v} ${pretty(k)}`).slice(0, 3).join(', ')} from chests.` : ''
      const short = partialFrom ? ` (wanted ${st.count}; out of ingredients${tally(fin.p.missing, nameOf).length ? ': ' + tally(fin.p.missing, nameOf).slice(0, 2).join(', ') : ''})` : ''
      return done(true, `Crafted ${made()} ${pretty(st.name)}${short}.${from}`, { partial: !!partialFrom })
    } catch (e) {
      if (e && e.name === 'AbortError') throw e
      api.log('crafting', `craft failed: ${e.stack || e.message}`)
      return done(false, `Couldn't finish crafting ${pretty(st.name)}: ${e.message}`)
    } finally {
      if (!opts.session) { try { await closeSession(session); if (bot.currentWindow) bot.closeWindow(bot.currentWindow) } catch {} }
    }
  }

  // Several things in one visit: the table is found and its window opened once, then every item is crafted in turn.
  //   craftMany(ctx, [{ name, count }, ...], opts) -> { ok, text, results: [{ name, ok, made, text }] }  (stops at the first failure)
  async function craftMany(ctx, list, opts = {}) {
    const session = newSession(), results = []
    try {
      for (const it of list) {
        const r = await craftNow(ctx, it.name, it.count || 1, { ...opts, session })
        results.push({ name: it.name, ok: r.ok, made: r.made, text: r.text })
        if (!r.ok) break
      }
    } finally { try { await closeSession(session); if (bot.currentWindow) bot.closeWindow(bot.currentWindow) } catch {} }
    const bad = results.find(r => !r.ok)
    const text = bad ? bad.text : `Crafted ${results.filter(r => r.made).map(r => `${r.made} ${pretty(r.name)}`).join(', ') || 'nothing new'}.`
    return { ok: !bad, text: clip(text), results }
  }

  // The old "craft tool set": a stone kit when there is cobblestone for it, otherwise wooden, sticks first. Replaces join.js craftToolSet.
  const KIT = ['pickaxe', 'axe', 'shovel', 'sword', 'hoe']
  async function toolSet(ctx, opts = {}) {
    const cobble = have('cobblestone') + have('cobbled_deepslate') + have('blackstone')
    const material = cobble >= 11 || (opts.chests !== false && chestCobble() >= 11) ? 'stone' : 'wooden'
    const list = [{ name: 'stick', count: 8 }, ...KIT.map(k => ({ name: `${material}_${k}`, count: 1 }))]
    const r = await craftMany(ctx, list.filter(x => x.name === 'stick' ? have('stick') < 8 : have(x.name) < 1), opts)
    return r.ok ? { ...r, text: `Done: ${material} tool set (${KIT.join(', ')}).` } : r
  }
  function chestCobble() { try { return chests.totals(chests.entries(), reg).get(idOf('cobblestone')) || 0 } catch { return 0 } }

  // The chat job: same thing, said out loud.
  async function run(ctx) {
    const r = await execute(ctx, ctx.state, { chests: true })
    say(r.text)
  }

  // For other modules (api.crafting.craft): craft `count` more of `name` inside the caller's own task. Uses the bag (and chests when
  // opts.chests), walks to a crafting table when the recipe needs one, never speaks. -> { ok, made, text, missing? }
  async function craftNow(ctx, name, count = 1, opts = {}) {
    if (!idOf(name) || !recipesOf(idOf(name)).length) return { ok: false, made: 0, text: `I do not know how to craft ${pretty(name)}.` }
    return execute(ctx, { name, count: Math.max(1, Math.min(count, maxCount)), goal: null }, opts)
  }

  function start(d) {
    const def = {
      name: 'craft', key: 'craft', priority: PRIORITY.CHAT, onUserStop: 'cancel', state: { name: d.name, count: d.count, goal: null },
      abort() { api.stopNav() }, run
    }
    const t = scheduler.submit(def)
    if (t.def !== def) { say('I am already crafting something. Say "stop" first if you want to change it.'); return false }
    return true
  }

  function startToolSet() {
    const def = { name: 'craft', key: 'craft', priority: PRIORITY.CHAT, onUserStop: 'cancel', state: { toolset: true }, abort() { api.stopNav() }, async run(ctx) { const r = await toolSet(ctx, { chests: true }); say(r.text) } }
    const t = scheduler.submit(def)
    if (t.def !== def) { say('I am already crafting something. Say "stop" first if you want to change it.'); return false }
    return true
  }

  return { decide, missingLine, start, startToolSet, planFor, run, canFit, execute, craftNow, craftMany, toolSet, fast, book }
}
