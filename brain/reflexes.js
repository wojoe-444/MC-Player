// Reflex registry with leased claims (P4 of the architecture taxonomy).
//
// A reflex acts within a tick or a few seconds, whatever the scheduler is running. Before this file they coordinated through loose flags on the bot
// (bot._breathBusyUntil, bot._ashoreUntil, ap.dangerHandled) and by dispatching fake chat commands ("do not fight"). Now each reflex registers once
// and takes short leases on the shared resources it needs; everybody else asks who holds a resource.
//
//   resources (brain/taxonomy.json "claims"):  body  melee  hands  danger
//   const r = reflexes.register({ name: 'breath', priority: 90, claims: ['body'], desc: '...' })
//   r.claim('body', 3000, 'digging out of gravel')    // true when granted; renews if already held; Infinity = until released
//   r.release('body')
//   reflexes.holder('body')                            // 'breath' | null (expired leases are dropped on the way)
//   reflexes.heldByOther('body', 'combat')             // the holder's name when someone else has it, else null
//
// Arbitration: a free or expired resource is granted; the holder renews its own lease; a claimer with a strictly higher priority takes it over
// (the old holder's lease is dropped and counted as a preemption); a lower or equal priority claim is refused. Nothing blocks and nothing is queued:
// a reflex that is refused simply does not act on that resource this tick. A reflex can only claim resources it declared.
// The registry never moves the bot itself. It is in api.reflexes and bot._reflexes (code that only has the bot, like brain/combat/reflex.js, reads it
// there and must work without it, e.g. in the arena harness).
const { CLAIMS } = require('./meta')

function createReflexes({ now = Date.now, log = () => {} } = {}) {
  const reflexes = new Map()      // name -> { name, priority, claims, desc, grants, refusals }
  const leases = new Map()        // resource -> { holder, since, until, reason }
  let preemptions = 0
  const recent = []               // last few preemptions / refusals, for the dashboard
  const note = (s) => { recent.push(`${new Date(now()).toISOString().slice(11, 19)} ${s}`); if (recent.length > 12) recent.shift() }

  function live(resource) {
    const l = leases.get(resource)
    if (l && l.until <= now()) { leases.delete(resource); return null }
    return l || null
  }

  function register({ name, priority = 50, claims = [], desc = '' }) {
    if (!name) throw new Error('reflex needs a name')
    for (const c of claims) if (!CLAIMS.includes(c)) throw new Error(`reflex ${name}: unknown resource "${c}"`)
    const prev = reflexes.get(name)
    const rec = prev || { name, grants: 0, refusals: 0 }
    Object.assign(rec, { priority, claims: [...claims], desc })
    reflexes.set(name, rec)
    return {
      name,
      claim: (resource, ms, reason) => claim(name, resource, ms, reason),
      release: (resource) => release(name, resource),
      holds: (resource) => { const l = live(resource); return !!l && l.holder === name },
      holder
    }
  }

  function claim(name, resource, ms = 1000, reason = '') {
    const r = reflexes.get(name)
    if (!r) { log(`claim by unregistered reflex "${name}"`); return false }
    if (!r.claims.includes(resource)) { log(`${name} did not declare resource "${resource}"`); return false }
    const cur = live(resource), t = now()
    if (cur && cur.holder !== name) {
      const other = reflexes.get(cur.holder)
      if (!other || r.priority > other.priority) { preemptions++; note(`${name} took ${resource} from ${cur.holder}`); log(`${name} took ${resource} from ${cur.holder}`) }
      else { r.refusals++; return false }
    }
    leases.set(resource, { holder: name, since: cur && cur.holder === name ? cur.since : t, until: ms === Infinity ? Infinity : t + Math.max(1, ms), reason: String(reason || '') })
    r.grants++
    return true
  }

  function release(name, resource) {
    const l = leases.get(resource)
    if (l && l.holder === name) { leases.delete(resource); return true }
    return false
  }

  const holder = (resource) => { const l = live(resource); return l ? l.holder : null }
  const heldByOther = (resource, name) => { const h = holder(resource); return h && h !== name ? h : null }

  function status() {
    const t = now()
    return {
      reflexes: [...reflexes.values()].sort((a, b) => b.priority - a.priority).map(r => ({
        name: r.name, priority: r.priority, claims: r.claims, desc: r.desc, grants: r.grants, refusals: r.refusals,
        holds: [...leases.entries()].filter(([res, l]) => l.holder === r.name && l.until > t).map(([resource, l]) => ({ resource, leftMs: l.until === Infinity ? null : l.until - t, reason: l.reason }))
      })),
      leases: [...leases.entries()].filter(([, l]) => l.until > t).map(([resource, l]) => ({ resource, holder: l.holder, ageMs: t - l.since, leftMs: l.until === Infinity ? null : l.until - t, reason: l.reason })),
      preemptions, recent: recent.slice()
    }
  }

  return { register, claim, release, holder, heldByOther, status }
}

// For code that only has the bot: who holds a resource (null when there is no registry).
const holderOf = (bot, resource) => { const r = bot && bot._reflexes; return r ? r.holder(resource) : null }

module.exports = { createReflexes, holderOf }
