const test = require('node:test')
const assert = require('node:assert')
const os = require('os'), fs = require('fs'), path = require('path')
const EE = require('events')
const V = require('vec3')
process.env.BOT_PLACED = path.join(os.tmpdir(), 'placed-test-' + process.pid + '.json')
const { attach, naturalChange } = require('../brain/placed')

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

test('placed log: natural changes near a working player are not credited to the player (ice, flow results, leaves, falling blocks)', () => {
  assert.strictEqual(naturalChange('water', 'ice'), true)
  assert.strictEqual(naturalChange('lava', 'obsidian'), true)
  assert.strictEqual(naturalChange('lava', 'cobblestone'), true)
  assert.strictEqual(naturalChange('air', 'oak_leaves'), true)
  assert.strictEqual(naturalChange('air', 'gravel'), true)
  assert.strictEqual(naturalChange('air', 'white_concrete_powder'), true)
  assert.strictEqual(naturalChange('air', 'cobblestone'), false)           // a player placing cobblestone on air is a build
  assert.strictEqual(naturalChange('water', 'oak_planks'), false)          // so is planks into water
  try { fs.unlinkSync(process.env.BOT_PLACED) } catch {}
  const bot = new EE(); bot.username = 'OzoGo444'; bot.spawnPoint = { x: 1, z: 2 }; bot.players = {}
  const P = attach(bot)
  const w = { type: 'player', username: 'Walter', position: V(5, 64, 5) }; bot.players.Walter = { entity: w }
  bot.emit('entitySwingArm', w)
  bot.emit('blockUpdate', { name: 'water', position: V(6, 64, 5) }, { name: 'ice', position: V(6, 64, 5) })
  bot.emit('blockUpdate', { name: 'air', position: V(6, 65, 5) }, { name: 'birch_leaves', position: V(6, 65, 5) })
  bot.emit('blockUpdate', { name: 'air', position: V(7, 64, 5) }, { name: 'gravel', position: V(7, 64, 5) })
  assert.strictEqual(P.count(), 0)
  bot.emit('blockUpdate', { name: 'air', position: V(7, 65, 5) }, { name: 'stone_bricks', position: V(7, 65, 5) })
  assert.strictEqual(P.count(), 1)
  P.dispose(); try { fs.unlinkSync(process.env.BOT_PLACED) } catch {}
})
