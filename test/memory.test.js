// brain/memory: the bot's memory folder with its caps, the dawn brief (request, answer checks, hand-off), the picker honouring a brief, the laptop job.
const test = require('node:test')
const assert = require('node:assert')
const fs = require('fs'), os = require('os'), path = require('path')
const EventEmitter = require('events')
const store = require('../brain/memory/store')
const B = require('../brain/memory/brief')
const register = require('../brain/memory')
const { rulesText, rulesList } = require('../brain/gate/rules-text')
const job = require('../reviewer/lib/brief')

const tmp = (p) => fs.mkdtempSync(path.join(os.tmpdir(), p))
const hasGit = (() => { try { require('child_process').execFileSync('git', ['--version'], { stdio: 'ignore' }); return true } catch { return false } })()

test('rule text comes from rules.json: one line per rule that is on, with how it is enforced; armor reads as banned', () => {
  const rules = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'brain', 'gate', 'rules.json'), 'utf8'))
  const lines = rulesText(rules)
  assert.strictEqual(lines.length, Object.values(rules.rules).filter(r => r.mode !== 'off').length)
  assert.match(lines.find(l => /noArmor/.test(l)), /^- No armor\..*enforced/)
  assert.match(lines.find(l => /torchSpacing/.test(l)), /at least 2 air blocks apart/)
  assert.deepStrictEqual(rulesList({ rules: { x: { mode: 'off' }, newRule: { mode: 'log', note: 'never do the thing. more detail' } } }), [{ id: 'newRule', mode: 'log', text: 'Never do the thing.' }])
})

test('global.md: the seed fits the caps and says nothing about armor; a brief edit replaces Now and the bot\'s own section, adds with evidence, removes by rule text', () => {
  const seed = store.seed()
  assert.ok(store.lineCount(seed) <= 20); assert.doesNotMatch(seed, /armor/i)
  assert.deepStrictEqual(Object.keys(store.parse(seed)), store.SECTIONS)
  assert.strictEqual(store.render(store.parse(seed)), seed, 'parse and render round-trip')
  const r = store.applyEdits(seed, {
    now: 'Phase 2. Iron has not moved.\nToday: smelt, then the farm.', projects: 'a vantage point east of home\n- ask Walter about a private chest',
    addPolicies: [{ rule: 'Carry 16 torches below y 50', evidence: '9 of my last 12 deaths were in the dark (journal 11-07)', check: 'deaths in the dark this week' }, { rule: 'Trust me', evidence: '' }],
    addTraps: ['The harvest step stalls at the field edge'], remove: ['Be home or sealed in before dark', 'a line that is not there'],
  })
  const sec = store.parse(r.text)
  assert.deepStrictEqual(sec[store.S_NOW], ['Phase 2. Iron has not moved.', 'Today: smelt, then the farm.'])
  assert.deepStrictEqual(sec[store.S_MINE], ['- a vantage point east of home', '- ask Walter about a private chest'])
  assert.ok(sec[store.S_POL].includes('- Carry 16 torches below y 50 | 9 of my last 12 deaths were in the dark (journal 11-07) | deaths in the dark this week'))
  assert.ok(!sec[store.S_POL].some(l => /sealed in before dark/.test(l))); assert.ok(!sec[store.S_POL].some(l => /Trust me/.test(l)))
  assert.deepStrictEqual(sec[store.S_TRAPS], ['- The harvest step stalls at the field edge'])
  assert.strictEqual(r.refused.length, 2); assert.match(r.refused.join('\n'), /no evidence given/); assert.match(r.refused.join('\n'), /no policy or trap line reads/)
  assert.strictEqual(store.applyEdits(r.text, { projects: null }).text, r.text, 'projects: null leaves the section alone')
  assert.deepStrictEqual(store.wrap('One sentence here. ' + 'word '.repeat(60), 6).map(l => l.length <= 221), [true, true], 'a long paragraph is wrapped, not cut')
})

