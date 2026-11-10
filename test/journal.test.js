// brain/journal: the per-day record (docs/MEMORY-LOOP.md job 1). Parsers against the real line shapes, the collector against rotating logs, the rollup, the reader tool.
const test = require('node:test')
const assert = require('node:assert')
const fs = require('fs'), os = require('os'), path = require('path')
const EventEmitter = require('events')
const P = require('../brain/journal/parse')
const { rollup } = require('../brain/journal/rollup')
const register = require('../brain/journal')
const tool = require('../tools/journal')

// lines copied from OzoGo444's lessons.md of 2026-11-10 (the watchdog writes "\n- entry", the death post-mortem "- entry\n", so they share a line)
const LESSONS = `# Lessons
- 2026-11-10 05:47 [watchdog] STALL A201: autopilot-stalled:harvest. Situation: step=harvest task=autopilot pos=(-6018, 60, -2355) hp=20 food=20 night=false nightHold=false bag=oak_log5,coal17. First fix: L1: kick(autopilot resumed, holds released, step cooled).
- 2026-11-10 05:48 [watchdog] A201 STALL cleared after 15s (fix: L1: kick(autopilot resumed, holds released, step cooled)).- 2026-11-10 06:05 [safety] DIED (OzoGo444 tried to swim in lava) at -6018,46,-2345, underground, light 0. Health trail 20>20>16>11>6>1. Doing: recover  (health 1/20). Had: sword, 68 torches, 78 filler blocks, 11 food, armor 0/4. Lessons: fire or lava: never walk toward lava, keep a water bucket on trips. Adjusted: lavaMargin 3.

- 2026-11-10 22:09 [watchdog] THRASH A201: 3 goal switches/retries in 2 min, no item gain, moved 8 blocks: stash>shelter>mob-farm-build. Situation: step=null task=autopilot pos=(-6018, 60, -2355) hp=20 food=20 night=true nightHold=false bag=oak_log5. First fix: L1: cooled stash 3min.
- 2026-11-10 22:13 [watchdog] A201 THRASH cleared after 137s (fix: L3: restarted autopilot).
- 2026-11-04 03:43 [watchdog] cave reflex #2: skeleton in sight underground at (169, 67, -335) (hp 19, filler 463); task safety cancelled, retreating to shelter.
- 2026-11-04 03:51 [think] wall_in needs placeable blocks in the bag.
- 2026-10-27 01:00 [safety] DIED (OzoGo444 drowned) at unknown. Health trail unknown. Doing: unknown. Had: no sword, 0 torches, 0 filler blocks, 0 food, armor 0/4. Lessons: I had almost no food.
`

test('lessons.md is split by entry, not by line, and each entry becomes one typed event', () => {
  const entries = P.splitLessons(LESSONS)
  assert.strictEqual(entries.length, 8)
  const evs = entries.map(P.lessonEvent)
  assert.deepStrictEqual(evs.map(e => e.k), ['alarm', 'alarm', 'death', 'alarm', 'alarm', 'reflex', 'note', 'death'])
  const [raised, cleared, death, thrash, cleared3, reflex, note, old] = evs
  assert.deepStrictEqual([raised.ev, raised.type, raised.id, raised.step, raised.level, raised.hp, raised.night], ['raised', 'STALL', 'A201', 'harvest', 1, 20, false])
  assert.deepStrictEqual(raised.pos, [-6018, 60, -2355]); assert.strictEqual(raised.at, '2026-11-10T05:47:00.000Z')
  assert.deepStrictEqual([cleared.ev, cleared.secs, cleared.level, cleared.sal], ['cleared', 15, 1, undefined])
  assert.strictEqual(death.cause, 'OzoGo444 tried to swim in lava'); assert.deepStrictEqual(death.pos, [-6018, 46, -2345])
  assert.strictEqual(death.underground, true); assert.strictEqual(death.light, 0); assert.strictEqual(death.sal, 1)
  assert.match(death.lessons, /^fire or lava/); assert.doesNotMatch(death.lessons, /Adjusted/); assert.strictEqual(death.adjusted, 'lavaMargin 3')
  assert.strictEqual(thrash.step, null, 'step=null in the situation line is no step'); assert.match(thrash.cause, /stash>shelter>mob-farm-build/); assert.strictEqual(thrash.night, true)
  assert.deepStrictEqual([cleared3.level, cleared3.sal, cleared3.secs], [3, 1, 137], 'an alarm the first fix did not clear is salient')
  assert.deepStrictEqual([reflex.n, reflex.mobs], [2, 'skeleton']); assert.deepStrictEqual(reflex.pos, [169, 67, -335])
  assert.deepStrictEqual([note.tag, note.text], ['think', 'wall_in needs placeable blocks in the bag.'])
  assert.strictEqual(old.pos, null, 'a death "at unknown" still parses'); assert.strictEqual(old.cause, 'OzoGo444 drowned')
})

