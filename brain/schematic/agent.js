// brain/schematic/agent.js: the schematic agent. A model builds a schematic in a block workspace (workspace.js) from a request in words, and the result is filed straight into
// the catalog the bots build from (store.js, variants.js). Walter 2026-11-11: "build the agent into the Schematics page so that the output can go directly to the in-game
// schematics catalog", and the loop / bots may call it too (agentstore.js: capped at 25 bot requests a day to start).
//
//   runRequest(request, ctx)   one request -> { ok, result: { schematicId, variantId, ... } } | { ok: false, error }
//     ctx: { sharedDir, dirs, agent, cwd?, claudePath?, signal?, onCall?, log?, now? }
//     `agent` is reviewer/lib/claude.js runAgent (the Claude Agent SDK on the Claude login of this computer, no API key); a test hands in a fake that calls the tools itself.
//
// What the model can do is only what the tools below allow: they change the workspace and read the catalog. No file, shell, web or network access.
// What kinds of request there are (agentstore.js): new (a schematic that is not in the catalog), variant (another version of one that is: the base variant is opened and
// changed, the result is filed next to it), edit (change one variant in place; people only, the old file is kept in history/).
'use strict'
const fs = require('fs')
const path = require('path')
const S = require('./store')
const V = require('./variants')
const W = require('./workspace')
const AS = require('./agentstore')

const SERVER = 'schem'
const SYSTEM = `You design Minecraft 1.21.6 builds as SCHEMATICS: block-by-block descriptions that go into a catalog. Survival bots in a shared world build from the functional ones, and people look at all of them as a textured 3D model on a dashboard page. Make something good: a build that looks intentional and that a player would be glad to find.

You work in a block WORKSPACE through tools; you have no other way to act. Coordinates are whole numbers from the workspace's own corner: x east, y UP, z south, all counted from 0. Check your work as you go with view_slice (a text picture of a layer or cut) and summary; build, look, fix.

How to work
1. Read the request. Decide the size, the material palette and the style before placing anything. Keep the build a sensible size for what it is (a hut is about 7x6x7, a farm tens of blocks, a castle may be big) and do not go beyond what was asked.
2. New build: start_workspace with the size (leave a little room around the build for fences, steps, overhangs). Edit or variant: the base is ALREADY OPEN in the workspace (see the opening message); change it, keep everything the request does not touch, and add what it needs in the free room around it (grow adds more on the +x, +y, +z sides if that is not enough).
3. Build large to small: foundation and floor, walls, roof, then openings (door, windows), then details and light. Use fill (solid, hollow, walls, frame, floor, ceiling), shape (cylinder, sphere, dome), copy_region (with mirror and rotate for the other half or the other three sides of a symmetric build), replace_blocks and set_blocks. Put many blocks in one call.
4. View at least the floor layer, a mid layer and a cut through the middle before you finish. Run summary: it lists what is wrong in the usual ways (torches with nothing under them, doors with one half, pieces that float). Fix every real problem.
5. Finish with your answer (the JSON the system asks for). The build is saved from the workspace as it is when you answer.

Modes (choose at start_workspace for a new build)
- aesthetic: built for looks (houses, towers, statues, gardens, bridges). Every block is wanted exactly as placed, air stays air. Background is air.
- functional: a working structure for the bots (a farm, a mine room, storage, a mob farm). Background is ROCK (stone) you carve out with air; or ask background "air" for a surface build. Any wall that is plain solid stone-like block is stored as "any solid block": use cobblestone, stone, bricks and so on freely, but anything with a function (slabs, trapdoors, hoppers, chests, water, torches, ladders, rails, doors) is stored exactly, so place those on purpose. Water: place SOURCE blocks (block "water", props level "0"); flowing water is made by the game.
Never use lava unless the request asks for it. Beds are not supported (leave room for one). Block entities (chest contents, sign text) are not stored.

Blocks and properties (only these properties are kept: facing, half, type, open, level, hinge, axis, face, attached, shape; others such as waterlogged or powered are ignored, and a wrong value is refused with the allowed ones)
- Names are 1.21.6 ids with or without "minecraft:" (oak_planks, stone_bricks, glass_pane, oak_stairs ...). Air is "air".
- stairs: facing = the direction you walk UP (the tall back side is that way); half bottom or top. A roof on the north side of a ridge that runs east-west is facing "south" (it rises toward the south). shape straight unless you build a corner (inner_left, outer_right ...).
- slabs: type bottom, top or double. logs and pillars: axis x, y or z.
- doors: set_blocks places both halves of a door or tall plant if you give the lower position and no "half"; facing = the direction a person walks to go in through it; open "false" normally. trapdoors: facing, half, open.
- torch (on the floor, needs a block under it); wall_torch facing = the direction it points AWAY from the wall (a wall_torch with facing north hangs on the block to its south); lantern; ladder facing = the direction it faces away from the wall; chest / furnace / barrel / hopper / dispenser facing = the way their front or output looks (a hopper: down or a side).
- fences, walls and glass panes connect to their neighbours by themselves: just place them.
- Light: the bots need lit buildings so mobs do not spawn: put torches or lanterns inside and by the door (block light under 1 spawns mobs).

Good builds: three to five materials with some texture (logs for the frame, planks or bricks for the walls, stairs and slabs for roof, trim and steps), windows that are not flat rows, roofs that overhang, a door with a step or path, a floor that differs from the wall, symmetry where it suits and a deliberate break where it does not. Functional builds: nothing the bots cannot reach, every open space the design needs actually open, a clear way in.

If the request is unclear, choose the most likely reading and say which in the answer's notes; do not ask questions (nobody is there to answer). If it cannot be built as a schematic, still build the closest thing and say what you left out.

ANSWER (the JSON): id (lowercase words with dashes, specific, e.g. "oak-cottage-with-garden"; ignored for edit and variant), name (a title), kind (one word: house, tower, farm, mobfarm, wall, bridge, statue, storage, mine, room, ...), category (the shelf it goes on: one lowercase word, preferably one of house, farm, mobfarm, base, room, tower, wall, bridge, statue, garden, storage, mine, tunnel; or another single word if none fits), tags (3 to 8 lowercase words), purpose (one or two sentences: what it is and how it works), variantName and variantDescription (for a variant: what is different; otherwise leave empty), notes (things worth knowing: assumptions made, what is not included, how to use it), summary (one or two sentences on what you built). For an edit or a variant, leave name, kind, category, tags and purpose empty unless they should change.`

