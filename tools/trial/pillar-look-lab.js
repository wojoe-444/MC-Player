#!/usr/bin/env node
// Pillar look-wait lab (insights doc, Haiku check 1, client-side half).
//
// Question: does mineflayer 4.39's non-forced lookAt inside bot.placeBlock delay the block_place packet until the feet have dropped back
// into the target cell? A vanilla server refuses a block whose cell still overlaps the player, judged from the LAST POSITION PACKET it got.
// So for every run this measures, with the real mineflayer physics and the real packet writer:
//   - yaw the head had to turn at the call (rad), and ticks from the call to the block_place packet
//   - the last position the client had told the server when block_place left, versus the cell top (feet cell y + 1)
//   - wouldRefuse = that last sent y is below the cell top (the vanilla overlap rule for a 0.6 x 1.8 box standing in the cell)
// It does not run vanilla. It uses flying-squid (a JS server) only as something to join, so it cannot confirm a real refusal; it measures
// the client-side timing that the hypothesis depends on. The vanilla half is `trial-server` (needs the Mojang jar).
//
//   npm i --no-save flying-squid@1.12.0   (not a dependency of the repo)
//   node tools/trial/pillar-look-lab.js [--runs 30] [--port 25611] [--out results.jsonl]
//
// Variants: A current reach.js timing + plain placeBlock; B forceLook; C place as soon as the feet clear +1.0 (tick 3); D both.
// Scenarios: first = random head yaw (first block of a climb); later = head already at the face yaw of a slightly different offset
// (a later block of the same climb); sidestep = head at the face yaw for an offset 0.3 away.
'use strict'
const fs = require('fs')
const path = require('path')
const mineflayer = require('mineflayer')
const { Vec3 } = require('vec3')

const args = process.argv.slice(2)
const opt = (k, d) => { const i = args.indexOf('--' + k); return i >= 0 ? args[i + 1] : d }
const RUNS = +opt('runs', 30)
const PORT = +opt('port', 25611)
const OUT = opt('out', path.join(require('os').tmpdir(), 'pillar-look-lab.out.jsonl'))
const VERSION = '1.21.4'
const SEED = +opt('seed', 12345)
let rs = SEED
const rnd = () => { rs = (rs * 1664525 + 1013904223) % 4294967296; return rs / 4294967296 }
const PI = Math.PI
const norm = a => { a %= 2 * PI; if (a < -PI) a += 2 * PI; if (a > PI) a -= 2 * PI; return a }
const faceYaw = (bx, bz, ref) => Math.atan2(-(ref.x + 0.5 - bx), -(ref.z + 0.5 - bz))

function startServer () {
  const flying = require('flying-squid')
  return flying.createMCServer({
    'online-mode': false, port: PORT, version: VERSION, motd: 'pillar lab', 'max-players': 4, logging: false, gameMode: 0, difficulty: 0,
    'view-distance': 4, kickTimeout: 60000, plugins: {}, modpe: false, 'player-list-text': { header: { text: 'lab' }, footer: { text: 'lab' } }, 'everybody-op': true,
    generation: { name: 'superflat', options: {} }, worldFolder: path.join(require('os').tmpdir(), 'pillar-lab-world-' + process.pid)
  })
}

