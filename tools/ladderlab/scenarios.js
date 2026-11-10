// Ladder scenario fixtures. Every scenario builds a small world, gives the bot a start position and an inventory, and names the goal cell.
// Geometry: ground is stone at y=63 (standing level 64). The ladder column is (X, Z) = (5, 0) with its wall behind it at z=-1, so the ladder
// faces south. `T` is the standing level of the top. Kinds:
//   climb     a complete ladder: reach the goal; metrics are time and bobbing (how far the bot moves up and down for the rise it makes)
//   complete  an incomplete ladder: reach the goal with the fewest placed blocks given the starting inventory (`optimal` placements)
const X = 5, Z = 0, FLOOR = 63

function ground(s) { s.floor(-8, -8, 18, 8, FLOOR) }
// stone mass around the shaft column; the column itself is carved (air) from y0 to y1 and `ladders` fills the ladder cells
function mass(s, x0, z0, x1, z1, y0, y1) { s.fill(x0, y0, z0, x1, y1, z1, 'stone') }
function ladders(s, y0, y1, skip = []) { for (let y = y0; y <= y1; y++) if (!skip.includes(y)) s.set(X, y, Z, 'ladder', { facing: 'south', waterlogged: false }) }

// a closed 1x1 shaft in stone (the iron mine shaft): entry from the south at the bottom, the top opens to a surface at standing level T
function shaft(s, T, { skip = [], from = 64, open = [] } = {}) {
  ground(s)
  mass(s, 3, -1, 7, 1, 64, T - 1)
  s.fill(X, 64, Z, X, T - 1, Z, 'air'); s.fill(X, 64, 1, X, 65, 1, 'air')
  for (const [side, y0, y1] of open) { const dx = side === 'W' ? -1 : side === 'E' ? 1 : 0; s.fill(X + dx, y0, Z, X + dx, y1, Z, 'air'); if (side === 'WE') s.fill(X - 1, y0, Z, X + 1, y1, Z, 'air') }
  ladders(s, from, T - 1, skip)
}
// a ladder on the south face of a free standing stone tower: air on both sides and in front
function tower(s, T, { skip = [], from = 64 } = {}) {
  ground(s)
  mass(s, 3, -4, 7, -1, 64, T - 1)
  ladders(s, from, T - 1, skip)
}

const S = []
const add = (o) => { S.push(o); return o }

// ---------------- complete ladders ----------------
add({ name: 'shaft-up', kind: 'climb', build: s => shaft(s, 76), start: [X + .5, 64, 2.5], goal: [X, 76, 1], note: 'stone shaft, 12 rungs, enter from the front at the bottom' })
add({ name: 'shaft-down', kind: 'climb', build: s => shaft(s, 76), start: [X + .5, 76, 1.5], goal: [X, 64, 1], note: 'down the same shaft: do nothing and slide' })
add({ name: 'tower-up', kind: 'climb', build: s => tower(s, 76), start: [X + .5, 64, 3.5], goal: [X, 76, -1], note: 'ladder free in the air on the face of a stone tower' })
add({ name: 'tower-down', kind: 'climb', build: s => tower(s, 76), start: [X + .5, 76, -2.5], goal: [X, 64, 1], note: 'down the face of the tower' })
add({ name: 'tower-from-side', kind: 'climb', build: s => tower(s, 72), start: [-1.5, 64, 0.5], goal: [X, 72, -1], note: 'approach the tower ladder from the side' })
add({ name: 'jump-onto-1', kind: 'climb', build: s => tower(s, 72, { from: 65 }), start: [X + .5, 64, 2.5], goal: [X, 72, -1], note: 'the first rung is one block above the floor: jump onto it' })
add({ name: 'jump-onto-1-shaft', kind: 'climb', build: s => shaft(s, 72, { from: 65 }), start: [X + .5, 64, 2.5], goal: [X, 72, 1], note: 'same inside a stone shaft' })
add({ name: 'side-gaps-left', kind: 'climb', build: s => shaft(s, 76, { open: [['W', 68, 70]] }), start: [X + .5, 64, 2.5], goal: [X, 76, 1], note: 'the shaft wall is open to the west for three blocks (a cave beside the ladder)' })
add({ name: 'side-gaps-right', kind: 'climb', build: s => shaft(s, 76, { open: [['E', 68, 70]] }), start: [X + .5, 64, 2.5], goal: [X, 76, 1], note: 'open to the east' })
add({ name: 'side-gaps-both', kind: 'climb', build: s => shaft(s, 76, { open: [['WE', 68, 70]] }), start: [X + .5, 64, 2.5], goal: [X, 76, 1], note: 'open on both sides' })
add({ name: 'ledge-down-side', kind: 'climb', build: s => { shaft(s, 76, { open: [['WE', 68, 70]] }) }, start: [X + .5, 76, 1.5], goal: [X, 64, 1], note: 'descend past side openings' })

