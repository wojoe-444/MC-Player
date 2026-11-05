// brain/combat: always-on combat reflex (arena winner, see README.md). Loaded as a module: runs on every physics tick, yields the controls to navigation when nothing can hurt the bot.
const reflex = require('./reflex')

function register(api) {
  const { bot } = api
  let combat = null
  const log = (m) => api.log('combat', m)
  const lease = api.reflexes ? api.reflexes.register({ name: 'combat', priority: 70, claims: ['melee'], desc: 'always-on combat reflex (arena winner): the one holder of the swings' }) : null
  const status = () => combat ? { on: true, engaged: combat.engaged(), stats: combat.stats } : { on: false }
  return {
    name: 'combat',
    start() {
      try {
        combat = reflex.create(bot, { yieldIdle: true, idleSprint: false }, { event: (t, o) => { if (t === 'hit' || t === 'kill' || t === 'escape') log(`${t} ${JSON.stringify(o).slice(0, 100)}`) } })
        bot._combat = combat
        api.combat = combat
        // the old safety melee would double-swing on the same mobs: keep its health holds and entomb, but not its own fight. This used to be a fake
        // "do not fight" chat command (which also overwrote Walter's saved fight/warn choice); now combat holds the `melee` lease and safety stands aside.
        if (lease) lease.claim('melee', Infinity, 'always-on combat reflex')
        else try { api.commands.dispatch(api.ownerName || 'OGWO', 'do not fight') } catch (e) { log('safety mode: ' + e.message) }   // no registry (old integrator)
        log('combat reflex on')
      } catch (e) { log('COMBAT_LOAD_ERR ' + (e.stack || e.message)) }
    },
    stop() { if (lease) lease.release('melee'); if (combat) { try { combat.stop() } catch {} combat = null; bot._combat = null } },
    status,
  }
}
module.exports = register
module.exports.meta = require('./meta.json')
