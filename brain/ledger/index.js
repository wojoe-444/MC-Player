// brain/ledger: the provenance ledger, an observer. Every block a bot of ours digs or places is recorded at the moment it happens, with which bot, when, which job
// (via) and which named space or structure it belongs to (shaft, room, mob farm, tree farm, pen, crop plot). Walter 2026-11-11: "every space should be tracked as
// it's built. Imagine an enderman places a block: it should be a quick code scan to confirm you didn't place it."
//
// How it sees things (three layers, so no code path can slip past):
//   1. the wire:    bot._client.write('block_dig' | 'block_place' | 'use_item') is wrapped, so even a raw packet dig (autopilot/mining.js) leaves an intent behind
//                   (position, time, the job's declared space from brain/ledger/scope.js);
//   2. the server:  every 'blockUpdate' in a loaded chunk is classified: a change that matches one of our intents is ours (dug / placed); a solid block that
//                   appears with no intent of ours is 'f' (someone else: an enderman, Walter, a flow...); one of our own records changed from outside is 'x';
//   3. mineflayer:  'diggingCompleted' and 'blockPlaced' are recorded directly too (they carry the exact block), duplicates are dropped.
// The space of a cell is, in order: the scope the job declared (within({id, kind}, fn)), else the registry geometry (shafts and rooms, brain/autopilot/ladder.js),
// else null. A new registry record also claims the unassigned cells inside its box (reconcile), so a room dug before it was registered is still the room's.
//
// Files: bot-shared/ledger/<world hash>/<bot>.jsonl (format in lib.js), one writer per file, every bot reads all of them. Nothing here moves the bot or touches a block.
// bot._ledger = { whoMade(pos), isOurs(pos), at(pos), spaceAt(pos), near, inBox, inSpace, spaces, audit, claim, declare, within, stats, ... }  (README.md)
'use strict'
const fs = require('fs')
const path = require('path')
const lib = require('./lib')
const scope = require('./scope')
const placedLog = require('../placed')
const config = require('./config.json')
const { Vec3 } = require('vec3')

const SHARED = process.env.BOT_LEDGER_DIR || path.join(__dirname, '..', '..', '..', 'bot-shared', 'ledger')
const REGISTRY = process.env.BOT_REGISTRY || path.join(__dirname, '..', '..', '..', 'bot-shared', 'registry.json')
const FACES = [[0, -1, 0], [0, 1, 0], [0, 0, -1], [0, 0, 1], [-1, 0, 0], [1, 0, 0]]
const AIR = /^(air|cave_air|void_air)$/
const FLUID = /^(water|lava)$/
const readJson = (f, d = null) => { try { return JSON.parse(fs.readFileSync(f, 'utf8').replace(/^﻿/, '')) } catch { return d } }
const isSource = (b) => { try { const p = b.getProperties && b.getProperties(); if (p && p.level != null) return Number(p.level) === 0 } catch {} return b.metadata == null || b.metadata === 0 }
const num = (v) => Math.floor(Number(v))

