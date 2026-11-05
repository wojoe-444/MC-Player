// The Nether side of brain/nav (Walter, 2026-10-26): travel in the Nether only along the logged safe network, never by algorithmic
// pathfinding, and ask before exploring anything new. This file wires nether.js (the log) and nether-walk.js (recording + following) into
// trips and chat commands.
//
//   planning   a Nether waypoint is reached by: (approach the nearest logged node, <= 8 blocks, straight line with live checks)
//              -> follow logged segments node to node (shortest chain) -> (short straight step to the waypoint, <= 8 blocks)
//   no route   nothing is walked; Walter is asked once: "explore the nether route" (approval) or "no". Only an approved exploration may use the
//              pathfinder in the Nether (short legs, recorded as an unverified 'bot-explore' segment that becomes verified after a second walk)
//   incidents  a segment that stopped the bot (lava beside the path, a hole, a wall, off the line) is blocked until Walter says "nether route ok"
const { dimOf } = require('./waypoints')
const { NetherNetwork, d3 } = require('./nether')
const { PathRecorder, SegmentWalker } = require('./nether-walk')
const route = require('./route')

// Known danger from the driver's notes (2026-10-26): 12 lava blocks within 16 blocks of the arrival portal at -129,61,288.
const SEED_HAZARDS = [{ kind: 'lava', x: -129, y: 61, z: 288, r: 16, note: '12 lava blocks within 16 blocks of the arrival portal (driver note 2026-10-26)', source: 'driver' }]
const LOCAL = 8                      // blocks: how far a straight, live-checked step to/from a logged node may be

