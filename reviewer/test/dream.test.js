// The dream job, work orders and the reasons findings close with (docs/MEMORY-LOOP.md, phase 2). No model, no bot: a fake `ask` and temp folders.
const test = require('node:test')
const assert = require('node:assert')
const fs = require('fs')
const os = require('os')
const path = require('path')
const dream = require('../lib/dream')
const orders = require('../lib/orders')
const runs = require('../lib/runs')
const findings = require('../lib/findings')
const schedule = require('../lib/schedule')
const { resolveConfig, loopDirOf } = require('../lib/config')
const STORE = require('../../brain/memory/store')
const { rollup } = require('../../brain/journal/rollup')

const NOW = Date.parse('2026-11-10T22:55:00Z')
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'dream-'))
const iso = (minAgo) => new Date(NOW - minAgo * 60000).toISOString()

// a day in which the iron step stalls again and again, with two lava deaths and a noisy flag
function events() {
  const ev = []
  for (let i = 0; i < 12; i++) {
    ev.push({ at: iso(600 - i * 20), k: 'alarm', ev: 'raised', type: 'STALL', id: 'A' + i, cause: `autopilot-stalled:iron idle ${40 + i}s`, step: 'iron', level: 1 })
    ev.push({ at: iso(600 - i * 20 - 1), k: 'alarm', ev: 'cleared', type: 'STALL', id: 'A' + i, secs: 90, level: 1 })
  }
  ev.push({ at: iso(500), k: 'death', cause: 'tried to swim in lava', doing: 'recover', pos: [-6018, 46, -2345], sal: 1 })
  ev.push({ at: iso(300), k: 'death', cause: 'tried to swim in lava', doing: 'iron', pos: [-6017, 47, -2346], sal: 1 })
  for (let i = 0; i < 11; i++) ev.push({ at: iso(200 - i), k: 'flag', kind: 'jumping', sev: 'high', msg: '20 jumps in the last minute' })
  ev.push({ at: iso(30), k: 'alarm', ev: 'raised', type: 'STALL', id: 'B1', cause: 'autopilot-stalled:stash idle 45s', step: 'stash', level: 1 })
  return ev.sort((a, b) => (a.at < b.at ? -1 : 1))
}
const GLOBAL = STORE.render({
  [STORE.S_NOW]: ['Day 55. Smelt iron.'],
  [STORE.S_POL]: [
    '- Be home or sealed in before dark | from the first strategy file, untested | deaths at night per day',
    '- Iron trips pay off below y 0 | 14 iron on 11-09 | iron per trip',
    '- No armor at all | Walter said so | armor flags',
  ],
  [STORE.S_TRAPS]: ['- Lava by the shaft at y 46', '- My bag holds 96 cobblestone', '- Creepers gather at the west door at dusk'],
  [STORE.S_MINE]: ['- A private room off the shaft, one day.'],
  [STORE.S_HOW]: ['- I read this every dawn.'],
})
function mkBot(root, id = 'ozo', { memory = true, evs = events() } = {}) {
  const dir = path.join(root, id), sd = path.join(dir, 'brain', 'state')
  fs.mkdirSync(path.join(sd, 'journal'), { recursive: true }); fs.mkdirSync(path.join(sd, 'runlog'), { recursive: true })
  const byDate = {}
  for (const e of evs) (byDate[e.at.slice(0, 10)] = byDate[e.at.slice(0, 10)] || []).push(e)
  for (const [d, list] of Object.entries(byDate)) fs.writeFileSync(path.join(sd, 'journal', `${d}.jsonl`), list.map(e => JSON.stringify(e)).join('\n') + '\n')
  if (memory) {
    fs.mkdirSync(path.join(sd, 'memory'), { recursive: true }); fs.writeFileSync(path.join(sd, 'memory', 'global.md'), GLOBAL)
    fs.writeFileSync(path.join(sd, 'memory', 'brief-request.json'), JSON.stringify({ at: iso(60), rules: ['- No armor. (noArmor, enforced: the action is dropped)', '- Torches at least 2 air blocks apart. (torchSpacing, watched)'], state: { home: [-6018, 64, -2355], pos: [-6019, 64, -2356] } }))
  }
  return { id, name: id === 'ozo' ? 'OzoGo444' : 'Smeo444', dir }
}
const cfgFor = (root, bots) => ({ bots, loopDir: path.join(root, 'loop'), outDir: path.join(root, 'out'), model: 'claude-haiku-5-5', effort: 'xhigh', git: false })
const factId = (prompt, re) => { const m = new RegExp(`^(E\\d+): .*${re}`, 'm').exec(prompt); return m && m[1] }
const lineId = (prompt, re) => { const m = new RegExp(`^([PT]\\d+): .*${re}`, 'm').exec(prompt); return m && m[1] }

