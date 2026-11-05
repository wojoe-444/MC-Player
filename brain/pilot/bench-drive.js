// node brain/pilot/bench-drive.js model1 model2 ...     (key: env OPENROUTER_API_KEY or brain/router/openrouter.key; never printed)
// Scores candidate models on the DRIVING job: pick the right command for an order, stay silent on statements, read priority directives, reply well.
// Each case: { text, cmd } cmd = expected canonical command | null (statement: must NOT trigger a command) | 'any' (either is fine); dir = expected directive urgency.
const fs = require('fs')
const path = require('path')
const ROOT = path.resolve(__dirname, '..', '..')
const { createTalker } = require('./talker')
const catalogLib = require('../router/catalog')
const { validate } = require('../router/slots')
const mc = require('minecraft-data')('1.21.6')

const H = (help, risk = 'low') => ({ name: help.split('|')[0].trim().replace(/\W+/g, '-'), help, risk, canonical: help.split('|').map(s => s.trim()) })
const COMMANDS = [
  H('chop trees | cut down trees | get wood', 'high'), H('stop chopping'), H('mine <ore> <amount> | go mine for diamonds', 'high'), H('stop mining'), H('resume mining', 'high'), H('mining status | how is the mining going'),
  H('build tower | build my tower | start the tower', 'high'), H('build status | how is the tower going'), H('pause building | stop building'), H('resume building | continue the tower', 'high'),
  H('furnace status'), H('furnace deposit'), H('furnace balance'), H('start furnace upkeep', 'high'), H('stop furnace upkeep'), H('harvest crops', 'high'), H('store crops'), H('farm status | how is the farm'),
  H('sleep | go to bed'), H('what are you doing'), H('inventory'), H('stay'), H('follow me'), H('tree status | how is the tree farm'), H('light up | place torches | fix the lighting', 'high'), H('excavate | resume excavation | continue the excavation', 'high'), H('mob status | any mobs near')
]
const WP = [{ name: 'farm', x: -1067, y: 160, z: 2360 }, { name: 'house', x: -1060, y: 160, z: 2341 }, { name: 'meadow', x: -984, y: 70, z: 2292 }]
const catalog = catalogLib.build({ commands: COMMANDS, waypoints: WP })
const reg = { blocks: mc.blocksArray.map(b => b.name), items: mc.itemsArray.map(i => i.name) }

const CASES = [
  { text: 'chop some trees please', cmd: 'chop trees' }, { text: 'go mine 10 iron', cmd: 'mine iron 10' }, { text: 'craft 3 torches', cmd: 'craft torch 3' },
  { text: 'go to the farm', cmd: 'go to farm' }, { text: 'how is the furnace doing', cmd: 'furnace status' }, { text: 'start the tower', cmd: 'build tower' },
  { text: 'find some diamonds', cmd: 'find diamond ore' }, { text: 'stop mining', cmd: 'stop mining' }, { text: 'harvest the crops', cmd: 'harvest crops' },
  { text: 'what are you up to', cmd: 'what are you doing' }, { text: 'go to 100 70 -200', cmd: 'go to 100 70 -200' }, { text: 'time to go to bed', cmd: 'sleep' },
  { text: 'we should chop more trees at some point', cmd: null }, { text: 'i think mining iron would be good for tomorrow', cmd: null }, { text: 'your mining is really slow', cmd: null },
  { text: 'the meadow site is approved for your build', cmd: null }, { text: 'yes that one', cmd: null }, { text: 'should we build the tower first?', cmd: null },
  { text: "don't chop the oak trees by the house", cmd: null }, { text: 'did you get any iron yet?', cmd: 'any' },
  { text: 'drop everything and finish the tower now', cmd: 'any', dir: 'now' }, { text: 'when you get a chance, get some more iron', cmd: 'any', dir: 'background' },
  { text: 'forget the farm for the next hour, focus on mining', cmd: 'any', dir: 'now' }, { text: 'how long should you stick with the tower?', cmd: null, dir: null }
]
const state = { doing: 'furnace upkeep (3/5 chests)', health: 20, food: 17, time: 'day', routines: { farm: 'on', furnace: 'on' }, carrying: { food: 24, pickaxe: 'iron' }, directives: [{ focus: 'tower', urgency: 'now', persist: 'until_done', walter_said: 'finish the tower before anything else' }] }

const EXTRA = process.env.BENCH_EXTRA ? JSON.parse(process.env.BENCH_EXTRA) : { reasoning: { enabled: false }, provider: { sort: 'latency' } }
async function runModel(model) {
  let extra = EXTRA
  const mk = () => createTalker({ config: { model, timeoutMs: 12000, maxTokens: 200, temperature: 0.3, extraBody: extra } })
  let t = mk()
  if (!t.hasKey()) return { model, error: 'no key' }
  const rows = []
  for (const c of CASES) {
    let r = await t.reply({ text: c.text, state, notes: '', history: [], recentBot: [], catalog, reg, validate })
    if (r.reason && /^api-(http|bad)/.test(r.reason) && Object.keys(extra).length) { extra = {}; t = mk(); r = await t.reply({ text: c.text, state, notes: '', history: [], recentBot: [], catalog, reg, validate }) }   // model rejects the extra params
    rows.push({ c, r })
  }
  return { model, rows, status: t.status() }
}
function score(rows) {
  let ok = 0, n = 0, falseCmd = 0, missed = 0, dirOk = 0, dirN = 0, errs = 0
  for (const { c, r } of rows) {
    const got = r.action === 'run' || r.action === 'ask' ? r.canonical : null
    if (r.action === 'defer' && /^(api|unavailable|exception|unparseable|empty)/.test(r.reason)) errs++
    if (c.cmd === 'any') { /* free */ } else { n++; if (c.cmd === null ? !got : got === c.cmd) ok++; else if (c.cmd === null) falseCmd++; else missed++ }
    if (c.dir !== undefined) { dirN++; if ((c.dir === null && !r.directive) || (c.dir && r.directive && r.directive.urgency === c.dir)) dirOk++ }
  }
  return { cmdAcc: `${ok}/${n}`, falseCmd, missed, dir: `${dirOk}/${dirN}`, errs }
}

;(async () => {
  const models = process.argv.slice(2)
  const results = await Promise.all(models.map(runModel))
  for (const R of results) {
    if (R.error) { console.log(R.model, R.error); continue }
    const lat = R.rows.map(x => x.r.ms).sort((a, b) => a - b)
    const s = score(R.rows)
    console.log(`\n=== ${R.model}  commands ${s.cmdAcc} (false triggers ${s.falseCmd}, missed ${s.missed})  directives ${s.dir}  errors ${s.errs}  latency median ${lat[Math.floor(lat.length / 2)]} ms, p90 ${lat[Math.floor(lat.length * 0.9)]} ms`)
    if (process.env.BENCH_VERBOSE) for (const { c, r } of R.rows) console.log(`  [${r.ms}ms ${r.action}${r.canonical ? ' ' + r.canonical : ''}${r.directive ? ' dir:' + r.directive.urgency + '/' + r.directive.persist : ''}] ${c.text.slice(0, 50)} => ${r.text || r.reason || ''}`.slice(0, 220))
  }
})()