test('row parsers: flags drop the raw excerpt, items fold into 10-minute events, gate entries group with a count, registry ids diff', () => {
  const f = P.flagEvent({ id: '1-1', at: '2026-11-10T22:24:42.823Z', kind: 'repeated_failure', sev: 'high', msg: '9x noPath in 5 min', data: { what: 'noPath', n: 9 }, excerptColumns: ['sec'], excerpt: [[1], [2]] })
  assert.deepStrictEqual(f, { at: '2026-11-10T22:24:42.823Z', k: 'flag', kind: 'repeated_failure', sev: 'high', msg: '9x noPath in 5 min', id: '1-1', data: { what: 'noPath', n: 9 } })
  assert.strictEqual(P.flagEvent({ kind: 'x' }), null)
  const T = Date.parse('2026-11-10T10:00:00Z')
  const items = P.itemEvents([{ t: T, item: 'cobblestone', n: 5 }, { t: T + 60000, item: 'cobblestone', n: 7 }, { t: T + 61000, item: 'raw_iron', n: 1 }, { t: T + 11 * 60000, item: 'coal', n: 2 }, { t: T, item: 'bad', n: 0 }])
  assert.deepStrictEqual(items.map(e => e.items), [{ cobblestone: 12, raw_iron: 1 }, { coal: 2 }])
  const gate = P.gateEvents([{ t: 5, rule: 'permit', packet: 'block_place', why: 'no permit', blocked: false, sites: ['a.js:1'], owner: 'craft' }, { t: 6, rule: 'permit', packet: 'block_place', why: 'no permit', blocked: false, sites: ['a.js:1'], owner: 'craft' }, { t: 7, rule: 'noArmor', packet: 'window_click', why: 'armor', blocked: true }, { t: 2, rule: 'old', blocked: false }], 3)
  assert.deepStrictEqual(gate.map(g => [g.rule, g.n, g.blocked, g.sal]), [['permit', 2, false, undefined], ['noArmor', 1, true, 1]])
  assert.strictEqual(gate[0].site, 'a.js:1')
  assert.deepStrictEqual(P.registryIds({ worlds: { chi: { rooms: [{ id: 'r1', type: 'mobfarm' }], shafts: [{ id: 's1' }] } } }), ['chi/room/mobfarm/r1', 'chi/shaft/s1'])
  assert.strictEqual(P.commitEvent({ t: T, day: 0, commit: 'abc', subject: 's' }).day, undefined, 'the commit row day is written before the first time packet')
})

