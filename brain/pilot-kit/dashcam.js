// brain/pilot-kit/dashcam.js: a state dashcam. Records the bot's own state and what is around it ten times a second into a RAM ring
// buffer, and saves the last ~30 s to brain/state/clips/ when something goes wrong (death, big hit, low health) or on request.
// No rendering, no browser: a clip is a small JSON file (about 50 to 80 KB for 35 s) that the dashboard can replay as a top-down animation.
//
// Clip format v1 (also documented in README.md):
//   { v:1, bot, reason, savedAt, hz, t0, t1, pos:{x,y,z}, map:{x0,z0,size,palette:[names],cells:[idx|-1,...]}|null,
//     samples:[{t, x,y,z, yaw, pit, hp, fd, h, a, m:[[name,x,y,z,id],...]}], events:[{t, type, ...}] }
//   t is milliseconds since t0. samples are 10 Hz. m = hostile mobs and players within RADIUS blocks. h = held item, a = what the bot is doing.
//   events: damage {amount, kind, by}, death, chat {user,text}, task {event,name}, eat, respawn.
const fs = require('fs')
const path = require('path')

const HZ = 10
const WINDOW_MS = 30000        // pre-roll kept in each clip
const POSTROLL_MS = 5000       // extra time recorded after a big hit / low health before saving
const RADIUS = 24
const MAP_SIZE = 41            // top-down terrain snapshot around the bot at save time
const MAX_CLIPS = 40
const COOLDOWN_MS = { death: 5000, big_hit: 20000, low_health: 60000, manual: 0 }

