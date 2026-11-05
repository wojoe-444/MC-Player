// Combat arena harness. Connects ONE bot (same Microsoft login as join.js, so the base bot must be offline) to the arena LAN world
// and runs repeatable survival trials against scripted night waves, driven by job files dropped in arena/queue/*.json:
//   { "label": "base", "n": 5, "params": { ...combat overrides }, "kit": { "armor": true }, "capSec": 300, "seedBase": 1 }
// Results: arena/results/trials.jsonl (one line per trial), arena/results/scoreboard.json, arena/harness.log.
// combat.js / threat.js are reloaded before every trial, so edit them freely while this keeps running.
const fs = require('fs')
const path = require('path')
const mineflayer = require('mineflayer')
const ROOT = path.resolve(__dirname, '..')
process.chdir(ROOT)
const A = (...p) => path.join(__dirname, ...p)
const PORT = Number(process.env.MC_PORT) || parseInt(fs.readFileSync(A('port.txt'), 'utf8'), 10)
const log = (...a) => { const s = new Date().toISOString().slice(11, 19) + ' ' + a.join(' '); console.log(s); try { fs.appendFileSync(A('harness.log'), s + '\n') } catch {} }
const sleep = (ms) => new Promise(r => setTimeout(r, ms))

const bot = mineflayer.createBot({ host: 'localhost', port: PORT, username: process.env.MC_EMAIL, auth: 'microsoft', version: '1.21.6', profilesFolder: './auth-cache', disableChatSigning: true })
const FABRIC = ['fabric:registry/sync/direct', 'fabric:registry/sync/nbt', 'fabric:registry/sync/complete', 'fabric:accepted_attachments_v1', 'c:version', 'c:register', 'fabric:custom_ingredient_sync']
const c = bot._client
c.on('custom_payload', (p) => {
  if (c.state !== 'configuration') return
  if (p.channel === 'minecraft:register') c.write('custom_payload', { channel: 'minecraft:register', data: Buffer.from(FABRIC.join('\0')) })
  else if (p.channel === 'fabric:accepted_attachments_v1') c.write('custom_payload', { channel: 'fabric:accepted_attachments_v1', data: Buffer.from([0]) })
  else if (p.channel === 'fabric:custom_ingredient_sync') c.write('custom_payload', { channel: 'fabric:custom_ingredient_sync', data: Buffer.from([1, 0]) })
  else if (p.channel === 'c:version') c.write('custom_payload', { channel: 'c:version', data: Buffer.from([1, 1]) })
  else if (p.channel === 'c:register') { const d = Buffer.from(p.data); c.write('custom_payload', { channel: 'c:register', data: Buffer.concat([d.subarray(0, 2 + d[1]), Buffer.from([0])]) }) }
  else if (p.channel === 'fabric:registry/sync/direct' && p.data.length === 0) c.write('custom_payload', { channel: 'fabric:registry/sync/complete', data: Buffer.alloc(0) })
})
bot.on('error', (e) => log('ERROR', e.message))
bot.on('kicked', (r) => log('KICKED', JSON.stringify(r).slice(0, 200)))
bot.on('end', (r) => { log('END', r); process.exit(2) })
let lastMsgs = []
bot.on('messagestr', (m) => { lastMsgs.push(m); if (lastMsgs.length > 30) lastMsgs.shift() })

// ---- commands (rate limited: the server kicks for command spam) ----
let cmdQ = [], cmdBusy = false
function cmd(s) { cmdQ.push(s); if (!cmdBusy) pump() }
async function pump() { cmdBusy = true; while (cmdQ.length) { bot.chat(cmdQ.shift()); await sleep(110) } cmdBusy = false }
async function cmdsDone() { while (cmdQ.length || cmdBusy) await sleep(50) }

function mulberry(seed) { let a = seed >>> 0; return () => { a |= 0; a = a + 0x6D2B79F5 | 0; let t = Math.imul(a ^ a >>> 15, 1 | a); t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t; return ((t ^ t >>> 14) >>> 0) / 4294967296 } }

let home = null
async function waitFor(fn, ms, step = 100) { const t0 = Date.now(); while (Date.now() - t0 < ms) { if (fn()) return true; await sleep(step) } return false }