module.exports = function makeNether({ api, nav, book, cfg = {}, log = () => {} }) {
  const bot = api.bot
  const network = new NetherNetwork({ file: api.statePath('nether-network.json'), now: api.now, log })
  const recorder = new PathRecorder({ bot, network, ownerName: api.ownerName, dimOf, log })
  const walker = new SegmentWalker({ bot, log })
  let pendingTrip = null              // the trip waiting for Walter's answer (kept in memory; the question itself is in the log file)
  let logWalter = cfg.logWalterWalks !== false
  let saveTicks = 0
  const lastWalked = []               // segment ids the bot walked recently (for "nether route ok")
  const _onTick = () => { if (++saveTicks % 400 === 0) network.save() }

  function seed() { try { return network.seedFromBook(book, SEED_HAZARDS) } catch (e) { log('nether seed failed: ' + e.message); return 0 } }

  // ---------- planning ----------
  // where the bot can join the network: [{ node, pts (blocks to walk first, [] = already at the node), len }]
  function startOptions(pos) {
    const snap = network.snap(pos, 4.5)
    if (snap && snap.node) return [{ node: snap.node, pts: [], len: 0 }]
    if (snap && snap.seg) {
      const s = snap.seg, i = snap.index
      const toA = s.points.slice(0, i + 1).reverse(), toB = s.points.slice(i)
      return [{ node: network.data.nodes[s.a], pts: toA, len: network.length(toA), segId: s.id }, { node: network.data.nodes[s.b], pts: toB, len: network.length(toB), segId: s.id }]
    }
    const n = network.nearestNode(pos, LOCAL)
    if (n) return [{ node: n, pts: [{ x: pos.x, y: pos.y, z: pos.z }, { x: n.x + 0.5, y: n.y, z: n.z + 0.5 }], len: d3(pos, n) }]
    return []
  }
  function targetNode(to) {
    // prefer a named node close to the waypoint, else any node within 10 blocks
    let best = null
    for (const n of network.nodes()) { const d = Math.hypot(n.x - to.x, n.z - to.z) + Math.abs(n.y - (to.y ?? n.y)) * 0.3; if (d <= 10 && (!best || d < best.d)) best = { n, d } }
    return best ? best.n : null
  }
  // pure planning: { ok, walks: [{ points, segId, reverse }], len } or { ok:false, err }
  function plan(fromPos, to) {
    seed()
    const opts = startOptions(fromPos)
    if (!opts.length) return { ok: false, err: 'I am not on a logged Nether route here' }
    const tn = targetNode(to)
    if (!tn) return { ok: false, err: 'that place is not on a logged Nether route' }
    let best = null
    for (const o of opts) {
      const r = network.route(o.node.id, tn.id)
      if (!r.ok) continue
      const total = o.len + r.length
      if (!best || total < best.total) best = { total, o, r }
    }
    if (!best) return { ok: false, err: 'no logged route to it from here', node: tn }
    const walks = []
    if (best.o.pts.length >= 2) walks.push({ points: best.o.pts, segId: best.o.segId || null, partial: true, len: best.o.len })
    for (const leg of best.r.legs) walks.push({ points: network.pointsOf(leg.seg, leg.reverse), segId: leg.seg.id, reverse: leg.reverse })
    const tail = Math.hypot(tn.x - to.x, tn.z - to.z)
    return { ok: true, walks, len: Math.round(best.total), node: tn, tail, finalPoints: tail > 1.5 && tail <= LOCAL ? [{ x: tn.x + 0.5, y: tn.y, z: tn.z + 0.5 }, { x: to.x + 0.5, y: to.y ?? tn.y, z: to.z + 0.5 }] : null }
  }

  // ---------- the question ----------
  function ask(trip, why, label) {
    pendingTrip = trip
    network.ask({ kind: 'explore', label, why })
    network.save()
    api.say(`${why} I only walk logged routes in the Nether, so I won't go. Say "explore the nether route" if you want me to try it carefully and log the way, or "no".`.slice(0, 235))
  }

  // ---------- walking ----------
  async function followWalks(ctx, walks, isAborted) {
    for (const w of walks) {
      if (isAborted()) return { ok: false, err: 'aborted' }
      await api.safehand.ensureSafeForMove().catch(() => {})
      const r = await walker.walk(w.points, { isAborted })
      if (!r.ok) {
        if (w.segId && r.err !== 'aborted' && r.err !== 'replaced') {
          network.noteBotWalk(w.segId, false, r.err)
          network.save()
          api.say(`I stopped on a logged Nether route (${r.err}) and marked it blocked until you say "nether route ok".`.slice(0, 200))
        }
        return { ok: false, err: r.err }
      }
      if (w.segId) { const seg = network.data.segments[w.segId]; if (!w.partial || (seg && w.len >= 0.6 * seg.length)) network.noteBotWalk(w.segId, true); lastWalked.push(w.segId); if (lastWalked.length > 10) lastWalked.shift() }
    }
    network.save()
    return { ok: true }
  }

  // Walk to `to` ({x,y,z}) in the Nether. trip.exploreOk lets an approved exploration use the pathfinder when no logged route exists.
  async function walkTo(ctx, to, label, trip) {
    const isAborted = () => !!(ctx && ctx.aborted)
    const p = bot.entity.position
    const pl = plan(p, to)
    if (pl.ok) {
      const r = await followWalks(ctx, pl.walks, isAborted)
      if (!r.ok) return r
      if (pl.finalPoints) {
        const f = await walker.walk(pl.finalPoints, { isAborted })
        if (!f.ok) return { ok: false, err: f.err }
      }
      return { ok: true }
    }
    if (!(trip && trip.exploreOk)) {
      ask(trip || { label, steps: [], idx: 0 }, `There's no logged Nether route to ${label} (${pl.err}).`, label)
      return { ok: false, err: 'no logged Nether route', asked: true }
    }
    return explore(ctx, to, label, isAborted)
  }

  // Approved by Walter: pathfind with short legs, record the way as an unverified segment.
  async function explore(ctx, to, label, isAborted) {
    api.say(`Exploring the Nether toward ${label}, slowly, and logging the way.`)
    recorder.botTrace = true
    let res
    try {
      res = await route.travel({ nav, bot, goals: api.goals, map: null, log, isAborted }, to, { legLen: 24, maxFailures: 4, maxLegs: 80, arriveRadius: 5, gotoOpts: { netherOk: true } })
    } finally {
      recorder.botTrace = false
      const seg = recorder.end('bot', 'exploration finished')
      network.save()
      if (seg) api.say(`Logged ${seg.length} blocks of new Nether route (${seg.hazards.length} hazards noted). It counts as verified after I have walked it twice.`.slice(0, 200))
    }
    return res.ok ? { ok: true } : { ok: false, err: res.err }
  }

  // Before a trip leaves the overworld: is there a logged way for every Nether leg? Asks Walter once if not. Returns true when the trip may go.
  function preflight(steps, label, trip) {
    for (let i = 0; i < steps.length; i++) {
      const s = steps[i]
      if (s.type !== 'walk' || s.dim !== -1) continue
      const prev = steps[i - 1]
      let from = null
      if (prev && prev.type === 'portal' && prev.arrival) from = { x: prev.arrival.x, y: prev.arrival.y ?? 64, z: prev.arrival.z }
      else if (dimOf(bot) === -1) from = bot.entity.position
      if (!from) continue
      const pl = plan(from, s.to)
      if (!pl.ok) { ask(trip, `There's no logged Nether route to ${label} (${pl.err}).`, label); return false }
    }
    return true
  }

  // ---------- commands ----------
  function summaryLine() {
    seed()
    const s = network.summary()
    return `Nether network: ${s.portals} portals, ${s.usable} usable routes (${s.blocks} blocks), ${s.unverified} unverified, ${s.blocked} blocked, ${s.hazards} hazards logged.${network.pending() ? ' Waiting for your answer about exploring.' : ''}`
  }
  function addCommands(onApprove) {
    api.commands.add({
      name: 'nether-explore-ok', help: 'explore the nether route', risk: 'high',
      match: (u, t) => !!(network.pending() && pendingTrip) && /\bexplore\b.*\b(nether|route|it|there)\b|^(yes[, ]+)?(please )?explore\b/.test(t),
      run() { const t = pendingTrip; pendingTrip = null; network.clearPending(); network.save(); onApprove(t) }
    })
    api.commands.add({
      name: 'nether-explore-no', help: 'do not explore', risk: 'low',
      match: (u, t) => !!(network.pending() && pendingTrip) && /^(no|nope|don'?t explore|do not explore|never ?mind|cancel)( the)?( nether)?( route| exploring)?$/.test(t),
      run() { pendingTrip = null; network.clearPending(); network.save(); api.say('Okay, I will not explore there.') }
    })
    api.commands.add({
      name: 'nether-route-ok', help: 'nether route ok', risk: 'high',
      match: /\bnether route\b.*\b(ok|okay|fine|safe|verified|clear)\b|\b(clear|unblock)\b.*\bnether\b.*\b(block|route)/,
      run() {
        let n = 0
        for (const s of network.segments()) if (s.blocked) { network.clearBlock(s.id); n++ }
        for (const id of lastWalked.slice(-1)) network.verify(id)
        network.save()
        api.say(n ? `Cleared ${n} blocked Nether route${n > 1 ? 's' : ''}. I will use ${n > 1 ? 'them' : 'it'} again.` : 'No Nether route is blocked.')
      }
    })
    api.commands.add({
      name: 'nether-log', help: 'log my nether walks | stop logging my nether walks', risk: 'low',
      match: /\b(stop|don'?t|do not|no more)\b.*\blogg?ing\b.*\bnether|\blog\b.*\b(my|the)\b.*\bnether\b.*\b(walks?|routes?|paths?)\b|\bstart\b.*\blogging\b.*\bnether/,
      run(u, text, t) {
        logWalter = !/\b(stop|don'?t|do not|no more)\b/.test(t)
        recorder.enabled = logWalter
        api.say(logWalter ? 'I will log the routes you walk in the Nether.' : 'I will stop logging your Nether walks.')
      }
    })
    api.commands.add({ name: 'nether-network', help: 'nether network | nether routes', risk: 'low', match: (u, t) => /\bnether\b.*\b(network|routes?|log)\b|\b(network|routes?)\b.*\bnether\b/.test(t) && !/\b(explore|ok|okay|fine|safe|verified|clear|unblock|stop|logging|walks?|no)\b/.test(t), run() { api.say(summaryLine().slice(0, 235)) } })
  }

  function start() {
    seed(); network.save()
    recorder.attach(); walker.attach(); bot.on('physicsTick', _onTick)
  }
  function stop() { bot.removeListener('physicsTick', _onTick); recorder.detach(); walker.detach(); network.save() }
  function status() { return { ...network.summary(), pending: network.pending() ? network.pending().kind : null, logging: logWalter, walking: walker.active } }

  return { network, recorder, walker, plan, walkTo, explore, preflight, addCommands, start, stop, status, ask, seed, summaryLine, get pendingTrip() { return pendingTrip } }
}