module.exports = function register(api) {
  const { bot } = api
  const now = () => (api.now ? api.now() : Date.now())
  const log = (m) => { try { api.log && api.log('LEDGER', m) } catch {} }
  const skipDug = new RegExp(config.skipDug), skipForeign = new RegExp(config.skipForeign)
  const me = () => bot.username
  const via = () => { try { const r = api.scheduler && api.scheduler.running; return r && r.name ? r.name : null } catch { return null } }

  const store = new lib.Store()
  for (const b of config.bots || []) store.bots.add(b)
  let journal = null, world = null, defs = [], intents = new Map(), declared = new Set(), foreignBudget = { t: 0, n: 0 }
  let timers = [], wrapped = null, started = 0, lastRegistryStat = '', counts = { p: 0, d: 0, r: 0, f: 0, x: 0, claimed: 0 }

  const worldKey = () => { const sp = bot.spawnPoint; return sp ? `spawn ${Math.floor(sp.x)},${Math.floor(sp.z)}` : null }
  const posOf = (p) => ({ x: num(p.x), y: num(p.y), z: num(p.z) })
  const k3 = (p) => `${p.x},${p.y},${p.z}`

  // ---------- opening the world's ledger ----------
  function open() {
    const w = worldKey()
    if (!w || (journal && w === world)) return !!journal
    if (journal) { try { journal.flush() } catch {} }
    world = w
    store.cells.clear(); store.cols.clear(); store.spaces.clear(); store.bySpace.clear(); store.writers.clear()
    for (const b of config.bots || []) store.bots.add(b)
    journal = new lib.Journal({ dir: path.join(SHARED, lib.worldHash(world)), writer: me() || 'bot', now, log })
    journal.load(store)
    const imported = lib.importPlaced(store, placedLog.FILE, world)
    if (!store.writers.has(me())) { const rec = { t: now(), op: 'B', by: me() }; store.apply(rec); journal.append(rec) }
    store.bots.add(me())
    if (journal.lines > config.compactAfter && journal.lines > 3 * store.size) log(`compacted own file to ${journal.compact(store)} lines`)
    log(`ledger open for ${world}: ${store.size} cells, ${store.spaces.size} spaces${imported ? `, ${imported} older placed-log entries imported` : ''}`)
    reconcile()
    return true
  }

  // ---------- spaces ----------
  function declare(sp, by) {
    if (!sp || !sp.id || declared.has(sp.id)) return
    declared.add(sp.id)
    const old = store.spaces.get(sp.id)
    if (old && (!sp.kind || old.kind === sp.kind) && (!sp.label || old.label === sp.label)) return
    const rec = { t: now(), op: 'S', block: sp.kind || null, by: by || me(), space: sp.id, via: sp.label || null }
    if (store.apply(rec) && journal) journal.append(rec)
  }
  const geoSpace = (p) => lib.spaceAt(defs, p.x, p.y, p.z)

  // registry -> geometry, and claim what no job declared. Cheap when nothing changed (one stat).
  const stateFiles = () => ({ treefarm: 'treefarm-state.json', husbandry: 'husbandry-state.json', autopilot: 'autopilot-state.json' })
  function reconcile(force = false) {
    if (!journal) return 0
    let sig = ''
    const files = [REGISTRY, ...Object.values(stateFiles()).map(f => api.statePath(f))]
    for (const f of files) { try { const st = fs.statSync(f); sig += st.mtimeMs + ':' + st.size + ';' } catch { sig += '-;' } }
    if (!force && sig === lastRegistryStat) return 0
    lastRegistryStat = sig
    const reg = readJson(REGISTRY, null), st = {}
    for (const [name, f] of Object.entries(stateFiles())) st[name] = readJson(api.statePath(f), null)
    defs = (reg && reg.worlds && reg.worlds[world] ? lib.defsFromRegistry(reg.worlds[world]) : []).concat(lib.defsFromState(st))
    let n = 0
    for (const d of defs.slice().sort((a, b) => lib.vol(a.box) + (a.kind === 'shaft' ? 1e9 : 0) - lib.vol(b.box) - (b.kind === 'shaft' ? 1e9 : 0))) {
      declare(d)
      n += claim({ id: d.id, box: d.box }, true)
    }
    return n
  }

  // Put every unassigned cell inside `box` (recorded before the space was known) into the space `id`. `since` limits it to records newer than that time.
  function claim(o, quiet = false) {
    if (!journal || !o || !o.id || !o.box) return 0
    if (!quiet) declare({ id: o.id, kind: o.kind, label: o.label })
    let n = 0
    for (const c of store.inBox(o.box)) {
      if (c.space || (o.since && c.t < o.since)) continue
      const rec = { t: c.t, op: c.op, x: c.x, y: c.y, z: c.z, block: c.block, by: c.by, space: o.id, via: c.via }
      if (store.apply(rec, me())) { journal.append(rec); n++ }
    }
    counts.claimed += n
    return n
  }

  // ---------- recording ----------
  function put(op, p, block, by, ctx, t = now()) {
    if (!journal && !open()) return null
    const sp = (ctx && ctx.space && ctx.space.id) ? ctx.space : geoSpace(p)
    if (sp) declare(sp, by)
    const rec = { t, op, x: p.x, y: p.y, z: p.z, block, by, space: sp ? sp.id : null, via: (ctx && ctx.via) || via() }
    if (!store.apply(rec, me())) return null
    journal.append(rec); counts[op] = (counts[op] || 0) + 1
    return rec
  }
  // digging out a block somebody placed returns the cell to what it was: 'r' (removed), not 'd' (dug): it hollows nothing
  const dugOp = (p, block) => { const c = store.get(p.x, p.y, p.z); return c && (c.op === 'p' || c.op === 'f') && c.block === block ? 'r' : 'd' }
  const recentDig = (p, block) => recent(p, 'd', block, me()) || recent(p, 'r', block, me())
  const recent = (p, op, block, by, ms = 3000) => { const c = store.get(p.x, p.y, p.z); return !!c && c.op === op && c.by === by && c.block === block && now() - c.t < ms }

  // ---- the wire ----
  function intent(kind, p, ttl) {
    intents.set(kind + ':' + k3(p), { t: now(), ttl, space: scope.current(), via: via() })
    if (intents.size > 600) for (const [kk, v] of intents) if (now() - v.t > v.ttl) intents.delete(kk)
  }
  function take(kind, p) {
    const kk = kind + ':' + k3(p), v = intents.get(kk)
    if (!v) return null
    if (now() - v.t > v.ttl) { intents.delete(kk); return null }
    return v
  }
  function onWrite(name, params) {
    if (!params) return
    if (name === 'block_dig') {
      if (!params.location) return
      const p = posOf(params.location)
      if (params.status === 0 || params.status === 2) intent('dig', p, config.digTtlMs)
      else if (params.status === 1) intents.delete('dig:' + k3(p))        // cancelled before it broke
    } else if (name === 'block_place') {
      if (!params.location) return
      const p = posOf(params.location), f = FACES[params.direction] || [0, 0, 0]
      intent('place', p, config.placeTtlMs); intent('place', { x: p.x + f[0], y: p.y + f[1], z: p.z + f[2] }, config.placeTtlMs)
    } else if (name === 'use_item') {
      const e = bot.entity && bot.entity.position
      if (e) { const p = posOf(e); intents.set('use:' + k3(p), { t: now(), ttl: config.useTtlMs, space: scope.current(), via: via(), at: e }); intents.set('use:last', intents.get('use:' + k3(p))) }
    }
  }
  function wrapClient() {
    const c = bot._client
    if (!c || typeof c.write !== 'function' || c.__ledgerWrapped) return
    const orig = c.write
    const mine = function (name, params, ...rest) { try { onWrite(name, params) } catch { /* never in the way of a packet */ } return orig.call(this, name, params, ...rest) }
    mine.__orig = orig
    c.write = mine; c.__ledgerWrapped = true; wrapped = c
  }
  function unwrapClient() { const c = wrapped; if (c && c.write && c.write.__orig) { c.write = c.write.__orig; c.__ledgerWrapped = false } wrapped = null }

  // ---- other players: who swung an arm lately, to put a name on a foreign block ----
  const swings = new Map()
  const onSwing = (e) => { if (e && e.type === 'player' && e.username && !store.isOurs(e.username)) swings.set(e.username, { t: now(), e }) }
  function swinger(p) {
    const t = now()
    for (const [name, s] of swings) {
      if (t - s.t > 700) continue
      const pe = (bot.players && bot.players[name] && bot.players[name].entity) || s.e
      if (pe && pe.position && Math.hypot(pe.position.x - p.x - 0.5, pe.position.y - p.y - 0.5, pe.position.z - p.z - 0.5) <= 6) return name
    }
    return null
  }

  // ---- the server: every block change in a loaded chunk ----
  function onUpdate(oldB, newB) {
    try {
      if (!newB || !newB.position || !journal) { if (!journal && newB && newB.position) open(); if (!journal) return }
      const oldName = oldB && oldB.name, newName = newB.name
      if (oldName === newName) return                                                  // a state change (crop age, water level), not a different block
      const p = posOf(newB.position)
      if (AIR.test(newName)) {                                                         // something went away
        if (!oldName || AIR.test(oldName)) return
        const d = take('dig', p)
        if (d) { intents.delete('dig:' + k3(p)); if (!skipDug.test(oldName) && !recentDig(p, oldName)) put(dugOp(p, oldName), p, oldName, me(), d); return }
        const c = store.get(p.x, p.y, p.z)
        if (c && (c.op === 'p' || c.op === 'f') && c.block === oldName) put('x', p, newName, 'other', null)       // ours (or someone's) went away without us
        else if (FLUID.test(oldName) && isSource(oldB)) { const u = intents.get('use:last'); if (u && now() - u.t <= u.ttl && u.at && Math.hypot(u.at.x - p.x, u.at.y - p.y, u.at.z - p.z) <= 8 && !recentDig(p, oldName)) put(dugOp(p, oldName), p, oldName, me(), u) }
        return
      }
      // something appeared (or one block was swapped for another)
      if (FLUID.test(newName)) {
        if (!isSource(newB)) return                                                    // a flow spreading is not a placement
        const u = intents.get('use:last')
        if (u && now() - u.t <= u.ttl && u.at && Math.hypot(u.at.x - p.x, u.at.y - p.y, u.at.z - p.z) <= 8) { if (!recent(p, 'p', newName, me())) put('p', p, newName, me(), u) }
        return
      }
      const pl = take('place', p)
      if (pl && (AIR.test(oldName || 'air') || placedLog.SOFT.test(oldName || 'air'))) { intents.delete('place:' + k3(p)); if (!recent(p, 'p', newName, me())) put('p', p, newName, me(), pl); return }
      const c = store.get(p.x, p.y, p.z)
      if (c && c.op === 'p' && c.block === newName) return                              // the same block again (a re-send), nothing new
      if (c && (c.op === 'p' || c.op === 'f') && c.block !== newName) { put('x', p, newName, 'other', null); return }   // one of our blocks was swapped
      if (placedLog.NOT_BUILDS.test(newName) || placedLog.naturalChange(oldName || 'air', newName)) return
      if (!(AIR.test(oldName || 'air') || placedLog.SOFT.test(oldName || 'air')) || skipForeign.test(newName)) return
      const t = now(); if (t - foreignBudget.t > 300000) foreignBudget = { t, n: 0 }
      if (foreignBudget.n++ >= config.foreignPer5Min) return
      put('f', p, newName, swinger(p) || 'other', null)                                // appeared and none of our bots placed it
    } catch (e) { log('onUpdate: ' + e.message) }
  }

  // ---- mineflayer's own word (carries the exact block): same record, deduplicated ----
  function onDug(block) {
    try {
      if (!block || !block.position || !block.name || AIR.test(block.name) || skipDug.test(block.name)) return
      if (!journal && !open()) return
      const p = posOf(block.position), d = take('dig', p)
      if (d) intents.delete('dig:' + k3(p))
      if (!recentDig(p, block.name)) put(dugOp(p, block.name), p, block.name, me(), d || { space: scope.current(), via: via() })
    } catch (e) { log('onDug: ' + e.message) }
  }
  function onPlaced(oldB, newB) {
    try {
      if (!newB || !newB.position || !newB.name || AIR.test(newB.name)) return
      if (!journal && !open()) return
      const p = posOf(newB.position), pl = take('place', p)
      if (pl) intents.delete('place:' + k3(p))
      if (!recent(p, 'p', newB.name, me())) put('p', p, newB.name, me(), pl || { space: scope.current(), via: via() })
    } catch (e) { log('onPlaced: ' + e.message) }
  }

  // ---------- the questions ----------
  const blockName = (p) => { try { const b = bot.blockAt && bot.blockAt(new Vec3(num(p.x), num(p.y), num(p.z)), false); return b ? b.name : null } catch { return null } }
  const P = (p) => { const q = posOf(p); return q }
  function whoMade(pos, current) {
    const p = P(pos), cur = current === undefined ? blockName(p) : current
    const v = store.whoMade(p.x, p.y, p.z, cur, me())
    // Walter's (or anyone's) block: the older placed-block log may have put a name on it
    if (!v.ours && v.verdict !== 'dug-by-us' && bot._placed && bot._placed.at) { try { const r = bot._placed.at(p, cur || undefined); if (r && !store.isOurs(r.by) && (!v.by || v.by === 'other')) { v.by = r.by; v.why = `${r.name} was placed by ${r.by} (placed-block log)` } } catch {} }
    return v
  }
  const api2 = {
    v: 1,
    whoMade, scope,
    isOurs: (pos, current) => !!whoMade(pos, current).ours,
    at: (pos) => { const p = P(pos), c = store.get(p.x, p.y, p.z); return c ? { ...c } : null },
    spaceAt: (pos) => { const p = P(pos), c = store.get(p.x, p.y, p.z); if (c && c.space) return c.space; const g = geoSpace(p); return g ? g.id : null },
    near: (pos, r) => store.near(P(pos), r).map(c => ({ ...c })),
    inBox: (box) => store.inBox(box).map(c => ({ ...c })),
    inSpace: (id) => store.inSpace(id).map(c => ({ ...c })),
    spaces: () => store.summary(),
    space: (id) => store.summary(id)[0] || null,
    audit: (box, read) => store.audit(box, read || ((x, y, z) => blockName({ x, y, z }))),
    claim, declare, within: scope.within, reconcile: () => reconcile(true),
    coverageFrom: () => store.coverageFrom(),
    stats: () => ({ world, cells: store.size, spaces: store.spaces.size, bots: [...store.bots], writers: Object.fromEntries(store.writers), coverageFrom: store.coverageFrom(), thisRun: { ...counts } }),
    save: () => { if (journal) journal.flush() },
    _store: store, _tick: { onUpdate, onDug, onPlaced, onWrite, open, reconcile, refresh: () => journal && journal.load(store), flush: () => journal && journal.flush(), intents: () => intents, defs: () => defs },
  }
  bot._ledger = api2

  function writeSummary() {
    try {
      if (!journal) return
      const out = { updatedAt: new Date(now()).toISOString(), world, cells: store.size, coverageFrom: store.coverageFrom(), spaces: store.summary().map(s => ({ ...s })) }
      fs.mkdirSync(path.dirname(api.statePath('x')), { recursive: true })
      fs.writeFileSync(api.statePath('ledger-summary.json'), JSON.stringify(out))
    } catch { /* a summary is a convenience */ }
  }

  return {
    name: 'ledger',
    start() {
      started = now()
      open(); wrapClient()
      bot.on('blockUpdate', onUpdate); bot.on('diggingCompleted', onDug); bot.on('blockPlaced', onPlaced); bot.on('entitySwingArm', onSwing)
      bot.on('spawn', () => { open(); wrapClient() })
      const every = (fn, ms) => { const t = setInterval(() => { try { fn() } catch (e) { log(e.message) } }, ms); if (t.unref) t.unref(); timers.push(t) }
      every(() => { journal && journal.flush(); wrapClient() }, config.flushMs)
      every(() => { journal && journal.load(store) }, config.refreshMs)
      every(() => { reconcile(); writeSummary() }, config.reconcileMs)
    },
    stop() {
      for (const t of timers) clearInterval(t); timers = []
      bot.removeListener('blockUpdate', onUpdate); bot.removeListener('diggingCompleted', onDug); bot.removeListener('blockPlaced', onPlaced); bot.removeListener('entitySwingArm', onSwing)
      unwrapClient(); try { journal && journal.flush() } catch {}
    },
    status() { return { since: started, world, cells: store.size, spaces: store.spaces.size, coverageFrom: store.coverageFrom(), thisRun: { ...counts } } },
    _tick: api2._tick,
  }
}
module.exports.meta = require('./meta.json')