async function prepWorld() {
  for (const g of ['doDaylightCycle false', 'doWeatherCycle false', 'doMobSpawning false', 'mobGriefing false', 'doImmediateRespawn true', 'doMobLoot false', 'keepInventory false', 'showDeathMessages true', 'doTileDrops false', 'sendCommandFeedback false', 'logAdminCommands false']) cmd('/gamerule ' + g)
  cmd('/difficulty hard'); cmd('/time set 18000'); cmd('/weather clear')
  await cmdsDone()
}

async function setupTrial(job, rnd) {
  cmd('/gamemode creative'); await cmdsDone()
  if (!await waitFor(() => bot.game.gameMode === 'creative', 4000)) throw new Error('no cheats/op: /gamemode did not change (open the LAN world with Allow Cheats ON)')
  cmd('/kill @e[type=!minecraft:player]'); cmd('/clear @s'); cmd('/effect clear @s'); cmd('/time set 18000')
  cmd(`/tp @s ${home.x} ${home.y} ${home.z} 0 0`)
  const armor = !(job.kit && job.kit.armor === false)
  if (job.kit && job.kit.scramble) {
    // scrambled start: every item in a random inventory slot (armor unworn, shield maybe not in the off-hand), so the bot has to organise itself
    const free = Array.from({ length: 36 }, (_, i) => i); const take = () => free.splice(Math.floor(rnd() * free.length), 1)[0]
    const put = (item, n = 1) => cmd(`/item replace entity @s container.${take()} with minecraft:${item} ${n}`)
    put('iron_sword'); put('bow'); put('arrow', 64); put('baked_potato', 64)
    if (rnd() < 0.3) cmd('/item replace entity @s weapon.offhand with minecraft:shield'); else put('shield')
    if (armor) for (const it of ['helmet', 'chestplate', 'leggings', 'boots']) { if (rnd() < 0.5) put('iron_' + it); else cmd(`/item replace entity @s armor.${{ helmet: 'head', chestplate: 'chest', leggings: 'legs', boots: 'feet' }[it]} with minecraft:iron_${it}`) }
    cmd('/effect give @s minecraft:instant_health 1 10 true'); cmd('/effect give @s minecraft:saturation 1 10 true')
    await cmdsDone(); await sleep(1500); return
  }
  if (armor) for (const [slot, it] of [['head', 'helmet'], ['chest', 'chestplate'], ['legs', 'leggings'], ['feet', 'boots']]) cmd(`/item replace entity @s armor.${slot} with minecraft:iron_${it}`)
  cmd('/item replace entity @s weapon.offhand with minecraft:shield')
  cmd('/give @s minecraft:iron_sword'); cmd('/give @s minecraft:bow'); cmd('/give @s minecraft:arrow 64'); cmd('/give @s minecraft:baked_potato 64')
  if (job.kit && job.kit.flint) cmd('/give @s minecraft:flint_and_steel')
  cmd('/effect give @s minecraft:instant_health 1 10 true'); cmd('/effect give @s minecraft:saturation 1 10 true')
  await cmdsDone(); await sleep(1500)
}

function loadCombat() {
  for (const k of Object.keys(require.cache)) if (k.startsWith(__dirname) && !k.endsWith('harness.js')) delete require.cache[k]
  return require('./' + (global.__mod || 'combat'))
}

const MOBS = [['zombie', 0.45], ['skeleton', 0.25], ['creeper', 0.15], ['spider', 0.15]]
function pickMob(rnd) { let r = rnd(), s = 0; for (const [m, w] of MOBS) { s += w; if (r < s) return m } return 'zombie' }