const SCHEMA = {
  type: 'object',
  required: ['id', 'name', 'kind', 'summary'],
  properties: {
    id: { type: 'string' }, name: { type: 'string' }, kind: { type: 'string' }, category: { type: 'string' },
    tags: { type: 'array', items: { type: 'string' } }, purpose: { type: 'string' },
    variantName: { type: 'string' }, variantDescription: { type: 'string' },
    notes: { type: 'array', items: { type: 'string' } }, summary: { type: 'string' },
  },
}

const short = (s, n) => { s = String(s == null ? '' : s); return s.length > n ? s.slice(0, n - 1) + '…' : s }
const plural = (n, w) => `${n} ${w}${n === 1 ? '' : 's'}`

// The tools. `st.ws` is the workspace (null until start_workspace for a new build). Every handler returns text; a refusal says what was wrong and what would work.
function buildTools(st, ctx) {
  const need = () => (st.ws ? null : 'There is no workspace yet: call start_workspace first.')
  const done = (r, extra = '') => (r.error ? `ERROR: ${r.error}` : `ok${r.placed != null ? `: ${plural(r.placed, 'block')} placed` : ''}${r.replaced != null ? `: ${plural(r.replaced, 'block')} replaced` : ''}${r.copied != null ? `: ${plural(r.copied, 'block')} copied` : ''}${r.note ? ` (${r.note})` : ''}${r.ignored && r.ignored.length ? ` (ignored properties a schematic does not keep: ${r.ignored.join(', ')})` : ''}${extra}`)
  const vec = (z) => z.array(z.number().int()).length(3)
  const props = (z) => z.record(z.string(), z.union([z.string(), z.number(), z.boolean()])).optional()
  return [
    { name: 'start_workspace', description: 'Begin a NEW build: an empty workspace of width (x) by height (y) by depth (z). mode "aesthetic" (built for looks, background air) or "functional" (a working structure; background "rock" = solid stone to carve out, or "air" for a surface build). Not available when a base schematic is already open.',
      shape: (z) => ({ width: z.number().int().min(1), height: z.number().int().min(1), depth: z.number().int().min(1), mode: z.enum(['aesthetic', 'functional']), background: z.enum(['rock', 'air']).optional() }),
      handler: async (a) => {
        if (st.ws) return 'ERROR: a workspace is already open (' + st.ws.size.join(' x ') + ', ' + st.ws.mode + '). Change it with the other tools (grow makes it bigger).'
        try { st.ws = new W.Workspace({ size: [a.width, a.height, a.depth], mode: a.mode, background: a.background }) } catch (e) { return 'ERROR: ' + e.message }
        return `ok: workspace ${a.width} x ${a.height} x ${a.depth} (x 0..${a.width - 1}, y 0..${a.height - 1}, z 0..${a.depth - 1}), mode ${st.ws.mode}${st.ws.background === 'rock' ? ', background rock (stone)' : ', background air'}`
      } },
    { name: 'grow', description: 'Make the workspace bigger by these amounts on the +x, +y, +z sides (existing blocks stay where they are).',
      shape: (z) => ({ x: z.number().int().min(0).optional(), y: z.number().int().min(0).optional(), z: z.number().int().min(0).optional() }),
      handler: async (a) => need() || (() => { const r = st.ws.grow(a); return r.error ? 'ERROR: ' + r.error : `ok: the workspace is now ${r.size.join(' x ')}` })() },
    { name: 'set_blocks', description: 'Place single blocks: a list of {x, y, z, block, props?}. Up to 2000 per call. A door (or tall plant) given without "half" is placed as both halves, the lower one at y.',
      shape: (z) => ({ blocks: z.array(z.object({ x: z.number().int(), y: z.number().int(), z: z.number().int(), block: z.string(), props: props(z) })).min(1).max(2000) }),
      handler: async (a) => {
        const n = need(); if (n) return n
        let placed = 0; const errors = [], ignored = new Set()
        for (const b of a.blocks) { const r = st.ws.set(b.x, b.y, b.z, b.block, b.props); if (r.error) { if (errors.length < 8) errors.push(`(${b.x}, ${b.y}, ${b.z}) ${r.error}`) } else { placed += r.placed; for (const i of r.ignored || []) ignored.add(i) } }
        return `${errors.length ? `${errors.length === 8 ? 'at least 8' : errors.length} block(s) were REFUSED:\n- ${errors.join('\n- ')}\n` : ''}ok: ${plural(placed, 'block')} placed${ignored.size ? ` (ignored properties a schematic does not keep: ${[...ignored].join(', ')})` : ''}`
      } },
    { name: 'fill', description: 'Fill a box from corner "from" to corner "to" (both inclusive, any order) with one block. style: solid (every cell), hollow (the six faces), walls (the four sides, no floor or ceiling), frame (the twelve edges), floor (the lowest layer), ceiling (the top layer). only: replace only cells that hold this block now ("air" for open cells). Fill with block "air" to carve out. Doors and tall plants go through set_blocks.',
      shape: (z) => ({ from: vec(z), to: vec(z), block: z.string(), props: props(z), style: z.enum(['solid', 'hollow', 'walls', 'frame', 'floor', 'ceiling']).optional(), only: z.string().optional() }),
      handler: async (a) => need() || done(st.ws.fill(a.from, a.to, a.block, a.props, { style: a.style, only: a.only })) },
    { name: 'shape', description: 'Place a cylinder (centre of its base [x, y, z], radius, height; stands on y), a sphere (centre, radius) or a dome (the upper half of a sphere, centre = the middle of its flat base). hollow: only a one-block shell (a hollow cylinder has no floor or roof unless caps is true).',
      shape: (z) => ({ kind: z.enum(['cylinder', 'sphere', 'dome']), center: vec(z), radius: z.number().int().min(1).max(100), height: z.number().int().min(1).optional(), block: z.string(), props: props(z), hollow: z.boolean().optional(), caps: z.boolean().optional(), only: z.string().optional() }),
      handler: async (a) => need() || done(st.ws.shape(a)) },
    { name: 'replace_blocks', description: 'Every cell holding block "from" (optionally only with these from_props) becomes block "to" (with to_props). box [[x,y,z],[x,y,z]] limits it to part of the workspace.',
      shape: (z) => ({ from: z.string(), to: z.string(), to_props: props(z), from_props: props(z), box: z.array(vec(z)).length(2).optional() }),
      handler: async (a) => need() || done(st.ws.replace(a.from, a.to, a.to_props, { box: a.box, fromProps: a.from_props })) },
    { name: 'copy_region', description: 'Copy the box from..to to another place: offset [dx, dy, dz] moves it. rotate 0, 90, 180 or 270 degrees clockwise seen from above (about the box\'s own corner: the result then sits at the box\'s lowest corner plus offset), mirror "x" (flip east-west) or "z" (flip north-south) before that. Stairs, doors, torches, ladders and chests keep facing the right way. skip_air (default true) leaves the target alone where the source is air. Check the result with view_slice.',
      shape: (z) => ({ from: vec(z), to: vec(z), offset: vec(z), rotate: z.union([z.literal(0), z.literal(90), z.literal(180), z.literal(270)]).optional(), mirror: z.enum(['x', 'z']).optional(), skip_air: z.boolean().optional() }),
      handler: async (a) => need() || done(st.ws.copy(a.from, a.to, a.offset, { rotate: a.rotate || 0, mirror: a.mirror || null, skipAir: a.skip_air !== false })) },
    { name: 'mark_scenery', description: 'Mark the blocks in a box as the natural SURROUNDINGS of the build (ground, trees, a garden bed): drawn for the picture, never checked, never counted as the build. on false makes them part of the build again.',
      shape: (z) => ({ from: vec(z), to: vec(z), on: z.boolean().optional() }),
      handler: async (a) => need() || (() => { const r = st.ws.markScenery(a.from, a.to, a.on !== false); return r.error ? 'ERROR: ' + r.error : `ok: ${plural(r.cells, 'cell')} ${a.on === false ? 'are part of the build' : 'are scenery'}` })() },
    { name: 'view_slice', description: 'A text picture of a slice. axis "y": the layer y=index seen from above (north at the top, x to the right). axis "x": the cut x=index seen from the east (y up, z to the right). axis "z": the cut z=index seen from the south (y up, x to the right). Every distinct block gets a letter (see the legend). cols and rows ([min, max]) limit part of a big slice (at most 120 x 120 cells).',
      shape: (z) => ({ axis: z.enum(['x', 'y', 'z']), index: z.number().int().min(0), cols: z.array(z.number().int()).length(2).optional(), rows: z.array(z.number().int()).length(2).optional() }),
      handler: async (a) => need() || (() => { const r = st.ws.render(a.axis, a.index, { cols: a.cols, rows: a.rows }); return r.error ? 'ERROR: ' + r.error : r.text })() },
    { name: 'summary', description: 'The workspace as it stands: size, mode, how much is built, the bounding box of the build, the blocks used (counts), and problems found (hanging things with nothing to hang on, half doors, falling blocks, floating pieces). Call it before you answer.',
      shape: () => ({}),
      handler: async () => need() || (() => {
        const ws = st.ws, c = ws.content(), counts = ws.counts().slice(0, 40), issues = ws.check()
        return [`workspace ${ws.size.join(' x ')}, mode ${ws.mode}${ws.background === 'rock' ? ', rock background' : ''}`,
          c ? `build: ${plural(c.count, 'cell')} differ from the background, bounding box (${c.lo.join(', ')}) to (${c.hi.join(', ')}), ${c.hi.map((h, i) => h - c.lo[i] + 1).join(' x ')}` : 'build: empty',
          `blocks: ${counts.map(r => `${r.name} ${r.cells}`).join(', ') || 'none'}`,
          issues.length ? `problems (${issues.length}):\n- ${issues.join('\n- ')}` : 'problems: none found'].join('\n')
      })() },
    { name: 'list_catalog', description: 'The schematics already in the catalog: id, name, kind, variants, size. query filters by a word in the id, name, kind or tags. Use it to avoid duplicating something that exists and to borrow its style.',
      shape: (z) => ({ query: z.string().optional() }),
      handler: async (a) => {
        const q = String(a.query || '').toLowerCase()
        const rows = S.listDocs(ctx.dirs).map(({ doc }) => doc).filter(d => !q || [d.id, d.name, d.kind, ...(d.tags || [])].join(' ').toLowerCase().includes(q))
        return rows.slice(0, 60).map(d => `${d.id}: ${d.name} (${d.kind}${d.category ? ', ' + d.category : ''}) variants: ${d.variants.map(v => `${v.id} ${v.size.join('x')}`).join(', ')}`).join('\n') + (rows.length > 60 ? `\n... and ${rows.length - 60} more (narrow with query)` : '') || 'nothing matches'
      } },
    { name: 'peek_schematic', description: 'Look at a slice of a schematic that is in the catalog, as view_slice does for your workspace (same axis, index, cols, rows), to borrow its design or match its style. variant defaults to its main one. Does not change your workspace.',
      shape: (z) => ({ id: z.string(), variant: z.string().optional(), axis: z.enum(['x', 'y', 'z']), index: z.number().int().min(0), cols: z.array(z.number().int()).length(2).optional(), rows: z.array(z.number().int()).length(2).optional() }),
      handler: async (a) => {
        const s = S.load(ctx.dirs, a.id, a.variant); if (!s) return `ERROR: no schematic "${a.id}"`
        let ws; try { ws = W.Workspace.fromSchematic(s) } catch (e) { return 'ERROR: ' + e.message }
        const r = ws.render(a.axis, a.index, { cols: a.cols, rows: a.rows }); return r.error ? 'ERROR: ' + r.error : `${s.name} (${s.variantName}), ${s.size.join(' x ')}\n${r.text}`
      } },
  ]
}

