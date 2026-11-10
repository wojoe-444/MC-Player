// brain/husbandry: fenced, lit animal pens (lure with food, breed, shear, cull for winter food) and a glow lichen light farm. ROADMAP Phase 2 items 9 and 11.
// Commands, one scheduler task per job and two idle routines that only visit pens/farms that already exist. See README.md and brain/INTERFACE.md.
const stateStore = require('./state')
const createEngine = require('./engine')
const baseConfig = require('./config.json')

const NEG = /^(?:please )?(?:don'?t|do not|never|no need to|no more|stop|cancel|quit)\b/
const QUESTION = /^(?:how|what|where|why|when|which|who|do you|did you|are you|is there|is it)\b/
const PEN = '(?:animal ?pens?|pens?|paddocks?|corrals?|enclosures?|animal ?farm|livestock)'
const P = {
  STOP: /^(?:stop|cancel|quit|enough)\b.*\b(?:pens?|animals?|herd|livestock|lichen)\b/,
  BUILD: new RegExp(`\\b(?:build|make|set up|start|put up|fence)\\b.*\\b${PEN}\\b`),
  TEND: /\b(?:tend|look after|work|check on|feed|breed|cull|shear|thin out)\b.*\b(?:pens?|animals?|livestock|herd|sheep|cows?|pigs?|chickens?)\b|\b(?:pens?|herd) (?:run|upkeep|round)\b/,
  STATUS: /\b(?:pens?|animals|livestock|herd|lichen)\b.*\b(?:status|report|progress|how many)\b|\bhow (?:are|is) the (?:animals|pens?|herd|sheep|cows|lichen)\b|\bhow many (?:animals|cows|sheep|pigs|chickens)\b/,
  LICHEN: /\b(?:glow ?lichen|lichen)\b.*\b(?:farm|tend|grow|harvest|start|build|make)\b|\b(?:start|build|make|tend|grow|harvest)\b.*\blichen\b/,
  SEASON: /\b(?:it(?:'s| is)|season is|now)\s+(winter|summer|spring|autumn|fall)\b/,
  ROUTINE_ON: /\b(?:pen|animal|herd|lichen) routine\b.*\b(?:on|start|enable)\b|\b(?:start|enable|turn on)\b.*\b(?:pen|animal|herd|lichen) routine\b/,
  ROUTINE_OFF: /\b(?:pen|animal|herd|lichen) routine\b.*\b(?:off|stop|disable|pause)\b|\b(?:stop|disable|turn off|pause)\b.*\b(?:pen|animal|herd|lichen) routine\b/
}
const FILLER = /\b(hey|yo|claude|bot|ozogo444|please|pls|plz|can you|could you|would you|will you|can u|go ahead and|just|now|for me)\b/g
const norm = (text) => String(text).toLowerCase().replace(/[^\w\s',.-]/g, ' ').replace(FILLER, ' ').replace(/\s+/g, ' ').trim()

function register(api) {
  const { bot, scheduler, say, PRIORITY } = api
  const log = (m) => api.log('husbandry', m)
  const config = baseConfig

  const file = api.statePath('husbandry-state.json')
  const state = stateStore.load({ file, log })
  const save = () => stateStore.save(file, state, api.now, log)

  // crafting goes through the autopilot's recursive crafter when it is loaded (planks, sticks, fences, gate, torches)
  // (under THIS task's context: S.craft checks the autopilot's own, which this task has preempted, so a bare S.craft aborted at once and returned false)
  let taskCtx = null
  const craft = async (item, n) => { const S = bot._ap && bot._ap.S; if (S && S.craft) return taskCtx && S.withCtx ? S.withCtx(taskCtx, () => S.craft(item, n)) : S.craft(item, n); return false }
  const foodPoints = () => { const S = bot._ap && bot._ap.S; return S && S.foodPoints ? S.foodPoints() : null }

  const engine = createEngine({
    bot, say, goals: api.goals, tryGoto: api.tryGoto, safehand: api.safehand, stopNav: api.stopNav, gotoNear: api.gotoNear,
    canSee: api.canSee, ensureLineOfSight: api.ensureLineOfSight, craft,
    foodPoints: () => { const f = foodPoints(); return f == null ? 999 : f },
    config, state, save, now: api.now, log
  })

  const task = (name, fn, said) => scheduler.submit({
    name, key: name, replace: true, priority: PRIORITY.CHAT, onUserStop: 'cancel',
    abort: () => engine.abort(),
    run: async (ctx) => { taskCtx = ctx; try { const r = await fn(ctx); say(said(r)); return r } finally { taskCtx = null } }
  })
  const sayBuild = (r) => !r.ok ? `Pen: ${r.why}`.slice(0, 200) : (r.done ? `Pen ${r.pen} is standing and lit (${r.total} pieces).` : `Pen ${r.pen}: ${r.placed} placed, ${r.left} still to do${r.blocked ? ', ' + r.blocked + ' blocked' : ''}.`)
  const sayTend = (r) => {
    if (!r.ok) return `Pens: ${r.why}`.slice(0, 200)
    const bits = []
    for (const o of r.pens) {
      const n = (m) => Object.entries(m || {}).filter(([, v]) => v).map(([k, v]) => `${v} ${k}`).join(', ')
      if (n(o.lured)) bits.push('lured ' + n(o.lured)); if (n(o.bred)) bits.push('bred ' + n(o.bred)); if (n(o.culled)) bits.push('culled ' + n(o.culled)); if (o.sheared) bits.push('sheared ' + o.sheared)
    }
    return `Pens tended${bits.length ? ': ' + bits.join('; ') : ', nothing needed doing'}.`.slice(0, 200)
  }
  const sayLichen = (r) => !r.ok ? `Lichen: ${r.why}`.slice(0, 200) : `Lichen tended: ${r.sites.map(s => `${s.seeded ? 'seeded, ' : ''}+${s.grown} faces${s.harvested ? ', cut ' + s.harvested : ''}${s.missing ? ', need ' + Object.keys(s.missing).join(', ') : ''}`).join('; ')}.`.slice(0, 200)

  // ---------- routines: only visit what already exists ----------
  scheduler.routine({
    name: 'husbandry', priority: PRIORITY.FARM, idleOnly: true, defaultEnabled: true, intervalMs: 60000,
    due: () => engine.dueTend(),
    make: () => ({ name: 'husbandry', abort: () => engine.abort(), run: async (ctx) => { log('idle pen run'); taskCtx = ctx; try { return await engine.runTend(ctx) } finally { taskCtx = null } } })
  })
  scheduler.routine({
    name: 'lichen', priority: PRIORITY.FARM, idleOnly: true, defaultEnabled: true, intervalMs: 60000,
    due: () => engine.dueLichen(),
    make: () => ({ name: 'lichen', abort: () => engine.abort(), run: async (ctx) => { log('idle lichen run'); taskCtx = ctx; try { return await engine.runLichen(ctx) } finally { taskCtx = null } } })
  })

  // ---------- chat ----------
  const statusLine = () => {
    const s = engine.snapshot()
    const pens = s.pens.length ? s.pens.map(p => `${p.id} ${p.built ? 'built' : 'not built'}${p.lit ? ', lit' : ''}${p.counts ? ' (' + Object.entries(p.counts).filter(([, c]) => c.adults + c.babies).map(([k, c]) => `${c.adults}${c.babies ? '+' + c.babies : ''} ${k}`).join(', ') + ')' : ''}`).join('; ') : 'no pen yet (say "build an animal pen")'
    const l = s.lichen.length ? `${s.lichen.length} lichen wall(s)${s.lichen[0].last ? `, ${s.lichen[0].last.faces} faces` : ''}` : 'no lichen farm'
    return `Pens: ${pens}. ${l}. Season: ${s.winter ? 'winter' : 'not winter'}. Totals: ${s.stats.bred} bred, ${s.stats.culled} culled, ${s.stats.sheared} sheared.`.slice(0, 235)
  }
  const commands = [
    { name: 'pens-stop', help: 'stop the pen work', risk: 'low', allowNeg: true, match: P.STOP, run() { scheduler.cancel('husbandry', 'user-stop'); scheduler.cancel('lichen', 'user-stop'); say('OK, stopped the pen work.') } },
    { name: 'pens-routine-on', help: 'pen routine on', risk: 'high', allowNeg: true, match: P.ROUTINE_ON, run() { scheduler.setEnabled('husbandry', true); scheduler.setEnabled('lichen', true); say('Pen and lichen routines on: when idle in daylight I tend the pens I have built.') } },
    { name: 'pens-routine-off', help: 'pen routine off', risk: 'low', allowNeg: true, match: P.ROUTINE_OFF, run() { scheduler.setEnabled('husbandry', false); scheduler.setEnabled('lichen', false); scheduler.cancel('husbandry', 'routine-off'); say('Pen and lichen routines off.') } },
    { name: 'pens-status', help: 'pen status | how are the animals', risk: 'low', allowNeg: true, match: P.STATUS, run() { say(statusLine()) } },
    { name: 'season', help: 'it is winter', risk: 'low', match: P.SEASON, run(user, text, t) { const m = P.SEASON.exec(t); state.winter = m[1] === 'winter'; save(); say(state.winter ? 'Noted: winter. I will keep the herds bigger and cull less.' : `Noted: ${m[1]}, not winter.`) } },
    { name: 'lichen-farm', help: 'start a glow lichen farm | tend the lichen', risk: 'high', match: P.LICHEN, run() { task('lichen', (ctx) => engine.runLichen(ctx), sayLichen) } },
    { name: 'pen-build', help: 'build an animal pen', risk: 'high', match: P.BUILD, run(user, text, t) { const another = /\b(?:another|second|new|more|extra)\b/.test(t); task('husbandry', (ctx) => engine.runBuild(ctx, { another }), sayBuild) } },
    { name: 'pens-tend', help: 'tend the pens | breed the animals | shear the sheep', risk: 'high', match: P.TEND, run() { task('husbandry', (ctx) => engine.runTend(ctx), sayTend) } }
  ]
  for (const c of commands) { try { api.commands.add({ ...c, match: (u, t) => !(!c.allowNeg && (NEG.test(t) || QUESTION.test(t))) && c.match.test(t) }) } catch (e) { log(`command ${c.name} not added: ${e.message}`) } }

  function onChat(user, text) {
    const t = norm(text)
    for (const c of commands) {
      if (!c.allowNeg && (NEG.test(t) || QUESTION.test(t))) continue
      let hit = false
      try { hit = c.match.test(t) } catch { /* bad pattern: skip */ }
      if (!hit) continue
      try { c.run(user, text, t) } catch (e) { log(`command ${c.name}: ${e.message}`); say(`That failed: ${e.message}`.slice(0, 150)) }
      return true
    }
    return false
  }

  const handle = {
    name: 'husbandry',
    provides: ['husbandry'],
    start() { /* the routines are registered with the scheduler */ },
    stop() { engine.abort(); if (bot._husbandry === handle) delete bot._husbandry },
    status: () => engine.snapshot(),
    onChat, engine, state
  }
  bot._husbandry = handle                                       // the think-first autopilot calls the engine through this (brain/autopilot/think.js action 'pens')
  return handle
}
register.meta = require('./meta.json')

module.exports = register
module.exports.meta = register.meta
module.exports.phrases = P