test('the 60-line cap: an addition that would pass it is refused and says so, while removals in the same edit still stand', () => {
  let text = store.seed()
  const sec = store.parse(text); for (let i = 0; i < 45; i++) sec[store.S_TRAPS].push(`- trap number ${i}`)
  text = store.render(sec); assert.strictEqual(store.lineCount(text), 60)
  const r = store.applyEdits(text, { addTraps: ['one more'] })
  assert.strictEqual(store.lineCount(r.text), 60); assert.doesNotMatch(r.text, /one more/); assert.match(r.refused[0], /would be 61 lines, the cap is 60/)
  const r2 = store.applyEdits(text, { remove: ['trap number 3', 'trap number 4'], addTraps: ['one more'] })
  assert.match(r2.text, /one more/); assert.strictEqual(store.lineCount(r2.text), 59); assert.deepStrictEqual(r2.refused, [])
})

test('the folder: seeded once, every accepted write is a commit, another writer cannot touch the bot\'s own section, notes are capped at 10 files of 150 lines', () => {
  const dir = tmp('mem-'), s = store.createStore({ dir, author: 'OzoGo444' })
  assert.strictEqual(s.ensure(), true); assert.strictEqual(s.ensure(), false)
  s.applyBrief({ now: 'day one', projects: 'my room' }, 'dawn brief 1')
  const mine = s.readGlobal()
  assert.match(s.writeGlobal(mine.replace('- my room', '- their room'), 'dream').error, /belongs to the bot/)
  assert.strictEqual(s.writeGlobal(mine.replace('day one', 'day one, corrected'), 'dream: corrected Now').ok, true)
  assert.match(s.writeGlobal(mine + '\n# Traps\n' + Array.from({ length: 70 }, (_, i) => `- t${i}`).join('\n'), 'too long').error, /cap is 60/)
  assert.match(s.writeNote('Stalls!', Array.from({ length: 151 }, () => 'x').join('\n')).error, /cap is 150/)
  for (let i = 0; i < 10; i++) assert.strictEqual(s.writeNote(`note ${i}`, 'body').ok, true)
  assert.match(s.writeNote('one too many', 'body').error, /already 10 notes/)
  assert.strictEqual(s.writeNote('note 3', 'new body').ok, true, 'an existing note can be rewritten')
  assert.deepStrictEqual(s.notes().map(n => n.name).slice(0, 2), ['note-0', 'note-1']); assert.strictEqual(s.readNote('note 3'), 'new body\n')
  if (hasGit) { const log = require('child_process').execFileSync('git', ['log', '--format=%s'], { cwd: dir }).toString(); assert.match(log, /dawn brief 1/); assert.match(log, /dream: corrected Now/); assert.match(log, /seed global\.md/) }
})

const STEPS = ['eat', 'recover', 'take-cover', 'iron', 'iron-smelt', 'harvest', 'pursue', 'mob-farm-build', 'whimsy']
const ANSWER = {
  intent: 'Smelt what I have and finish the farm.', focus: ['iron-smelt', 'no-such-step', 'whimsy', 'iron-smelt'],
  holds: [{ step: 'pursue', days: 9, why: 'failed 8 times at y -7' }, { step: 'eat', days: 1, why: 'x' }, { step: 'whimsy', days: 1, why: 'x' }, { step: 'ghost', days: 1, why: 'x' }],
  freeTime: { choice: 'vantage', note: 'east of home' }, ask: null,
  memory: { now: 'Iron is stuck.', projects: null, addPolicies: [{ rule: 'Hold a step that fails the same way 8 times', evidence: 'pursue failed 8 times at y -7 (journal 22:21)', check: 'repeat failures per day' }], addTraps: [], remove: [] },
}