async function main () {
  const server = startServer()
  await new Promise(r => setTimeout(r, 2500))
  const bot = mineflayer.createBot({ host: 'localhost', port: PORT, username: 'LabPillar', version: VERSION, auth: 'offline', checkTimeoutInterval: 120000 })
  await new Promise((res, rej) => { bot.once('spawn', res); bot.once('error', rej); bot.once('kicked', k => rej(new Error('kicked ' + JSON.stringify(k)))) })
  await bot.waitForChunksToLoad()
  await bot.waitForTicks(20)

  // find the floor under the spawn
  const sp = bot.entity.position.floored()
  let floorY = sp.y
  for (let y = sp.y + 3; y > sp.y - 10; y--) { const b = bot.blockAt(new Vec3(sp.x, y, sp.z)); if (b && b.boundingBox === 'block') { floorY = y; break } }
  const cell = new Vec3(sp.x, floorY + 1, sp.z) // feet cell
  const refPos = new Vec3(cell.x, floorY, cell.z)
  const Item = require('prismarine-item')(VERSION)
  const dirt = bot.registry.itemsByName.dirt
  const give = () => { bot.inventory.slots[36] = new Item(dirt.id, 64); bot.setQuickBarSlot(0) }

  // instrument the packet writer
  let tick = 0
  bot.on('physicsTick', () => { tick++ })
  let lastSent = { y: null }
  let placePacket = null
  const origWrite = bot._client.write.bind(bot._client)
  bot._client.write = (name, data) => {
    if ((name === 'position' || name === 'position_look') && data && typeof data.y === 'number') lastSent = { y: data.y, tick }
    if (name === 'block_place') placePacket = { tick, sentY: lastSent.y, entityY: bot.entity.position.y, vy: bot.entity.velocity.y }
    return origWrite(name, data)
  }

  const VARIANTS = {
    A: { force: false, from: 'reach' },
    B: { force: true, from: 'reach' },
    C: { force: false, from: 'tick3' },
    D: { force: true, from: 'tick3' }
  }
  const SCEN = ['first', 'later', 'sidestep']
  const results = []
  fs.writeFileSync(OUT, '')

  async function oneRun (vname, scen, n) {
    const v = VARIANTS[vname]
    give()
    // start position: random offset inside the cell (a 0.6 wide player in a 1x1 shaft can be +-0.2 off centre)
    const ox = (rnd() * 2 - 1) * 0.2, oz = (rnd() * 2 - 1) * 0.2
    bot.entity.position.set(cell.x + 0.5 + ox, cell.y, cell.z + 0.5 + oz)
    bot.entity.velocity.set(0, 0, 0)
    bot.entity.onGround = true
    bot.setControlState('jump', false)
    await bot.waitForTicks(8)
    const bx = bot.entity.position.x, bz = bot.entity.position.z
    // head state before the jump, as reach.js does: pitch straight down, forced
    let yaw0
    if (scen === 'first') yaw0 = (rnd() * 2 - 1) * PI
    else if (scen === 'later') yaw0 = faceYaw(bx + (rnd() * 2 - 1) * 0.03, bz + (rnd() * 2 - 1) * 0.03, refPos)
    else yaw0 = faceYaw(bx + 0.3 * (rnd() < 0.5 ? -1 : 1), bz + 0.3 * (rnd() < 0.5 ? -1 : 1), refPos)
    await bot.look(yaw0, -PI / 2, true)
    await bot.waitForTicks(2)
    const ref = bot.blockAt(refPos)
    placePacket = null
    const jumpStartTick = tick
    bot.setControlState('jump', true)
    let callTick = null, callDy = null, yawDelta = null, err = null
    for (let i = 0; i < 40 && callTick === null; i++) {
      await bot.waitForTicks(1)
      const dy = bot.entity.position.y - cell.y, vy = bot.entity.velocity.y
      if (v.from === 'reach') {
        if (dy >= 1.1 && vy > -0.05) {
          await bot.waitForTicks(1)
          if (bot.entity.position.y - cell.y < 1.1 || bot.entity.velocity.y < -0.1) continue
          callTick = tick
        }
      } else if (dy >= 1.0) callTick = tick
      if (callTick !== null) callDy = bot.entity.position.y - cell.y
    }
    if (callTick === null) { bot.setControlState('jump', false); return { vname, scen, n, noCall: true } }
    // what the head has to turn at the call, as lookAt computes it
    const target = ref.position.offset(0.5, 1, 0.5)
    const d = target.minus(bot.entity.position.offset(0, bot.entity.eyeHeight, 0))
    const wantYaw = Math.atan2(-d.x, -d.z)
    yawDelta = Math.abs(norm(wantYaw - bot.entity.yaw))
    // yaw the server has seen so far is bot.entity.yaw only after the slew; the wait is the gap to the last SENT yaw
    const p = v.force ? bot._placeBlockWithOptions(ref, new Vec3(0, 1, 0), { forceLook: true, swingArm: 'right' }) : bot.placeBlock(ref, new Vec3(0, 1, 0))
    p.catch(e => { err = e.message })
    for (let i = 0; i < 40 && !placePacket; i++) await bot.waitForTicks(1)
    bot.setControlState('jump', false)
    const out = { vname, scen, n, ox: +ox.toFixed(3), callDy: +callDy.toFixed(3), yawDelta: +yawDelta.toFixed(3), packet: !!placePacket }
    if (placePacket) {
      out.waitTicks = placePacket.tick - callTick
      out.sentDy = +(placePacket.sentY - cell.y).toFixed(3)
      out.entityDy = +(placePacket.entityY - cell.y).toFixed(3)
      out.wouldRefuse = placePacket.sentY < cell.y + 1 - 1e-6 // feet of the server's last known position still inside the target cell
    }
    // undo the local placement and settle
    const destPos = cell
    try { const stone = 0; bot.world.setBlockStateId(destPos, stone) } catch {}
    await bot.waitForTicks(12)
    return out
  }

  for (const scen of SCEN) {
    for (const vname of Object.keys(VARIANTS)) {
      for (let n = 0; n < RUNS; n++) {
        const r = await oneRun(vname, scen, n)
        results.push(r)
        fs.appendFileSync(OUT, JSON.stringify(r) + '\n')
      }
    }
  }

  // summary
  const lines = ['| scenario | variant | runs | packet sent | mean yaw to turn (rad) | mean ticks call->packet | max ticks | would refuse |', '|---|---|---|---|---|---|---|---|']
  for (const scen of SCEN) for (const vname of Object.keys(VARIANTS)) {
    const rr = results.filter(r => r.scen === scen && r.vname === vname)
    const sent = rr.filter(r => r.packet)
    const avg = a => a.length ? +(a.reduce((x, y) => x + y, 0) / a.length).toFixed(2) : null
    lines.push(`| ${scen} | ${vname} | ${rr.length} | ${sent.length} | ${avg(rr.map(r => r.yawDelta).filter(x => x != null))} | ${avg(sent.map(r => r.waitTicks))} | ${Math.max(0, ...sent.map(r => r.waitTicks))} | ${sent.filter(r => r.wouldRefuse).length}/${sent.length} |`)
  }
  console.log(lines.join('\n'))
  fs.writeFileSync(OUT.replace(/\.jsonl$/, '.md'), lines.join('\n') + '\n')
  bot.quit()
  try { server._server.close() } catch {}
  setTimeout(() => process.exit(0), 500)
}
main().catch(e => { console.error(e); process.exit(1) })
