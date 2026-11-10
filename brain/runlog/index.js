// brain/runlog: "compare each bot with itself, by commit" (docs/HILLCLIMB-INSIGHTS.md, item 4). An observer: it never moves the bot or touches the world.
//
//   bot._runInfo.commit()          the short git commit the code on disk is at right now (the bots hot-reload from main, so this is read live, cached 60 s)
//   bot._runInfo.dayCommits(day)   the distinct commits seen during that in-game day (plan.js writes them into each dayStats row)
//   brain/state/runlog/commits.jsonl   one line per change of commit: { t, day, commit, subject }
//   brain/state/runlog/steps.jsonl     one line per autopilot step change: { t, day, step, prev, x, y, z, hp, held }  (rotated at 2 MB)
//   brain/state/runlog/step-loops.json { pairs: { "A|B": { count, ys: [y of each 4-run], last } }, since }  A,B,A,B within 10 min = a step ping-pong
//                                      (the planner's own loop detector only sees A,A,A,A; ladder bobbing is the expected A,B,A,B)
const fs = require('fs')
const path = require('path')
const { execFileSync } = require('child_process')

const ROOT = path.join(__dirname, '..', '..')
const COMMIT_TTL_MS = 60000, LOOP_WINDOW_MS = 10 * 60000, ROTATE_BYTES = 2 * 1024 * 1024, MAX_YS = 20