test('answer checks: unknown steps, holds on survival steps and on free time are dropped with a reason; holds are capped at three in-game days; a brief goes stale after three hours', () => {
  const now = Date.parse('2026-11-11T00:00:00Z')
  const v = B.validate(ANSWER, { steps: STEPS, day: 57, now, id: 'r1', model: 'claude-haiku-5-5' })
  assert.deepStrictEqual(v.brief.focus, ['iron-smelt'])
  assert.deepStrictEqual(v.brief.holds, [{ step: 'pursue', untilDay: 60, why: 'failed 8 times at y -7' }])
  assert.strictEqual(v.dropped.length, 5)
  assert.match(v.dropped.join('\n'), /hold "eat": a survival step is never put on hold/); assert.match(v.dropped.join('\n'), /hold "whimsy": free time is not put on hold/)
  assert.deepStrictEqual(v.brief.freeTime, { choice: 'vantage', note: 'east of home' })
  const a = B.active(v.brief, { now: now + 60000, day: 58 })
  assert.deepStrictEqual([a.focus, [...a.held], a.freeTime.choice], [['iron-smelt'], ['pursue'], 'vantage'])
  assert.deepStrictEqual([...B.active(v.brief, { now: now + 60000, day: 60 }).held], [], 'the hold ends when its days are up')
  assert.strictEqual(B.active(v.brief, { now: now + 3 * 3600000 + 1, day: 58 }), null)
  // a hand-edited or corrupted brief.json cannot hold a survival step either
  assert.deepStrictEqual([...B.active({ ...v.brief, holds: [{ step: 'eat', untilDay: 59 }, { step: 'harvest', untilDay: 999 }] }, { now: now + 1, day: 58 }).held], [])
  assert.strictEqual(B.active(null), null); assert.strictEqual(B.validate('garbage', { steps: STEPS }).brief.freeTime.choice, 'none')
  assert.match(B.clock(1900), /^morning, about 8 real minutes of daylight left/); assert.match(B.clock(14000), /^night, dark until sunrise/)
})

function rig({ enabled = true } = {}) {
  const dir = tmp('membot-')
  const bot = new EventEmitter(); bot.username = 'OzoGo444'; bot.time = { day: 57, timeOfDay: 1000 }; bot.health = 20; bot.food = 20
  bot.entity = { position: { x: 10.5, y: 64, z: -3.2 } }; bot.inventory = { items: () => [{ name: 'torch', count: 31 }, { name: 'raw_iron', count: 2 }] }
  const G = { role: 'hillclimber', steps: STEPS.map(id => ({ id })), state: { home: [10, 64, -3] }, lastStep: 'harvest' }
  bot._ap = { active: () => true, G }
  const journal = []; bot._journal = { dir: path.join(dir, 'journal'), add: (k, f, o) => journal.push({ k, ...f, sal: o && o.sal }) }
  let clock = Date.parse('2026-11-11T00:00:00Z')
  const api = { bot, statePath: (rel) => path.join(dir, rel), now: () => clock, log() {}, briefEnabled: enabled, memoryGit: false }
  fs.mkdirSync(path.join(dir, 'journal'), { recursive: true })
  const ev = (minAgo, e) => fs.appendFileSync(path.join(dir, 'journal', '2026-11-10.jsonl'), JSON.stringify({ at: new Date(clock - minAgo * 60000).toISOString(), ...e }) + '\n')
  const m = register(api)
  const file = (f) => path.join(dir, 'memory', f), read = (f) => JSON.parse(fs.readFileSync(file(f), 'utf8'))
  const answer = (data, extra = {}) => fs.writeFileSync(file('brief-answer.json'), JSON.stringify({ id: read('brief-request.json').id, ok: true, model: 'claude-haiku-5-5', data, ...extra }))
  return { dir, bot, G, api, m, journal, ev, file, read, answer, tick: (ms) => { clock += ms }, now: () => clock }
}