let WALLS = null; try { WALLS = JSON.parse(fs.readFileSync(A('walls.json'), 'utf8')) } catch {}
function deathInfo(p) {   // where the bot died relative to the barrier (negative = outside it)
  if (!p) return null
  if (!WALLS) { try { WALLS = JSON.parse(fs.readFileSync(A('walls.json'), 'utf8')) } catch { return { x: +p.x.toFixed(1), z: +p.z.toFixed(1) } } }
  const b = WALLS.bbox, wd = Math.min(p.x - b.x0, b.x1 - p.x, p.z - b.z0, b.z1 - p.z)
  const cd = Math.min(...[[b.x0, b.z0], [b.x0, b.z1], [b.x1, b.z0], [b.x1, b.z1]].map(([cx, cz]) => Math.hypot(p.x - cx, p.z - cz)))
  return { x: +p.x.toFixed(1), z: +p.z.toFixed(1), wallDist: +wd.toFixed(1), cornerDist: +cd.toFixed(1) }
}
async function runTrial(job, idx) {
  const seed = (job.seedBase || 1) * 1000 + idx
  const rnd = mulberry(seed)
  await setupTrial(job, rnd)
  global.__mod = job.module; const combatMod = loadCombat()
  let params = {}
  try { params = JSON.parse(fs.readFileSync(A('params.json'), 'utf8')) } catch {}
  Object.assign(params, job.params || {})
  if (params.rngSeed === undefined) params.rngSeed = seed   // seeded strafing etc. during benchmarks (common random numbers); the live bot has no seed and stays unpredictable
  const W = { first: 6, every: 10, base: 2, growth: 0.7, cap: 30, ...(job.waves || {}) }
  const cap = (job.capSec || 300) * 1000
  const stat = { damage: 0, dmgBy: {}, waves: 0, maxAlive: 0, mobsSpawned: 0 }
  const timeline = []
  let dead = false, cause = null, deathAt = 0
  let deathPos = null
  const onDeath = () => { dead = true; deathAt = Date.now(); try { deathPos = bot.entity.position.clone() } catch {} }
  bot.once('death', onDeath)
  // damage accounting
  let lastHealth = null
  const onHealth = () => {
    if (lastHealth !== null && bot.health < lastHealth) {
      const amt = lastHealth - bot.health
      stat.damage += amt
      const me = bot.entity && bot.entity.position
      let src = 'unknown'
      if (me) {
        const near = Object.values(bot.entities).filter(e => e !== bot.entity && e.position && (e.type === 'hostile' || /arrow/.test(e.name || '')) && e.position.distanceTo(me) < 14)
        near.sort((a, b) => a.position.distanceTo(me) - b.position.distanceTo(me))
        if (near[0]) src = near[0].name
        const sk = near.find(e => e.name === 'skeleton'), arrow = near.find(e => /arrow/.test(e.name))
        if (arrow || (sk && !near.some(e => e.name !== 'skeleton' && e.position.distanceTo(me) < 3.5))) src = 'arrow'
        const cr = near.find(e => e.name === 'creeper' && e.position.distanceTo(me) < 7)
        if (cr && amt >= 6) src = 'creeper'
      }
      stat.dmgBy[src] = +((stat.dmgBy[src] || 0) + amt).toFixed(1)
    }
    lastHealth = bot.health
  }
  bot.on('health', onHealth); lastHealth = bot.health
  cmd('/gamemode survival'); await cmdsDone()
  await waitFor(() => bot.game.gameMode === 'survival', 3000)
  const combat = combatMod.create(bot, params, { event: () => {} })
  const t0 = Date.now()
  let nextWave = t0 + W.first * 1000
  const heading = rnd() * Math.PI * 2
  combat.setIdleYaw(heading)
  let lastSample = 0
  while (!dead && Date.now() - t0 < cap) {
    await sleep(100)
    const now = Date.now()
    if (now >= nextWave && bot.entity) {
      let n = Math.min(W.cap, Math.round(W.base + stat.waves * W.growth))
      if (stat.waves === 0 && W.firstCount) n = W.firstCount
      if (W.aliveCap) { const alive = Object.values(bot.entities).filter(e => e.type === 'hostile').length; n = Math.max(0, Math.min(n, W.aliveCap - alive)) }   // steady pressure: top up toward a ceiling
      const me = bot.entity.position
      for (let i = 0; i < n; i++) {
        const mob = pickMob(rnd), ang = rnd() * Math.PI * 2, r = 12 + rnd() * 8
        cmd(`/summon minecraft:${mob} ${(me.x + Math.cos(ang) * r).toFixed(1)} ${me.y.toFixed(1)} ${(me.z + Math.sin(ang) * r).toFixed(1)} {PersistenceRequired:1b}`)
        stat.mobsSpawned++; (stat.byType = stat.byType || {})[mob] = (stat.byType[mob] || 0) + 1
      }
      stat.waves++
      nextWave = now + W.every * 1000
    }
    if (now - lastSample >= 1000) {
      lastSample = now
      const alive = Object.values(bot.entities).filter(e => e.type === 'hostile').length
      stat.maxAlive = Math.max(stat.maxAlive, alive)
      timeline.push([Math.round((now - t0) / 1000), +bot.health.toFixed(1), bot.food, alive])
    }
  }
  const survived = Math.min(dead ? deathAt - t0 : cap, cap) / 1000
  if (dead) {
    await sleep(600)
    const dm = lastMsgs.slice(-8).reverse().find(m => /was (slain|shot|blown|killed|pricked|burned|fireballed|stung)|blew up|hit the ground|fell|drowned|suffocated|died/i.test(m))
    cause = dm ? dm.replace(bot.username, 'bot') : 'unknown'
  }
  const near = bot.entity ? Object.values(bot.entities).filter(e => e.type === 'hostile').length : 0
  combat.stop()
  try { fs.mkdirSync(A('results', 'traces'), { recursive: true }); fs.writeFileSync(A('results', 'traces', `${job.label}-${idx}.json`), JSON.stringify({ label: job.label, idx, survivedSec: +survived.toFixed(1), died: dead, cause, params: job.params || {}, trace: combat.trace || [], dmgLog: combat.dmgLog || [], behTicks: combat.behTicks || {}, events: combat.events || [], stats: combat.stats })) } catch (e) { log('trace write failed', e.message) }
  bot.removeListener('health', onHealth); bot.removeListener('death', onDeath)
  if (!dead) { cmd('/kill @s'); await cmdsDone(); await waitFor(() => bot.isAlive, 3000); await sleep(800) } else await sleep(800)
  cmd('/gamemode creative'); cmd('/kill @e[type=!minecraft:player]'); await cmdsDone()
  const res = {
    label: job.label, idx, seed, ts: new Date().toISOString(), survivedSec: +survived.toFixed(1), died: dead, cause,
    kills: combat.stats.kills, damage: +stat.damage.toFixed(1), dmgBy: stat.dmgBy, waves: stat.waves, mobsSpawned: stat.mobsSpawned, byType: stat.byType, maxAlive: stat.maxAlive,
    death: deathInfo(deathPos), stats: combat.stats, waveCfg: job.waves || null, kit: job.kit || { armor: true }, params: job.params || {}, timeline: timeline.filter((_, i) => i % 5 === 0),
    events: combat.events.filter(e => e.type !== 'bow-draw').slice(-40),
  }
  fs.appendFileSync(A('results', 'trials.jsonl'), JSON.stringify(res) + '\n')
  return res
}

