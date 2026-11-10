#!/usr/bin/env node
// Read a bot's journal (brain/journal, docs/MEMORY-LOOP.md job 1) from outside the bot: for a person, a scheduled agent, or a test.
//   node tools/journal.js [--state <brain/state>] days                      the days on record, with their headline numbers
//   node tools/journal.js [--state ...] day [YYYY-MM-DD]                    one day's rollup as text (default: the latest day)
//   node tools/journal.js [--state ...] search <text> [--k death,alarm] [--since 2026-11-10T06:00 | 6h | 2d] [--until ...] [--step harvest] [--sal] [--limit 50] [--json]
//   node tools/journal.js [--state ...] salient [--since ...]               shorthand for: search "" --sal
//   node tools/journal.js [--state ...] rebuild [YYYY-MM-DD]                recompute the rollup(s) from the event files
// --state defaults to ./brain/state. A bot folder works too (its brain/state is used).
'use strict'
const fs = require('fs')
const path = require('path')
const { rollup } = require('../brain/journal/rollup')

const readJsonl = (f) => { try { return fs.readFileSync(f, 'utf8').split('\n').filter(Boolean).map(l => { try { return JSON.parse(l) } catch { return null } }).filter(Boolean) } catch { return [] } }
const readJson = (f, d = null) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')) } catch { return d } }

function journalDir(state) {
  const s = path.resolve(state || path.join('brain', 'state'))
  for (const c of [path.join(s, 'journal'), path.join(s, 'brain', 'state', 'journal'), s]) if (fs.existsSync(c) && fs.readdirSync(c).some(f => /^\d{4}-\d\d-\d\d\.jsonl$/.test(f))) return c
  return path.join(s, 'journal')
}
const dates = (dir) => { try { return fs.readdirSync(dir).map(f => (/^(\d{4}-\d\d-\d\d)\.jsonl$/.exec(f) || [])[1]).filter(Boolean).sort() } catch { return [] } }

// "6h", "2d", "30m" before now, or an ISO time. Pure given `now`.
function parseTime(s, now = Date.now()) {
  if (!s) return null
  const m = /^(\d+(?:\.\d+)?)([mhd])$/.exec(String(s))
  if (m) return now - Number(m[1]) * { m: 60000, h: 3600000, d: 86400000 }[m[2]]
  const t = Date.parse(/[zZ]|[+-]\d\d:?\d\d$/.test(s) ? s : s + (s.length <= 10 ? 'T00:00:00Z' : 'Z'))
  return Number.isFinite(t) ? t : null
}

// Pure: events -> the ones that match. text matches anywhere in the event's JSON, case-insensitive.
function search(events, { text = '', kinds = null, since = null, until = null, step = null, sal = false, limit = 0 } = {}) {
  const needle = String(text || '').toLowerCase()
  let out = events.filter(e => {
    if (kinds && !kinds.includes(e.k)) return false
    if (sal && !e.sal) return false
    if (step && e.step !== step) return false
    const t = Date.parse(e.at)
    if (since != null && t < since) return false
    if (until != null && t > until) return false
    return !needle || JSON.stringify(e).toLowerCase().includes(needle)
  })
  if (limit > 0 && out.length > limit) out = out.slice(-limit)
  return out
}

function line(e) {
  const { at, k, day, sal, ...rest } = e
  const body = k === 'step' ? `${rest.prev || '-'} -> ${rest.step}${rest.pos ? ` at ${rest.pos.join(',')}` : ''}`
    : k === 'result' ? `${rest.step} ${rest.out} (${Math.round((rest.ms || 0) / 1000)}s)`
    : k === 'alarm' ? (rest.ev === 'raised' ? `${rest.type} raised in ${rest.step || '?'}: ${rest.cause}` : `${rest.type} cleared after ${rest.secs}s, fix level ${rest.level}`)
    : k === 'death' ? `${rest.cause || rest.text}${rest.pos ? ` at ${rest.pos.join(',')}` : ''}${rest.doing ? `, doing ${rest.doing}` : ''}`
    : k === 'flag' ? `${rest.kind} (${rest.sev}): ${rest.msg}`
    : k === 'items' ? Object.entries(rest.items).map(([n, c]) => `${n} ${c}`).join(', ')
    : k === 'commit' ? `${rest.commit} ${rest.subject}`
    : k === 'chat' ? `${rest.from}: ${rest.text}`
    : k === 'note' ? `[${rest.tag}] ${rest.text}`
    : JSON.stringify(rest)
  return `${at.slice(0, 19).replace('T', ' ')} ${sal ? '*' : ' '} ${String(k).padEnd(6)} ${day != null ? `d${day} ` : ''}${body}`
}

