#!/usr/bin/env node
// Speedrun bench: small bounded test arenas on a vanilla 1.21.6 server (offline mode), one bot plays the "first hour" from a fresh start, the world is then
// reset by copying the identical starting snapshot. Score = per-player-hour numbers read from the SERVER (items, structures, deaths, stall).
//
//   node tools/bench/bench.js list                         arenas, snapshot status, last scores
//   node tools/bench/bench.js make <arena|all> [--force]    generate the world (single forced biome, seeded), pick the best 128x128 window and a dry spawn, pre-generate it,
//                                                           set border/spawn/time, save the snapshot to .bench/snapshots/<arena>/
//   node tools/bench/bench.js run <arena> [--minutes 60] [--bot ozo] [--code <checkout>] [--label text] [--difficulty normal|hard]
//                                                           reset (copy snapshot), start server + the real join.js bot, sample over RCON, score, write .bench/runs/<id>/result.json
//   node tools/bench/bench.js score <run id>                re-score a finished run (after a scoring change)
//   node tools/bench/bench.js tick <arena> [--seconds 40]    check what /tick sprint and /tick rate do to a bot's progress (see README)
// The bot is the real join.js + brain from this checkout (or --code), forced offline by offline-preload.js. The server is only ever used from here: nothing here
// touches the live world, its port or its accounts. See tools/bench/README.md.
'use strict'
const fs = require('fs')
const os = require('os')
const path = require('path')
const cp = require('child_process')
const S = require('./lib/server')
const T = require('./lib/terrain')
const Sc = require('./lib/score')

const REPO = path.resolve(__dirname, '..', '..')
const BENCH = process.env.BENCH_DIR ? path.resolve(process.env.BENCH_DIR) : path.join(REPO, '.bench')
const ARENAS_FILE = path.join(__dirname, 'arenas.json')
const PORT = Number(process.env.BENCH_SERVER_PORT) || 25620, RCON_PORT = PORT + 1
const sleep = S.sleep
const argv = process.argv.slice(2), cmd = argv[0]
const opt = (k, d) => { const i = argv.indexOf('--' + k); return i >= 0 ? argv[i + 1] : d }
const flag = (k) => argv.includes('--' + k)
const arg1 = argv[1] && !argv[1].startsWith('--') ? argv[1] : null
const readArenas = () => JSON.parse(fs.readFileSync(ARENAS_FILE, 'utf8'))
const writeArenas = (j) => fs.writeFileSync(ARENAS_FILE, JSON.stringify(j, null, 2) + '\n')
const arenaOf = (id) => { const j = readArenas(), a = j.arenas[id]; if (!a) throw new Error(`no arena "${id}" (have: ${Object.keys(j.arenas).join(', ')})`); return { id, ...j.defaults, ...a } }
const snapDir = (id) => path.join(BENCH, 'snapshots', id)
const stamp = () => new Date().toISOString().replace(/[-:]/g, '').replace(/\..*/, '').replace('T', '-')
const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a)

function needJar() {
  const jar = S.findJar(REPO)
  if (!jar) throw new Error('no server.jar: run `node .claude/skills/trial-server/scripts/server.js setup` once (downloads the Mojang 1.21.6 jar, sha1-checked), or set BENCH_JAR')
  return jar
}

// a datapack that makes the overworld ONE biome (vanilla terrain noise and features, every column that biome); written into world/datapacks before the world exists
function writeBiomePack(worldDir, biome) {
  const dp = path.join(worldDir, 'datapacks', 'bench-biome')
  fs.mkdirSync(path.join(dp, 'data', 'minecraft', 'worldgen', 'world_preset'), { recursive: true })
  fs.writeFileSync(path.join(dp, 'pack.mcmeta'), JSON.stringify({ pack: { pack_format: 80, description: 'bench: single biome ' + biome } }))
  fs.writeFileSync(path.join(dp, 'data', 'minecraft', 'worldgen', 'world_preset', 'normal.json'), JSON.stringify({ dimensions: {
    'minecraft:overworld': { type: 'minecraft:overworld', generator: { type: 'minecraft:noise', settings: 'minecraft:overworld', biome_source: { type: 'minecraft:fixed', biome } } },
    'minecraft:the_nether': { type: 'minecraft:the_nether', generator: { type: 'minecraft:noise', settings: 'minecraft:nether', biome_source: { type: 'minecraft:multi_noise', preset: 'minecraft:nether' } } },
    'minecraft:the_end': { type: 'minecraft:the_end', generator: { type: 'minecraft:noise', settings: 'minecraft:end', biome_source: { type: 'minecraft:the_end' } } } } }))
}

