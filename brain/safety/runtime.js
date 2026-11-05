// Mob safety + combat runtime: watches the entity list, tells Walter, retreats / fights / shoots / eats, and holds the other tasks
// (via the scheduler's non-preemptible SAFETY task) while the bot is in danger or recovering.
//
// Hard rules kept here (Walter's):
//  - never moves with a lava bucket selected (ensureHandSafe before every goal; eating/fighting swap the hand away from it too)
//  - never digs, places or activates blocks: this file only sets pathfinder goals, equips, eats, attacks, shoots and looks
//  - default mode is "fight" (Walter asked for automatic fighting); "do not fight" switches to "warn" (retreat + tell Walter)
//  - creepers: never meleed except as a hit-and-retreat strike, shot from range when there is a bow, fled from when the fuse starts
//  - chat only through say(), rate limited, slash-free
const fs = require('fs')
const { PROFILES } = require('./profiles')
const { assess, Tracker, DEFAULTS, d3 } = require('./assess')
const { HEALTH_DEFAULTS, nextRecovering, shouldEat, chooseFood } = require('./health')
const { PathReach, entityVisible, findVisibleSpot } = require('./reach')
const { FuseTracker } = require('./creeper')
const bow = require('./bow')
const gear = require('./gear')
const shelterMod = require('./shelter')
const entombMod = require('./entomb')
const { makeDeaths } = require('./deaths')
const { makeLoadout } = require('./loadout')
const { makeLight, LIGHT_DEFAULTS } = require('./light')
const createTorches = require('../lighting/torches')

const RUNTIME_DEFAULTS = {
  scanMs: 300, holdMaxMs: 120000, holdCooldownMs: 120000, eatGapMs: 3000, eatTimeoutMs: 4500, hitWindowMs: 6000, calmMs: 2500,
  defaultMode: 'fight', creeperStrike: true /* back off from a creeper, then hit it: Walter wants fighting, not fleeing (2026-10-26 17:00) */, emergencyEntomb: true /* places/digs blocks; Walter approved it (2026-10-26 15:29), 'do not wall yourself in' turns it off */, shelterCloseMax: 30, maxDropDown: 4, bigFallBlocks: 12, fallEntombHealth: 14, fallWatchMs: 90000, shelterPathMax: 70, entombHoldMs: 150000, entombMinFiller: 14, pathFilter: true, leashRange: 16, chaseRange: 7, rangedChase: 12, armor: true, strikeReach: 3.1
}

