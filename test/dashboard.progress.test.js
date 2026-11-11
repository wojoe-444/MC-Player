// dashboard/progress.js and /api/progress: roadmap phases, builds with inspection verdicts, per-day numbers, from the bots' own records.
const test = require('node:test')
const assert = require('node:assert')
const fs = require('fs')
const os = require('os')
const path = require('path')
const net = require('net')
const { spawn } = require('child_process')
const { buildProgress, onlineMinutes } = require('../dashboard/progress')

const REPO = path.join(__dirname, '..')
const J = (f, o) => { fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, JSON.stringify(o)) }
const freePort = () => new Promise((res) => { const s = net.createServer().listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => res(p)) }) })

function world() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'progress-'))
  const ozo = path.join(root, 'ozo'), smeo = path.join(root, 'smeo'), reg = path.join(root, 'bot-shared', 'registry.json')
  const st = path.join(ozo, 'brain', 'state')
  J(reg, { worlds: { w: {
    shafts: [{ id: 'sh1', by: 'Smeo444', entry: [-6030, 87, -2355], bottom: [-6030, 35, -2355], at: Date.parse('2026-11-10T10:00:00Z') }],
    rooms: [{ id: 'mobfarm-sh1', type: 'mobfarm', by: 'Smeo444', box: { x0: -6040, x1: -6020, y0: 40, y1: 60, z0: -2360, z1: -2350 }, chests: [[1, 2, 3]] },
            { id: 'storage-sh1', type: 'storage', by: 'OzoGo444', box: { x0: 0, x1: 4, y0: 50, y1: 53, z0: 0, z1: 4 }, chests: [[1, 51, 1], [2, 51, 1]], reset: [3, 51, 3] }] } } })
  J(path.join(st, 'inspect', 'summary.json'), { updatedAt: '2026-11-11T00:00:00Z', rooms: { 'mobfarm-sh1': { at: '2026-11-11T00:00:00Z', ok: false, faults: 2, warns: 1, headline: ['torch in platform', 'open cell by the kill spot'] } } })
  J(path.join(st, 'roadmap.json'), { at: new Date().toISOString(), items: [
    { id: '1.home', phase: '1', title: 'A home is set', status: 'done' },
    { id: '1.shelter', phase: '1', title: 'A shelter door is recorded', status: 'open' },
    { id: '2.1.ladder', phase: '2', title: 'Laddered', status: 'unmeasured', needs: 'a laddered flag' }], phases: {} })
  J(path.join(st, 'autopilot-state.json'), { dayStats: [{ day: 3, iron: 12, ingots: 8, tunnels: 2, deaths: 1, armor: 'none', commits: ['abc'] }], dayStat: { day: 4, iron: 5, deaths: 0 } })
  J(path.join(st, 'treefarm-state.json'), { farms: [{ id: 'farm1', x: 10, y: 70, z: 20, cols: 5, rows: 5, species: 'birch' }], stats: { planted: 4, lit: 9 } })
  J(path.join(st, 'journal', '2026-11-10.day.json'), { alarms: { raised: 3, cleared: 3, stalledMin: 7.25 }, flagsHigh: 2, deaths: [{ at: 'x' }], commits: [{ commit: 'a' }], steps: { mine: { minutes: 30, runs: 4, fail: 1 }, eat: { minutes: 5, runs: 2 } }, items: { raw_iron: 9, iron_ingot: 4, diamond: 1, oak_log: 20 } })
  // the day's event file: 10 min of play, a 50-min hole (capped at 30), a restart (the gap before `start` is not play), 5 more minutes
  fs.writeFileSync(path.join(st, 'journal', '2026-11-10.jsonl'), [['00:00', 'start'], ['00:10', 'step'], ['01:00', 'step'], ['03:00', 'start'], ['03:05', 'result']]
    .map(([t, k]) => JSON.stringify({ at: `2026-11-10T${t}:00.000Z`, k, step: 'x' })).join('\n') + '\n')
  fs.writeFileSync(path.join(st, 'acquired.jsonl'), [{ t: Date.parse('2026-11-09T12:00:00Z'), item: 'raw_iron', n: 6 }, { t: Date.parse('2026-11-09T13:00:00Z'), item: 'dirt', n: 3 }].map(o => JSON.stringify(o)).join('\n') + '\n{"torn')
  fs.mkdirSync(path.join(smeo, 'brain', 'state'), { recursive: true })
  return { root, ozo, smeo, reg }
}
const bots = (w) => [{ id: 'ozo', name: 'OzoGo444', dir: w.ozo }, { id: 'smeo', name: 'Smeo444', dir: w.smeo }]

test('buildProgress: roadmap phases count done of measured and leave unmeasured items visible', () => {
  const w = world()
  const p = buildProgress({ bots: bots(w), codeDir: REPO, registryFile: w.reg })
  const rm = p.bots.ozo.roadmap
  assert.strictEqual(rm.source, 'bot')
  const ph = Object.fromEntries(rm.phases.map(x => [x.id, x]))
  assert.deepStrictEqual([ph['1'].total, ph['1'].measured, ph['1'].done], [2, 2, 1])
  assert.deepStrictEqual([ph['2'].total, ph['2'].measured, ph['2'].done], [1, 0, 0])
  assert.strictEqual(ph['2'].items[0].needs, 'a laddered flag')
  assert.strictEqual(ph['5'].total, 0)                                   // a phase nothing measures yet is listed, not hidden
  assert.deepStrictEqual(p.phases.map(x => x.id), ['1', '2', '3', '3.5', '4', '5'])
})

