// The bot profile: who this bot is and how it plays, in one place (P3 of the architecture taxonomy).
//
//   <state dir>/profile.json   (seeded from bots/<bot>/profile.json by scripts/start-bot.js, written by the stance switch)
//   { version, name, role, stance, planner: { enabled }, steps, disabledModules, persona, router: { mode }, director: { mode } }
//
//   name             in-game name; falls back to bot.username
//   role             'hillclimber' (broad autonomy, the full step list) | 'assistant' (fixed routine: base upkeep and chat requests)
//   stance           'task' (chat tasks + routines, the autopilot is gated off) | 'autonomous' (the autopilot plays its own goals)
//   planner.enabled  false = no model planner layer (what the think-off file did)
//   planner.brief    true/false = the dawn brief on or off for this bot (brain/memory); unset = on for a hillclimber, off for an assistant
//   steps            the assistant's allowed routine step ids (null = built-in list)
//   disabledModules  brain modules not to load (what disabled-modules.json did)
//   persona          optional override of the planner's one-line self description
//   router.mode / director.mode   defaults for the chat decision router and the pilot director (their own saved switches still win)
//
// Each field falls back to the file it replaced, so a bot folder with no profile.json behaves exactly as before:
//   stance <- mode.json        role, steps <- role.json        planner.enabled <- not(think-off exists)        disabledModules <- disabled-modules.json
// Precedence per field: profile.json > the old file > built-in default. Env: BRAIN_DISABLE adds modules; BOT_MODE is applied by brain/mode as the start stance only.
// get() reports where every field came from (source), for the dashboard. Pure fs, no bot needed: the dashboard process loads this too.
const fs = require('fs')
const path = require('path')

const ROLES = ['hillclimber', 'assistant']
const STANCES = ['task', 'autonomous']
const DEFAULT_ROLE = 'hillclimber'
const DEFAULT_STANCE = 'task'          // what brain/mode always started in when nothing was saved

const readJson = (f) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')) } catch { return null } }

// The planner's one-line self description. The hillclimber line is the text think.js always used, with the bot's name filled in.
function persona({ name = 'the bot', role = DEFAULT_ROLE, owner = 'Walter', override = null } = {}) {
  if (override) return String(override)
  if (role === 'assistant') {
    return `You are the mind of ${name}, a Minecraft survival player in ${owner}'s world whose job is to keep the base running: the farms, the storage, the lights and the requests ${owner} gives in chat. You live at the base and stay near it; you do not go exploring or deep mining on your own. Goal: stay alive, keep the base upkeep done, and be useful.`
  }
  return `You are the mind of ${name}, a Minecraft survival player who just spawned in a brand-new world (LAN, Java 1.21.6, Hard) with an empty bag and no base. Goal: survive as long as possible and progress.`
}

function createProfile({ stateDir, env = process.env, botName = null, now = Date.now } = {}) {
  const file = path.join(stateDir, 'profile.json')
  const legacy = (f) => path.join(stateDir, f)
  let cache = null, cacheAt = 0, cacheKey = ''

  function compute() {
    const p = readJson(file)
    const has = !!p
    const pf = p || {}
    const src = {}
    const pick = (field, fromProfile, fromLegacy, dflt, legacyName) => {
      if (fromProfile !== undefined && fromProfile !== null) { src[field] = 'profile.json'; return fromProfile }
      if (fromLegacy !== undefined && fromLegacy !== null) { src[field] = legacyName; return fromLegacy }
      src[field] = 'default'; return dflt
    }
    const roleJ = readJson(legacy('role.json')) || {}
    const modeJ = readJson(legacy('mode.json')) || {}
    const dis = readJson(legacy('disabled-modules.json'))

    const role = pick('role', ROLES.includes(pf.role) ? pf.role : null, roleJ.role, DEFAULT_ROLE, 'role.json')
    const steps = pick('steps', Array.isArray(pf.steps) ? pf.steps : null, Array.isArray(roleJ.steps) ? roleJ.steps : null, null, 'role.json')
    const stance = pick('stance', STANCES.includes(pf.stance) ? pf.stance : null, STANCES.includes(modeJ.mode) ? modeJ.mode : null, DEFAULT_STANCE, 'mode.json')
    const thinkOff = fs.existsSync(legacy('think-off'))
    const plannerEnabled = pick('planner', pf.planner && typeof pf.planner.enabled === 'boolean' ? pf.planner.enabled : null, thinkOff ? false : null, true, 'think-off')
    let disabledModules = pick('disabledModules', Array.isArray(pf.disabledModules) ? pf.disabledModules : null, Array.isArray(dis) ? dis : null, [], 'disabled-modules.json')
    const envOff = String(env.BRAIN_DISABLE || '').split(',').map(x => x.trim()).filter(Boolean)
    if (envOff.length) { disabledModules = [...new Set([...disabledModules, ...envOff])]; src.disabledModules += ' + env BRAIN_DISABLE' }
    const name = pf.name || botName || null; src.name = pf.name ? 'profile.json' : (botName ? 'bot.username' : 'default')
    return {
      name, role, stance, steps, disabledModules,
      planner: { enabled: plannerEnabled, brief: pf.planner && typeof pf.planner.brief === 'boolean' ? pf.planner.brief : null },      // brief: the dawn brief (brain/memory); null = on for a hillclimber, off for an assistant
      persona: pf.persona || null,
      router: { mode: pf.router && pf.router.mode || null },
      director: { mode: pf.director && pf.director.mode || null },
      hasFile: has, file, stanceSince: pf.stanceSince || modeJ.since || null, source: src
    }
  }

  // cached for 2 s and re-read when any of the files involved changes on disk
  function keyOf() {
    let k = ''
    for (const f of [file, legacy('role.json'), legacy('mode.json'), legacy('think-off'), legacy('disabled-modules.json')]) { try { const s = fs.statSync(f); k += s.mtimeMs + ':' + s.size + ';' } catch { k += '-;' } }
    return k
  }
  function get() {
    const t = Date.now()          // real clock: tests may fake `now`, the cache must still expire
    if (cache && t - cacheAt < 2000) return cache
    const k = keyOf()
    if (!cache || k !== cacheKey) { cache = compute(); cacheKey = k }
    cacheAt = t
    return cache
  }
  const invalidate = () => { cache = null }

  // Writes go to profile.json when it exists, otherwise to the legacy file the field came from (so a bot folder without a profile keeps its old files).
  function setStance(stance, why) {
    if (!STANCES.includes(stance)) return false
    const since = now()
    const p = readJson(file)
    try {
      if (p) fs.writeFileSync(file, JSON.stringify({ ...p, stance, stanceSince: since, stanceWhy: why || undefined }, null, 2) + '\n')
      else fs.writeFileSync(legacy('mode.json'), JSON.stringify({ mode: stance, since, why }))
    } catch { return false }
    invalidate()
    return true
  }
  const owner = () => 'Walter'
  function personaText() {
    const g = get()
    return persona({ name: g.name || botName || 'the bot', role: g.role, owner: owner(), override: g.persona })
  }
  return { get, setStance, invalidate, persona: personaText, file }
}

module.exports = { createProfile, persona, ROLES, STANCES, DEFAULT_ROLE, DEFAULT_STANCE }
