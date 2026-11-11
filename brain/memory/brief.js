// brain/memory/brief: the pure parts of the dawn brief (docs/MEMORY-LOOP.md, job 3). No bot, no files, no model.
//
//   buildRequest(...)    everything the brief needs to see, as one JSON object the laptop job turns into a prompt
//   digest(rollup)       a journal rollup cut down to what a plan needs: what ran, what failed, what stalled, what was gained
//   validate(answer,..)  the model's answer -> a brief the step picker can trust, plus what was dropped and why
//   active(brief, ...)   the brief as it applies right now (null when stale), with expired holds removed
//
// The limits are here, in code, and the picker applies them again: a brief cannot hold a survival step or the bot's free time, cannot name a step
// that does not exist, holds at most three steps for at most three in-game days, and stops counting three hours after it was written.
'use strict'

const SURVIVAL = new Set(['eat', 'take-cover', 'recover', 'rebed', 'night-home', 'food', 'cook', 'shelter', 'move-home'])
const UNHOLDABLE = new Set([...SURVIVAL, 'whimsy'])
const WHIMSY = {
  vantage: 'walk to the highest ground I can reach near home, look around, and save the spot',
  wander: 'a short walk somewhere new, close to home, in daylight',
  home: 'stay at home and look around',
  none: 'no free-time plan today',
}
const LIMITS = { focus: 3, holds: 3, holdDays: 3, ttlMs: 3 * 3600000, why: 240, intent: 300 }
const cut = (s, n) => { s = String(s == null ? '' : s).replace(/\s+/g, ' ').trim(); return s.length > n ? s.slice(0, n - 1) + '…' : s }
const top = (obj, n) => Object.entries(obj || {}).sort((a, b) => b[1] - a[1]).slice(0, n)

function digest(r) {
  if (!r || !r.events) return null
  const steps = Object.entries(r.steps || {}).map(([id, s]) => ({ id, runs: s.runs, min: s.minutes, ok: s.ok, fail: s.fail, timeout: s.timeout, alarms: s.alarms, stalledMin: s.stalledMin }))
    .filter(s => s.runs || s.alarms || s.fail || s.timeout).sort((a, b) => (b.min + b.stalledMin * 3 + b.fail + b.timeout) - (a.min + a.stalledMin * 3 + a.fail + a.timeout)).slice(0, 14)
  return {
    from: r.from, to: r.to, steps,
    alarms: { raised: r.alarms.raised, stalledMin: r.alarms.stalledMin, worstFixLevel: r.alarms.maxLevel },
    deaths: (r.deaths || []).slice(-5).map(d => ({ at: d.at, cause: d.cause, doing: d.doing, pos: d.pos })),
    flags: Object.fromEntries(top(r.flags, 6)), itemsGained: Object.fromEntries(top(r.items, 12)), firsts: (r.firsts || []).slice(-10),
    gateBlocked: Object.fromEntries(Object.entries(r.gate || {}).filter(([, v]) => v.blocked).map(([k, v]) => [k, v.blocked])),
    lookAtFirst: (r.salient || []).slice(-12).map(s => `${String(s.at).slice(11, 16)} ${s.k}: ${cut(s.what, 160)}`),
  }
}

// the in-game clock in words: a model reads "1900" as an hour of the evening
function clock(tod) {
  if (!Number.isFinite(tod)) return null
  const t = ((tod % 24000) + 24000) % 24000
  const part = t < 1000 ? 'sunrise' : t < 6000 ? 'morning' : t < 11500 ? 'afternoon' : t < 13000 ? 'dusk' : t < 23000 ? 'night' : 'just before sunrise'
  const left = t < 12000 ? Math.round((12000 - t) / 1200) : 0
  return `${part}${left ? `, about ${left} real minutes of daylight left` : ', dark until sunrise'} (a full in-game day is 20 real minutes)`
}

function buildRequest({ id, at, reason, bot, role, day, timeOfDay, steps = [], state = {}, rules = [], global = '', notes = [], since = null, lastBrief = null, refused = [], findings = [], roadmap = null }) {
  return {
    v: 1, id, at, reason, bot, role, day, clock: clock(timeOfDay),
    steps: steps.filter(s => typeof s === 'string'), cannotHold: [...UNHOLDABLE].filter(s => steps.includes(s) || s === 'whimsy'),
    freeTimeChoices: WHIMSY, limits: { focus: LIMITS.focus, holds: LIMITS.holds, holdDays: LIMITS.holdDays },
    rules, memory: { global, notes },
    lastBrief: lastBrief ? { at: lastBrief.at, day: lastBrief.day, intent: lastBrief.intent, focus: lastBrief.focus, holds: lastBrief.holds, freeTime: lastBrief.freeTime } : null,
    refusedLastTime: refused.slice(0, 6),
    sinceLastBrief: since,
    reviewerFindings: findings.slice(0, 8).map(f => ({ key: f.key, severity: f.severity, title: cut(f.title, 140), suggestion: cut(f.suggestion, 200) })),
    roadmap, state,
  }
}

