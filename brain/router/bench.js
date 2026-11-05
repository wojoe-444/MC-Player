// Measures the decision model on real chat: latency (cold first call, then warm) and accuracy against the labelled phrase corpus.
//   node brain/router/bench.js [--n 25] [--gap 3200] [--lines file.txt] [--dry]
//   --dry     build the requests and print their size; no network, no key needed
//   --lines   one chat line per row instead of the labelled corpus (e.g. chat.log: "OGWO: text" prefixes are stripped)
// The key comes from OPENROUTER_API_KEY or brain/router/openrouter.key. Free OpenRouter models are limited (about 20 requests a
// minute; the daily cap depends on credits), hence --gap and a small default --n. Nothing is printed that contains the key.
const fs = require('fs')
const path = require('path')
const catalogLib = require('./catalog')
const { buildRequest, interpret } = require('./decide')
const { createClient } = require('./client')
const { INTENTS } = require('../chat/intents')

const arg = (k, d) => { const i = process.argv.indexOf('--' + k); return i < 0 ? d : (process.argv[i + 1] && !process.argv[i + 1].startsWith('--') ? process.argv[i + 1] : true) }
const root = path.resolve(__dirname, '..', '..')
const cfg = JSON.parse(fs.readFileSync(path.join(__dirname, 'config.json'), 'utf8'))

// every brain-native command the integrator registers, so the catalog matches the live bot
const commands = INTENTS.map(i => ({ name: i.id, help: i.canonical, risk: i.risk, canonical: [i.canonical] }))
let waypoints = []
try { waypoints = Object.entries(JSON.parse(fs.readFileSync(path.join(root, 'waypoints.json'), 'utf8').replace(/^﻿/, ''))).map(([name, v]) => ({ name, x: v.x, y: v.y, z: v.z })) } catch {}
const catalog = catalogLib.build({ commands, waypoints })
const idToCanon = Object.fromEntries(INTENTS.map(i => [i.id, i.canonical]))

let items
if (arg('lines')) {
  items = fs.readFileSync(arg('lines'), 'utf8').split(/\r?\n/).map(l => l.replace(/^(?:\S+\s)?OGWO:\s*/, '').trim()).filter(Boolean).map(t => [t, undefined])
} else {
  const { REAL, VARIANTS } = require('../../test/chat.phrases')
  items = [...REAL, ...VARIANTS].filter(([t]) => t.trim() && !t.startsWith('/'))
}
const n = Number(arg('n', 25))
const step = Math.max(1, Math.floor(items.length / n))
items = items.filter((_, i) => i % step === 0).slice(0, n)

const stateFor = (message) => ({ message, doing: 'idle', health: 20, food: 20 })
const pct = (a, p) => a.length ? [...a].sort((x, y) => x - y)[Math.min(a.length - 1, Math.floor(p * a.length))] : null

;(async () => {
  const reqs = items.map(([t]) => buildRequest({ model: cfg.model, state: stateFor(t), catalog }))
  console.log(`catalog: ${catalog.options.length} commands, ${catalog.waypoints.length} waypoints; request ~${JSON.stringify(reqs[0]).length} bytes; ${items.length} lines`)
  if (arg('dry')) return
  const client = createClient({ url: cfg.url, timeoutMs: Number(arg('timeout', 10000)) })
  if (!client.hasKey()) { console.log('No key: set OPENROUTER_API_KEY or put it in brain/router/openrouter.key'); process.exit(2) }
  const ms = [], rows = []
  let right = 0, judged = 0, errors = 0
  for (let i = 0; i < items.length; i++) {
    const [text, exp] = items[i]
    const r = await client.decide(reqs[i])
    if (!r.ok) { errors++; rows.push(`ERR ${r.kind}${r.status ? ' ' + r.status : ''}${r.message ? ' ' + r.message : ''}  | ${text.slice(0, 60)}`); if (r.kind === 'rate' || r.kind === 'auth' || r.kind === 'payment') { console.log(rows[rows.length - 1]); break } }
    else {
      ms.push(r.ms)
      const d = interpret(r.data, catalog, cfg.thresholds, { len: text.length })
      let verdict = ''
      if (exp !== undefined) {
        const want = exp === null ? null : idToCanon[String(exp).replace(/^ask:/, '')] || String(exp)
        const got = d.action === 'defer' ? null : (d.label || null)
        judged++; if (got === want || (want === 'goto-waypoint' && got === 'goto-waypoint')) right++
        verdict = got === want ? 'ok ' : 'BAD'
        if (String(exp).startsWith('ask:') && d.action === 'run') verdict = 'RAN-RISKY'
      }
      rows.push(`${String(r.ms).padStart(5)} ms ${verdict.padEnd(3)} ${d.action.padEnd(5)} ${(d.label || '-').padEnd(22)} p=${d.p ?? '-'} dir=${d.directed ?? '-'} | ${text.slice(0, 60)}`)
    }
    if (i < items.length - 1) await new Promise(r => setTimeout(r, Number(arg('gap', 3200))))
  }
  console.log(rows.join('\n'))
  console.log(`\nlatency: cold first call ${ms[0] ?? '-'} ms; warm median ${pct(ms.slice(1), 0.5) ?? '-'} ms, p95 ${pct(ms.slice(1), 0.95) ?? '-'} ms, max ${ms.length ? Math.max(...ms) : '-'} ms; ${errors} errors of ${items.length}`)
  if (judged) console.log(`accuracy vs labelled corpus: ${right}/${judged} (a defer counts as right only when the label is "not a command")`)
})()
