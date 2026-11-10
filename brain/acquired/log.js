// brain/acquired/log: the pure parts of the items-acquired log (no bot, no clock of its own).
//   createSelfDrops({ ttlMs })   a pool of what the bot itself dropped: add(name, n, t), consume(name, n, t) -> how many of n it covers (oldest first, expired entries ignored)
//   parse(text)                  jsonl text -> [{ t, item, n }], bad lines skipped
//   compact(text, now, opts)     lines older than olderThanMs are merged into one line per item per hour (keeps the file small; recent lines stay exact)
//   sum(entries, since)          { item: n } for entries with t >= since

// Dropped items despawn after 5 minutes, so a self-dropped stack can only be picked up again within that time (plus a little slack for chunk loading).
const DEFAULT_TTL_MS = 5 * 60000 + 30000

function createSelfDrops({ ttlMs = DEFAULT_TTL_MS } = {}) {
  const byItem = new Map()   // name -> [{ n, t }] oldest first
  const prune = (list, t) => { while (list.length && t - list[0].t > ttlMs) list.shift() }
  return {
    add(name, n, t) {
      if (!name || !(n > 0)) return
      const list = byItem.get(name) || []; byItem.set(name, list)
      list.push({ n, t })
    },
    consume(name, n, t) {
      const list = byItem.get(name); if (!list || !(n > 0)) return 0
      prune(list, t)
      let left = n
      while (left > 0 && list.length) {
        const e = list[0], take = Math.min(left, e.n)
        e.n -= take; left -= take
        if (!e.n) list.shift()
      }
      if (!list.length) byItem.delete(name)
      return n - left
    },
    size() { let s = 0; for (const l of byItem.values()) for (const e of l) s += e.n; return s }
  }
}

function parse(text) {
  const out = []
  for (const line of String(text || '').split('\n')) {
    if (!line) continue
    try {
      const j = JSON.parse(line)
      if (j && typeof j.item === 'string' && j.n > 0 && Number.isFinite(j.t)) out.push({ t: j.t, item: j.item, n: j.n })
    } catch { /* a torn last line */ }
  }
  return out
}

const HOUR = 3600000
function compact(text, now, { olderThanMs = 48 * HOUR } = {}) {
  const old = new Map(), keep = []
  for (const e of parse(text)) {
    if (now - e.t > olderThanMs) {
      const hour = Math.floor(e.t / HOUR) * HOUR, k = hour + '|' + e.item
      const cur = old.get(k); if (cur) cur.n += e.n; else old.set(k, { t: hour, item: e.item, n: e.n })
    } else keep.push(e)
  }
  return [...old.values(), ...keep].sort((a, b) => a.t - b.t).map(e => JSON.stringify(e)).join('\n') + '\n'
}

function sum(entries, since = 0) {
  const out = {}
  for (const e of entries) if (e.t >= since) out[e.item] = (out[e.item] || 0) + e.n
  return out
}

module.exports = { createSelfDrops, parse, compact, sum, DEFAULT_TTL_MS }