test('candidates: keys come from what the journal measured, cost is stalled minutes plus failed share plus a flat cost per death', () => {
  const ev = events(), c = orders.candidates({ rollup: rollup(ev), events: ev, findings: [{ key: 'ozo-torch', severity: 'high', seenRuns: 7, title: 'Torches too close', evidence: 'two torches 2 apart', firstSeen: iso(90) }, { key: 'ozo-low', severity: 'low', seenRuns: 30 }] })
  const by = Object.fromEntries(c.map(x => [x.key, x]))
  assert.deepStrictEqual(Object.keys(by).sort(), ['death-tried-to-swim-in-lava', 'finding-ozo-torch', 'flag-jumping', 'step-iron'])
  assert.strictEqual(by['step-iron'].costMin, 18)                                   // 12 alarms of 90 s
  assert.match(by['step-iron'].evidence[0], /^12x STALL: autopilot-stalled:iron idle Ns$/)   // the seconds are folded so one cause is one line
  assert.strictEqual(by['death-tried-to-swim-in-lava'].costMin, 2 * orders.DEATH_MIN)
  assert.strictEqual(by['flag-jumping'].costMin, 0)
  assert.strictEqual(c[0].key, 'death-tried-to-swim-in-lava')                       // most costly first
  assert.ok(!by['step-stash'], 'one alarm is not a candidate')
  // a step whose runs mostly fail loses that share of its minutes
  const r = { steps: { harvest: { runs: 10, minutes: 40, ok: 2, fail: 6, timeout: 2, other: 0, alarms: 0, stalledMin: 0 } }, deaths: [], flags: {} }
  assert.strictEqual(orders.candidates({ rollup: r })[0].costMin, 32)
})

