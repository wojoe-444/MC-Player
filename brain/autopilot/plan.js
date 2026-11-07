// brain/autopilot/plan.js (survival world): processes that came out of reviewing the bot's own failures (2026-11-02, reflect.js PATTERNS:
// 92% of deaths in darkness with no torches, 88% with no sword, 88% underground, 100% with no food or armor; the step list used to end at 'coal'
// and then "explore" forever, which is how it kept walking into the dark). Each step is a capability, kept up by a repeatable process:
//   home      : the bed it respawns at is home; nights are slept there (or worked underground in a lit tunnel, never wandered)
//   vision    : torches are a staple (coal, else charcoal from logs) and home is lit in a ring
//   renewables: saplings get planted in a grove around home, so wood never depends on luck
//   defense   : shield + iron armor + iron sword as soon as iron allows
//   iron      : lit strip mining under home (the conservative, mostly-underground way of working)
//   storage   : a chest at home takes the surplus so the bag never blocks work
// Loaded by autopilot/index.js (plan(G, S, M, api, log)); hot-reloads with ap.reload().
const fs = require('fs')

module.exports = function plan(G, S, M, api, log) {
  const bot = S.bot, { goals } = S, v = S.v
  const st = G.state
  const note = (m) => { try { G.note(m) } catch { log('PLAN', m) } }
  const tier = (k) => S.toolTier(k)
  const cnt = (re) => S.count(re)
  M.st = st                                                       // mining.js keeps seen spawners in the plan state
  const cobbleRe = /^(cobblestone|cobbled_deepslate)$/
  const ids = (re) => bot.registry.blocksArray.filter(b => re.test(b.name)).map(b => b.id)

  // ---------- shared sleep status (both bots run this code; the file sits in the code folder they share) ----------
  const SLEEP_FILE = require('path').join(__dirname, '..', '..', 'bots-sleep.json')
  const readSleep = () => { try { return JSON.parse(fs.readFileSync(SLEEP_FILE, 'utf8')) } catch { return {} } }
  const sleepMark = (on) => { try { const m = readSleep(); m[bot.username] = { sleeping: !!on, at: Date.now() }; fs.writeFileSync(SLEEP_FILE, JSON.stringify(m)) } catch {} }
  // every other bot that reported in the last minute is in bed (a bot that is offline does not count)
  const othersAsleep = () => { const m = readSleep(); return Object.entries(m).filter(([n, r]) => n !== bot.username && Date.now() - r.at < 60000).every(([, r]) => r.sleeping) }
  { const t = setInterval(() => { try { if (bot.entity) sleepMark(bot.isSleeping) } catch {} }, 15000); const prev = G.dispose; G.dispose = () => { clearInterval(t); if (prev) prev() } }

  // ---------- home ----------
  function home() {
    // home is stable: keep it while that bed still stands (or its chunk is not loaded). Re-picking 'the nearest bed' every minute moved home into a trial chamber at y-22.
    if (st.home) { const hb = S.block(v(st.home[0], st.home[1], st.home[2])); if (!hb || /_bed$/.test(hb.name)) return v(st.home[0], st.home[1], st.home[2]) }
    // the bed is gone: the search costs half a second, and every step's need() asks for home, so it runs at most once a minute
    // (the rebed step puts a bed back at the old spot meanwhile)
    if (st.home && Date.now() - (home.searchedAt || 0) < 60000) return v(st.home[0], st.home[1], st.home[2])
    home.searchedAt = Date.now()
    const z = S.zone && S.zone(), c = z && z.workZone ? z.workZone : null
    const from = bot.entity.position
    const beds = bot.findBlocks({ matching: ids(/_bed$/), maxDistance: 64, count: 8 })
      .filter(p => !c || Math.hypot(p.x - c.x, p.z - c.z) <= c.r)
      .sort((a, b) => a.distanceTo(from) - b.distanceTo(from))
    if (beds.length) { st.home = [beds[0].x, beds[0].y, beds[0].z]; st.homeAt = Date.now(); G.save() }
    return st.home ? v(st.home[0], st.home[1], st.home[2]) : null
  }
  const nearHome = (r = 24) => { const h = home(); return h && bot.entity.position.distanceTo(h) <= r }
  const outdoorCell = (p) => { const b = S.block(p), a = S.block(p.offset(0, 1, 0)), g = S.block(p.offset(0, -1, 0)); return b && a && g && S.isAir(b) && S.passable(a) && S.solid(g) && !S.isLiquid(g) }

  // surface cells in a ring around home
  function ring(rMin, rMax, step) {
    const h = home(); if (!h) return []
    const out = []
    for (let dx = -rMax; dx <= rMax; dx += step) for (let dz = -rMax; dz <= rMax; dz += step) {
      const d = Math.hypot(dx, dz); if (d < rMin || d > rMax) continue
      for (let dy = 10; dy >= -12; dy--) { const p = v(h.x + dx, h.y + dy, h.z + dz); if (outdoorCell(p)) { out.push(p); break } }
    }
    return out
  }

  // ---------- steps ----------
  const torchFuel = () => cnt(/^(coal|charcoal)$/)
  const logName = () => { const t = {}; for (const i of S.items()) if (/_log$/.test(i.name)) t[i.name] = (t[i.name] || 0) + i.count; return Object.entries(t).sort((a, b) => b[1] - a[1]).map(x => x[0])[0] || null }
  // never go underground with a single pickaxe and no way to make another: that stranded the bot at y-22 with no tool and no wood (2026-11-03)
  const spareTools = () => S.count(/^(stone|iron|diamond)_pickaxe$/) >= 2 || (cnt(cobbleRe) >= 3 && (S.count('stick') >= 2 || S.logs() >= 1 || S.items().some(i => /_planks$/.test(i.name) && i.count >= 2)))
  // a trip away from home only starts with enough daylight to come back (died at dusk 80 blocks out with 2 hp, 23:24)
  const daylightLeft = () => { const t = bot.time && bot.time.timeOfDay; return typeof t === 'number' && t < 11500 ? 11500 - t : 0 }
  const ironUnits = () => cnt('iron_ingot') + cnt('raw_iron')
  const ARMOR = [['iron_chestplate', 8, 'torso'], ['iron_leggings', 7, 'legs'], ['iron_helmet', 5, 'head'], ['iron_boots', 4, 'feet']]
  const worn = (slot) => { try { return bot.inventory.slots[bot.getEquipmentDestSlot(slot)] } catch { return null } }
  // armor tiers: an item counts as an upgrade only over an empty slot or a lower tier
  const ARMOR_TIER = { leather: 1, golden: 2, chainmail: 3, iron: 4, diamond: 5, netherite: 6, turtle: 2 }
  const armorUp = (it) => { const m = /^([a-z]+)_(helmet|chestplate|leggings|boots)$/.exec(it.name); if (!m) return false
    const w = worn({ helmet: 'head', chestplate: 'torso', leggings: 'legs', boots: 'feet' }[m[2]]); if (!w) return true
    const wm = /^([a-z]+)_/.exec(w.name); return (ARMOR_TIER[m[1]] || 0) > (ARMOR_TIER[wm && wm[1]] || 0) }
  const hasShield = () => S.has('shield') || (worn('off-hand') && worn('off-hand').name === 'shield')

  const steps = [
    { id: 'night-home', budget: 660000, need: () => S.isNight() && !bot.isSleeping && !!home() && Date.now() > (st.noSleepUntil || 0) && Math.floor(bot.entity.position.y) > 50 && (!st.waitBedForOthers || othersAsleep()), cool: 30000, run: async () => {
      st.waitBedForOthers = false
      const h = home()
      // with a shelter round the bed: to the cell outside its door first, then in through the door to a floor cell beside the bed.
      // A plain go-to near the bed ended on the shelter roof twice (13:01, 14:48: 'cannot sleep: the bed is too far').
      let r
      if (st.shelterDoor && G.role !== 'assistant') r = await G.enterShelter()
      else r = await S.goto(new goals.GoalNear(h.x, h.y, h.z, 2), { dig: false, ms: 90000 })
      const bed = bot.findBlock({ matching: ids(/_bed$/), maxDistance: 4 })
      if (!bed) { st.noSleepUntil = Date.now() + 120000; return !!r.ok }
      try { await bot.sleep(bed); note('sleeping at home') } catch (e) { note('cannot sleep: ' + e.message); st.noSleepUntil = Date.now() + 5 * 60000; return true }
      // the night does not skip while another player is up, so stay in bed until morning: getting up after 2 minutes sent it out among the mobs
      // the assistant (Walter 2026-11-05): a minute in bed, then up again if the other bot is not in bed too (the night cannot skip anyway);
      // when the other bot lies down later, back to bed (the need() above re-opens as soon as the shared file says so)
      const t0 = Date.now(); let roseEarly = false
      while (bot.isSleeping && S.isNight() && Date.now() - t0 < 600000) {
        await S.wait(1000); sleepMark(true)
        if (G.role === 'assistant' && Date.now() - t0 > 60000 && !othersAsleep()) { roseEarly = true; break }
      }
      if (bot.isSleeping) { try { await bot.wake() } catch {} }
      sleepMark(false)
      if (roseEarly) { st.noSleepUntil = 0; st.waitBedForOthers = true; note('up after a minute: the other bot is not in bed') }
      else st.noSleepUntil = Date.now() + 5 * 60000
      return true } },

    { id: 'torches', need: () => cnt('torch') < 24 && (torchFuel() > 0 || (S.logs() >= 12 && (S.has('furnace') || S.furnaceNear(32) || cnt(cobbleRe) >= 8))), cool: 60000, run: async () => {
      if (!torchFuel()) {
        const ln = logName(); if (!ln) return false
        if (S.logs() < 12) return false          // keep a wood reserve: the last logs are the next pickaxe, not torches (it stranded itself with none)
        // the wood reserve counts all logs: 8 oak + 4 birch gave count(oak) - 8 = 0 to smelt and the step failed every minute (torches failed x10)
        const got = await S.smelt(ln, Math.min(6, S.logs() - 8, S.count(ln)))   // charcoal: the renewable torch fuel
        note('charcoal from ' + ln + ': ' + got)
      }
      const n = torchFuel(); if (!n) return false
      // one batch (1 fuel + 1 stick = 4 torches) at a time: asking for 24 at once fails when coal and charcoal are split across two recipe variants
      let ok = false
      for (let i = 0; i < 16 && torchFuel() > 0 && cnt('torch') < 64; i++) { const before = cnt('torch'); await S.craft('torch', before + 4); if (cnt('torch') <= before) break; ok = true }
      note('torches now ' + cnt('torch'))
      return ok } },

    // ---- restock: after a death the bag is empty but the home chest is not. Take back the basics before anything else. ----
    { id: 'restock', budget: 120000, need: () => !!home() && Date.now() > (st.restockAt || 0) && (tier('pickaxe') < 1 || cnt(cobbleRe) < 8 || cnt('torch') < 8 || S.foodPoints() < 8 || S.logs() + S.planks() < 4), cool: 60000, run: async () => {
      st.restockAt = Date.now() + 3 * 60000
      const h = home()
      // the home chests at floor level only: two chests in the hollow under the shelter floor (188/191,68,-292) cannot be reached from the
      // house, and the walk for them ended on the shelter roof, stuck, three times (06:58-07:06)
      const chests = bot.findBlocks({ matching: ids(/^chest$/), maxDistance: 16, count: 10, point: h }).filter(p => Math.abs(p.y - h.y) <= 1).slice(0, 6)
      if (!chests.length) return false
      const want = [[cobbleRe, 48], [/_log$/, 16], [/_planks$/, 8], [/^stick$/, 8], [/^torch$/, 64], [/^(coal|charcoal)$/, 32], [/^(bread|dried_kelp|cooked_[a-z_]+|baked_potato|apple|sweet_berries|carrot)$/, 32], [/_pickaxe$|_sword$|_axe$|^shield$|_(helmet|chestplate|leggings|boots)$/, 9], [/^crafting_table$/, 1], [/^furnace$/, 1], [/_sapling$/, 8], [/^(raw_iron|iron_ingot)$/, 64], [/^dirt$/, 16], [/^(string|fishing_rod)$/, 8]]
      let took = 0
      for (const cp of chests) {
        // plain walking only: the escalating go-to climbed onto the shelter roof over the home chests and stood there, stuck (06:58, 07:03)
        let r = await S.goto(new goals.GoalLookAtBlock(cp, bot.world, { reach: 3.5 }), { dig: false, ms: 25000, escalate: false })
        if (!r.ok) r = await S.goto(new goals.GoalNear(cp.x, cp.y, cp.z, 2), { dig: false, ms: 20000, escalate: false })
        if (!r.ok && S.eye().distanceTo(cp.offset(0.5, 0.5, 0.5)) > 4.4) continue
        let c; S.closeWindows(); try { c = await bot.openContainer(bot.blockAt(cp)) } catch { continue }
        try {
          for (const it of c.containerItems()) {
            const w = want.find(([re]) => re.test(it.name)); if (!w) continue
            const have = cnt(w[0]), n = Math.min(it.count, w[1] - have); if (n <= 0) continue
            try { await c.withdraw(it.type, null, n); took += n } catch {}
          }
        } finally { try { c.close() } catch {} }
      }
      if (!took) st.restockAt = Date.now() + 15 * 60000   // nothing useful in the chests: don't keep walking back
      note(`restock: took ${took} items from the home chests`)
      return took > 0 } },

    // ---- tools never run out: both pickaxes wore out at y23 and inventory (2x2) crafting is unreliable on this server, so the bot was stranded.
    // Keep a spare pickaxe and a crafting table in the bag; with no tool and no table, walk back to a remembered table first. ----
    { id: 'tool-kit', budget: 240000, need: () => (tier('pickaxe') < 1 && (cnt(cobbleRe) >= 3 || S.logs() + S.planks() >= 3)) || (!S.has('crafting_table') && S.logs() + S.planks() >= 2) || (S.count(/^(stone|iron|diamond)_pickaxe$/) < 2 && cnt(cobbleRe) >= 3 && S.logs() + S.planks() + S.count('stick') >= 2), cool: 60000, run: async () => {
      const tbl = S.tableNear(4.5)
      if (tbl) { const p = tbl.position; st.tables = [[p.x, p.y, p.z]].concat((st.tables || []).filter(q => q[0] !== p.x || q[2] !== p.z)).slice(0, 6) }
      if (!tbl && !S.has('crafting_table')) {
        const known = (st.tables || []).map(q => v(q[0], q[1], q[2])).filter(q => { const b = S.block(q); return (!b || b.name === 'crafting_table') && (bot.entity.position.y < 56 || !home() || q.y >= home().y - 8) }).sort((a, b) => S.dist(a) - S.dist(b))[0]   // the nearest one; from the surface, not a table down in the caves.sort((a, b) => S.dist(a) - S.dist(b))[0]
        const target = known || (home() && bot.findBlock({ matching: ids(/^crafting_table$/), maxDistance: 48, point: home() })?.position)
        if (target) { const r = await S.goto(new goals.GoalNear(target.x, target.y, target.z, 2), { dig: false, ms: 150000 }); note('tool-kit: walked to the table at ' + target + ' ' + r.ok) }
      }
      if (!S.has('crafting_table')) await S.craft('crafting_table', 1)
      if (cnt(cobbleRe) >= 3) await S.craft('stone_pickaxe', Math.min(2, S.count('stone_pickaxe') + Math.floor(cnt(cobbleRe) / 3)))
      else if (tier('pickaxe') < 1) await S.craft('wooden_pickaxe', 1)
      note(`tool-kit: pickaxes ${S.count(/_pickaxe$/)}, table in bag ${S.has('crafting_table')}`)
      return tier('pickaxe') >= 1 } },

    // ---- wood stock: logs feed charcoal -> torches -> the mine. With no logs the whole chain stopped and the bot wandered (and drowned exploring). ----
    { id: 'wood-stock', budget: 300000, need: () => !S.isNight() && S.logs() * 4 + S.planks() < 48, cool: 90000, run: async () => {
      // trees are a surface job: from the mine, walk home first (it kept failing from underground and marking every trunk unreachable)
      if (!S.skyVisible() && home()) { const h0 = home(); await S.goto(new goals.GoalNear(h0.x, h0.y, h0.z, 3), { dig: false, ms: 120000 }); st.badTrees = [] }
      let got = await S.chopTree(12, { ms: 150000 })
      if (!got) {
        // walk the grove / the trees seen before around home, staying on the surface
        const h = home()
        // grove trees first (planted for this), then other trunks; a trunk it could not reach is skipped for 30 min instead of retried forever
        st.badTrees = (st.badTrees || []).filter(b => Date.now() - b[3] < 30 * 60000)
        const bad = (p) => st.badTrees.some(b => Math.abs(b[0] - p.x) <= 2 && Math.abs(b[2] - p.z) <= 2)
        const groveLogs = (st.grove || []).map(q => v(q[0], q[1], q[2])).filter(p => { const b = S.block(p); return b && /_log$/.test(b.name) })
        const remembered = (st.treeSeen || []).map(q => v(q[0], q[1], q[2])).filter(p => { const blk = S.block(p); return !blk || /_log$/.test(blk.name) })   // unloaded = maybe still there
        const trees = groveLogs.concat(bot.findBlocks({ matching: ids(/_log$/), maxDistance: 64, count: 60, point: h || bot.entity.position }).filter(p => S.inZone(p))).concat(remembered.sort((p, q) => S.dist(p) - S.dist(q))).filter(p => !bad(p))
        for (const t of trees.slice(0, 4)) {
          const r = await S.goto(new goals.GoalNear(t.x, t.y, t.z, 3), { dig: false, ms: 45000 })
          const before = got
          if (r.ok) got += await S.chopTree(12, { ms: 90000 })
          if (got === before) st.badTrees.push([t.x, t.y, t.z, Date.now()])
          if (got) break
        }
        // saplings come from leaves: after felling, clear the canopy around the stump until there are enough for the tree farm
        if (got && S.count(/_sapling$/) < 8) { await S.gather(/_leaves$/, 20, { radius: 7, ms: 50000 }); await S.pickup(10, 5000) }
        // replant: every felled grove tree gets a sapling back
        for (const q of (st.grove || [])) { const p = v(q[0], q[1], q[2]), b = S.block(p), sap = S.items().find(i => /_sapling$/.test(i.name)); if (sap && b && S.isAir(b)) { const g = S.block(p.offset(0, -1, 0)); if (g && /grass_block|dirt/.test(g.name) && S.dist(p) < 5) await S.placeAgainst(g, v(0, 1, 0), sap.name) } }
      }
      await S.pickup(10, 4000)
      note(`wood-stock: +${got} logs, now ${S.logs()}`); return got > 0 } },

    { id: 'shield', need:() => !hasShield() && cnt('iron_ingot') >= 1 && S.logs() * 4 + S.planks() >= 6, run: async () => {
      const ok = await S.craft('shield', 1); const it = S.items().find(i => i.name === 'shield'); if (it) { try { await bot.equip(it, 'off-hand') } catch {} }
      note('shield ' + (ok ? 'made and worn' : 'craft failed')); return ok } },
    { id: 'iron-smelt', need: () => cnt('raw_iron') >= 3, cool: 60000, run: async () => { const got = await S.smelt('raw_iron', cnt('raw_iron')); note('smelted iron ' + got); return got > 0 } },
    // Walter 2026-11-06: no iron tools, they waste iron (they went with every death). Stone tools are the default; iron goes into armor
    // (and the shield). The one iron pickaxe is made in the tunnel when an ore that needs it (diamond, gold, redstone, emerald) is in sight.
    { id: 'iron-gear', need: () => ARMOR.some(([n, c, s]) => !S.has(n) && !(worn(s) && worn(s).name === n) && cnt('iron_ingot') >= c), run: async () => {
      for (const [n, c, s] of ARMOR) {
        if (S.has(n) || (worn(s) && worn(s).name === n) || cnt('iron_ingot') < c) continue
        const ok = await S.craft(n, 1); const it = S.items().find(i => i.name === n); if (it) { try { await bot.equip(it, s) } catch {} }
        note(n + ' ' + (ok ? 'made and worn' : 'craft failed')); return ok
      }
      return false } },
    // only an upgrade over what is worn (Smeo kept 'wearing' spare golden leggings over chainmail ones and the loop detector parked the step)
    { id: 'wear', need: () => S.items().some(i => armorUp(i)) || (S.has('shield') && !(worn('off-hand') && worn('off-hand').name === 'shield')), cool: 30000, run: async () => {
      for (const it of S.items()) { const m = /_(helmet|chestplate|leggings|boots)$/.exec(it.name); if (m && armorUp(it)) { try { await bot.equip(it, { helmet: 'head', chestplate: 'torso', leggings: 'legs', boots: 'feet' }[m[1]]) } catch {} } }
      const sh = S.items().find(i => i.name === 'shield'); if (sh) { try { await bot.equip(sh, 'off-hand') } catch {} }
      return true } },

    // tree farm (Walter: birch, saplings with 3 blocks between them, well lit): a 4-block lattice around home, a torch in the middle of each
    // lattice square, every sapling spot needs open sky above for the tree; spots are remembered and replanted when a tree is felled
    { id: 'grove', budget: 180000, need: () => !!home() && Date.now() > (st.groveRestUntil || 0) && S.items().some(i => /_sapling$/.test(i.name)) && (st.grove || []).filter(q => { const b = S.block(v(q[0], q[1], q[2])); return b && (/_sapling$|_log$/.test(b.name)) }).length < 24 && !S.isNight(), cool: 90000, run: async () => {
      const h = home(); st.grove = (st.grove || [])
      const live = (q) => { const b = S.block(v(q[0], q[1], q[2])); return b && /_sapling$|_log$/.test(b.name) }
      const spots = []
      for (let dx = -20; dx <= 20; dx++) for (let dz = -20; dz <= 20; dz++) {
        if (((dx % 4) + 4) % 4 || ((dz % 4) + 4) % 4) continue
        const d = Math.hypot(dx, dz); if (d < 8 || d > 20) continue
        for (let dy = 8; dy >= -10; dy--) {
          const p = v(h.x + dx, h.y + dy, h.z + dz), g = S.block(p.offset(0, -1, 0)), c = S.block(p)
          if (!g || !c) continue
          if (S.isAir(c) && /^(grass_block|dirt|podzol|coarse_dirt)$/.test(g.name)) {
            let open = true; for (let k = 1; k <= 6 && open; k++) { const a = S.block(p.offset(0, k, 0)); if (a && !S.isAir(a) && !/leaves/.test(a.name)) open = false }
            if (open && !(st.farm || []).some(q => Math.abs(q[0] - p.x) <= 2 && Math.abs(q[2] - p.z) <= 2)) spots.push(p)
            break
          }
          if (!S.isAir(c)) break
        }
      }
      spots.sort((p, q) => S.dist(p) - S.dist(q))
      let planted = 0
      for (const p of spots) {
        if (planted >= 6) break
        if (live([p.x, p.y, p.z])) continue
        const sap = S.items().filter(i => /_sapling$/.test(i.name)).sort((a, b) => (/birch/.test(b.name) ? 1 : 0) - (/birch/.test(a.name) ? 1 : 0))[0]; if (!sap) break
        const r = await S.goto(new goals.GoalNear(p.x, p.y, p.z, 2), { dig: false, ms: 30000 }); if (!r.ok) continue
        if (await S.placeAgainst(S.block(p.offset(0, -1, 0)), v(0, 1, 0), sap.name)) {
          if (!st.grove.some(q => q[0] === p.x && q[2] === p.z)) st.grove.push([p.x, p.y, p.z])
          planted++
          // light the square: a torch two blocks off the sapling, on the diagonal (between four lattice spots)
          const tp = p.offset(2, 0, 2), tg = S.block(tp.offset(0, -1, 0)), tc = S.block(tp)
          if (cnt('torch') > 2 && tg && S.solid(tg) && tc && S.isAir(tc) && !bot.findBlock({ matching: ids(/^(torch|wall_torch)$/), maxDistance: 3, point: tp })) await S.placeAgainst(tg, v(0, 1, 0), 'torch')
        }
      }
      // nowhere left to plant on the lattice: rest the step an hour instead of retrying every few minutes (failed x6 by 08:51)
      if (!planted) st.groveRestUntil = Date.now() + 3600000
      G.save(); note(`grove: planted ${planted}, ${st.grove.filter(live).length} live trees/saplings on the lattice`)
      return planted > 0 } },

    // ---- surface lighting (Walter 2026-11-04): a regular torch grid over the land around home looks good and keeps it safe, and it has to reach
    // far enough that mobs spawning on nearby land cannot notice the bot and walk in. Torch light 14 drops 1 per block and mobs spawn only at
    // block light 0 (1.18+), so on flat land a 10-block grid leaves at least light 4 between torches; hills and walls are covered by fill-in
    // torches where the computed light (light.js; the server's light data is scrambled) still shows spawnable cells. Torches off the grid that
    // the grid makes redundant are taken down by day (the island had 417, mostly bunched). ----
    { id: 'light-home', budget: 180000, need: () => !!home() && cnt('torch') >= 4 && nearHome(72) && Date.now() > (st.lightAt || 0), cool: 60000, run: async () => {
      // 32 by day (64 and then 40 still took 230 s on this machine with the server alongside and the watchdog reset the bot mid-step,
      // 01:02 and 05:59), 24 near dusk
      const h = home(), GRID = 10, R = daylightLeft() > 2500 ? 32 : 24
      const torchIds = ids(/^(torch|wall_torch)$/)
      // the walkable top of a column (not on leaves, not in water), or null
      const surface = (x, z) => { for (let y = h.y + 20; y >= h.y - 16; y--) { const g = S.block(v(x, y - 1, z)); if (!g) return null
          if (S.isLiquid(g)) return null; if (/leaves/.test(g.name)) continue
          if (outdoorCell(v(x, y, z))) return v(x, y, z) } return null }
      const avoid = (p) => nearList(p, st.grove, 1) || nearList(p, st.farm, 1) || inBox(p, homeBox())
      const torchNear = (p, r) => bot.findBlocks({ matching: torchIds, point: p, maxDistance: r + 1, count: 6 }).some(t => Math.abs(t.x - p.x) <= r && Math.abs(t.z - p.z) <= r && Math.abs(t.y - p.y) <= 4)
      // 1. grid points: x and z on the home lattice; a point on water, a tree, the farm or the house shifts to the nearest usable cell within 2
      const grid = []
      for (let dx = -R; dx <= R; dx += GRID) for (let dz = -R; dz <= R; dz += GRID) {
        if (Math.hypot(dx, dz) > R || (Math.abs(dx) < 4 && Math.abs(dz) < 4)) continue
        let spot = null
        for (const [ox, oz] of [[0, 0], [1, 0], [0, 1], [-1, 0], [0, -1], [1, 1], [-1, -1], [1, -1], [-1, 1], [2, 0], [0, 2], [-2, 0], [0, -2]]) {
          const p = surface(h.x + dx + ox, h.z + dz + oz); if (p && !avoid(p)) { spot = p; break } }
        if (spot) grid.push(spot)
      }
      const missing = grid.filter(p => !torchNear(p, 2)).sort((a, b) => S.dist(a) - S.dist(b))
      let placed = 0
      for (const p of missing) {
        if (placed >= 16 || cnt('torch') < 2 || (R > 24 && daylightLeft() < 1500)) break
        const r = await S.goto(new goals.GoalNear(p.x, p.y, p.z, 2), { dig: false, ms: 20000, escalate: false }); if (!r.ok) continue
        const g = S.block(p.offset(0, -1, 0)), b = S.block(p)
        if (g && b && S.isAir(b) && await S.placeAgainst(g, v(0, 1, 0), 'torch')) placed++
      }
      // 2. fill-in: cells the grid still leaves at light 0 (hills, walls, pits) within R, nearest first, at most one per 8 blocks per pass
      delete require.cache[require.resolve('./light')]
      const L = require('./light')(bot, v(0, 0, 0).constructor)
      const lm = await L.compute(h, R, 20)
      const surfaceCells = []
      // in slices: scanning ~3000 columns in one go froze the event loop for 2-3 s, and nothing (combat included) runs meanwhile
      for (let dx = -R; dx <= R; dx += 2) { for (let dz = -R; dz <= R; dz += 2) { if (Math.hypot(dx, dz) > R) continue; const p = surface(h.x + dx, h.z + dz); if (p) surfaceCells.push(p) } await new Promise(r => setImmediate(r)) }
      // the farm sits in a hollow below home (y62) that the top-down scan never reaches; three skeletons stood there at 20:26.
      // Cells around the plots, at the plots' level, count as ground to light too.
      const seenCell = new Set(surfaceCells.map(p => p.x + ',' + p.y + ',' + p.z))
      for (const q of st.farm || []) for (let dx = -5; dx <= 5; dx++) for (let dz = -5; dz <= 5; dz++) for (let dy = 0; dy <= 2; dy++) {
        const p = v(q[0] + dx, q[1] + dy, q[2] + dz), k = p.x + ',' + p.y + ',' + p.z; if (seenCell.has(k)) continue; seenCell.add(k)
        if (outdoorCell(p)) surfaceCells.push(p) }
      // and the caves right under the house: the bot died again and again at y57-65 below home (23:10, 23:17), where it keeps passing
      for (let dx = -12; dx <= 12; dx++) for (let dz = -12; dz <= 12; dz++) for (let dy = -14; dy <= -2; dy++) {
        const p = v(h.x + dx, h.y + dy, h.z + dz), k = p.x + ',' + p.y + ',' + p.z; if (seenCell.has(k)) continue
        if (outdoorCell(p)) { seenCell.add(k); surfaceCells.push(p) } }
      const dark = surfaceCells.filter(p => lm.spawnable(p) && !avoid(p))
      let filled = 0; const lit = []
      if (placed === missing.length) for (const p of dark.sort((a, b) => S.dist(a) - S.dist(b))) {
        if (filled >= 8 || cnt('torch') < 2) break
        if (lit.some(q => q.distanceTo(p) < 8)) continue
        const r = await S.goto(new goals.GoalNear(p.x, p.y, p.z, 2), { dig: false, ms: 20000, escalate: false }); if (!r.ok) continue
        const g = S.block(p.offset(0, -1, 0))
        if (g && await S.placeAgainst(g, v(0, 1, 0), 'torch')) { filled++; lit.push(p) }
      }
      // 3. by day: surface torches off the grid that nothing needs come down (light recomputed
      // without them; a torch is kept if a cell would go dark within 12 blocks of it). The house, farm, grove and underground torches stay.
      let removed = 0
      if (R > 24) {      // safe before the grid is complete too: a torch is only taken if the light without it still leaves no spawnable cell
        const onGrid = (t) => grid.some(g => Math.abs(g.x - t.x) <= 2 && Math.abs(g.z - t.z) <= 2 && Math.abs(g.y - t.y) <= 4)
        const off = bot.findBlocks({ matching: torchIds, point: h, maxDistance: R, count: 3000 }).filter(t => {
          if (onGrid(t) || inBox(t, homeBox()) || nearList(t, st.farm, 2) || nearList(t, st.grove, 2)) return false
          // on the surface: open sky above the torch (the column scan skips the torch cell itself, so it cannot be used here)
          for (let y = t.y + 1; y <= t.y + 24; y++) { const a = S.block(v(t.x, y, t.z)); if (a && a.boundingBox === 'block' && !/leaves/.test(a.name)) return false }
          return true })
        if (off.length) {
          // one torch at a time, most crowded first: light recomputed around it without it (and without those already taken); it goes only
          // if no surface cell within 14 blocks turns spawnable without it. (Taking all off-grid torches out at once and keeping the nearest to each
          // dark cell kept every one of them while the grid was half built.)
          const gone = new Set(), k = (t) => t.x + ',' + t.y + ',' + t.z
          const crowd = (t) => off.filter(o => o !== t && Math.abs(o.x - t.x) + Math.abs(o.z - t.z) <= 6).length
          const order = off.map(t => [t, crowd(t)]).sort((a, b) => b[1] - a[1] || S.dist(a[0]) - S.dist(b[0])).map(x => x[0])
          let checked = 0
          for (const t of order) {
            if (removed >= 40 || checked >= 80 || daylightLeft() < 1500) break
            checked++
            const lm3 = await L.compute(t, 16, 10, { exclude: new Set([...gone, k(t)]) }), lmw = await L.compute(t, 16, 10, { exclude: gone })
            let darkNear = false
            for (let dx = -14; dx <= 14 && !darkNear; dx++) for (let dz = -14; dz <= 14 && !darkNear; dz++) {
              if (Math.abs(dx) + Math.abs(dz) > 14) continue
              const p = surface(t.x + dx, t.z + dz); if (p && lm3.spawnable(p) && !lmw.spawnable(p) && !avoid(p)) darkNear = true }
            if (darkNear) continue
            const b = S.block(t); if (!b || !/torch/.test(b.name)) continue
            // forced: torches count as built blocks, so the plain dig refused every one after the walk out to it (05:24-05:26, 90 s a torch)
            if (await S.mine(b, { dig: false, force: true, escalate: false })) { removed++; gone.add(k(t)) }
          }
          if (removed) await S.pickup(6, 3000)
        }
      }
      st.lightAt = Date.now() + (missing.length > placed || dark.length > filled ? 60000 : 5 * 60000)
      st.lightGrid = { grid: grid.length, missing: missing.length - placed, dark: dark.length - filled }
      note(`light-home: grid ${grid.length - missing.length + placed}/${grid.length} torches within ${R}, +${placed} grid, +${filled} fill-in, ${dark.length - filled} spawnable cells left, ${removed} redundant torches taken down`)
      return placed + filled + removed > 0 || !missing.length } },

    // storage grows with the work: every chest at home is used, and when they are all full a new one is crafted and set down (the single chest filled up and the bag jammed)
    { id: 'stash', budget: 240000, need: () => S.freeSlots() <= 6 && !!home(), cool: 60000, run: async () => {
      const h = home()
      const plan = () => { const kept = {}, out = []
        for (const it of S.items()) {
          let keep = 0
          if (/_(pickaxe|axe|sword|shovel|hoe|helmet|chestplate|leggings|boots)$|^(shield|torch|bed|.*_bed|crafting_table|furnace|bucket|water_bucket|stick|fishing_rod)$/.test(it.name)) continue
          if (/^(bread|cooked_|baked_potato|apple|carrot|dried_kelp|sweet_berries)/.test(it.name)) continue
          if (/^(coal|charcoal|iron_ingot|raw_iron|string)$/.test(it.name)) continue
          if (cobbleRe.test(it.name)) keep = 64
          if (/_log$|_planks$/.test(it.name)) keep = 16
          if (/_sapling$/.test(it.name)) keep = 8
          if (it.name === 'dirt') keep = 16
          const left = kept[it.name] == null ? keep : kept[it.name], stay = Math.min(left, it.count); kept[it.name] = left - stay
          if (it.count - stay > 0) out.push({ it, n: it.count - stay })
        }
        return out }
      let moved = 0
      const chests = bot.findBlocks({ matching: ids(/^chest$/), maxDistance: 12, count: 16, point: h }).filter(p => Math.abs(p.y - h.y) <= 1).slice(0, 12)   // (floor level only, as restock)
      for (let round = 0; round < chests.length + 2 && plan().length; round++) {
        let pos = chests[round]
        if (!pos) {
          await S.goto(new goals.GoalNear(h.x, h.y, h.z, 4), { dig: false, ms: 60000 })
          if (!S.has('chest')) await S.craft('chest', 1)
          const placed = S.has('chest') ? await S.placeNear('chest') : null
          if (!placed) break
          pos = placed.position; note('stash: new home chest at ' + pos)
        }
        const r = await S.goto(new goals.GoalLookAtBlock(pos, bot.world, { reach: 3.5 }), { dig: false, ms: 60000 }); if (!r.ok) continue
        let c; S.closeWindows(); try { c = await bot.openContainer(bot.blockAt(pos)) } catch { continue }
        try { st.chestFree = st.chestFree || {}; st.chestFree[pos.toString()] = (c.inventoryStart || 27) - c.containerItems().length } catch {}
        try { for (const { it, n } of plan()) { try { await c.deposit(it.type, null, n); moved += n } catch { break } } } finally { try { st.chestFree[pos.toString()] = (c.inventoryStart || 27) - c.containerItems().length } catch {} try { c.close() } catch {} }
      }
      // safety valve: chests full and no wood for another chest, bag still jammed with stone rubble -> drop the rubble (it despawns) so tools, logs and food fit again
      if (S.freeSlots() <= 4) { let dropped = 0; for (const it of S.items()) { if (!/^(cobblestone|cobbled_deepslate|andesite|diorite|granite|tuff|gravel|dirt|deepslate|netherrack|leaf_litter)$/.test(it.name)) continue; const keepN = /cobble/.test(it.name) ? 64 : 0; const have = S.count(it.name); if (have - it.count < keepN) continue; try { await bot.toss(it.type, null, it.count); dropped += it.count } catch {} if (S.freeSlots() > 10) break } if (dropped) note('stash: chests full, dropped ' + dropped + ' rubble to free the bag') }
      note('stashed ' + moved + ' items at home'); return moved > 0 } },

    // ---- sustenance: 100% of deaths had no food. Hunting depends on luck; a wheat farm by water at home does not. ----
    { id: 'seeds', budget: 90000, need: () => !S.isNight() && !!home() && Date.now() > (st.seedsUntil || 0) && cnt('wheat_seeds') < 6 && (st.farm || []).length < 12, cool: 120000, run: async () => {
      st.seedsUntil = Date.now() + 20 * 60000   // pessimistic: cleared below on success
      // bot.findBlocks is cheap; S.seen with needSight:false over a big radius blocked the event loop long enough for the server to drop the connection
      let got = 0
      const grass = bot.findBlocks({ matching: ids(/^(short_grass|tall_grass|fern)$/), maxDistance: 48, count: 24 }).filter(p => !home() || p.distanceTo(home()) < 90)
      for (const p of grass) { const b = S.block(p); if (!b || !/grass|fern/.test(b.name)) continue; if (await S.mine(b, { dig: false })) got++; if (got >= 24) break }
      await S.pickup(10, 4000)
      if (got) st.seedsUntil = 0
      note(`seeds: cut ${got} grass, have ${cnt('wheat_seeds')} seeds`); return cnt('wheat_seeds') > 0 } },
    { id: 'farm', need: () => !S.isNight() && !!home() && cnt('wheat_seeds') >= 1 && (st.farm || []).length < 16, cool: 120000, run: async () => {
      st.farm = st.farm || []
      if (!S.items().some(i => /_hoe$/.test(i.name))) { if (!(await S.craft(cnt(cobbleRe) >= 2 ? 'stone_hoe' : 'wooden_hoe', 1))) return false }
      const h = home()
      const water = bot.findBlocks({ matching: ids(/^water$/), maxDistance: 40, count: 60, point: h }).filter(p => Math.abs(p.y - h.y) <= 14 && S.inZone(p))
        .filter(p => { const a = S.block(p.offset(0, 1, 0)); return a && S.isAir(a) })     // surface water only
        .sort((a, b) => a.distanceTo(h) - b.distanceTo(h))
      let made = 0
      // one level field around one water block (Walter: plots at mixed heights next to drops get trampled back to dirt): every cell within 4 of the
      // water at the water's own height becomes soil; stone/sand there is swapped for dirt, a missing block is filled, a block on top is cleared
      st.farmWater = st.farmWater && S.block(v(...st.farmWater)) && S.block(v(...st.farmWater)).name === 'water' ? st.farmWater : (water[0] ? [water[0].x, water[0].y, water[0].z] : null)
      if (cnt('dirt') < 8) await S.gather(/^(dirt|grass_block)$/, 12, { radius: 24, ms: 40000, filter: (b) => !S.isEstablished(b) && (!st.farmWater || b.position.distanceTo(v(...st.farmWater)) > 6) })
      for (const w of (st.farmWater ? [v(...st.farmWater)] : [])) {
        const cells = []
        const ring = []
        for (let dx = -4; dx <= 4; dx++) for (let dz = -4; dz <= 4; dz++) if (dx || dz) ring.push(w.offset(dx, 0, dz))
        ring.sort((p, q) => p.distanceTo(w) - q.distanceTo(w))
        for (const p of ring) {
          if (cells.length + st.farm.length >= 16) break
          if (st.farm.some(q => q[0] === p.x && q[1] === p.y && q[2] === p.z)) continue
          const g = S.block(p), a = S.block(p.offset(0, 1, 0)), under = S.block(p.offset(0, -1, 0))
          if (!g || !a || !under || S.isLiquid(g) || S.inZone && !S.inZone(p)) continue
          if (/^(grass_block|dirt|farmland)$/.test(g.name) && S.isAir(a)) { cells.push(p); continue }
          if (!cnt('dirt')) continue
          const r0 = await S.goto(new goals.GoalNear(p.x, p.y + 1, p.z, 3), { dig: false, ms: 25000 }); if (!r0.ok) continue
          if (!S.isAir(a) && a.boundingBox === 'block' && !(await S.digBlock(a))) continue          // keep the field level: nothing on top
          if (S.isAir(g)) { if (S.solid(under) && await S.placeAgainst(under, v(0, 1, 0), 'dirt')) cells.push(p); continue }
          if (/sand|gravel|stone|andesite|diorite|granite|clay|tuff|deepslate/.test(g.name) && S.solid(under) && await S.digBlock(g) && await S.placeAgainst(S.block(p.offset(0, -1, 0)), v(0, 1, 0), 'dirt')) cells.push(p)
        }
        for (const p of cells) {
          if (st.farm.length >= 16 || !cnt('wheat_seeds')) break
          const r = await S.goto(new goals.GoalNear(p.x, p.y + 1, p.z, 2), { dig: false, ms: 25000 }); if (!r.ok) continue
          let g = S.block(p)
          if (g.name !== 'farmland') {
            const hoe = S.items().find(i => /_hoe$/.test(i.name)); if (!hoe) break
            try { await bot.equip(hoe, 'hand'); await bot.lookAt(p.offset(0.5, 1, 0.5), true); await bot.activateBlock(g); await S.wait(250) } catch {}
            g = S.block(p); if (!g || g.name !== 'farmland') continue
          }
          if (await S.placeAgainst(g, v(0, 1, 0), 'wheat_seeds')) { st.farm.push([p.x, p.y, p.z]); made++ }
        }
        if (made) break
      }
      G.save(); note(`farm: planted ${made}, ${st.farm.length} plots by the water`)
      return made > 0 } },
    // kelp: the sea around the island is full of it, it regrows, and dried kelp is food. Cut it from the shore (reach, not diving), dry it in the furnace.
    { id: 'kelp', budget: 150000, need: () => !S.isNight() && !!home() && S.foodPoints() < 16 && cnt(/^(kelp|dried_kelp)$/) < 24, cool: 120000, run: async () => {
      const h = home()
      const ks = bot.findBlocks({ matching: ids(/^(kelp|kelp_plant)$/), maxDistance: 40, count: 80, point: h }).filter(p => p.y >= 57 && S.inZone(p)).sort((a, b) => b.y - a.y || S.dist(a) - S.dist(b))
      let got = 0
      for (const p of ks.slice(0, 20)) { const b = S.block(p); if (!b || !/kelp/.test(b.name)) continue; if (await S.mine(b, { dig: false, pick: false })) got++; if (got >= 12) break }
      await S.pickup(8, 5000)
      if (cnt('kelp') >= 4) { const d = await S.smelt('kelp', Math.min(cnt('kelp'), 16)); note('kelp: dried ' + d) }
      note(`kelp: cut ${got}, have ${cnt('kelp')} kelp / ${cnt('dried_kelp')} dried`); return got > 0 || cnt('dried_kelp') > 0 } },

    { id: 'harvest', budget: 300000, need:() => { if (S.isNight() || !home()) return false; if (Date.now() - (st._ripeAt || 0) > 20000) { st._ripeAt = Date.now(); st._ripe = bot.findBlocks({ matching: ids(/^wheat$/), point: home(), maxDistance: 40, count: 120 }).filter(p => { const c = S.block(p); return c && c.metadata >= 7 }).length } return st._ripe >= 4 }, cool: 120000, run: async () => {
      // every ripe stalk near home, nearest first (walking the plot list in stored order sent it to the shore plots first, among the
      // drowned, and the 30 ripe stalks of the starter farm were never reached)
      let n = 0
      const ripe = bot.findBlocks({ matching: ids(/^wheat$/), point: home(), maxDistance: 40, count: 120 }).filter(p => { const c = S.block(p); return c && c.metadata >= 7 })
      let at = bot.entity.position
      while (ripe.length) {
        ripe.sort((a, b) => a.distanceTo(at) - b.distanceTo(at)); const p = ripe.shift(), c = S.block(p)
        if (!c || c.name !== 'wheat' || c.metadata < 7) continue
        // plain walking only: crops on open farmland need no escalation, and its sidesteps spent ~50 s a stalk (05:27-05:29, 4 wheat in 2 min)
        if (await S.mine(c, { dig: false, escalate: false })) { n++; const f = S.block(p.offset(0, -1, 0)); if (f && f.name === 'farmland' && cnt('wheat_seeds')) await S.placeAgainst(f, v(0, 1, 0), 'wheat_seeds') }
        at = bot.entity.position
      }
      await S.pickup(8, 4000)
      if (cnt('wheat') >= 3) await S.craft('bread', Math.floor(cnt('wheat') / 3))
      note(`harvest: ${n} wheat cut and replanted, bread ${cnt('bread')}`); return n > 0 } },

    { id: 'iron', budget: 600000, need:() => !(S.isNight() && bot.entity.position.y > 56) && tier('pickaxe') >= 2 && spareTools() && cnt('torch') >= 12 && S.foodPoints() + S.rawFood() * 2 >= 6 && ironUnits() < 32 && S.freeSlots() > 6 && !!home(), cool: 60000, run: async () => {
      // ONE established mine (Walter: a player builds one staircase and routes to it, instead of breaching the surface again and again).
      // st.mine = { entry: surface cell where the staircase starts, bottom: where it ends, path: cells walked on the way down }.
      // Going down = walk to the entry and down the existing stairs; only the very first trip (or a lost shaft) digs a new one.
      // Underground everything is free: tunnels branch from the bottom in turn.
      const h = home(), y = Math.floor(bot.entity.position.y)
      // water or lava on every side, three times running (17:05: a spot under home by an aquifer, 15 minutes of retries): this site is done.
      // Back to the surface; the shaft is given up and the next one starts at another spot around home.
      // first a level 8 further down the same shaft (twice at most): the aquifer at y20 under 150,-298 ended the only dry shaft in
      // reach at 03:37, and no other site was found for two hours after
      if ((st.mineBlocked || 0) >= 3 && st.mine && st.mine.bottom && st.mine.bottom[1] - 8 >= 4 && (st.mine.wetDrops || 0) < 2) {
        st.mine.wetDrops = (st.mine.wetDrops || 0) + 1; G.save()
        const bb = v(...st.mine.bottom); if (S.dist(bb) > 3) await S.goto(new goals.GoalNear(bb.x, bb.y, bb.z, 1), { dig: false, ms: 90000, escalate: false })
        if (S.dist(bb) <= 4) {
          const r = await M.descend(st.mine.bottom[1] - 8, { maxSteps: 40, dir0: st.mine.dir0 })
          const b = S.flo(bot.entity.position)
          if (b.y < st.mine.bottom[1] - 3) { st.mine.bottom = [b.x, b.y, b.z]; st.mineBlocked = 0; st.mineEmpty = 0; G.save(); note(`mine: water all round at this level, new level at y${b.y} in the same shaft (${JSON.stringify(r)})`); return true }
        }
      }
      if ((st.mineBlocked || 0) >= 3) {
        // remembered as wet underground, so the land-site scan does not pick it again (it chose the same flooded site twice, 10:20 and 10:46)
        { const e = st.mine && st.mine.entry ? st.mine.entry : [Math.floor(bot.entity.position.x), 0, Math.floor(bot.entity.position.z)]; st.wetSites = (st.wetSites || []).concat([[e[0], e[2]]]).slice(-40) }
        const up = await M.goSurface(); st.mineBlocked = 0; st.mine = null; st.mineSite = null; st.mineSpot = (st.mineSpot || 0) + 1; G.save()
        note('mine: blocked by water three times here, giving this shaft up (surfaced ' + up + '); next shaft at spot ' + st.mineSpot); return false
      }
      if (y > 56) {
        if (st.mine && st.mine.bottom) {
          const e = v(...st.mine.entry), b = v(...st.mine.bottom)
          await S.goto(new goals.GoalNear(e.x, e.y, e.z, 2), { dig: false, ms: 120000 })
          // down by the recorded stairs, cell by cell (the go-to to the bottom took a cave route instead and stopped at y48 31 blocks off
          // the stairs, 12:30); the go-to below finishes or stands in when there is no record
          { const path = (st.mine.path || []).map(q => v(...q))
            if (path.length > 3 && S.dist(path[0].offset(0.5, 0, 0.5)) < 5) {
              let fails = 0, i = 1
              for (; i < path.length && fails < 4; i++) {
                S.check()
                const q = path[i]
                let rr = await S.goto(new goals.GoalBlock(q.x, q.y, q.z), { dig: false, ms: 8000, escalate: false })
                if (!rr.ok) { for (const c of [q.offset(0, 1, 0), q]) { const bl = S.block(c); if (bl && bl.boundingBox === 'block' && !S.isLiquid(bl)) await S.digBlock(bl, { force: true }).catch(() => false) }
                  rr = await S.goto(new goals.GoalBlock(q.x, q.y, q.z), { dig: false, ms: 8000, escalate: false }) }
                if (!rr.ok) fails++
              }
              log('PLAN', `mine: stairs down to cell ${i - 1}/${path.length}, ${fails} fails, at ${S.flo(bot.entity.position)}`)
            } }
          const r = await S.goto(new goals.GoalNear(b.x, b.y, b.z, 2), { dig: false, ms: 150000 })
          note(`mine: walked down the shaft to y${Math.floor(bot.entity.position.y)} (${r.ok ? 'ok' : r.err || r.why})`)
          if (!r.ok && Math.floor(bot.entity.position.y) > 56) { st.mine.fails = (st.mine.fails || 0) + 1; if (st.mine.fails >= 3) { note('mine: the shaft is lost, a new one will be dug'); st.mine = null } G.save(); return false }
          // stopped halfway down (the walk timed out at y39, 10:19): no tunnels from the middle of the shaft, they ran into the water around it;
          // the next trip carries on down from here
          if (!r.ok && S.dist(b) > 6) { st.mine.fails = (st.mine.fails || 0) + 1; if (st.mine.fails >= 4) { note('mine: the shaft is lost, a new one will be dug'); st.mine = null } G.save(); return false }
          if (r.ok) st.mine.fails = 0
        } else {
          // the first shaft: next to home (not inside the house), away from places where the bot died
          const OFF = [[6, 6], [-10, 6], [10, -10], [-10, -10], [0, 16], [16, 0], [-16, 0], [0, -16], [-30, 10], [-24, 24], [-40, -4], [-20, 30], [30, 24], [-36, -30], [50, 0], [0, 50], [-50, 0], [0, -50], [45, 45], [-45, 45], [45, -45], [-45, -45], [64, 20], [-64, -20], [20, -64], [-20, 64]], /* farther spots (up to ~45 out) so an avoided deadly shaft does not cover them all; a ring at 50-67 for the water and caves near home (07:48: the zombie pocket and water ruled out every closer spot) */ near = (x, z) => (st.avoid || []).some(q => Math.hypot(q[0] - x, q[2] - z) < 12) || (st.avoidMines || []).some(q => Math.hypot(q[0] - x, q[2] - z) < (q[3] || 48))   // and no new shaft within reach of a deadly old one
          let k = 0; while (k < OFF.length && near(h.x + OFF[(st.mineSpot || 0) % OFF.length][0], h.z + OFF[(st.mineSpot || 0) % OFF.length][1])) { st.mineSpot = (st.mineSpot || 0) + 1; k++ }
          // no chosen site, or the listed spots keep turning out wet: find the land farthest from water within 72 of home from the surface
          // the bot can see (the loaded terrain, a 6-block grid, yielding every row). Around OzoGo444's home nearly every listed spot was
          // water (10:19, iron failed x7).
          if (!st.mineSite && (st.mineSkips || 0) >= 3 && Date.now() - (st.landScanAt || 0) > 30 * 60000) {
            st.landScanAt = Date.now()
            const G6 = 8, R = 112, cols = new Map()     // (72 found nothing dry around OzoGo444's island for hours, 2026-11-07)
            for (let dx = -R; dx <= R; dx += G6) { for (let dz = -R; dz <= R; dz += G6) {
                const x = h.x + dx, z = h.z + dz; let top = null, wet = false
                for (let y = h.y + 30; y > h.y - 25; y--) { const b = S.block(v(x, y, z)); if (!b) { top = undefined; break } if (/water|kelp|seagrass/.test(b.name)) wet = true; if (b.boundingBox === 'block' && !/_leaves$|_log$/.test(b.name)) { top = y; break } }
                if (top !== undefined) cols.set(dx + ',' + dz, { x, z, top, wet })
              } await S.wait(0) }
            const wets = [...cols.values()].filter(c => c.wet || c.top == null)
            let best = null
            for (const c of cols.values()) {
              // (8 blocks clear of every avoided radius: a site right on the edge put the bot inside it when it got there, and the shaft was
              // refused every round, 01:39 and 01:47)
              if (c.wet || c.top == null || Math.hypot(c.x - h.x, c.z - h.z) < 14 || near(c.x, c.z) || (st.avoidMines || []).some(q => Math.hypot(q[0] - c.x, q[2] - c.z) < (q[3] || 48) + 8) || (st.wetSites || []).some(q => Math.hypot(q[0] - c.x, q[1] - c.z) < 20)) continue
              // never in or by the farm, the grove or anything built (it picked 177,71,-316, right by Walter's starter wheat farm, 11:29)
              if ((st.farm || []).concat(st.grove || []).some(q => Math.abs(q[0] - c.x) <= 6 && Math.abs(q[2] - c.z) <= 6)) continue
              { const tb = S.block(v(c.x, c.top, c.z)); if (!tb || /farmland|planks|cobblestone|_slab|_stairs|fence|glass|bricks|wool|chest|torch/.test(tb.name) || (S.isEstablished && S.isEstablished(tb))) continue }
              const dry = wets.reduce((m, w) => Math.min(m, Math.hypot(w.x - c.x, w.z - c.z)), 99)
              const score = dry - Math.hypot(c.x - h.x, c.z - h.z) / 12          // far from water first, then nearer home
              if (!best || score > best.score) best = { ...c, dry, score }
            }
            if (best && best.dry >= 8) { st.mineSite = [best.x, best.top + 1, best.z]; st.mineSkips = 0; G.save(); note(`mine: land site ${best.x},${best.top + 1},${best.z} picked, ${Math.round(best.dry)} blocks from the nearest water`) }
            else note('mine: no dry land site found within 112 of home')
          }
          // a chosen site (st.mineSite: the land spot farthest from open water, 2026-11-05; every shaft dug by the sea flooded) comes first
          const o = st.mineSite && !near(st.mineSite[0], st.mineSite[2]) ? [st.mineSite[0] - h.x, st.mineSite[2] - h.z] : OFF[(st.mineSpot || 0) % OFF.length]
          // by x/z only (spots up to 45 out sit on hills or in hollows), and only on dry land: a spot out at sea or on the shore is skipped
          // instead of being dug and given up after three floods
          // to the ground surface of the spot when that column is loaded (top solid block), else by x/z only. By x/z alone the path went
          // into a cave under the spot (17:44): the spot was skipped but the bot stayed down there and a creeper killed it (17:46)
          { const tx = h.x + o[0], tz = h.z + o[1]; let top = null
            let wetTop = false
            for (let y = Math.min(140, h.y + 50); y > h.y - 30; y--) { const b = S.block(v(tx, y, tz)); if (!b) { top = null; break } if (/water|kelp|seagrass/.test(b.name)) wetTop = true; if (b.boundingBox === 'block' && !/_leaves$|_log$/.test(b.name)) { top = y; break } }
            // water over the spot, or right beside its top: skipped from here, without walking out there (a drowned's trident from the
            // water killed the bot walking to such a spot, 08:05)
            if (!wetTop && top != null) wetTop = [[2, 0], [-2, 0], [0, 2], [0, -2]].some(([dx, dz]) => { const b = S.block(v(tx + dx, top + 1, tz + dz)); return b && /water/.test(b.name) })
            if (wetTop && (st.mineSkips || 0) < OFF.length) { st.mineSkips = (st.mineSkips || 0) + 1; st.mineSpot = (st.mineSpot || 0) + 1; if (st.mineSite && o[0] === st.mineSite[0] - h.x && o[1] === st.mineSite[2] - h.z) st.mineSite = null; G.save(); note(`mine: spot ${tx},${tz} is water (seen from here), trying the next one (${st.mineSkips} skipped)`); return false }
            await S.goto(top != null ? new goals.GoalNear(tx, top + 1, tz, 3) : new goals.GoalNearXZ(tx, tz, 3), { dig: false, ms: 90000 }) }
          { const f = S.flo(bot.entity.position), wet = [[0, 0], [2, 0], [-2, 0], [0, 2], [0, -2]].some(([dx, dz]) => [-1, 0].some(dy => { const b = S.block(f.offset(dx, dy, dz)); return b && /water/.test(b.name) }))
            // skipped: the next ring spot next time (a chosen site is dropped, or it would be picked again forever); after a full round of
            // skips in a row, dig right here as before rather than cycle
            // GoalNearXZ is met at any height: at 16:07 it walked into a cave under spot 82 and 'dug' a 0-step shaft from y20, so the
            // shaft's entry was underground and climbing 'out via the shaft' ended down there. A spot reached far below home is skipped.
            const deep = f.y < h.y - 10
            // a spawner the bot has seen within 24 (any depth from y-10 to y45, where the shafts go): not here
            const spawnerNear = (st.spawners || []).some(q => Math.hypot(f.x - q[0], f.z - q[2]) < 24 && q[1] > -10 && q[1] < 45)
            if ((wet || deep || spawnerNear || Math.hypot(f.x - h.x - o[0], f.z - h.z - o[1]) > 8) && (st.mineSkips || 0) < OFF.length) {
              st.mineSkips = (st.mineSkips || 0) + 1; st.mineSpot = (st.mineSpot || 0) + 1
              if (st.mineSite && o[0] === st.mineSite[0] - h.x && o[1] === st.mineSite[2] - h.z) st.mineSite = null
              G.save(); note(`mine: spot ${h.x + o[0]},${h.z + o[1]} is ${wet ? 'by water' : deep ? 'under ground (a cave)' : spawnerNear ? 'by a spawner' : 'out of reach'}, trying the next one (${st.mineSkips} skipped)`)
              if (deep && !S.skyVisible()) { const up = await M.goSurface(); note('mine: back out of the cave first (' + up + ')') }
              return false } }
          // (an avoidMines entry may carry its own radius as a 4th number; 48 otherwise)
          // never here when here is near a place the bot gave up (deaths, the zombie spawner pocket under home): the fallback after a
          // round of skipped spots dug a new shaft 6 blocks from it and a zombie killed the bot down there (06:29 shaft, 06:45 death)
          { const f2 = S.flo(bot.entity.position)
            if ((st.avoidMines || []).some(q => Math.hypot(f2.x - q[0], f2.z - q[2]) < (q[3] || 48))) { st.mineSkips = 3;   /* the land-site scan runs on the next pass */ st.mineSpot = (st.mineSpot || 0) + 1; G.cool.iron = Date.now() + 20 * 60000; G.save(); note('mine: no spot away from the avoided places this round, iron paused 20 min'); return false } }
          const entry = bot.entity.position.floored(), dir0 = st.mineDir == null ? 0 : st.mineDir
          // a shaft cut short by the step's time budget is kept as far as it got (05:39: 35 blocks dug to y30, the budget ran out, nothing
          // was recorded, and the next trip started a fresh staircase); the next trip walks down it and carries on from there
          let r
          try { r = await M.descend(20, { maxSteps: 120, dir0 }) }
          finally { const b = bot.entity.position.floored(); if (!st.mine && b.y <= 56 && entry.y >= h.y - 10 && b.y < entry.y - 4) { st.mine = { entry: [entry.x, entry.y, entry.z], bottom: [b.x, b.y, b.z], dir0, since: Date.now(), partial: true, path: (M.descendPath || []).slice(-600) }; G.save() } }
          const bottom = bot.entity.position.floored()
          note('mine: dug the shaft from ' + entry + ' down to y' + bottom.y + ' ' + JSON.stringify(r))
          // stopped near the top (a cave right under the site, 'no floor' on every side): this site is no good, the scan must not pick it again
          if (bottom.y > 56) { st.wetSites = (st.wetSites || []).concat([[entry.x, entry.z]]).slice(-40); st.mineSite = null; st.mineSkips = Math.max(3, st.mineSkips || 0); st.landScanAt = 0; G.save(); return false }
          // never record a shaft that starts deep under ground or was not dug at all (the fallback after a full round of skipped spots
          // could still start one in a cave; descend's 'blocked' exit has no steps count, so depth is measured by y): go home instead
          if (entry.y < h.y - 10 || bottom.y >= entry.y) { st.mineSpot = (st.mineSpot || 0) + 1; G.save(); note(`mine: no shaft recorded (entry y${entry.y}, ${entry.y - bottom.y} blocks down), heading home`); await M.goSurface(); await S.goto(new goals.GoalNear(h.x, h.y, h.z, 3), { dig: false, ms: 120000 }); return false }
          st.mine = { entry: [entry.x, entry.y, entry.z], bottom: [bottom.x, bottom.y, bottom.z], dir0, since: Date.now(), path: (M.descendPath || []).slice(-600) }; st.mineSkips = 0
          G.save()
        }
      }
      // underground but nowhere near the shaft bottom (a walk down that ended in a flooded cave at y40 over 211,-426, 10:20-10:26: three
      // tunnels started there, each 'water'): to the bottom first, and up and out if that fails; tunnels only start at the bottom
      if (st.mine && st.mine.bottom && !st.mine.partial && bot.entity.position.y < 57) {
        const bb = v(...st.mine.bottom)
        if (S.dist(bb) > 8 && Math.abs(bot.entity.position.y - bb.y) > 4) {
          const r = await S.goto(new goals.GoalNear(bb.x, bb.y, bb.z, 2), { dig: false, ms: 90000 })
          if (!r.ok && S.dist(bb) > 8) { st.mine.fails = (st.mine.fails || 0) + 1; G.save(); const up = await M.goSurface(); note('mine: could not get to the shaft bottom from y' + Math.floor(bot.entity.position.y) + ', back up (' + up + ')'); return false }
        }
      }
      // a shaft cut short by the time budget (#114) is dug on down to y20 from where it stopped, before any tunnel (06:25: it tunnelled at
      // y50 instead, under the new site at 213,-388)
      if (st.mine && st.mine.partial && st.mine.bottom && bot.entity.position.y < 57 && Math.floor(bot.entity.position.y) > 22 && S.dist(v(...st.mine.bottom)) < 4) {
        try { const r = await M.descend(20, { maxSteps: 120, dir0: st.mine.dir0 }); note('mine: carried the shaft on down to y' + Math.floor(bot.entity.position.y) + ' ' + JSON.stringify(r)) }
        finally { const b = S.flo(bot.entity.position); if (b.y < st.mine.bottom[1]) st.mine.bottom = [b.x, b.y, b.z]; if (b.y <= 22) delete st.mine.partial; G.save() }
      }
      // the shaft bottom is where the tunnels meet caves: light every spawnable cell around it before tunnelling (OzoGo444 died there to a
      // zombie, a skeleton and a spider in one minute, 06:59; light from light.js, the server's light data is scrambled)
      if (bot.entity.position.y < 56 && cnt('torch') >= 8) {
        try {
          delete require.cache[require.resolve('./light')]
          const here = S.flo(bot.entity.position), lm = await require('./light')(bot, v(0, 0, 0).constructor).compute(here, 12, 6)
          const cells = []
          for (let dx = -10; dx <= 10; dx++) for (let dz = -10; dz <= 10; dz++) for (let dy = -3; dy <= 3; dy++) { const p = here.offset(dx, dy, dz); if (lm.spawnable(p)) cells.push(p) }
          let lit = 0; const done = []
          for (const p of cells.sort((a, b) => S.dist(a) - S.dist(b))) {
            if (lit >= 6 || done.some(q => q.distanceTo(p) < 7)) continue
            if (S.dist(p) > 4) { const r = await S.goto(new goals.GoalNear(p.x, p.y, p.z, 2), { dig: false, ms: 15000 }); if (!r.ok) continue }
            const g = S.block(p.offset(0, -1, 0)); if (g && await S.placeAgainst(g, v(0, 1, 0), 'torch')) { lit++; done.push(p) }
          }
          if (lit) note(`mine: lit ${lit} dark spots around the shaft bottom (${cells.length} spawnable)`)
        } catch (e) { log('PLAN', 'mine lighting: ' + e.message) }
      }
      st.mineDir = ((st.mineDir || 0) + 1) % 4
      { const here = S.flo(bot.entity.position), D = [[1, 0], [0, 1], [-1, 0], [0, -1]]   // the order M.tunnel uses
        const bad = (d) => (st.avoidMines || []).some(q => Math.hypot(here.x + D[d][0] * 40 - q[0], here.z + D[d][1] * 40 - q[2]) < (q[3] || 48))
        for (let k = 0; k < 4 && bad(st.mineDir); k++) st.mineDir = (st.mineDir + 1) % 4 }
      const before = ironUnits()
      // 20 blocks, not 40: the walk back to the shaft stays in its own tunnels. A bottom 45 blocks off its entry sent the pathfinder
      // through the deep caves, and zombies killed the bot at y-8 (00:17)
      const t = await M.tunnel(st.mineDir, 20, { targets: /^(deepslate_)?(iron|coal|copper|gold|diamond|redstone|lapis)_ore$/, torchEvery: 6, stop: () => S.freeSlots() <= 4 || cnt('torch') < 4 || bot.food <= 8 })
      note(`mine: tunnel ${t.len} blocks, mined ${t.mined}, iron +${ironUnits() - before} (${t.reason})`)
      if (ironUnits() - before >= 3) st.mineDeaths = 0   // a good haul: the shaft is worth keeping
      // the four tunnels from this bottom are dug out: walking them again mines nothing (06:56, "tunnel 40 blocks, mined 0" in 11 s).
      // Two empty walks in a row: a new level 8 blocks further down the same shaft, which becomes the shaft bottom
      if (t.mined === 0 && t.len >= 16) st.mineEmpty = (st.mineEmpty || 0) + 1; else if (t.mined > 0) st.mineEmpty = 0
      // not below y4: the deepslate caves under that killed the bot at y-8 (two skeleton arrows, 23:26), and iron is best around y16
      if ((st.mineEmpty || 0) >= 2 && st.mine && st.mine.bottom && st.mine.bottom[1] - 8 >= 4) {
        const target = st.mine.bottom[1] - 8
        // from the foot of the shaft, back along its own tunnel, so each new level stays under the shaft (it used to start at the tunnel's far end)
        { const bb = v(...st.mine.bottom); if (S.dist(bb) > 3) await S.goto(new goals.GoalNear(bb.x, bb.y, bb.z, 1), { dig: false, ms: 90000, escalate: false }) }
        const r = await M.descend(target, { maxSteps: 40, dir0: st.mine.dir0 })
        const b = S.flo(bot.entity.position)
        if (b.y < st.mine.bottom[1]) { st.mine.bottom = [b.x, b.y, b.z]; st.mineEmpty = 0; note(`mine: new level at y${b.y} below the worked-out one (${JSON.stringify(r)})`) }
        G.save()
      }
      // blocked tunnels (water, lava): just branch another way next time, from the same shaft bottom; no new surface breach
      if (t.len === 0 && /water|lava|hazard|clear-fail|blocked/.test(String(t.reason))) { st.mineBlocked = (st.mineBlocked || 0) + 1; G.save() } else st.mineBlocked = 0
      if (S.freeSlots() <= 4 || cnt('torch') < 4 || bot.food <= 8 || ironUnits() >= 24) { const up = await M.goSurface(); note('mine: back up ' + up) }
      return true } }
  ]

  // ---- tend the field: plots that dried out or got trampled back to dirt are tilled and sown again (7 of 9 plots had reverted, 2026-11-04) ----
  // a plot that is no longer soil (water, air, a path: the farm was rebuilt) is dropped from the list; at 14:10 nine of them kept the step due
  const tendBare = () => {
    st.farm = (st.farm || []).filter(q => { const g = S.block(v(q[0], q[1], q[2])); return !g || /^(farmland|dirt|grass_block)$/.test(g.name) })
    return st.farm.filter(q => { const g = S.block(v(q[0], q[1], q[2])), c = S.block(v(q[0], q[1] + 1, q[2])); return g && c && S.isAir(c) && !((st.tendSkip || {})[q.join(',')] > Date.now()) }) }
  steps.push({ id: 'tend', budget: 150000, cool: 180000, need: () => {
      if (S.isNight() || cnt('wheat_seeds') < 1) return false
      // bare plots, minus the ones that would not take seed lately (unreachable, not farmland any more): those wait half an hour.
      // From down in the mine it takes three bare plots to make the climb worth it (at 14:06 it climbed the shaft to resow nothing).
      const bare = tendBare().length, h = home(), deep = h && bot.entity.position.y < h.y - 8
      return bare >= (deep ? 3 : 1) }, run: async () => {
    let n = 0
    for (const q of tendBare()) {
      if (!cnt('wheat_seeds')) break
      const p = v(q[0], q[1], q[2]), k = q.join(','), skip = () => { st.tendSkip = st.tendSkip || {}; st.tendSkip[k] = Date.now() + 1800000 }
      const r = await S.goto(new goals.GoalNear(p.x, p.y + 1, p.z, 2), { dig: false, ms: 25000 }); if (!r.ok) { skip(); continue }
      let g = S.block(p)
      if (g && /^(dirt|grass_block)$/.test(g.name)) { const hoe = S.items().find(i => /_hoe$/.test(i.name)) || (await S.craft('stone_hoe', 1), S.items().find(i => /_hoe$/.test(i.name))); if (!hoe) break; try { await bot.equip(hoe, 'hand'); await bot.lookAt(p.offset(0.5, 1, 0.5), true); await bot.activateBlock(g); await S.wait(250) } catch {} g = S.block(p) }
      if (g && g.name === 'farmland' && await S.placeAgainst(g, v(0, 1, 0), 'wheat_seeds')) n++
      else skip()
    }
    note('tend: resowed ' + n + ' plots'); return n > 0 } })

  // ---- Walter's starter farm and berry bushes (2026-11-04): adopt every farmland plot near home as ours to tend; pick ripe berries by
  // right-clicking the bush (breaking it would destroy the source), never by walking through it (it hurts). ----
  const adoptFarm = () => {
    const h = home(); if (!h) return
    const fl = bot.findBlocks({ matching: ids(/^farmland$/), maxDistance: 32, count: 120, point: h })
    st.farm = st.farm || []
    for (const p of fl) if (!st.farm.some(q => q[0] === p.x && q[1] === p.y && q[2] === p.z)) st.farm.push([p.x, p.y, p.z])
    if (st.farm.length > 120) st.farm = st.farm.slice(-120)
  }
  steps.push({ id: 'berries', budget: 120000, cool: 90000, need: () => !S.isNight() && !!home() && cnt('sweet_berries') < 24 && bot.findBlocks({ matching: ids(/^sweet_berry_bush$/), maxDistance: 32, count: 40, point: home() }).some(p => { const b = S.block(p); return b && b.metadata >= 2 }), run: async () => {
    adoptFarm()
    const ripe = bot.findBlocks({ matching: ids(/^sweet_berry_bush$/), maxDistance: 32, count: 40, point: home() }).filter(p => { const b = S.block(p); return b && b.metadata >= 2 }).sort((p, q) => S.dist(p) - S.dist(q))
    let picked = 0; const before = cnt('sweet_berries')
    for (const p of ripe.slice(0, 12)) {
      // GoalNear, not GoalLookAtBlock: the look-at goal's raycasts timed the path search out among the bushes and nothing was ever picked
      // (18 bushes stood ripe while the bot starved, 16:00). From 2 blocks away the bush is within reach.
      // a row of bushes cannot be walked through (the pathfinder avoids their thorns): stand within arm's reach, not next to it
      if (S.dist(p.offset(0.5, 0.5, 0.5)) > 4.2) { let r = await S.goto(new goals.GoalNear(p.x, p.y, p.z, 3), { dig: false, ms: 20000 }); if (!r.ok && S.dist(p.offset(0.5, 0.5, 0.5)) > 4.2) r = await S.goto(new goals.GoalNear(p.x, p.y, p.z, 4), { dig: false, ms: 15000 }); if (S.dist(p.offset(0.5, 0.5, 0.5)) > 4.4) continue }
      const b = S.block(p); if (!b || b.metadata < 2) continue
      // empty hand first: right-clicking a bush with berries in hand eats them instead of picking (Smeo444 sat eating by the bushes, 02:40)
      if (bot.heldItem) await bot.unequip('hand').catch(() => {})
      try { await bot.lookAt(p.offset(0.5, 0.5, 0.5), true); await bot.activateBlock(b); picked++; await S.wait(200) } catch {}
    }
    await S.pickup(6, 3000)
    note('berries: picked ' + picked + ' bushes, +' + (cnt('sweet_berries') - before) + ' berries'); return picked > 0 } })

  // ---- fishing: an island is surrounded by fish. Diving for kelp drowned the bot (13:33); casting from the shore is safe and renewable. ----
  // string comes from spiders (they spawn around the island at night and the combat reflex kills them anyway) or from cobwebs.
  steps.push({ id: 'string', budget: 90000, need: () => !S.has('fishing_rod') && cnt('string') < 2 && S.hostilesNear(20).some(e => e.name === 'spider' || e.name === 'cave_spider'), cool: 30000, run: async () => {
    const sp = S.hostilesNear(20).filter(e => e.name === 'spider' || e.name === 'cave_spider')[0]; if (!sp) return false
    if (bot.health < 12) return false
    await S.kill(sp); await S.pickup(8, 4000)
    note(`string: spider hunt, string now ${cnt('string')}`); return cnt('string') > 0 } })
  steps.push({ id: 'rod', need: () => !S.has('fishing_rod') && cnt('string') >= 2 && (S.count('stick') >= 3 || S.planks() >= 2 || S.logs() >= 1), run: async () => {
    const ok = await S.craft('fishing_rod', 1); note('rod: ' + (ok ? 'fishing rod made' : 'craft failed')); return ok } })
  steps.push({ id: 'fish', budget: 300000, need: () => S.has('fishing_rod') && !!home() && S.foodPoints() + S.rawFood() * 2 < 24, cool: 60000, run: async () => {
    const h = home()
    // a dry shore cell next to surface water near home
    const water = bot.findBlocks({ matching: ids(/^water$/), maxDistance: 40, count: 120, point: h }).filter(p => { const a = S.block(p.offset(0, 1, 0)); return a && S.isAir(a) && Math.abs(p.y - h.y) <= 14 })
    let spot = null, wat = null
    for (const w of water) { for (const [dx, dz] of [[2, 0], [-2, 0], [0, 2], [0, -2], [3, 0], [-3, 0], [0, 3], [0, -3]]) { const p = w.offset(dx, 1, dz); if (outdoorCell(p)) { spot = p; wat = w; break } } if (spot) break }
    if (!spot) return false
    const r = await S.goto(new goals.GoalNear(spot.x, spot.y, spot.z, 0), { dig: false, ms: 60000 }); if (!r.ok && S.dist(spot) > 2) return false
    const rod = S.items().find(i => i.name === 'fishing_rod'); await bot.equip(rod, 'hand')
    let caught = 0
    for (let i = 0; i < 8; i++) {
      S.check()
      if (S.hostilesNear(8).length) break
      await bot.lookAt(wat.offset(0.5, 0.9, 0.5), true)
      try { await Promise.race([bot.fish(), new Promise((_, rej) => setTimeout(() => rej(new Error('no bite')), 45000))]); caught++ } catch (e) { try { bot.activateItem() } catch {} if (!S.has('fishing_rod')) break }
      await S.wait(400)
    }
    await S.pickup(6, 3000)
    if (S.rawFood() >= 3 && (S.has('furnace') || S.furnaceNear(32))) { for (const n of ['cod', 'salmon']) { const c = cnt(n); if (c) await S.smelt(n, c) } }
    note(`fish: caught ${caught}, food points now ${S.foodPoints()}`); return caught > 0 } })

  // ---- the established vs the incidental (Walter 2026-11-03): the house, its bed, chests, the farm, the grove are not "the world". ----
  // The bot dug through its own house wall to reach the bed, slept in a random bed underground, and laid cobble paths over the sea.
  // Built things: block kinds that the world does not generate on its own near home, plus everything inside the home box and the remembered places.
  const BUILT = /^sweet_berry_bush$|^(carrots|potatoes|beetroots)$|_planks$|_door$|_bed$|^(chest|barrel|trapped_chest|crafting_table|furnace|smoker|blast_furnace|torch|wall_torch|lantern|ladder|farmland|glass|glass_pane)$|_slab$|_stairs$|_fence|_wall$|_carpet$|_wool$|bricks?$|^smooth_|^polished_|_sign$|^wheat$/
  // cached: the pathfinder asks for every node it expands, so this must be nearly free
  let hbCache = null, hbAt = 0
  const homeBox = () => { if (Date.now() - hbAt < 5000) return hbCache; hbAt = Date.now(); const h = home(); hbCache = h ? { x0: h.x - 6, x1: h.x + 6, y0: h.y - 2, y1: h.y + 6, z0: h.z - 8, z1: h.z + 6 } : null; return hbCache }
  const inBox = (p, b) => b && p.x >= b.x0 && p.x <= b.x1 && p.y >= b.y0 && p.y <= b.y1 && p.z >= b.z0 && p.z <= b.z1
  const nearList = (p, list, r) => (list || []).some(q => Math.abs(q[0] - p.x) <= r && Math.abs(q[1] - p.y) <= r && Math.abs(q[2] - p.z) <= r)
  S.isEstablished = (block) => {
    if (!block || !block.position) return false
    const p = block.position
    if (BUILT.test(block.name)) return true
    // a job site's own harvest (zone.json allow: Smeo444's birch logs and leaves) is work, even inside the box around the home bed
    try { const z = S.zone(); if (z && (z.allow || []).some(a => p.x >= a.x0 && p.x <= a.x1 && p.y >= a.y0 && p.y <= a.y1 && p.z >= a.z0 && p.z <= a.z1 && new RegExp(a.blocks).test(block.name))) return false } catch {}
    if (inBox(p, homeBox()) && block.boundingBox === 'block') return true      // the house shell, whatever it is made of
    if (nearList(p, st.farm, 0) || nearList(p, st.tables, 0)) return true
    return false
  }
  // every pathfinder (the autopilot's and nav's) asks these before breaking or placing: built blocks are walls, the open sea is not a place to build paths
  try {
    const Mv = require('mineflayer-pathfinder').Movements.prototype
    if (!Mv._origExBreak) { Mv._origExBreak = Mv.exclusionBreak; Mv._origExPlace = Mv.exclusionPlace }
    Mv.exclusionBreak = function (block) { let w = Mv._origExBreak.call(this, block); try { if (S.isEstablished(block)) w += 1000 } catch {} return w }
    Mv.exclusionPlace = function (block) {
      let w = Mv._origExPlace.call(this, block)
      try { const p = block.position; const below = S.block(p.offset(0, -1, 0)); if ((block.name === 'water') || (below && below.name === 'water')) w += 1000 } catch {}
      return w
    }
    // berry bushes are prickly (Walter 2026-11-05): never a step on the way, whichever Movements object a layer built
    // and keep a margin: walking along the edge of a bush row the bot's body grazes the thorns (53 bush hits by the farm gate, 03:30)
    if (!Mv._origExStep) Mv._origExStep = Mv.exclusionStep
    Mv.exclusionStep = function (block) { let w = Mv._origExStep.call(this, block); try { const p = block.position; if (p && [[1, 0], [-1, 0], [0, 1], [0, -1]].some(([dx, dz]) => { const n = bot.blockAt(p.offset(dx, 0, dz), false); return n && n.name === 'sweet_berry_bush' })) w += 6 } catch {} return w }
    // the shelter roof is no place to walk: three times tonight a path home ended up standing on it and the bot stalled there
    // (13:01, 14:48, 15:20 'cannot sleep: the bed is too far'). A heavy cost on the cells on top of it; the box is cached for a minute.
    if (!Mv._origExStep2) { Mv._origExStep2 = Mv.exclusionStep
      Mv.exclusionStep = function (block) { let w = Mv._origExStep2.call(this, block); try { const r = bot._roofBox && bot._roofBox(), p = block.position
        if (r && p && p.y >= r.y && p.y <= r.y + 1 && p.x >= r.x0 && p.x <= r.x1 && p.z >= r.z0 && p.z <= r.z1) w += 60 } catch {} return w } }
    if (!Mv._origGetBlock) Mv._origGetBlock = Mv.getBlock
    // the cells on top of the shelter roof are not a place to stand at all (a step cost was not enough: a timed-out search returns the
    // partial path whose end is nearest the bed, and that end was the roof, 03:26). bot._roofBox: x0..x1, z0..z1 and the standing y.
    Mv.getBlock = function (pos, dx, dy, dz) { const b = Mv._origGetBlock.call(this, pos, dx, dy, dz)
      if (b && b.name === 'sweet_berry_bush') { b.safe = false; b.physical = false }
      try { const r = bot._roofBox && bot._roofBox(); if (b && r && b.position && b.position.y >= r.y && b.position.y <= r.y + 1 && b.position.x >= r.x0 && b.position.x <= r.x1 && b.position.z >= r.z0 && b.position.z <= r.z1 && b.boundingBox === 'empty') b.safe = false } catch {}
      return b }
  } catch (e) { log('PLAN', 'exclusions not installed: ' + e.message) }

  // ---- loop breaker (Walter 2026-11-03: the goal is hillclimbing, not a no-cheats run): three deaths in one spot within 30 min, or 25 min with no
  // step succeeding, or stuck far below home with no pickaxe -> teleport home and reset the respawn point to the home bed. Logged, never silent. ----
  st.deathLog = (st.deathLog || []).filter(d => Date.now() - d[3] < 30 * 60000)
  const onDeathLoop = () => { try { const p = bot.entity.position; st.deathLog = (st.deathLog || []).concat([[Math.floor(p.x), Math.floor(p.y), Math.floor(p.z), Date.now()]]).slice(-10); G.save() } catch {} }
  bot.on('death', onDeathLoop)
  let lastDone = G.done || 0, lastDoneAt = Date.now()
  // the watchdog's last rung (its own fixes exhausted: thrashing between steps while mobs keep preempting, 17:20-17:37 under home at night)
  // ends in the same reset as the loop breaker: back home on the surface, respawn point at the bed
  G.forceReset = (why) => {
    const h = home(); if (!h || Date.now() - (st.resetAt || 0) < 10 * 60000) return false
    // the assistant waiting at home between shifts is not stuck (the watchdog read its idle time as a stall)
    if ((G.role === 'assistant' || S.isNight()) && /^watchdog/.test(why) && S.dist(h) < 24) return false
    st.resetAt = Date.now(); st.resetLog = (st.resetLog || []).filter(t => Date.now() - t < 60 * 60000).concat([Date.now()]); st.mineBlocked = 3; G.save()
    const cmds = [`/tp ${bot.username} ${h.x - 1} ${h.y} ${h.z - 8}`, `/spawnpoint ${bot.username} ${h.x} ${h.y} ${h.z}`]
    log('PLAN', `loop breaker: ${why}; reset level 1: ${cmds.join(' ; ')}`)
    cmds.forEach((c, i) => setTimeout(() => api.say(c), i * 1300))
    return true
  }
  const loopTimer = setInterval(() => {
    try {
      // a reflex task that never ends holds everything: safety ran 29 minutes at y20 (19:30-19:58) with the bot standing still and the log silent
      try { const run = api.scheduler.status().running; if (run && /^(safety|wd-retreat)$/.test(run.name) && ((run.runningS > 180 && !S.hostilesNear(8).length) || run.runningS > 360)) { log('PLAN', `loop breaker: ${run.name} ran ${run.runningS}s, cancelled`); api.scheduler.cancel(run.name, 'stuck') } } catch {}
      if (!bot.entity || !st.home) return
      // logged in or respawned at world spawn, hundreds of blocks from home (Smeo444 on its first days): back home by the reset
      if (bot.entity.position.distanceTo(home()) > 400 && G.forceReset) G.forceReset('far from home (' + Math.round(bot.entity.position.distanceTo(home())) + ' blocks)')
      if ((G.done || 0) !== lastDone) { lastDone = G.done || 0; lastDoneAt = Date.now() }
      const p = bot.entity.position, h = home()
      const recent = (st.deathLog || []).filter(d => Date.now() - d[3] < 30 * 60000)
      const cluster = recent.length >= 3 && recent.every(d => Math.hypot(d[0] - recent[recent.length - 1][0], d[2] - recent[recent.length - 1][2]) < 20)
      const stalled = Date.now() - lastDoneAt > 25 * 60000
      // stranded: underground with no pickaxe and no wood to make one (no way to dig out), for 3+ minutes
      const boxed = p.y < h.y - 8 && !S.skyVisible() && tier('pickaxe') < 1 && S.logs() + S.planks() < 2
      st.boxedSince = boxed ? (st.boxedSince || Date.now()) : 0
      const stranded = boxed && Date.now() - st.boxedSince > 3 * 60000
      // resource deadlock: no pickaxe and no wood for 10 minutes (nothing else can start from there)
      const broke = tier('pickaxe') < 1 && S.logs() + S.planks() < 2
      st.brokeSince = broke ? (st.brokeSince || Date.now()) : 0
      const deadlock = broke && Date.now() - st.brokeSince > 10 * 60000
      if ((cluster || stalled || stranded || deadlock) && Date.now() - (st.resetAt || 0) > 10 * 60000) {
        st.resetAt = Date.now(); st.deathLog = []; lastDoneAt = Date.now(); st.brokeSince = 0
        st.resetLog = (st.resetLog || []).filter(t => Date.now() - t < 60 * 60000).concat([Date.now()])
        G.save()
        const why = cluster ? 'three deaths in one spot' : stalled ? 'no step succeeded for 25 min' : stranded ? 'stranded underground without a pickaxe' : 'no pickaxe and no wood for 10 min'
        // escalation ladder (Walter 2026-11-04: loops get reset with commands, the day must not be lost to a stall):
        //   1. teleport home + respawn point at the home bed
        //   2. the bed is gone: give a bed, put it back at home, respawn point there
        //   3. a second reset within the hour, or a resource deadlock: a basic kit, so the bot plays again instead of looping
        const cmds = [`/tp ${bot.username} ${h.x - 1} ${h.y} ${h.z - 8}`]
        const hb = S.block(h)
        const bedGone = hb && !/_bed$/.test(hb.name)
        if (bedGone) cmds.push(`/give ${bot.username} white_bed 1`)
        const kit = deadlock || st.resetLog.length >= 2
        if (kit) cmds.push(...['stone_pickaxe 2', 'stone_axe 1', 'stone_sword 1', 'bread 16', 'torch 32', 'oak_log 16'].map(x => `/give ${bot.username} ${x}`))
        cmds.push(`/spawnpoint ${bot.username} ${h.x} ${h.y} ${h.z}`)
        log('PLAN', `loop breaker: ${why}; reset level ${kit ? 3 : bedGone ? 2 : 1}: ${cmds.join(' ; ')}`)
        cmds.forEach((c, i) => setTimeout(() => api.say(c), i * 1300))
        if (bedGone) setTimeout(async () => { try { const fl = S.block(h.offset(0, -1, 0)); if (fl && S.solid(fl) && await S.placeAgainst(fl, v(0, 1, 0), 'white_bed')) log('PLAN', 'loop breaker: bed put back at home') } catch {} }, cmds.length * 1300 + 1500)
      }
    } catch {}
  }, 20000)
  { const prev = G.dispose; G.dispose = () => { clearInterval(loopTimer); try { bot.removeListener('death', onDeathLoop) } catch {} if (prev) prev() } }

  // ---- a shelter around the home bed (2026-11-05: Walter's house there is gone, and the bot kept dying at its own spawn point at night:
  // skeleton arrows from the dark (11:28), a zombie camping the bed). Walls two high around the bed with one block of room on each side,
  // a roof, a doorway where the ground outside is walkable (chosen once and kept clear), and a torch inside. Built by day; missing blocks
  // are put back on later passes, up to three passes without progress. The hillclimber only: the assistant's bed belongs to Walter's base.
  // Blocks inside the box around the home bed already count as established (isEstablished, homeBox), so neither the bot nor the pathfinder
  // takes them down. Chests are never built over (a block on top seals a chest). ----
  const CONTAINER = /chest|barrel|shulker|furnace|smoker/
  // into the shelter the one way that works: to the cell outside the door, then through it to the floor beside the bed. The walk to the door
  // may escalate only from far away (a cave); near the shelter nothing digs or pillars: from 3-4 blocks out the escalating go-to stacked
  // blocks up the outside wall and left the bot on the roof (14:48, 15:20, 21:29 'cannot sleep: the bed is too far')
  G.enterShelter = async () => {
    const h = home(); if (!h || !st.shelterDoor) return { ok: false, err: 'no shelter' }
    // the doorway whose outside cell is nearest
    const ds = [st.shelterDoor, st.shelterDoor2].filter(Boolean).map(q => v(...q)), outs = ds.map(d => d.offset(Math.sign(d.x - h.x), 0, Math.sign(d.z - h.z)))
    const out = outs.sort((a, b) => S.dist(a) - S.dist(b))[0]
    if (S.dist(h) > 2.2) {
      const g = new goals.GoalNear(out.x, out.y, out.z, 1), far = S.dist(h) > 12
      const w = await S.goto(g, { dig: false, ms: 90000, escalate: far })
      // stuck in a hole or on a ledge more than 6 out: then dig or bridge after all (still never right at the walls)
      if (!w.ok && !far && S.dist(h) > 6) await S.goto(g, { dig: false, ms: 90000, escalate: true })
    }
    let r = await S.goto(new goals.GoalNear(h.x, h.y, h.z, 1.5), { dig: false, ms: 30000, escalate: false })
    if (!r.ok) r = await S.goto(new goals.GoalNear(h.x, h.y, h.z, 2), { dig: false, ms: 60000, escalate: false })
    return r
  }
  // the cells above the shelter roof (the roof is at floor + 2), cached: the pathfinder asks for every step it weighs
  var _roof = { at: 0, box: null }
  function roofBox() {
    if (G.role === 'assistant' || !st.shelterDoor) return null
    if (Date.now() - _roof.at > 60000) { _roof.at = Date.now(); const pl = shelterPlan(); _roof.box = pl ? { x0: pl.box.x0 - 1, x1: pl.box.x1 + 1, z0: pl.box.z0 - 1, z1: pl.box.z1 + 1, y: pl.box.y + 3 } : null }
    return _roof.box }
  bot._roofBox = roofBox        // the Movements patch (installed once per process) calls the current plan's version
  function shelterPlan() {
    const h = home(); if (!h) return null
    const cells = [h, ...[[1, 0], [-1, 0], [0, 1], [0, -1]].map(([dx, dz]) => h.offset(dx, 0, dz))].filter(p => { const b = S.block(p); return b && /_bed$/.test(b.name) })
    if (!cells.length) return null
    const x0 = Math.min(...cells.map(p => p.x)) - 1, x1 = Math.max(...cells.map(p => p.x)) + 1, z0 = Math.min(...cells.map(p => p.z)) - 1, z1 = Math.max(...cells.map(p => p.z)) + 1, y = h.y
    const midZ = Math.round((z0 + z1) / 2), midX = Math.round((x0 + x1) / 2)
    // the doorway: kept once chosen; else the middle of a side whose outside cell is walkable ground with room to stand. None: no shelter.
    const passable = (d) => { const out = d.offset(Math.sign(d.x - midX), 0, Math.sign(d.z - midZ)); const g = S.block(out.offset(0, -1, 0)), a = S.block(out), b = S.block(out.offset(0, 1, 0)); return g && g.boundingBox === 'block' && a && a.boundingBox === 'empty' && b && b.boundingBox === 'empty' }
    const kept = st.shelterDoor && v(...st.shelterDoor)
    const door = kept && (kept.x === x0 - 1 || kept.x === x1 + 1 || kept.z === z0 - 1 || kept.z === z1 + 1) ? kept
      : [v(x1 + 1, y, midZ), v(x0 - 1, y, midZ), v(midX, y, z1 + 1), v(midX, y, z0 - 1)].find(passable)
    if (!door) return null
    if (!kept || !kept.equals(door)) { st.shelterDoor = [door.x, door.y, door.z]; G.save() }
    // a second doorway on another walkable side: four times a walk home ended against the north wall (189,71,-289) with the only door on the
    // east side out of reach of a slow path search, and the bot slept outside or not at all (22:31, 00:42)
    const sides = [v(x1 + 1, y, midZ), v(x0 - 1, y, midZ), v(midX, y, z1 + 1), v(midX, y, z0 - 1)]
    const kept2 = st.shelterDoor2 && v(...st.shelterDoor2)
    const door2 = kept2 && sides.some(d => d.equals(kept2)) && !kept2.equals(door) ? kept2 : sides.filter(d => !d.equals(door) && d.x !== door.x && d.z !== door.z).find(passable) || sides.find(d => !d.equals(door) && passable(d))
    if (door2 && (!kept2 || !kept2.equals(door2))) { st.shelterDoor2 = [door2.x, door2.y, door2.z]; G.save() }
    const haveDoor = S.items().some(i => /_door$/.test(i.name)) || S.planks() + S.logs() * 4 >= 6
    const doors = [door].concat(door2 && (haveDoor || /door/.test((S.block(door2) || {}).name || '')) ? [door2] : [])
    const sealsChest = (p) => { const b = S.block(p), below = S.block(p.offset(0, -1, 0)); return (b && CONTAINER.test(b.name)) || (below && CONTAINER.test(below.name)) }
    const walls = [], roof = []
    for (let x = x0 - 1; x <= x1 + 1; x++) for (let z = z0 - 1; z <= z1 + 1; z++) {
      const edge = x === x0 - 1 || x === x1 + 1 || z === z0 - 1 || z === z1 + 1
      // corner columns close nothing (no mob gets through a diagonal between two wall blocks) and one at 187,71,-295 could not be
      // placed from inside (the only neighbour face points outward), so the step came back for it every ten minutes
      const corner = (x === x0 - 1 || x === x1 + 1) && (z === z0 - 1 || z === z1 + 1)
      // corners back in (arrows and line of sight pass a missing corner: OzoGo444 was shot at its bed through one, 23:34); a corner that
      // will not take a block is dropped from the plan after three tries (st.shelterSkip), so it cannot hold the step forever
      if (edge && !doors.some(d => x === d.x && z === d.z) && !(corner && (st.shelterSkip || []).includes(x + ',' + z))) { walls.push(v(x, y, z)); walls.push(v(x, y + 1, z)) }
      roof.push(v(x, y + 2, z))
    }
    // the floor too: inside, under the doorway, under the cell in front of it and the two cells beside that one. Holes there (taken out
    // as 'scaffold' by tidy) left the doorway reachable only by a jump and the bot stood outside the wall at night (22:31)
    const outOf = (d) => d.offset(Math.sign(d.x - midX), 0, Math.sign(d.z - midZ)), out = outOf(door)
    st._shelterBox = { x0, x1, z0, z1, y }
    const floor = []
    for (let x = x0; x <= x1; x++) for (let z = z0; z <= z1; z++) if (!cells.some(c => c.x === x && c.z === z)) floor.push(v(x, y - 1, z))
    // and the ground under the walls: a hole under a wall cell left only a chest to place against (a click opens it), 188,71,-290 at 00:54
    // (only where the wall block itself is missing: a wall over a drop stands fine without it, and the cell below may be out of reach)
    for (const w of walls) if (w.y === y && !sealsChest(w)) { const wb = S.block(w); if (wb && (S.isAir(wb) || wb.boundingBox === 'empty')) floor.push(w.offset(0, -1, 0)) }
    for (const d of doors) { const o = outOf(d), across = o.x === d.x ? [[1, 0], [-1, 0]] : [[0, 1], [0, -1]]; floor.push(d.offset(0, -1, 0), o.offset(0, -1, 0), ...across.map(([a, b]) => o.offset(a, -1, b))) }
    return { walls: walls.filter(p => !sealsChest(p)), roof: roof.filter(p => !sealsChest(p)), floor, door, doors, outs: doors.map(outOf), out, inside: v(midX, y, midZ), box: { x0, x1, z0, z1, y } }
  }
  // inside the shelter (walls and roof included) and the way out: used by S.goto so nothing digs through the walls from inside
  S.inShelter = (p) => { const b = st._shelterBox; if (!b || G.role === 'assistant' || !st.shelterDoor) return false
    return p.x >= b.x0 - 1 && p.x < b.x1 + 2 && p.z >= b.z0 - 1 && p.z < b.z1 + 2 && p.y >= b.y - 1 && p.y < b.y + 3 }
  S.shelterOut = () => { const h = home(); if (!h) return null
    const outs = [st.shelterDoor, st.shelterDoor2].filter(Boolean).map(q => v(...q)).filter(d => /door/.test((S.block(d) || {}).name || '')).map(d => d.offset(Math.sign(d.x - h.x), 0, Math.sign(d.z - h.z)))
    return outs.sort((a, b) => S.dist(a) - S.dist(b))[0] || null }
  // the shelter's floor, its doorway and the cell in front of it stay free: nothing is set down there (tables, furnaces, chests)
  S.keepClear = (c) => { const pl = st.shelterDoor && home() && G.role !== 'assistant' ? shelterPlan() : null; if (!pl) return false
    const b = pl.box
    if (c.y < b.y - 1 || c.y > b.y + 1) return false
    return (c.x >= b.x0 && c.x <= b.x1 && c.z >= b.z0 && c.z <= b.z1) || pl.doors.concat(pl.outs).some(q => c.x === q.x && c.z === q.z) }
  const missingShelter = (pl) => pl.walls.concat(pl.roof, pl.floor || []).filter(p => { const b = S.block(p); return b && (S.isAir(b) || b.boundingBox === 'empty') && !/torch|_bed|door/.test(b.name) })
  bot._shelterMissing = () => { const pl = shelterPlan(); return pl ? missingShelter(pl).map(p => [p.x, p.y, p.z]) : null }   // for the live pilot
  const shelterTorch = (pl) => bot.findBlocks({ matching: ids(/^(torch|wall_torch)$/), point: pl.inside, maxDistance: 3, count: 3 }).some(p => p.x >= pl.box.x0 && p.x <= pl.box.x1 && p.z >= pl.box.z0 && p.z <= pl.box.z1)
  const doorIn = (pl) => (pl.doors || [pl.door]).every(d => /door/.test((S.block(d) || {}).name || ''))
  const shelterTodo = (pl) => missingShelter(pl).length + (!shelterTorch(pl) && cnt('torch') > 0 ? 1 : 0) + (!doorIn(pl) && S.items().some(i => /_door$/.test(i.name)) ? 1 : 0)
  steps.push({ id: 'shelter', budget: 240000, cool: 600000, need: () => {
      if (G.role === 'assistant' || S.isNight() || !home() || Date.now() < (st.shelterPauseUntil || 0)) return false
      if (Date.now() - (st._shelterAt || 0) < 120000) return !!st._shelterNeed
      st._shelterAt = Date.now(); const pl = shelterPlan()
      st._shelterNeed = !!pl && (missingShelter(pl).length > 0 || (!shelterTorch(pl) && cnt('torch') > 0) || (!doorIn(pl) && (S.items().some(i => /_door$/.test(i.name)) || S.planks() + S.logs() * 4 >= 6)))
      return st._shelterNeed }, run: async () => {
    const pl = shelterPlan(); if (!pl) { note('shelter: no walkable side for a doorway, not building'); st.shelterPauseUntil = Date.now() + 3600000; return false }
    const FILL = /^(cobblestone|cobbled_deepslate|stone|andesite|diorite|granite|dirt|tuff)$/
    const filler = () => (S.items().find(i => cobbleRe.test(i.name)) || S.items().find(i => FILL.test(i.name)) || {}).name
    const have = () => S.items().filter(i => FILL.test(i.name)).reduce((n, i) => n + i.count, 0)
    // building stone from the bot's own chests only: the ones it placed itself (the house rules allow only crop food from shared chests)
    if (have() < 48) {
      const own = (st.placed || []).filter(q => q[3] === 'chest').map(q => v(q[0], q[1], q[2])).filter(p => p.distanceTo(home()) < 16 && /chest/.test((S.block(p) || {}).name || ''))
      for (const cp of own) {
        if (S.eye().distanceTo(cp.offset(0.5, 0.5, 0.5)) > 4.2) await S.goto(new goals.GoalNear(cp.x, cp.y, cp.z, 2), { dig: false, ms: 30000 })
        let c; S.closeWindows(); try { c = await bot.openContainer(S.block(cp)) } catch { continue }
        try { for (const it of c.containerItems().filter(i => FILL.test(i.name))) { await c.withdraw(it.type, null, Math.min(it.count, 64)); if (have() >= 80) break } } catch {} finally { try { c.close() } catch {} }
        if (have() >= 80) break
      }
    }
    const before = shelterTodo(pl)
    let placed = 0
    // three standing spots inside, so every wall and roof block is within reach of one of them
    // (free interior cells only, never a bed cell, and never by the escalating go-to: at 11:49 it pillared inside the box and the breath
    // reflex then broke the roof out over the bot's head)
    const standable = (c) => { const a = S.block(c), b = S.block(c.offset(0, 1, 0)), g = S.block(c.offset(0, -1, 0)); return a && b && g && a.boundingBox === 'empty' && b.boundingBox === 'empty' && g.boundingBox === 'block' && !/_bed$/.test(g.name) }
    const free = []; for (let x = pl.box.x0; x <= pl.box.x1; x++) for (let z = pl.box.z0; z <= pl.box.z1; z++) { const c = v(x, pl.box.y, z); if (standable(c)) free.push(c) }
    const corner = (x, z) => free.slice().sort((a, b) => (Math.abs(a.x - x) + Math.abs(a.z - z)) - (Math.abs(b.x - x) + Math.abs(b.z - z)))[0]
    const spots = [corner(pl.inside.x, pl.inside.z), corner(pl.box.x1, pl.box.z0), corner(pl.box.x0, pl.box.z1)].filter((c, i, a) => c && a.findIndex(d => d && d.equals(c)) === i)
    if (filler()) for (const s of spots) {
      await S.goto(new goals.GoalNear(s.x, s.y, s.z, 0), { dig: false, ms: 30000, escalate: false })
      for (let pass = 0; pass < 2; pass++) for (const p of missingShelter(pl).sort((a, b) => a.y - b.y)) {
        const it = filler(); if (!it) break
        if (S.eye().distanceTo(p.offset(0.5, 0.5, 0.5)) > 4.4) continue
        // something solid to place against: below first, then the sides, then above
        const ref = [[0, -1, 0], [1, 0, 0], [-1, 0, 0], [0, 0, 1], [0, 0, -1], [0, 1, 0]].map(([dx, dy, dz]) => [S.block(p.offset(dx, dy, dz)), v(-dx, -dy, -dz)]).find(([b]) => b && b.boundingBox === 'block' && !CONTAINER.test(b.name) && !/door|_bed$|crafting_table/.test(b.name))
        if (ref && await S.placeAgainst(ref[0], ref[1], it)) placed++
        else if (pl.box && (p.x === pl.box.x0 - 1 || p.x === pl.box.x1 + 1) && (p.z === pl.box.z0 - 1 || p.z === pl.box.z1 + 1)) { const k = p.x + ',' + p.z; st.shelterTries = st.shelterTries || {}; st.shelterTries[k] = (st.shelterTries[k] || 0) + 1; if (st.shelterTries[k] >= 3) { st.shelterSkip = (st.shelterSkip || []).concat([k]) } }
      }
    }
    // a torch inside, so nothing spawns next to the bed
    if (!shelterTorch(pl) && cnt('torch')) {
      for (const c of [pl.inside, ...[[1, 0], [-1, 0], [0, 1], [0, -1]].map(([dx, dz]) => pl.inside.offset(dx, 0, dz))]) {
        const b = S.block(c), g = S.block(c.offset(0, -1, 0)); if (!b || !S.isAir(b) || !g || g.boundingBox !== 'block') continue
        if (S.dist(c) > 4) await S.goto(new goals.GoalNear(c.x, c.y, c.z, 2), { dig: false, ms: 15000, escalate: false })
        if (await S.placeAgainst(g, v(0, 1, 0), 'torch')) { placed++; break }
      }
    }
    // a door in every doorway (each stays open otherwise)
    for (const dr of pl.doors || [pl.door]) {
      let db = S.block(dr), da = S.block(dr.offset(0, 1, 0))
      if (!db || /door/.test(db.name)) continue
      if (!S.items().some(i => /_door$/.test(i.name)) && S.planks() + S.logs() * 4 >= 6) await S.craft('oak_door', 1).catch(() => false)
      const dItem = S.items().find(i => /_door$/.test(i.name))
      // a doorway that is still walled up (the second one, cut into its own wall): take the two wall blocks out first, with the door in the bag
      if (dItem && [db, da].some(b => b && b.boundingBox === 'block' && FILL.test(b.name))) {
        await S.goto(new goals.GoalNear(dr.x, dr.y, dr.z, 2), { dig: false, ms: 20000, escalate: false })
        for (const b of [da, db]) if (b && b.boundingBox === 'block' && FILL.test(b.name)) { try { await S.digBlock(b, { force: true }) } catch {} }
        db = S.block(dr); da = S.block(dr.offset(0, 1, 0))
      }
      const floor = S.block(dr.offset(0, -1, 0))
      if (dItem && floor && floor.boundingBox === 'block' && S.isAir(db) && da && S.isAir(da)) {
        await S.goto(new goals.GoalNear(dr.x, dr.y, dr.z, 2), { dig: false, ms: 20000, escalate: false })
        if (await S.placeAgainst(floor, v(0, 1, 0), dItem.name)) placed++
      }
    }
    const left = missingShelter(pl).length, todo = shelterTodo(pl)
    // what cannot be done (a cell with nothing to place against, a torch or door that will not go down) must not hold the step ahead of
    // iron for ever: three passes without progress pause it for an hour
    if (todo > 0 && todo >= before) { st.shelterStuck = (st.shelterStuck || 0) + 1; if (st.shelterStuck >= 3) { st.shelterPauseUntil = Date.now() + 3600000; st.shelterStuck = 0 } } else st.shelterStuck = 0
    note(`shelter: ${placed} placed, ${left} wall/roof blocks still missing, door ${doorIn(pl) ? 'in' : 'open'}, torch ${shelterTorch(pl) ? 'in' : 'missing'}`)
    st._shelterAt = 0
    return placed > 0 } })

  // ---- the home bed is a fixed point (Walter 2026-11-04: if the base blows up, use commands to put a bed back and reset the spawn). When the
  // bed block at home is gone, a bed is given if none is carried, set down at the same spot and the respawn point is set there again. ----
  steps.splice(Math.max(0, steps.findIndex(s => s.id === 'eat') + 1), 0, { id: 'rebed', budget: 90000, cool: 30000, need: () => {
    if (!st.home) return false; const hb = S.block(v(...st.home)); return !!hb && !/_bed$/.test(hb.name) && bot.health > 6 }, run: async () => {
    const h = v(...st.home)
    if (!S.items().some(i => /_bed$/.test(i.name)) && Date.now() - (st.bedGivenAt || 0) > 120000) { st.bedGivenAt = Date.now(); api.say(`/give ${bot.username} white_bed 1`); await new Promise(r => setTimeout(r, 2500)) }
    if (!S.items().some(i => /_bed$/.test(i.name))) return false
    // far away (respawned at world spawn without a bed): teleport, the walk would eat the whole step
    const r = S.dist(h) > 48 ? { ok: false } : await S.goto(new goals.GoalNear(h.x, h.y, h.z, 2), { dig: false, ms: 40000, maxMs: 60000 })
    if (!r.ok) { api.say(`/tp ${bot.username} ${h.x} ${h.y} ${h.z - 2}`); await new Promise(r => setTimeout(r, 2500)) }
    const hb = S.block(h); if (hb && !S.isAir(hb) && !/_bed$/.test(hb.name)) await S.mine(hb, { dig: false })
    let fl = S.block(h.offset(0, -1, 0))
    if (fl && !S.solid(fl)) { const below = S.block(h.offset(0, -2, 0)); if (below && S.solid(below)) await S.placeAgainst(below, v(0, 1, 0), (S.items().find(i => cobbleRe.test(i.name)) || {}).name); fl = S.block(h.offset(0, -1, 0)) }
    const bedItem = S.items().find(i => /_bed$/.test(i.name))
    const ok = !!(fl && S.solid(fl) && bedItem && await S.placeAgainst(fl, v(0, 1, 0), bedItem.name))
    if (ok) {
      // the bed may extend the other way: home is whichever bed cell is now at or next to the spot
      const cell = [h, ...[[1, 0], [-1, 0], [0, 1], [0, -1]].map(([x, z]) => h.offset(x, 0, z))].find(p => { const b = S.block(p); return b && /_bed$/.test(b.name) })
      if (cell) { st.home = [cell.x, cell.y, cell.z]; G.save() }
      api.say(`/spawnpoint ${bot.username} ${st.home[0]} ${st.home[1]} ${st.home[2]}`)
      st.rebeds = (st.rebeds || 0) + 1
    }
    note(`rebed: home bed was gone, ${ok ? 'put a bed back at ' + st.home.join(',') + ' and reset the respawn point' : 'could not place the bed yet'}`)
    return ok } })

  // ---- cover from archers: pillager crossbows and skeleton arrows killed the bot twice by the house in one minute (02:18/02:19). Without a shield the answer
  // is walls: get inside home and stay out of their line of sight until they wander off, then carry on. ----
  steps.push({ id: 'take-cover', budget: 120000, need: () => { const h = home(); if (!h || S.dist(h) > 40) return false; const hasShield = worn('off-hand') && worn('off-hand').name === 'shield'; return !hasShield && S.hostilesNear(28).some(e => /^(pillager|skeleton|stray|vindicator|evoker|witch|phantom)$/.test(e.name) && S.canSee(e)) }, cool: 15000, run: async () => {
    const h = home()
    await S.goto(new goals.GoalNear(h.x, h.y, h.z, 1), { dig: false, ms: 30000 })
    const t0 = Date.now()
    while (Date.now() - t0 < 90000 && S.hostilesNear(28).some(e => /^(pillager|skeleton|stray|vindicator|evoker|witch|phantom)$/.test(e.name) && S.canSee(e))) await S.wait(2000)
    note('take-cover: sheltered at home ' + Math.round((Date.now() - t0) / 1000) + 's from archers and phantoms'); return true } })

  // ---- scaffolding is incidental, not established (Walter's screenshots: cobble pillars, holes and stray blocks around the house) ----
  // every block the bot places (its own placing, the pathfinder's scaffolding, nav pillars) is remembered; plain scaffold blocks that are
  // still there after 10 minutes, on the surface and outside the home/farm, are taken down again, top first.
  if (!bot._placeLogPatched) {
    bot._placeLogPatched = true
    const orig = bot.placeBlock.bind(bot)
    bot.placeBlock = async function (ref, face, ...rest) {
      const held = bot.heldItem && bot.heldItem.name
      const r = await orig(ref, face, ...rest)
      try { const p = ref.position.plus(face); const sx = bot._ap && bot._ap.G && bot._ap.G.state; if (sx && held) { sx.placed = (sx.placed || []).concat([[p.x, p.y, p.z, held, Date.now()]]).slice(-600) } } catch {}
      return r
    }
  }
  const SCAFFOLD = /^(cobblestone|cobbled_deepslate|dirt|andesite|diorite|granite|tuff|netherrack|stone)$/
  let _tidy = { at: 0, list: [] }
  const tidyList = () => { if (Date.now() - _tidy.at < 10000) return _tidy.list; _tidy = { at: Date.now(), list: tidyList0() }; return _tidy.list }
  const tidyList0 = () => {
    const hb = homeBox(), now = Date.now(), placedKeys = new Set((st.placed || []).map(q => q[0] + ',' + q[1] + ',' + q[2]))
    return (st.placed || []).filter(q => now - q[4] > 10 * 60000 && SCAFFOLD.test(q[3])).map(q => v(q[0], q[1], q[2])).filter(p => {
      const b = S.block(p); if (!b || !SCAFFOLD.test(b.name)) return false
      if (inBox(p, hb) || nearList(p, st.farm, 1) || nearList(p, st.grove, 1)) return false
      // nothing in or around the shelter (walls, roof, floor, the ground at the door): it took the floor out by the door (22:31)
      // ...but only the shelter's own cells: pillars the escalating go-to left against its walls and on its roof are scaffold like any other
      // (a 4-high column at 192,-293 and blocks on the roof let the walk home end up on the roof, 03:26)
      { const sb = st._shelterBox; if (sb && p.x >= sb.x0 - 3 && p.x <= sb.x1 + 3 && p.z >= sb.z0 - 3 && p.z <= sb.z1 + 3 && p.y >= sb.y - 2 && p.y <= sb.y + 3) {
          const pl = shelterPlan(); if (!pl || pl.walls.concat(pl.roof, pl.floor || []).some(q => q.equals(p))) return false } }
      // surface scaffold only: blocks under ground are tunnel plugs, cave walls and pillars that keep the mine closed. Tidy walked down into
      // the cave under home to take them apart and the bot died there at 20:43 (fell in, two zombies)
      // (exposure, not height: valleys and the island shore sit below the bed and their pillars must still go; a block with solid
      // rock within 8 above it is under ground; its own placed blocks stacked above do not count as cover, natural stone does)
      { const h0 = home(); if (h0 && p.y < h0.y - 12) return false }       // deep backstop: a tall cavern's floor can have open air 8 up
      for (let dy = 1; dy <= 8; dy++) { const q = p.offset(0, dy, 0), a = S.block(q); if (!a) break; if (a.boundingBox === 'block' && !placedKeys.has(q.x + ',' + q.y + ',' + q.z) && !/_leaves$|_log$/.test(a.name)) return false }
      if (st.mine && st.mine.entry && Math.abs(p.x - st.mine.entry[0]) <= 3 && Math.abs(p.z - st.mine.entry[2]) <= 3) return false
      const below = S.block(p.offset(0, -1, 0)), above = S.block(p.offset(0, 1, 0))
      if (below && below.name === 'water') return false                         // sea paths: taking them apart from on top of them means swimming
      if (above && !S.isAir(above)) return false                                // something stands on it (a torch, a block, a plant)
      return S.skyVisible ? true : true
    }).sort((p, q) => q.y - p.y)
  }
  // over-lighting: the top-down map showed 240 torches in a tight grid around home. A torch the bot placed with another one within 3 blocks goes.
  // replaced by the light-home grid pruning (it keeps grid torches and checks the light before taking one down)
  const extraTorches = () => []
  const crowdedTorches = () => (st.placed || []).filter(q => q[3] === 'torch').map(q => v(q[0], q[1], q[2])).filter(p => { const b = S.block(p); if (!b || !/torch/.test(b.name)) return false; return bot.findBlocks({ matching: ids(/^(torch|wall_torch)$/), maxDistance: 3, count: 4, point: p }).some(o => !o.equals(p)) })
  steps.push({ id: 'tidy', budget: 150000, cool: 300000, need: () => !S.isNight() && !!home() && (tidyList().length > 0 || extraTorches().length > 0), run: async () => {
    let n = 0
    let tn = 0
    for (const p of extraTorches().slice(0, 30)) { if (bot.findBlocks({ matching: ids(/^(torch|wall_torch)$/), maxDistance: 3, count: 4, point: p }).filter(o => !o.equals(p)).length === 0) continue; const tb = S.block(p); if (tb && await S.mine(tb, { dig: false })) tn++ }
    if (tn) note('tidy: removed ' + tn + ' crowded torches')
    for (const p of tidyList().slice(0, 24)) {
      const b = S.block(p); if (!b) continue
      if (S.flo(bot.entity.position).offset(0, -1, 0).equals(p)) continue       // never the block it stands on
      if (await S.mine(b, { dig: false })) n++
    }
    st.placed = (st.placed || []).filter(q => { const b = S.block(v(q[0], q[1], q[2])); return !b || !S.isAir(b) })
    G.save(); note('tidy: took down ' + n + ' scaffold blocks'); return n > 0 } })

  // ---- supply trips (Walter: going 200-300 blocks by day for resources is normal): when nothing usable is remembered, walk out on land in a new
  // direction each time; trees and animals seen on the way are remembered by the sighting timers and the normal steps go and use them ----
  steps.push({ id: 'scout', budget: 240000, cool: 300000, need: () => daylightLeft() > 4000 && bot.health > 12 && S.foodPoints() >= 6 && !!home() &&
      ((S.logs() + S.planks() < 4 && !(st.treeSeen || []).some(q => { const b = S.block(v(q[0], q[1], q[2])); return !b || /_log$/.test(b.name) })) ||
       (S.foodPoints() + S.rawFood() * 2 < 8 && !(st.animalSeen || []).length)), run: async () => {
    const h = home(); st.scoutHeading = ((st.scoutHeading == null ? -1 : st.scoutHeading) + 3) % 8
    const a = st.scoutHeading * Math.PI / 4, dist = 90 + 40 * (st.scoutHeading % 3)
    const tx = Math.round(h.x + Math.cos(a) * dist), tz = Math.round(h.z + Math.sin(a) * dist)
    const r = await S.goto(new goals.GoalNearXZ(tx, tz, 8), { dig: false, ms: 180000 })
    note('scout: heading ' + st.scoutHeading + ' toward ' + tx + ',' + tz + ' (' + (r.ok ? 'arrived' : (r.err || r.why || 'stopped')) + '), now ' + bot.entity.position.floored() + '; trees known ' + (st.treeSeen || []).length + ', animals ' + (st.animalSeen || []).length)
    G.save(); return true } })

  // ---- storage headroom (Walter: build chest capacity out before it turns into an inventory loop): keep at least one empty chest's worth of
  // free slots at home; whenever wood allows, add a chest next to the others. Free space is recorded every time a home chest is opened. ----
  const homeFree = () => { const h = home(); if (!h) return 99; const live = bot.findBlocks({ matching: ids(/^chest$/), maxDistance: 12, count: 20, point: h }); if (!live.length) return 0; return live.reduce((s, p) => s + ((st.chestFree || {})[p.toString()] ?? 27), 0) }
  steps.push({ id: 'storage', budget: 120000, cool: 300000, need: () => !!home() && homeFree() < 27 && (S.planks() >= 8 || S.logs() >= 3 || S.has('chest')), run: async () => {
    const h = home(); let added = 0
    for (let i = 0; i < 2 && homeFree() < 54; i++) {
      if (!S.has('chest') && !(await S.craft('chest', 1))) break
      await S.goto(new goals.GoalNear(h.x, h.y, h.z, 3), { dig: false, ms: 60000 })
      const placed = await S.placeNear('chest'); if (!placed) break
      st.chestFree = st.chestFree || {}; st.chestFree[placed.position.toString()] = 27; added++
    }
    G.save(); note('storage: added ' + added + ' chests, about ' + homeFree() + ' free slots at home'); return added > 0 } })

  // resource memory: where food animals were last seen (they are scarce on the island; hunting only what is in range found nothing for an hour)
  const FOODMOB = /^(cow|pig|sheep|chicken|rabbit|mooshroom)$/
  const sightTimer = setInterval(() => {
    try {
      if (!bot.entity) return
      const me = bot.entity.position, seen = []
      for (const e of Object.values(bot.entities)) if (e && e.name && FOODMOB.test(e.name) && e.position.distanceTo(me) < 128 && (!S.inZone || S.inZone(e.position)) && (!st.home || e.position.y > st.home[1] - 15)) seen.push([Math.floor(e.position.x), Math.floor(e.position.y), Math.floor(e.position.z), e.name, Date.now()])
      if (seen.length) { st.animalSeen = seen.concat((st.animalSeen || []).filter(a => !st.home || a[1] > st.home[1] - 15).filter(a => !seen.some(s => Math.hypot(s[0] - a[0], s[2] - a[2]) < 8))).slice(0, 30) }
    } catch {}
  }, 10000)
  // trees seen anywhere it goes are remembered too (the trees around home got used up; the wooded hill where the sheep live is a walk away)
  const treeTimer = setInterval(() => {
    try {
      if (!bot.entity || !S.skyVisible()) return
      const ps = bot.findBlocks({ matching: ids(/_log$/), maxDistance: 32, count: 40 }).filter(p => S.inZone(p) && (!st.home || p.y > st.home[1] - 15))
      const cols = []; for (const p of ps) if (!cols.some(c => Math.abs(c[0] - p.x) < 3 && Math.abs(c[2] - p.z) < 3)) cols.push([p.x, p.y, p.z, Date.now()])
      if (cols.length) st.treeSeen = cols.concat((st.treeSeen || []).filter(o => !cols.some(c => Math.abs(c[0] - o[0]) < 3 && Math.abs(c[2] - o[2]) < 3))).slice(0, 60)
    } catch {}
  }, 20000)
  { const prev = G.dispose; G.dispose = () => { clearInterval(sightTimer); clearInterval(treeTimer); if (prev) prev() } }
  steps.push({ id: 'hunt-memory', budget: 240000, need: () => daylightLeft() > 3000 && bot.health > 8 && S.foodPoints() < 12 && (st.animalSeen || []).some(a => Date.now() - a[4] < 30 * 60000), cool: 120000, run: async () => {
    // a swim is where drowned spear the bot (death 12:55, 'impaled by Drowned' on the way to a cow across the water): skip animals across open water
    // bounded: at most 16 samples, stop a column at the first loaded non-air block or an unloaded chunk (the old version froze the bot for 60 s)
    const wet = (x0, z0, x1, z1) => { let w = 0; const n = Math.min(16, Math.ceil(Math.hypot(x1 - x0, z1 - z0) / 4)); for (let i = 1; i < n; i++) { const x = Math.floor(x0 + (x1 - x0) * i / n), z = Math.floor(z0 + (z1 - z0) * i / n); for (let y = 80; y > 50; y -= 2) { const b = S.block(v(x, y, z)); if (!b) break; if (b.name === 'water') { w++; break } if (b.boundingBox === 'block') break } } return w }
    const me0 = bot.entity.position
    const a = (st.animalSeen || []).filter(x => Date.now() - x[4] < 30 * 60000).sort((p, q) => S.dist(v(p[0], p[1], p[2])) - S.dist(v(q[0], q[1], q[2]))).slice(0, 4).find(x => wet(me0.x, me0.z, x[0], x[2]) <= 3)
    if (!a) return false
    const r = await S.goto(new goals.GoalNear(a[0], a[1], a[2], 4), { dig: false, ms: 150000 })
    let n = 0
    // not only the ones in view: after a long walk they are usually behind a hill; S.kill walks up to them
    const me1 = bot.entity.position
    const near = Object.values(bot.entities).filter(e => e && e.name && FOODMOB.test(e.name) && e.position.distanceTo(me1) < 40).sort((p, q) => p.position.distanceTo(me1) - q.position.distanceTo(me1))
    for (const e of near.slice(0, 3)) { await S.kill(e); n++ }
    await S.pickup(10, 4000)
    if (!near.length) st.animalSeen = (st.animalSeen || []).filter(x => x !== a)
    note(`hunt-memory: went to the ${a[3]} seen at ${a[0]},${a[2]} (${r.ok ? 'arrived' : 'no path'}), killed ${n}, raw food ${S.rawFood()}`)
    return n > 0 } })

  // deaths teach places: an underground death marks the spot, and the mine moves away from it (two deaths in the same gravel pocket at 200,58,-300)
  const onDeathPlace = () => {
    try {
      const p = bot.entity.position
      st.avoid = (st.avoid || []).concat([[Math.floor(p.x), Math.floor(p.y), Math.floor(p.z)]]).slice(-20)
      if (p.y < 60) { st.mineSpot = (st.mineSpot || 0) + 1; st.mineBlocked = 0 }
      // a shaft whose tunnels open into a mob-filled cave: the bot died four times around (223-231, 22-27, -313..-338) in five hours. Two deaths
      // within 48 blocks of the shaft bottom and the shaft is given up; the next one is dug at another spot around home
      if (p.y < 60 && st.mine && st.mine.bottom && p.distanceTo(v(...st.mine.bottom)) < 48) {
        if (Date.now() - (st.mineDeathAt || 0) > 30 * 60000) st.mineDeaths = 0   // one death long ago does not count toward a deadly shaft
        st.mineDeaths = (st.mineDeaths || 0) + 1; st.mineDeathAt = Date.now()
        if (st.mineDeaths >= 2) { log('PLAN', `mine: ${st.mineDeaths} deaths around the shaft bottom ${st.mine.bottom}, giving the shaft up`); st.avoidMines = (st.avoidMines || []).concat([st.mine.bottom]).slice(-8); st.mine = null; st.mineSite = null; st.mineDeaths = 0 }
      }
      st.restockAt = 0   // the bag is empty now: the home chests are the first stop
      G.save(); log('PLAN', `death at ${p.floored()} remembered; mine spot now ${st.mineSpot || 0}`)
    } catch {}
  }
  bot.on('death', onDeathPlace)
  const prevDispose = G.dispose
  G.dispose = () => { try { bot.removeListener('death', onDeathPlace) } catch {} if (prevDispose) prevDispose() }

  M.goSurface = async () => {
    if (S.skyVisible()) return 'already up'
    // at the shaft's own entry (or above it) is up, sky or not: the entry at 219,88,-402 is under a tree, and standing there read as 'no
    // way up from y88', a reset (11:48)
    const atTop = () => { try { if (!st.mine || !st.mine.entry) return false; const e = v(...st.mine.entry); return S.dist(e) < 4 || (bot.entity.position.y >= e.y - 1 && Math.hypot(bot.entity.position.x - e.x, bot.entity.position.z - e.z) < 12) } catch { return false } }
    if (atTop()) return 'already up (at the shaft entry)'
    if (st.mine && st.mine.bottom) {
      // straight for the entry (going to the bottom first sent it 30 blocks down from halfway up the shaft); digging allowed on a second try
      const e = v(...st.mine.entry), b = v(...st.mine.bottom)
      // out in the tunnels at the bottom's level: back along them to the foot of the stairs first. One search from a tunnel end 40 blocks
      // out to the top found no path, the escalation dug its own way up into an aquifer and the good shaft was given up (15:58, y47)
      if (Math.abs(bot.entity.position.y - b.y) <= 3 && S.dist(b) > 6) await S.goto(new goals.GoalNear(b.x, b.y, b.z, 2), { dig: false, ms: 90000, escalate: false })
      // the recorded stairs, walked backwards one cell at a time from the nearest one (short plain steps; a stair that will not take
      // the bot gets its two cells cleared, the shaft's own stone, and one more try)
      const path = (st.mine.path || []).map(q => v(...q))
      if (path.length > 3) {
        let i = path.reduce((bi, q, k) => (S.dist(q.offset(0.5, 0, 0.5)) < S.dist(path[bi].offset(0.5, 0, 0.5)) ? k : bi), 0)
        log('PLAN', `goSurface: stairs from cell ${i}/${path.length} (${path[i]}), ${S.dist(path[i].offset(0.5, 0, 0.5)).toFixed(1)} away`)
        if (S.dist(path[i].offset(0.5, 0, 0.5)) < 4) {
          let fails = 0
          for (; i >= 0 && fails < 4; i--) {
            S.check()
            const q = path[i]; if (S.dist(q.offset(0.5, 0, 0.5)) < 0.7) continue
            let rr = await S.goto(new goals.GoalBlock(q.x, q.y, q.z), { dig: false, ms: 8000, escalate: false })
            if (!rr.ok) {
              for (const c of [q, q.offset(0, 1, 0)]) { const bl = S.block(c); if (bl && bl.boundingBox === 'block' && !S.isLiquid(bl)) await S.digBlock(bl, { force: true }).catch(() => false) }
              rr = await S.goto(new goals.GoalBlock(q.x, q.y, q.z), { dig: false, ms: 8000, escalate: false })
            }
            if (!rr.ok) fails++
          }
          log('PLAN', `goSurface: stairs walk ended at cell ${Math.max(i, 0)} with ${fails} fails, at ${S.flo(bot.entity.position)}`)
          if (S.skyVisible() || atTop()) return 'via the stairs'
        }
      }
      let r = await S.goto(new goals.GoalNear(e.x, e.y, e.z, 2), { dig: false, ms: 120000 })
      if (!r.ok && !S.skyVisible()) r = await S.goto(new goals.GoalNear(e.x, e.y, e.z, 2), { dig: true, ms: 120000 })
      if (r.ok || S.skyVisible() || atTop()) return 'via the shaft'
    }
    const d = await M.surface()
    if (S.skyVisible()) return 'dug: ' + JSON.stringify(d)
    // no way up at all: the reset (teleport home) rather than another half hour in the rock (21:37, stuck at y48 in the shaft)
    if (st.mine) { st.mine = null; st.mineSpot = (st.mineSpot || 0) + 1; G.save() }    // a shaft it cannot climb is not the established way down any more
    const reset = G.forceReset && G.forceReset('no way up from y' + Math.floor(bot.entity.position.y))
    return 'stuck: ' + JSON.stringify(d) + (reset ? ', reset home' : '')
  }

  // place the new processes into the step list by priority
  const at = (id) => G.steps.findIndex(s => s.id === id)
  const insertAfter = (id, list) => { const i = at(id); G.steps.splice(i >= 0 ? i + 1 : G.steps.length, 0, ...list) }
  const byId = Object.fromEntries(steps.map(s => [s.id, s]))
  insertAfter('eat', [steps.find(s => s.id === 'take-cover'), byId.rebed])
  insertAfter('cook', [byId['night-home'], byId.restock, byId['tool-kit'], byId.harvest])   // ripe wheat is a quick sure meal: before wood trips (34 ripe stalks waited all afternoon)
  insertAfter('furnace', [byId.torches, byId['wood-stock'], byId.wear, byId.shield, byId['iron-smelt'], byId['iron-gear']])
  insertAfter('food', ['berries', 'fish', 'rod', 'string', 'hunt-memory', 'tend'].map(id => steps.find(s => s.id === id)).concat([byId.seeds, byId.farm]))   // kelp diving dropped: it drowned the bot
  // iron before upkeep: grove, lighting and tidying kept winning every pick and the hillclimber never went mining (02:50)
  insertAfter('coal', [byId.stash, byId.shelter, byId.iron, byId.grove, byId['light-home'], steps.find(s => s.id === 'tidy')])
  insertAfter('wood-stock', [steps.find(s => s.id === 'scout'), steps.find(s => s.id === 'storage')])
  // routine work at a fixed site (site.json; Smeo444's birch farm), right after the survival basics
  try { delete require.cache[require.resolve('./site')]; insertAfter('tool-kit', [require('./site')(G, S, M, api, log)]) } catch (e) { log('PLAN', 'site not loaded: ' + e.message) }
  // the assistant's second routine: finishing the mobs in Walter's mob farm (mobfarm.json). Before the birch farm: a pass takes a minute
  // and mobs waiting in the shaft hold the farm's mob cap (four skeletons waited 30 min behind back-to-back birch rounds, 04:00)
  try { delete require.cache[require.resolve('./mobfarm')]; insertAfter('tool-kit', [require('./mobfarm')(G, S, M, api, log)]) } catch (e) { log('PLAN', 'mobfarm not loaded: ' + e.message) }
  // long goals from brain/state/goals.json, expanded through the recipe tree (pursue.js)
  try { delete require.cache[require.resolve('./pursue')]; G.steps.push(require('./pursue')(G, S, M, api, log, { daylightOk: () => true })) } catch (e) { log('PLAN', 'pursue not loaded: ' + e.message) }
  log('PLAN', 'survival processes loaded: ' + G.steps.map(s => s.id).join(' > '))
}
