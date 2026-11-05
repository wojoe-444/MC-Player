// Probe job: feet-level layers of the course. Layer A: y=-60 (feet) solid/water/open. Layer B: y=-59 (head). Also names of every non-air block type with counts and where the odd ones are.
const fs = require('fs'), path = require('path')
const { Vec3 } = require('vec3')
module.exports = async function (bot, cmd, sleep) {
  cmd('/gamemode creative'); cmd('/tp @s -83 -58 25 0 0'); await sleep(3500)
  const X0 = -108, X1 = -59, Z0 = 2, Z1 = 50
  const names = {}, odd = {}
  const layer = (y) => { const rows = []; for (let z = Z0; z <= Z1; z++) { let r = ''; for (let x = X0; x <= X1; x++) { const b = bot.blockAt(new Vec3(x, y, z)); if (!b || b.name === 'air') { r += '.'; continue } names[b.name] = (names[b.name] || 0) + 1; if (b.name === 'water') r += '~'; else if (b.name === 'orange_concrete') r += 'O'; else if (b.name.includes('glass')) r += 'G'; else if (b.name === 'blue_concrete' || b.name === 'light_blue_concrete') r += 'b'; else { r += '?'; (odd[b.name] = odd[b.name] || []).push([x, y, z]) } } rows.push(String(z).padStart(3) + ' ' + r) } return rows.join('\n') }
  let out = `x ${X0}..${X1} (left to right) z ${Z0}..${Z1} (top to bottom). '.'=air O=orange b=blue G=glass ~=water ?=other\n`
  for (const y of [-60, -59, -58, -57, -56]) out += `\n=== layer y=${y} ===\n` + layer(y) + '\n'
  out += '\nblock names seen (feet..head layers): ' + JSON.stringify(names) + '\nodd blocks (first 12 each): ' + JSON.stringify(Object.fromEntries(Object.entries(odd).map(([k, v]) => [k, v.slice(0, 12)])))
  fs.writeFileSync(path.join(__dirname, 'results', 'course-layers.txt'), out)
  return { names, odd: Object.fromEntries(Object.entries(odd).map(([k, v]) => [k, v.length])) }
}