function rig({ day = 55, botNames = new Set(['OzoGo444', 'Smeo444']) } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'journal-'))
  const bot = new EventEmitter(); bot.username = 'OzoGo444'; bot.time = { day }
  let clock = Date.parse('2026-11-10T22:30:00Z')
  const api = { bot, statePath: (rel) => path.join(dir, rel), now: () => clock, log() {}, botNames, registryFile: path.join(dir, 'registry.json') }
  const put = (rel, text) => { const f = path.join(dir, rel); fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, text) }
  const app = (rel, obj) => { const f = path.join(dir, rel); fs.mkdirSync(path.dirname(f), { recursive: true }); fs.appendFileSync(f, typeof obj === 'string' ? obj : JSON.stringify(obj) + '\n') }
  const events = (date = '2026-11-10') => { try { return fs.readFileSync(path.join(dir, 'journal', `${date}.jsonl`), 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse) } catch { return [] } }
  const dayFile = (date = '2026-11-10') => JSON.parse(fs.readFileSync(path.join(dir, 'journal', `${date}.day.json`), 'utf8'))
  return { dir, bot, api, put, app, events, dayFile, now: () => clock, tick: (ms) => { clock += ms }, make: () => register(api) }
}

test('first run reads the existing logs back and files events by their own date; a second pass adds nothing; a restart resumes where it stopped', () => {
  const r = rig()
  r.put('lessons.md', LESSONS)
  const T = r.now() - 3600000
  r.app('runlog/steps.jsonl', { t: T, day: 54, step: 'harvest', prev: null, x: 1, y: 64.2, z: 2, hp: 20, held: '' })
  r.app('runlog/steps.jsonl', { t: T + 600000, day: 54, step: 'iron', prev: 'harvest', x: 1, y: 12, z: 2, hp: 18, held: 'stone_pickaxe' })
  r.app('runlog/commits.jsonl', { t: T, day: 0, commit: 'aaa', subject: 'one' })
  r.app('runlog/commits.jsonl', { t: T + 5000, day: 0, commit: 'aaa', subject: 'one' })
  r.app('acquired.jsonl', { t: T + 1000, item: 'raw_iron', n: 3 })
  let m = r.make(); m.start()
  const today = r.events()
  assert.deepStrictEqual(today.filter(e => e.k === 'step').map(e => e.step), ['harvest', 'iron'])
  assert.deepStrictEqual(today.filter(e => e.k === 'first').map(e => `${e.what}:${e.id}`).sort(), ['item:raw_iron', 'step:harvest', 'step:iron'])
  assert.strictEqual(today.filter(e => e.k === 'death').length, 1); assert.strictEqual(today.filter(e => e.k === 'alarm').length, 4)
  assert.deepStrictEqual(today.filter(e => e.k === 'commit').map(e => !!e.same), [false, true], 'the same commit again is a restart, not a change')
  assert.ok(today.every((e, i) => i === 0 || today[i - 1].at <= e.at), 'one pass is written oldest first')
  assert.strictEqual(r.events('2026-11-04').length, 2, 'older entries land in their own day file')
  assert.strictEqual(r.events('2026-10-27').length, 1)
  const start = today.find(e => e.k === 'start'); assert.strictEqual(start.day, 55, 'an event written now carries the in-game day')
  assert.strictEqual(today.find(e => e.k === 'death').day, undefined, 'an event read back from hours ago does not')
  const n = today.length
  assert.strictEqual(m._tick.collect(), 0); assert.strictEqual(r.events().length, n)
  m.stop()
  r.app('lessons.md', '\n- 2026-11-10 22:31 [watchdog] A201 STALL cleared after 20s (fix: L1: kick).')
  r.tick(60000); m = r.make(); m.start()
  const after = r.events()
  assert.strictEqual(after.filter(e => e.k === 'alarm').length, 5, 'only the new entry, even though it has no trailing newline')
  assert.strictEqual(after.filter(e => e.k === 'first').length, 3, 'first-time items and steps are remembered across restarts')
  assert.strictEqual(after.filter(e => e.k === 'start').length, 2)
  m.stop()
  const d = r.dayFile()
  assert.strictEqual(d.deaths.length, 1); assert.strictEqual(d.starts, 2); assert.strictEqual(d.commits.length, 1)
  assert.strictEqual(d.steps.harvest.runs, 1); assert.strictEqual(d.steps.harvest.minutes, 10); assert.strictEqual(d.items.raw_iron, 3)
  assert.ok(fs.existsSync(path.join(r.dir, 'journal', '2026-11-04.day.json')))
})

