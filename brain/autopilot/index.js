// brain/autopilot: the bot plays the fresh world on its own (wood -> tools -> stone -> food -> coal -> iron -> ...). See README.md.
// Hot reload: write `ap.reload()` into brain/state/ap-cmd.js (the eval channel) and the skills/goals files are re-read without a restart.
const fs = require('fs')
const path = require('path')
const util = require('util')
const { Vec3 } = require('vec3')

const FILES = ['hallway.js', 'skills.js', 'mining.js', 'goals.js', 'plan.js', 'memory.js', 'think.js', 'watchdog.js']

function register(api) {
  const { bot, scheduler, PRIORITY } = api
  const log = (tag, msg) => api.log('autopilot', `${tag} ${msg}`)
  const ap = { enabled: true, S: null, M: null, G: null, api, bot, lastError: null, started: Date.now() }
  let taskKey = 'autopilot', timers = [], disposers = []

  function build() {
    for (const f of FILES) { const p = path.join(__dirname, f); if (fs.existsSync(p)) delete require.cache[require.resolve(p)] }
    if (ap.G && ap.G.dispose) ap.G.dispose()
    const makeSkills = require('./skills'), makeMining = require('./mining'), makeGoals = require('./goals')
    const S = makeSkills({ bot, api, log: (t, m) => log(t, m) })
    S.ctx = ap.S ? ap.S.ctx : null
    const M = makeMining(S, api, (t, m) => log(t, m))
    const G = makeGoals(S, M, api, (t, m) => log(t, m))
    let plan = null
    try { plan = require('./plan') } catch (e) { if (e.code !== 'MODULE_NOT_FOUND') log('PLAN_LOAD_ERR', e.message) }
    G.ap = ap
    if (plan) plan(G, S, M, api, (t, m) => log(t, m))
    // the mind: a model plans every step from what it sees and remembers (think.js); G.step falls back to the routine steps above only when it cannot
    // brain/state/think-off: skip the model planner layer (no model credit; its per-step observation work only costs time). Claude drives from outside instead.
    if (fs.existsSync(api.statePath('think-off'))) ap.thinkOff = true
    if (!ap.thinkOff) { try { require('./think')(G, S, M, api, (t, m) => log(t, m)) } catch (e) { log('THINK_LOAD_ERR', e.stack || e.message) } }
    ap.S = S; ap.M = M; ap.G = G
    if (ap.W && ap.reloadWatchdog) { try { ap.W.dispose() } catch {} ap.W = null; ap.reloadWatchdog = false }
    if (!ap.W) { try { ap.W = require('./watchdog')(ap, api, (t, m) => log(t, m)) } catch (e) { log('WD_LOAD_ERR', e.message) } }
  }
  bot._ap = ap
  ap.reload = () => { build(); return 'reloaded' }
  build()

  async function run(ctx) {
    ap.S.ctx = ctx
    try {
      while (ap.enabled) {
        ctx.checkpoint()
        try { await ap.G.step() } catch (e) {
          if (e && e.name === 'AbortError') throw e
          ap.lastError = e && (e.stack || e.message); log('LOOP_ERR', ap.lastError)
          await ctx.sleep(3000)
        }
        ap.S.ctx = ctx
        await ctx.sleep(150)
      }
    } finally {
      try { ap.S.stopMoving() } catch {}
    }
  }

  function ensureTask() {
    if (ap.keepTaskOff) return
    if (!ap.enabled) return
    try {
      const s = scheduler.status()
      const has = (s.running && s.running.key === taskKey) || (s.running && s.running.name === 'autopilot') ||
        (s.queue || []).some(t => t.name === 'autopilot' || t.key === taskKey) || (s.parked || []).some(t => t.name === 'autopilot' || t.key === taskKey)
      if (has) return
      scheduler.submit({ name: 'autopilot', key: taskKey, priority: 45, onUserStop: 'park', run, abort: () => { try { ap.S.stopMoving() } catch {} } })
    } catch (e) { log('SUBMIT_ERR', e.message) }
  }

  // ---------- eval channel for development: brain/state/ap-cmd.js -> brain/state/ap-out.txt ----------
  ap.ensureTask = ensureTask
  const cmdFile = api.statePath('ap-cmd.js'), outFile = api.statePath('ap-out.txt')
  let evalBusy = false
  const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor
  async function pollEval() {
    if (evalBusy) return
    let code = ''
    try { code = fs.readFileSync(cmdFile, 'utf8') } catch { return }
    if (!code.trim()) return
    evalBusy = true
    try { fs.writeFileSync(cmdFile, '') } catch {}
    let out
    try {
      const fn = new AsyncFunction('bot', 'ap', 'S', 'M', 'G', 'Vec3', 'api', 'require', code)
      const r = await fn(bot, ap, ap.S, ap.M, ap.G, Vec3, api, require)
      out = util.inspect(r, { depth: 3, maxArrayLength: 60, breakLength: 140 })
    } catch (e) { out = 'ERROR ' + (e && e.stack || e) }
    try { fs.writeFileSync(outFile, String(out).slice(0, 30000)) } catch {}
    evalBusy = false
  }
  timers.push(setInterval(pollEval, 600))

  // ---------- chat ----------
  api.commands.add({ name: 'autopilot', help: 'autopilot on|off|status', match: /\bauto-?pilot\b/, run(user, text) {
    const t = String(text).toLowerCase()
    if (/\b(off|stop|disable|pause)\b/.test(t)) { ap.enabled = false; scheduler.cancel && scheduler.cancel(taskKey); api.say('Autopilot off. Say "autopilot on" and I will go back to playing on my own.'); return }
    if (/\b(on|start|enable|resume)\b/.test(t)) { ap.enabled = true; ensureTask(); api.say('Autopilot on.'); return }
    const G = ap.G
    api.say(`Autopilot ${ap.enabled ? 'on' : 'off'}; doing: ${G.lastStep || 'nothing yet'}. Bag: ${ap.S.logs()} logs, ${ap.S.count(/^(cobblestone|cobbled_deepslate)$/)} cobble.`.slice(0, 200))
  } })

  return {
    name: 'autopilot',
    start() { ensureTask(); timers.push(setInterval(ensureTask, 5000)) },
    stop() { ap.enabled = false; for (const t of timers) clearInterval(t); timers = []; try { ap.W && ap.W.dispose() } catch {} try { ap.G && ap.G.dispose && ap.G.dispose() } catch {} try { api.scheduler.cancel(taskKey, 'reload') } catch {} },
    status() { return { enabled: ap.enabled, step: ap.G && ap.G.lastStep, lastError: ap.lastError && String(ap.lastError).slice(0, 200), log: ap.G && ap.G.log.slice(-8), stats: ap.S && ap.S.stats } },
    ap,
  }
}
module.exports = register
module.exports.meta = { name: 'autopilot', version: 1 }
