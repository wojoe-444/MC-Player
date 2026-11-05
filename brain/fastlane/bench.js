// Measures the fast lane on chat lines the Elephant-1 router tends to miss: latency, cost, and whether the answer is the right one.
//   node brain/fastlane/bench.js [--models a,b,c] [--extra '{"reasoning":{"enabled":false}}'] [--n 13] [--gap 400] [--lines file.txt] [--dry]
//   --models  bench each model id in turn (default: the model in config.json). Paid models need OpenRouter credits.
//   --extra   JSON merged into the request body (default: config.json extraBody for the configured model, nothing for --models)
//   --lines   one chat line per row ("OGWO: text" prefixes are stripped); no expected answers, so no accuracy column
//   --dry     build the requests and print their size; no network, no key needed
// The key comes from OPENROUTER_API_KEY or brain/fastlane/openrouter.key (else brain/router/openrouter.key). Nothing is printed that
// contains the key. Nothing is executed: decisions are only printed.
const fs = require('fs')
const path = require('path')
const catalogLib = require('../router/catalog')
const { validate } = require('../router/slots')
const { INTENTS } = require('../chat/intents')
const { buildMessages } = require('./decide')
const { createFastlane, regFrom } = require('./index')

const arg = (k, d) => { const i = process.argv.indexOf('--' + k); return i < 0 ? d : (process.argv[i + 1] && !process.argv[i + 1].startsWith('--') ? process.argv[i + 1] : true) }
const root = path.resolve(__dirname, '..', '..')
const commands = INTENTS.map(i => ({ name: i.id, help: i.canonical, risk: i.risk, canonical: [i.canonical] }))
let waypoints = []
try { waypoints = Object.entries(JSON.parse(fs.readFileSync(path.join(root, 'waypoints.json'), 'utf8').replace(/^﻿/, ''))).map(([name, v]) => ({ name, x: v.x, y: v.y, z: v.z })) } catch { /* no waypoints file */ }
const catalog = catalogLib.build({ commands, waypoints })
let reg = { blocks: [], items: [] }
try { reg = regFrom({ registry: require('minecraft-data')('1.21.6') }) } catch { /* registry optional */ }

// [line, regex the outcome "action: canonical-or-reply" must match to count as right]. Escalating is never "right" here: these are
// all lines a fast tier should be able to handle.
const BUILTIN = [
  ['could you tag along with me for a bit', /^(run|ask): follow me$/],
  ['hold your horses', /^run: stay$/],
  ['how are you holding up', /^(say: |run: status)/],
  ['thanks buddy, that was great', /^say: /],
  ['head over to the farm', /^(run|ask): go to /],
  ['go to 120 64 -300', /^(run|ask): go to 120 64 -300$/],
  ['find some iron for me', /^(run|ask): find iron( ore)?$/],
  ['make me 4 sticks', /^ask: craft stick 4$/],
  ['get us some food', /^(run|ask): harvest crops$/],
  ['go to the farm and then tell me the time', /^ask: go to /],
  ['what are you up to right now', /^(run|ask): what are you doing$/],
  ['sleep when it gets dark', /^(run|ask): sleep$/],
  ['are we in danger', /^((run|ask): mob status|say: )/]
]
let items = arg('lines') ? fs.readFileSync(arg('lines'), 'utf8').split(/\r?\n/).map(l => l.replace(/^(?:\S+\s)?OGWO:\s*/, '').trim()).filter(Boolean).map(t => [t, null]) : BUILTIN
items = items.slice(0, Number(arg('n', 13)))
const state = { doing: 'idle', health: 20, food: 20 }
const outcome = (d) => `${d.action}: ${d.canonical || d.reply || d.reason}`
const pct = (a, p) => a.length ? [...a].sort((x, y) => x - y)[Math.min(a.length - 1, Math.floor(p * a.length))] : null

async function benchModel(model, extra, gap) {
  const config = { maxPerDay: 0, cacheMs: 0, timeoutMs: 8000, slowMedianMs: 0, ...(model ? { model } : {}), ...(extra ? { extraBody: extra } : {}) }
  const fl = createFastlane({ config, validate, log: () => {} })
  if (!fl.hasKey()) { console.log('No key: set OPENROUTER_API_KEY or put it in brain/fastlane/openrouter.key (gitignored).'); process.exit(2) }
  const rows = []
  console.log(`\n== ${fl.config().model}  extra=${JSON.stringify(fl.config().extraBody)}`)
  for (const [t, want] of items) {
    const d = await fl.decide({ user: 'OGWO', text: t, state, catalog, reg })
    const o = outcome(d)
    const right = want ? want.test(o) : null
    rows.push({ d, right })
    console.log(`${String(d.ms).padStart(5)} ms ${right === null ? ' ' : right ? '✓' : '✗'} ${o.slice(0, 46).padEnd(46)} <- ${t}${d.model && d.model !== fl.config().model ? '   [' + d.model + ']' : ''}${d.err ? '  ' + d.err.slice(0, 60) : ''}`)
    await new Promise(r => setTimeout(r, gap))
  }
  const ms = rows.filter(r => r.d.ms != null && !/^api-/.test(r.d.reason)).map(r => r.d.ms)
  const cost = rows.reduce((a, r) => a + (r.d.cost || 0), 0)
  const st = fl.status()
  const usable = rows.filter(r => r.d.action !== 'escalate').length
  const right = rows.filter(r => r.right).length
  const sum = { model: fl.config().model, calls: st.calls, ok: st.ok, usable, right: want0() ? right : null, n: rows.length, p50: pct(ms, 0.5), p95: pct(ms, 0.95), costPerCall: st.ok ? cost / st.ok : null, errors: st.errors }
  console.log(`-> ${sum.model}: ${sum.ok}/${sum.calls} ok, ${usable}/${rows.length} usable, ${want0() ? right + '/' + rows.length + ' right, ' : ''}p50 ${sum.p50} ms, p95 ${sum.p95} ms, ${sum.costPerCall == null ? 'cost n/a' : '$' + sum.costPerCall.toFixed(6) + '/call'}${Object.keys(sum.errors).length ? ', errors ' + JSON.stringify(sum.errors) : ''}`)
  return sum
}
const want0 = () => items.some(([, w]) => w)

;(async () => {
  if (arg('dry')) {
    for (const [t] of items) { const { messages } = buildMessages({ text: t, state, catalog }); console.log(`${String(JSON.stringify(messages).length).padStart(6)} chars  ${t}`) }
    return
  }
  const gap = Number(arg('gap', 400))
  const extra = arg('extra') ? JSON.parse(arg('extra')) : (arg('models') ? {} : undefined)
  const models = arg('models') ? String(arg('models')).split(',').map(s => s.trim()).filter(Boolean) : [null]
  const sums = []
  for (const m of models) sums.push(await benchModel(m, extra, gap))
  if (sums.length > 1) {
    console.log('\nSUMMARY (model | usable | right | p50 | p95 | $/call)')
    for (const s of sums) console.log(`${s.model.padEnd(44)} ${String(s.usable).padStart(2)}/${s.n} ${s.right == null ? '' : String(s.right).padStart(2) + '/' + s.n} ${String(s.p50).padStart(5)} ${String(s.p95).padStart(5)} ${s.costPerCall == null ? 'n/a' : '$' + s.costPerCall.toFixed(6)}`)
  }
})()