// ---------------------------------------------------------------------------------------------------- make
async function waitGenerated(rc, world, x0, z0, x1, z1, tries = 40) {
  for (let i = 0; i < tries; i++) {
    await rc.cmd('save-all flush').catch(() => {})
    const g = T.columns(world, x0, z0, x1, z1)
    if (!g.missing) return g
    await sleep(8000)
  }
  throw new Error('chunks did not finish generating')
}

// start a server on `seed`, generate the 192x192 scout area, and rank the 128x128 windows in it. Leaves the server running; the caller stops it.
async function generate(a, seed) {
  const jar = needJar(), dir = path.join(BENCH, 'work', 'make-' + a.id)
  fs.rmSync(dir, { recursive: true, force: true })
  fs.mkdirSync(path.join(dir, 'world'), { recursive: true })
  if (a.biome) writeBiomePack(path.join(dir, 'world'), a.biome)
  const srv = await S.start({ jar, dir, port: PORT, rconPort: RCON_PORT, seed, difficulty: a.difficulty, minutes: 40 })
  try {
    const rc = srv.rcon, world = path.join(dir, 'world'), R = 96
    await rc.cmd('gamerule doMobSpawning false')
    let center = a.center, g
    if (!center) {
      await rc.cmd(`forceload add ${-R} ${-R} ${R - 1} ${R - 1}`)
      g = await waitGenerated(rc, world, -R, -R, R - 1, R - 1)
      const best = T.scout(g, a.size, a.want)[0]
      return { srv, dir, world, g, seed, win: best, center: best.center }
    }
    const h = a.size / 2 + 16
    await rc.cmd(`forceload add ${center[0] - h} ${center[1] - h} ${center[0] + h - 1} ${center[1] + h - 1}`)
    g = await waitGenerated(rc, world, center[0] - h, center[1] - h, center[0] + h - 1, center[1] + h - 1)
    return { srv, dir, world, g, seed, win: { ok: true, ...T.windowStats(g, center[0] - a.size / 2, center[1] - a.size / 2, a.size) }, center }
  } catch (e) { await srv.stop().catch(() => {}); throw e }
}
const describeWin = (w) => `land ${(w.land * 100).toFixed(0)}%, trees ${(w.trees * 100).toFixed(1)}%, relief ${w.relief}`