function dayText(r) {
  const L = [`# Journal ${r.date}: ${r.events} events, ${r.from ? r.from.slice(11, 16) : '-'} to ${r.to ? r.to.slice(11, 16) : '-'} UTC`]
  L.push(`deaths ${r.deaths.length}; alarms ${r.alarms.raised} (${r.alarms.stalledMin} min stalled, worst fix level ${r.alarms.maxLevel}); high flags ${r.flagsHigh}; starts ${r.starts}; commits ${r.commits.length}; chat ${r.chat}`)
  const steps = Object.entries(r.steps).sort((a, b) => (b[1].minutes + b[1].stalledMin) - (a[1].minutes + a[1].stalledMin)).slice(0, 15)
  if (steps.length) { L.push('', 'step            runs   min    ok  fail  t/o  alarms  stalled min'); for (const [id, s] of steps) L.push(`${id.padEnd(15)} ${String(s.runs).padStart(4)} ${String(s.minutes).padStart(5)} ${String(s.ok).padStart(5)} ${String(s.fail).padStart(5)} ${String(s.timeout).padStart(4)} ${String(s.alarms).padStart(7)} ${String(s.stalledMin).padStart(12)}`) }
  const kv = (o, n = 10) => Object.entries(o).sort((a, b) => b[1] - a[1]).slice(0, n).map(([k, v]) => `${k} ${v}`).join(', ')
  if (Object.keys(r.flags).length) L.push('', 'flags: ' + kv(r.flags))
  if (Object.keys(r.items).length) L.push('items: ' + kv(r.items, 15))
  if (r.firsts.length) L.push('first time: ' + r.firsts.join(', '))
  const gate = Object.entries(r.gate).map(([k, v]) => `${k} ${v.violations} logged / ${v.blocked} blocked`); if (gate.length) L.push('gate: ' + gate.join(', '))
  for (const d of r.deaths) L.push(`death ${d.at.slice(11, 16)}: ${d.cause}${d.doing ? `, doing ${d.doing}` : ''}`)
  if (r.salient.length) { L.push('', 'look at first:'); for (const s of r.salient) L.push(`  ${s.at.slice(11, 16)} ${s.k}: ${s.what}`); if (r.salientDropped) L.push(`  (and ${r.salientDropped} more)`) }
  return L.join('\n')
}

function main(argv) {
  const opt = { _: [] }
  for (let i = 0; i < argv.length; i++) { const a = argv[i]; if (a === '--sal' || a === '--json') opt[a.slice(2)] = true; else if (a.startsWith('--')) opt[a.slice(2)] = argv[++i]; else opt._.push(a) }
  const dir = journalDir(opt.state), all = dates(dir), cmd = opt._[0] || 'days'
  if (!all.length) { console.log(`no journal in ${dir} yet (the bot writes it once brain/journal has run)`); return 0 }
  if (cmd === 'days') {
    for (const d of all) { const r = readJson(path.join(dir, `${d}.day.json`)) || rollup(readJsonl(path.join(dir, `${d}.jsonl`)), { date: d }); console.log(`${d}  events ${String(r.events).padStart(5)}  deaths ${r.deaths.length}  alarms ${String(r.alarms.raised).padStart(3)}  stalled ${String(r.alarms.stalledMin).padStart(5)} min  high flags ${String(r.flagsHigh).padStart(3)}  commits ${r.commits.length}`) }
    return 0
  }
  if (cmd === 'day' || cmd === 'rebuild') {
    const want = opt._[1] ? [opt._[1]] : (cmd === 'rebuild' ? all : [all[all.length - 1]])
    for (const d of want) {
      const r = rollup(readJsonl(path.join(dir, `${d}.jsonl`)), { date: d })
      if (cmd === 'rebuild') { fs.writeFileSync(path.join(dir, `${d}.day.json`), JSON.stringify(r, null, 1)); console.log(`rebuilt ${d}: ${r.events} events`) } else console.log(opt.json ? JSON.stringify(r, null, 1) : dayText(r))
    }
    return 0
  }
  if (cmd === 'search' || cmd === 'salient') {
    const since = parseTime(opt.since), until = parseTime(opt.until)
    const from = since != null ? new Date(since).toISOString().slice(0, 10) : all[0], to = until != null ? new Date(until).toISOString().slice(0, 10) : all[all.length - 1]
    const events = all.filter(d => d >= from && d <= to).flatMap(d => readJsonl(path.join(dir, `${d}.jsonl`)))
    const hits = search(events, { text: cmd === 'search' ? opt._.slice(1).join(' ') : '', kinds: opt.k ? String(opt.k).split(',') : null, since, until, step: opt.step || null, sal: cmd === 'salient' || !!opt.sal, limit: Number(opt.limit) || (opt.json ? 0 : 200) })
    for (const e of hits) console.log(opt.json ? JSON.stringify(e) : line(e))
    if (!opt.json) console.log(`${hits.length} event${hits.length === 1 ? '' : 's'}`)
    return 0
  }
  console.error('unknown command: ' + cmd + ' (days | day | search | salient | rebuild)'); return 1
}

module.exports = { search, parseTime, line, dayText, journalDir }
if (require.main === module) process.exitCode = main(process.argv.slice(2))