test('sources that shrink: a rotated steps log is finished from its .1, a rewritten flags log is not taken twice', () => {
  const r = rig(), m = r.make(); m.start()
  const T = r.now()
  const flag = (i, sev = 'med') => ({ id: 'f' + i, at: new Date(T + i * 1000).toISOString(), kind: 'stuck', sev, msg: 'm' + i })
  for (let i = 0; i < 4; i++) r.app('telemetry/flags.jsonl', flag(i))
  r.app('runlog/steps.jsonl', { t: T, day: 55, step: 'a', prev: null })
  r.app('runlog/steps.jsonl', { t: T + 1000, day: 55, step: 'b', prev: 'a' })
  r.tick(5000); m._tick.collect()
  // runlog rotates: one more row lands in the old file before the rename, the new file starts small
  r.app('runlog/steps.jsonl', { t: T + 6000, day: 55, step: 'c', prev: 'b' })
  fs.renameSync(path.join(r.dir, 'runlog/steps.jsonl'), path.join(r.dir, 'runlog/steps.jsonl.1'))
  r.app('runlog/steps.jsonl', { t: T + 7000, day: 55, step: 'd', prev: 'c' })
  // telemetry trims its file to the last lines and appends one
  r.put('telemetry/flags.jsonl', [flag(2), flag(3), flag(4)].map(x => JSON.stringify(x)).join('\n') + '\n')
  r.tick(10000); m._tick.collect()
  const evs = r.events()
  assert.deepStrictEqual(evs.filter(e => e.k === 'step').map(e => e.step), ['a', 'b', 'c', 'd'])
  assert.deepStrictEqual(evs.filter(e => e.k === 'flag').map(e => e.id), ['f0', 'f1', 'f2', 'f3', 'f4'])
  m.stop()
})

test('what it hears itself: step results through G.onStepEnd, chat (a person is salient, a bot is not), dawn, registry changes, gate blocks, high flags once per kind', () => {
  const r = rig()
  const seen = []
  r.bot._ap = { G: { onStepEnd: (x) => seen.push(x.step) } }
  r.put('registry.json', JSON.stringify({ worlds: { chi: { rooms: [], shafts: [{ id: 's1' }] } } }))
  const m = r.make(); m.start()
  const G = r.bot._ap.G
  G.onStepEnd({ step: 'harvest', out: 'timeout', ms: 240000 }); G.onStepEnd({ step: 'iron', out: 'ok', ms: 1000 })
  assert.deepStrictEqual(seen, ['harvest', 'iron'], 'an observer that was there first still hears')
  r.bot.emit('chat', 'Smeojy', 'please stop digging there'); r.bot.emit('chat', 'Smeo444', 'on my way'); r.bot.emit('chat', 'OzoGo444', 'my own line')
  r.tick(20 * 60000); r.bot.time.day = 56; m._tick.dawn(); m._tick.dawn()
  r.put('registry.json', JSON.stringify({ worlds: { chi: { rooms: [{ id: 'farm1', type: 'mobfarm' }], shafts: [{ id: 's1' }] } } }))
  r.put('gate-log.json', JSON.stringify({ recent: [{ t: r.now(), rule: 'noArmor', packet: 'window_click', why: 'armor', blocked: true }] }))
  for (let i = 0; i < 3; i++) r.app('telemetry/flags.jsonl', { id: 'h' + i, at: new Date(r.now() + i).toISOString(), kind: 'pillar_failing', sev: 'high', msg: 'x' })
  m._tick.collect(); m._tick.collect()
  const evs = r.events()
  assert.deepStrictEqual(evs.filter(e => e.k === 'result').map(e => [e.step, e.out]), [['harvest', 'timeout'], ['iron', 'ok']])
  assert.deepStrictEqual(evs.filter(e => e.k === 'chat').map(e => [e.from, e.sal]), [['Smeojy', 1], ['Smeo444', undefined]])
  assert.deepStrictEqual(evs.filter(e => e.k === 'dawn').map(e => [e.day, e.prevDay]), [[56, 55]])
  assert.deepStrictEqual(evs.filter(e => e.k === 'registry').map(e => e.added), [['chi/room/mobfarm/farm1']], 'the first sight of the registry is the baseline, not news')
  assert.deepStrictEqual(evs.filter(e => e.k === 'gate').map(e => [e.rule, e.sal]), [['noArmor', 1]])
  assert.deepStrictEqual(evs.filter(e => e.k === 'flag').map(e => e.sal), [1, undefined, undefined])
  r.bot._journal.add('note', { tag: 'brief', text: 'hello' })
  m.stop()
  assert.strictEqual(typeof G.onStepEnd, 'function'); G.onStepEnd({ step: 'late', out: 'ok' })
  assert.strictEqual(r.events().filter(e => e.k === 'result').length, 2, 'stop() puts the earlier observer back')
  assert.strictEqual(r.bot._journal, undefined)
  const d = r.dayFile()
  assert.deepStrictEqual([d.steps.harvest.timeout, d.steps.iron.ok, d.chat, d.gate.noArmor.blocked, d.flagsHigh], [1, 1, 2, 1, 3])
  assert.ok(d.salient.some(s => /Smeojy: please stop digging/.test(s.what)))
})