async function make(id, { force = false } = {}) {
  const a = arenaOf(id)
  if (fs.existsSync(path.join(snapDir(id), 'meta.json')) && !force) { log(`${id}: snapshot exists (use --force to rebuild)`); return }
  // seed search: the arena's seed first, then the next ones, until a window has the wanted land, trees and relief; the best one is used if none does
  const tries = a.center ? 1 : Number(opt('tries', a.tries || 8))
  let ctx = null, best = null
  for (let k = 0; k < tries; k++) {
    const seed = a.seed + k
    log(`${id}: generating seed ${seed} (biome ${a.biome || 'natural'})`)
    ctx = await generate(a, seed)
    log(`${id}: seed ${seed}: best window ${describeWin(ctx.win)}${ctx.win.ok ? ' (meets the wanted terrain)' : ''}`)
    if (!best || ctx.win.ok || ctx.win.rank > best.win.rank) best = { seed, win: ctx.win }
    if (ctx.win.ok) break
    await ctx.srv.stop()
    if (k === tries - 1) { log(`${id}: no seed met the wanted terrain, using seed ${best.seed}`); ctx = best.seed === seed ? null : await generate(a, best.seed); if (!ctx) ctx = await generate(a, seed) }
  }
  const { srv, dir, world, g, center, seed } = ctx
  try {
    const rc = srv.rcon, h2 = a.size / 2
    const gw = T.columns(world, center[0] - h2, center[1] - h2, center[0] + h2 - 1, center[1] + h2 - 1)
    const stats = T.windowStats(gw, center[0] - h2, center[1] - h2, a.size)
    const spawn = a.spawn || T.spawnNear(g, center[0], center[1], 40)
    if (!spawn) throw new Error('no dry flat spawn cell in the window')
    for (const c of [`worldborder center ${center[0]} ${center[1]}`, `worldborder set ${a.size}`, `setworldspawn ${spawn[0]} ${spawn[1]} ${spawn[2]}`, 'gamerule spawnRadius 0',
      'gamerule doWeatherCycle false', 'weather clear', 'gamerule doDaylightCycle true', 'gamerule doMobSpawning true', 'gamerule keepInventory false', 'time set 0', 'forceload remove all']) await rc.cmd(c)
    for (let i = 0; i < 3; i++) await rc.cmd('save-all flush')
    await srv.stop()
    const snap = snapDir(id)
    fs.rmSync(snap, { recursive: true, force: true })
    fs.mkdirSync(snap, { recursive: true })
    fs.cpSync(world, path.join(snap, 'world'), { recursive: true, filter: (s) => !/session\.lock$|[\\/](playerdata|stats|advancements)([\\/]|$)/.test(s) })
    const before = T.blockCounts(path.join(snap, 'world'), center[0] - h2, center[1] - h2, center[0] + h2 - 1, center[1] + h2 - 1)
    const meta = { id, name: a.name, biome: a.biome || null, seed, size: a.size, center, spawn, window: stats, difficulty: a.difficulty, madeAt: new Date().toISOString(), blocks: before }
    fs.writeFileSync(path.join(snap, 'meta.json'), JSON.stringify(meta))
    require('./lib/preview').write(path.join(snap, 'world'), meta, path.join(snap, 'preview.json'))
    const j = readArenas(); Object.assign(j.arenas[id], { seed, center, spawn, window: { land: +stats.land.toFixed(3), trees: +stats.trees.toFixed(3), relief: stats.relief, medianY: stats.medianY } }); writeArenas(j)
    log(`${id}: snapshot ready: seed ${seed}, window centre ${center.join(',')}, spawn ${spawn.join(',')}, ${describeWin(stats)}`)
  } finally { await srv.stop().catch(() => {}); fs.rmSync(dir, { recursive: true, force: true }) }
}

// ---------------------------------------------------------------------------------------------------- bot
function prepareBot(botDir, { code, bot, arena }) {
  const files = ['join.js', 'run.js', 'farm.js', 'excavate.js', 'package.json']
  fs.rmSync(botDir, { recursive: true, force: true })
  fs.mkdirSync(path.join(botDir, 'brain', 'state'), { recursive: true })
  for (const f of files) if (fs.existsSync(path.join(code, f))) fs.copyFileSync(path.join(code, f), path.join(botDir, f))
  fs.cpSync(path.join(code, 'brain'), path.join(botDir, 'brain'), { recursive: true, filter: (s) => !/[\\/]brain[\\/]state([\\/]|$)/.test(s) })
  fs.cpSync(path.join(code, 'vendor'), path.join(botDir, 'vendor'), { recursive: true })
  fs.mkdirSync(path.join(botDir, 'brain', 'state'), { recursive: true })
  fs.symlinkSync(path.join(code, 'node_modules'), path.join(botDir, 'node_modules'), 'junction')
  const cfg = path.join(code, 'bots', bot)
  const prof = path.join(cfg, 'profile.json')
  if (fs.existsSync(prof)) fs.copyFileSync(prof, path.join(botDir, 'brain', 'state', 'profile.json'))
  // the bot's own seed files, except what belongs to the live world: its work zone (centred on the live base) and its death memory (live coordinates)
  const seed = path.join(cfg, 'seed')
  if (fs.existsSync(seed)) fs.cpSync(seed, botDir, { recursive: true, filter: (s) => !/[\\/](zone|safety-tuning)\.json$/.test(s) })
  const [cx, cz] = arena.center
  fs.writeFileSync(path.join(botDir, 'brain', 'state', 'zone.json'), JSON.stringify({ _note: 'bench arena', workZone: { x: cx, z: cz, r: 95 }, noDig: [] }))
}

