// brain/telemetry: cheap structured telemetry for the external behavior reviewer (reviewer/), because text logs miss what a spectator sees in a minute:
// jumping up and down, the wrong tool in hand, pacing back and forth, standing around, stray blocks on the surface, the same failure again and again.
//
// It is an observer: it only listens and samples; it never moves the bot or touches the world.
//   * every 250 ms a compact sample (position, onGround, held item, task, whether the bot is busy) goes into a 15-minute ring buffer
//   * events: jumps (physicsTick), dig starts with the held item vs the tool the block needs, placements (open air or covered), failures (noPath, timeout, aborted dig, failed task)
//   * every 15 s the deterministic detectors in detectors.js run over the ring and write brain/state/telemetry/summary.json (counters + active flags)
//     and, for each new flag, one line with a 1 Hz excerpt to brain/state/telemetry/flags.jsonl
// Nothing here says anything in game chat. The reviewer reads the files and writes its findings next to them.
const fs = require('fs')
const path = require('path')
const D = require('./detectors')
const SB = require('./sandbox')

const SAMPLE_MS = 250, RING_MS = 15 * 60000, ANALYZE_MS = 15000, FLAG_REPEAT_MS = 5 * 60000
const ARMOR_RE = /_(helmet|chestplate|leggings|boots)$/
const LADDERISH = /^(ladder|vine|scaffolding|weeping_vines|twisting_vines|cave_vines)/
const WINDOW_MS = 150000, WINDOW_EVERY_MS = 120000, KEEP_NORMAL = 8, KEEP_FLAGGED = 6      // raw slices kept for the reviewer to validate new detectors against