test('orders.sync: opens only what was judged a bug, updates cost, remembers "not a bug", closes with a reason after quiet dreams, reopens on return', () => {
  const loop = path.join(tmp(), 'loop'), ev = events()
  const cands = orders.candidates({ rollup: rollup(ev), events: ev })
  assert.strictEqual(orders.undecided(loop, cands, NOW).length, 3)
  const decided = { 'step-iron': { isBug: true, kind: 'bug', title: 'iron step idles', problem: 'It stalls 12 times a day.', suggestion: 'the iron step', findings: ['ozo-iron'], why: 'same stall' }, 'flag-jumping': { isBug: false, why: 'thin' } }
  let r = orders.sync(loop, { bot: 'ozo', cands, decided, now: NOW })
  assert.deepStrictEqual(r.opened, ['step-iron'])
  let o = orders.load(loop, 'step-iron')
  assert.strictEqual(o.status, 'open'); assert.strictEqual(o.costMin, 18); assert.deepStrictEqual(o.findings, ['ozo-iron']); assert.strictEqual(o.bots.ozo.counts.alarms, 12)
  assert.ok(!orders.load(loop, 'flag-jumping') && !orders.load(loop, 'death-tried-to-swim-in-lava'), 'no order without a bug verdict')
  // next dream: the open order and the fresh "not a bug" are not asked again; the candidate nobody judged still is
  assert.deepStrictEqual(orders.undecided(loop, cands, NOW + 2 * 3600000).map(c => c.key), ['death-tried-to-swim-in-lava'])
  assert.ok(orders.undecided(loop, cands, NOW + 25 * 3600000).some(c => c.key === 'flag-jumping'), 'a "not a bug" is asked again after a day')
  // the second bot shows the same step: one order, costs added
  r = orders.sync(loop, { bot: 'smeo', cands: [{ ...cands.find(c => c.key === 'step-iron'), costMin: 5 }], now: NOW + 1000 })
  assert.deepStrictEqual(r.updated, ['step-iron']); assert.strictEqual(orders.load(loop, 'step-iron').costMin, 23)
  // quiet: it takes QUIET_DREAMS dreams of every bot in the order, and the reason names the code the bot moved to
  const commits = [{ at: iso(-60), commit: 'abc123456789', subject: 'iron: stop idling at the shaft (#290)' }]
  for (let i = 1; i <= orders.QUIET_DREAMS; i++) {
    r = orders.sync(loop, { bot: 'ozo', cands: [], commits, now: NOW + i * 7200000 })
    assert.deepStrictEqual(r.closed, [], 'smeo has not been quiet yet')
    r = orders.sync(loop, { bot: 'smeo', cands: [], commits, now: NOW + i * 7200000 + 1 })
    assert.deepStrictEqual(r.closed, i === orders.QUIET_DREAMS ? ['step-iron'] : [])
  }
  o = orders.load(loop, 'step-iron')
  assert.strictEqual(o.status, 'closed'); assert.strictEqual(o.closed.code, 'quiet-after-deploy'); assert.match(o.closed.reason, /went quiet after the bot moved to abc123456 "iron: stop idling/)
  // it comes back: the model is asked again, and a bug verdict reopens the same order with its history
  const later = NOW + 20 * 7200000
  assert.ok(orders.undecided(loop, cands, later).some(c => c.key === 'step-iron'))
  r = orders.sync(loop, { bot: 'ozo', cands, decided: { 'step-iron': decided['step-iron'] }, now: later })
  assert.deepStrictEqual(r.reopened, ['step-iron'])
  o = orders.load(loop, 'step-iron'); assert.strictEqual(o.status, 'open'); assert.strictEqual(o.reopens, 1)
  assert.deepStrictEqual(orders.readLedger(loop).map(l => l.ev), ['opened', 'closed', 'reopened'])
  // a later job records a PR and a fix; the file a person reads lists it
  orders.record(loop, 'step-iron', 'pr', { pr: 291 }, later + 1); o = orders.record(loop, 'step-iron', 'fixed', {}, later + 2)
  assert.strictEqual(o.status, 'fixed'); assert.strictEqual(o.closed.reason, 'fixed by PR #291')
  assert.match(fs.readFileSync(path.join(loop, 'WORK-ORDERS.md'), 'utf8'), /# Work orders/)
  assert.strictEqual(orders.list(loop)[0].key, 'step-iron')
})

test('answers are checked in code: a change needs a fact that exists, ids never reach the kept text, caps hold', () => {
  const lines = dream.numbered(GLOBAL), facts = [{ id: 'E1', text: '2026-11-10 step iron: 12 alarms' }, { id: 'E2', text: '2026-11-10 death in lava' }], rules = ['- No armor. (noArmor)']
  assert.deepStrictEqual(lines.map(l => l.id), ['P1', 'P2', 'P3', 'T1', 'T2', 'T3'])
  let r = dream.correctOps({ verdicts: [
    { id: 'P1', verdict: 'keep', rule: '', evidence: '', check: '', cites: [], why: '' },
    { id: 'P2', verdict: 'remove', cites: ['E99'], why: 'made up' },                                    // cites nothing real: dropped
    { id: 'P3', verdict: 'update', rule: 'No armor at all', evidence: 'untested', check: '', cites: [], why: 'no proof' },   // silence is not grounds
    { id: 'T1', verdict: 'update', rule: 'Lava by the shaft at y 46: 2 deaths on 11-10 (E2)', evidence: '', check: '', cites: ['E2', 'E2', 'nope'], why: 'the record has the count' },
    { id: 'T9', verdict: 'remove', cites: ['E1'], why: 'no such line' },
  ] }, { lines, resting: [], facts, rules })
  assert.strictEqual(r.ops.length, 1)
  assert.strictEqual(r.ops[0].line, '- Lava by the shaft at y 46: 2 deaths on 11-10'); assert.deepStrictEqual(r.ops[0].cites, ['E2: 2026-11-10 death in lava'])
  assert.strictEqual(r.dropped.length, 2)
  r = dream.correctOps({ verdicts: [{ id: 'P2', verdict: 'remove', cites: ['E1'], why: 'x' }] }, { lines, resting: ['P2'], facts, rules })
  assert.strictEqual(r.ops.length, 0, 'a line the dream changed recently rests')
  assert.strictEqual(dream.correctOps({ verdicts: ['P1', 'P2', 'P3', 'T1', 'T2', 'T3'].map(id => ({ id, verdict: 'remove', cites: ['E1'], why: 'x' })) }, { lines, resting: [], facts, rules }).ops.length, dream.LIMITS.corrections)

  r = dream.cutOps({ cuts: [
    { id: 'T2', reason: 'state', of: null, why: 'the bag is visible' },
    { id: 'P3', reason: 'rule', of: 'R1', why: 'the rule says it' },
    { id: 'P1', reason: 'rule', of: 'R7', why: 'no such rule' },
    { id: 'P2', reason: 'duplicate', of: 'T2', why: 'T2 is already cut' },
  ] }, { lines, resting: [], rules })
  assert.deepStrictEqual(r.ops.map(o => o.id), ['T2', 'P3']); assert.deepStrictEqual(r.ops[1].cites, ['R1: No armor. (noArmor)']); assert.strictEqual(r.dropped.length, 2)

  r = dream.fillOps({ add: [
    { kind: 'policy', rule: 'Smelt before mining more', evidence: 'iron stalled 12 times on 11-10 (E1)', check: 'iron alarms per day', cites: ['E1', 'E2'] },
    { kind: 'trap', rule: 'One fact only', evidence: '', check: '', cites: ['E1', 'E77'] },
  ] }, { facts })
  assert.strictEqual(r.ops.length, 1); assert.strictEqual(r.ops[0].line, '- Smelt before mining more | iron stalled 12 times on 11-10 | iron alarms per day'); assert.match(r.dropped[0], /needs two facts/)

  r = dream.demoteOps({ moves: [{ id: 'T1', note: 'Lava Spots!', detail: 'y 46 by the shaft\n\nwest wall', pointer: 'Lava near the shaft' }, { id: 'P1', note: '', detail: 'x', pointer: null }] }, { lines, resting: [], notes: [] })
  assert.deepStrictEqual(r.writes, [{ name: 'lava-spots', lines: ['y 46 by the shaft', 'west wall'], from: 'T1' }]); assert.strictEqual(r.ops[0].line, '- Lava near the shaft (detail: notes/lava-spots.md)')

  // the cap on new orders is applied by code, most costly first, and what is over the cap stays undecided (not "not a bug")
  const cands = ['a', 'b', 'c', 'd', 'e', 'f'].map(k => ({ key: k }))
  const h = dream.handoffDecisions({ decisions: [...['f', 'e', 'd', 'c', 'b', 'a'].map(k => ({ key: k, isBug: k !== 'c', kind: 'bug', title: k, problem: 'p', suggestion: 'Where to look: the step', findings: [], why: 'w' })), { key: 'zz', isBug: true, problem: 'p' }] }, cands)
  assert.deepStrictEqual(Object.keys(h.decided).sort(), ['a', 'b', 'c', 'd', 'e']); assert.strictEqual(h.decided.c.isBug, false); assert.strictEqual(h.decided.a.suggestion, 'the step')
  assert.ok(h.dropped.some(d => /^f: a bug, but at most/.test(d)) && h.dropped.some(d => /^zz: not a candidate key/.test(d)))
})

test('applyOps: addressed by line text, so a brief that wrote the file meanwhile is not overwritten; additions give way at the cap', () => {
  const ops = [
    { op: 'remove', section: STORE.S_TRAPS, old: '- My bag holds 96 cobblestone', step: 'cut' },
    { op: 'replace', section: STORE.S_POL, old: '- Iron trips pay off below y 0 | 14 iron on 11-09 | iron per trip', line: '- Iron trips pay off below y 0 | 14 iron on 11-09, 0 on 11-10 | iron per trip', step: 'correct' },
    { op: 'add', section: STORE.S_TRAPS, line: '- The iron step idles at the shaft', step: 'fill' },
  ]
  // meanwhile the bot's brief rewrote Now and replaced the iron policy
  const sec = STORE.parse(GLOBAL); sec[STORE.S_NOW] = ['Day 56. A new plan.']; sec[STORE.S_POL][1] = '- Iron trips: try y 16 first | mine | iron per trip'
  const r = dream.applyOps(STORE.render(sec), ops)
  assert.deepStrictEqual(r.applied.map(o => o.op), ['remove', 'add']); assert.match(r.skipped[0].skipped, /changed while the dream ran/)
  assert.match(r.text, /Day 56\. A new plan\./); assert.match(r.text, /try y 16 first/); assert.doesNotMatch(r.text, /96 cobblestone/)
  const full = STORE.parse(GLOBAL); for (let i = 0; i < 50; i++) full[STORE.S_TRAPS].push(`- trap ${i}`)
  const big = dream.applyOps(STORE.render(full).split('\n').slice(0, 200).join('\n'), [{ op: 'add', section: STORE.S_TRAPS, line: '- one more', step: 'fill' }])
  if (STORE.lineCount(STORE.render(full)) >= STORE.CAPS.globalLines) assert.match(big.skipped[0].skipped, /capped at 60 lines/)
})

test('runDream: five questions in order, only checked changes are written, the bot\'s own section is never touched, and a second run has nothing to do', async () => {
  const root = tmp(), bot = mkBot(root, 'ozo', { evs: [{ at: iso(1800), k: 'note', tag: 'x', text: 'the day before' }, ...events()] }), cfg = cfgFor(root, [bot])
  const asked = []
  const ask = async (o) => {
    const step = /is each memory line true/.test(o.systemPrompt) ? 'correct' : /should not be in the memory at all/.test(o.systemPrompt) ? 'cut' : /getting long/.test(o.systemPrompt) ? 'demote' : /pattern in the facts/.test(o.systemPrompt) ? 'fill' : 'handoff'
    asked.push({ step, o })
    assert.strictEqual(o.model, 'claude-haiku-5-5'); assert.strictEqual(o.effort, 'xhigh')
    if (step === 'correct') {
      assert.match(o.prompt, /## where\nAs of .*home at -6018, 64, -2355/); assert.match(o.prompt, /R1: No armor\./); assert.doesNotMatch(o.prompt, /private room/, 'the bot\'s own section is not even shown')
      return { ok: true, costUsd: 0.01, durationMs: 5, data: { verdicts: [
        { id: lineId(o.prompt, 'Iron trips pay off'), verdict: 'update', rule: 'Iron trips pay off below y 0', evidence: 'untested since 11-10: the iron step raised 12 alarms and stalled 18 min', check: 'iron per trip', cites: [factId(o.prompt, 'step iron: ')], why: 'the day shows stalls, not iron' },
        { id: lineId(o.prompt, 'Be home or sealed'), verdict: 'remove', rule: '', evidence: '', check: '', cites: ['E999'], why: 'invented' },
      ] } }
    }
    if (step === 'cut') return { ok: true, costUsd: 0.01, durationMs: 5, data: { cuts: [{ id: lineId(o.prompt, 'My bag holds'), reason: 'state', of: null, why: 'it can see its bag' }, { id: lineId(o.prompt, 'No armor at all'), reason: 'rule', of: 'R1', why: 'the rule of play says it' }] } }
    if (step === 'fill') return { ok: false, error: 'timed out after 300s', durationMs: 300000 }
    if (step === 'handoff') {
      assert.match(o.prompt, /step-iron: step iron: 0 runs.*12 alarms.*estimated 18 min lost; 12x STALL/)
      return { ok: true, costUsd: 0.01, durationMs: 5, data: { decisions: [
        { key: 'step-iron', isBug: true, kind: 'bug', title: 'iron step idles at the shaft', problem: 'The iron step raised 12 stall alarms in 24 h and never finished.', suggestion: 'the iron step', findings: [], why: 'the same stall 12 times' },
        { key: 'flag-jumping', isBug: false, kind: 'bug', title: '', problem: '', suggestion: '', findings: [], why: 'eleven flags in ten minutes, once' },
        { key: 'step-made-up', isBug: true, kind: 'bug', title: 'x', problem: 'x', suggestion: '', findings: [], why: 'x' },
      ] } }
    }
    throw new Error('unexpected step ' + step)
  }
  const logs = []
  const d = await dream.runDream(cfg, { ask, now: NOW, log: (m) => logs.push(m) })
  assert.deepStrictEqual(asked.map(a => a.step), ['correct', 'cut', 'fill', 'handoff'])                // demote is skipped: the file is short
  assert.strictEqual(d.ok, false, 'one call failed, and the run says so')
  const mem = path.join(bot.dir, 'brain', 'state', 'memory'), text = fs.readFileSync(path.join(mem, 'global.md'), 'utf8')
  assert.match(text, /Iron trips pay off below y 0 \| untested since 11-10: the iron step raised 12 alarms and stalled 18 min \| iron per trip/)
  assert.match(text, /Be home or sealed in before dark/, 'a removal with an invented citation is not applied')
  assert.doesNotMatch(text, /96 cobblestone/); assert.doesNotMatch(text, /No armor at all/)
  assert.match(text, /# My own projects and wishes\n- A private room off the shaft, one day\./); assert.match(text, /# Now\nDay 55\. Smelt iron\./)
  const last = JSON.parse(fs.readFileSync(path.join(mem, 'dream', 'last.json'), 'utf8'))
  assert.deepStrictEqual(last.memory.changes.map(c => `${c.step}:${c.op}`), ['correct:replace', 'cut:remove', 'cut:remove'])
  assert.match(last.memory.changes[0].cites[0], /^E\d+: 2026-11-10 step iron: /)
  assert.ok(last.dropped.some(x => /remove: no fact cited that exists/.test(x)) && last.dropped.some(x => /step-made-up: not a candidate key/.test(x)))
  assert.strictEqual(fs.readdirSync(path.join(mem, 'dream')).filter(f => f.endsWith('.md')).length, 1)
  assert.deepStrictEqual(orders.list(cfg.loopDir).map(o => `${o.key}:${o.status}:${o.costMin}`), ['step-iron:open:18'])
  const run = runs.read(cfg)[0]
  assert.strictEqual(run.job, 'dream'); assert.strictEqual(run.ok, false); assert.match(run.summary, /4 calls \(1 failed\), memory 3 lines changed, orders 1 opened/)
  // what the bot is told at its next brief
  const { checkSummary } = require('../../brain/memory/brief')
  const told = checkSummary(last, NOW - 1000)
  assert.strictEqual(told.changes.length, 3); assert.match(told.changes[1], /^removed "My bag holds 96 cobblestone" because: state: it can see its bag/)
  assert.strictEqual(checkSummary(last, NOW + 1000), null, 'a check older than the last plan has already been shown')

  // nothing new in the journal: no call. With --force: the changed line rests, the order exists, so only what is left is asked
  asked.length = 0
  const again = await dream.runDream(cfg, { ask, now: NOW + 7200000 })
  assert.strictEqual(asked.length, 0); assert.match(again.bots[0].skipped, /nothing new in the journal/)
  const forced = await dream.runDream(cfg, { now: NOW + 7200000, force: true, ask: async (o) => {
    asked.push(o)
    if (/is each memory line true/.test(o.systemPrompt)) { assert.match(o.prompt, /## resting\nP2\n/); return { ok: true, data: { verdicts: [{ id: 'P2', verdict: 'remove', rule: '', evidence: '', check: '', cites: ['E1'], why: 'again' }] } } }
    return { ok: true, data: { add: [], decisions: [] } }
  } })
  assert.strictEqual(forced.ok, true)
  assert.match(fs.readFileSync(path.join(mem, 'global.md'), 'utf8'), /Iron trips pay off below y 0/, 'a resting line is not changed again')
  assert.ok(!asked.some(o => /should not be in the memory at all/.test(o.systemPrompt)), 'too few lines left to ask the cut question')
})

test('runDream: a bot with a journal and no memory folder still gets work orders; a dry run calls no model and writes nothing', async () => {
  const root = tmp(), ozo = mkBot(root, 'ozo'), smeo = mkBot(root, 'smeo', { memory: false }), cfg = cfgFor(root, [ozo, smeo])
  const dry = await dream.runDream(cfg, { ask: async () => assert.fail('no model call in a dry run'), now: NOW, dryRun: true })
  assert.deepStrictEqual(dry.bots.map(b => b.prompts.map(p => p.step)), [['correct', 'cut', 'fill', 'handoff'], ['handoff']])
  assert.match(dry.bots[0].prompts[2].prompt, /SMEO1: Smeo444: 2026-11-10 whole day/, 'the other bot\'s days are facts for the gap question')
  assert.ok(!fs.existsSync(cfg.loopDir))
  const steps = []
  const d = await dream.runDream(cfg, { now: NOW, only: 'smeo', ask: async (o) => { steps.push(o.systemPrompt.slice(0, 30)); return { ok: true, data: { decisions: [{ key: 'step-iron', isBug: true, kind: 'tuning', title: 't', problem: 'p', suggestion: '', findings: [], why: 'w' }] } } } })
  assert.strictEqual(steps.length, 1); assert.strictEqual(d.bots.length, 1); assert.strictEqual(d.bots[0].ok, true)
  assert.ok(orders.load(cfg.loopDir, 'step-iron').bots.smeo); assert.ok(!fs.existsSync(path.join(smeo.dir, 'brain', 'state', 'memory')))
  // a second dream while one holds the lock stands down
  fs.writeFileSync(path.join(cfg.loopDir, 'dream.lock'), JSON.stringify({ at: NOW }))
  assert.strictEqual((await dream.runDream(cfg, { now: NOW + 1000, ask: async () => assert.fail('locked') })).skipped, 'another dream is running')
})

test('a finding closes with a reason: fixed by a named PR, quiet after a deploy, closed by the reviewer, or plain quiet', () => {
  const bot = { id: 'ozo', name: 'OzoGo444' }, f = (key) => ({ key, kind: 'stuck', severity: 'high', confidence: 'med', title: key, evidence: 'e', suggestion: 's' })
  const t0 = Date.parse('2026-11-10T10:00:00Z'), at = (m) => t0 + m * 60000
  let st = findings.merge(null, bot, { findings: [f('a'), f('b'), f('c'), f('d')], resolved: [] }, { now: at(0), run: {}, context: { orders: [{ key: 'step-iron', status: 'open', findings: ['a'] }] } })
  assert.strictEqual(st.open.find(x => x.key === 'a').workOrder, 'step-iron'); assert.ok(!('workOrder' in st.open.find(x => x.key === 'b')))
  const context = {
    commits: [{ at: new Date(at(-600)).toISOString(), commit: 'old000000000', subject: 'old' }, { at: new Date(at(5)).toISOString(), commit: 'new111111111', subject: 'nav: do not walk into lava (#300)' }],
    orders: [{ key: 'step-iron', status: 'fixed', pr: 291, findings: ['a'] }],
  }
  st = findings.merge(st, bot, { findings: [f('d')], resolved: ['c'] }, { now: at(10), run: {}, context })
  st = findings.merge(st, bot, { findings: [f('d')], resolved: [] }, { now: at(20), run: {}, context })
  const why = Object.fromEntries(st.recentlyResolved.map(r => [r.key, r]))
  assert.strictEqual(why.a.why, 'fixed by PR #291 (work order step-iron)'); assert.deepStrictEqual(why.a.reason, { code: 'fixed', pr: 291, order: 'step-iron' })
  assert.match(why.b.why, /^went quiet after the bot moved to new111111 "nav: do not walk into lava \(#300\)"$/); assert.strictEqual(why.b.reason.code, 'quiet-after-deploy')
  assert.match(why.c.why, /new111111.*\(closed by the reviewer\)$/)
  // no code change in between: it says so
  st = findings.merge(st, bot, { findings: [], resolved: [] }, { now: at(30), run: {}, context: { commits: context.commits.slice(0, 1) } })
  st = findings.merge(st, bot, { findings: [], resolved: [] }, { now: at(40), run: {}, context: { commits: context.commits.slice(0, 1) } })
  assert.match(st.recentlyResolved[0].why, /^went quiet: not seen in the last 2 reviews, with no code change in between$/)
  assert.strictEqual(findings.closeReason({ key: 'x', firstSeen: new Date(at(0)).toISOString(), lastSeen: new Date(at(1)).toISOString() }, 'reviewer', {}).why, 'closed by the reviewer: gone, or merged into another finding')
  assert.match(findings.toMarkdown(st), /Recently resolved/)
})

test('schedule and config: the dream is its own Task Scheduler entry; loop files live beside the app settings', () => {
  assert.strictEqual(schedule.JOBS.dream.name, 'MC-Player Bot Dream'); assert.strictEqual(schedule.JOBS.dream.minutes, 120); assert.strictEqual(schedule.JOBS.review.name, schedule.TASK_NAME)
  const v = schedule.launcherVbs({ nodeExe: 'C:\\node.exe', scriptPath: 'C:\\r\\run.js', workDir: 'C:\\r', args: schedule.JOBS.dream.args })
  assert.match(v, /run\.js"" --dream"/); assert.doesNotMatch(v, /--once/)
  assert.match(schedule.launcherVbs({ nodeExe: 'n', scriptPath: 's', workDir: 'w' }), /--once/)
  assert.deepStrictEqual(schedule.createArgs({ vbsPath: 'C:\\x\\launch-dream.vbs', minutes: 120, name: schedule.JOBS.dream.name }).slice(0, 8), ['/Create', '/F', '/TN', 'MC-Player Bot Dream', '/SC', 'MINUTE', '/MO', '120'])
  const home = path.join(tmp(), 'h'), appCfg = path.join(home, 'AppData', 'Roaming', 'Bot Dashboard', 'config.json')
  assert.strictEqual(loopDirOf({}, home, (f) => f === appCfg), path.join(home, 'AppData', 'Roaming', 'Bot Dashboard', 'loop'))
  assert.strictEqual(loopDirOf({}, home, () => false), path.join(home, '.mc-player', 'loop'))
  assert.strictEqual(loopDirOf({}, home, (f) => f === path.dirname(appCfg)), path.join(home, 'AppData', 'Roaming', 'Bot Dashboard', 'loop'), 'the settings folder is enough: the file appears only once a setting is changed')
  assert.strictEqual(resolveConfig({ argv: ['--loop', '/x/loop'], env: {}, home, exists: () => false }).loopDir, '/x/loop')
  assert.strictEqual(resolveConfig({ argv: [], env: { LOOP_DIR: '/y' }, home, exists: () => false }).loopDir, '/y')
})

test('buildFacts: ids a model can cite, the newest facts kept, reviewer findings included', () => {
  const ev = events(), days = [{ date: '2026-11-10', events: ev, rollup: rollup(ev, { date: '2026-11-10' }) }]
  const facts = dream.buildFacts(days, { briefs: [{ at: iso(60), reason: 'dawn', intent: 'Smelt iron.' }], findings: [{ key: 'k', severity: 'high', seenRuns: 3, firstSeen: iso(50), lastSeen: iso(20), title: 'Torches too close', evidence: 'two torches 2 apart' }] })
  assert.strictEqual(facts[0].id, 'E1'); assert.match(facts[0].text, /2026-11-10 whole day: \d+ events .* 2 deaths, 13 alarms raised/)
  assert.ok(facts.some(f => /step iron: 0 runs, 0 min, 0 ok, 0 fail, 0 timeout, 12 alarms, 18 min stalled/.test(f.text)))
  assert.ok(facts.some(f => /death: tried to swim in lava while recover at -6018,46,-2345/.test(f.text)))
  assert.ok(facts.some(f => /dawn brief \(dawn\): Smelt iron\./.test(f.text)) && facts.some(f => /^reviewer finding, open \(high, seen in 3 reviews/.test(f.text)))
  assert.strictEqual(dream.buildFacts(days, { max: 5 }).length, 5)
  assert.strictEqual(dream.noIds('held a stone pickaxe (E84, E90) and was flagged 15x (E73). See E12 too.'), 'held a stone pickaxe and was flagged 15x. See too.')
})
