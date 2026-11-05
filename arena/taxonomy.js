// Brain (strategy) and Eval (wave schedule + kit) are separate dimensions. Every result row maps to exactly one brain and one eval.
// Works in node (require) and in the browser (<script src="/taxonomy.js">, exposes window.TAX).
(function (root) {
  const WALL_TS = '2026-10-26T22:54:00'
  const NAVFIX_TS = '2026-10-27T04:03:00'
  const BASE = { shieldSkel: true, critJump: false, attackTicks: 10 }          // "fastswing" (v5b): sprint-hit, shield vs skeletons, 10-tick swings
  const LEGACY = {                                                              // earlier generations whose code differs, so params alone cannot name them
    'na-v1': 'v1-base', 'na-v2': 'v2-guard+skelfirst', 'na-v3a-shieldskel': 'v3a-skelshield', 'na-v3b-shieldskel+melee': 'v3b-skelshield+meleeshield',
    'na-v4a-eatmore': 'v4a-skelshield+eat', 'na-v5a-nocrit': 'v5a-nocrit', 'base': 'v1-base', 'v1b': 'v1-base'
  }
  const EVALS = {
    orig: { name: 'Original waves', desc: 'wave every 10s, +0.7 mobs per wave; best bot dies in ~90s' },
    'orig-armor': { name: 'Original waves, iron armor', desc: 'same waves, full iron armor kit' },
    H1: { name: 'H1', desc: 'every 7s, +1 per wave (calibration)' }, H2: { name: 'H2', desc: 'every 6s, +1.4 per wave (calibration)' },
    H3: { name: 'H3', desc: '5 mobs at 3s, every 4s, +2 per wave; fastswing dies in ~22s' }, H4: { name: 'H4', desc: 'every 5s, +1.6 per wave (calibration)' },
    H5: { name: 'H5 steady A', desc: '8 at 3s, then 2 every 2s, ceiling 40' }, H6: { name: 'H6 steady B', desc: '8 at 3s, then 3 every 2s, ceiling 40' },
    'COURSE-none': { name: 'Obstacle course: difficulty 0 (no mobs, navigation only)', desc: 'white block to red block, navigation only; Score = progress % + finish bonus' },
    'COURSE-R1': { name: 'Obstacle course: start-room stress test (11 mobs, room 1 only)', desc: 'only the start-room pack (14 mobs)' },
    'COURSE-E1': { name: 'Obstacle course: difficulty 1', desc: 'difficulty ladder tier 1: 28 mobs spread evenly along the route (about 3 zombies + 1 skeleton per section); Score = progress % + finish bonus - damage' },
    'COURSE-E1-cap150': { name: 'Obstacle course: difficulty 1 (150s time cap, retired)', desc: 'runs with the old 150s cap: slow survivors run out of time at ~78%' },
    'COURSE-E1-oldnav': { name: 'Obstacle course: difficulty 1 (before the tower nav fix)', desc: 'runs before the glass-tower navigation fix: most surviving runs stall at ~78% progress' },
    'COURSE-R1-oldnav': { name: 'Obstacle course: start-room stress test (before nav fix)', desc: 'retired' },
    'COURSE-E2': { name: 'Obstacle course: difficulty 2', desc: 'ladder tier 2: tier 1 doubled (56 mobs, evenly spread)' },
    'COURSE-E3': { name: 'Obstacle course: difficulty 3', desc: 'ladder tier 3: tier 1 tripled (84 mobs, evenly spread)' },
    'COURSE-T1': { name: 'Obstacle course: old uneven layout (retired)', desc: 'white block to red block with 34 fixed mobs (14 in room 1); Score = progress % + finish bonus - damage' },
    W7: { name: 'Walled arena W7', desc: 'steady pressure (14 at 2s, then 4 every 2s, ceiling 50) inside a 60x100 purple terracotta barrier; new eval since 22:54Z' },
    H7: { name: 'Eval H (H7)', desc: 'steady pressure: 14 at 2s, then 4 every 2s, ceiling 50; fastswing dies in ~14s' }
  }
  function evalOf(r) {
    if (r.course) return 'COURSE-' + r.course.mobs + (r.ts && r.ts < NAVFIX_TS && r.course.mobs !== 'none' ? '-oldnav' : (r.course.mobs !== 'none' && (r.course.cap || 150) < 240 ? '-cap150' : ''))   // runs before the glass-tower navigation fix stall at ~78%
    const k = r.kit || {}; let e = 'orig'
    const wc = r.waveCfg || null, lb = r.label || ''
    if (k.armor !== false) e = 'orig-armor'
    else if (/^h7-/.test(lb) || (wc && wc.firstCount === 14)) e = 'H7'
    else if (wc && wc.firstCount === 8) e = wc.base === 2 ? 'H5' : 'H6'
    else if (/^h([1-6])-/.test(lb)) e = 'H' + lb[1]
    else if (/^h-/.test(lb)) e = 'H3'
    else if (wc && wc.every === 4 && wc.base === 5) e = 'H3'
    if (k.scramble) e += '-scrambled'
    if (r.ts && r.ts >= WALL_TS && e === 'H7') e = 'W7'   // since the purple terracotta barrier went up (~22:54Z) the steady-pressure arena is its own eval
    else if (r.ts && r.ts >= WALL_TS) e += '-walled'
    return e
  }
  const TAGS = [
    [(p) => p.bow === false, 'nobow'], [(p) => p.strafe === false, 'nostrafe'], [(p) => p.backAfterHit === 0, 'noback'],
    [(p) => p.shieldMeleeHealth === 21, 'meleeshield'], [(p) => p.attackTicks !== undefined && p.attackTicks !== 10, (p) => 'swing' + p.attackTicks],
    [(p) => p.bowAggroOnly, 'aggro-only'], [(p) => p.creeperPreShield === false && !p.creeperOnFuse, 'creeper-fuseshield'],
    [(p) => p.creeperOnFuse, (p) => 'creeper-' + p.creeperOnFuse], [(p) => p.targetMode && p.targetMode !== 'nearest', (p) => 'target-' + p.targetMode],
    [(p) => p.shieldVerify, 'shieldverify'], [(p) => p.skeletonFirst === false, 'no-skelfirst'], [(p) => p.approachRange !== undefined, 'hold-ground'],
    [(p) => p.retreatHealth === 0, 'no-retreat'], [(p) => p.eatFood !== undefined && p.eatHealth !== 12, 'eatmore'], [(p) => p.eatHealth === 12 && p.eatFood === -1, 'eat-critical'],
    [(p) => p.crowdEvadeN, (p) => 'evade' + p.crowdEvadeN + (p.evadeRepulse ? 'r' : '') + (p.retreatTicks > 14 ? 'long' : '')],
    [(p) => p.kiteN, (p) => 'kite' + p.kiteN], [(p) => p.fireTrap, 'firetrap'], [(p) => p.disengageEat, 'disengage-eat'],
    [(p) => p.wallAware, 'wallaware'], [(p) => p.glassBlocksLos, 'glassLOS'], [(p) => p.openMin, (p) => 'open' + p.openMin], [(p) => p.routeWeight, (p) => 'route' + p.routeWeight], [(p) => p.kiteMode === 'gap', 'gap'], [(p) => p.encircleEscape, (p) => 'encircle' + (p.encQuads && p.encQuads !== 3 ? '-q' + p.encQuads : '') + (p.encMinMobs && p.encMinMobs !== 4 ? '-n' + p.encMinMobs : '') + (p.encGap !== undefined && p.encGap !== 50 ? '-g' + p.encGap : '') + (p.encRange && p.encRange !== 10 ? '-r' + p.encRange : '') + (p.encTicks && p.encTicks !== 20 ? '-t' + p.encTicks : '')], [(p) => p.creeperShieldKite, 'cshieldkite'],
    [(p) => p.creeperShieldAlone, 'creeper-shield-alone'], [(p) => p.organize, 'organize']
  ]
  function brainOf(r) {
    if (r.brain) return r.brain
    if (LEGACY[r.label]) return LEGACY[r.label]
    const p = r.params || {}, t = []
    for (const [test, name] of TAGS) if (test(p)) t.push(typeof name === 'function' ? name(p) : name)
    return t.length ? 'fastswing+' + t.join('+') : 'fastswing'
  }
  const api = { BASE, EVALS, evalOf, brainOf, REF: 'fastswing' }
  if (typeof module !== 'undefined' && module.exports) module.exports = api; else root.TAX = api
})(typeof window !== 'undefined' ? window : this)