module.exports = function register(api) {
  const { bot } = api
  const now = () => (api.now ? api.now() : Date.now())
  const dir = path.dirname(api.statePath('telemetry/x'))
  try { fs.mkdirSync(dir, { recursive: true }) } catch {}
  const summaryFile = api.statePath('telemetry/summary.json'), flagsFile = api.statePath('telemetry/flags.jsonl')

  let samples = [], events = [], timer = null, analyzeTimer = null
  let curTask = null, lastSwing = 0, lastDigKey = null, lastDigAt = new Map(), wasGround = true
  const active = new Map()      // kind -> { id, first, last, count, flag }
  let seq = 0, started = 0

  const winDir = path.join(dir, 'windows'), detDir = path.dirname(api.statePath('detectors/x'))
  try { fs.mkdirSync(winDir, { recursive: true }) } catch {}
  const addEvent = (e) => { events.push(e) }
  const pos = () => bot.entity && bot.entity.position
  const invNames = () => { try { return bot.inventory.items().map(i => i.name) } catch { return [] } }

  function sample() {
    const e = bot.entity; if (!e) return
    const t = now()
    const cs = bot.controlState || {}
    const moving = (bot.pathfinder && bot.pathfinder.isMoving && bot.pathfinder.isMoving()) || cs.forward || cs.back || cs.left || cs.right
    const tb = bot.targetDigBlock
    let ld = 0; try { const fb = bot.blockAt(e.position); ld = fb && LADDERISH.test(fb.name) ? 1 : 0 } catch {}
    const act = bot.isSleeping || bot.currentWindow || tb || bot.usingHeldItem || (t - lastSwing < 2000) || curTask === 'sleep'
    samples.push({
      t, x: e.position.x, y: e.position.y, z: e.position.z, g: e.onGround ? 1 : 0, vy: e.velocity ? +e.velocity.y.toFixed(2) : 0, yaw: +(e.yaw || 0).toFixed(2), pit: +(e.pitch || 0).toFixed(2),
      h: bot.heldItem ? bot.heldItem.name : '', mv: moving ? 1 : 0, act: act ? 1 : 0, dg: tb ? tb.name : '', tk: curTask || '', hp: bot.health, ld, st: (bot._ap && bot._ap.G && bot._ap.G.lastStep) || '',
    })
    if (samples.length > RING_MS / SAMPLE_MS) samples.splice(0, samples.length - RING_MS / SAMPLE_MS)
    // a dig started: record what was in hand against what the block needs
    if (tb) {
      const key = tb.position.x + ',' + tb.position.y + ',' + tb.position.z
      if (key !== lastDigKey) { lastDigKey = key; recordDig(tb, t) }
    } else lastDigKey = null
  }

  function recordDig(block, t) {
    const key = block.position.x + ',' + block.position.y + ',' + block.position.z
    if (t - (lastDigAt.get(key) || 0) < 5000) return
    lastDigAt.set(key, t); if (lastDigAt.size > 200) lastDigAt.delete(lastDigAt.keys().next().value)
    let hn = null
    try { if (block.harvestTools && bot.registry && bot.registry.items) hn = Object.keys(block.harvestTools).map(id => bot.registry.items[id] && bot.registry.items[id].name).filter(Boolean) } catch {}
    const c = D.toolCheck(block, bot.heldItem, invNames(), hn)
    addEvent({ k: 'dig', t, block: block.name, x: block.position.x, y: block.position.y, z: block.position.z, held: bot.heldItem ? bot.heldItem.name : '', need: c.need, have: c.have, ok: c.ok, harvestOk: c.harvestOk, overTier: c.overTier })
  }

  // the column above a placement is empty up to the sky: that block sits in the open
  function openAbove(p) {
    for (let dy = 1; dy <= 24; dy++) {
      const b = bot.blockAt(p.offset(0, dy, 0))
      if (!b) return true
      if (b.boundingBox !== 'empty') return false
    }
    return true
  }

  // ---- listeners ----
  const onPhysics = () => {
    const e = bot.entity; if (!e) return
    const g = !!e.onGround
    if (wasGround && !g && e.velocity && e.velocity.y > 0.1) addEvent({ k: 'jump', t: now() })
    wasGround = g
  }
  const onSwing = (ent) => { if (ent === bot.entity) lastSwing = now() }
  const TORCHES = /^(soul_)?(wall_)?torch$/
  function checkTorch(nb) {
    const reg = bot.registry && bot.registry.blocksByName
    if (!reg || typeof bot.findBlocks !== 'function') return
    const ids = ['torch', 'wall_torch', 'soul_torch', 'soul_wall_torch'].map(n => reg[n] && reg[n].id).filter(x => x !== undefined)
    const p = nb.position
    const near = bot.findBlocks({ matching: ids, maxDistance: 4, count: 30, point: p }).filter(q => D.torchTooClose(p, q))
      .map(q => [q.x, q.y, q.z, Math.max(Math.abs(q.x - p.x), Math.abs(q.z - p.z))])
    if (near.length) addEvent({ k: 'torch', t: now(), block: nb.name, x: p.x, y: p.y, z: p.z, tk: curTask || '', near })
  }
  const onPlaced = (_old, nb) => {
    try { if (TORCHES.test(nb.name)) checkTorch(nb) } catch {}
    try { addEvent({ k: 'place', t: now(), block: nb.name, x: nb.position.x, y: nb.position.y, z: nb.position.z, sky: openAbove(nb.position), tk: curTask || '' }) } catch {}
  }
  const onDug = (block) => { try { recordDig(block, now()) } catch {} }
  const onDigAbort = (block) => addEvent({ k: 'fail', t: now(), what: 'digAbort', note: block ? block.name : '' })
  const onPathUpdate = (r) => {
    if (!r) return
    if (r.status === 'noPath' || r.status === 'timeout') addEvent({ k: 'fail', t: now(), what: r.status, note: (curTask || '') + (bot._ap && bot._ap.G && bot._ap.G.lastStep ? ':' + bot._ap.G.lastStep : '') })
  }
  // signs of work that are not digging or placing: picking items up, opening a chest/furnace/crafting table (coalesced, one per 5 s)
  let lastWork = 0
  const work = (what) => { const t = now(); if (t - lastWork > 5000) { lastWork = t; addEvent({ k: 'work', t, what }) } }
  const onCollect = (collector) => { if (collector === bot.entity) work('pickup') }
  const onWindow = () => work('window')
  const onTask = (m) => {
    if (!m || !m.task) return
    if (m.event === 'start') curTask = m.task.name
    else if ((m.event === 'done' || m.event === 'parked' || m.event === 'failed') && curTask === m.task.name) curTask = null
    if (m.event === 'failed') addEvent({ k: 'fail', t: now(), what: 'taskFailed', note: m.task.name })
  }

  // ---- rule state: what is worn (checked every pass and the moment an armor slot changes), own chat lines ----
  const rulesFile = api.statePath('telemetry/rules.json')
  function farmDrops() { try { return JSON.parse(fs.readFileSync(rulesFile, 'utf8')).armorFarmDrops || [] } catch { return [] } }   // optional {"armorFarmDrops":["leather_boots"]} once a mob farm exists
  function gearState() {
    const worn = []
    try {
      for (const slot of [5, 6, 7, 8]) {
        const it = bot.inventory && bot.inventory.slots && bot.inventory.slots[slot]
        if (!it) continue
        let mending = false; try { mending = (it.enchants || []).some(e => e.name === 'mending') } catch {}
        worn.push({ slot, name: it.name, mending })
      }
    } catch {}
    const carried = []
    try { for (const i of bot.inventory.items()) if (ARMOR_RE.test(i.name) && !worn.some(w => w.name === i.name && w.slot === i.slot)) { let mending = false; try { mending = (i.enchants || []).some(e => e.name === 'mending') } catch {} carried.push({ name: i.name, count: i.count, mending }) } } catch {}
    return { worn, carried, farmDrops: farmDrops() }
  }
  // what the bot carries, name -> count (top 30), so the reviewer can judge progress between two reviews
  function bagCounts() {
    try {
      const m = {}; for (const i of bot.inventory.items()) m[i.name] = (m[i.name] || 0) + i.count
      return Object.fromEntries(Object.entries(m).sort((a, b) => b[1] - a[1]).slice(0, 30))
    } catch { return {} }
  }
  let armorSoon = null
  const onSlot = (slot, _old, nw) => {      // an armor slot changed: do not wait for the next 15 s pass
    try { if (slot >= 5 && slot <= 8 && nw && ARMOR_RE.test(nw.name || '')) { clearTimeout(armorSoon); armorSoon = setTimeout(() => { try { analyze() } catch {} }, 300) } } catch {}
  }
  const onOwnChat = (username, message) => { if (username === bot.username) addEvent({ k: 'chat', t: now(), text: String(message || '').slice(0, 120) }) }

  // ---- model-written detectors (brain/state/detectors/manifest.json, written by the reviewer after it validated them; see sandbox.js) ----
  const custom = new Map()          // name -> { det, sha, fails, recent:[0|1] }
  let manifestSig = ''
  function loadCustom() {
    const mf = path.join(detDir, 'manifest.json')
    let st; try { st = fs.statSync(mf) } catch { if (custom.size) custom.clear(); manifestSig = ''; return }
    const sig = st.mtimeMs + ':' + st.size
    if (sig === manifestSig) return
    manifestSig = sig
    let m; try { m = JSON.parse(fs.readFileSync(mf, 'utf8')) } catch { return }
    const want = new Set()
    for (const e of (m.detectors || [])) {
      if (!e.enabled || !SB.NAME.test(e.name || '')) continue
      want.add(e.name)
      const old = custom.get(e.name)
      if (old && old.sha === e.sha) continue
      try {
        const src = fs.readFileSync(path.join(detDir, e.name + '.js'), 'utf8')
        if (SB.sha(src) !== e.sha) { api.log('telemetry', `custom detector ${e.name}: file does not match the manifest hash, not loaded`); continue }
        custom.set(e.name, { det: SB.compile(e.name, src), sha: e.sha, fails: 0, recent: [], muted: false })
        api.log('telemetry', `custom detector ${e.name} loaded (${e.origin && e.origin.by || 'unknown origin'})`)
      } catch (err) { api.log('telemetry', `custom detector ${e.name} not loaded: ${err.message}`) }
    }
    for (const n of [...custom.keys()]) if (!want.has(n)) custom.delete(n)
  }
  function runCustom(t) {
    try { loadCustom() } catch (e) { api.log('telemetry', 'custom detector load error: ' + e.message) }
    if (!custom.size) return []
    const input = SB.prepareInput(samples, events, t), out = []
    for (const [name, c] of custom) {
      if (c.muted) continue
      const r = c.det.run(input, t)
      c.recent.push(r.flag ? 1 : 0); if (c.recent.length > 40) c.recent.shift()
      if (r.error) { c.fails++; if (c.fails >= 3) { c.muted = true; api.log('telemetry', `custom detector ${name} muted: ${r.error}`) } continue }
      c.fails = 0
      // a detector that fires on almost every pass carries no information: mute it until the reviewer replaces it
      if (c.recent.length >= 40 && c.recent.filter(Boolean).length >= 36) { c.muted = true; api.log('telemetry', `custom detector ${name} muted: fires on nearly every pass`) }
      if (r.flag) out.push(r.flag)
    }
    return out
  }

  // raw slices of the ring, kept so the reviewer can test a new detector against real recent play (fires on the bad window, quiet on normal ones)
  let lastWindowAt = 0
  function captureWindow(t, kind, flagKinds) {
    try {
      const t0 = t - WINDOW_MS, id = `w${Math.floor(t / 1000)}-${kind}`
      const ss = D.since(samples, t0).map(x => ({ ...x, x: +x.x.toFixed(2), y: +x.y.toFixed(2), z: +x.z.toFixed(2) }))
      if (ss.length < 100) return
      const ev = events.filter(e => e.t >= t0)
      const digest = { counters: D.counters(ss, ev, t, WINDOW_MS), excerptColumns: D.excerpt.columns, excerpt: D.excerpt(ss, t0, t, 30) }
      fs.writeFileSync(path.join(winDir, id + '.json'), JSON.stringify({ id, kind, at: new Date(t).toISOString(), t0, t1: t, flags: flagKinds, digest, samples: ss, events: ev }))
      const files = fs.readdirSync(winDir).filter(f => f.endsWith('.json')).sort()
      for (const k of ['normal', 'flagged']) for (const f of files.filter(f => f.endsWith(`-${k}.json`)).slice(0, -(k === 'normal' ? KEEP_NORMAL : KEEP_FLAGGED))) try { fs.unlinkSync(path.join(winDir, f)) } catch {}
    } catch (e) { api.log('telemetry', 'window capture error: ' + e.message) }
  }

  // ---- analysis and persistence ----
  function analyze() {
    const t = now()
    events = events.filter(e => e.t >= t - RING_MS)
    const flags = [...D.analyze(samples, events, t, undefined, gearState()), ...runCustom(t)]
    let newHigh = false
    const seen = new Set()
    for (const f of flags) {
      seen.add(f.kind)
      const a = active.get(f.kind)
      const rank = { low: 1, med: 2, high: 3 }
      if (a && t - a.last < FLAG_REPEAT_MS && rank[f.sev] <= rank[a.flag.sev]) { a.last = t; a.count++; a.flag = f; continue }   // same problem still going on: count it, do not re-log
      if (f.sev === 'high') newHigh = true
      const rec = { id: `${started}-${++seq}`, first: t, last: t, count: 1, flag: f }
      active.set(f.kind, rec)
      try {
        const line = { id: rec.id, at: new Date(t).toISOString(), kind: f.kind, sev: f.sev, msg: f.msg, data: f.data, origin: f.origin, excerptColumns: D.excerpt.columns, excerpt: D.excerpt(samples, f.t0, f.t1) }
        fs.appendFileSync(flagsFile, JSON.stringify(line) + '\n')
        trimFlags()
      } catch {}
    }
    for (const [k, a] of active) if (!seen.has(k) && t - a.last > FLAG_REPEAT_MS) active.delete(k)
    if (newHigh || t - lastWindowAt >= WINDOW_EVERY_MS) { lastWindowAt = t; captureWindow(t, flags.length ? 'flagged' : 'normal', flags.map(f => f.kind)) }
    // a new high flag also saves the world around the bot, so the incident can be rebuilt on a trial server as a scenario (brain/snapshot, tools/snapshot-rebuild.js)
    if (newHigh) { try { const hi = flags.find(f => f.sev === 'high'); require('../snapshot').capture(bot, { flag: hi, dir: path.join(dir, '..', 'snapshots'), task: curTask, now }) } catch (e) { api.log('telemetry', 'snapshot error: ' + e.message) } }
    writeSummary(t)
    writeAlerts(t)
  }

  function trimFlags() {
    try {
      if (fs.statSync(flagsFile).size < 768 * 1024) return
      const lines = fs.readFileSync(flagsFile, 'utf8').split('\n').filter(Boolean)
      fs.writeFileSync(flagsFile, lines.slice(-150).join('\n') + '\n')
    } catch {}
  }

  // Instant path (no model, within one analysis tick): the active medium/high flags as a short readable file next to chat.log for the driver thread.
  const alertsFile = api.dir ? path.join(api.dir, 'REVIEW-ALERTS.md') : null
  let lastAlerts = ''
  function writeAlerts(t) {
    if (!alertsFile) return
    const rows = [...active.values()].filter(a => a.flag.sev !== 'low').sort((a, b) => (b.flag.sev === 'high') - (a.flag.sev === 'high'))
    const body = rows.length
      ? rows.map(a => `- **[${a.flag.sev.toUpperCase()}] ${a.flag.kind}**: ${a.flag.msg} _(since ${new Date(a.first).toISOString()}, last ${new Date(a.last).toISOString()}, seen ${a.count}x)_`).join('\n')
      : '_No active alerts._'
    const text = `# Live behavior alerts: ${bot.username}\n\nDeterministic detectors inside the bot (brain/telemetry), refreshed every ${ANALYZE_MS / 1000}s with no model in the loop. The Haiku reviewer adds judgement in REVIEW-FINDINGS.md every few minutes.\n\n${body}\n`
    if (text === lastAlerts) return
    lastAlerts = text
    try { fs.writeFileSync(alertsFile, text) } catch {}
  }

  function summary(t = now()) {
    const p = pos()
    return {
      updatedAt: new Date(t).toISOString(), bot: bot.username, startedAt: new Date(started).toISOString(), samples: samples.length,
      now: p ? { pos: [Math.round(p.x), Math.round(p.y), Math.round(p.z)], task: curTask, held: bot.heldItem ? bot.heldItem.name : null, hp: bot.health, food: bot.food, sleeping: !!bot.isSleeping, bag: bagCounts(), worn: gearState().worn.map(a => a.name) } : null,
      last1min: D.counters(samples, events, t, 60000), last10min: D.counters(samples, events, t, 600000),
      customDetectors: [...custom].map(([n, c]) => ({ name: n, muted: c.muted })),
      flags: [...active.values()].map(a => ({ id: a.id, kind: a.flag.kind, sev: a.flag.sev, msg: a.flag.msg, data: a.flag.data, origin: a.flag.origin, since: new Date(a.first).toISOString(), lastSeen: new Date(a.last).toISOString(), seenTimes: a.count })),
      recent: { columns: D.excerpt.columns, rows: D.excerpt(samples, t - 90000, t, 90) },
    }
  }
  function writeSummary(t) {
    try { const tmp = summaryFile + '.tmp'; fs.writeFileSync(tmp, JSON.stringify(summary(t))); fs.renameSync(tmp, summaryFile) } catch {}
  }

  return {
    name: 'telemetry',
    start() {
      started = now()
      bot.on('physicsTick', onPhysics); bot.on('entitySwingArm', onSwing); bot.on('blockPlaced', onPlaced)
      bot.on('diggingCompleted', onDug); bot.on('diggingAborted', onDigAbort); bot.on('path_update', onPathUpdate); bot.on('playerCollect', onCollect); bot.on('windowOpen', onWindow); bot.on('chat', onOwnChat)
      try { bot.inventory.on('updateSlot', onSlot) } catch {}
      if (api.events) api.events.on('task', onTask)
      timer = setInterval(() => { try { sample() } catch {} }, SAMPLE_MS)
      analyzeTimer = setInterval(() => { try { analyze() } catch (e) { api.log('telemetry', 'analyze error: ' + e.message) } }, ANALYZE_MS)
    },
    stop() {
      clearInterval(timer); clearInterval(analyzeTimer)
      bot.removeListener('physicsTick', onPhysics); bot.removeListener('entitySwingArm', onSwing); bot.removeListener('blockPlaced', onPlaced)
      bot.removeListener('diggingCompleted', onDug); bot.removeListener('diggingAborted', onDigAbort); bot.removeListener('path_update', onPathUpdate); bot.removeListener('playerCollect', onCollect); bot.removeListener('windowOpen', onWindow); bot.removeListener('chat', onOwnChat)
      try { bot.inventory.removeListener('updateSlot', onSlot) } catch {}; clearTimeout(armorSoon)
      if (api.events) api.events.removeListener('task', onTask)
      writeSummary(now())
    },
    status() { const s = summary(); return { samples: s.samples, flags: s.flags.map(f => `${f.sev} ${f.kind}`), jumpsPerMin: s.last1min.jumpsPerMin } },
    // for tests and the dashboard's eval channel
    _tick: { sample, analyze, summary, samples: () => samples, events: () => events },
  }
}
module.exports.meta = require('./meta.json')
