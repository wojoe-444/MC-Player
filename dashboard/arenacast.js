// dashboard/arenacast.js: read-only view of the speedrun bench (tools/bench): the test arenas, their previews and the scored runs.
// Reads <bench dir>/results.jsonl, snapshots/<arena>/{meta,preview}.json and runs/<id>/{result.json,samples.jsonl}. Never starts or stops anything.
'use strict'
const fs = require('fs')
const path = require('path')

const readJson = (f) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')) } catch { return null } }
const safe = (s) => /^[\w.-]+$/.test(String(s))

function benchDir(codeDir) { return process.env.BENCH_DIR ? path.resolve(process.env.BENCH_DIR) : path.join(codeDir, '.bench') }

function runIds(dir) { try { return fs.readdirSync(path.join(dir, 'runs')).filter(d => fs.existsSync(path.join(dir, 'runs', d, 'result.json'))).sort() } catch { return [] } }

// arenas (from tools/bench/arenas.json, so an arena shows up before its snapshot exists) and every scored run, newest last
function index(codeDir) {
  const dir = benchDir(codeDir), cfg = readJson(path.join(codeDir, 'tools', 'bench', 'arenas.json')) || { arenas: {}, defaults: {} }
  const runs = runIds(dir).map(id => {
    const r = readJson(path.join(dir, 'runs', id, 'result.json')); if (!r) return null
    return { id: r.id, arena: r.arena, label: r.label || '', startedAt: r.startedAt, seconds: r.seconds, minutes: r.minutes, points: r.points, maxPoints: r.maxPoints, perHour: r.perHour, phase: r.phase, totals: r.totals, difficulty: r.difficulty, code: r.code, notes: r.notes || [] }
  }).filter(Boolean)
  const arenas = Object.entries(cfg.arenas).map(([id, a]) => {
    const meta = readJson(path.join(dir, 'snapshots', id, 'meta.json'))
    const mine = runs.filter(r => r.arena === id)
    const best = mine.reduce((b, r) => (!b || r.perHour.points > b.perHour.points ? r : b), null)
    return { id, name: a.name, biome: a.biome || null, note: a.note || '', seed: meta ? meta.seed : a.seed, size: (meta && meta.size) || cfg.defaults.size || 128, ready: !!meta, window: meta ? meta.window : null, center: meta ? meta.center : null, spawn: meta ? meta.spawn : null, madeAt: meta ? meta.madeAt : null, runs: mine.length, bestRun: best ? best.id : null, bestPointsPerHour: best ? best.perHour.points : null }
  })
  return { benchDir: dir, exists: fs.existsSync(dir), arenas, runs }
}

const preview = (codeDir, id) => safe(id) ? readJson(path.join(benchDir(codeDir), 'snapshots', id, 'preview.json')) : null

// one run: the result plus a path (positions every ~10 s, at most 500 points) and the points-so-far curve for the chart
function run(codeDir, id) {
  if (!safe(id)) return null
  const dir = path.join(benchDir(codeDir), 'runs', id), r = readJson(path.join(dir, 'result.json')); if (!r) return null
  let rows = []
  try { rows = fs.readFileSync(path.join(dir, 'samples.jsonl'), 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l)) } catch {}
  const step = Math.max(1, Math.ceil(rows.length / 500))
  const path_ = rows.filter((_, i) => i % step === 0 && _.pos).map(s => [Math.round(s.pos[0] * 10) / 10, Math.round(s.pos[2] * 10) / 10, Math.round(s.t)])
  const events = []
  let prevDeaths = 0
  for (const s of rows) { if (s.deaths != null && s.deaths > prevDeaths && s.pos) { events.push({ t: Math.round(s.t), kind: 'death', pos: [s.pos[0], s.pos[2]] }); prevDeaths = s.deaths } else if (s.deaths != null) prevDeaths = Math.max(prevDeaths, s.deaths) }
  const hp = rows.filter((_, i) => i % step === 0).map(s => [Math.round(s.t), s.hp == null ? null : Math.round(s.hp)])
  return { ...r, path: path_, events, hp }
}

module.exports = { index, preview, run }
