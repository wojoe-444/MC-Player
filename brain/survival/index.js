// brain/survival: the metric for the survive-from-scratch hillclimb. One "life" = spawn/respawn to death.
// Writes brain/state/survival-runs.jsonl (events) and brain/state/survival-summary.json (per-life table).
// Per life: ticks survived (game time, 24000 = one day), cause of death, milestone times in ticks since the life began.
// Observation only: it never moves the bot or touches the world.
const fs = require('fs')

const MILESTONES = [
  ['log', /_log$/], ['crafting_table', /^crafting_table$/], ['wooden_pickaxe', /^wooden_pickaxe$/], ['wooden_sword', /^wooden_sword$/],
  ['cobblestone', /^cobblestone$/], ['stone_pickaxe', /^stone_pickaxe$/], ['stone_sword', /^stone_sword$/], ['furnace', /^furnace$/],
  ['food', /^(cooked_[a-z_]+|bread|apple|baked_potato|carrot|melon_slice)$/], ['coal', /^coal$/], ['torch', /^torch$/],
  ['bed', /_bed$/], ['raw_iron', /^raw_iron$/], ['iron_ingot', /^iron_ingot$/], ['iron_pickaxe', /^iron_pickaxe$/], ['iron_sword', /^iron_sword$/],
  ['armor', /_(helmet|chestplate|leggings|boots)$/], ['shield', /^shield$/], ['diamond', /^diamond$/]
]

function register(api) {
  const { bot } = api
  const evFile = api.statePath('survival-runs.jsonl'), sumFile = api.statePath('survival-summary.json')
  const age = () => (bot.time && typeof bot.time.age === 'number') ? bot.time.age : 0
  let lives = []
  try { lives = (JSON.parse(fs.readFileSync(sumFile, 'utf8')).lives || []).map(l => l.open ? { ...l, open: undefined, valid: false, cause: 'disconnected (bot restart)', survivedTicks: null, interrupted: true } : l) } catch {}
  let cur = null
  const emit = (o) => { try { fs.appendFileSync(evFile, JSON.stringify({ t: new Date().toISOString(), age: age(), ...o }) + '\n') } catch {} }
  const save = () => { try { fs.writeFileSync(sumFile, JSON.stringify({ lives: lives.concat(cur ? [{ ...cur, open: true }] : []), best: Math.max(0, ...lives.map(l => l.survivedTicks || 0)) }, null, 1)) } catch {} }
  function begin(why) {
    let tod = (bot.time && bot.time.timeOfDay) || 0
    let reset = false
    // Walter's rule: an early-game life must start in daylight. Cheats are on in this world, so the harness (not the bot's play) resets night to day.
    if (!(tod < 6000 || tod > 23000) && process.env.SURVIVAL_TIME_RESET !== '0') {
      try { bot.chat('/time set 1000'); reset = true; tod = 1000 } catch {}
    }
    cur = { n: lives.length + 1, startTimeOfDay: tod, timeReset: reset, valid: tod < 6000 || tod > 23000, startAge: age(), startReal: Date.now(), why, milestones: {}, minHp: 20, nights: 0, lastDawnAge: age() }
    emit({ ev: 'life-start', n: cur.n, why }); save()
  }
  function scan() {
    if (!cur || !bot.entity) return
    const names = new Set(bot.inventory.items().map(i => i.name))
    for (const slot of [5, 6, 7, 8]) { const it = bot.inventory.slots[slot]; if (it) names.add(it.name) }
    for (const [k, re] of MILESTONES) {
      if (cur.milestones[k] != null) continue
      for (const n of names) if (re.test(n)) { cur.milestones[k] = age() - cur.startAge; emit({ ev: 'milestone', n: cur.n, k, sinceStart: cur.milestones[k] }); break }
    }
    cur.minHp = Math.min(cur.minHp, bot.health)
    // a night survived = game time passing a dawn (tick 0 of the day) while alive
    const day = Math.floor(age() / 24000), lastDay = Math.floor(cur.lastDawnAge / 24000)
    if (day > lastDay) { cur.nights += day - lastDay; cur.lastDawnAge = age(); emit({ ev: 'dawn', n: cur.n, nights: cur.nights }) }
  }
  let deathMsg = ''
  const onMsg = (m) => { try { const s = m.toString(); if (new RegExp(bot.username + ' (was|drowned|died|hit|burned|fell|tried|suffocated|starved|walked|went|blew|experienced|withered|got)').test(s)) deathMsg = s } catch {} }
  const onDeath = () => {
    if (!cur) return
    setTimeout(() => {
      const p = bot.entity ? bot.entity.position : null
      cur.endAge = age(); cur.survivedTicks = cur.endAge - cur.startAge; cur.survivedMin = Math.round((Date.now() - cur.startReal) / 600) / 100
      cur.cause = deathMsg.replace(new RegExp('^.*' + bot.username), bot.username); cur.deathPos = p ? [Math.round(p.x), Math.round(p.y), Math.round(p.z)] : null
      lives.push(cur); emit({ ev: 'death', ...cur }); cur = null; deathMsg = ''; save()
      begin('respawn')
    }, 1500)
  }
  let timer = null
  return {
    name: 'survival',
    start() {
      begin('join')
      bot.on('message', onMsg); bot.on('death', onDeath)
      timer = setInterval(() => { try { scan(); save() } catch {} }, 5000)
    },
    stop() { if (timer) clearInterval(timer); bot.removeListener('message', onMsg); bot.removeListener('death', onDeath) },
    status: () => ({ life: cur && cur.n, ticks: cur ? age() - cur.startAge : 0, milestones: cur ? Object.keys(cur.milestones).length : 0, deaths: lives.length })
  }
}
register.meta = { name: 'survival', version: 1 }
module.exports = register
module.exports.meta = register.meta
