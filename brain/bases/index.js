// brain/bases: which waypoints are bases, and what the bots dig inside them. An observer: it listens, it never moves the bot or touches the world.
// (Walter 2026-11-11: "a page in the app where you select between bases, identified by waypoint, and see the base as a cast, like metal poured into an
// ant farm". The bots recorded what they placed (brain/placed.js) and their rooms and shafts (the registry) but not what they dug, and nothing said
// which of it belonged to a base. This records both.)
//
//   Base list: the waypoints named in config.json `bases` ("Chicago") are looked up in the nav module's waypoint book (Xaero and waypoints.json) and
//   written to bot-shared/bases.json with a radius, per world (the registry's world key, spawn x,z). Re-read every 5 minutes; a moved waypoint updates
//   the record, a missing one leaves the old record alone.
//   Dug log: every block this bot finishes digging (mineflayer 'diggingCompleted') inside a base circle is appended to bot-shared/base-dug/<base id>.jsonl as
//   [x, y, z, block, bot, time]. Trees, plants, light and anything the bot placed itself are left out (lib.digLine), digs outside every base are not logged.
//   bot._bases = { list(), at(pos) } for code that wants to know which base a position is in.
//
// The dashboard turns these (plus the registry's shafts and rooms and the placed-block log) into the cast: dashboard/basecast.js.
'use strict'
const fs = require('fs')
const path = require('path')
const lib = require('./lib')
const config = require('./config.json')

const SHARED = process.env.BOT_BASES_DIR || path.join(__dirname, '..', '..', '..', 'bot-shared')

const readJson = (f, d = null) => { try { return JSON.parse(fs.readFileSync(f, 'utf8').replace(/^﻿/, '')) } catch { return d } }
const safeRename = (tmp, dst) => { try { fs.renameSync(tmp, dst) } catch (e) { if (!/EPERM|EBUSY|EACCES/.test(String(e.code || e.message))) throw e; fs.writeFileSync(dst, fs.readFileSync(tmp)); fs.unlinkSync(tmp) } }

module.exports = function register(api) {
  const { bot } = api
  const now = () => (api.now ? api.now() : Date.now())
  const log = (m) => { try { api.log && api.log('BASES', m) } catch {} }
  const cfg = config
  const ignoreRe = cfg.ignore ? new RegExp(cfg.ignore) : null
  const dir = SHARED
  const basesFile = path.join(dir, 'bases.json'), dugDir = path.join(dir, 'base-dug')
  let bases = [], world = 'unknown', syncT = null, flushT = null, started = 0
  const pending = new Map()           // base id -> lines
  const counts = {}

  const worldKey = () => { const sp = bot.spawnPoint; return sp ? `spawn ${Math.floor(sp.x)},${Math.floor(sp.z)}` : 'unknown' }
  const norm = (s) => lib.slug(s)

  function waypointBook() { return api.nav && api.nav.book ? api.nav.book : null }
  function loadBases() {
    world = worldKey()
    const f = readJson(basesFile, { worlds: {} })
    bases = (((f.worlds || {})[world] || {}).bases || []).filter(b => Number.isFinite(b.x) && Number.isFinite(b.z) && b.radius > 0)
  }
  function sync() {
    try {
      const book = waypointBook()
      if (!book) return
      world = worldKey()
      if (world === 'unknown') return
      book.load(true)
      let f = readJson(basesFile, { worlds: {} }), changed = false
      for (const name of cfg.bases || []) {
        const w = book.all(0).find(x => norm(x.name) === norm(name))
        if (!w) continue
        const y = typeof w.y === 'number' ? w.y : 64
        const r = lib.mergeBase(f, world, { id: lib.baseId(w.name, world), name: w.name, x: w.x, y, z: w.z, radius: cfg.radius, save: (book.xaeroWorld && book.xaeroWorld()) || null, source: 'waypoint', at: now() })
        f = r.file; changed = changed || r.changed
      }
      if (changed) {
        fs.mkdirSync(dir, { recursive: true })
        const tmp = basesFile + '.' + (bot.username || 'bot') + '.tmp'
        fs.writeFileSync(tmp, JSON.stringify(f, null, 1)); safeRename(tmp, basesFile)
        log('base record updated: ' + ((f.worlds[world] || {}).bases || []).map(b => `${b.name} (${b.x},${b.z} r${b.radius})`).join(', '))
      }
      loadBases()
    } catch (e) { log('sync: ' + e.message) }
  }

  const onDug = (block) => {
    try {
      if (!block || !block.position || !bases.length) return
      const b = lib.baseAt(bases, block.position)
      if (!b) return
      const line = lib.digLine(block, bot.username, now(), ignoreRe, bot._placed && bot._placed.at ? (p, n) => !!bot._placed.at(p, n) : null)
      if (!line) return
      let a = pending.get(b.id); if (!a) pending.set(b.id, a = [])
      a.push(line); counts[b.id] = (counts[b.id] || 0) + 1
    } catch { /* a bad block is not worth a crash */ }
  }
  function flush() {
    if (!pending.size) return
    try { fs.mkdirSync(dugDir, { recursive: true }) } catch {}
    for (const [id, lines] of pending) {
      try { fs.appendFileSync(path.join(dugDir, id + '.jsonl'), lines.join('\n') + '\n') } catch (e) { log('dug log write failed: ' + e.message); continue }
      pending.delete(id)
    }
  }

  bot._bases = { list: () => bases.slice(), at: (p) => lib.baseAt(bases, p) }
  return {
    name: 'bases',
    start() {
      started = now()
      loadBases()
      sync()
      bot.on('diggingCompleted', onDug)
      bot.on('spawn', sync)
      syncT = setInterval(sync, cfg.syncMs); if (syncT.unref) syncT.unref()
      flushT = setInterval(flush, cfg.flushMs); if (flushT.unref) flushT.unref()
    },
    stop() {
      clearInterval(syncT); clearInterval(flushT)
      bot.removeListener('diggingCompleted', onDug); bot.removeListener('spawn', sync)
      flush()
    },
    status() { return { since: started, world, bases: bases.map(b => ({ id: b.id, name: b.name, x: b.x, z: b.z, radius: b.radius })), dugThisRun: { ...counts } } },
    _tick: { sync, flush, onDug, pending: () => pending }
  }
}
module.exports.meta = require('./meta.json')
