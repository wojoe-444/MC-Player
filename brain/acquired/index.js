// brain/acquired: "items acquired" for the dashboard's inventory page. An observer: it only listens, it never moves the bot or touches the world.
//
// What counts: every dropped item entity the bot picks up (block drops, mob drops, farm output, items on the ground), read from the server's collect packet
// so the count is what actually went into the bag. What does not count, so nothing is counted twice:
//   * taking things out of a chest or furnace (no collect packet), crafting and smelting (they convert items already counted)
//   * picking up again what the bot itself dropped (bot.toss / bot.tossStack, or the whole bag when it dies) within the 5 minutes an item lives on the ground
// brain/state/acquired.jsonl gets one line { t, item, n } per item per 10 seconds (pickups are coalesced); old lines are merged per hour when the file grows past 6 MB.
// dashboard/server.js sums the file per window (/api/acquired). There is no backfill: the table starts when this module first runs.
const fs = require('fs')
const L = require('./log')

const FLUSH_MS = 10000, COMPACT_BYTES = 6 * 1024 * 1024

module.exports = function register(api) {
  const { bot } = api
  const now = () => (api.now ? api.now() : Date.now())
  const file = api.statePath('acquired.jsonl')
  const pool = L.createSelfDrops()
  const pending = new Map()      // item -> { t (first pickup in this batch), n }
  let timer = null, tossing = 0, started = 0, totals = {}
  const orig = {}

  const bagCounts = (all) => {
    const out = {}
    let list = []
    try { list = all && bot.inventory.slots ? bot.inventory.slots.filter(Boolean) : bot.inventory.items() } catch { /* no inventory yet */ }
    for (const it of list) out[it.name] = (out[it.name] || 0) + it.count
    return out
  }

  function record(name, n) {
    const t = now()
    const net = n - pool.consume(name, n, t)
    if (net <= 0) return
    const p = pending.get(name); if (p) p.n += net; else pending.set(name, { t, n: net })
    totals[name] = (totals[name] || 0) + net
  }

  function flush() {
    if (!pending.size) return
    const lines = [...pending].map(([item, p]) => JSON.stringify({ t: p.t, item, n: p.n })).join('\n') + '\n'
    pending.clear()
    try { fs.appendFileSync(file, lines) } catch (e) { api.log && api.log('acquired', 'write failed: ' + e.message) }
  }

  const onCollect = (p) => {
    try {
      const me = bot.entity
      if (!me || !p || p.collectorEntityId !== me.id) return
      const ent = bot.entities && bot.entities[p.collectedEntityId]
      const it = ent && typeof ent.getDroppedItem === 'function' ? ent.getDroppedItem() : null   // null for xp orbs and arrows
      if (!it || !it.name) return
      record(it.name, p.pickupItemCount > 0 ? p.pickupItemCount : it.count)
    } catch { /* an odd packet is not worth a crash */ }
  }

  // what a toss removed from the bag is what may come back off the ground
  function wrapToss(name) {
    const fn = bot[name]; if (typeof fn !== 'function') return
    const wrapped = async function (...args) {
      if (tossing++) { try { return await fn.apply(this, args) } finally { tossing-- } }
      const before = bagCounts(false)
      try { return await fn.apply(this, args) }
      finally {
        tossing--
        const after = bagCounts(false), t = now()
        for (const [n, c] of Object.entries(before)) if (c > (after[n] || 0)) pool.add(n, c - (after[n] || 0), t)
      }
    }
    orig[name] = { fn, wrapped }; bot[name] = wrapped
  }
  const onDeath = () => { const t = now(); for (const [n, c] of Object.entries(bagCounts(true))) pool.add(n, c, t) }

  function compactIfBig() {
    try {
      if (fs.statSync(file).size <= COMPACT_BYTES) return
      fs.writeFileSync(file + '.tmp', L.compact(fs.readFileSync(file, 'utf8'), now()))
      fs.renameSync(file + '.tmp', file)
    } catch { /* no file yet, or busy: try again next start */ }
  }

  return {
    name: 'acquired',
    start() {
      started = now()
      compactIfBig()
      if (bot._client && typeof bot._client.on === 'function') bot._client.on('collect', onCollect)
      wrapToss('toss'); wrapToss('tossStack')
      bot.on('death', onDeath)
      timer = setInterval(flush, FLUSH_MS); if (timer.unref) timer.unref()
    },
    stop() {
      clearInterval(timer)
      if (bot._client && typeof bot._client.removeListener === 'function') bot._client.removeListener('collect', onCollect)
      for (const [name, o] of Object.entries(orig)) if (bot[name] === o.wrapped) bot[name] = o.fn
      bot.removeListener('death', onDeath)
      flush()
    },
    status() { return { since: started, sessionTotals: { ...totals }, selfDropped: pool.size() } },
    _tick: { flush, pending: () => pending, pool }
  }
}
module.exports.meta = require('./meta.json')