module.exports = function createDashcam(api, opts = {}) {
  const { bot } = api
  const now = api.now || Date.now
  const dir = opts.dir || api.statePath('clips')
  const hz = opts.hz || HZ
  const windowMs = opts.windowMs || WINDOW_MS
  const cap = Math.ceil((windowMs + (opts.postrollMs ?? POSTROLL_MS) + 5000) / (1000 / hz))
  const post = opts.postrollMs ?? POSTROLL_MS
  const samples = []           // ring
  const events = []            // ring, trimmed by time
  let tickN = 0, running = false, lastSave = {}, pending = null, hpHist = []
  const saved = []             // [{file, reason, at}]
  const listeners = []

  const act = () => {
    try {
      const ap = bot._ap
      const s = api.scheduler && api.scheduler.status ? api.scheduler.status() : null
      const task = s && s.running ? s.running.name : null
      const step = ap && ap.G && ap.G.lastStep ? String(ap.G.lastStep).slice(0, 60) : null
      return step ? (task ? task + ': ' + step : step) : (task || 'idle')
    } catch (e) { return '?' }
  }
  const r1 = (n) => Math.round(n * 10) / 10

  function sample() {
    const e = bot.entity
    if (!e || !e.position) return
    const p = e.position
    const m = []
    for (const id in bot.entities) {
      const o = bot.entities[id]
      if (!o || o === e || !o.position) continue
      if (o.type !== 'hostile' && o.type !== 'player') continue
      const d = o.position.distanceTo(p)
      if (d > RADIUS) continue
      m.push([o.username || o.name || o.type, r1(o.position.x), r1(o.position.y), r1(o.position.z), o.id])
      if (m.length >= 30) break
    }
    const held = bot.heldItem ? bot.heldItem.name : null
    const t = now()
    samples.push({ t, x: r1(p.x), y: r1(p.y), z: r1(p.z), yaw: r1(e.yaw || 0), pit: r1(e.pitch || 0), hp: r1(bot.health ?? 20), fd: bot.food ?? 20, h: held, a: act(), m })
    if (samples.length > cap) samples.shift()
    // health history for the big-hit rule
    hpHist.push([t, bot.health ?? 20]); while (hpHist.length && t - hpHist[0][0] > 2500) hpHist.shift()
  }

  const evt = (type, extra) => {
    const t = now()
    events.push(Object.assign({ t, type }, extra)); while (events.length && t - events[0].t > windowMs + post + 5000) events.shift()
  }

  function mapSnapshot() {
    try {
      const e = bot.entity; if (!e) return null
      const px = Math.floor(e.position.x), py = Math.floor(e.position.y), pz = Math.floor(e.position.z)
      const half = (MAP_SIZE - 1) / 2, x0 = px - half, z0 = pz - half
      const palette = [], pi = new Map(), cells = []
      const Vec3 = require('vec3').Vec3
      for (let dz = 0; dz < MAP_SIZE; dz++) for (let dx = 0; dx < MAP_SIZE; dx++) {
        let found = -1
        for (let y = py + 6; y >= py - 10; y--) {
          const b = bot.blockAt(new Vec3(x0 + dx, y, z0 + dz))
          if (b && b.name !== 'air' && b.name !== 'cave_air' && b.name !== 'void_air' && b.name !== 'light' && b.name !== 'short_grass' && b.name !== 'tall_grass') {
            if (!pi.has(b.name)) { pi.set(b.name, palette.length); palette.push(b.name) }
            found = pi.get(b.name) * 64 + Math.max(0, Math.min(63, y - (py - 10)))   // palette index and height packed in one number
            break
          }
        }
        cells.push(found)
      }
      return { x0, z0, size: MAP_SIZE, y0: py - 10, palette, cells, note: 'cell = paletteIndex*64 + (y - y0); -1 = nothing found' }
    } catch (err) { return null }
  }

  function writeClip(reason, endT) {
    const t1 = endT || now()
    const from = t1 - windowMs - (reason === 'death' ? 0 : post)
    const sel = samples.filter(s => s.t >= from && s.t <= t1)
    if (!sel.length) return null
    const t0 = sel[0].t
    const out = {
      v: 1, bot: bot.username, reason, savedAt: new Date(t1).toISOString(), hz, t0, t1: sel[sel.length - 1].t,
      pos: { x: sel[sel.length - 1].x, y: sel[sel.length - 1].y, z: sel[sel.length - 1].z },
      map: mapSnapshot(),
      samples: sel.map(s => Object.assign({}, s, { t: s.t - t0 })),
      events: events.filter(x => x.t >= t0 && x.t <= t1 + 1).map(x => Object.assign({}, x, { t: x.t - t0 }))
    }
    try { fs.mkdirSync(dir, { recursive: true }) } catch {}
    const stamp = new Date(t1).toISOString().replace(/[:.]/g, '-')
    const file = path.join(dir, `${stamp}-${reason}.json`)
    const tmp = file + '.tmp'
    try {
      fs.writeFileSync(tmp, JSON.stringify(out)); fs.renameSync(tmp, file)
      saved.push({ file, reason, at: out.savedAt })
      prune()
      for (const l of listeners) { try { l({ file, reason }) } catch (e) {} }
      return file
    } catch (err) { api.log && api.log('DASHCAM', 'save failed: ' + err.message); return null }
  }

  function prune() {
    try {
      const files = fs.readdirSync(dir).filter(f => f.endsWith('.json')).sort()
      for (const f of files.slice(0, Math.max(0, files.length - MAX_CLIPS))) fs.unlinkSync(path.join(dir, f))
    } catch (e) {}
  }

  // save(reason): the one entry point. Death saves at once; the others wait POSTROLL so the clip shows what happened next.
  function save(reason = 'manual') {
    const t = now()
    if (lastSave[reason] && t - lastSave[reason] < (COOLDOWN_MS[reason] ?? 10000)) return null
    lastSave[reason] = t
    if (reason === 'death' || reason === 'manual' || post <= 0) return writeClip(reason, t)
    if (pending) return null
    pending = setTimeout(() => { pending = null; writeClip(reason, now()) }, post)
    return 'pending'
  }

  // ---- wiring ----
  const onHealth = () => {
    const t = now(), hp = bot.health ?? 20
    const old = hpHist.length ? Math.max(...hpHist.map(h => h[1])) : hp
    if (old - hp >= 6) save('big_hit')
    else if (hp <= 6 && hp > 0) save('low_health')
  }
  const onDeath = () => { evt('death'); save('death') }
  const onChat = (user, text) => { if (user !== bot.username) evt('chat', { user, text: String(text).slice(0, 120) }) }
  const onSpawn = () => evt('respawn')
  const onDamage = (p) => {
    try {
      if (!bot.entity || p.entityId !== bot.entity.id) return
      const types = bot._damageTypes || null
      const by = p.sourceCauseId > 0 ? bot.entities[p.sourceCauseId - 1] : null
      const hp0 = bot.health
      setTimeout(() => { evt('damage', { amount: r1(Math.max(0, hp0 - bot.health)), kind: (types && types[p.sourceTypeId]) || ('type#' + p.sourceTypeId), by: by ? (by.username || by.name || by.type) : null }) }, 60)
    } catch (e) {}
  }
  const onTask = (x) => { try { evt('task', { event: x.event, name: x.task && x.task.name }) } catch (e) {} }
  let timer = null
  const onTick = () => { if (++tickN % Math.round(20 / hz) === 0) sample() }

  return {
    start() {
      if (running) return
      running = true
      // 10 Hz from physicsTick (20 Hz), so the cost is a handful of property reads per sample
      bot.on('physicsTick', onTick)
      bot.on('health', onHealth); bot.on('death', onDeath); bot.on('chat', onChat); bot.on('spawn', onSpawn)
      try { bot._client.on('damage_event', onDamage) } catch (e) {}
      if (api.events) api.events.on('task', onTask)
    },
    stop() {
      running = false
      bot.removeListener('physicsTick', onTick)
      bot.removeListener('health', onHealth); bot.removeListener('death', onDeath); bot.removeListener('chat', onChat); bot.removeListener('spawn', onSpawn)
      try { bot._client.removeListener('damage_event', onDamage) } catch (e) {}
      if (api.events) api.events.removeListener('task', onTask)
      if (pending) { clearTimeout(pending); pending = null }
    },
    save,
    onSaved(fn) { listeners.push(fn) },
    status() { return { running, buffered: samples.length, bufferedMs: samples.length ? now() - samples[0].t : 0, clips: saved.slice(-5).map(s => ({ reason: s.reason, at: s.at })), dir } },
    // for tests
    _sample: sample, _events: evt, _samples: samples
  }
}
module.exports.meta = { name: 'dashcam', version: 1 }
