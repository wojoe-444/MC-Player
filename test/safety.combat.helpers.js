// Test helpers for the combat module: a rig around the mock bot plus a small vanilla-like creeper simulation.
const { Vec3 } = require('vec3')
const { mockBot } = require('./mock-bot')
const { Scheduler, PRIORITY } = require('../brain/scheduler')
const safehand = require('../brain/safehand')
const install = require('../brain/safety/runtime')
const wait = (ms) => new Promise(r => setTimeout(r, ms))

const FAST = { calmMs: 150, scanMs: 25, eatGapMs: 0, holdMaxMs: 400, holdCooldownMs: 100000, pathFilter: false }

function rig({ mode = 'fight', health = 20, food = 20, items = ['stone_sword'], config = {}, pos = [0, 64, 0], withReach = false, waypointsFile = null, floor = true, lessonsFile = null, tuningFile = null, commands = null, canSee = null } = {}) {
  const bot = mockBot({ pos, health, food })
  for (const i of items) bot.give(i, i === 'arrow' ? 16 : 1)
  if (floor) for (let x = -40; x <= 40; x++) for (let z = -40; z <= 40; z++) bot.setBlock(x, 63, z, 'stone')       // solid ground: no drops, so the narrow-ground rule stays out of the way
  bot.dig = bot.placeBlock = () => { throw new Error('safety module must never dig or place') }
  bot.look = (yaw, pitch) => { bot.entity.yaw = yaw; bot.entity.pitch = pitch; bot.actions.push(['look', yaw, pitch]); return Promise.resolve() }
  bot.activateItem = () => bot.actions.push(['activateItem', bot.heldItem && bot.heldItem.name])
  bot.deactivateItem = () => bot.actions.push(['deactivateItem'])
  bot.goalLog = []
  const origSet = bot.pathfinder.setGoal.bind(bot.pathfinder)
  bot.pathfinder.setGoal = (g) => { if (g) bot.goalLog.push({ hand: bot.heldItem && bot.heldItem.name, kind: g.goal ? 'away' : g.entity ? 'follow' : 'other', g }); origSet(g) }
  const sched = new Scheduler({ graceMs: 100 })
  const said = [], slog = []
  const rt = install({ bot, say: (t) => said.push(t), goals: bot.goals, scheduler: sched, PRIORITY, safehand: safehand({ bot }), slog: (m) => slog.push(m), waypointsFile, lessonsFile, tuningFile, commands, canSee, config: { ...FAST, ...(withReach ? { pathFilter: true } : {}), ...config } })
  rt.setMode(mode)
  return { bot, sched, said, slog, rt }
}
const addMob = (bot, id, name, x, z, y = 64) => { bot.entities[id] = { id, name, type: 'hostile', position: new Vec3(x, y, z), height: name === 'creeper' ? 1.7 : 1.95, metadata: [] } }
async function until(fn, ms = 3000) { const t = Date.now(); while (Date.now() - t < ms) { if (fn()) return true; await wait(15) } return fn() }

// Vanilla-like creeper: walks to the player at `speed`, swells while the player is within 3 blocks (and stops walking while swelling),
// the fuse winds down when the player is out of range, explodes after 30 ticks (power 3, damage falls to 0 at 6 blocks).
// The bot moves per its pathfinder goal (GoalInvert = away at sprint speed, GoalFollow = toward the mob), capped by `botSpeed`.
function creeperSim(bot, { id = 50, x, z, speed = 4.3, botSpeed = 5.6, hp = 20, knockback = 1.5, stepMs = 25 } = {}) {
  addMob(bot, id, 'creeper', x, z)
  const e = bot.entities[id]
  const st = { exploded: false, dead: false, damage: 0, swell: 0, maxSwell: 0, minDist: Infinity, hits: 0, hp, distAtBoom: null }
  let last = Date.now()
  const timer = setInterval(() => {
    const t = Date.now(), dt = Math.min(0.2, (t - last) / 1000); last = t
    if (st.exploded || st.dead) return
    const me = bot.entity.position, c = e.position
    // bot movement
    const g = bot.pathfinder._goal
    if (g) {
      const away = g.goal ? 1 : g.entity ? -1 : 0
      if (away) {
        const dx = c.x - me.x, dz = c.z - me.z, d = Math.hypot(dx, dz) || 1
        const want = g.goal ? (g.goal.r ?? 16) : (g.r ?? 2)
        if (away === 1 || d > want) bot.entity.position = new Vec3(me.x - away * (dx / d) * botSpeed * dt, me.y, me.z - away * (dz / d) * botSpeed * dt)
      }
    }
    // creeper
    const m2 = bot.entity.position, dx = m2.x - c.x, dz = m2.z - c.z, d = Math.hypot(dx, dz)
    st.minDist = Math.min(st.minDist, d)
    const dtTicks = dt * 20
    if (d <= 3) st.swell = Math.min(30, st.swell + dtTicks); else st.swell = Math.max(0, st.swell - dtTicks)
    st.maxSwell = Math.max(st.maxSwell, st.swell)
    e.metadata[16] = st.swell > 0 && d <= 7 ? 1 : -1
    if (st.swell <= 0 || d > 3) { if (!(st.swell > 0 && d <= 3)) { /* walks */ } }
    const swelling = st.swell > 0 && d <= 3
    if (!swelling && d > 0.5) e.position = new Vec3(c.x + (dx / d) * speed * dt, c.y, c.z + (dz / d) * speed * dt)
    if (st.swell >= 30) {
      st.exploded = true; st.distAtBoom = d
      const impact = Math.max(0, 1 - d / 6)
      st.damage = d >= 6 ? 0 : ((impact * impact + impact) / 2) * 21 + 1
      bot.health = Math.max(0, bot.health - st.damage)
      delete bot.entities[id]
    }
  }, stepMs)
  // melee: the bot's attack() hurts the creeper and knocks it back
  const origAttack = bot.attack
  bot.attack = (en) => {
    origAttack(en)
    if (en.id !== id || st.exploded || st.dead) return
    const me = bot.entity.position, c = e.position, d = Math.hypot(me.x - c.x, me.z - c.z)
    if (d > 3.3) return
    st.hits++; st.hp -= 5
    if (st.hp <= 0) { st.dead = true; delete bot.entities[id]; return }
    const k = knockback / (d || 1)
    e.position = new Vec3(c.x + (c.x - me.x) * k, c.y, c.z + (c.z - me.z) * k)
  }
  return { st, stop: () => clearInterval(timer), entity: e }
}

module.exports = { rig, addMob, until, wait, creeperSim, FAST, Vec3, PRIORITY }