// 80% CI half-width of the mean (t quantile 0.9 via small table + interpolation)
const T90 = [0, 3.078, 1.886, 1.638, 1.533, 1.476, 1.440, 1.415, 1.397, 1.383, 1.372, 1.363, 1.356, 1.350, 1.345, 1.341]
function halfWidth(a) { if (a.length < 2) return Infinity; const m = a.reduce((x, y) => x + y, 0) / a.length; const sd = Math.sqrt(a.reduce((x, y) => x + (y - m) ** 2, 0) / (a.length - 1)); return (T90[Math.min(a.length - 1, 15)]) * sd / Math.sqrt(a.length) }
function median(a) { const s = a.slice().sort((x, y) => x - y); const m = s.length >> 1; return s.length ? (s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2) : 0 }
function updateScoreboard(job, results) {
  const f = A('results', 'scoreboard.json')
  let sb = {}; try { sb = JSON.parse(fs.readFileSync(f, 'utf8')) } catch {}
  const t = results.map(r => r.survivedSec)
  sb[job.label] = {
    n: results.length, medianSurvival: +median(t).toFixed(1), meanSurvival: +(t.reduce((a, b) => a + b, 0) / t.length).toFixed(1), min: Math.min(...t), max: Math.max(...t),
    meanKills: +(results.reduce((a, r) => a + r.kills, 0) / results.length).toFixed(1), meanDamage: +(results.reduce((a, r) => a + r.damage, 0) / results.length).toFixed(1),
    deaths: results.filter(r => r.died).length, causes: results.filter(r => r.died).map(r => r.cause), params: job.params || {}, kit: job.kit || { armor: true }, at: new Date().toISOString(),
  }
  fs.writeFileSync(f, JSON.stringify(sb, null, 1))
  return sb[job.label]
}

