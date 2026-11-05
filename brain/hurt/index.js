// brain/hurt: every hit the bot takes, named by its cause (Walter 2026-11-05: could we see the damage from berry bushes?).
// The server sends damage_event with a damage-type id; join.js keeps the type names from the login registry (brain/state/damage-types.json).
// Each hit is logged ("hurt: sweet_berry_bush -1.0 hp, now 15.0") and counted; totals go to brain/state/hurt.json for the views and for tuning.
const fs = require('fs')

module.exports = function register(api) {
  const { bot } = api
  const file = api.statePath('hurt.json')
  let types = null
  const typeName = (id) => {
    if (!types) { types = bot._damageTypes || null; if (!types) { try { types = JSON.parse(fs.readFileSync(api.statePath('damage-types.json'), 'utf8')) } catch {} } }
    return (types && types[id]) || ('type#' + id)
  }
  let totals = {}; try { totals = JSON.parse(fs.readFileSync(file, 'utf8')) } catch {}
  let saveAt = 0
  const onDamage = (p) => {
    try {
      if (!bot.entity || p.entityId !== bot.entity.id) return
      const kind = typeName(p.sourceTypeId)
      const by = p.sourceCauseId > 0 ? bot.entities[p.sourceCauseId - 1] : null
      const who = by ? (by.username || by.name || by.type) : null
      if (!who) bot._lastEnvHurtAt = Date.now()   // no mob behind it: thorns, falls, drowning, fire (the cave reflex ignores these)
      const hp0 = bot.health
      setTimeout(() => {
        const lost = Math.max(0, +(hp0 - bot.health).toFixed(1))
        const k = who && kind !== who ? `${kind} (${who})` : kind
        const t = totals[k] || (totals[k] = { hits: 0, hp: 0 }); t.hits++; t.hp = +(t.hp + lost).toFixed(1)
        api.log('hurt', `${k} -${lost} hp, now ${bot.health.toFixed(1)} at ${bot.entity.position.floored()}`)
        if (Date.now() - saveAt > 5000) { saveAt = Date.now(); try { fs.writeFileSync(file, JSON.stringify(totals, null, 1)) } catch {} }
      }, 150)
    } catch {}
  }
  return {
    name: 'hurt',
    start() { bot._client.on('damage_event', onDamage) },
    stop() { bot._client.removeListener('damage_event', onDamage); try { fs.writeFileSync(file, JSON.stringify(totals, null, 1)) } catch {} },
    status() { return totals }
  }
}
module.exports.meta = require('./meta.json')
