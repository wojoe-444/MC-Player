// brain/pilot-kit/observe.js: observe({ since }) gives one compact snapshot plus only the events newer than `since`.
// The cursor is a plain integer, so it survives any transport: call it from the ap-cmd.js eval channel (Claude Desktop), from the
// pilot REPL, or from a model prompt. A caller that polls with the last cursor reads a few lines per turn instead of the whole state.
//
//   const o = bot._kit.observe({ since: lastCursor })   ->  { cursor, t, vitals, pos, doing, inventory, nearby, events, dropped }
//   bot._kit.observeText({ since })                      ->  the same as a short text block
//
// Honest-play rule: nearby entities are limited to ones the bot has line of sight to (a clear ray to the entity's body), plus
// anything that hit it (see sight.js). No seeing through walls.
const sight = require('./sight')
const MAX_EVENTS = 400
const NEAR = 24

module.exports = function createObserve(api, opts = {}) {
  const { bot } = api
  const now = api.now || Date.now
  const ring = []
  let seq = 0, dropped = 0
  const listeners = []
  const push = (type, extra) => {
    const e = Object.assign({ seq: ++seq, t: now(), type }, extra)
    ring.push(e); if (ring.length > MAX_EVENTS) { ring.shift(); dropped++ }
    return e
  }
  const r1 = (n) => Math.round(n * 10) / 10

  const hear = {
    chat: (x) => push('chat', { user: x.user, text: String(x.text).slice(0, 160) }),
    task: (x) => push('task', { event: x.event, name: x.task && x.task.name }),
    park: (x) => push('park', { module: x.module, reason: String(x.reason || '').slice(0, 100) })
  }
  const onDeath = () => push('death', { pos: bot.entity ? [Math.round(bot.entity.position.x), Math.round(bot.entity.position.y), Math.round(bot.entity.position.z)] : null })
  const onSpawn = () => push('spawn')
  const onKicked = (r) => push('kicked', { reason: String(JSON.stringify(r)).slice(0, 120) })
  const onEat = () => push('ate', { food: bot.food })
  const onDamage = (p) => {
    try {
      if (!bot.entity || p.entityId !== bot.entity.id) return
      const types = bot._damageTypes || null
      const by = p.sourceCauseId > 0 ? bot.entities[p.sourceCauseId - 1] : null
      const hp0 = bot.health
      setTimeout(() => push('damage', { amount: r1(Math.max(0, hp0 - bot.health)), kind: (types && types[p.sourceTypeId]) || ('type#' + p.sourceTypeId), by: by ? (by.username || by.name || by.type) : null, hp: r1(bot.health) }), 60)
    } catch (e) {}
  }

  function inventory() {
    const counts = {}
    for (const it of bot.inventory.items()) counts[it.name] = (counts[it.name] || 0) + it.count
    const slot = (n) => { const it = bot.inventory.slots[n]; return it ? it.name : null }
    return { counts, hand: bot.heldItem ? bot.heldItem.name : null, offhand: slot(45), armor: { head: slot(5), chest: slot(6), legs: slot(7), feet: slot(8) }, free: bot.inventory.emptySlotCount() }
  }

  function nearby() {
    const e = bot.entity, p = e.position, hostiles = [], players = [], items = []
    for (const id in bot.entities) {
      const o = bot.entities[id]
      if (!o || o === e || !o.position) continue
      const d = o.position.distanceTo(p)
      if (d > NEAR) continue
      const isMob = o.type === 'hostile', isPlayer = o.type === 'player', isItem = o.name === 'item' || o.type === 'object'
      if (!isMob && !isPlayer && !isItem) continue
      let seen = true
      seen = d < 3 || sight.pointVisible(bot, o.position.offset(0, 1, 0))
      if (!seen) continue
      const row = { name: o.username || o.name || o.type, d: r1(d), dx: r1(o.position.x - p.x), dy: r1(o.position.y - p.y), dz: r1(o.position.z - p.z) }
      if (isMob) hostiles.push(row); else if (isPlayer) players.push(row); else if (items.length < 8) items.push(row)
    }
    hostiles.sort((a, b) => a.d - b.d); players.sort((a, b) => a.d - b.d)
    return { hostiles: hostiles.slice(0, 10), players: players.slice(0, 6), items }
  }

  function doing() {
    try {
      const ap = bot._ap
      const s = api.scheduler && api.scheduler.status ? api.scheduler.status() : null
      return { task: s && s.running ? s.running.name : null, step: ap && ap.G && ap.G.lastStep ? String(ap.G.lastStep).slice(0, 80) : null }
    } catch (e) { return { task: null, step: null } }
  }

  // observe({ since, events: true|false }): `since` = the cursor from the previous call (omit for the first call: no events, just state)
  function observe(o = {}) {
    const e = bot.entity
    if (!e) return { cursor: seq, t: now(), error: 'not spawned' }
    const since = Number.isFinite(o.since) ? o.since : null
    const first = ring.length ? ring[0].seq : seq + 1
    let evs = [], lost = false
    if (since !== null && o.events !== false) {
      evs = ring.filter(x => x.seq > since)
      lost = since < first - 1 && ring.length > 0 && dropped > 0
    }
    const p = e.position
    return {
      cursor: seq, t: now(),
      vitals: { hp: r1(bot.health ?? 0), food: bot.food ?? 0, sat: r1(bot.foodSaturation ?? 0), air: bot.oxygenLevel ?? null, xp: bot.experience ? bot.experience.level : 0 },
      pos: { x: r1(p.x), y: r1(p.y), z: r1(p.z), dim: bot.game ? bot.game.dimension : null, yaw: r1(e.yaw || 0), onGround: !!e.onGround },
      time: { tod: bot.time ? bot.time.timeOfDay : null, day: bot.time ? bot.time.isDay : null, rain: !!bot.isRaining },
      doing: doing(), inventory: inventory(), nearby: nearby(), events: evs, dropped: lost
    }
  }

  function observeText(o = {}) {
    const x = observe(o)
    if (x.error) return x.error
    const inv = Object.entries(x.inventory.counts).sort((a, b) => b[1] - a[1]).slice(0, 14).map(([k, v]) => `${k}:${v}`).join(' ')
    const near = x.nearby.hostiles.map(h => `${h.name}@${h.d}`).concat(x.nearby.players.map(h => `player ${h.name}@${h.d}`)).join(', ')
    const ev = x.events.map(v => `[${v.seq}] ${v.type}${v.user ? ' ' + v.user + ': ' + v.text : ''}${v.kind ? ' ' + v.kind + ' -' + v.amount + (v.by ? ' by ' + v.by : '') : ''}${v.event ? ' ' + v.event + ' ' + (v.name || '') : ''}`).join('\n')
    return [
      `cursor ${x.cursor} hp ${x.vitals.hp} food ${x.vitals.food} at ${x.pos.x},${x.pos.y},${x.pos.z} (${x.time.day ? 'day' : 'night'}) doing ${x.doing.task || 'idle'}${x.doing.step ? ' / ' + x.doing.step : ''}`,
      `hand ${x.inventory.hand || 'empty'} free slots ${x.inventory.free}; bag ${inv || 'empty'}`,
      near ? 'near: ' + near : 'near: nothing in sight',
      x.dropped ? 'WARNING: some events were dropped since your cursor' : '',
      ev
    ].filter(Boolean).join('\n')
  }

  return {
    start() {
      for (const k of Object.keys(hear)) if (api.events) api.events.on(k, hear[k])
      bot.on('death', onDeath); bot.on('spawn', onSpawn); bot.on('kicked', onKicked); bot.on('entityEat', onEat)
      try { bot._client.on('damage_event', onDamage) } catch (e) {}
    },
    stop() {
      for (const k of Object.keys(hear)) if (api.events) api.events.removeListener(k, hear[k])
      bot.removeListener('death', onDeath); bot.removeListener('spawn', onSpawn); bot.removeListener('kicked', onKicked); bot.removeListener('entityEat', onEat)
      try { bot._client.removeListener('damage_event', onDamage) } catch (e) {}
    },
    observe, observeText, push,   // push(type, extra) lets other modules add events (e.g. a skill reporting "ore_found")
    cursor: () => seq
  }
}
module.exports.meta = { name: 'observe', version: 1 }