test('buildProgress: a bot with no roadmap.json gets the predicates evaluated live on its records; with no records at all it is null-safe', () => {
  const w = world()
  const p = buildProgress({ bots: bots(w), codeDir: REPO, registryFile: w.reg })
  const sm = p.bots.smeo.roadmap
  assert.strictEqual(sm.source, 'live')
  assert.ok(sm.phases.find(x => x.id === '2').total > 5)
  assert.ok(sm.phases.every(x => x.done === 0 || x.items.some(i => i.status === 'done')))
  const none = buildProgress({ bots: bots(w), codeDir: path.join(w.root, 'nowhere'), registryFile: path.join(w.root, 'no.json') })
  assert.strictEqual(none.bots.smeo.roadmap, null)
  assert.strictEqual(none.registry.found, false)
  assert.deepStrictEqual(none.builds, [])
  assert.strictEqual(none.bots.smeo.gameDays, null)
  assert.deepStrictEqual(none.bots.smeo.days, [])
})

test('buildProgress: shafts and rooms from the registry, a room carries its inspection verdict, own farms are listed', () => {
  const w = world()
  const p = buildProgress({ bots: bots(w), codeDir: REPO, registryFile: w.reg })
  const by = Object.fromEntries(p.builds.map(b => [b.id, b]))
  assert.strictEqual(by.sh1.kind, 'shaft'); assert.strictEqual(by.sh1.depth, 52); assert.deepStrictEqual(by.sh1.pos, [-6030, 87, -2355])
  assert.strictEqual(by['mobfarm-sh1'].status, 'faults'); assert.strictEqual(by['mobfarm-sh1'].inspection.faults, 2)
  assert.deepStrictEqual(by['mobfarm-sh1'].pos, [-6030, 50, -2355])
  assert.strictEqual(by['storage-sh1'].status, 'unchecked'); assert.strictEqual(by['storage-sh1'].hasReset, true); assert.strictEqual(by['storage-sh1'].chests, 2)
  assert.strictEqual(p.bots.ozo.ownBuilds[0].kind, 'tree farm'); assert.strictEqual(p.bots.ozo.ownBuilds[0].status, 'working')
  assert.deepStrictEqual(p.bots.smeo.ownBuilds, [])
})

test('buildProgress: per in-game day from dayStats (the day in progress marked), per real day from the journal, acquired log where there is no journal', () => {
  const w = world()
  const p = buildProgress({ bots: bots(w), codeDir: REPO, registryFile: w.reg })
  const gd = p.bots.ozo.gameDays
  assert.deepStrictEqual(gd.map(d => [d.day, d.iron, d.ingots, d.deaths, d.done]), [[3, 12, 8, 1, true], [4, 5, 0, 0, false]])
  const d = Object.fromEntries(p.bots.ozo.days.map(r => [r.date, r]))
  assert.strictEqual(d['2026-11-10'].journal, true)
  assert.deepStrictEqual([d['2026-11-10'].deaths, d['2026-11-10'].stalledMin, d['2026-11-10'].flagsHigh, d['2026-11-10'].iron, d['2026-11-10'].ingots, d['2026-11-10'].diamonds, d['2026-11-10'].items], [1, 7.3, 2, 9, 4, 1, 34])
  assert.strictEqual(d['2026-11-10'].topSteps[0].id, 'mine'); assert.strictEqual(d['2026-11-10'].activeMin, 35)
  assert.strictEqual(d['2026-11-10'].onlineMin, 45)                       // 10 + min(50, 30) + 0 (gap before a start) + 5: the denominator of the per-player-hour figures
  assert.strictEqual(d['2026-11-09'].onlineMin, null)                     // no journal: unknown, so no rate (never zero hours)
  assert.strictEqual(d['2026-11-09'].journal, false)                      // no journal that day: only what the pickup log proves, deaths are unknown (null), not zero
  assert.deepStrictEqual([d['2026-11-09'].iron, d['2026-11-09'].items, d['2026-11-09'].deaths], [6, 9, null])
  assert.strictEqual(p.bots.ozo.hasJournal, true); assert.strictEqual(p.bots.smeo.hasJournal, false)
})

test('/api/progress serves it, finding the registry beside the bot folders', async () => {
  const w = world()
  const port = await freePort()
  const child = spawn(process.execPath, [path.join(REPO, 'dashboard', 'server.js')], { env: { ...process.env, PORT: String(port), BOT_OZO_DIR: w.ozo, BOT_SMEO_DIR: w.smeo, BOT_CODE_DIR: REPO, BOT_REGISTRY: '' }, stdio: 'ignore' })
  try {
    let r
    for (let i = 0; i < 50 && !r; i++) { try { r = await fetch(`http://127.0.0.1:${port}/api/progress`) } catch { await new Promise(x => setTimeout(x, 100)) } }
    assert.ok(r, 'server did not start')
    const d = await r.json()
    assert.strictEqual(d.registry.found, true)
    assert.ok(d.builds.some(b => b.id === 'mobfarm-sh1'))
    assert.ok(d.bots.ozo.roadmap && d.bots.smeo.roadmap)
  } finally { child.kill() }
})

test('onlineMinutes: gaps summed and capped at 30 min, nothing counted across a restart, input order does not matter, junk is skipped', () => {
  const e = (t, k = 'step') => ({ at: `2026-11-10T${t}:00Z`, k })
  assert.strictEqual(onlineMinutes([]), 0)
  assert.strictEqual(onlineMinutes([e('00:00')]), 0)
  assert.strictEqual(onlineMinutes([e('00:20'), e('00:00'), e('00:05')]), 20)
  assert.strictEqual(onlineMinutes([e('00:00'), e('02:00')]), 30)
  assert.strictEqual(onlineMinutes([e('00:00'), e('00:10', 'start')]), 0)
  assert.strictEqual(onlineMinutes([e('00:00'), { at: 'nonsense', k: 'step' }, null, e('00:10')]), 10)
})
