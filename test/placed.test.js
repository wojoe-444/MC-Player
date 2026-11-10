const test = require('node:test')
const assert = require('node:assert')
const os = require('os'), fs = require('fs'), path = require('path')
const EE = require('events')
const V = require('vec3')
process.env.BOT_PLACED = path.join(os.tmpdir(), 'placed-test-' + process.pid + '.json')
const { attach } = require('../brain/placed')

test('placed log: own placements and a nearby player\'s (who swung) are logged, a broken block is dropped, the file is merged', () => {
  try { fs.unlinkSync(process.env.BOT_PLACED) } catch {}
  const bot = new EE(); bot.username = 'OzoGo444'; bot.spawnPoint = { x: 1, z: 2 }; bot.players = {}
  const P = attach(bot)
  bot.emit('blockPlaced', { name: 'air' }, { name: 'cobblestone', position: V(1, 2, 3) })
  const w = { type: 'player', username: 'Walter', position: V(5, 64, 5) }; bot.players.Walter = { entity: w }
  bot.emit('entitySwingArm', w)
  bot.emit('blockUpdate', { name: 'air', position: V(6, 64, 5) }, { name: 'oak_planks', position: V(6, 64, 5) })
  // far from any player who swung: not logged (water flow, sand falling, a sapling growing)
  bot.emit('blockUpdate', { name: 'air', position: V(40, 64, 40) }, { name: 'sand', position: V(40, 64, 40) })
  assert.deepStrictEqual(P.byWho(), { OzoGo444: 1, Walter: 1 })
  assert.strictEqual(P.at(V(6, 64, 5)).by, 'Walter')
  bot.emit('blockUpdate', { name: 'oak_planks', position: V(6, 64, 5) }, { name: 'air', position: V(6, 64, 5) })
  assert.strictEqual(P.at(V(6, 64, 5)), null)
  P.save()
  const f = JSON.parse(fs.readFileSync(process.env.BOT_PLACED, 'utf8'))
  assert.deepStrictEqual(Object.keys(f.worlds['spawn 1,2']), ['1,2,3'])
  P.dispose()
  fs.unlinkSync(process.env.BOT_PLACED)
})
