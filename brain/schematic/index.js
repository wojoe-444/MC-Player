// brain/schematic: the bot's ability to SAVE a schematic of something that stands in the world, and to check a build against one. An observer: it reads blocks the
// bot has loaded (the same blocks it sees), never moves, never touches a block.
//   bot._schematic.capture({ id, name?, kind?, purpose?, box | room, seeds?, masks? })  -> { ok, file, schematic } | { ok:false, why }
//        box   { x0,y0,z0,x1,y1,z1 } world cells; every chunk column of it must be loaded
//        room  a registry room id: its box (plus a margin) is captured and the room record gets `schematic: id`, so brain/inspect diffs it cell by cell from then on
//        mode  'functional' (default: walls stored as role `solid` with the block that was there) or 'aesthetic' (every block exact: a house, a statue)
//        surround  cells of natural world kept around it as scenery for the picture (default 2)
//        seeds cells inside the build: only open space connected to them is the build (a farm in the open is not the forest around it)
//   bot._schematic.diff(id, at?)  -> brain/schematic/format.js diff against the loaded world
//   bot._schematic.list()
//   bot._schematic.progress(id, at?)      -> brain/schematic/follow.js progress(): percent right, the work still to do, per layer; unloaded cells are never counted wrong
//   bot._schematic.startJob({ id?, kind, reason, at?, near?, explicit?, room? })  decide to FOLLOW a schematic for a build (loop.js says when that is appropriate),
//        pick where it goes (findAt: least digging, never lava or a no-dig cell) and remember the job (brain/state/schematic-job.json). One job at a time.
//   bot._schematic.verify()               -> check the world against the job now: percent, state (building | complete | stuck | abandoned), a lesson line and a journal event
//        when the state changes; on completion the build is registered as a room whose blueprint is the schematic, so brain/inspect and brain/outcome take it from there
//   bot._schematic.job() / .noteWork(ms) / .abandon(why)
// Every cell stores the specific block it shows AND a role (see blocks.js): a wall is `solid` (any solid, light-blocking, non-flammable block passes the check) shown as the block it was.
// Walter 2026-11-11: the improvement loop needs to be able to save a schematic of a working build, and to check the next one against it.
'use strict'
const fs = require('fs')
const path = require('path')
const F = require('./format')
const S = require('./store')
const grid = require('../inspect/grid')
const FO = require('./follow')
const LP = require('./loop')

