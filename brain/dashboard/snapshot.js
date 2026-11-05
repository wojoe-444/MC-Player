// Builds the JSON snapshot the dashboard serves (and writes to status.json). Read-only: it only looks at the bot object,
// api.status.all() and a few state files. Every source is optional; a missing one just leaves its section empty.
const fs = require('fs')
const path = require('path')

const stripBom = (s) => s.replace(/^﻿/, '')

// Parsed-JSON cache keyed by file path, invalidated by mtime+size, so polling every 2 s does not re-parse chest-index.json.
class FileCache {
  constructor() { this.m = new Map() }
  json(file) {
    try {
      const st = fs.statSync(file)
      const c = this.m.get(file)
      if (c && c.mtimeMs === st.mtimeMs && c.size === st.size) return c
      const value = JSON.parse(stripBom(fs.readFileSync(file, 'utf8')))
      const e = { value, mtimeMs: st.mtimeMs, size: st.size }
      this.m.set(file, e)
      return e
    } catch { return null }
  }
}

const num = (v, d = null) => (typeof v === 'number' && isFinite(v) ? v : d)
const round1 = (v) => (typeof v === 'number' && isFinite(v) ? Math.round(v * 10) / 10 : null)

function gameClock(ticks) {
  if (typeof ticks !== 'number') return null
  const h = (Math.floor(ticks / 1000) + 6) % 24, m = Math.floor(((ticks % 1000) / 1000) * 60)
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`
}

function botSection(bot, now) {
  if (!bot) return { online: false }
  const e = bot.entity
  const held = bot.heldItem
  return {
    online: !!e,
    username: bot.username || null,
    pos: e && e.position ? { x: round1(e.position.x), y: round1(e.position.y), z: round1(e.position.z) } : null,
    yawDeg: e && num(e.yaw) !== null ? Math.round(((e.yaw * 180) / Math.PI + 360) % 360) : null,
    pitchDeg: e && num(e.pitch) !== null ? Math.round((e.pitch * 180) / Math.PI) : null,
    dimension: (bot.game && bot.game.dimension) || null,
    gameMode: (bot.game && bot.game.gameMode) || null,
    health: num(bot.health), food: num(bot.food), saturation: num(bot.foodSaturation),
    xpLevel: num(bot.experience && bot.experience.level),
    isSleeping: !!bot.isSleeping,
    gameDay: bot.time ? num(bot.time.day) : null,
    gameClock: bot.time ? gameClock(bot.time.timeOfDay) : null,
    held: held ? { name: held.name, count: held.count } : null,
    holdingLava: !!(held && held.name === 'lava_bucket'),
    onGround: e ? !!e.onGround : null
  }
}

function inventorySection(bot) {
  let items = []
  try { items = bot && bot.inventory ? bot.inventory.items() : [] } catch { items = [] }
  const totals = new Map()
  for (const it of items) {
    if (!it || !it.name) continue
    const t = totals.get(it.name) || { name: it.name, displayName: it.displayName || it.name, count: 0, stacks: 0 }
    t.count += it.count || 0; t.stacks++
    totals.set(it.name, t)
  }
  return { stacks: items.length, items: [...totals.values()].sort((a, b) => b.count - a.count || a.name.localeCompare(b.name)) }
}

function normLine(e, defaults = {}) {
  if (e == null) return null
  if (typeof e === 'string') return { ...defaults, text: e }
  const text = e.text ?? e.msg ?? e.message
  if (text == null) return null
  return { ...defaults, t: num(e.t ?? e.at ?? e.time), from: e.user ?? e.from ?? e.name ?? e.tag ?? defaults.from, text: String(text) }
}

function tailFile(file, bytes = 6000) {
  try {
    const fd = fs.openSync(file, 'r')
    try {
      const size = fs.fstatSync(fd).size, len = Math.min(size, bytes), buf = Buffer.alloc(len)
      fs.readSync(fd, buf, 0, len, size - len)
      const lines = buf.toString('utf8').split(/\r?\n/).filter(Boolean)
      if (size > len) lines.shift()          // first line is probably cut
      return lines
    } finally { fs.closeSync(fd) }
  } catch { return [] }
}

function chatSection(all, dir, ring) {
  let lines = (Array.isArray(all.chatTail) ? all.chatTail : []).map(e => normLine(e)).filter(Boolean)
  if (!lines.length) lines = ring.map(e => ({ ...e }))
  if (!lines.length) {
    lines = tailFile(path.join(dir, 'chat.log')).map(l => {
      const m = /^([^:]{1,32}): (.*)$/.exec(l)
      return m ? { from: m[1], text: m[2] } : { text: l }
    })
  }
  return lines.slice(-40)
}

function chestsSection(dir, cache) {
  const st = cache.json(path.join(dir, 'stations.json'))
  const ci = cache.json(path.join(dir, 'chest-index.json'))
  const summarize = (c) => {
    if (!c) return null
    if (c.error) return { error: String(c.error) }
    const items = c.items || {}
    return { slots: num(c.slots), used: num(c.used, Object.keys(items).length), items, scannedAt: num(c.at) }
  }
  const stations = []
  if (st && Array.isArray(st.value)) {
    for (const s of st.value) {
      stations.push({
        station: s.station, furnaces: s.furnaces || [],
        chests: (s.chests || []).map(c => ({ at: c.at, ...summarize(c) }))
      })
    }
  }
  const index = []
  if (ci && ci.value && typeof ci.value === 'object') {
    for (const [at, c] of Object.entries(ci.value).slice(0, 800)) index.push({ at, ...summarize(c) })
  }
  return {
    stations, stationsScannedAt: st ? Math.round(st.mtimeMs) : null,
    index, indexUpdatedAt: ci ? Math.round(ci.mtimeMs) : null,
    indexed: index.length, indexErrors: index.filter(c => c.error).length
  }
}

function povSection(povPath) {
  try {
    const st = fs.statSync(povPath)
    return { exists: true, mtimeMs: Math.round(st.mtimeMs), size: st.size }
  } catch { return { exists: false } }
}

function build({ api, dir, povPath, cache, ring, startedAt, port }) {
  const now = api && api.now ? api.now() : Date.now()
  let all = {}
  try { all = (api && api.status && api.status.all && api.status.all()) || {} } catch (e) { all = { error: e.message } }
  const bot = api && api.bot
  const base = botSection(bot, now)
  // anything status.all().bot knows that the live bot object did not give us (e.g. a custom task label)
  const extra = all.bot && typeof all.bot === 'object' ? all.bot : {}
  const sched = all.scheduler || (api && api.scheduler && api.scheduler.status && api.scheduler.status()) || {}
  return {
    ts: now,
    uptimeS: Math.round((now - startedAt) / 1000),
    dashboard: { port, readOnly: true },
    bot: { ...extra, ...base },
    inventory: inventorySection(bot),
    task: {
      running: sched.running || null,
      queue: sched.queue || [],
      parked: sched.parked || [],
      routines: sched.routines || [],
      quietForS: num(sched.quietForS),
      history: sched.history || []
    },
    furnace: all.furnace === undefined ? null : all.furnace,
    modules: all.modules || {},
    chat: chatSection(all, dir, ring),
    log: (Array.isArray(all.logTail) ? all.logTail : []).map(e => normLine(e)).filter(Boolean).slice(-40),
    chests: chestsSection(dir, cache),
    pov: povSection(povPath)
  }
}

module.exports = { build, FileCache, gameClock, tailFile }
