// brain/autopilot/schematicbuild.js: builds what a schematic says, and lets the WORLD say when it is done.
//
// Walter 2026-11-11: following a schematic should be part of the recursive loop when appropriate ("it's really only needed seldom, like when the decision has been
// made to build a mob farm"), because it makes checking a build "much easier and more reliable". The gate for "appropriate" is brain/schematic/loop.js; the diff, the
// work list, its safe order and how each block is put down are brain/schematic/follow.js (pure, tested); the job and its state are bot._schematic (brain/schematic).
// This file is only the hands:
//
//   pass:  progress(world vs schematic) -> work list -> order (digs outward from open space, placements bottom up against something that stands, torches, water last)
//          -> do the steps one at a time, re-reading the cell before each (a cell that is already right is skipped) -> verify (the world is read again, the percent changes)
//   run:   passes until the build is complete, the budget is spent, or a pass changes nothing (those cells are marked stuck after three tries and reported, never retried forever)
//
// Survival-legit: every block is dug by hand in view (the same `mine` as the mob farm builder: stands only in open cells, breaks only the wanted block), every block is placed
// against a block that stands, from a spot with a line of sight. Never lava (a lava cell in a design is "forbidden": a person has to do it), never a no-dig area, never a block
// somebody else built (the ledger says who made it). Water goes in with a bucket the bot already holds.
//
// Think-brain: the skill `follow_schematic` (think.js). Fallback routine step: `schematic-build`. It also DECIDES a mob farm: when the farm's preconditions hold
// (storage room first, no farm yet, the shaft is deep enough) and the catalog has a farm schematic that fits near the shaft, it starts the job; when nothing fits the old
// geometry builder (mobfarmbuild.js) carries on as before.
const fs = require('fs')
const path = require('path')
const FO = require('../schematic/follow')
const B = require('../schematic/blocks')
const grid = require('../inspect/grid')
const scope = require('../ledger/scope')

const INTERACTIVE = /(chest|barrel|hopper|furnace|smoker|crafting_table|dropper|dispenser|trapdoor|_door|button|lever|bed|anvil|enchanting_table|brewing_stand|shulker_box|note_block|gate)$/
const MAX_TRIES = 3