// ---------------- incomplete ladders ----------------
// `optimal` = the fewest blocks that can finish the job from the starting inventory (ladders and backing blocks both count); worked out by hand:
// every column cell from the one above the bot's floor up to the one below the exit level needs a ladder (the first one is a jump away from the ground),
// and a cell whose wall is open needs one more block for the ladder to hang on.
function range(a, b) { const o = []; for (let i = a; i <= b; i++) o.push(i); return o }
const C = (o) => add({ kind: 'complete', start: [X + .5, 64, 3.5], goal: [X, 76, -1], ...o })
for (const k of [1, 2, 3]) C({ name: 'top-short-' + k, build: s => tower(s, 76, { skip: range(76 - k, 75) }), inv: { ladder: 6 }, optimal: k, note: `the top ${k} rung(s) are missing` })
C({ name: 'mid-gap-1', build: s => tower(s, 76, { skip: [70] }), inv: { ladder: 4 }, optimal: 1, note: 'one rung missing in the middle (a bot on the rung below cannot reach the next)' })
C({ name: 'mid-gap-3-spare', build: s => tower(s, 76, { skip: [68, 69, 70] }), inv: { ladder: 9, cobblestone: 20 }, optimal: 3, note: 'three missing, plenty of material: still 3 blocks' })
C({ name: 'bottom-gap-2', build: s => tower(s, 76, { from: 66 }), inv: { ladder: 3 }, optimal: 1, note: 'the ladder starts two blocks up: one rung placed, the jump does the rest' })
C({ name: 'bottom-gap-1', build: s => tower(s, 76, { from: 65 }), inv: {}, optimal: 0, note: 'the ladder starts one block up: a jump onto it, no material' })
C({ name: 'shaft-gap-2', goal: [X, 76, 1], build: s => shaft(s, 76, { skip: [66, 67] }), inv: { ladder: 5 }, optimal: 2, note: 'closed shaft, two rungs missing' })
C({ name: 'wall-open-1', build: s => { tower(s, 76, { skip: [70, 71] }); s.clear(X, 70, -1) }, inv: { ladder: 3, cobblestone: 3 }, optimal: 3, note: 'two rungs missing and the wall behind the lower one is open: 2 ladders + 1 backing block' })
C({ name: 'wall-open-tall', build: s => { tower(s, 76, { skip: [70, 71, 72] }); s.fill(X, 70, -1, X, 71, -1, 'air') }, inv: { ladder: 3, cobblestone: 4 }, optimal: 5, note: 'the wall is open for two of three missing cells' })
C({ name: 'short-of-ladders', build: s => tower(s, 76, { skip: [70, 71, 72] }), inv: { ladder: 2 }, optimal: null, expectFail: true, note: 'three missing, two ladders in the bag: it must say so, place nothing and not bob' })
C({ name: 'open-sides-gap', goal: [X, 76, -1], build: s => { tower(s, 76, { skip: [72] }); s.fill(X - 1, 72, 0, X - 1, 72, 0, 'air') }, inv: { ladder: 2 }, optimal: 1, note: 'ladder free in the air with open sides and a gap' })


// ---------------- more shapes ----------------
add({ name: 'exit-side', kind: 'climb', build: s => { tower(s, 79); s.fill(X + 1, 75, Z, X + 3, 75, Z, 'stone') }, start: [X + .5, 64, 3.5], goal: [X + 1, 76, Z], note: 'the rungs run on above a side ledge: step off sideways at its level' })
add({ name: 'down-gap-2', kind: 'climb', build: s => tower(s, 76, { skip: [70, 71] }), start: [X + .5, 76, -2.5], goal: [X, 64, 1], note: 'descend past a two block hole in the rungs (falls 2 onto the lower ones: no damage)' })

module.exports = { S, X, Z, FLOOR, tower, shaft, ground, mass, ladders, range }