const stats = require('./stats')
const metrics = require('./metrics')
const rowsOf = (label) => { try { return fs.readFileSync(A('results', 'trials.jsonl'), 'utf8').trim().split(String.fromCharCode(10)).map(l => JSON.parse(l)).filter(r => r.label === label) } catch { return [] } }
// Sequential test of a candidate against the incumbent: run the candidate until it is clearly better (p<0.05), clearly not better, or maxCand runs;
// if still ambiguous, run more of the incumbent (up to maxInc) and re-test. Decisions are logged as VERDICT lines.
async function runVs(job) {
  const inc = job.vs, maxCand = inc.maxCand || 8, maxInc = inc.maxInc || 4, minCand = inc.minCand || 3
  const incJob = { ...inc, capSec: job.capSec, kit: inc.kit || job.kit, waves: job.waves }
  const surv = (l) => rowsOf(l).map(r => metrics.score(r, inc.metric || 'survival')).filter(x => x !== null)
  const decide = () => {
    const IA = surv(inc.label), IB = surv(job.label)
    if (IB.length < minCand || IA.length < 3) return null
    const pBetter = stats.welchP(IA, IB), pWorse = stats.welchP(IB, IA), hw = stats.halfWidth80(IB)
    if (pBetter < 0.05) return { v: 'WIN', pBetter, pWorse }
    if (pWorse < 0.10 || stats.mean(IB) + hw < stats.mean(IA)) return { v: 'LOSE', pBetter, pWorse }
    return null
  }
  let nc = 0, ni = 0, d = null
  while (!d) {
    if (fs.existsSync(A('STOP'))) return
    const minInc = inc.minInc || 4
    const doCand = surv(inc.label).length >= minInc && nc < maxCand   // incumbent first if it lacks data for this metric
    if (!doCand && ni >= maxInc && surv(inc.label).length >= minInc) { const IA = surv(inc.label), IB = surv(job.label); d = { v: 'INCONCLUSIVE', pBetter: stats.welchP(IA, IB), pWorse: stats.welchP(IB, IA) }; break }
    const j = doCand ? job : incJob
    try {
      const r = await runTrial(j, rowsOf(j.label).length)
      log(`  ${j.label}#${r.idx}${doCand ? '' : ' (incumbent rerun)'}: ${r.survivedSec}s ${r.died ? 'DIED' : 'alive'} kills=${r.kills} dmg=${r.damage} waves=${r.waves} cause=${r.cause}`)
      if (doCand) nc++; else ni++
    } catch (e) { log('trial error', e.message); await sleep(2000); continue }
    d = decide()
  }
  const IA = surv(inc.label), IB = surv(job.label)
  log('VERDICT', job.label, d.v, 'vs', inc.label, `candidate n=${IB.length} mean=${stats.mean(IB).toFixed(1)} | incumbent n=${IA.length} mean=${stats.mean(IA).toFixed(1)} | p(better)=${d.pBetter.toFixed(3)} p(worse)=${d.pWorse.toFixed(3)}`)
}