test('days past 30 are deleted, and a day file over its size limit takes salient events only', () => {
  const r = rig()
  r.put('journal/2026-10-01.jsonl', '{"at":"2026-10-01T00:00:00.000Z","k":"note"}\n'); r.put('journal/2026-10-01.day.json', '{}'); r.put('journal/2026-11-01.jsonl', '{"at":"2026-11-01T00:00:00.000Z","k":"note"}\n')
  r.put('journal/2026-11-10.jsonl', '')
  fs.truncateSync(path.join(r.dir, 'journal/2026-11-10.jsonl'), 16 * 1024 * 1024 + 1)
  const m = r.make(); m.start()
  assert.ok(!fs.existsSync(path.join(r.dir, 'journal/2026-10-01.jsonl'))); assert.ok(!fs.existsSync(path.join(r.dir, 'journal/2026-10-01.day.json')))
  assert.ok(fs.existsSync(path.join(r.dir, 'journal/2026-11-01.jsonl')))
  r.bot._journal.add('note', { text: 'dropped' }); r.bot._journal.add('note', { text: 'kept' }, { sal: true })
  assert.ok(m.status().dropped >= 1); assert.strictEqual(m.status().written, 1)
  m.stop()
})

test('rollup: step minutes stop at a restart and at the gap cap, stalled minutes go to the step the alarm was raised in, in-game days split the running step', () => {
  const at = (min) => new Date(Date.parse('2026-11-10T10:00:00Z') + min * 60000).toISOString()
  const r = rollup([
    { at: at(0), k: 'step', step: 'harvest', day: 54 },
    { at: at(2), k: 'alarm', ev: 'raised', type: 'STALL', id: 'A201', step: 'harvest', level: 1 },
    { at: at(4), k: 'alarm', ev: 'cleared', type: 'STALL', id: 'A201', secs: 120, level: 2, sal: 1 },
    { at: at(10), k: 'step', step: 'iron', day: 54 },
    { at: at(15), k: 'dawn', day: 55 },
    { at: at(20), k: 'result', step: 'iron', out: 'fail' },
    { at: at(20), k: 'step', step: 'home', day: 55 },
    { at: at(120), k: 'start' },
    { at: at(121), k: 'step', step: 'home', day: 55 },
    { at: at(122), k: 'items', items: { coal: 4 } },
    { at: at(123), k: 'death', cause: 'fell', doing: 'home', sal: 1 }
  ], { date: '2026-11-10' })
  assert.deepStrictEqual([r.steps.harvest.runs, r.steps.harvest.minutes, r.steps.harvest.alarms, r.steps.harvest.stalledMin], [1, 10, 1, 2])
  assert.deepStrictEqual([r.steps.iron.minutes, r.steps.iron.fail], [10, 1])
  assert.strictEqual(r.steps.home.minutes, 32, '30 (gap cap, the bot was off) + 2 after the restart'); assert.strictEqual(r.steps.home.runs, 2)
  assert.deepStrictEqual([r.alarms.raised, r.alarms.cleared, r.alarms.stalledMin, r.alarms.maxLevel], [1, 1, 2, 2])
  assert.deepStrictEqual(Object.keys(r.gameDays), ['54', '55'])
  assert.strictEqual(r.gameDays[54].steps.iron.minutes, 5); assert.strictEqual(r.gameDays[55].steps.iron.minutes, 5)
  assert.deepStrictEqual([r.gameDays[55].deaths, r.gameDays[55].items.coal, r.gameDays[54].stalledMin], [1, 4, 2])
  assert.deepStrictEqual(r.salient.map(s => s.k), ['alarm', 'death']); assert.match(r.salient[1].what, /fell while home/)
  assert.strictEqual(rollup([]).events, 0)
})

