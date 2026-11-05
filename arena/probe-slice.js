// Probe job: print layers y=-62..-48 for the window around the ladder / glass cage (x -92..-70, z 28..48).
const fs = require('fs'), path = require('path')
const { Vec3 } = require('vec3')
module.exports = async function (bot, cmd, sleep) {
  cmd('/gamemode creative'); cmd('/tp @s -80 -58 36 0 0'); await sleep(3500)
  const X0 = -96, X1 = -62, Z0 = 28, Z1 = 50
  const ch = (n) => ({ air: '.', orange_concrete: 'O', light_blue_concrete: 'b', glass: 'G', water: '~', ladder: 'H', iron_door: 'D', oak_pressure_plate: 'p', stone_button: 'u', gray_concrete: 'k', oak_wall_sign: 's', wall_torch: 't', grass_block: ',', dirt: ',', bedrock: ',' }[n] || '?')
  let out = `x ${X0}..${X1} (left->right), z ${Z0}..${Z1} (top->bottom)\n`
  for (let y = -61; y <= -47; y++) { out += `\n=== y=${y} ===\n`; for (let z = Z0; z <= Z1; z++) { let r = ''; for (let x = X0; x <= X1; x++) { const b = bot.blockAt(new Vec3(x, y, z)); r += b ? ch(b.name) : ' ' } out += String(z).padStart(3) + ' ' + r + '\n' } }
  fs.writeFileSync(path.join(__dirname, 'results', 'course-slice.txt'), out)
  return { ok: true }
}
