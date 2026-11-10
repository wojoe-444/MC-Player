// brain/autopilot/goals.js: what the bot wants next. A list of steps in priority order; the first unmet one that is not cooling down runs.
// Steps return true (progress), false (failed, cools down) or 'explore' (nothing in sight: walk somewhere new first).
const fs = require('fs')
const { LOG_RE, PLANK_RE, FOOD_VALUE, RAW_MEAT, PASSIVE_FOOD, ORE_RE } = require('./skills').consts

module.exports = function makeGoals(S, M, api, log) {
  const bot = S.bot, { goals } = S, v = S.v
  const file = api.statePath('autopilot-state.json')
  const load = () => { try { return JSON.parse(fs.readFileSync(file, 'utf8')) } catch { return {} } }
  const G = { state: load(), fails: {}, cool: {}, lastStep: null, log: [] }
  // survival steps are never held back and never start a commitment
  G.commit = require('./commit').createCommit({ urgent: new Set(['eat', 'recover', 'take-cover', 'night-home', 'rebed', 'shelter', 'wear', 'shield']) })
  const st = G.state
  st.said = st.said || {}
  st.heading = st.heading == null ? Math.floor(Math.random() * 8) : st.heading
  G.save = () => { try { fs.writeFileSync(file + '.tmp', JSON.stringify(st, null, 1)); fs.renameSync(file + '.tmp', file) } catch {} }
  const note = (m) => { G.log.push(`${new Date().toISOString().slice(11, 19)} ${m}`); if (G.log.length > 80) G.log.shift(); log('GOAL', m) }
  G.note = note
  const milestone = (id, text) => { if (st.said[id]) return; st.said[id] = Date.now(); G.save(); S.say(text) }
  G.milestone = milestone

  const cobbleRe = /^(cobblestone|cobbled_deepslate|blackstone)$/
  const stoneSrc = /^(stone|cobblestone|deepslate)$/
  const tier = (k) => S.toolTier(k)

  // ---------- helpers ----------
  async function explore(hop = 32) {
    // never explore from underground: caves are where it drowned and suffocated; get to the sky first
    if (!S.skyVisible() && bot.entity.position.y < 64) { const up = await (M.goSurface ? M.goSurface() : M.surface()); note('explore: surfaced first ' + JSON.stringify(up)); return true }
    if (S.nightHold) { await S.wait(1500); return false }      // watchdog night guard: no outdoor wandering in the dark (4 deaths)
    if (S.isNight() && st.home) { note('explore: not at night'); await S.wait(1500); return false }   // 'stone: nothing in sight, exploring' walked it into the sea at night (18:42)
    if (bot.entity.position.y > 55 && !S.skyVisible()) { const a = await M.ascend(40); note('boxed in: ascend ' + a.ok) }
    // walk to a new area along a rotating heading, avoiding oceans by trying other headings when the path fails
    for (let i = 0; i < 8; i++) {
      S.check()
      const ang = (st.heading % 8) * Math.PI / 4
      const p = bot.entity.position
      let tx = Math.floor(p.x + Math.cos(ang) * hop), tz = Math.floor(p.z + Math.sin(ang) * hop)
      // leash (watchdog, deaths 4 and 5 were 100+ blocks from base with no armor): wander only within LEASH of the base, else walk back toward it
      // leash centre: home (the bed) if known, else the work zone centre (brain/state/zone.json); never the old base-world coordinates
      const zc = (S.zone && S.zone() && S.zone().workZone) || { x: p.x, z: p.z, r: 120 }
      const hm = st.home ? { x: st.home[0], z: st.home[2] } : zc
      const BX = hm.x, BZ = hm.z, LEASH = Math.min(90, zc.r || 90)
      if (Math.hypot(tx - BX, tz - BZ) > LEASH) {      // outside the leash: pick a random spot inside it instead (always a real walk, never an instant no-op)
        const a2 = Math.random() * Math.PI * 2, r2 = 15 + Math.random() * 40
        tx = Math.floor(BX + Math.cos(a2) * r2); tz = Math.floor(BZ + Math.sin(a2) * r2)
      }
      const r = await S.goto(new goals.GoalXZ(tx, tz), { dig: false, ms: 40000 })
      if (r.ok || S.dist(v(tx, p.y, tz)) < hop * 0.6) { note(`explored heading ${st.heading % 8}`); G.save(); return true }
      st.heading = (st.heading + 1 + Math.floor(Math.random() * 3)) % 8
    }
    G.save()
    return false
  }
  G.explore = explore

  async function ensureWoodForTools() {
    const units = S.logs() * 4 + S.planks()
    if (units >= 24) return true
    const got = await S.chopTree(Math.ceil((24 - units) / 4) + 1, { ms: 150000 })
    return got > 0 || S.logs() * 4 + S.planks() >= 12
  }

  async function goDownMine(targetY, ores, len = 40, stopFn = null) {
    // staircase to targetY, then a tunnel mining visible ores; returns true if anything was mined or length done
    if (Math.floor(bot.entity.position.y) > targetY) {
      const d = await M.descend(targetY)
      note(`descend -> y=${d.y} ${d.ok ? 'ok' : d.reason}`)
      if (!d.ok && d.y > targetY + 6) return false
    }
    let total = 0
    for (let leg = 0; leg < 4; leg++) {
      const dirIdx = Math.floor(Math.random() * 4)
      const r = await M.tunnel(dirIdx, len, { targets: ores, stop: stopFn })
      note(`tunnel dir ${dirIdx}: ${r.len} blocks, mined ${r.mined}, ${r.reason}`)
      total += r.mined
      if (stopFn && stopFn()) return true
      if (r.reason === 'full') return true
    }
    return total > 0
  }

  async function hideForNight() {
    // 1x2 hole with a roof: dig down 2, stand there, place a block over the head
    note('hiding for the night')
    const p = S.flo(bot.entity.position)
    for (let i = 0; i < 2; i++) { const b = S.block(S.flo(bot.entity.position).offset(0, -1, 0)); if (!b || !(await S.digBlock(b))) break; await S.wait(500) }
    const mat = ['dirt', 'cobblestone', 'stone', 'netherrack'].find(n => S.has(n))
    if (mat) {
      const above = S.flo(bot.entity.position).offset(0, 2, 0)
      const ref = S.block(above.offset(1, 0, 0)) // place against a side block if solid else skip
      for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
        const r = S.block(above.offset(dx, 0, dz)); if (r && S.solid(r)) { await S.placeAgainst(r, v(-dx, 0, -dz), mat); break }
      }
    }
    const t0 = Date.now()
    while (S.isNight() && Date.now() - t0 < 240000) { S.check(); await S.wait(2000) }
    return true
  }

  // ---------- the steps ----------
  const steps = [
    // hurt with a hunger bar under 18 does not heal at all: eat then too, and bake bread from carried wheat when there is no food
    // (17:25-17:40 OzoGo444 sat at 2 hp, food 15-16, 11 wheat in the bag and nothing to eat)
    { id: 'eat', need: () => (bot.food <= 14 || (bot.health < 14 && bot.food < 18)) && (S.foodPoints() > 0 || S.count('wheat') >= 3) && !S.hostilesNear(5).length, run: async () => {
      if (S.foodPoints() <= 0 && S.count('wheat') >= 3) await S.craft('bread', Math.min(4, Math.floor(S.count('wheat') / 3))).catch(() => false)
      let ate = 0; for (let i = 0; i < 3 && bot.food < 19 && S.foodPoints() > 0; i++) { if (!(await S.eat())) break; ate++; await S.wait(300) } return ate > 0 } },

    { id: 'recover', need: () => process.env.AUTO_RECOVER === '1' && st.death && Date.now() - st.death.t < 8 * 60000 && !st.death.done, run: async () => {
      const d = st.death; note(`recovering items at ${d.x},${d.y},${d.z}`)
      const r = await S.goto(new goals.GoalNear(d.x, d.y, d.z, 3), { dig: true, ms: 90000 })
      await S.pickup(12, 15000)
      d.done = true; G.save(); return true } },

    { id: 'cook', need: () => S.rawFood() >= 2 && (S.has('furnace') || S.furnaceNear(32)) && S.fuelPlan(), cool: 120000, run: async () => {
      for (const n of RAW_MEAT) { const c = S.count(n); if (c >= 1) { const got = await S.smelt(n, c); note(`cooked ${n} x${got}`) } }
      return true } },

    // --- wood & wooden tools ---
    { id: 'wood', need: () => tier('pickaxe') < 1 && S.logs() * 4 + S.planks() < 24, cool: 20000, run: async () => { const ok = await ensureWoodForTools(); return ok } },   // no random exploring for wood: wood-stock walks to remembered trees },
    { id: 'wooden-tools', need: () => tier('pickaxe') < 1 || tier('axe') < 1 || !S.items().some(i => /_sword$/.test(i.name)), run: async () => {
      let ok = true
      if (tier('pickaxe') < 1) ok = (await S.craft('wooden_pickaxe', 1)) && ok
      if (tier('axe') < 1) ok = (await S.craft('wooden_axe', 1)) && ok
      if (!S.items().some(i => /_sword$/.test(i.name))) ok = (await S.craft('wooden_sword', 1)) && ok
      if (tier('pickaxe') >= 1) milestone('wood-pick', 'Got my first pickaxe.')
      return ok } },

    // --- stone & stone tools ---
    { id: 'stone', need: () => (tier('pickaxe') < 2 || tier('axe') < 2 || !S.has('furnace')) && S.count(cobbleRe) < 14 + (S.has('furnace') ? 0 : 8), cool: 30000, run: async () => {
      const want = 24 - S.count(cobbleRe)
      let got = await S.gather(stoneSrc, want, { radius: 40, ms: 120000 })
      if (got < 4) {
        // nothing in sight: dig a staircase down; the cells themselves give cobble
        const y0 = Math.floor(bot.entity.position.y)
        await M.descend(y0 - 10, { maxSteps: 14 })
        got += 1
      }
      return S.count(cobbleRe) >= 8 ? true : 'explore' } },
    { id: 'stone-tools', need: () => S.count(cobbleRe) >= 3 && (tier('pickaxe') < 2 || tier('axe') < 2 || !S.items().some(i => /^(stone|iron|diamond)_sword$/.test(i.name))), run: async () => {
      let ok = true
      if (tier('pickaxe') < 2) ok = (await S.craft('stone_pickaxe', 1)) && ok
      if (tier('axe') < 2) ok = (await S.craft('stone_axe', 1)) && ok
      if (!S.items().some(i => /^(stone|iron|diamond)_sword$/.test(i.name))) ok = (await S.craft('stone_sword', 1)) && ok
      if (tier('pickaxe') >= 2) milestone('stone-pick', 'Stone tools done.')
      return ok } },
    { id: 'furnace', need: () => !S.has('furnace') && !S.furnaceNear(48) && S.count(cobbleRe) >= 8, run: async () => (await S.craft('furnace', 1)) } ,

    // --- food ---
    { id: 'food', need: () => S.foodPoints() + S.rawFood() * 3 < 14 && bot.food < 17, cool: 45000, run: async () => {
      const a = S.animals(Object.keys(PASSIVE_FOOD), 110).filter(e => !S.inZone || S.inZone(e.position))
      if (!a.length) return bot.food <= 10 ? 'explore' : false    // not hungry yet: let the other processes (farm, mine) run instead of wandering
      let n = 0
      for (let i = 0; i < 4 && a[i]; i++) { await S.kill(a[i]); n++; if (S.rawFood() + S.foodPoints() / 3 >= 8) break }
      return n > 0 } },

    // --- coal ---
    // with a home, fuel is charcoal and the coal the iron tunnels pass; this step dug its own holes down next to home into the flooded caves
    { id: 'coal', need: () => !st.home && tier('pickaxe') >= 1 && S.count(/^(coal|charcoal)$/) < 6 && !S.skipCoal, cool: 120000, run: async () => {
      let got = await S.gather(/^coal_ore$/, 6, { radius: 40, ms: 100000 })
      if (S.count(/^(coal|charcoal)$/) >= 4) return true
      // none in sight: go underground for it (coal is common between y 30 and 60)
      const y = Math.floor(bot.entity.position.y)
      const ok = await goDownMine(Math.min(y, 52) - 2 > 30 ? Math.min(y - 12, 48) : y, /^(coal_ore|deepslate_coal_ore)$/, 30, () => S.count(/^coal$/) >= 8)
      return ok } },
  ]

  G.steps = steps

  // ---------- decide & run ----------
  // (restock too: walking out to the chests by night got OzoGo444 shot by a skeleton, 23:34)
  const DAWN_SKIP = new Set(['iron', 'light-mine', 'wood', 'stone', 'explore', 'whimsy'])
  const NIGHT_SKIP = new Set(['restock', 'wood-stock', 'scout', 'hunt-memory', 'food', 'grove', 'seeds', 'farm', 'tend', 'fish', 'string', 'berries', 'harvest', 'tidy', 'pursue'])
  // tool-kit, iron-smelt, furnace and cook walk to a table or furnace at home: from the mine that walk is up the shaft first. At 03:15
  // tool-kit went for the table 49 blocks straight above the tunnel, the escalating go-to pillared up through an aquifer and the bot drowned
  const SURFACE = new Set(['tool-kit', 'iron-smelt', 'furnace', 'cook', 'harvest', 'berries', 'tend', 'seeds', 'farm', 'grove', 'light-home', 'tidy', 'wood-stock', 'scout', 'hunt-memory', 'food', 'fish', 'storage', 'stash', 'restock', 'night-home', 'rebed', 'take-cover', 'wood'])
  // the assistant's routine: keep itself alive and equipped, keep the base fed, lit, stocked and tidy; no mining trips, no exploring, no long goals
  const ASSISTANT_STEPS = new Set(['eat', 'take-cover', 'rebed', 'recover', 'cook', 'night-home', 'restock', 'tool-kit', 'site-work', 'mob-farm', 'harvest', 'berries', 'tend', 'seeds', 'wooden-tools', 'stone-tools', 'furnace', 'torches', 'wood-stock', 'storage', 'stash', 'grove', 'light-home', 'tidy', 'wear', 'shield'])
  G.pick = () => {
    const t = Date.now()
    const slowNeed = []
    // trips away from home are day work: woken in the night, the bot went for wood 30 blocks out and died to the mobs there (16:19).
    // At night it stays with what can be done at home (crafting, smelting, storage, the shaft, lighting close by).
    const night = S.isNight() && !!st.home
    // dawn too (time 22000-1800): the night's skeletons still stand in the forest shade. OzoGo444 went for wood 70 blocks out and to its
    // far mine at sunrise and died to arrows three times (14:04, 15:21, 15:33); trips away wait until the sun is well up
    const tod = (bot.time && bot.time.timeOfDay) || 6000, dawn = !!st.home && (tod >= 22000 || tod < 1800)
    // role (bot profile, falling back to brain/state/role.json, per bot): Walter 2026-11-04: Smeo444 is a personal assistant on a fixed routine (base upkeep and his
    // chat requests); OzoGo444 is the hillclimber with the full step list. Missing file = hillclimber.
    if (Date.now() - (G.roleAt || 0) > 10000) { G.roleAt = Date.now(); try { const pr = api.profile ? api.profile.get() : JSON.parse(require('fs').readFileSync(api.statePath('role.json'), 'utf8')); G.role = pr.role || 'hillclimber'; G.roleSteps = Array.isArray(pr.steps) ? new Set(pr.steps) : null } catch { G.role = 'hillclimber'; G.roleSteps = null } }
    const assistant = G.role === 'assistant'
    for (const s of steps) {
      if ((night || dawn) && G.role !== 'assistant' && (NIGHT_SKIP.has(s.id) || DAWN_SKIP.has(s.id))) continue
      if (night && NIGHT_SKIP.has(s.id)) continue
      if (assistant && !(G.roleSteps || ASSISTANT_STEPS).has(s.id)) continue
      let need = false
      const nt = Date.now()
      try { need = !!s.need() } catch (e) { log('GOAL_NEED_ERR', `${s.id}: ${e.message}`) }
      if (Date.now() - nt > 500) log('SLOW', `need() of ${s.id} took ${Date.now() - nt} ms`)
      if (!need) continue
      if ((G.cool[s.id] || 0) > t) continue
      // committed to a step that the picker keeps leaving for this one (A,B,A,B): let it finish before this one comes back
      if (G.commit.skips(s.id, (id) => { const b = steps.find(x => x.id === id); return b && (G.cool[id] || 0) <= t && !((night || dawn) && G.role !== 'assistant' && (NIGHT_SKIP.has(id) || DAWN_SKIP.has(id))) && b.need() })) continue
      return s
    }
    return null
  }

  G.step = async () => {
    const s = G.pick()
    if (!s) {
      // idle: in the dark, wandering is how it drowned and got shot (PATTERNS). At night stay at home; by day explore on the surface only.
      if (S.isNight() && st.home) {
        G.lastStep = 'home'
        const h = v(st.home[0], st.home[1], st.home[2])
        // out of the mine by its own stairs first: straight for home from y38 the escalating walk went under the sea at y48 (11:23-11:39,
        // 16 minutes, the same place it drowned at 06:55)
        if (S.dist(h) > 4 && G.role !== 'assistant' && bot.entity.position.y < h.y - 6 && !S.skyVisible() && M.goSurface) { const up = await M.goSurface(); note('nothing to do at night: up from the mine first (' + up + ')') }
        if (S.dist(h) > 4) { note('nothing to do at night: going home'); await S.goto(new goals.GoalNear(h.x, h.y, h.z, 2), { dig: false, ms: 60000 }) }
        await S.wait(5000)
        return
      }
      // down in its own mine with the iron step only cooling down: wait there, not walk the 100 blocks home to light ground and back
      // (09:11, after a tunnel at y21 under 213,-388)
      { const ir = steps.find(x => x.id === 'iron')
        if (ir && G.role !== 'assistant' && st.mine && bot.entity.position.y < 56) { let ok = false; try { ok = !!ir.need() } catch {} if (ok) { G.lastStep = 'iron'; await S.wait(5000); return } } }
      // idle by day: extend the lit area around home (dark ground is where the creepers and skeletons come from) before wandering off
      const lh = steps.find(x => x.id === 'light-home')
      if (lh && G.role !== 'assistant' && st.home && S.count('torch') >= 8 && Date.now() - (G.idleLightAt || 0) > 60000) { G.idleLightAt = Date.now(); G.lastStep = 'light-home'; note('nothing to do: lighting more ground around home'); st.lightAt = 0; S.stepDeadline = Date.now() + 150000; try { await lh.run() } catch (e) { if (S.isAbort(e)) throw e } finally { S.stepDeadline = 0 } return }
      // random exploring kept walking it into the sea (drowned, 06:34) and caves: with a home, idle time is spent there, not wandering
      if (st.home) { G.lastStep = 'home'; const h = v(st.home[0], st.home[1], st.home[2]); if (S.dist(h) > 6) { note('nothing to do: back home'); if (G.enterShelter && st.shelterDoor && G.role !== 'assistant') await G.enterShelter(); else await S.goto(new goals.GoalNear(h.x, h.y, h.z, 3), { dig: false, ms: 60000 }) } await S.wait(4000); return }
      if (G.role === 'assistant') { G.lastStep = 'home'; await S.wait(5000); return }
      note('nothing to do: exploring')
      G.lastStep = 'explore'
      await explore()
      if (!S.skyVisible()) { const up = await (M.goSurface ? M.goSurface() : M.surface()); note('explore ended underground: surfaced ' + up) }
      return
    }
    G.lastStep = s.id
    { const cm = G.commit.note(s.id); if (cm) note(`commitment: ${cm.over} and ${s.id} keep re-arming each other; staying with ${s.id} until it is done (at most ${Math.round((cm.until - cm.since) / 60000)} min)`) }
    S.progress(s.id)
    note(`step ${s.id}`)
    let r
    // loop detector (general, any step): the same step picked 4 times in a row while the bag did not change = no progress; park that step for 15 min
    const sig = S.items().map(i => i.name + i.count).sort().join(',')
    G.picks = (G.picks || []).concat([{ id: s.id, sig }]).slice(-4)
    // (steps whose work does not show in the bag are exempt: the mob farm's kills go into the farm's own chest; it was parked 15 min
    // with mobs dropping, 08:09)
    const NOBAG = new Set(['mob-farm', 'shelter', 'light-home', 'night-home', 'take-cover'])
    if (!NOBAG.has(s.id) && G.picks.length === 4 && G.picks.every(p => p.id === s.id && p.sig === sig)) {
      G.cool[s.id] = Date.now() + 15 * 60000; G.picks = []
      note(`loop: ${s.id} ran 4 times with no change in the bag, parked for 15 min`)
      return
    }
    // provisional cooldown: a step that gets aborted halfway (preempted, watchdog kick, restart) must not be re-picked at once, or it loops forever
    if (s.cool) G.cool[s.id] = Date.now() + Math.min(180000, s.cool)
    S.stepDeadline = Date.now() + (s.budget || 240000)
    // surface work picked while the bot is down the mine: walk up the shaft first (a harvest picked at y20 tried to dig straight up to the
    // field and was aborted every time; 34 ripe wheat went uncut)
    if (SURFACE.has(s.id) && st.home && bot.entity.position.y < st.home[1] - 10 && !S.skyVisible()) {
      const up = await (M.goSurface ? M.goSurface() : M.surface()); note(`${s.id}: up from the mine first (${typeof up === 'string' ? up : JSON.stringify(up)})`)
    }
    try { r = await s.run() } catch (e) {
      if (e && e.name === 'StepTimeout') { note(`${s.id}: time budget used up, moving on`); r = false }
      else if (S.isAbort(e)) throw e
      else { log('GOAL_ERR', `${s.id}: ${e.stack || e.message}`); r = false }
    } finally { S.stepDeadline = 0 }
    if (r === 'explore') { note(`${s.id}: nothing in sight, exploring`); await explore(); r = true; G.cool[s.id] = Date.now() + 2000 }
    else if (!r) { G.failedCount = (G.failedCount || 0) + 1; G.fails[s.id] = (G.fails[s.id] || 0) + 1; G.cool[s.id] = Date.now() + Math.min(300000, (s.cool || 15000) * G.fails[s.id]); note(`${s.id} failed x${G.fails[s.id]}`) }
    else { G.done = (G.done || 0) + 1; G.fails[s.id] = 0; if (s.cool) G.cool[s.id] = Date.now() + 1000 }
    G.save()
  }

  const onDeath = () => { const p = bot.entity.position; st.death = { x: Math.floor(p.x), y: Math.floor(p.y), z: Math.floor(p.z), t: Date.now(), done: false }; G.save(); note('DIED') }
  bot.on('death', onDeath)
  G.dispose = () => { bot.removeListener('death', onDeath) }

  return G
}