async function main() {
  await new Promise(r => bot.once('spawn', r))
  log('SPAWNED', bot.username, JSON.stringify(bot.entity.position), 'mode', bot.game.gameMode)
  await sleep(2000)
  cmd('/gamemode creative'); await cmdsDone()
  if (!await waitFor(() => bot.game.gameMode === 'creative', 4000)) log('WARNING: no cheats yet (gamemode unchanged). Will keep waiting for op.')
  home = { x: 2.5, y: -60, z: -2.5 }   // fixed arena centre (inside the barrier); the spawn point can drift, e.g. onto the course
  log('home', JSON.stringify(home))
  await prepWorld()
  for (const f of fs.readdirSync(A('queue'))) if (f.endsWith('.running')) fs.renameSync(A('queue', f), A('queue', f.replace(/.running$/, '')))
  log('ready; watching', A('queue'))
  while (true) {
    const files = fs.readdirSync(A('queue')).filter(f => f.endsWith('.json')).sort()
    if (!files.length) { await sleep(1000); continue }
    const jf = A('queue', files[0]); let job
    try { job = JSON.parse(fs.readFileSync(jf, 'utf8')) } catch (e) { log('bad job', files[0], e.message); fs.renameSync(jf, jf + '.bad'); continue }
    fs.renameSync(jf, A('queue', files[0] + '.running'))
    log('JOB', job.label, job.vs ? 'vs ' + job.vs.label : 'n=' + job.n)
    if (job.probe) { try { const r = (delete require.cache[require.resolve('./' + job.probe)], await require('./' + job.probe)(bot, cmd, sleep, job)); fs.writeFileSync(A('results', (job.label || 'probe') + '.json'), JSON.stringify(r, null, 1)); log('PROBE', job.label, JSON.stringify(r).slice(0, 600)) } catch (e) { log('probe error', e.message) } fs.renameSync(A('queue', files[0] + '.running'), A('queue', files[0] + '.done')); continue }
    if (job.vs) { await runVs(job); fs.renameSync(A('queue', files[0] + '.running'), A('queue', files[0] + '.done')); if (fs.existsSync(A('STOP'))) { fs.unlinkSync(A('STOP')); log('stopped by STOP file'); process.exit(0) } continue }
    const results = []
    // sequential design: job.n is a fixed count; or job.adaptive = { targetHalfWidth, nMin, nMax, beat?: label } runs until the 80% CI of the mean is tight enough (or futile)
    const ad = job.adaptive, nMax = ad ? (ad.nMax || 10) : (job.n || 1)
    let prior = []
    if (job.topup) { try { prior = fs.readFileSync(A('results', 'trials.jsonl'), 'utf8').trim().split(String.fromCharCode(10)).map(l => JSON.parse(l)).filter(r => r.label === job.label).map(r => r.survivedSec) } catch {} ; job.idxStart = prior.length }
    for (let i = 0; i < nMax; i++) {
      if (ad && job.topup && prior.length + results.length >= (ad.nMin || 4) && halfWidth(prior.concat(results.map(r => r.survivedSec))) <= (ad.targetHalfWidth || 3.5)) { log('  topup: ' + job.label + ' already precise enough (n=' + (prior.length + results.length) + ')'); break }
      try {
        const r = await runTrial(job, (job.idxStart || 0) + i); results.push(r)
        log(`  ${job.label}#${i}: ${r.survivedSec}s ${r.died ? 'DIED' : 'alive'} kills=${r.kills} dmg=${r.damage} waves=${r.waves} cause=${r.cause}`)
      } catch (e) { log('trial error', e.message); await sleep(2000) }
      if (fs.existsSync(A('STOP'))) break
      if (ad && prior.length + results.length >= (ad.nMin || 4)) {
        const t = prior.concat(results.map(r => r.survivedSec)), hw = halfWidth(t), m = t.reduce((x, y) => x + y, 0) / t.length
        let futile = false
        if (ad.beatMean !== undefined && m + hw < ad.beatMean - (ad.margin || 0)) futile = true   // even the optimistic end of the CI is below the incumbent
        if (hw <= (ad.targetHalfWidth || 3.5) || futile) { log('  adaptive stop at n=' + t.length + ' halfwidth=' + hw.toFixed(1) + (futile ? ' (futile: clearly below incumbent)' : ' (precise enough)')); break }
      }
    }
    if (results.length) log('SCORE', job.label, JSON.stringify(updateScoreboard(job, results)))
    fs.renameSync(A('queue', files[0] + '.running'), A('queue', files[0] + '.done'))
    if (fs.existsSync(A('STOP'))) { fs.unlinkSync(A('STOP')); log('stopped by STOP file'); process.exit(0) }
  }
}
main().catch(e => { log('FATAL', e.stack); process.exit(1) })