module.exports = function schematicbuild(G, S, M, api, log) {
  const bot = S.bot, { goals } = S, v = S.v, st = G.state
  const SC = () => bot._schematic
  const note = (m) => { try { G.note(m) } catch { log('SCHEMBUILD', m) } }
  const sleep = (ms) => S.wait(ms)
  const here = () => S.flo(bot.entity.position)
  const cellV = (c) => v(c[0], c[1], c[2])
  const S0 = () => (st.schematicBuild = st.schematicBuild || { tries: {}, stuck: {} })
  const get = () => { const at = grid.liveBlockAt(bot); return (x, y, z) => { const b = at(x, y, z); return b ? { name: b.name, props: b.props || {} } : null } }
  const have = () => { const m = {}; for (const i of S.items()) m[i.name] = (m[i.name] || 0) + i.count; return m }
  let lastWhy = ''
  const why = (m) => { lastWhy = m; return false }

  // ------------------------------------------------------------------ reaching and seeing
  // the reach is measured to the face that is clicked (a pit one block wide and two deep is reached from the top: the block's centre is 4.6 away, its top face 3.6)
  const faceTo = (ref, face) => S.eye().distanceTo(cellV(ref).offset(0.5 + (face ? face[0] * 0.5 : 0), 0.5 + (face ? face[1] * 0.5 : 0), 0.5 + (face ? face[2] * 0.5 : 0)))
  const inCell = (c) => { const p = bot.entity.position, x = Math.floor(p.x), z = Math.floor(p.z), y = Math.floor(p.y); return x === c[0] && z === c[2] && (y === c[1] || y + 1 === c[1]) }
  async function walkTo(c, ms = 20000) {
    if (here().equals(cellV(c))) return true
    if ((await S.goto(new goals.GoalBlock(c[0], c[1], c[2]), { dig: false, ms, escalate: false })).ok) return true
    return S.dist(cellV(c).offset(0.5, 0, 0.5)) < 1.2
  }
  // a spot from which `ref` (a cell holding a block) is in reach and in view, and the bot is not inside `cell` (a block cannot be placed where the player stands)
  async function reachSee(cell, ref, face, standHint) {
    const refB = S.block(cellV(ref)); if (!refB) return false
    const ok = () => faceTo(ref, face) <= 4.3 && S.canSee(refB) && !inCell(cell)
    if (standHint) { const sb = S.block(cellV(standHint)), hb = S.block(cellV([standHint[0], standHint[1] + 1, standHint[2]])); if (sb && hb && sb.boundingBox === 'empty' && hb.boundingBox === 'empty') { await walkTo(standHint, 15000); if (ok()) return true } }
    if (ok()) return true
    const los = require('../los')
    for (const f of los.viewpoints(bot, cellV(ref), { reach: 4.9, max: 10 })) {
      if (f.x === cell[0] && f.z === cell[2] && (f.y === cell[1] || f.y + 1 === cell[1])) continue
      const r = await S.goto(new goals.GoalBlock(f.x, f.y, f.z), { dig: false, ms: 15000, escalate: false })
      if ((r.ok || S.dist(f.offset(0.5, 0, 0.5)) < 1.2) && ok()) return true
    }
    return ok()
  }
  async function approachSite(job) {
    const s = SC().load(job.id); if (!s) return false
    const c = [job.at[0] + Math.floor(s.size[0] / 2), job.at[1] + Math.floor(s.size[1] / 2), job.at[2] + Math.floor(s.size[2] / 2)]
    const r = await S.goto(new goals.GoalNear(c[0], c[1], c[2], 8), { dig: false, ms: 90000, escalate: true })
    return !!r.ok
  }

  // ------------------------------------------------------------------ the steps
  const mine = (c) => (G.mobFarmBuild && G.mobFarmBuild.mine ? G.mobFarmBuild.mine(c) : Promise.resolve('fail'))
  const keyOf = (s) => s.x + ',' + s.y + ',' + s.z
  const markTry = (s, why2) => { const k = keyOf(s), t = S0().tries; t[k] = (t[k] || 0) + 1; if (t[k] >= MAX_TRIES) { S0().stuck[k] = why2 || 'did not work 3 times'; return true } return false }
  const stuckNow = (s) => !!S0().stuck[keyOf(s)]

  async function digStep(s, out) {
    const now = bot.blockAt(cellV([s.x, s.y, s.z]), false)
    if (!now) return
    if (!SC().diggable(s.x, s.y, s.z, { name: now.name })) { S0().stuck[keyOf(s)] = 'not ours to dig (a no-dig area, or a block someone else made)'; out.skipped++; return }
    if (B.isLava(now.name) || B.isWater(now.name)) { S0().stuck[keyOf(s)] = 'liquid in the cell'; out.skipped++; return }
    const r = await mine([s.x, s.y, s.z])
    if (r === 'ok') { out.dug++; return }
    if (r === 'nopick' || r === 'bagfull') { out.stop = r === 'nopick' ? 'no pickaxe left and cannot make one' : 'the bag is full'; return }
    if (r === 'lava' || r === 'water' || r === 'nodig') { S0().stuck[keyOf(s)] = r === 'nodig' ? 'no-dig area' : r + ' next to the cell'; out.skipped++; return }
    if (markTry(s, 'cannot dig it from any spot with a view')) out.skipped++
  }

  async function placeStep(s, out) {
    const cur = get()(s.x, s.y, s.z)
    if (cur && FO.classify(s.entry, cur) === 'ok') return
    const refB = S.block(cellV(s.ref)); if (!refB || /^(air|cave_air|void_air|water|lava)$/.test(refB.name)) { out.deferred++; return }
    const bag = have()
    let item = s.item
    if (!bag[item]) {
      // any solid filler will do for a plain wall, and an alternative the schematic allows
      const alts = s.entry.role === 'solid' ? FO.FILLER : (s.entry.alt || [])
      item = alts.find(n => bag[n] > 0) || null
      if (!item) { out.missing[s.item] = (out.missing[s.item] || 0) + 1; return }
    }
    // standing in the cell itself is the common reason a placement does nothing: reachSee never picks such a spot
    if (!(await reachSee([s.x, s.y, s.z], s.ref, s.face, s.stand))) { if (markTry(s, 'no spot with a view of ' + s.ref.join(','))) out.skipped++; return }
    const sneak = INTERACTIVE.test(refB.name)
    if (sneak) bot.setControlState('sneak', true)
    let placed = false
    try { placed = await S.placeAgainst(S.block(cellV(s.ref)), cellV(s.face), item, { half: s.half }) } finally { if (sneak) bot.setControlState('sneak', false) }
    await sleep(180)
    let after = get()(s.x, s.y, s.z)
    // a trapdoor drawn open: use it once if it came out shut
    if (placed && s.after === 'open' && after && /_trapdoor$/.test(after.name) && String(after.props.open) !== 'true') {
      try { const b = bot.blockAt(cellV([s.x, s.y, s.z]), false); await bot.activateBlock(b); await sleep(250) } catch { /* the diff will say */ }
      after = get()(s.x, s.y, s.z)
    }
    if (after && FO.classify(s.entry, after) === 'ok') { out.placed++; return }
    if (placed && after && /_trapdoor$/.test(after.name) && FO.classify(s.entry, after) === 'toggle') { out.placed++; return }     // the toggle step finishes it
    // the wrong block came out (a block that faces the wrong way, a slab on the wrong half): take it out so the next pass places it again, unless it is the last try
    if (placed && after && !/^(air|cave_air|water|lava)$/.test(after.name) && FO.classify(s.entry, after) !== 'ok' && (S0().tries[keyOf(s)] || 0) < MAX_TRIES - 1) {
      const wb = bot.blockAt(cellV([s.x, s.y, s.z]), false); try { await S.digBlock(wb, { force: true }) } catch { /* next pass */ }
    }
    if (markTry(s, `placing ${item} against ${s.ref.join(',')} did not give ${B.label(s.entry)} (got ${after ? B.strip(after.name) : '?'})`)) out.skipped++
  }

  async function fluidStep(s, out) {
    const cur = get()(s.x, s.y, s.z)
    if (cur && FO.classify(s.entry, cur) === 'ok') return
    if (!S.items().some(i => i.name === 'water_bucket')) {
      // an empty bucket and a water source nearby that is not part of the design: scoop it
      const wb = S.items().find(i => i.name === 'bucket'); const src = wb && bot.findBlock({ matching: (b) => b && b.name === 'water' && (b.metadata === 0 || (b.getProperties && Number(b.getProperties().level) === 0)), maxDistance: 5 })
      if (!wb || !src) { out.missing.water_bucket = 1; return }
      await bot.equip(wb, 'hand').catch(() => {}); await bot.lookAt(src.position.offset(0.5, 0.5, 0.5), true); bot.activateItem(); await sleep(700)
      if (!S.items().some(i => i.name === 'water_bucket')) { out.missing.water_bucket = 1; return }
    }
    if (!(await reachSee([s.x, s.y, s.z], s.ref, s.face, null))) { if (markTry(s, 'no spot with a view of the water spot')) out.skipped++; return }
    const wbk = S.items().find(i => i.name === 'water_bucket'); await bot.equip(wbk, 'hand').catch(() => {})
    for (let t = 0; t < 3; t++) {
      // the bucket is "use item": the server ray-casts from the eye, so look at the face of the reference block the water goes against
      await bot.lookAt(cellV(s.ref).offset(0.5 + s.face[0] * 0.5, 0.5 + s.face[1] * 0.5 + (s.face[1] === 0 ? 0 : 0), 0.5 + s.face[2] * 0.5), true); await sleep(150)
      bot.activateItem(); await sleep(900)
      const w0 = get()(s.x, s.y, s.z); if (w0 && B.isWater(w0.name)) { out.placed++; return }
    }
    if (markTry(s, 'the bucket did not put water at the spot')) out.skipped++
  }

  async function toggleStep(s, out) {
    const b = bot.blockAt(cellV([s.x, s.y, s.z]), false); if (!b || !/_trapdoor$/.test(b.name)) return
    if (!(await reachSee([s.x, s.y, s.z], [s.x, s.y, s.z], [0, 1, 0], null))) { if (markTry(s, 'no spot to reach the trapdoor')) out.skipped++; return }
    try { await bot.activateBlock(b); await sleep(250) } catch { if (markTry(s, 'cannot use the trapdoor')) out.skipped++; return }
    out.placed++
  }

  // a tunnel, two cells high so the bot can stand in it, from the open cell nearest to a dig that no open cell reaches (the shaft is rarely next to the build).
  // The cells it opens inside the build's shell are placement work like any other wrong cell: the last thing the build does is plug them from outside.
  async function accessTo(orphans, starts, out) {
    const g = get()
    const open = (c) => { const b = g(c[0], c[1], c[2]); return !!b && B.isOpenish(b.name) && !B.isSolid(b.name) }
    let best = null
    for (const o of orphans) for (const s0 of starts) { const d = Math.abs(s0[0] - o.x) + Math.abs(s0[1] - o.y) + Math.abs(s0[2] - o.z); if (!best || d < best.d) best = { s0, o, d } }
    if (!best || best.d > 24) return false
    const target = best.o
    let [x, y, z] = best.s0; const cells = []
    while (x !== target.x || z !== target.z || y !== target.y) {
      const horizontal = x !== target.x || z !== target.z
      if (x !== target.x) x += Math.sign(target.x - x); else if (z !== target.z) z += Math.sign(target.z - z); else y += Math.sign(target.y - y)
      cells.push([x, y, z]); if (horizontal) cells.push([x, y + 1, z])        // feet and head of the cell the bot will stand in
      if (cells.length > 60) return false
    }
    for (const c of cells) {
      if (open(c)) continue
      if (!SC().diggable(c[0], c[1], c[2], g(c[0], c[1], c[2]))) return false
      const r = await mine(c); if (r !== 'ok') { lastWhy = 'access tunnel stopped at ' + c.join(',') + ': ' + r; return false }
      out.dug++; out.access++
    }
    return true
  }

  // ------------------------------------------------------------------ one pass and the loop
  async function pass(job, deadline) {
    const out = { dug: 0, placed: 0, skipped: 0, deferred: 0, access: 0, missing: {}, stop: null }
    let r = SC().progress(job.id, job.at, { max: 8000, attribute: false })
    if (!r.ok) {
      if (/not loaded/.test(r.why || '')) { await approachSite(job); r = SC().progress(job.id, job.at, { max: 8000, attribute: false }) }
      if (!r.ok) { out.stop = r.why; return out }
    }
    if (r.complete) { out.complete = true; return out }
    out.pct0 = r.pct
    const starts = [[here().x, here().y, here().z], [here().x, here().y + 1, here().z]]
    const shaftCells = []; try { for (const sh of (M.LD ? M.LD.shafts() : [])) if (sh.bottom && Math.hypot(sh.entry[0] - bot.entity.position.x, sh.entry[2] - bot.entity.position.z) < 40) for (let y = sh.bottom[1]; y <= sh.entry[1]; y++) shaftCells.push([sh.entry[0], y, sh.entry[2]]) } catch { /* no registry */ }
    const o = FO.order(r.work.filter(w => !stuckNow(w)), get(), { starts: [...starts, ...shaftCells], have: have() })
    if (o.orphans.length && !o.steps.some(x => x.phase === 'dig')) { if (!(await accessTo(o.orphans, [...starts, ...shaftCells], out))) note('schematic ' + job.id + ': no way in to the digs (' + o.orphans.length + ' unreachable): ' + lastWhy) }
    if (out.access) return out                                    // re-plan with the new tunnel
    for (const step of o.steps) {
      if (Date.now() > deadline || out.stop) break
      S.check()
      if (bot.health < 10 || S.hostilesNear(8).length) { out.stop = bot.health < 10 ? 'hurt' : 'a hostile mob is near'; break }
      if (bot._meleeClose && Date.now() - (bot._meleeCloseAt || 0) < 2000) { out.stop = 'fighting'; break }
      if (stuckNow(step)) continue
      try {
        if (step.phase === 'dig') await digStep(step, out)
        else if (step.phase === 'place') await placeStep(step, out)
        else if (step.phase === 'fluid') await fluidStep(step, out)
        else if (step.phase === 'toggle') await toggleStep(step, out)
      } catch (e) { if (S.isAbort(e) || e.name === 'StepTimeout') throw e; log('SCHEMBUILD', e.stack || e.message); out.stop = 'error ' + e.message; break }
    }
    out.unsupported = o.unsupported.length
    return out
  }

  // a sentence for the planner and the log
  const say = (o) => `dug ${o.dug}, placed ${o.placed}${o.access ? ', ' + o.access + ' access tunnel' : ''}${o.skipped ? ', ' + o.skipped + ' marked stuck' : ''}${o.deferred ? ', ' + o.deferred + ' waiting for support' : ''}${Object.keys(o.missing).length ? '; the bag lacks ' + Object.entries(o.missing).map(([k, n]) => n + ' ' + k).join(', ') : ''}${o.stop ? '; stopped: ' + o.stop : ''}`

  // What the design needs and the bag lacks gets crafted from what the bag holds (chests, hoppers, ladders, slabs, a bucket); cobblestone and stone come from the
  // digging itself. The first live pass (2026-11-11) ended with "the bag lacks 2 chest, 4 hopper, 3 ladder, 2 cobblestone_slab, 1 water_bucket, ..." and nothing
  // made any of it, so nothing could be placed. Returns how many kinds were crafted.
  async function craftMissing(missing) {
    let made = 0
    const order = ['chest', 'hopper', 'ladder', 'cobblestone_slab', 'stone_slab', 'bucket']
    for (const name of Object.keys(missing || {}).sort((a, b) => (order.indexOf(a) < 0 ? 99 : order.indexOf(a)) - (order.indexOf(b) < 0 ? 99 : order.indexOf(b)))) {
      if (name === 'water_bucket' || /^(stone|cobblestone|cobbled_deepslate|dirt)$/.test(name)) continue
      const target = S.count(name) + missing[name]
      let ok = false
      try { ok = await S.craft(name, target) } catch (e) { if (S.isAbort(e) || e.name === 'StepTimeout') throw e }
      if (ok) made++
      else note(`schematic: could not craft ${missing[name]} ${name} (wood or iron short)`)
    }
    if (missing && missing.water_bucket && !S.items().some(i => i.name === 'bucket' || i.name === 'water_bucket')) {
      try { if (await S.craft('bucket', 1)) made++ } catch (e) { if (S.isAbort(e) || e.name === 'StepTimeout') throw e }
    }
    return made
  }

  async function run(budgetMs = 20 * 60000) {
    if (!SC()) return why('schematic module not loaded')
    let job = SC().job(); if (!job || job.state === 'complete' || job.state === 'abandoned') return why('no schematic job to work on')
    const t0 = Date.now(), deadline = t0 + budgetMs
    let any = false, idle = 0
    await scope.within({ id: job.room, kind: 'room', label: 'Schematic ' + job.id }, async () => {
      for (let i = 0; i < 12 && Date.now() < deadline; i++) {
        const o = await pass(job, deadline)
        if (o.complete) { SC().verify(); note(`schematic ${job.id}: complete`); any = true; break }
        const v1 = SC().verify(); const worked = o.dug + o.placed + o.access > 0
        any = any || worked
        note(`schematic ${job.id}: ${v1 && v1.pct != null ? v1.pct + '%' : '?'} (${say(o)})`)
        if (!worked && !o.stop && o.missing && Object.keys(o.missing).length && !o._crafted) {
          const m = await craftMissing(o.missing)
          if (m) { idle = 0; continue }                                // something was made: pass again
        }
        if (o.stop || !worked) { if (!worked) idle++; if (o.stop || idle >= 2) { lastWhy = o.stop || 'a pass changed nothing'; break } }
        else idle = 0
        job = SC().job() || job
        if (job.state === 'complete') break
      }
    })
    SC().noteWork(Date.now() - t0)
    const j = SC().job()
    if (j && j.state === 'complete') { try { await goRest() } catch { /* the mob farm routine moves it */ } }
    return any
  }
  // a finished farm stops spawning when the bot stands within 24 blocks of its pads: leave the build
  async function goRest() {
    const j = SC().job(); if (!j || j.kind !== 'mobfarm') return
    const s = SC().load(j.id); if (!s) return
    const c = [j.at[0] + s.size[0] / 2, j.at[2] + s.size[2] / 2]
    if (Math.hypot(bot.entity.position.x - c[0], bot.entity.position.z - c[1]) > 40) return
    const home = st.home; if (Array.isArray(home)) await S.goto(new goals.GoalNear(home[0], home[1], home[2], 4), { dig: false, ms: 60000, escalate: true })
  }

  // ------------------------------------------------------------------ deciding to follow one (the mob farm)
  const CLAIM = process.env.BOT_SCHEMATIC_CLAIM || path.join(__dirname, '..', '..', '..', 'bot-shared', 'schematic-claim.json')
  const claimedByOther = () => { try { const c = JSON.parse(fs.readFileSync(CLAIM, 'utf8')); return c.by !== bot.username && Date.now() - c.at < 6 * 3600000 } catch { return false } }
  const claim = () => { try { fs.writeFileSync(CLAIM, JSON.stringify({ by: bot.username, at: Date.now(), job: (SC().job() || {}).id || null })) } catch { /* ignore */ } }
  // kinds the loop decides on its own: the preconditions are the old builder's (one farm per world, the storage room first, a laddered shaft)
  function decideMobFarm() {
    if (!SC() || SC().job()) return null
    if (S.isNight() && !S.underground()) return null
    try { if ((M.LD.rooms() || []).some(r => r.type === 'mobfarm')) return null } catch { return null }
    if (!st.mine || !st.mine.ladder) return null
    const mb = st.mobFarmBuild; if (mb && mb.phase && mb.phase !== 'done') return null          // the geometry builder is part way through a farm: let it finish
    const sh = (M.LD.shafts() || []).find(s => s.id === st.mine.shaft) || null; if (!sh || !sh.bottom) return null
    if (!(M.LD.rooms() || []).some(r => r.type === 'storage' && r.shaft === sh.id)) return null
    if (Date.now() < (S0().decideRestUntil || 0)) return null
    if (claimedByOther()) return null
    // the catalog is read at most every five minutes: this runs each time the step picker asks, and the library holds megabytes
    if (!decideMobFarm.cache || Date.now() - decideMobFarm.cache.at > 300000) decideMobFarm.cache = { at: Date.now(), pick: require('../schematic/loop').choose({ kind: 'mobfarm', dirs: SC().dirs() }) }
    const pick = decideMobFarm.cache.pick
    if (!pick.ok) return null
    return { sh, pick }
  }
  async function decide() {
    const d = decideMobFarm(); if (!d) return false
    claim()
    // go to the shaft's bottom end: the farm is sited from where the bot can read the rock (the chunks must be loaded)
    const sh = d.sh, near = [sh.entry[0], Math.max(sh.bottom[1] + 8, sh.entry[1] - 24), sh.entry[2]]
    const r = SC().startJob({ kind: 'mobfarm', near, radius: 18, dy: [-12, 6], reason: 'the decision to build a mob farm was made (storage room done, no farm yet): follow ' + d.pick.schematic.id })
    if (!r.ok) { S0().decideRestUntil = Date.now() + 30 * 60000; S0().lastWhy = r.why; G.save(); note('schematic: not following a farm schematic: ' + r.why); return false }
    st.schematicBuild = { tries: {}, stuck: {} }
    note(`schematic: following ${r.job.id} at ${r.job.at.join(',')}`); G.save()
    return true
  }

  const step = {
    id: 'schematic-build', budget: 1500000, cool: 120000,
    need: () => {
      if (!SC()) return false
      const j = SC().job()
      if (!j) return !!decideMobFarm()
      if (j.state === 'complete' || j.state === 'abandoned') return false
      if (j.state === 'stuck' && Date.now() - (j.lastVerifyAt || 0) < 30 * 60000) return false
      if (S.isNight() && !S.underground()) return false
      if (bot.health < 14 || bot.isSleeping) return false
      if (j.by && j.by !== bot.username && claimedByOther()) return false
      return Date.now() >= (S0().restUntil || 0)
    },
    run: async () => {
      if (!SC().job()) { if (!(await decide())) return false }
      claim()
      const ok = await run()
      const j = SC().job()
      S0().restUntil = Date.now() + (ok ? 60000 : 10 * 60000); G.save()
      if (j && j.state === 'stuck') { S0().restUntil = Date.now() + 30 * 60000; note(`schematic ${j.id} is stuck at ${j.pct}%: ${(j.lastWrong || []).slice(0, 2).join(' | ')}`) }
      return ok
    },
  }

  function status() {
    const j = SC() && SC().job()
    return { job: j ? { id: j.id, state: j.state, pct: j.pct, off: j.off, at: j.at, counts: j.counts, lastWrong: (j.lastWrong || []).slice(0, 4), foreign: j.attribution ? j.attribution.other + j.attribution.changed : null, workedMin: Math.round((j.workedMs || 0) / 60000) } : null,
      stuckCells: Object.keys(S0().stuck).length, why: lastWhy || S0().lastWhy || '' }
  }
  G.schematicBuild = { run, pass, status, decide, step }
  return step
}