test('the reader tool: search by text, kind, step, time and salience; relative times; the day text', () => {
  const evs = P.splitLessons(LESSONS).map(P.lessonEvent)
  assert.deepStrictEqual(tool.search(evs, { text: 'LAVA' }).map(e => e.k), ['death'])
  assert.strictEqual(tool.search(evs, { kinds: ['alarm'], step: 'harvest' }).length, 1)
  assert.strictEqual(tool.search(evs, { sal: true }).length, 3)
  assert.strictEqual(tool.search(evs, { since: Date.parse('2026-11-10T22:00:00Z') }).length, 2)
  assert.strictEqual(tool.search(evs, { limit: 2 }).length, 2)
  const now = Date.parse('2026-11-10T12:00:00Z')
  assert.strictEqual(tool.parseTime('6h', now), now - 6 * 3600000); assert.strictEqual(tool.parseTime('2026-11-10', now), Date.parse('2026-11-10T00:00:00Z')); assert.strictEqual(tool.parseTime('2026-11-10T06:00', now), Date.parse('2026-11-10T06:00:00Z'))
  const text = tool.dayText(rollup(evs.filter(e => e.at.startsWith('2026-11-10')), { date: '2026-11-10' }))
  assert.match(text, /deaths 1; alarms 2/); assert.match(text, /look at first:/); assert.match(text, /tried to swim in lava/)
  assert.match(tool.line(evs[2]), /^2026-11-10 06:05:00 \* death/)
})

test('wiring: journal is a registered observer module, and goals.js reports how every step ended without being able to break one', () => {
  const idx = fs.readFileSync(path.join(__dirname, '..', 'brain', 'index.js'), 'utf8')
  assert.match(idx, /const MODULES = \[[^\]]*'journal'/)
  assert.strictEqual(register.meta.kind, 'observer'); assert.strictEqual(register.meta.name, 'journal')
  const goals = fs.readFileSync(path.join(__dirname, '..', 'brain', 'autopilot', 'goals.js'), 'utf8')
  assert.match(goals, /const stepEnd = \(id, out, t0\) => \{ try \{[^\n]*G\.onStepEnd[^\n]*\} catch/)
  for (const out of ["'parked'", "'aborted'", "out = 'timeout'", "out = 'error'", "'explore' : r \\? 'ok' : 'fail'"]) assert.match(goals, new RegExp(`${out}`), `goals.js reports ${out}`)
})