function openingPrompt(req, base) {
  const lines = [`REQUEST (from ${req.by}): ${req.prompt}`, '']
  if (req.kind === 'new') lines.push('This is a NEW schematic. Start with start_workspace.')
  else {
    const ws = base.ws
    lines.push(`This is ${req.kind === 'edit' ? 'an EDIT of' : 'a new VARIANT of'} the schematic "${base.doc.name}" (id ${base.doc.id}, ${base.doc.kind}). Its variant "${base.variant.variantName}" is open in the workspace: ${ws.size.join(' x ')}, mode ${ws.mode}.`)
    lines.push(req.kind === 'edit' ? 'Change what the request asks for and keep the rest as it is. The result replaces that variant.' : 'Make the version the request describes from this one; the result is filed as an additional variant next to it. Give it a variantName and variantDescription.')
    const counts = ws.counts().slice(0, 15), c = ws.content()
    lines.push(`The workspace has ${ws.margin || 0} cells of free room all round the build${c ? `: the build occupies (${c.lo.join(', ')}) to (${c.hi.join(', ')})` : ''}.`)
    lines.push(`It holds ${c ? plural(c.count, 'cell') : 'nothing'}: ${counts.map(r => `${r.name} ${r.cells}`).join(', ')}. Use view_slice to look at it.`)
    if (base.variant.notes && base.variant.notes.length) lines.push('Its notes: ' + base.variant.notes.join(' | '))
  }
  lines.push('', 'Build it, check it with view_slice and summary, then answer.')
  return lines.join('\n')
}