// The model's answer -> { brief, edits, dropped }. `steps` is the list the picker really has; anything else is dropped with a reason the next brief is shown.
function validate(answer, { steps = [], day = 0, now = Date.now(), id = null, model = null } = {}) {
  const a = answer && typeof answer === 'object' ? answer : {}
  const known = new Set(steps), dropped = []
  const focus = []
  for (const s of (Array.isArray(a.focus) ? a.focus : [])) {
    if (!known.has(s)) { dropped.push(`focus "${cut(s, 40)}": no such step`); continue }
    if (s === 'whimsy') { dropped.push('focus "whimsy": free time has its own slot every day'); continue }
    if (!focus.includes(s) && focus.length < LIMITS.focus) focus.push(s)
  }
  const holds = []
  for (const h of (Array.isArray(a.holds) ? a.holds : [])) {
    const s = h && h.step
    if (!known.has(s)) { dropped.push(`hold "${cut(s, 40)}": no such step`); continue }
    if (UNHOLDABLE.has(s)) { dropped.push(`hold "${s}": ${s === 'whimsy' ? 'free time is not put on hold' : 'a survival step is never put on hold'}`); continue }
    if (focus.includes(s)) { dropped.push(`hold "${s}": it is also a focus step, the focus stands`); continue }
    if (holds.length >= LIMITS.holds) { dropped.push(`hold "${s}": at most ${LIMITS.holds} holds`); continue }
    if (holds.some(x => x.step === s)) continue
    const days = Math.max(1, Math.min(LIMITS.holdDays, Math.round(Number(h.days) || 1)))
    holds.push({ step: s, untilDay: day + days, why: cut(h.why, LIMITS.why) })
  }
  const ft = a.freeTime && typeof a.freeTime === 'object' ? a.freeTime : {}
  const choice = Object.prototype.hasOwnProperty.call(WHIMSY, ft.choice) ? ft.choice : 'none'
  if (ft.choice && choice !== ft.choice) dropped.push(`free time "${cut(ft.choice, 40)}": not one of ${Object.keys(WHIMSY).join(', ')}`)
  const m = a.memory && typeof a.memory === 'object' ? a.memory : {}
  return {
    brief: {
      v: 1, id, at: new Date(now).toISOString(), until: now + LIMITS.ttlMs, day, model,
      intent: cut(a.intent, LIMITS.intent), focus, holds,
      freeTime: { choice, note: cut(ft.note, 200) }, ask: a.ask ? cut(a.ask, 240) : null, dropped,
    },
    edits: {
      now: typeof m.now === 'string' ? m.now : (a.intent ? String(a.intent) : ''), projects: typeof m.projects === 'string' ? m.projects : null,
      addPolicies: Array.isArray(m.addPolicies) ? m.addPolicies : [], addTraps: Array.isArray(m.addTraps) ? m.addTraps : [], remove: Array.isArray(m.remove) ? m.remove : [],
    },
    dropped,
  }
}

// What of a brief applies now. A stale or malformed brief is no brief: the step list then plays exactly as it does without one.
function active(brief, { now = Date.now(), day = null } = {}) {
  if (!brief || typeof brief !== 'object' || !(brief.until > now) || !(Date.parse(brief.at) <= now + 60000)) return null
  const holds = (Array.isArray(brief.holds) ? brief.holds : []).filter(h => h && typeof h.step === 'string' && !UNHOLDABLE.has(h.step) && (day == null || (h.untilDay > day && h.untilDay - day <= LIMITS.holdDays))).slice(0, LIMITS.holds)
  const focus = (Array.isArray(brief.focus) ? brief.focus : []).filter(s => typeof s === 'string' && s !== 'whimsy').slice(0, LIMITS.focus)
  const choice = brief.freeTime && Object.prototype.hasOwnProperty.call(WHIMSY, brief.freeTime.choice) ? brief.freeTime.choice : 'none'
  return { id: brief.id || null, focus, holds, held: new Set(holds.map(h => h.step)), freeTime: { choice, note: (brief.freeTime && brief.freeTime.note) || '' } }
}

module.exports = { buildRequest, digest, validate, active, clock, SURVIVAL, UNHOLDABLE, WHIMSY, LIMITS }