module.exports = function install({
  bot, say, goals, scheduler, PRIORITY = { SAFETY: 100, EAT: 70 }, safehand = null, stopNav = () => {}, ownerName = 'OGWO',
  stateFile = null, now = Date.now, log = () => {}, slog = () => {}, config = {}, eatNow = null, canSee = null, waypointsFile = null,
  lessonsFile = null, tuningFile = null, commands = null, reflexes = null
}) {
  const C = { ...DEFAULTS, ...HEALTH_DEFAULTS, ...RUNTIME_DEFAULTS, ...LIGHT_DEFAULTS, ...shelterMod.SHELTER_DEFAULTS, ...config }
  let healthCfg = { ...C, lowHealth: C.minFightHealth }
  let mode = C.defaultMode === 'warn' ? 'warn' : 'fight'
  // The right to swing at mobs is the `melee` lease (brain/reflexes.js). The combat reflex holds it for good; while another reflex holds it this module
  // behaves as in warn mode (retreat, no swings of its own) without touching the saved mode, which used to be overwritten by a fake "do not fight" command.
  const reflex = reflexes ? reflexes.register({ name: 'safety', priority: 60, claims: ['melee'], desc: 'mob safety: retreat, fight back when allowed, wall in' }) : null
  const meleeTakenBy = () => reflexes ? reflexes.heldByOther('melee', 'safety') : null
  const effectiveMode = () => (mode === 'fight' && meleeTakenBy()) ? 'warn' : mode
  const chosen = {}                                        // settings Walter set himself: only these are saved, so a new default is never overridden by an old copy
  try { if (stateFile) { const st = JSON.parse(fs.readFileSync(stateFile, 'utf8')); mode = st.mode || mode; for (const k of ['creeperStrike', 'emergencyEntomb']) if (typeof st[k] === 'boolean' && st[k + 'Chosen'] === true) { C[k] = st[k]; chosen[k] = true } } } catch { /* first run */ }
  if (mode !== 'warn' && mode !== 'fight') mode = 'fight'
  const saveState = () => { if (stateFile) try { fs.writeFileSync(stateFile, JSON.stringify({ mode, ...(chosen.creeperStrike ? { creeperStrike: !!C.creeperStrike, creeperStrikeChosen: true } : {}), ...(chosen.emergencyEntomb ? { emergencyEntomb: !!C.emergencyEntomb, emergencyEntombChosen: true } : {}) })) } catch { /* ignore */ } }
  // what past deaths taught (safety-tuning.json, written by deaths.js): stricter loadout, earlier retreat, fewer archers at once ...
  const deaths = makeDeaths({ bot, now, say, lessonsFile, tuningFile, log: slog })
  function applyTuning() {
    const T = deaths.tuning()
    if (T.noCreeperStrike && !chosen.creeperStrike) C.creeperStrike = false
    if (T.creeperRangePlus) C.creeperRange = 7 + Math.min(4, T.creeperRangePlus)
    if (T.archerHealthPlus) { C.rangedFightHealth = 10 + T.archerHealthPlus; C.nightFightHealth = 14 + T.archerHealthPlus }
    if (T.maxArchers) C.maxArchers = T.maxArchers
    if (T.minFightHealthPlus) { C.minFightHealth = 8 + Math.min(3, T.minFightHealthPlus); healthCfg = { ...C, lowHealth: C.minFightHealth } }
  }
  applyTuning()
  const setMode = (m) => { mode = m === 'fight' ? 'fight' : 'warn'; saveState() }
  const setCreeperStrike = (on) => { C.creeperStrike = !!on; chosen.creeperStrike = true; saveState() }
  const setEmergencyEntomb = (on) => { C.emergencyEntomb = !!on; chosen.emergencyEntomb = true; saveState() }

  const tracker = new Tracker()
  const fuseTracker = new FuseTracker()
  const reach = new PathReach({ bot, goals, now, log: slog, cfg: config.reach || {} })
  let latest = null, hurtBy = null, lastHurtAt = 0, fleeingSince = null, lastWarnAt = 0
  const hits = []                                         // timestamps of recent damage taken from mobs
  const warnedAt = new Map(), giveUp = new Map()          // giveUp: id -> until
  let timer = null, calmSince = now(), recovering = false, announcedLow = false
  let holdStart = 0, holdCooldownUntil = 0, eating = false, lastEatAt = 0, noFoodSaid = false, lastMobs = []
  // creeper hit-and-retreat state
  const cs = { phase: 'idle', hitAt: 0, cycles: 0, lastSeen: 0 }
  let primed = null                                       // { at, pos } last creeper hiss we heard
  let swellIdx = null, ignitedIdx = null
  const lastLog = new Map()
  const torches = createTorches({ bot, canSee: canSee ? (b) => canSee(b) : null, log: slog, now })
  const light = makeLight({ bot, torches, log: slog, now, cfg: config })
  const loadout = makeLoadout({ bot, commands, log: slog, tuning: () => deaths.tuning() })
  const entomber = entombMod.makeEntomb({ bot, log: slog, canSee })
  const ySamples = []                                  // recent heights, to notice a big fall
  let roofTried = false, entombBusy = false, entombed = false, wantEntomb = false, entombFailedAt = 0, entombCalmAt = 0, shelterPathCache = new Map()
  let envAt = 0, env = { night: false, outdoors: false, narrow: false, shelter: null }, shelterListAt = 0, shelterList = [], firstScan = true
  // Nearest shelter that a walking path actually leads to (post-mortem 05:06: "retreating to mine storage (89 blocks)" then "can't find a safe path").
  // Candidates by straight-line distance; the first with a path of <= shelterPathMax nodes wins. A search that times out only counts for a shelter < 25 blocks away.
  function reachableShelter(p, t) {
    const cands = shelterList.map(s => ({ s, d: Math.hypot(s.pos.x + 0.5 - p.x, s.pos.z + 0.5 - p.z) + Math.abs(s.pos.y - p.y) * 0.5 })).filter(c => c.d <= C.shelterMax).sort((a, b) => a.d - b.d).slice(0, 3)
    for (const { s, d } of cands) {
      const key = s.name + '@' + s.pos.x + ',' + s.pos.y + ',' + s.pos.z
      let c = shelterPathCache.get(key)
      if (!c || t - c.at > 15000 || Math.hypot(c.from.x - p.x, c.from.z - p.z) > 12) {
        const r = C.pathFilter ? reach.pathTo(s.pos, { maxLen: C.shelterPathMax }) : { ok: true, status: 'skipped', len: 0 }
        c = { at: t, from: { x: p.x, z: p.z }, ok: r.ok || (r.status === 'timeout' && d < 25), status: r.status, len: r.len }
        shelterPathCache.set(key, c)
        if (!c.ok) slogOnce('shelter-nopath:' + key, `shelter ${s.name} (${d.toFixed(0)} blocks) skipped: no walking path (${r.status}, ${r.len} nodes)`, 30000)
      }
      if (c.ok) return { name: s.name, pos: s.pos, dist: d }
    }
    return null
  }
  // night / open sky / nearest shelter, refreshed every 2 s (the sky scan is ~50 block lookups)
  function environment(t) {
    if (t - envAt < 2000) return env
    envAt = t
    const p = bot.entity.position
    if (t - shelterListAt > 30000) { shelterListAt = t; shelterList = shelterMod.listShelters(bot, waypointsFile ? shelterMod.readWaypoints(waypointsFile) : {}, C) }
    let outdoors = false
    try { outdoors = shelterMod.skyExposed(bot, p, C.skyScan) } catch { /* unloaded chunk: assume covered */ }
    let narrow = false
    try { narrow = shelterMod.dropExposure(bot, p).narrow } catch { /* unloaded chunk */ }
    env = { night: shelterMod.isNight(bot), outdoors, narrow, shelter: reachableShelter(p, t) }
    return env
  }
  const prevPos = new Map(), vels = new Map()          // id -> last seen position / velocity (blocks per second)

  const ownerEntity = () => bot.players && bot.players[ownerName] && bot.players[ownerName].entity
  const weapon = () => gear.bestWeapon(bot.inventory.items())
  const bowItem = () => bow.bowItem(bot.inventory.items())
  const holdingLava = () => !!bot.heldItem && bot.heldItem.name === 'lava_bucket'
  const slogOnce = (key, msg, gap = 5000) => { const t = now(); if (t - (lastLog.get(key) || 0) >= gap) { lastLog.set(key, t); slog(msg) } }

  // ---- rule 1: never move holding lava ----
  async function ensureHandSafe() {
    if (safehand) return safehand.ensureSafeForMove()
    if (!holdingLava()) return true
    const inv = bot.inventory.items().filter(i => !/(^|_)(bucket|lava|tnt|potion|spawn_egg)$/.test(i.name))
    const it = weapon() || inv[0]
    if (it) await bot.equip(it, 'hand'); else await bot.unequip('hand')
    if (holdingLava()) throw new Error('refusing to move while holding a lava bucket')
    return true
  }
  async function moveTo(goal, dynamic) {
    try { await ensureHandSafe() } catch (e) { speak('lava-hand', 'I cannot move safely: lava bucket in hand and nothing else to hold.', 60000, true); return false }
    bot.pathfinder.setGoal(goal, dynamic)
    return true
  }
  const stopMoving = () => { try { bot.pathfinder.setGoal(null); bot.clearControlStates() } catch { /* ignore */ } }

  // ---- survival-legit rule: every hit and shot needs a clear line from the eye to the target ----
  async function sees(e) {
    let ok = entityVisible(bot, e)
    if (ok && canSee) { try { ok = !!(await canSee(e)) } catch { /* shared helper failed: our own check already passed */ } }
    return ok
  }
  // Blocked while in reach: walk to a standable spot with a clear line (no digging/placing), else hold and let it come round; give up after 4 s.
  async function whenBlocked(L, e, dist) {
    const t = now()
    if (!L.blockedAt) { L.blockedAt = t; slogOnce('los:' + e.id, `no clear line to ${e.name}#${e.id} at ${dist.toFixed(1)} blocks: repositioning`, 3000) }
    if (t - L.blockedAt > 4000) { giveUp.set(e.id, t + 10000); slog(`no clear line to ${e.name}#${e.id} for 4 s: ignoring it for 10 s`); stopMoving(); L.key = null; L.goalFor = null; L.blockedAt = null; return }
    if (!L.spotAt || t - L.spotAt > 1000) {
      L.spotAt = t
      const spot = findVisibleSpot(bot, e)
      if (spot) { L.goalFor = 'spot'; await moveTo(new goals.GoalBlock(spot.x, spot.y, spot.z), false) }
      else { stopMoving(); L.goalFor = null }
    }
  }

  // ---- creeper fuse detection: entity metadata (swell_dir / is_ignited) and the hiss sound ----
  function metaIndexes() {
    if (swellIdx != null) return
    const keys = bot.registry && bot.registry.entitiesByName && bot.registry.entitiesByName.creeper && bot.registry.entitiesByName.creeper.metadataKeys
    swellIdx = keys && keys.indexOf('swell_dir') >= 0 ? keys.indexOf('swell_dir') : 16
    ignitedIdx = keys && keys.indexOf('is_ignited') >= 0 ? keys.indexOf('is_ignited') : 18
  }
  function metaFusing(e) {
    metaIndexes()
    const m = e.metadata
    if (!m) return false
    return m[swellIdx] === 1 || m[ignitedIdx] === true || m[ignitedIdx] === 1
  }
  function onSound(...args) {
    let name = args.find(a => typeof a === 'string')
    if (!name && typeof args[0] === 'number' && bot.registry && bot.registry.sounds && bot.registry.sounds[args[0]]) name = bot.registry.sounds[args[0]].name
    if (!name || !/creeper.*primed/.test(name)) return
    const pos = args.find(a => a && typeof a === 'object' && typeof a.x === 'number')
    primed = { at: now(), pos: pos || null }
  }

  // ---- state gathering ----
  function snapshot() {
    const t = now()
    let mobs = []
    for (const e of Object.values(bot.entities)) {
      if (!e || e === bot.entity || e.type === 'player' || !e.name || !e.position) continue
      const known = PROFILES[e.name]
      if (!known && e.type !== 'hostile') continue
      if (d3(bot.entity.position, e.position) > 32) continue
      mobs.push({ id: e.id, name: e.name, pos: e.position, entity: e })
    }
    lastMobs = mobs
    for (const m of mobs) {
      const p = prevPos.get(m.id)
      if (p && t - p.t >= 100) { const dt = (t - p.t) / 1000; vels.set(m.id, { x: (m.pos.x - p.pos.x) / dt, y: 0, z: (m.pos.z - p.pos.z) / dt }) }
      if (!p || t - p.t >= 100) prevPos.set(m.id, { t, pos: m.pos.clone() })
    }
    if (prevPos.size > 80) { const live = new Set(mobs.map(x => x.id)); for (const id of [...prevPos.keys()]) if (!live.has(id)) { prevPos.delete(id); vels.delete(id) } }
    // walking-path filter: hostiles that cannot walk to us are no threat (caves behind rock). The mob that just hurt us always counts.
    if (C.pathFilter) {
      const res = reach.check(mobs)
      mobs = mobs.filter(m => { const r = res.get(m.id); return !r || r.ok || (m.id === hurtBy && t - lastHurtAt < 5000) })
    }
    const motion = tracker.update(t, bot.entity.position, mobs)
    for (const m of mobs) m.closing = motion.get(m.id).closing
    // creepers: fuse state, line of sight for the bow
    const creepers = mobs.filter(m => m.name === 'creeper')
    const hasBow = !!bowItem(), hasArrows = bow.arrowCount(bot.inventory.items()) > 0
    const los = {}
    fuseTracker.update(t, creepers.map(m => {
      const dist = d3(bot.entity.position, m.pos)
      const heard = primed && t - primed.at < 1800 && (!primed.pos || d3(primed.pos, m.pos) < 4)
      return { id: m.id, dist, fusing: metaFusing(m.entity) || !!heard }
    }))
    const fuse = {}
    for (const m of creepers) {
      fuse[m.id] = fuseTracker.get(m.id, t)
      if (hasBow && hasArrows) los[m.id] = reach.los(m)
    }
    if (creepers.length) cs.lastSeen = t
    else if (t - cs.lastSeen > 15000) { cs.cycles = 0; cs.phase = 'idle' }
    for (const [id, until] of giveUp) if (until < t) giveUp.delete(id)
    while (hits.length && t - hits[0] > C.hitWindowMs) hits.shift()
    const o = ownerEntity()
    return {
      now: t, me: { pos: bot.entity.position }, health: bot.health, mode: effectiveMode(), hasWeapon: !!weapon(), hasBow, hasArrows, los,
      creeper: { fuse, phase: cs.phase, sinceHitMs: cs.hitAt ? t - cs.hitAt : Infinity, cycles: cs.cycles },
      owner: o ? { pos: o.position } : null, mobs,
      hurtBy: t - lastHurtAt < 5000 ? hurtBy : null, hurtRecently: t - lastHurtAt < 4000, recentHits: hits.length,
      recovering, night: environment(t).night, outdoors: env.outdoors, shelter: shelterNow(mobs, t), giveUp: new Set(giveUp.keys()), fleeingSinceMs: fleeingSince ? t - fleeingSince : null
    }
  }

  // Hurt with mobs close: only a shelter within shelterCloseMax counts. Never a long walk through the dark with a creeper on our heels.
  function shelterNow(mobs, t) {
    const sh = env.shelter
    if (!sh) return null
    const hurt = bot.health <= C.minFightHealth || recovering
    const closeHostile = mobs.some(m => d3(bot.entity.position, m.pos) <= 16 && (PROFILES[m.name] || {}).kind !== 'neutral')
    return hurt && closeHostile && sh.dist > C.shelterCloseMax ? null : sh
  }

  // Effective settings for this scan. Unprepared underground (no armor / no torches / hardly any filler / no food) the retreat reflex fires at 12 health;
  // while holding a position on purpose (standGround) the number of mobs does not make the bot run, only low health does.
  function effective(prepNow) {
    let c = C
    if (prepNow.unprepared) c = { ...c, minFightHealth: Math.max(c.minFightHealth, 12) }
    if (now() < standUntil) c = { ...c, maxFighters: 99, maxArchers: 99, rangedFightHealth: 0, retreatRange: 0 }
    return c
  }
  let standUntil = 0, prepAt = 0, prep = { unprepared: false, why: [] }
  function preparedness(t) {
    if (t - prepAt < 2000) return prep
    prepAt = t
    environment(t)
    const s = loadout.summary(), why = []
    if (!env.outdoors) {          // underground (covered)
      if (s.armor < 2) why.push('armor'); if (s.torches === 0) why.push('torches'); if (s.filler < 12) why.push('filler'); if (s.food < 4) why.push('food')
    }
    prep = { unprepared: why.length > 0, why }
    return prep
  }
  const standGround = (ms = 60000) => { standUntil = now() + ms; return { until: standUntil } }

  function onHurt(e) {
    if (e !== bot.entity) return
    const t = now()
    lastHurtAt = t; hits.push(t)
    let best = null, bd = 6
    for (const m of lastMobs) { const d = d3(m.pos, bot.entity.position); if (d < bd) { bd = d; best = m } }
    if (best) hurtBy = best.id
  }
  function onDeath() { hits.length = 0; hurtBy = null; fleeingSince = null; recovering = false; announcedLow = false; cs.phase = 'idle'; cs.cycles = 0; try { bot.pathfinder.setGoal(null) } catch { /* ignore */ } }
  function bind() { unbind(); bot.on('entityHurt', onHurt); bot.on('death', onDeath); bot.on('soundEffectHeard', onSound); bot.on('hardcodedSoundEffectHeard', onSound) }
  function unbind() { for (const [ev, fn] of [['entityHurt', onHurt], ['death', onDeath], ['soundEffectHeard', onSound], ['hardcodedSoundEffectHeard', onSound]]) bot.removeListener(ev, fn) }

  function speak(key, text, gapMs = 20000, urgent = false) {
    const t = now()
    if (t - (warnedAt.get(key) || 0) < gapMs || (!urgent && t - lastWarnAt < 4000)) return false
    warnedAt.set(key, t); lastWarnAt = t; say(text); return true
  }

  // ---- decide (cheap, runs every scanMs) ----
  function scan() {
    try { scanInner() } catch (e) { log('scan failed: ' + (e && e.message)) }     // never let a timer throw
  }
  function scanInner() {
    if (!bot.entity || bot.health === undefined) return
    const was = recovering
    if (firstScan) { firstScan = false; if (bot.health > C.minFightHealth && bot.health < C.recoverHealth) { recovering = true; announcedLow = true; holdStart = now(); slogOnce('restart-hurt', `started hurt (${Math.round(bot.health)}/20): holding tasks until ${C.recoverHealth}`, 1000) } }
    const prepNow = preparedness(now())
    const effC = effective(prepNow)
    recovering = nextRecovering(recovering, bot.health, { ...healthCfg, lowHealth: effC.minFightHealth })
    const snap = snapshot()
    const d = assess(snap, effC)
    latest = { ...d, at: snap.now, entity: d.target && snap.mobs.find(m => m.id === d.target.id)?.entity }
    // creeper phase bookkeeping
    const before = cs.phase
    if (d.action === 'fight' && d.style === 'strike') cs.phase = 'approach'
    else if (d.creeper === 'withdraw') cs.phase = 'withdraw'
    else if (cs.phase === 'withdraw' && snap.now - cs.hitAt < 6000 && d.action === 'flee' && d.target && d.target.name === 'creeper') cs.phase = 'withdraw'   // fuse flee must not lose the cycle
    else cs.phase = 'idle'
    if (cs.phase !== before || d.creeper) slogOnce('creeper:' + cs.phase + ':' + d.action + ':' + d.reason, `creeper ${before}->${cs.phase}: ${d.action} (${d.reason}) dist ${d.target ? d.target.dist.toFixed(1) : '?'} health ${Math.round(snap.health)}`, 2000)
    if (d.action === 'flee' && fleeingSince == null) fleeingSince = snap.now
    if (d.action !== 'flee' && d.action !== 'fight') fleeingSince = null
    for (const w of d.warnings) speak(w.key, w.text, 20000, w.key.startsWith('bot:creeper') || w.key.startsWith('far:creeper'))
    if (recovering && !was) { holdStart = snap.now; if (!announcedLow) { announcedLow = true; say(`Health ${Math.round(snap.health)}/20. Pausing my tasks until I recover.`) } }
    if (!recovering) { announcedLow = false; noFoodSaid = false }
    if (recovering && holdCooldownUntil && snap.now >= holdCooldownUntil && holdStart < holdCooldownUntil) holdStart = snap.now   // new hold window after a cooldown
    const holding = recovering && snap.now >= holdCooldownUntil
    // Height history: a drop of bigFallBlocks or more within fallWatchMs is a "big fall" (05:06 incident: 41 blocks into a cave).
    ySamples.push({ t: snap.now, y: snap.me.pos.y })
    while (ySamples.length && snap.now - ySamples[0].t > C.fallWatchMs) ySamples.shift()
    const fell = Math.max(...ySamples.map(s => s.y)) - snap.me.pos.y >= C.bigFallBlocks
    // No reachable shelter close by, hurt (or just fallen into the dark), hostiles about: wall in on the spot (only when Walter allowed it).
    // Walter 18:18 (6 deaths in caves, hp 12 -> 2 in one volley): underground with a hostile within 15 blocks and a clear line, or a fresh hit with a hostile near => wall in NOW, not at low health
    const losTo = (m) => { try { const eye = bot.entity.position.offset(0, 1.62, 0), tg = m.pos.offset(0, 1, 0), dv = tg.minus(eye), dist = dv.norm(); return !bot.world.raycast(eye, dv.scaled(1 / dist), dist) } catch { return true } }
    let cavePreempt = false
    try { cavePreempt = !entombed && light.underground() && (snap.mobs.some(m => (PROFILES[m.name] || {}).kind !== 'neutral' && d3(snap.me.pos, m.pos) <= 15 && losTo(m)) || (snap.now - lastHurtAt < 3000 && snap.mobs.some(m => (PROFILES[m.name] || {}).kind !== 'neutral' && d3(snap.me.pos, m.pos) <= 24))) } catch { cavePreempt = false }
    if (C.emergencyEntomb && !entombed && !entombBusy && !wantEntomb && snap.now - entombFailedAt > 60000 && (snap.health <= C.minFightHealth || recovering || cavePreempt || (fell && snap.health <= C.fallEntombHealth))) {
      const hostile = snap.mobs.some(m => d3(snap.me.pos, m.pos) <= (fell || cavePreempt ? 16 : 12) && (PROFILES[m.name] || {}).kind !== 'neutral')
      if (hostile && !snap.shelter && entombMod.countFiller(bot.inventory.items()) >= C.entombMinFiller) { wantEntomb = true; slog(`entomb wanted: health ${Math.round(snap.health)}${fell ? ', after a big fall' : ''}${cavePreempt ? ', cave hostile in sight (preempt)' : ''}, no reachable shelter, hostile close`) }
    }
    // Narrow ground / a bridge: do not run (the bot fell 40 blocks off the y26 mining bridge). Wall in on the spot when allowed, else stand and hold.
    if (C.emergencyEntomb && !entombed && !entombBusy && !wantEntomb && env.narrow && d.action === 'flee' && snap.now - entombFailedAt > 60000 &&
        entombMod.countFiller(bot.inventory.items()) >= C.entombMinFiller) { wantEntomb = true; slog(`entomb wanted: fleeing on narrow ground (${d.reason})`) }
    // post-mortem material: what we were doing, with what, how hurt
    try {
      const feet = bot.entity.position.floored(), here = bot.blockAt(feet)
      deaths.sample({
        health: snap.health, food: bot.food, pos: { x: snap.me.pos.x, y: snap.me.pos.y, z: snap.me.pos.z }, light: here && typeof here.light === 'number' ? here.light : null,
        underground: light.underground(), loadout: loadout.summary(), phase: cs.phase,
        mobs: snap.mobs.map(m => ({ name: m.name, dist: Math.round(d3(snap.me.pos, m.pos)) })).filter(m => m.dist <= 24),
        doing: entombed ? 'walled in' : `${d.action} ${d.target ? d.target.name : ''} (${d.reason || 'calm'})`.trim()
      })
    } catch { /* never break the scan */ }
    const act = d.action === 'fight' || d.action === 'flee' || d.action === 'shoot' || wantEntomb || entombed
    // torch as you go: underground, dark, nothing hostile about, nothing else using the hand
    if (!act && !holding && light.due() && !(safehand && safehand.holdingLava()) && !bot.currentWindow && !snap.mobs.some(m => d3(snap.me.pos, m.pos) <= 12) && bot.entity.onGround !== false) {
      light.lightHere().then(r => { if (!r.ok && r.why !== 'cooldown' && r.why !== 'busy') slogOnce('light:' + r.why, `light: not placed (${r.why})`, 60000) }).catch(() => {})
    }
    if (act || holding) {
      if (act) calmSince = snap.now
      scheduler.submit({ name: 'safety', priority: PRIORITY.SAFETY, preemptible: false, run: runSafety })
    }
  }

  // ---- eating ----
  async function eat(emergency) {
    if (eating) return false
    eating = true; lastEatAt = now()
    try {
      if (eatNow) { await eatNow(); return true }
      // brain/plugins loaded mineflayer-auto-eat: one eater only, it picks the food
      if (bot.autoEat && typeof bot.autoEat.eat === 'function') {
        if (bot._eatBlocked && bot._eatBlocked()) return false   // a mob in reach: fight first (brain/plugins)
        try { await bot.autoEat.eat() } catch (e) { log('auto-eat: ' + e.message); return false } return true }
      const food = chooseFood(bot.inventory.items(), bot.registry.foodsByName || {}, { food: bot.food, emergency })
      if (!food) { if (!noFoodSaid) { noFoodSaid = true; say(emergency ? 'Hurt and no food on me.' : 'No food to eat.') } return false }
      await bot.equip(food, 'hand'); swappedForFood = true
      if (typeof bot.consume === 'function') await Promise.race([bot.consume(), new Promise((_, rej) => setTimeout(() => rej(new Error('eat timeout')), C.eatTimeoutMs))])
      return true
    } catch (e) { log('eat failed: ' + e.message); return false } finally {
      eating = false
      // only put the weapon back if food really went into the hand: re-equipping on every no-food attempt yanked pickaxes and scaffold blocks out of the hand several times a second
      if (swappedForFood) { swappedForFood = false; try { const w = weapon(); if (w && (!bot.heldItem || bot.heldItem.name !== w.name)) await bot.equip(w, 'hand') } catch { /* ignore */ } }
    }
  }
  let swappedForFood = false
  function nearestThreatDist() {
    const l = latest && now() - latest.at < 1500 ? latest : null
    return l && l.threats.length ? Math.min(...l.threats.map(m => m.dist)) : Infinity
  }
  async function maybeEat(walledIn = false) {
    if (eating || bot.isSleeping || now() - lastEatAt < C.eatGapMs) return
    const q = shouldEat({ health: bot.health, food: bot.food, nearestThreat: walledIn ? Infinity : nearestThreatDist(), recovering }, healthCfg)
    if (q.eat) { log('eating: ' + q.why); await eat(q.emergency) }
  }

  // ---- armor already in the inventory (never taken from chests) ----
  async function equipArmor() {
    if (!C.armor || typeof bot.getEquipmentDestSlot !== 'function') return
    try {
      const worn = {}
      for (const slot of ['head', 'torso', 'legs', 'feet']) worn[slot] = bot.inventory.slots[bot.getEquipmentDestSlot(slot)] || null
      for (const { item, slot } of gear.armorUpgrades(bot.inventory.items(), worn)) { await bot.equip(item, slot); slogOnce('armor:' + item.name, `equipped ${item.name}`, 60000) }
    } catch (e) { log('armor failed: ' + e.message) }
  }

  // ---- act (runs as the SAFETY task) ----
  async function runSafety(ctx) {
    const L = { key: null, lastAttack: 0, progress: { t: now(), d: Infinity }, spokeFight: false, spokeFlee: false, drawing: false, drawStart: 0, lastShot: 0, anchor: null, armored: false, fleeSetAt: 0 }
    const equipWeapon = async () => { const w = weapon(); if (w && (!bot.heldItem || bot.heldItem.name !== w.name)) await bot.equip(w, 'hand').catch(() => {}); return w }
    // while this task runs no step may drop more than 3 blocks, whatever the other modules left in the shared Movements
    const mv = bot.pathfinder && bot.pathfinder.movements
    const savedDrop = mv ? mv.maxDropDown : undefined
    if (mv && typeof mv.maxDropDown === 'number' && mv.maxDropDown > C.maxDropDown) mv.maxDropDown = C.maxDropDown
    const dropBow = async () => { if (L.drawing) { L.drawing = false; await cancelDraw() } }      // leaving the shoot action never fires a stray arrow
    try {
      while (true) {
        ctx.checkpoint()
        const t = now(), d = latest
        const active = !!d && t - d.at < 1500 && (d.action === 'fight' || d.action === 'flee' || d.action === 'shoot')
        if (active) calmSince = t
        if (L.drawing && !(active && d.action === 'shoot')) await dropBow()
        if (wantEntomb) { wantEntomb = false; await doEntomb(L) }
        if (entombed) {
          await entombedTick(L, t)
          await ctx.sleep(250); continue
        }
        const holding = recovering && t < holdStart + C.holdMaxMs
        if (recovering && !holding && t >= holdCooldownUntil) {          // cannot recover (no food?): stop blocking the other tasks
          holdCooldownUntil = t + C.holdCooldownMs
          say(`Still at ${Math.round(bot.health)}/20 and not recovering. Resuming tasks; I need food.`)
        }
        if (!active && !holding && t - calmSince > C.calmMs) break
        if (active && d.entity) {
          const e = d.entity, dist = bot.entity.position.distanceTo(e.position)
          if (d.action === 'fight') {
            if (!L.armored) { L.armored = true; await equipArmor() }
            const w = await equipWeapon()
            if (!L.spokeFight) { L.spokeFight = true; say(`Fighting ${e.name} (${d.reason}).`) }
            if (d.style === 'strike') await strike(L, e, dist, w)
            else await melee(L, e, dist, w, d)
          } else if (d.action === 'shoot') {
            await shoot(L, e, dist)
          } else {
            // fleeing still holds the weapon, not the pickaxe, and eats only with nothing within 8 blocks: twice underground (16:11 a
            // skeleton, 17:13 zombies and a creeper) the bot fled with a pickaxe in hand and bread in its mouth while mobs hit it point-blank
            await equipWeapon()
            if (!d.urgent && nearestThreatDist() > 8) await maybeEat()
            // a creeper is the combat reflex's: it hits it as it comes and runs from the fuse by itself. A pathfinder flee on top of that
            // pulled the controls the other way and the bot stood still while the creeper walked up and blew (18:21, 20 hp on the surface)
            if (!(e.name === 'creeper' && bot._combat)) await retreat(L, e, d)
          }
        } else if (!active) {
          if (recovering && latest && latest.retreat === 'shelter') await goShelter(L)
          await maybeEat()                                              // recovering with nobody around: heal up
        }
        await ctx.sleep(L.drawing ? 100 : 250)
      }
    } finally {
      if (mv && savedDrop !== undefined) mv.maxDropDown = savedDrop
      await dropBow().catch(() => {})
      try { stopNav() } catch { /* ignore */ }
      stopMoving()
      try { await (async () => { const w = weapon(); if (w && bot.heldItem && bot.heldItem.name === 'bow') await bot.equip(w, 'hand') })() } catch { /* ignore */ }
      fleeingSince = null; hurtBy = null
      if (L.spokeFight || L.spokeFlee) say('Clear.')
    }
  }

  async function melee(L, e, dist, w, d) {
    const t = now()
    if (reflex && !reflex.claim('melee', 2000, `fighting ${e.name}`)) return        // another reflex (combat) holds the swings
    const ranged = PROFILES[e.name] && PROFILES[e.name].kind === 'ranged'
    if (L.key !== 'm' + e.id) { L.key = 'm' + e.id; L.progress = { t, d: dist }; L.anchor = bot.entity.position.clone() }
    if (L.anchor && bot.entity.position.distanceTo(L.anchor) > C.leashRange) {      // never chase far from where the fight began
      giveUp.set(e.id, t + 30000); slog(`leash: gave up on ${e.name}#${e.id}`); say(`Not chasing ${e.name} any further.`); stopMoving(); L.key = null; L.goalFor = null; return
    }
    const standing = now() < standUntil                                   // holding a position (the shaft bottom): hit what reaches us, never step off
    const chase = !env.narrow && (standing ? dist <= 3.6 : (dist <= (ranged ? C.rangedChase : C.chaseRange) || e.id === hurtBy))
    if (dist > 3.2 && chase) {
      if (ranged && dist > 4.5) await strafeIn(L, e, dist)                 // archers: zig-zag in so most arrows miss
      else if (L.goalFor !== 'f' + e.id) { L.goalFor = 'f' + e.id; await moveTo(new goals.GoalFollow(e, 2), true) }
    } else if (dist > 3.2) { stopMoving(); L.goalFor = null }
    if (dist <= 6) { try { await bot.lookAt(e.position.offset(0, (e.height || 1.8) * 0.8, 0), true) } catch { /* ignore */ } }
    if (dist <= 3.2) {
      if (!(await sees(e))) { await whenBlocked(L, e, dist); return }
      L.blockedAt = null
      if (t - L.lastAttack > gear.cooldownMs(w)) { L.lastAttack = t; bot.attack(e) }
    } else if (chase) {
      if (dist < L.progress.d - 0.5) L.progress = { t, d: dist }
      else if (t - L.progress.t > 6000) { giveUp.set(e.id, t + 30000); log(`giving up on ${e.name} ${e.id}: cannot reach`); stopMoving(); L.key = null; L.goalFor = null }
    }
  }

  // Close in on an archer along a zig-zag: every 0.6 s pick a point 4 blocks ahead, rotated 40 degrees left or right (alternating).
  async function strafeIn(L, e, dist) {
    const t = now()
    if (L.strafeAt && t - L.strafeAt < 600) return
    L.strafeAt = t; L.strafeSide = -(L.strafeSide || 1)
    const me = bot.entity.position
    const dx = e.position.x - me.x, dz = e.position.z - me.z, len = Math.hypot(dx, dz) || 1
    const a = L.strafeSide * 0.7, ca = Math.cos(a), sa = Math.sin(a), step = Math.min(4, Math.max(1.5, dist - 2))
    const px = me.x + (dx / len * ca - dz / len * sa) * step, pz = me.z + (dx / len * sa + dz / len * ca) * step
    L.goalFor = 'strafe'
    if (goals.GoalNearXZ) await moveTo(new goals.GoalNearXZ(px, pz, 1), false)
    else await moveTo(new goals.GoalNear(px, me.y, pz, 1), false)
  }

  // Sword hit-and-retreat on a creeper: close in, one full-strength hit, then back off (assess keeps us in "withdraw" until 5.5+ blocks).
  async function strike(L, e, dist, w) {
    const t = now()
    if (env.narrow) return
    if (L.key !== 's' + e.id) { L.key = 's' + e.id; L.goalFor = null; await moveTo(new goals.GoalFollow(e, 1.5), true) }
    if (dist <= C.strikeReach && t - L.lastAttack > gear.cooldownMs(w) && !(await sees(e))) { await whenBlocked(L, e, dist); return }
    if (dist <= C.strikeReach && t - L.lastAttack > gear.cooldownMs(w)) {
      L.blockedAt = null
      try { await bot.lookAt(e.position.offset(0, (e.height || 1.7) * 0.7, 0), true) } catch { /* ignore */ }
      L.lastAttack = t; bot.attack(e)
      cs.phase = 'withdraw'; cs.hitAt = t; cs.cycles++
      slog(`creeper strike #${cs.cycles} at ${dist.toFixed(1)} blocks, health ${Math.round(bot.health)}`)
      L.key = null; L.goalFor = null
      await moveTo(new goals.GoalInvert(new goals.GoalFollow(e, 9)), true)
    }
  }

  // Bow: draw, aim with the ballistic solver, release at full draw. Stands still while drawing; assess switches to flee if the
  // creeper gets inside the kite range or starts its fuse.
  async function shoot(L, e, dist) {
    const t = now(), b = bowItem()
    if (!b) { L.drawing = false; return }
    if (!L.drawing) {
      if (t - L.lastShot < 350) return
      if (!(await sees(e))) { slogOnce('los-bow:' + e.id, `no clear line to ${e.name}#${e.id}: not drawing`, 3000); return }
      stopMoving()
      try { await ensureHandSafe() } catch { return }
      if (!bot.heldItem || bot.heldItem.name !== 'bow') await bot.equip(b, 'hand').catch(() => {})
      aim(e, true)
      bot.activateItem(); L.drawing = true; L.drawStart = t
      if (!L.spokeFight) { L.spokeFight = true; say(`Shooting ${e.name} from range.`) }
    } else {
      const ok = aim(e, false)
      if (!ok) { L.drawing = false; await cancelDraw(); return }
      if (t - L.drawStart >= bow.FULL_DRAW_MS && !(await sees(e))) { L.drawing = false; slog(`line to ${e.name}#${e.id} blocked at release: draw cancelled`); await cancelDraw(); return }
      if (t - L.drawStart >= bow.FULL_DRAW_MS) { bot.deactivateItem(); L.drawing = false; L.lastShot = t; slog(`shot arrow at ${e.name}#${e.id} from ${dist.toFixed(1)} blocks`) }
    }
  }
  // Switching to the sword cancels a half-drawn bow without firing the arrow.
  async function cancelDraw() { const w = weapon(); if (w) await bot.equip(w, 'hand').catch(() => {}); else { try { bot.deactivateItem() } catch { /* ignore */ } } }
  function aim(e, first) {
    const eye = bot.entity.position.offset(0, 1.62, 0)
    const target = e.position.offset(0, (e.height || 1.7) * 0.6, 0)
    const vel = vels.get(e.id) || { x: 0, y: 0, z: 0 }
    const a = bow.solveAim(eye, target, vel)
    if (!a) return false
    try { bot.look(a.yaw, a.pitch, true) } catch { /* ignore */ }
    return true
  }

  async function doEntomb(L) {
    if (entombBusy) return
    // zombies already at arm's length: walling in (stopped, cobblestone in hand) let three of them kill OzoGo444 at 09:34. Fight (combat) instead;
    // walling in is for the moment the melee mobs are not yet in reach (creepers and archers still allow it)
    if (bot._meleeClose && Date.now() - (bot._meleeCloseAt || 0) < 500) { slogOnce('entomb-skip', 'entomb skipped: melee mob in reach, fighting', 5000); return }
    entombBusy = true
    try { await doEntombInner(L) } finally { entombBusy = false }
  }
  async function doEntombInner(L) {
    stopMoving()
    say('Hurt, hostiles close and no safe way to shelter: sealing myself in with blocks until I heal.')
    const res = await entomber.seal().catch(e => ({ ok: false, why: e.message }))
    slog(`entomb result: ${JSON.stringify(res)}`)
    if (res.ok) { entombed = true; roofTried = false; entombCalmAt = 0; holdStart = now(); say('Sealed in. Eating and healing.') }
    else { entombFailedAt = now(); say(`Could not seal myself in (${res.why || (res.lava ? 'lava next to me' : res.open + ' sides open')}).`) }
  }
  // Inside the walls: eat (mobs outside do not count), wait for health and quiet, then dig out through our own blocks.
  async function entombedTick(L, t) {
    // survival world: never stay "entombed" in the open. If any side cell at feet/head is passable we are not walled in, so release and go back to work.
    try {
      const me = bot.entity.position.floored()
      const open = [[1, 0], [-1, 0], [0, 1], [0, -1]].some(([dx, dz]) => [0, 1].some(dy => { const b = bot.blockAt(me.offset(dx, dy, dz)); return b && b.boundingBox === 'empty' }))
      if (open) { entombed = false; entombFailedAt = t; return }
    } catch {}
    await maybeEat(true)
    if (!roofTried && bot.food >= 0) { roofTried = true; const ok = await entomber.closeRoof(); slog(`entomb roof: ${ok ? 'closed' : 'left open'}`) }
    // an archer within 16 or anything within 8 keeps the walls up: at 16:11 the bot dug out with a skeleton 6.8 blocks off and was shot dead
    // creepers too: at 17:45 it dug out with a creeper 12 blocks off, which walked up and blew it up a few seconds later
    const hostileNear = latest && t - latest.at < 1500 && latest.threats.some(m => m.dist <= 8 || (m.dist <= 16 && /^(ranged|explosive)$/.test((PROFILES[m.name] || {}).kind || '')))
    if (hostileNear) entombCalmAt = 0; else if (!entombCalmAt) entombCalmAt = t
    const healed = bot.health >= C.recoverHealth
    if ((healed && entombCalmAt && t - entombCalmAt > 5000) || t - holdStart > C.entombHoldMs) {
      say(healed ? 'Healed. Digging out.' : 'Waited long enough. Digging out.')
      const out = env.shelter ? env.shelter.pos : null
      const ok = await entomber.digOut(out).catch(() => false)
      slog(`entomb exit: ${ok}`)
      // a clean dig-out may wall in again after 10 s (the old 60 s lock left it in the open while the next creeper came, 17:45); a failed one waits the full minute
      entombed = false; entombFailedAt = ok ? t - 50000 : t
      // a failed dig-out used to re-enter the hold forever (the safety task ran 29 min at 19:30): leave it to the autopilot, which digs its own way
    }
  }

  // Hurt and nobody around: walk to the nearest shelter once, then hold there. Re-issued every 5 s while still far from it.
  async function goShelter(L) {
    const sh = env.shelter, t = now()
    if (!sh) return
    const dist = Math.hypot(sh.pos.x + 0.5 - bot.entity.position.x, sh.pos.z + 0.5 - bot.entity.position.z)
    if (dist <= 4) { if (bot.pathfinder.goal) stopMoving(); return }
    if (L.shelterAt && t - L.shelterAt < 5000) return
    L.shelterAt = t
    if (!L.spokeShelter) { L.spokeShelter = true; say(`Hurt (${Math.round(bot.health)}/20): heading to ${sh.name} to recover.`) }
    slogOnce('shelter-recover', `recovering: walking to ${sh.name} (${dist.toFixed(0)} blocks), health ${Math.round(bot.health)}`, 5000)
    await moveTo(new goals.GoalNear(sh.pos.x, sh.pos.y, sh.pos.z, 2), false)
  }

  async function retreat(L, e, d) {
    const t = now()
    if (env.narrow) {
      // narrow ground: running risks a fall. Stand still (mobs come to us; adjacent ones are still fought via the fight branch).
      if (bot.pathfinder.goal) stopMoving()
      L.key = null; L.goalFor = null
      speak('narrow', 'Narrow ground: staying put instead of running.', 30000, true)
      slogOnce('narrow', `flee suppressed on narrow ground (${d.reason}), health ${Math.round(bot.health)}`, 5000)
      return
    }
    const key = e.id + ':' + d.retreat + ':' + (d.creeper || '')
    const refresh = d.urgent && t - L.fleeSetAt > 1000 && !bot.pathfinder.goal
    if (L.key !== key || refresh) {
      L.key = key; L.fleeSetAt = t; L.goalFor = null
      const owner = ownerEntity()
      const far = d.creeper ? 12 : 16
      const sh = env.shelter
      const ok = (d.retreat === 'shelter' && sh && !d.creeper)
        ? await moveTo(new goals.GoalNear(sh.pos.x, sh.pos.y, sh.pos.z, 2), false)
        : (d.retreat === 'owner' && owner && !d.creeper)
          ? await moveTo(new goals.GoalFollow(owner, 2), true)
          : await moveTo(new goals.GoalInvert(new goals.GoalFollow(e, far)), true)
      if (ok && d.retreat === 'shelter' && sh && !d.creeper) slogOnce('shelter-flee', `retreating to ${sh.name} (${sh.dist.toFixed(0)} blocks) from ${e.name}: ${d.reason}`, 5000)
      if (ok && !L.spokeFlee) { L.spokeFlee = true; speak('flee:' + d.reason, d.urgent ? `${e.name} is about to blow! Running.` : `Backing away (${d.reason}).`, 15000, !!d.urgent) }
    }
  }

  function start() { bind(); deaths.start(); if (!timer) { timer = setInterval(scan, C.scanMs); if (timer.unref) timer.unref() } }
  function stop() { clearInterval(timer); timer = null; unbind(); deaths.stop(); if (reflex) reflex.release('melee') }
  const status = () => ({
    mode, meleeBy: meleeTakenBy(), creeperStrike: !!C.creeperStrike, narrow: env.narrow, unprepared: prep.unprepared ? prep.why : null, standing: now() < standUntil, loadout: loadout.summary(), torchesPlaced: light.stat.placed, deathsLogged: deaths.tuning().deaths.length, emergencyEntomb: !!C.emergencyEntomb, entombed, wantEntomb, action: latest ? latest.action : 'none', reason: latest ? latest.reason : '', health: bot.health, food: bot.food, recovering,
    creeper: { phase: cs.phase, cycles: cs.cycles }, night: env.night, outdoors: env.outdoors, shelter: env.shelter ? { name: env.shelter.name, dist: Math.round(env.shelter.dist) } : null, path: { evals: reach.stat.evals, suppressed: reach.stat.suppressed, timeouts: reach.stat.timeouts },
    threats: latest ? latest.threats.map(m => ({ name: m.name, dist: Math.round(m.dist), approaching: m.approaching })) : []
  })

  bind()
  return { start, stop, scan, setMode, getMode: () => mode, setCreeperStrike, getCreeperStrike: () => !!C.creeperStrike, standGround, preparedness: () => preparedness(now()), setEmergencyEntomb, getEmergencyEntomb: () => !!C.emergencyEntomb, status, environment: () => environment(now()), deaths, loadout, light, torches, eat, runSafety, tracker, reach }
}
