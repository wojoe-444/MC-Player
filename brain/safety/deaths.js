// After every death: a short post-mortem appended to brain/state/lessons.md (the shared lessons file the pilot also writes) and a small self-adjustment
// stored in safety-tuning.json (loadout requirements and a few fight thresholds). Walter: "deaths are an indication that you need to get better at gameplay".
//
//   const d = makeDeaths({ bot, now, lessonsFile, tuningFile, log })
//   d.sample(ctx)        call about once a second with what the bot is doing (health trail, nearby mobs, loadout, light)
//   d.start()/stop()     listens to 'messagestr' (death message), 'death' (writes the post-mortem), 'spawn' (one chat line afterwards)
//   d.tuning()           { req: { torches, filler, food, armor, sword }, archerHealthPlus, noCreeperStrike, ... }
const fs = require('fs')

const DEATH_MSG = /\b(was (shot|slain|blown up|killed|burnt|fireballed|pummeled|pricked|squashed|impaled|skewered|stung|doomed|struck|obliterated|squished|shot off)|fell|drowned|burned|hit the ground|suffocated|starved|tried to swim|withered away|went up in flames|walked into|blew up|died|experienced kinetic|discovered the floor|was lit on fire|didn't want to live)\b/i
const MAX_REQ = { torches: 32, filler: 64, food: 24, armor: 4 }

function classify(msg) {
  const m = (msg || '').toLowerCase()
  const by = (/ (?:by|to|using) ([a-z_ ]+?)(?: using| whilst|\.|$)/.exec(m) || [])[1] || null
  if (/shot|skeleton|stray|pillager|arrow/.test(m)) return { cause: 'archers', by: by || 'skeleton' }
  if (/blown up|blew up|creeper|explo/.test(m)) return { cause: 'creeper', by: by || 'creeper' }
  if (/fell|hit the ground|high place|discovered the floor/.test(m)) return { cause: 'fall', by: null }
  if (/lava|burn|flames|fire/.test(m)) return { cause: 'fire/lava', by: null }
  if (/drown/.test(m)) return { cause: 'drowning', by: null }
  if (/suffocat/.test(m)) return { cause: 'suffocation', by: null }
  if (/starv/.test(m)) return { cause: 'starvation', by: null }
  if (/sonic|warden|shriek/.test(m)) return { cause: 'warden', by: 'warden' }
  if (/slain|killed|pummel|squish|stung|impaled/.test(m)) return { cause: 'melee', by: by || 'mob' }
  return { cause: 'other', by: by }
}

// Pure: turn the facts into lesson text and tuning changes. facts = { cause, by, pos, light, underground, loadout:{torches,filler,food,sword,pickaxe,armor,bow}, trail:[health..], doing, phase, archersNear }
function lessonsFor(f, tuning) {
  const say = [], adj = []
  const raise = (key, to) => { const cur = tuning.req[key] || 0; if (to > cur) { tuning.req[key] = Math.min(MAX_REQ[key] || to, to); adj.push(`${key} >= ${tuning.req[key]}`) } }
  const L = f.loadout || {}
  if (f.underground && (f.light == null || f.light <= 3) && (L.torches || 0) === 0) { say.push('I was in the dark with no torches: pack and place torches before and while going underground'); raise('torches', 16) }
  if ((L.filler || 0) < 12) { say.push('I had too little cobblestone to wall myself in: carry 32+'); raise('filler', 32) }
  if ((L.food || 0) < 4) { say.push('I had almost no food'); raise('food', 12) }
  if ((L.armor || 0) < 2 && ['archers', 'melee', 'creeper'].includes(f.cause)) { say.push('I wore little or no armor: wear armor before leaving the base'); raise('armor', 2) }
  if (!L.sword && ['archers', 'melee'].includes(f.cause)) { say.push('I had no sword: carry one and fight back'); raise('sword', 1) }
  if (f.cause === 'archers') {
    say.push((f.archersNear || 0) > 2 ? 'several archers at once: back off out of their line of sight instead of walking into them' : 'archers: close in zig-zagging and keep health above 10 before engaging')
    if ((f.archersNear || 0) > 2 && !tuning.maxArchers) { tuning.maxArchers = 1; adj.push('fight at most 1 archer at a time') }
    if (f.doing && /fight|shoot/.test(f.doing)) { tuning.archerHealthPlus = Math.min(6, (tuning.archerHealthPlus || 0) + 2); adj.push(`engage archers from ${10 + tuning.archerHealthPlus} health`) }
  }
  if (f.cause === 'creeper') {
    if (f.phase && f.phase !== 'idle') { tuning.noCreeperStrike = true; adj.push('no more sword hit-and-retreat on creepers'); say.push('I was blown up while hitting a creeper: only run from creepers, shoot them if I get a bow') }
    else { tuning.creeperRangePlus = Math.min(4, (tuning.creeperRangePlus || 0) + 1); adj.push(`flee creepers from ${7 + tuning.creeperRangePlus} blocks`); say.push('a creeper got too close: keep 8+ blocks away and listen for the hiss') }
  }
  if (f.cause === 'fall') { say.push('I fell: do not run on ledges or bridges, light the way, never step off an unlit edge'); raise('torches', 16) }
  if (f.cause === 'fire/lava') say.push('fire or lava: never walk toward lava, keep a water bucket on trips')
  if (f.cause === 'warden') say.push('warden: leave the deep dark (sculk) at once, never fight it')
  if (f.cause === 'melee' && f.trail && f.trail.length > 2 && f.trail.some(h => h <= 10)) { tuning.minFightHealthPlus = Math.min(3, (tuning.minFightHealthPlus || 0) + 1); adj.push(`retreat from ${8 + tuning.minFightHealthPlus} health`); say.push('I kept fighting while low: retreat earlier and eat') }
  if (!say.length) say.push('no clear cause found: check the health trail')
  return { say, adj }
}

const emptyTuning = () => ({ req: {}, deaths: [] })

function makeDeaths({ bot, now = Date.now, say = () => {}, lessonsFile = null, tuningFile = null, log = () => {} }) {
  let tuning = emptyTuning()
  try { if (tuningFile) tuning = { ...emptyTuning(), ...JSON.parse(fs.readFileSync(tuningFile, 'utf8')) } } catch { /* first run */ }
  tuning.req = tuning.req || {}; tuning.deaths = tuning.deaths || []
  const save = () => { if (tuningFile) try { fs.writeFileSync(tuningFile, JSON.stringify(tuning, null, 2)) } catch { /* ignore */ } }

  const samples = []          // about one per second, last 40
  let lastMsg = null, pendingLine = null, started = false
  function sample(ctx) {
    const t = now()
    if (samples.length && t - samples[samples.length - 1].t < 900) return
    samples.push({ t, ...ctx }); if (samples.length > 40) samples.shift()
  }
  const onMsg = (m) => {
    const text = typeof m === 'string' ? m : String(m)
    const name = (bot.username || '').toLowerCase()
    if (name && text.toLowerCase().includes(name) && DEATH_MSG.test(text)) lastMsg = { t: now(), text }
  }
  function onDeath() {
    const t = now()
    const last = samples[samples.length - 1] || {}
    const msg = lastMsg && t - lastMsg.t < 15000 ? lastMsg.text : null
    const { cause, by } = classify(msg || '')
    const recent = samples.filter(s => t - s.t <= 20000)
    const trail = recent.map(s => Math.round(s.health))
    const facts = {
      cause, by, msg, pos: last.pos, light: last.light, underground: !!last.underground, loadout: last.loadout, trail, doing: last.doing, phase: last.phase,
      archersNear: (last.mobs || []).filter(m => /skeleton|stray|pillager|bogged/.test(m.name)).length
    }
    const { say: lessons, adj } = lessonsFor(facts, tuning)
    const L = facts.loadout || {}
    const when = new Date(t).toISOString().slice(0, 16).replace('T', ' ')
    const p = facts.pos ? `${Math.round(facts.pos.x)},${Math.round(facts.pos.y)},${Math.round(facts.pos.z)}` : 'unknown'
    const line = `- ${when} [safety] DIED${msg ? ` (${msg.replace(/^<?[^ ]+> /, '')})` : ` (${cause})`} at ${p}${facts.underground ? ', underground' : ''}${facts.light != null ? `, light ${facts.light}` : ''}. ` +
      `Health trail ${trail.length ? trail.join('>') : 'unknown'}. Doing: ${facts.doing || 'unknown'}. ` +
      `Had: ${L.sword ? 'sword' : 'no sword'}, ${L.torches || 0} torches, ${L.filler || 0} filler blocks, ${L.food || 0} food, armor ${L.armor || 0}/4${L.bow ? ', bow' : ''}. ` +
      `Lessons: ${lessons.join('; ')}.${adj.length ? ` Adjusted: ${adj.join(', ')}.` : ''}\n`
    if (lessonsFile) try { fs.appendFileSync(lessonsFile, line) } catch (e) { log('lessons write failed: ' + e.message) }
    tuning.deaths.push({ at: new Date(t).toISOString(), cause, by, pos: p }); if (tuning.deaths.length > 30) tuning.deaths.shift()
    save()
    pendingLine = `I died (${cause}${by && cause !== 'fall' ? `: ${by}` : ''}). ${lessons[0]}.`
    samples.length = 0; lastMsg = null
    log('death: ' + line.trim())
  }
  function onSpawn() { if (pendingLine) { const l = pendingLine; pendingLine = null; setTimeout(() => { try { say(l.slice(0, 220)) } catch { /* ignore */ } }, 4000).unref?.() } }

  function start() { if (started) return; started = true; bot.on('messagestr', onMsg); bot.on('death', onDeath); bot.on('spawn', onSpawn) }
  function stop() { started = false; bot.removeListener('messagestr', onMsg); bot.removeListener('death', onDeath); bot.removeListener('spawn', onSpawn) }
  return { sample, start, stop, tuning: () => tuning, onDeath, classify, save }
}

module.exports = { makeDeaths, classify, lessonsFor, DEATH_MSG }
