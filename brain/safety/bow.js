// Bow aiming. Pure maths + inventory helpers, no bot. Arrow physics (Java): launch speed 3.0 blocks/tick at full draw,
// each tick: position += velocity; velocity *= 0.99; velocity.y -= 0.05.
const V0 = 3.0, G = 0.05, DRAG = 0.99
const FULL_DRAW_MS = 1050          // 20 ticks plus a little slack

// Height of the arrow when it has travelled `dist` blocks horizontally, and the ticks that took. null if it never gets there.
function simulate(pitch, dist, v0 = V0) {
  let x = 0, y = 0, vx = v0 * Math.cos(pitch), vy = v0 * Math.sin(pitch), t = 0
  while (t < 400) {
    const nx = x + vx, ny = y + vy
    if (nx >= dist) { const f = (dist - x) / (nx - x); return { y: y + (ny - y) * f, ticks: t + f } }
    x = nx; y = ny; vx *= DRAG; vy = vy * DRAG - G; t++
    if (vx < 0.01) return null
  }
  return null
}

// Pitch (radians, + = up) that makes the arrow pass through (dist, dy). Low arc only. null when out of reach.
function solvePitch(dist, dy) {
  let lo = -0.5, hi = 0.8
  const top = simulate(hi, dist); if (!top || top.y < dy) return null
  for (let k = 0; k < 40; k++) {
    const mid = (lo + hi) / 2, s = simulate(mid, dist)
    if (!s || s.y < dy) lo = mid; else hi = mid
  }
  const pitch = (lo + hi) / 2
  const s = simulate(pitch, dist)
  return { pitch, ticks: s ? s.ticks : 0 }
}

// from: eye position; target: aim point; vel: target velocity in blocks/second (zero for standing mobs).
// Returns { yaw, pitch, ticks } in mineflayer convention (yaw 0 = looking +z... computed with atan2(-dx, -dz)), or null if out of range.
function solveAim(from, target, vel = { x: 0, y: 0, z: 0 }) {
  let tx = target.x, ty = target.y, tz = target.z, res = null
  for (let k = 0; k < 3; k++) {
    const dx = tx - from.x, dz = tz - from.z, dy = ty - from.y
    const dist = Math.hypot(dx, dz)
    const s = solvePitch(dist, dy)
    if (!s) return null
    res = { yaw: Math.atan2(-dx, -dz), pitch: s.pitch, ticks: s.ticks }
    const sec = s.ticks / 20                          // lead the target by the flight time
    tx = target.x + vel.x * sec; ty = target.y + (vel.y || 0) * sec * 0; tz = target.z + vel.z * sec
  }
  return res
}

const bowItem = (items) => items.find(i => i.name === 'bow') || null
const arrowCount = (items) => items.filter(i => /(^|_)arrow$/.test(i.name)).reduce((s, i) => s + i.count, 0)

module.exports = { V0, G, DRAG, FULL_DRAW_MS, simulate, solvePitch, solveAim, bowItem, arrowCount }
