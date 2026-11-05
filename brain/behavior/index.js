// brain/behavior: what the bot is doing, as a mineflayer-statemachine graph for the dashboard (Walter 2026-11-05: the behavior tree should be
// visible on the site). The autopilot scheduler stays in charge of priorities and safety; this machine follows it: a 'deciding' hub, one state
// per step this bot's role can run, and for site work its phases (G.sitePhase, set by site.js). Written to brain/state/behavior-tree.json.
const path = require('path')
const { EventEmitter } = require('events')

module.exports = function register(api) {
  const { bot } = api
  const log = (m) => api.log('behavior', m)
  const SM = require(path.join(__dirname, '..', '..', 'vendor', 'node_modules', 'mineflayer-statemachine'))
  const { attachBehaviorView } = require('../behavior-view')
  let tick = null, view = null, builtFor = null, timer = null
  const ap = () => bot._ap
  const S = (name) => ({ stateName: name, active: false, onStateEntered () {}, onStateExited () {} })
  const PHASES = [['stock', 'stock up'], ['enter', 'in through the gate'], ['fell', 'fell trees'], ['replant', 'replant'], ['cleanup', 'clear leftovers'], ['leave', 'out through the gate'], ['store', 'store output']]

  function build() {
    const G = ap() && ap().G; if (!G) return
    const steps = G.steps.map(s => s.id).filter(id => !G.roleSteps || G.roleSteps.has(id))
    const key = (G.role || 'hillclimber') + ':' + steps.join(',')
    if (key === builtFor) return
    stop(); builtFor = key
    const hub = S('deciding'), idle = S('idle at home')
    const transitions = [], states = []
    const stepOf = () => (ap() && ap().G && ap().G.lastStep) || null
    const add = (st, id) => {
      transitions.push(new SM.StateTransition({ parent: hub, child: st, name: 'picked', shouldTransition: () => stepOf() === id }))
      transitions.push(new SM.StateTransition({ parent: st, child: hub, name: 'done', shouldTransition: () => stepOf() !== id }))
    }
    for (const id of steps) {
      let st
      if (id === 'site-work') {
        const ph = PHASES.map(([k, l]) => Object.assign(S(l), { key: k }))
        const phase = () => ap() && ap().G && ap().G.sitePhase
        const inner = []
        for (const a of ph) for (const b of ph) if (a !== b) inner.push(new SM.StateTransition({ parent: a, child: b, shouldTransition: () => phase() === b.key }))
        st = new SM.NestedStateMachine(inner, ph[0]); st.stateName = 'site work'
      } else st = S(id)
      states.push(st); add(st, id)
    }
    transitions.push(new SM.StateTransition({ parent: hub, child: idle, name: 'nothing to do', shouldTransition: () => /^(home|explore)$/.test(stepOf() || '') }))
    transitions.push(new SM.StateTransition({ parent: idle, child: hub, name: 'work', shouldTransition: () => !/^(home|explore)$/.test(stepOf() || '') }))
    const root = new SM.NestedStateMachine(transitions, hub); root.stateName = bot.username
    tick = new EventEmitter()                      // our own clock, so the machine stops cleanly on reload
    const bsm = new SM.BotStateMachine(tick, root)
    view = attachBehaviorView(bsm, api.statePath('behavior-tree.json'), { machine: `${bot.username} (${G.role || 'hillclimber'})` })
    timer = setInterval(() => { try { tick.emit('physicTick') } catch {} }, 250)
    log(`machine built: ${states.length} steps (${G.role || 'hillclimber'})`)
  }
  function stop() { clearInterval(timer); timer = null; try { view && view.stop() } catch {} view = null; tick = null }
  let rebuild = null
  return {
    name: 'behavior',
    start() { setTimeout(() => { try { build() } catch (e) { log('not built: ' + e.message) } }, 3000); rebuild = setInterval(() => { try { build() } catch {} }, 30000) },
    stop() { clearInterval(rebuild); stop() },
    status() { return { builtFor } }
  }
}
module.exports.meta = require('./meta.json')