const idFrom = (s) => S.safeId(s).slice(0, 48)
const uniqueId = (ids, want) => { let id = want || 'schematic', n = 2; while (ids.has(id)) id = `${want}-${n++}`; return id }
// the shelf a schematic goes on, as the catalog names them (lowercase, singular: "Houses" and "house" are the same shelf)
const SHELVES = { houses: 'house', farms: 'farm', 'mob-farms': 'mobfarm', mobfarms: 'mobfarm', 'mob-farm': 'mobfarm', bases: 'base', rooms: 'room', towers: 'tower', walls: 'wall', bridges: 'bridge', statues: 'statue', gardens: 'garden', mines: 'mine', tunnels: 'tunnel' }
const normCategory = (c) => { const k = S.safeId(String(c || '')).slice(0, 24); return SHELVES[k] || k || undefined }
const cleanList = (a, n, len) => (Array.isArray(a) ? a.map(x => short(String(x).trim(), len)).filter(Boolean).slice(0, n) : [])

// the model is done: file the workspace into the catalog
function finish(req, st, answer, ctx, runInfo) {
  const now = ctx.now ? ctx.now() : Date.now(), ws = st.ws
  if (!ws) return { ok: false, error: 'the model finished without building anything' }
  const sharedDir = ctx.sharedDir, outDir = path.join(sharedDir, 'schematics')
  const existing = req.kind === 'new' ? null : S.loadDoc(ctx.dirs, req.target.id)
  if (req.kind !== 'new' && !existing) return { ok: false, error: `the schematic "${req.target.id}" is gone` }
  const ids = new Set(S.listDocs(ctx.dirs).map(e => e.doc.id))
  const id = req.kind === 'new' ? uniqueId(ids, idFrom(answer.id) || idFrom(answer.name) || 'schematic') : existing.doc.id
  const name = short(answer.name, 80).trim() || (existing && existing.doc.name) || id
  const notes = [...cleanList(answer.notes, 8, 300)]
  const source = { world: 'schematic agent', save: null, capturedAt: new Date(now).toISOString(), by: `${req.model} (${req.effort}) for ${req.by}`, request: req.id, prompt: short(req.prompt, 300) }
  const flat = ws.toSchematic({ id, name, kind: short(answer.kind, 24).trim() || 'build', purpose: short(answer.purpose, 400), source, notes })
  if (flat.error) return { ok: false, error: flat.error }
  let doc, variantId
  if (req.kind === 'new') {
    doc = V.newDoc(flat, { category: normCategory(answer.category), tags: cleanList(answer.tags, 8, 24).map(t => t.toLowerCase()) })
    variantId = V.MAIN
  } else {
    doc = { ...existing.doc }
    const r = req.kind === 'edit'
      ? V.withVariant(doc, flat, { id: req.target.variant || doc.defaultVariant, replace: true, description: answer.variantDescription ? short(answer.variantDescription, 300) : undefined })
      : V.withVariant(doc, flat, { name: short(answer.variantName, 40).trim() || 'Variant', description: short(answer.variantDescription, 300) })
    doc = r.doc; variantId = r.variantId
    // the schematic's own details change only when the model says so
    if (answer.name && answer.name.trim()) doc.name = name
    if (answer.kind && answer.kind.trim()) doc.kind = short(answer.kind, 24).trim()
    if (answer.purpose && answer.purpose.trim()) doc.purpose = short(answer.purpose, 400)
    if (normCategory(answer.category)) doc.category = normCategory(answer.category)
    if (cleanList(answer.tags, 8, 24).length) doc.tags = cleanList(answer.tags, 8, 24).map(t => t.toLowerCase())
    try { const h = path.join(AS.root(sharedDir), 'history'); fs.mkdirSync(h, { recursive: true }); fs.copyFileSync(existing.file, path.join(h, `${id}-${new Date(now).toISOString().replace(/\D/g, '').slice(0, 14)}.json`)) } catch { /* the history is a courtesy */ }
  }
  const file = S.saveDoc(outDir, doc)
  const c = ws.content()
  return { ok: true, result: { schematicId: id, variantId, name: doc.name, kind: doc.kind, mode: ws.mode, size: flat.size, cells: c ? c.count : 0, file, summary: short(answer.summary, 400), issues: ws.check(6), ...runInfo } }
}

