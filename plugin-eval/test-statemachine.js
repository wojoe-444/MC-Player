const EventEmitter = require('events'); const fs = require('fs')
const { BotStateMachine, StateTransition, NestedStateMachine } = require('mineflayer-statemachine')
const { attachBehaviorView } = require('./behavior-view')
const bot = new EventEmitter()
let inv = 0
const S = (name, extra = {}) => Object.assign({ stateName: name, active: false, onStateEntered() { this.entered = (this.entered || 0) + 1 } }, extra)
const idle = S('idle'), find = S('find tree'), mine = S('mine log'), haul = S('return to chest')
const inner = new NestedStateMachine([
  new StateTransition({ parent: find, child: mine, name: 'tree found', shouldTransition: () => true }),
], find, mine); inner.stateName = 'chop wood'
let cmd = false
const root = new NestedStateMachine([
  new StateTransition({ parent: idle, child: inner, name: 'chop asked', shouldTransition: () => cmd }),
  new StateTransition({ parent: inner, child: haul, name: 'inventory full', shouldTransition: () => inner.isFinished() }),
  new StateTransition({ parent: haul, child: idle, name: 'done', shouldTransition: () => true }),
], idle)
const f = 'out/behavior-tree.json'
const bsm = new BotStateMachine(bot, root)
const view = attachBehaviorView(bsm, f)
const read = () => JSON.parse(fs.readFileSync(f, 'utf8'))
const tick = () => bot.emit('physicTick')
tick(); let d = read(); console.log('t0 active', d.active)
cmd = true; tick(); d = read(); console.log('after cmd active', d.active)   // idle -> chop wood (find tree)
tick(); d = read(); console.log('after tick active', d.active)              // find -> mine
tick(); tick(); tick(); d = read(); console.log('end active', d.active)
console.log(JSON.stringify(d.nodes)); console.log(JSON.stringify(d.transitions)); console.log(JSON.stringify(d.history.map(h => h.from + '->' + h.to)))
view.stop()
