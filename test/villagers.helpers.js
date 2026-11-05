// Test rig for brain/villagers: the excavation rig's mock bot (ray casts, entities) plus villager entities, trade windows and a fake api.
const fs = require('fs')
const os = require('os')
const path = require('path')
const { Vec3 } = require('vec3')
const { mockBot } = require('./mock-bot')
const { extend, waitFor, wait } = require('./excavation.helpers')
const { Scheduler, PRIORITY } = require('../brain/scheduler')
const makeSafehand = require('../brain/safehand')
const los = require('../brain/los')
const register = require('../brain/villagers')

const PROF = ['none', 'armorer', 'butcher', 'cartographer', 'cleric', 'farmer', 'fisherman', 'fletcher', 'leatherworker', 'librarian', 'mason', 'nitwit', 'shepherd', 'toolsmith', 'weaponsmith']

const T = {   // trade builders (mineflayer shape)
  buy: (out, cost, { enchants = [], count = 1, in2 = null, max = 12, used = 0 } = {}) => ({
    inputItem1: { name: 'emerald', count: cost }, realPrice: cost, outputItem: { name: out, count, enchants },
    hasItem2: !!in2, inputItem2: in2, tradeDisabled: used >= max, nbTradeUses: used, maximumNbTradeUses: max
  }),
  sell: (item, count, gets = 1, { max = 16, used = 0 } = {}) => ({
    inputItem1: { name: item, count }, realPrice: count, outputItem: { name: 'emerald', count: gets, enchants: [] },
    hasItem2: false, inputItem2: null, tradeDisabled: used >= max, nbTradeUses: used, maximumNbTradeUses: max
  }),
  book: (ench, lvl, cost, opts = {}) => T.buy('enchanted_book', cost, { ...opts, enchants: [{ name: ench, lvl }], in2: { name: 'book', count: 1 } })
}

function rig({ pos = [0, 64, 0], inv = {} } = {}) {
  const bot = extend(mockBot({ pos }))
  for (const [n, c] of Object.entries(inv)) bot.give(n, c)
  for (let x = -6; x <= 20; x++) for (let z = -8; z <= 8; z++) bot.setBlock(x, 63, z, 'stone')   // a floor
  bot.windowsOpened = []; bot.losBreaches = []

  bot.addVillager = ({ id, at, profession = 'none', baby = false, trades = [], level = 1, name = 'villager' }) => {
    bot.entities[id] = { id, name, position: new Vec3(...at), height: baby ? 0.975 : 1.95, metadata: [{ villagerType: 'plains', villagerProfession: PROF.indexOf(profession), level }], trades }
    return bot.entities[id]
  }
  bot.openVillager = async (e) => {
    const eyeP = bot.entity.position.offset(0, 1.62, 0), mid = e.position.offset(0, e.height / 2, 0)
    if (eyeP.distanceTo(mid) > 3.6) throw new Error('too far to open the trade window')
    const d = mid.minus(eyeP), r = d.norm(), hit = bot.world.raycast(eyeP, d.scaled(1 / r), r)
    if (hit) { bot.losBreaches.push(e.id); throw new Error('NO LINE OF SIGHT to villager ' + e.id) }
    bot.windowsOpened.push(e.id)
    const trades = e.trades.map((t) => ({ ...t, inputItem1: { ...t.inputItem1 }, outputItem: { ...t.outputItem } }))
    const win = {
      trades,
      closed: false,
      close() { this.closed = true },
      async trade(index, count) {
        const t = trades[index]
        if (t.tradeDisabled) throw new Error('trade blocked')
        for (let i = 0; i < count; i++) {
          if (bot.count(t.inputItem1.name) < t.realPrice) throw new Error('Not enough item 1 to trade')
          if (t.hasItem2 && bot.count(t.inputItem2.name) < t.inputItem2.count) throw new Error('Not enough item 2 to trade')
          bot.take(t.inputItem1.name, t.realPrice); if (t.hasItem2) bot.take(t.inputItem2.name, t.inputItem2.count)
          bot.give(t.outputItem.name, t.outputItem.count); t.nbTradeUses++
          if (t.nbTradeUses >= t.maximumNbTradeUses) t.tradeDisabled = true
        }
        bot.actions.push(['trade', e.id, index, count])
      }
    }
    bot._lastWin = win
    return win
  }

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vil-'))
  const said = []
  const commands = []
  const scheduler = new Scheduler({ graceMs: 300, idleAfterMs: 0 })
  const sh = makeSafehand({ bot })
  const state = { arrive: (pos) => new Vec3(pos.x - 1.5, pos.y, pos.z + 0.5) }   // where gotoNear leaves us: next to the target
  const api = {
    bot, PRIORITY, scheduler, say: (t) => said.push(t), goals: bot.goals, tryGoto: bot.tryGoto, stopNav() {}, safehand: sh,
    gotoNear: async ({ pos }) => { bot.entity.position = state.arrive(pos); bot.actions.push(['gotoNear', pos.x, pos.y, pos.z]); return true },
    canSee: (t) => los.canSee(bot, t), ownerName: 'OGWO', dir, statePath: (f) => path.join(dir, f), log() {}, now: () => Date.now(),
    commands: { add: (c) => commands.push(c), list: () => commands, dispatch: () => false }
  }
  const handle = register(api)
  return { bot, api, handle, said, scheduler, dir, file: path.join(dir, 'villagers-state.json'), commands, arrive: state, say: (t) => handle.onChat('OGWO', t), reload: () => register(api) }
}

const inv = (bot, n) => bot.count(n)
const idle = async (r, ms = 4000) => { await wait(20); await waitFor(() => !r.scheduler.status().running && !(r.scheduler.status().queue || []).length, ms) }

module.exports = { rig, T, inv, idle, waitFor, wait, Vec3, PROF }