function startBot(botDir, { name, port }) {
  const out = fs.openSync(path.join(botDir, 'join.log'), 'a')
  const pre = path.join(__dirname, 'offline-preload.js')
  const env = { ...process.env, MC_EMAIL: name, MC_PORT: String(port), BENCH_PORT: String(port), BENCH_NAME: name, NODE_OPTIONS: `--require "${pre.split(path.sep).join('/')}"`, BOT_DASHBOARD_PORT: '-1', VIEWER_PORT: '0', SKIP_HELLO: '1', SUPERVISOR_POLL_MS: '600000' }
  const child = cp.spawn(process.execPath, [path.join(botDir, 'run.js')], { cwd: botDir, env, stdio: ['ignore', out, out], windowsHide: true })
  return child
}
function killTree(child) { try { if (child && child.pid) cp.execFileSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore' }) } catch {} }

// ---------------------------------------------------------------------------------------------------- run
async function sampleOnce(rc, name) {
  const g = async (what) => { try { const r = await rc.cmd(`data get entity ${name} ${what}`); return /No entity|Found no/.test(r) ? null : r } catch { return null } }
  const pos = await g('Pos'); if (!pos) return null
  const [inv, hp, food, dim, dm] = [await g('Inventory'), await g('Health'), await g('foodLevel'), await g('Dimension'), await rc.cmd('time query daytime').catch(() => '')]
  const dth = await rc.cmd(`scoreboard players get ${name} deaths`).catch(() => '')
  const gt = await rc.cmd('time query gametime').catch(() => '')
  const num = (s) => { const m = /(-?\d+(\.\d+)?)[fdb]?\s*$/.exec(String(s || '').trim()); return m ? +m[1] : null }
  return { pos: Sc.parseNums(pos.replace(/^[^\[]*/, '')).map(v => +v.toFixed(2)), hp: num(hp), food: num(food), inv: inv ? Sc.parseInventory(inv) : {}, deaths: (/has (\d+)/.exec(dth) || [])[1] ? +(/has (\d+)/.exec(dth))[1] : 0,
    day: num(dm), gt: num(gt), dim: dim ? (/"([^"]+)"/.exec(dim) || [])[1] : null }
}

const DEATH_RE = (n) => new RegExp(`\\]: (${n} (was|drowned|died|hit|burned|fell|tried|suffocated|starved|walked|went|blew|experienced|withered|got|froze|discovered|fell|died).*)$`, 'gm')

function finalize(runDir, info) {
  if (!fs.existsSync(path.join(runDir, 'samples.jsonl'))) fs.writeFileSync(path.join(runDir, 'samples.jsonl'), '')
  const samples = fs.readFileSync(path.join(runDir, 'samples.jsonl'), 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l))
  const world = path.join(runDir, 'server', 'world'), a = info.arena
  const logTxt = (() => { try { return fs.readFileSync(path.join(runDir, 'server', 'logs', 'latest.log'), 'utf8') } catch { return '' } })()
  const deathLog = [...logTxt.matchAll(DEATH_RE(info.name))].map(m => m[1])
  let stats = {}
  try { stats = JSON.parse(fs.readFileSync(path.join(world, 'stats', S.offlineUuid(info.name) + '.json'), 'utf8')).stats || {} } catch {}
  const h = a.size / 2, box = [a.center[0] - h, a.center[1] - h, a.center[0] + h - 1, a.center[1] + h - 1]
  const after = T.blockCounts(world, ...box), before = JSON.parse(fs.readFileSync(path.join(snapDir(a.id), 'meta.json'), 'utf8')).blocks
  const delta = {}; for (const k of new Set([...Object.keys(before), ...Object.keys(after)])) { const d = (after[k] || 0) - (before[k] || 0); if (d) delta[k] = d }
  const placedDelta = {}; for (const [k, v] of Object.entries(delta)) if (v > 0) placedDelta[k] = v
  const reconnects = (logTxt.match(new RegExp(info.name + ' joined the game', 'g')) || []).length - 1
  const res = Sc.analyze({ samples, seconds: info.seconds, stats, placedDelta, deathLog, reconnects: Math.max(0, reconnects) })
  const gts = samples.map(x => x.gt).filter(x => x != null)
  const out = { id: info.id, arena: a.id, tickRate: info.tickRate || 20, gameTicks: gts.length ? gts[gts.length - 1] - gts[0] : null, biome: a.biome, label: info.label || '', bot: info.bot, code: info.code, name: info.name, difficulty: info.difficulty, startedAt: info.startedAt, minutes: info.minutes, ...res, blockDelta: Object.fromEntries(Object.entries(delta).sort((x, y) => Math.abs(y[1]) - Math.abs(x[1])).slice(0, 40)), notes: info.notes || [] }
  fs.writeFileSync(path.join(runDir, 'result.json'), JSON.stringify(out, null, 1))
  return out
}
const summaryLine = (r) => `${r.id}: ${r.points}/${r.maxPoints} pts in ${Math.round(r.seconds / 60)} min | per hour: ${r.perHour.points} pts, ${r.perHour.deaths} deaths, stall ${r.perHour.stallSeconds}s (${r.totals.stallPct}%), ${r.perHour.itemsPickedUp} items picked up, ${r.perHour.blocksMined} mined | phases ${r.phase.p1} ${r.phase.p2} ${r.phase.p3}`

async function run(id) {
  const a = arenaOf(id)
  if (!fs.existsSync(path.join(snapDir(id), 'meta.json'))) throw new Error(`arena ${id} has no snapshot: run "make ${id}" first`)
  const jar = needJar(), minutes = Number(opt('minutes', a.minutes)), botKind = opt('bot', 'ozo'), code = path.resolve(opt('code', REPO))
  const name = opt('name', 'OzoBench'), difficulty = opt('difficulty', a.difficulty)
  const runId = `${id}-${stamp()}`, runDir = path.join(BENCH, 'runs', runId), serverDir = path.join(runDir, 'server'), botDir = path.join(runDir, 'bot')
  fs.mkdirSync(serverDir, { recursive: true })
  const t0c = Date.now()
  fs.cpSync(path.join(snapDir(id), 'world'), path.join(serverDir, 'world'), { recursive: true })            // the reset: the starting snapshot, byte for byte
  log(`${runId}: reset in ${Date.now() - t0c} ms (copied snapshot); starting server`)
  const meta = JSON.parse(fs.readFileSync(path.join(snapDir(id), 'meta.json'), 'utf8'))
  const arena = { ...a, center: meta.center, spawn: meta.spawn }
  const srv = await S.start({ jar, dir: serverDir, port: PORT, rconPort: RCON_PORT, seed: a.seed, difficulty, minutes: minutes + 10 })
  const rc = srv.rcon
  let bot = null, finished = false
  const info = { id: runId, arena, name, bot: botKind, code: path.basename(code), difficulty, minutes, label: opt('label', ''), startedAt: new Date().toISOString(), seconds: 0, notes: [] }
  const finish = async (why) => {
    if (finished) return; finished = true
    log(`${runId}: finishing (${why})`)
    killTree(bot); await sleep(500)
    await srv.stop().catch(() => {})
    try { rc.close() } catch {}
    const res = finalize(runDir, info)
    const idx = { id: res.id, arena: res.arena, label: res.label, startedAt: res.startedAt, seconds: res.seconds, points: res.points, perHour: res.perHour, phase: res.phase, code: res.code }
    fs.appendFileSync(path.join(BENCH, 'results.jsonl'), JSON.stringify(idx) + '\n')
    log(summaryLine(res)); return res
  }
  process.on('SIGINT', async () => { await finish('interrupted'); process.exit(130) })
  try {
    await rc.cmd('tick freeze')                                                                     // the world waits until the bot is standing at the spawn
    await rc.cmd('scoreboard objectives add deaths deathCount')
    prepareBot(botDir, { code, bot: botKind, arena })
    bot = startBot(botDir, { name, port: PORT })
    let s = null
    for (let i = 0; i < 90 && !s; i++) { await sleep(2000); s = await sampleOnce(rc, name); if (bot.exitCode != null) throw new Error('bot exited early, see ' + path.join(botDir, 'join.log')) }
    if (!s) throw new Error('bot never joined, see ' + path.join(botDir, 'join.log'))
    await rc.cmd('time set 0'); await rc.cmd('tick unfreeze')
    if (opt('tickrate')) { log(`${runId}:`, await rc.cmd('tick rate ' + opt('tickrate'))); info.tickRate = Number(opt('tickrate')) }
    log(`${runId}: bot in at ${s.pos.join(',')} (spawn ${arena.spawn.join(',')}), clock started`)
    const t0 = Date.now(), end = t0 + minutes * 60000, out = path.join(runDir, 'samples.jsonl')
    let lastPrint = 0
    while (Date.now() < end && !finished) {
      await sleep(Math.max(0, 3000 - 0))
      const t = (Date.now() - t0) / 1000
      let row = null; try { row = await sampleOnce(rc, name) } catch (e) { info.notes.push('sample error ' + e.message); if (!/timeout|closed/.test(e.message)) continue; break }
      fs.appendFileSync(out, JSON.stringify({ t: +t.toFixed(1), ...(row || { pos: null, inv: {}, deaths: null }) }) + '\n')
      info.seconds = t
      if (t - lastPrint >= 120) { lastPrint = t; const inv = row ? Object.entries(row.inv).sort((x, y) => y[1] - x[1]).slice(0, 6).map(([k, v]) => k + ' ' + v).join(', ') : '(no entity)'; log(`${runId}: t=${Math.round(t / 60)}m hp ${row && row.hp} deaths ${row && row.deaths} pos ${row && row.pos && row.pos.map(Math.round).join(',')} bag: ${inv}`) }
      if (bot.exitCode != null) { info.notes.push('bot process exited with ' + bot.exitCode); break }
    }
    return await finish('time up')
  } catch (e) { info.notes.push(String(e.message)); log('error:', e.message); await finish('error'); throw e }
}

// ---------------------------------------------------------------------------------------------------- list / score
function list() {
  const j = readArenas(), results = fs.existsSync(path.join(BENCH, 'results.jsonl')) ? fs.readFileSync(path.join(BENCH, 'results.jsonl'), 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l)) : []
  for (const [id, a] of Object.entries(j.arenas)) {
    const snap = fs.existsSync(path.join(snapDir(id), 'meta.json')), mine = results.filter(r => r.arena === id)
    console.log(`${id.padEnd(10)} ${String(a.biome || 'natural').padEnd(26)} ${snap ? 'snapshot ok ' : 'no snapshot '} runs ${mine.length}${mine.length ? '  last: ' + mine[mine.length - 1].points + ' pts, ' + mine[mine.length - 1].perHour.deaths + ' deaths/h' : ''}`)
  }
}

;(async () => {
  try {
    if (cmd === 'list') list()
    else if (cmd === 'make') { for (const id of (arg1 === 'all' ? Object.keys(readArenas().arenas) : [arg1])) await make(id, { force: flag('force') }) }
    else if (cmd === 'run') await run(arg1)
    else if (cmd === 'score') { const dir = path.join(BENCH, 'runs', arg1); const r = JSON.parse(fs.readFileSync(path.join(dir, 'result.json'), 'utf8')); console.log(summaryLine(finalize(dir, { id: r.id, arena: arenaOf(r.arena), name: r.name, seconds: r.seconds, bot: r.bot, code: r.code, difficulty: r.difficulty, minutes: r.minutes, label: r.label, startedAt: r.startedAt, notes: r.notes }))) }
    else if (cmd === 'tick') throw new Error('tick: not built yet')
    else console.log('usage: bench.js list | make <arena|all> [--force] | run <arena> [--minutes N] [--bot ozo] [--code dir] [--label x] | score <run id> | tick <arena>')
    process.exit(0)
  } catch (e) { console.error('error:', e.message); process.exit(1) }
})()