function readCommit(root = ROOT) {
  try { return execFileSync('git', ['rev-parse', '--short=9', 'HEAD'], { cwd: root, timeout: 3000, stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim() || null } catch { /* not a git checkout */ }
  try {                                                                    // no git binary: read .git/HEAD directly
    const head = fs.readFileSync(path.join(root, '.git', 'HEAD'), 'utf8').trim()
    if (!head.startsWith('ref:')) return head.slice(0, 9)
    return fs.readFileSync(path.join(root, '.git', head.slice(5).trim()), 'utf8').trim().slice(0, 9)
  } catch { return null }
}
function readSubject(root = ROOT) { try { return execFileSync('git', ['log', '-1', '--format=%s'], { cwd: root, timeout: 3000, stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim().slice(0, 120) } catch { return null } }

// Pure: feeds step changes in, reports A,B,A,B. keeps the last four transitions with their time and Y.
function createLoopTracker({ windowMs = LOOP_WINDOW_MS } = {}) {
  const recent = []
  const pairs = {}
  return {
    pairs,
    // returns { a, b, ys } when this step change completes an A,B,A,B run inside the window, else null
    note(step, t, y) {
      if (!step) return null
      if (recent.length && recent[recent.length - 1].step === step) return null
      recent.push({ step, t, y }); if (recent.length > 4) recent.shift()
      if (recent.length < 4) return null
      const [s0, s1, s2, s3] = recent
      if (s0.step === s2.step && s1.step === s3.step && s0.step !== s1.step && s3.t - s0.t <= windowMs) {
        const key = [s0.step, s1.step].sort().join('|'), p = pairs[key] = pairs[key] || { count: 0, ys: [], last: 0 }
        p.count++; p.last = t; p.ys.push(+Math.min(...recent.map(r => r.y)).toFixed(1) + '..' + +Math.max(...recent.map(r => r.y)).toFixed(1)); if (p.ys.length > MAX_YS) p.ys.shift()
        return { a: s0.step, b: s1.step, ys: recent.map(r => r.y) }
      }
      return null
    }
  }
}

module.exports = function register(api) {
  const { bot } = api
  const now = () => (api.now ? api.now() : Date.now())
  const dir = path.dirname(api.statePath('runlog/x'))
  try { fs.mkdirSync(dir, { recursive: true }) } catch {}
  const commitsFile = path.join(dir, 'commits.jsonl'), stepsFile = path.join(dir, 'steps.jsonl'), loopsFile = path.join(dir, 'step-loops.json')
  const root = api.repoRoot || ROOT
  const day = () => (bot.time && bot.time.day) || 0

  let cached = null, cachedAt = 0, lastLogged = null, since = now()
  const byDay = new Map()
  function commit() {
    const t = now()
    if (cached === null || t - cachedAt > COMMIT_TTL_MS) {
      cachedAt = t
      const c = (api.readCommit || readCommit)(root)
      if (c) cached = c
      else if (cached === null) cached = 'unknown'
      if (cached && cached !== lastLogged) {
        lastLogged = cached
        append(commitsFile, { t, day: day(), commit: cached, subject: (api.readSubject || readSubject)(root) })
      }
    }
    const d = day(), set = byDay.get(d) || new Set(); set.add(cached); byDay.set(d, set)
    if (byDay.size > 40) byDay.delete(byDay.keys().next().value)
    return cached
  }
  const dayCommits = (d) => { commit(); return [...(byDay.get(d === undefined ? day() : d) || [])] }

  function append(file, obj) {
    try {
      try { if (fs.statSync(file).size > ROTATE_BYTES) fs.renameSync(file, file + '.1') } catch { /* no file yet */ }
      fs.appendFileSync(file, JSON.stringify(obj) + '\n')
    } catch { /* a log is a nicety */ }
  }

  const loops = createLoopTracker()
  let saveSoon = null
  function writeLoops() { saveSoon = null; try { fs.writeFileSync(loopsFile, JSON.stringify({ since, savedAt: now(), commit: cached, pairs: loops.pairs }, null, 1)) } catch {} }

  let prevStep = null, hooked = false, hookTimer = null, commitTimer = null, stepValue = null
  function onStep(step) {
    const t = now(), e = bot.entity, p = e && e.position
    if (!step || step === prevStep) return
    const row = { t, day: day(), step, prev: prevStep, x: p ? Math.floor(p.x) : null, y: p ? +p.y.toFixed(1) : null, z: p ? Math.floor(p.z) : null, hp: bot.health, held: bot.heldItem ? bot.heldItem.name : '' }
    prevStep = step
    append(stepsFile, row)
    const loop = loops.note(step, t, row.y)
    if (loop) {
      if (api.log) api.log('runlog', `step ping-pong ${loop.a} <-> ${loop.b} at y ${loop.ys.join(', ')}`)
      if (!saveSoon) { saveSoon = setTimeout(writeLoops, 2000); if (saveSoon.unref) saveSoon.unref() }
    }
  }
  // G.lastStep is assigned all over goals.js: observe the property instead of editing every site
  function hook() {
    const G = bot._ap && bot._ap.G
    if (!G || hooked) return
    const desc = Object.getOwnPropertyDescriptor(G, 'lastStep')
    if (desc && !desc.configurable) return
    stepValue = G.lastStep
    Object.defineProperty(G, 'lastStep', { configurable: true, enumerable: true, get: () => stepValue, set: (v) => { stepValue = v; try { onStep(v) } catch { /* observer */ } } })
    hooked = true; hookedG = G
    if (stepValue) onStep(stepValue)
  }
  let hookedG = null

  bot._runInfo = { v: 1, commit, dayCommits }
  return {
    name: 'runlog',
    start() {
      commit()
      hook(); hookTimer = setInterval(() => { try { hook() } catch {} }, 5000)
      commitTimer = setInterval(() => { try { commit() } catch {} }, COMMIT_TTL_MS + 1000)           // so every in-game day has the commit(s) it ran, even when nobody asks
      for (const t of [hookTimer, commitTimer]) if (t.unref) t.unref()
    },
    stop() {
      clearInterval(hookTimer); clearInterval(commitTimer)
      if (hookedG) { try { Object.defineProperty(hookedG, 'lastStep', { configurable: true, enumerable: true, writable: true, value: stepValue }) } catch {} hookedG = null; hooked = false }
      if (saveSoon) { clearTimeout(saveSoon); writeLoops() }
      if (bot._runInfo && bot._runInfo.v === 1) delete bot._runInfo
    },
    status() { return { commit: cached, steps: prevStep, loops: Object.fromEntries(Object.entries(loops.pairs).map(([k, v]) => [k, v.count])) } },
    _tick: { onStep, hook, commit, loops }
  }
}
module.exports.meta = require('./meta.json')
module.exports.createLoopTracker = createLoopTracker
module.exports.readCommit = readCommit