async function runRequest(req, ctx) {
  const log = ctx.log || (() => {})
  const st = { ws: null }
  let base = null
  if (req.kind !== 'new') {
    const e = S.loadDoc(ctx.dirs, req.target && req.target.id)
    if (!e) return { ok: false, error: `no schematic "${req.target && req.target.id}" in the catalog` }
    const variantId = (req.target.variant && V.find(e.doc, req.target.variant)) ? req.target.variant : e.doc.defaultVariant
    if (req.target.variant && variantId !== req.target.variant) return { ok: false, error: `${e.doc.id} has no variant "${req.target.variant}"` }
    const flat = V.project(e.doc, variantId)
    try { st.ws = W.Workspace.fromSchematic(flat, { margin: 6 }) } catch (err) { return { ok: false, error: err.message } }
    base = { doc: e.doc, variant: flat, ws: st.ws }
    req = { ...req, target: { ...req.target, variant: variantId } }
  }
  const tools = buildTools(st, ctx)
  const res = await ctx.agent({
    systemPrompt: SYSTEM, prompt: openingPrompt(req, base), schema: SCHEMA, model: req.model, effort: req.effort, cwd: ctx.cwd, claudePath: ctx.claudePath, signal: ctx.signal,
    server: SERVER, tools, builtins: [], maxTurns: 120, timeoutMs: ctx.timeoutMs || 25 * 60000,
    gate: (name) => (String(name).startsWith(`mcp__${SERVER}__`) ? { allow: true } : { allow: false, why: 'the schematic agent only has the workspace tools' }),
    onCall: ctx.onCall,
  })
  const runInfo = { costUsd: res.costUsd, turns: res.turns, durationMs: res.durationMs }
  if (!res.ok) { log(`schematic agent ${req.id}: ${res.error}`); return { ok: false, error: res.error || 'the model call failed', costUsd: res.costUsd, calls: res.calls } }
  const fin = finish(req, st, res.data || {}, ctx, runInfo)
  if (!fin.ok) return { ...fin, costUsd: res.costUsd }
  return fin
}

module.exports = { runRequest, buildTools, finish, openingPrompt, SYSTEM, SCHEMA, SERVER }
