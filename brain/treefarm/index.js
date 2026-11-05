// brain/treefarm: chop trees (tall ones too), replant, collect drops, put logs and saplings away. See README.md and brain/INTERFACE.md.
// A command ("chop trees") and an idle routine ('treefarm', on by default) that only works known tree farm sites.
const fs = require('fs')
const path = require('path')
const stateStore = require('./state')
const createEngine = require('./engine')
const baseConfig = require('./config.json')

const NEG = /^(?:please )?(?:don'?t|do not|never|no need to|no more|stop|cancel|quit)\b/
const QUESTION = /^(?:how|what|where|why|when|which|who|do you|did you|are you|is there|is it)\b/
const WOOD = '(?:trees?|wood|logs?|lumber|timber)'
const P = {
  STOP: /^(?:stop|cancel|quit|enough)\b.*\b(?:chopping|trees?|lumber|woodcutting|logging)\b/,
  ROUTINE_ON: /\b(?:tree|wood|lumber)(?: ?farm)? ?(?:routine|duty|upkeep|farming)\b.*\b(?:on|start|enable)\b|\b(?:start|enable|turn on)\b.*\b(?:tree|wood|lumber)(?: ?farm)? ?(?:routine|duty|upkeep|farming)\b/,
  ROUTINE_OFF: /\b(?:tree|wood|lumber)(?: ?farm)? ?(?:routine|duty|upkeep|farming)\b.*\b(?:off|stop|disable|pause)\b|\b(?:stop|disable|turn off|pause)\b.*\b(?:tree|wood|lumber)(?: ?farm)? ?(?:routine|duty|upkeep|farming)\b/,
  STATUS: /\b(?:tree|wood|lumber)(?: ?farm)?\b.*\b(?:status|report|progress)\b|\bhow (?:is|are) the (?:trees?|tree ?farm|grove|woodcutting|wood)\b/,
  HERE: /\btree ?farm here\b|\b(?:this|here) is (?:a |the |my )?(?:tree ?farm|grove)\b|\bmark (?:this|here)\b.*\b(?:tree ?farm|grove)\b/,
  FORGET: /\b(?:forget|remove|clear|unmark)\b.*\b(?:tree ?farms?|groves?)\b/,
  GROVE: /\bplant\b.*\b(?:grove|forest|saplings?|trees?)\b|\b(?:start|make|grow|begin)\b.*\b(?:a |the )?(?:grove|forest|tree ?farm)\b/,
  CHOP: new RegExp(`\\b(?:chop|cut|fell|cut down|harvest|farm|gather|collect|fetch|get|bring)\\b.*\\b${WOOD}\\b|\\b(?:wood ?cutting|lumber ?jack)\\b`)
}
const FILLER = /\b(hey|yo|claude|bot|ozogo444|please|pls|plz|can you|could you|would you|will you|can u|go ahead and|just|now|for me)\b/g
const norm = (text) => String(text).toLowerCase().replace(/[^\w\s',.-]/g, ' ').replace(FILLER, ' ').replace(/\s+/g, ' ').trim()

// "chop 5 trees" -> { count: 5 }, "get 40 logs" -> { wantLogs: 40, count: 12 }
function parseAmount(t) {
  const trees = /\b(\d+)\s*(?:more\s+)?trees?\b/.exec(t), logs = /\b(\d+)\s*(?:more\s+)?(?:logs?|wood|lumber)\b/.exec(t)
  if (trees) return { count: Math.min(30, Math.max(1, +trees[1])) }
  if (logs) return { wantLogs: Math.min(512, Math.max(1, +logs[1])), count: 12 }
  return {}
}

function register(api) {
  const { scheduler, say, PRIORITY } = api
  const log = (m) => api.log('treefarm', m)
  const config = baseConfig

  const file = api.statePath('treefarm-state.json')
  const state = stateStore.load({ file, log })
  const save = () => stateStore.save(file, state, api.now, log)

  const waypoints = () => { try { return JSON.parse(fs.readFileSync(path.join(api.dir, 'waypoints.json'), 'utf8').replace(/^﻿/, '')) } catch { return {} } }
  // sites: configured ones, the ones Walter marked ("tree farm here", a planted grove) and every waypoint named like a tree farm
  function sitesFn() {
    const re = new RegExp(config.sitePattern, 'i'), by = new Map()
    for (const s of config.sites || []) by.set(s.name, s)
    for (const s of state.sites) by.set(`${s.name}@${s.x},${s.z}`, s)
    for (const [name, w] of Object.entries(waypoints())) {
      if (re.test(name) && w && Number.isFinite(w.x) && Number.isFinite(w.z)) by.set(name, { name, x: w.x, y: Number.isFinite(w.y) ? w.y : 64, z: w.z })
    }
    return [...by.values()]
  }

  const engine = createEngine({
    bot: api.bot, say, goals: api.goals, tryGoto: api.tryGoto, safehand: api.safehand, stopNav: api.stopNav, gotoNear: api.gotoNear,
    canSee: api.canSee, ensureLineOfSight: api.ensureLineOfSight, depositSmeltables: api.depositSmeltables,
    requestChest: () => !!(api.commands && api.commands.dispatch && api.commands.dispatch(api.ownerName, 'make a chest')),      // the crafting module makes it (own scheduler task)
    config, state, save, sitesFn, now: api.now, log
  })

  // ---------- tasks ----------
  const manualTask = (opts) => scheduler.submit({
    name: 'treefarm', key: 'treefarm', replace: true, priority: PRIORITY.CHAT, onUserStop: 'cancel',
    abort: () => engine.abort(), run: (ctx) => engine.run(ctx, { manual: true, ...opts })
  })
  const groveTask = () => scheduler.submit({
    name: 'treefarm', key: 'treefarm', replace: true, priority: PRIORITY.CHAT, onUserStop: 'cancel',
    abort: () => engine.abort(), run: (ctx) => engine.plantGrove(ctx)
  })
  // Idle routine: on by default (Walter wants it in the rotation), only after quiet time, and it only works the tree farm sites.
  scheduler.routine({
    name: 'treefarm', priority: PRIORITY.FARM, idleOnly: true, defaultEnabled: true, intervalMs: 60000,
    due: () => engine.due(),
    make: () => { const followUp = engine.dueKind() === 'followup'; return { name: 'treefarm', abort: () => engine.abort(), run: (ctx) => { log(followUp ? 'idle tree follow-up' : 'idle tree run'); return engine.run(ctx, { manual: false, followUp }) } } }
  })

  // ---------- chat ----------
  const statusLine = () => {
    const s = engine.snapshot()
    const age = s.lastRunAgoS === null ? 'no run yet' : `last run ${Math.round(s.lastRunAgoS / 60)} min ago`
    const r = s.lastResult
    const res = r ? ` Last: ${r.trees} tree(s), ${r.logs} logs, ${r.planted} planted.` : ''
    return `Tree routine is ${scheduler.isEnabled('treefarm') ? 'ON' : 'OFF (say "tree routine on")'}, ${age}.${res} On me: ${s.logsInBag} logs, ${s.saplingsInBag} saplings. ${s.pendingReplants ? s.pendingReplants + ' spot(s) waiting for a sapling. ' : ''}Tree farms: ${s.sites.join(', ') || 'none known (say "tree farm here" or "plant a grove")'}.`.slice(0, 235)
  }
  const commands = [
    { name: 'tree-stop', help: 'stop chopping', risk: 'low', allowNeg: true, match: P.STOP, run() { scheduler.cancel('treefarm', 'user-stop'); say('OK, stopped chopping.') } },
    { name: 'tree-routine-on', help: 'tree routine on', risk: 'high', allowNeg: true, match: P.ROUTINE_ON, run() { scheduler.setEnabled('treefarm', true); say('Tree routine on: when I am idle in daytime I chop the grown trees at the tree farm, replant, and put the wood away.') } },
    { name: 'tree-routine-off', help: 'tree routine off', risk: 'low', allowNeg: true, match: P.ROUTINE_OFF, run() { scheduler.setEnabled('treefarm', false); scheduler.cancel('treefarm', 'routine-off'); say('Tree routine off.') } },
    { name: 'tree-status', help: 'tree status | how is the tree farm', risk: 'low', allowNeg: true, match: P.STATUS, run() { say(statusLine()) } },
    { name: 'tree-farm-here', help: 'tree farm here', risk: 'high', match: P.HERE, run() { const p = engine.markSite(); say(`OK, ${p.x}, ${p.y}, ${p.z} is a tree farm now. I will chop the grown trees around it.`) } },
    { name: 'tree-farm-forget', help: 'forget tree farm', risk: 'low', match: P.FORGET, run() { const n = engine.forgetSites(); say(n ? 'Forgot the tree farm sites I had saved (waypoints stay).' : 'I had no saved tree farm sites.') } },
    { name: 'plant-grove', help: 'plant a grove', risk: 'high', match: P.GROVE, run() { groveTask() } },
    { name: 'chop-trees', help: 'chop trees | cut down trees | get wood', risk: 'high', match: P.CHOP,
      run(user, text, t) { manualTask(parseAmount(t || norm(text))) } }
  ]
  for (const c of commands) { try { api.commands.add({ ...c, match: (u, t) => !(!c.allowNeg && (NEG.test(t) || QUESTION.test(t))) && c.match.test(t) }) } catch (e) { log(`command ${c.name} not added: ${e.message}`) } }

  // Runs before the brain commands of the same wording ("farm" / "get" phrases of the routines and crafting modules).
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

  return {
    name: 'treefarm',
    provides: ['treefarm'],
    start() { /* nothing to start: the routine is registered with the scheduler */ },
    stop() { engine.abort() },
    status: () => engine.snapshot(),
    onChat, engine, state, sitesFn
  }
}
register.meta = { name: 'treefarm', version: 1 }

module.exports = register
module.exports.meta = register.meta
module.exports.phrases = P
module.exports.parseAmount = parseAmount