test('the bot asks for a brief on first run, at a dawn at most once an hour, and after a respawn; the request carries rules, memory, the record since the last brief and the step names', () => {
  const r = rig()
  r.ev(30, { k: 'step', step: 'harvest', day: 56 }); r.ev(20, { k: 'alarm', ev: 'raised', type: 'STALL', id: 'A1', step: 'harvest', level: 1 }); r.ev(18, { k: 'alarm', ev: 'cleared', type: 'STALL', id: 'A1', secs: 120, level: 2, sal: 1 })
  r.ev(500, { k: 'death', cause: 'too old to matter', sal: 1 })
  fs.mkdirSync(path.join(r.dir, 'review'), { recursive: true })
  fs.writeFileSync(path.join(r.dir, 'review', 'findings.json'), JSON.stringify({ open: [{ key: 'low-one', severity: 'low', title: 'l' }, { key: 'high-one', severity: 'high', title: 'h', suggestion: 's' }] }))
  r.m.start(); r.m._tick.tick()
  const req = r.read('brief-request.json')
  assert.strictEqual(req.reason, 'first'); assert.deepStrictEqual(req.steps, STEPS); assert.ok(req.cannotHold.includes('eat') && req.cannotHold.includes('whimsy'))
  assert.match(req.memory.global, /# Policies/); assert.ok(req.rules.some(l => /No armor/.test(l)))
  assert.strictEqual(req.sinceLastBrief.steps[0].id, 'harvest'); assert.strictEqual(req.sinceLastBrief.steps[0].stalledMin, 2); assert.deepStrictEqual(req.sinceLastBrief.deaths, [], 'only the last hour on a first brief')
  assert.deepStrictEqual(req.reviewerFindings.map(f => f.key), ['high-one', 'low-one']); assert.deepStrictEqual(req.state.bag, { torch: 31, raw_iron: 2 }); assert.match(req.clock, /^morning/)
  assert.ok(fs.existsSync(r.file('global.md')))
  r.m._tick.tick(); assert.strictEqual(r.read('brief-request.json').id, req.id, 'no second request while one is waiting')
  r.answer(ANSWER); r.m._tick.tick()
  r.tick(30 * 60000); r.bot.time.day = 58; r.m._tick.tick(); assert.strictEqual(r.read('brief-request.json').id, req.id, 'a dawn 30 minutes later is too soon')
  r.bot.emit('death'); r.bot.emit('spawn'); r.m._tick.tick()
  const req2 = r.read('brief-request.json'); assert.strictEqual(req2.reason, 'respawn'); assert.strictEqual(req2.lastBrief.intent, ANSWER.intent)
  r.answer(ANSWER); r.m._tick.tick()
  r.tick(56 * 60000); r.bot.time.day = 61; r.m._tick.tick(); assert.strictEqual(r.read('brief-request.json').reason, 'dawn')
  r.m.stop()
})

test('an answer is checked, written to memory and handed to the picker; a failed answer leaves no brief; the off switch asks for nothing', () => {
  const r = rig(); r.m.start(); r.m._tick.tick()
  r.answer(ANSWER); r.m._tick.tick()
  const brief = r.read('brief.json')
  assert.deepStrictEqual([brief.focus, brief.holds.map(h => h.step), brief.freeTime.choice, brief.model], [['iron-smelt'], ['pursue'], 'vantage', 'claude-haiku-5-5'])
  assert.strictEqual(r.G.brief.id, brief.id, 'the picker has it')
  assert.deepStrictEqual(r.bot._memory.brief().focus, ['iron-smelt'])
  const g = fs.readFileSync(r.file('global.md'), 'utf8'); assert.match(g, /Iron is stuck\./); assert.match(g, /Hold a step that fails the same way 8 times \| pursue failed 8 times/)
  assert.deepStrictEqual(r.journal.filter(e => e.k === 'brief').map(e => [e.text, e.holds, e.sal]), [[ANSWER.intent, ['pursue'], true]])
  assert.strictEqual(r.m.status().refused.length, 5, 'what was dropped is kept to show the next brief')
  // the next request tells the model what was refused
  r.tick(11 * 60000); r.bot.emit('death'); r.bot.emit('spawn'); r.m._tick.tick()
  assert.strictEqual(r.read('brief-request.json').refusedLastTime.length, 5)
  fs.writeFileSync(r.file('brief-answer.json'), JSON.stringify({ id: r.read('brief-request.json').id, ok: false, error: 'timed out after 300s' })); r.m._tick.tick()
  assert.match(r.m.status().lastError, /timed out/); assert.strictEqual(r.read('brief.json').id, brief.id, 'the earlier brief stays until it goes stale')
  r.tick(3 * 3600000); assert.strictEqual(r.bot._memory.brief(), null)
  r.m.stop(); assert.strictEqual(r.G.brief, undefined); assert.strictEqual(r.bot._memory, undefined)

  const off = rig({ enabled: false }); off.m.start(); off.m._tick.tick()
  assert.ok(!fs.existsSync(off.file('brief-request.json'))); assert.strictEqual(off.G.brief, undefined); off.m.stop()
})

// ---- the picker (brain/autopilot/goals.js) with a hand-made step list ----
function picker({ tod = 6000 } = {}) {
  const dir = tmp('goals-')
  const bot = new EventEmitter(); bot.time = { day: 57, timeOfDay: tod }; bot.health = 20; bot.food = 20; bot.entity = { position: { x: 0, y: 64, z: 0 } }
  const S = new Proxy({ bot, goals: {}, v: (x, y, z) => ({ x, y, z }), isNight: () => false }, { get: (t, k) => (k in t ? t[k] : () => 0) })
  const api = { statePath: (f) => path.join(dir, f), profile: { get: () => ({ role: 'hillclimber', steps: null }) } }
  const G = require('../brain/autopilot/goals')(S, {}, api, () => {})
  const needs = { eat: false, harvest: true, iron: true, 'iron-smelt': true, pursue: true, whimsy: false }
  G.steps.length = 0
  for (const id of ['eat', 'harvest', 'pursue', 'iron', 'iron-smelt', 'whimsy']) G.steps.push({ id, need: () => needs[id], run: async () => true })
  const brief = (o) => { G.brief = { id: 'b', at: new Date().toISOString(), until: Date.now() + 3600000, focus: [], holds: [], freeTime: { choice: 'none', note: '' }, ...o } }
  return { G, needs, brief, pick: () => { const s = G.pick(); return s && s.id } }
}

test('picker: no brief plays the plain list; a hold skips the step; a focus step that wants to run goes first; a survival step always wins; a stale brief is ignored', () => {
  const p = picker()
  assert.strictEqual(p.pick(), 'harvest')
  p.brief({ holds: [{ step: 'harvest', untilDay: 59 }, { step: 'eat', untilDay: 59 }] }); assert.strictEqual(p.pick(), 'pursue')
  p.needs.eat = true; assert.strictEqual(p.pick(), 'eat', 'a brief that names a survival step in a hold is not obeyed'); p.needs.eat = false
  p.brief({ focus: ['iron-smelt', 'iron'] }); assert.strictEqual(p.pick(), 'iron-smelt')
  p.needs['iron-smelt'] = false; assert.strictEqual(p.pick(), 'iron', 'a focus step with nothing to do is passed over')
  p.G.cool.iron = Date.now() + 60000; assert.strictEqual(p.pick(), 'harvest', 'a cooling focus step is passed over too'); p.G.cool.iron = 0
  p.needs.eat = true; assert.strictEqual(p.pick(), 'eat', 'focus never jumps a survival step that is waiting'); p.needs.eat = false
  p.brief({ focus: ['iron'], holds: [{ step: 'iron', untilDay: 59 }] }); assert.strictEqual(p.pick(), 'harvest', 'held beats focus if a bad file has both')
  p.brief({ focus: ['iron'], until: Date.now() - 1 }); assert.strictEqual(p.pick(), 'harvest')
  p.brief({ focus: ['iron'], holds: [{ step: 'harvest', untilDay: 57 }] }); assert.strictEqual(p.pick(), 'iron'); p.G.brief = null; assert.strictEqual(p.pick(), 'harvest')
  assert.deepStrictEqual(p.G.stepIds(), ['eat', 'harvest', 'pursue', 'iron', 'iron-smelt', 'whimsy'])
})

test('picker: free time gets its slot ahead of focus when the whimsy step wants to run, cannot be held, and waits at dawn', () => {
  const p = picker()
  p.needs.whimsy = true
  assert.strictEqual(p.pick(), 'harvest', 'without a brief the list order stands (whimsy is last)')
  p.brief({ focus: ['iron'], holds: [{ step: 'whimsy', untilDay: 59 }], freeTime: { choice: 'vantage', note: '' } }); assert.strictEqual(p.pick(), 'whimsy')
  p.needs.eat = true; assert.strictEqual(p.pick(), 'eat'); p.needs.eat = false
  const dawn = picker({ tod: 23000 }); dawn.G.state.home = [0, 64, 0]; dawn.needs.whimsy = true; dawn.needs.harvest = false; dawn.needs.pursue = false; dawn.needs.iron = false; dawn.needs['iron-smelt'] = true
  dawn.brief({ freeTime: { choice: 'vantage', note: '' } }); assert.strictEqual(dawn.pick(), 'iron-smelt', 'no free-time walk while the night\'s mobs are still out')
})

test('the whimsy step: asks to run only with a fresh brief that chose something, once per in-game day, in daylight, healthy and fed; "home" needs no walk', async () => {
  const bot = new EventEmitter(); bot.time = { day: 57, timeOfDay: 6000 }; bot.health = 20; bot.food = 20; bot.entity = { position: { x: 0, y: 64, z: 0, floored() { return { x: 0, y: 64, z: 0 } } }, yaw: 0 }
  const looks = []; bot.look = async (yaw) => { looks.push(yaw) }
  const added = []; bot._journal = { add: (k, f) => added.push({ k, ...f }) }
  const notes = []
  const G = { state: { home: [0, 64, 0] }, note: (m) => notes.push(m), save() {}, explore: async () => true }
  const S = { bot, goals: { GoalNear: function () {} }, v: (x, y, z) => ({ x, y, z }), isNight: () => false, skyVisible: () => true, dist: () => 2, check() {}, wait: async () => {}, goto: async () => ({ ok: true }), block: () => null }
  const step = require('../brain/autopilot/whimsy')(G, S, {}, { statePath: (f) => path.join(tmp('whimsy-'), f) }, () => {})
  assert.strictEqual(step.id, 'whimsy'); assert.strictEqual(step.need(), false, 'no brief, no ask')
  G.brief = { at: new Date().toISOString(), until: Date.now() + 3600000, freeTime: { choice: 'none' } }; assert.strictEqual(step.need(), false)
  G.brief.freeTime = { choice: 'home', note: 'watch the sun' }; assert.strictEqual(step.need(), true)
  bot.health = 10; assert.strictEqual(step.need(), false); bot.health = 20
  bot.time.timeOfDay = 10500; assert.strictEqual(step.need(), false, 'too late in the day to start'); bot.time.timeOfDay = 6000
  const realNow = Date.now; let t = realNow(); Date.now = () => (t += 5000)                 // the look-around loop runs on the clock
  try { assert.strictEqual(await step.run(), true) } finally { Date.now = realNow }
  assert.ok(looks.length >= 2); assert.deepStrictEqual(added.map(e => [e.k, e.choice, e.did]), [['whimsy', 'home', 'home']]); assert.match(notes[0], /free time: home \(watch the sun\)/)
  assert.strictEqual(step.need(), false, 'once per in-game day'); bot.time.day = 58; assert.strictEqual(step.need(), true)
})

test('the laptop job: answers a fresh unanswered request once with the reviewer\'s model settings, skips stale and answered ones, and records a failed call as no answer', async () => {
  const home = tmp('job-'), botDir = path.join(home, 'ozo'), mem = path.join(botDir, 'brain', 'state', 'memory'); fs.mkdirSync(mem, { recursive: true })
  const cfg = { bots: [{ id: 'ozo', name: 'OzoGo444', dir: botDir }, { id: 'smeo', name: 'Smeo444', dir: path.join(home, 'none') }], outDir: path.join(home, 'out'), model: 'claude-haiku-5-5', effort: 'xhigh', timeoutMs: 480000 }
  const now = Date.parse('2026-11-11T00:10:00Z')
  const req = B.buildRequest({ id: 'r7', at: new Date(now - 60000).toISOString(), reason: 'dawn', bot: 'OzoGo444', role: 'hillclimber', day: 57, timeOfDay: 1000, steps: STEPS, rules: ['- No armor. (noArmor, enforced)'], global: store.seed(), notes: [{ name: 'stalls', lines: 12 }] })
  fs.writeFileSync(path.join(mem, 'brief-request.json'), JSON.stringify(req))
  const calls = []
  const ask = async (o) => { calls.push(o); return { ok: true, data: ANSWER, costUsd: 0.01, durationMs: 50000 } }
  const dry = await job.runBriefs(cfg, { now, dryRun: true })
  assert.match(dry.prompts[0].system, /^You are OzoGo444/); assert.match(dry.prompts[0].system, /Use only what is in this message/); assert.match(dry.prompts[0].prompt, /a new in-game day began/); assert.match(dry.prompts[0].prompt, /# Policies/); assert.match(dry.prompts[0].prompt, /stalls \(12 lines\)/)
  const r = await job.runBriefs(cfg, { ask, now })
  assert.deepStrictEqual(r.briefs, [{ bot: 'ozo', id: 'r7', ok: true, error: null, costUsd: 0.01, durationMs: 50000 }])
  assert.deepStrictEqual([calls[0].model, calls[0].effort, calls[0].schema.required.includes('memory')], ['claude-haiku-5-5', 'xhigh', true])
  const ans = JSON.parse(fs.readFileSync(path.join(mem, 'brief-answer.json'), 'utf8')); assert.deepStrictEqual([ans.id, ans.ok, ans.data.intent], ['r7', true, ANSWER.intent])
  await job.runBriefs(cfg, { ask, now }); assert.strictEqual(calls.length, 1, 'an answered request is not asked again')
  fs.writeFileSync(path.join(mem, 'brief-request.json'), JSON.stringify({ ...req, id: 'r8', at: new Date(now - 31 * 60000).toISOString() }))
  await job.runBriefs(cfg, { ask, now }); assert.strictEqual(calls.length, 1, 'a request older than 30 minutes is left alone')
  fs.writeFileSync(path.join(mem, 'brief-request.json'), JSON.stringify({ ...req, id: 'r9' }))
  const bad = await job.runBriefs(cfg, { ask: async () => ({ ok: false, error: 'not logged in' }), now })
  assert.strictEqual(bad.ok, false); assert.deepStrictEqual(JSON.parse(fs.readFileSync(path.join(mem, 'brief-answer.json'), 'utf8')).error, 'not logged in')
  // the bot-side checks accept what this job's schema allows
  assert.deepStrictEqual(B.validate(ANSWER, { steps: STEPS, day: 57 }).brief.focus, ['iron-smelt'])
})

test('wiring: memory is a registered module after journal, whimsy is loaded into the step list, the profile carries the brief switch, the model call shuts out ambient memory', () => {
  const idx = fs.readFileSync(path.join(__dirname, '..', 'brain', 'index.js'), 'utf8')
  assert.match(idx, /const MODULES = \[[^\]]*'journal', 'memory'[,\]]/); assert.strictEqual(register.meta.name, 'memory')
  assert.match(fs.readFileSync(path.join(__dirname, '..', 'brain', 'autopilot', 'plan.js'), 'utf8'), /G\.steps\.push\(require\('\.\/whimsy'\)\(G, S, M, api, log\)\)/)
  const { createProfile } = require('../brain/profile'); const d = tmp('prof-')
  fs.writeFileSync(path.join(d, 'profile.json'), JSON.stringify({ name: 'X', role: 'hillclimber', planner: { enabled: false, brief: false } })); assert.strictEqual(createProfile({ stateDir: d }).get().planner.brief, false)
  fs.writeFileSync(path.join(d, 'profile.json'), JSON.stringify({ name: 'X', role: 'hillclimber', planner: { enabled: false } })); assert.strictEqual(createProfile({ stateDir: tmp('prof2-') }).get().planner.brief, null)
  const { childEnv } = require('../reviewer/lib/claude')
  const e = childEnv({ PATH: '/x', ANTHROPIC_API_KEY: 'k', CLAUDE_MEMORY_STORES: '[]', CLAUDE_COWORK_MEMORY_PATH_OVERRIDE: '/m' }); assert.deepStrictEqual(Object.keys(e).sort(), ['CLAUDE_AGENT_SDK_CLIENT_APP', 'PATH'])
  assert.match(fs.readFileSync(path.join(__dirname, '..', 'reviewer', 'lib', 'claude.js'), 'utf8'), /settings: \{ autoMemoryEnabled: false \}/)
})

test('the bot is told what the memory check changed in its file, once, and the brief prompt says the file is its own to put right', () => {
  const report = { at: '2026-11-10T22:55:00.000Z', memory: { changes: [
    { step: 'correct', op: 'replace', from: 'Iron pays below y 0 | 14 iron | iron per trip', to: 'Iron pays below y 0 | 0 iron on 11-10 | iron per trip', why: 'the day shows no iron', cites: ['E5: x'] },
    { step: 'cut', op: 'remove', from: 'My bag holds 96 cobblestone', to: null, why: 'state: it can see its bag', cites: [] },
    { step: 'fill', op: 'add', from: null, to: 'Lava by the shaft at y 46', why: 'a pattern across days', cites: [] },
  ] } }
  const lastCheck = B.checkSummary(report, Date.parse('2026-11-10T22:00:00Z'))
  assert.deepStrictEqual(lastCheck.changes.map(c => c.split(' "')[0]), ['changed', 'removed', 'added'])
  assert.strictEqual(B.checkSummary(report, Date.parse('2026-11-10T23:00:00Z')), null)
  assert.strictEqual(B.checkSummary({ at: report.at, memory: { changes: [] } }, 0), null); assert.strictEqual(B.checkSummary(null, 0), null)
  const req = B.buildRequest({ id: 'r1', at: '2026-11-10T23:00:00.000Z', reason: 'dawn', bot: 'OzoGo444', steps: STEPS, global: store.seed(), lastCheck })
  assert.strictEqual(req.memory.lastCheck.changes.length, 3)
  assert.ok(!('lastCheck' in B.buildRequest({ id: 'r2', steps: STEPS }).memory))
  const prompt = job.userPrompt(req)
  assert.match(prompt, /## memory\.lastCheck \(2026-11-10T22:55:00\.000Z\)\n- changed "Iron pays below y 0/); assert.match(prompt, /- removed "My bag holds 96 cobblestone" because: state: it can see its bag/)
  assert.doesNotMatch(job.userPrompt(B.buildRequest({ id: 'r2', steps: STEPS })), /lastCheck/)
  assert.match(job.systemPrompt(req), /The file is yours: if a change is wrong, put the line back/)
})