module.exports = function register(api) {
  const { bot } = api
  const now = () => (api.now ? api.now() : Date.now())
  const stateDir = path.dirname(api.statePath('x'))
  const sharedDir = process.env.BOT_SHARED || path.join(__dirname, '..', '..', '..', 'bot-shared')
  const registryFile = api.registryFile || process.env.BOT_REGISTRY || path.join(sharedDir, 'registry.json')
  const dirs = () => S.dirsFor({ sharedDir, stateDir })
  const MAX_CELLS = 400000

  const readReg = () => { try { return JSON.parse(fs.readFileSync(registryFile, 'utf8')) } catch { return null } }
  const roomBox = (id) => { const reg = readReg(); if (reg && reg.worlds) for (const w of Object.values(reg.worlds)) for (const r of (w.rooms || [])) if (r.id === id && r.box) return { room: r, box: r.box, reg } ; return null }
  const liveGet = () => { const at = grid.liveBlockAt(bot); return (x, y, z) => { const b = at(x, y, z); return b ? { name: b.name, props: b.props || {} } : null } }

  function capture(o = {}) {
    if (!o.id) return { ok: false, why: 'give the schematic an id' }
    let box = o.box, room = null
    if (!box && o.room) { const r = roomBox(o.room); if (!r) return { ok: false, why: `no registered room "${o.room}"` }; room = r; const b = r.box; box = { x0: b.x0 - 1, y0: b.y0 - 1, z0: b.z0 - 1, x1: b.x1 + 1, y1: b.y1 + 1, z1: b.z1 + 1 } }
    if (!box) return { ok: false, why: 'give a box or a registered room' }
    const cells = (box.x1 - box.x0 + 1) * (box.y1 - box.y0 + 1) * (box.z1 - box.z0 + 1)
    if (!(cells > 0) || cells > MAX_CELLS) return { ok: false, why: `the box has ${cells} cells (the limit is ${MAX_CELLS})` }
    if (!grid.columnsLoaded(bot, box, 0)) return { ok: false, why: 'the chunks around the box are not loaded: go there first' }
    const s = F.capture(liveGet(), box, { id: o.id, name: o.name, kind: o.kind || (room && room.room.type) || 'build', purpose: o.purpose, seeds: o.seeds, masks: o.masks, mode: o.mode === 'aesthetic' ? 'aesthetic' : 'functional', surround: o.surround,
      source: { world: o.world || 'live world', save: null, capturedAt: new Date(now()).toISOString(), by: (bot.username || 'bot') + ' (in game)' } })
    if (s.unknownCells > s.size[0] * s.size[1] * s.size[2] * 0.02) return { ok: false, why: `${s.unknownCells} cells could not be read (chunks missing)` }
    const dir = path.join(sharedDir, 'schematics')
    let file; try { file = S.save(dir, s) } catch { file = S.save(path.join(stateDir, 'schematics'), s) }
    if (room) tagRoom(o.room, s.id)
    try { if (bot._journal) bot._journal.add('schematic', { id: s.id, kindOf: s.kind, cells: cells, file: path.basename(file) }, { sal: true }) } catch { /* observer */ }
    return { ok: true, file, schematic: s }
  }
  // the room record names its blueprint, so brain/inspect compares it with that from now on (the registry is shared: re-read, change one field, write whole)
  function tagRoom(roomId, schematicId) {
    try {
      const reg = readReg(); if (!reg) return
      for (const w of Object.values(reg.worlds || {})) for (const r of (w.rooms || [])) if (r.id === roomId) r.schematic = schematicId
      fs.writeFileSync(registryFile + '.tmp', JSON.stringify(reg, null, 1)); fs.renameSync(registryFile + '.tmp', registryFile)
    } catch { /* the schematic is saved either way */ }
  }
  function diff(id, at) {
    const s = S.load(dirs(), id); if (!s) return { ok: false, why: `no schematic "${id}"` }
    const box = { x0: (at || s.origin)[0], y0: (at || s.origin)[1], z0: (at || s.origin)[2], x1: (at || s.origin)[0] + s.size[0] - 1, y1: (at || s.origin)[1] + s.size[1] - 1, z1: (at || s.origin)[2] + s.size[2] - 1 }
    if (!grid.columnsLoaded(bot, box, 0)) return { ok: false, why: 'the chunks are not loaded' }
    return { ok: true, ...F.diff(s, liveGet(), at || s.origin) }
  }
  const list = () => S.list(dirs()).map(e => ({ id: e.schematic.id, name: e.schematic.name, kind: e.schematic.kind, mode: e.schematic.mode, size: e.schematic.size, origin: e.schematic.origin, file: e.file }))

  // ---------------------------------------------------------------------------------------------------------------------------- following one
  const jobFile = api.statePath('schematic-job.json'), lessonsFile = api.statePath('lessons.md')
  const readJson = (f, d = null) => { try { return JSON.parse(fs.readFileSync(f, 'utf8').replace(/^\uFEFF/, '')) } catch { return d } }
  const STUCK_MS = 25 * 60000                           // this much WORK time (the executor reports it) without one more cell right: the job is stuck
  let job = readJson(jobFile)
  const saveJob = () => { try { fs.writeFileSync(jobFile + '.tmp', JSON.stringify(job, null, 1)); fs.renameSync(jobFile + '.tmp', jobFile) } catch { /* the next verify writes it again */ } }
  const lesson = (m) => { try { fs.appendFileSync(lessonsFile, `- ${new Date(now()).toISOString().slice(0, 16).replace('T', ' ')} [schematic] ${m}\n`) } catch { /* ignore */ } }
  const boxOf = (s, at) => ({ x0: at[0], y0: at[1], z0: at[2], x1: at[0] + s.size[0] - 1, y1: at[1] + s.size[1] - 1, z1: at[2] + s.size[2] - 1 })
  const loadSchem = (id) => S.load(dirs(), id)

  function progress(id, at, opt = {}) {
    const s = loadSchem(id); if (!s) return { ok: false, why: `no schematic "${id}"` }
    const a = at || s.origin
    if (!grid.columnsLoaded(bot, boxOf(s, a), 0)) return { ok: false, why: 'the chunks are not loaded: go there first' }
    const p = FO.progress(s, liveGet(), a, opt)
    return { ok: true, ...p, attribution: opt.attribute === false ? undefined : attribute(p) }
  }
  // what the ledger knows about the cells that are off: made by us, by someone else, or nothing recorded (natural). Only the first 300 are asked.
  function attribute(p) {
    const lg = bot._ledger; if (!lg || !lg.whoMade) return null
    const out = { ours: 0, other: 0, natural: 0, changed: 0, sample: [] }
    for (const w of p.work.slice(0, 300)) {
      if (w.kind === 'place' || w.kind === 'fluid' || w.kind === 'forbidden' || !w.got || /^(air|cave_air|water|lava)$/.test(w.got)) continue
      let r; try { r = lg.whoMade({ x: w.x, y: w.y, z: w.z }, w.got) } catch { continue }
      const v = r && r.verdict
      if (v === 'placed-by-us' || v === 'dug-by-us' || v === 'removed-by-us') out.ours++
      else if (v === 'placed-by-other') { out.other++; if (out.sample.length < 6) out.sample.push([w.x, w.y, w.z, w.got]) }
      else if (v === 'changed-since') { out.changed++; if (out.sample.length < 6) out.sample.push([w.x, w.y, w.z, w.got]) }
      else out.natural++
    }
    return out
  }
  // where may a bot never dig for this job: a no-dig area, or a block somebody built (not natural and not placed by the job itself)
  function diggable(x, y, z, got) {
    try { if (bot._ap && bot._ap.S && bot._ap.S.noDigAt && bot._ap.S.noDigAt({ x, y, z }, got && got.name)) return false } catch { /* ignore */ }
    const lg = bot._ledger; if (!lg || !lg.whoMade) return true
    try { const r = lg.whoMade({ x, y, z }, got && got.name); return !(r.verdict === 'placed-by-other' || (r.verdict === 'changed-since' && !r.wasOurs)) } catch { return true }
  }

  function startJob(o = {}) {
    if (job && job.state === 'building') return { ok: false, why: `already following ${job.id} (${job.pct != null ? job.pct + '%' : 'just started'}): finish or abandon it first`, job }
    const dirsNow = dirs()
    const pick = LP.choose({ kind: o.kind, id: o.id || null, explicit: !!o.explicit, dirs: dirsNow })
    if (!pick.ok) return { ok: false, why: pick.why }
    const s = pick.schematic
    let at = Array.isArray(o.at) && o.at.length >= 3 && o.at.slice(0, 3).every(Number.isFinite) ? o.at.slice(0, 3).map(Math.floor) : null
    let cost = null
    if (!at) {
      const near = Array.isArray(o.near) && o.near.length >= 3 && o.near.slice(0, 3).every(Number.isFinite) ? o.near : (bot.entity && bot.entity.position ? [Math.floor(bot.entity.position.x), Math.floor(bot.entity.position.y), Math.floor(bot.entity.position.z)] : null)
      if (!near) return { ok: false, why: 'no position to site the build near' }
      const get = liveGet()
      const box = { x0: near[0] - 30 - s.size[0], x1: near[0] + 30 + s.size[0], y0: near[1] - 32, y1: near[1] + s.size[1] + 2, z0: near[2] - 30 - s.size[2], z1: near[2] + 30 + s.size[2] }
      if (!grid.columnsLoaded(bot, box, 0)) return { ok: false, why: 'the chunks around the site are not loaded: go there first' }
      const r = FO.findAt(s, get, near, { radius: o.radius || 20, dy: o.dy || [-24, 0], step: 2, noDig: (x, y, z) => !diggable(x, y, z, get(x, y, z)), established: (x, y, z, got) => !diggable(x, y, z, got) })
      if (!r.ok) return { ok: false, why: r.why }
      at = r.at; cost = r.cost
    }
    job = { v: 1, id: s.id, name: s.name, kind: s.kind, at, reason: String(o.reason || pick.why).slice(0, 200), room: o.room || (s.kind + '-' + s.id).slice(0, 48), startedAt: now(), state: 'building', pct: null, off: null, bestOff: null, progressAt: now(), workedMs: 0, sinceProgressMs: 0, history: [], siteCost: cost, by: bot.username || null }
    saveJob()
    lesson(`following ${s.id} at ${at.join(',')}${cost != null ? ` (about ${cost} dig and place steps)` : ''}: ${job.reason}`)
    try { if (bot._journal) bot._journal.add('schematic', { ev: 'start', id: s.id, kindOf: s.kind, at, reason: job.reason }, { sal: true }) } catch { /* observer */ }
    return { ok: true, job, schematic: s }
  }

  // register a finished schematic build as a room whose blueprint is the schematic: brain/inspect then checks it cell by cell and brain/outcome counts its output
  function registerRoom(s) {
    try {
      const reg = readJson(registryFile); if (!reg) return
      const key = bot.spawnPoint ? `spawn ${Math.floor(bot.spawnPoint.x)},${Math.floor(bot.spawnPoint.z)}` : null
      const world = (key && reg.worlds && reg.worlds[key]) || (reg.worlds && Object.values(reg.worlds)[0]); if (!world) return
      world.rooms = world.rooms || []
      const rec = { id: job.room, type: s.kind, by: bot.username, box: boxOf(s, job.at), at: now(), schematic: s.id, viaSchematic: true, origin: job.at }
      const i = world.rooms.findIndex(r => r.id === rec.id); if (i >= 0) world.rooms[i] = { ...world.rooms[i], ...rec }; else world.rooms.push(rec)
      fs.writeFileSync(registryFile + '.tmp', JSON.stringify(reg, null, 1)); fs.renameSync(registryFile + '.tmp', registryFile)
    } catch { /* the job file still says it is complete */ }
    writeFarmConfig(s)
  }
  // A farm schematic that names its anchors (kill spot, kill box, chests: world cells as captured) gives the kill routine (brain/autopilot/mobfarm.js) what the geometry
  // builder used to write into brain/state/mobfarm.json, moved by however far the build was placed from where it was captured. Without anchors nothing is written and the
  // lesson says so: the farm stands, but the bot has no kill spot for it yet.
  function writeFarmConfig(s) {
    if (s.kind !== 'mobfarm') return
    if (!s.anchors || !s.anchors.killSpot) { lesson(`${s.id}: complete, but the schematic has no kill spot anchor, so the kill routine has no config for this farm`); return }
    const d = [job.at[0] - s.origin[0], job.at[1] - s.origin[1], job.at[2] - s.origin[2]]
    const mv = (c) => [c[0] + d[0], c[1] + d[1], c[2] + d[2]]
    const a = s.anchors, kb = a.killBox
    const cfg = { builder: 'schematic', schematic: s.id, world: bot.spawnPoint ? `spawn ${Math.floor(bot.spawnPoint.x)},${Math.floor(bot.spawnPoint.z)}` : null, built: now(),
      killSpot: mv(a.killSpot), killBox: kb ? { x0: kb.x0 + d[0], x1: kb.x1 + d[0], y0: kb.y0 + d[1], y1: kb.y1 + d[1], z0: kb.z0 + d[2], z1: kb.z1 + d[2] } : null,
      chests: (a.chests || []).map(mv), overflow: [], overflowSpots: [], rest: a.rest ? mv(a.rest) : null }
    try {
      const f = api.statePath('mobfarm.json'), old = readJson(f)
      if (old && old.builder !== 'schematic') fs.writeFileSync(api.statePath('mobfarm.old.json'), JSON.stringify(old, null, 1))
      if (old && old.builder === 'schematic') { cfg.overflow = old.overflow || []; cfg.overflowSpots = old.overflowSpots || [] }
      fs.writeFileSync(f, JSON.stringify(cfg, null, 1))
    } catch { /* the lesson below still says what happened */ }
  }

  let lastVerifiedState = null
  function verify() {
    if (!job || job.state === 'abandoned') return null
    const r = progress(job.id, job.at, { max: 4000 })
    if (!r.ok) return { ok: false, why: r.why }
    const t = now(), prevState = job.state
    job.pct = r.pct; job.off = r.off; job.unknown = r.unknown; job.lastVerifyAt = t; job.counts = r.counts; job.attribution = r.attribution || null
    job.lastWrong = r.work.slice(0, 12).map(w => `${w.x},${w.y},${w.z} ${w.kind}: want ${w.want}, got ${w.got}`)
    if (r.verified && (job.bestOff == null || r.off < job.bestOff)) { job.bestOff = r.off; job.progressAt = t; job.sinceProgressMs = 0 }
    const h = job.history[job.history.length - 1]
    if (r.verified && (!h || h.off !== r.off || t - h.t > 30 * 60000)) { job.history.push({ t, pct: r.pct, off: r.off }); if (job.history.length > 60) job.history.splice(0, job.history.length - 60) }
    if (r.complete) { job.state = 'complete'; job.completedAt = job.completedAt || t }
    else if (job.state === 'complete') job.state = 'building'                  // somebody changed it again: it is not complete any more
    else if (job.sinceProgressMs >= STUCK_MS) job.state = 'stuck'
    else if (job.state === 'stuck' && job.sinceProgressMs < STUCK_MS) job.state = 'building'
    saveJob()
    if (job.state !== prevState || (lastVerifiedState == null && job.state !== 'building')) {
      const s = loadSchem(job.id)
      if (job.state === 'complete') { if (s) registerRoom(s); lesson(`${job.id}: complete, every checked cell matches (${r.checked} cells).`) }
      else if (job.state === 'stuck') lesson(`${job.id}: stuck at ${r.pct}% (${FO.summary(r)}); first off: ${job.lastWrong.slice(0, 3).join(' | ')}`)
      else lesson(`${job.id}: ${job.state} at ${r.pct}%.`)
      try { if (bot._journal) bot._journal.add('schematic', { ev: 'state', id: job.id, kindOf: job.kind, state: job.state, pct: r.pct, off: r.off, counts: r.counts, wrong: job.lastWrong.slice(0, 6), foreign: r.attribution ? r.attribution.other + r.attribution.changed : null }, { sal: job.state !== 'building' }) } catch { /* observer */ }
    }
    lastVerifiedState = job.state
    return { ok: true, state: job.state, pct: r.pct, off: r.off, counts: r.counts, complete: r.complete, progress: r }
  }
  const noteWork = (ms) => { if (job && job.state !== 'complete' && job.state !== 'abandoned') { job.workedMs = (job.workedMs || 0) + ms; job.sinceProgressMs = (job.sinceProgressMs || 0) + ms; saveJob() } }
  function abandon(why) {
    if (!job) return { ok: false, why: 'no job' }
    job.state = 'abandoned'; job.why = String(why || '').slice(0, 200); job.endedAt = now(); saveJob()
    lesson(`abandoned ${job.id} at ${job.pct != null ? job.pct + '%' : 'the start'}: ${job.why || 'no reason given'}`)
    try { if (bot._journal) bot._journal.add('schematic', { ev: 'state', id: job.id, kindOf: job.kind, state: 'abandoned', pct: job.pct, why: job.why }, { sal: true }) } catch { /* observer */ }
    return { ok: true }
  }
  // a finished or abandoned job can be cleared so the next decision starts clean
  const clearJob = () => { if (job && (job.state === 'complete' || job.state === 'abandoned')) { job = null; try { fs.unlinkSync(jobFile) } catch { /* gone */ } return true } return false }
  const jobView = () => (job ? { ...job } : null)

  let vtimer = null
  bot._schematic = { v: 2, capture, diff, list, dirs, progress, startJob, verify, job: jobView, noteWork, abandon, clearJob, attribute, diggable, load: loadSchem, policy: LP.policy, candidates: (kind) => LP.candidates(kind, dirs()) }
  return {
    name: 'schematic',
    start() { vtimer = setInterval(() => { if (job && job.state !== 'abandoned') { try { verify() } catch (e) { if (api.log) api.log('schematic', 'verify failed: ' + e.message) } } }, 5 * 60000); if (vtimer.unref) vtimer.unref() },
    stop() { clearInterval(vtimer); if (bot._schematic && bot._schematic.v === 2) delete bot._schematic },
    status() { return { schematics: list().length, job: job ? { id: job.id, state: job.state, pct: job.pct } : null } },
    _capture: capture, _diff: diff, _verify: verify, _start: startJob,
  }
}
module.exports.meta = require('./meta.json')
