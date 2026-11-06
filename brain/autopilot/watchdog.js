// brain/autopilot/watchdog.js: notices idling by itself, restarts the autopilot, and keeps a scoreboard (Walter: "be feverishly attentive to idleness").
//  - samples every 5 s: moved / dug / placed / crafted / inventory changed => active, else idle with a cause
//  - idle >= 60 s (not sleeping, not deliberately sheltering): logs why and kicks the autopilot (resume, release manual holds, resubmit)
//  - every 5 min writes brain/state/scoreboard.json and appends scoreboard.log
const fs = require('fs')
const path = require('path')
const { PRIORITY } = require('../scheduler')
const { holderOf } = require('../reflexes')

module.exports = function watchdog(ap, api, log) {
  const { bot, scheduler } = api
  const dir = path.dirname(api.statePath('x'))
  const jsonFile = path.join(dir, 'scoreboard.json'), logFile = path.join(dir, 'scoreboard.log')
  const alertFile = path.join(dir, 'idle-alert.json')
  const WAIT_STEPS = { 'iron-smelt': 150000 }    // steps that legitimately stand still (furnace wait): longer fuse, no cooldown
  const W = { alarms: [], alarmSecs: 0, alarm: null, episodes: [], cur: null, startedAt: Date.now(), samples: 0, active: 0, idle: 0, causes: {}, deaths: 0, kicks: 0, lastActiveAt: Date.now(), idleLog: [], window: { samples: 0, active: 0, causes: {} } }
  const totalsFile = path.join(dir, 'scoreboard-totals.json')
  let C = ap.WCarry
  if (!C) { try { C = JSON.parse(fs.readFileSync(totalsFile, 'utf8')) } catch { C = {} } }     // survives bot restarts too      // totals survive hot reloads of this file
  for (const k of ['startedAt', 'samples', 'active', 'idle', 'causes', 'deaths', 'kicks', 'episodes', 'alarms', 'alarmSecs']) if (C[k] != null) W[k] = C[k]
  let lastPos = bot.entity ? bot.entity.position.clone() : null, lastInvSig = '', lastDig = Date.now(), lastPlace = Date.now()
  const sig = () => bot.inventory.items().map(i => i.name + i.count).sort().join(',')
  const onDig = () => { lastDig = Date.now() }
  const onPlace = () => { lastPlace = Date.now() }
  const onDeath = () => { W.deaths++; saveTotals() }
  bot.on('diggingCompleted', onDig); bot.on('blockPlaced', onPlace); bot.on('death', onDeath)

  const taskName = () => { try { const s = scheduler.status(); return s.running ? s.running.name : null } catch { return null } }

  function cause() {
    if (bot.isSleeping) return 'sleeping'
    if (ap.S && ap.S.nightHold) return 'night-hold'
    const t = taskName()
    const s = scheduler.status()
    if (!t) return (s.parked && s.parked.length) ? 'parked:' + s.parked.map(p => p.name + (p.reason ? '(' + String(p.reason).slice(0, 24) + ')' : '')).join('+') : 'no-task'
    if (s.parked && s.parked.length) return 'parked:' + s.parked.map(p => p.name).join('+')
    if (t === 'autopilot') return 'autopilot-stalled:' + (ap.G && ap.G.lastStep)
    if (t === 'manual-ap') return 'manual-hold'
    return 'task:' + t
  }

  function sample() {
    const now = Date.now()
    W.samples++; W.window.samples++
    const p = bot.entity && bot.entity.position
    let active = false
    if (p && lastPos && p.distanceTo(lastPos) >= 0.8) active = true
    if (p) lastPos = p.clone()
    const sg = sig(); if (sg !== lastInvSig) { active = true; lastInvSig = sg }
    if (now - lastDig < 6000 || now - lastPlace < 6000) active = true
    if (bot.isSleeping) active = true       // sleeping is allowed
    if (ap.walledUntil && ap.walledUntil > now) active = true
    if (active) {
      W.active++; W.window.active++; W.lastActiveAt = now
      if (W.cur) { W.cur.endedAt = now; W.cur.secs = Math.round((now - W.cur.startAt) / 1000); if (W.cur.secs >= 20) { W.episodes.push(W.cur); if (W.episodes.length > 40) W.episodes.shift() } W.cur = null }
      return
    }
    const c = cause()
    if (!W.cur) W.cur = { startAt: W.lastActiveAt, cause: c, step: ap.G && ap.G.lastStep, pos: bot.entity ? bot.entity.position.floored().toString() : null, kicks: 0 }
    W.cur.cause = c
    W.idle++; W.causes[c] = (W.causes[c] || 0) + 1; W.window.causes[c] = (W.window.causes[c] || 0) + 1
    const idleFor = now - W.lastActiveAt
    const fuse = (ap.G && WAIT_STEPS[ap.G.lastStep]) || 45000
    if (idleFor >= 45000) { try { fs.writeFileSync(alertFile, JSON.stringify({ at: new Date().toISOString(), idleSecs: Math.round(idleFor / 1000), cause: c, step: ap.G && ap.G.lastStep, task: taskName(), pos: bot.entity.position.floored().toString(), recent: ap.G && ap.G.log ? ap.G.log.slice(-4) : null }, null, 1)) } catch {} }
  }

  function kick(c, idleFor) {
    W.lastKickAt = Date.now(); W.kicks++; if (W.cur) W.cur.kicks++
    const line = `${new Date().toISOString()} IDLE ${Math.round(idleFor / 1000)}s cause=${c} task=${taskName()} step=${ap.G && ap.G.lastStep} recent=${JSON.stringify(ap.G && ap.G.log ? ap.G.log.slice(-2).map(x => String(x.msg || x).slice(0, 90)) : null)} pos=${bot.entity.position.floored()}`
    W.idleLog.push(line); if (W.idleLog.length > 30) W.idleLog.shift()
    try { fs.appendFileSync(logFile, line + '\n') } catch {}
    log('IDLE', line)
    try {
      ap.enabled = true
      if (ap.keepTaskOff && !(ap.dangerUntil && ap.dangerUntil > Date.now())) { ap.keepTaskOff = false; log('IDLE', 'keepTaskOff was set while idle: cleared so the autopilot can run') }
      if (ap.release && taskName() === 'manual-ap' && !ap.keepHold) { ap.release(); ap.release = null }   // my own hold must not block the autopilot
      // a manual-mode hold (pilot/chat) that stands still for 100 s blocks every routine: end it so the autopilot runs
      if (taskName() === 'manual' && idleFor >= 45000) { scheduler.cancel('manual', 'idle-watchdog'); log('IDLE', 'manual hold idle ' + Math.round(idleFor / 1000) + 's: cancelled so the autopilot can run') }
      const s = scheduler.status()
      for (const p of (s.parked || [])) { if (p.name === 'autopilot') scheduler.resumeParked && scheduler.resumeParked('autopilot') }
      if (ap.ensureTask) ap.ensureTask()
      // a stalled autopilot step: cool it down so the next goal runs
      if (c.startsWith('autopilot-stalled') && ap.G && ap.G.lastStep) ap.G.cool[ap.G.lastStep] = Date.now() + (W.cur && W.cur.kicks >= 2 ? 240000 : 60000)
      if (ap.S) ap.S.stopMoving()
    } catch (e) { log('KICK_ERR', e.message) }
  }

  function snapshot() {
    const S = ap.S
    const cnt = (re) => S ? S.count(re) : 0
    return {
      at: new Date().toISOString(), uptimeMin: Math.round((Date.now() - W.startedAt) / 60000),
      activePct: W.samples ? Math.round(100 * W.active / W.samples) : 0,
      windowActivePct: W.window.samples ? Math.round(100 * W.window.active / W.window.samples) : 0,
      idleMin: Math.round(W.idle * 5 / 60 * 10) / 10, idleCauses: Object.fromEntries(Object.entries(W.causes).map(([k, v]) => [k, Math.round(v * 5 / 6) / 10])),
      windowIdleCauses: Object.fromEntries(Object.entries(W.window.causes).map(([k, v]) => [k, Math.round(v * 5)])),
      deaths: W.deaths, kicks: W.kicks, alarmCount: W.alarms.length, alarmMin: Math.round(W.alarmSecs / 6) / 10, recentAlarms: W.alarms.slice(-5), recentEpisodes: W.episodes.slice(-8).map(e => `${e.secs}s ${e.cause} @${e.step} ${e.pos}`),
      progress: { rawIron: cnt('raw_iron'), ironIngots: cnt('iron_ingot'), diamonds: cnt('diamond'), coal: cnt('coal'), ironArmor: cnt(/^iron_(helmet|chestplate|leggings|boots)$/), swords: cnt(/_sword$/), cobble: cnt('cobblestone'), goalsDone: (ap.G && ap.G.done) || 0, goalsFailed: (ap.G && ap.G.failedCount) || 0 },
      step: ap.G && ap.G.lastStep, task: taskName(), pos: bot.entity ? bot.entity.position.floored().toString() : null, lastIdle: W.idleLog.slice(-3),
    }
  }

  function write() {
    const snap = snapshot()
    try { fs.writeFileSync(jsonFile, JSON.stringify(snap, null, 1)) } catch {}
    try { fs.appendFileSync(logFile, `${snap.at} SCORE active=${snap.activePct}% (5min ${snap.windowActivePct}%) idle=${snap.idleMin}min deaths=${snap.deaths} kicks=${snap.kicks} progress=${JSON.stringify(snap.progress)} causes=${JSON.stringify(snap.windowIdleCauses)}\n`) } catch {}
    W.window = { samples: 0, active: 0, causes: {} }
    saveTotals()
  }
  function saveTotals() { try { fs.writeFileSync(totalsFile, JSON.stringify({ startedAt: W.startedAt, samples: W.samples, active: W.active, idle: W.idle, causes: W.causes, deaths: W.deaths, kicks: W.kicks, episodes: W.episodes, alarms: W.alarms, alarmSecs: W.alarmSecs })) } catch {} }

  const t1 = setInterval(() => { try { sample() } catch (e) { log('WD_ERR', e.message) } try { alarmCheck() } catch (e) { log('WD_ERR', 'alarm ' + e.message) } }, 5000)
  const t2 = setInterval(() => { try { write() } catch {} }, 5 * 60000)
  const firstWrite = setTimeout(() => { try { write() } catch {} }, 20000)

  // ---- live monitor: status file every 10 s + predictable-stall warnings (read by the game-monitor thread) ----
  const statusFile = path.join(dir, 'monitor-status.json')
  const nothingHits = []
  function warnings() {
    const w = [], G = ap.G, S = ap.S, p = bot.entity && bot.entity.position
    if (!p || !G || !S) return w
    const recent = (G.log || []).slice(-8).filter(x => /nothing in sight/.test(String(x))).length
    if (p.y > 100 && recent >= 3) w.push('gather-loop-up-high: ' + recent + ' "nothing in sight" in a row at y' + Math.floor(p.y))
    if (G.lastStep === 'iron-supply' || G.lastStep === 'diamond-supply') {
      const armor = S.count(/^(iron|diamond)_(helmet|chestplate|leggings|boots)$/), sword = S.count(/_sword$/), cobble = S.count(/^(cobblestone|cobbled_deepslate)$/)
      if (p.y > 60 && (!sword || cobble < 24 || bot.health < 16 || bot.food < 14)) w.push(`descent-underequipped: sword=${sword} cobble=${cobble} hp=${Math.round(bot.health)} food=${bot.food}`)
      else if (p.y > 60 && !armor) w.push('descent-no-armor (3 deaths in the mine so far)')
    }
    try {
      const filler = bot.inventory.items().filter(i => /^(cobblestone|cobbled_deepslate|stone|deepslate|dirt|andesite|diorite|granite|tuff|netherrack|blackstone)$/.test(i.name)).reduce((n, i) => n + i.count, 0), torches = S.count(/^torch$/)
      if (underRock() && (filler < 32 || torches === 0)) w.push(`underground-underequipped: filler=${filler} torches=${torches}`)
    } catch {}
    if (S.isNight && S.isNight() && p.y > 55 && !bot.isSleeping) w.push('night-outdoors')
    if (bot.food <= 8) w.push('low-food ' + bot.food)
    if (bot.health <= 8) w.push('low-hp ' + Math.round(bot.health))
    const emptySlots = bot.inventory.emptySlotCount ? bot.inventory.emptySlotCount() : 99
    if (emptySlots <= 3) w.push('bag-nearly-full')
    return w
  }
  function monitorStatus() {
    const now = Date.now(), p = bot.entity && bot.entity.position
    let sc = null; try { sc = scheduler.status() } catch {}
    const st = {
      at: new Date().toISOString(), pos: p ? p.floored().toString() : null, hp: Math.round(bot.health), food: bot.food,
      task: sc && sc.running ? sc.running.name : null, queue: sc ? sc.queue.map(t => t.name) : [], parked: sc ? sc.parked.map(t => t.name) : [],
      step: ap.G && ap.G.lastStep, apEnabled: ap.active ? ap.active() : ap.enabled, keepTaskOff: !!ap.keepTaskOff,
      idleSecs: Math.round((now - W.lastActiveAt) / 1000), deaths: W.deaths, kicks: W.kicks, warnings: warnings(), alarm: W.alarm, nightHold: !!(ap.S && ap.S.nightHold),
    }
    try { fs.writeFileSync(statusFile, JSON.stringify(st)) } catch {}
    return st
  }
  const t3 = setInterval(() => { try { monitorStatus() } catch {} }, 10000)
  // ================= FIVE-ALARM SYSTEM =================
  // Alarm = the bot STALLED (no movement/dig/place/item gain for 45 s) or THRASHES (3+ goal switches/retries in 2 min with no item gain
  // and < 12 blocks of net movement). On alarm: fix at once (escalating), re-alarm every 60 s until progressing, log duration to
  // scoreboard.log and the lesson to lessons.md. brain/state/alarm.json always holds the current alarm for the game-monitor thread.
  const alarmFile = path.join(dir, 'alarm.json'), lessonsFile = path.join(dir, 'lessons.md')
  const posHist = [], gainTimes = [], switches = []
  let lastCnt = {}, lastGoalSig = '', alarmClearSince = 0
  const hhmm = () => new Date().toISOString().slice(11, 16)
  function trackProgress(now) {
    const p = bot.entity && bot.entity.position
    if (p) { posHist.push({ t: now, p: p.clone() }); while (posHist.length && now - posHist[0].t > 130000) posHist.shift() }
    const cnt = {}; for (const i of bot.inventory.items()) cnt[i.name] = (cnt[i.name] || 0) + i.count
    for (const k of Object.keys(cnt)) if (cnt[k] > (lastCnt[k] || 0)) { gainTimes.push(now); break }
    lastCnt = cnt; while (gainTimes.length && now - gainTimes[0] > 130000) gainTimes.shift()
    const G = ap.G
    if (G) {
      const gs = (G.lastStep || '') + '|' + (G.done || 0) + '|' + (G.failedCount || 0)
      if (gs !== lastGoalSig) { switches.push({ t: now, step: G.lastStep }); lastGoalSig = gs }
    }
    while (switches.length && now - switches[0].t > 125000) switches.shift()
  }
  const recentSwitches = (now) => switches.filter(x => now - x.t <= 120000)
  const displacement = (now) => { const old = posHist.find(h => now - h.t <= 125000); const p = bot.entity && bot.entity.position; return old && p ? old.p.distanceTo(p) : 99 }
  function alarmWanted(now) {
    try { if (fs.existsSync(path.join(dir, 'watchdog-pause'))) { W.lastActiveAt = now; return null } } catch {}      // brain/state/watchdog-pause exists => alarms and kicks paused (world switch)
    if (bot.isSleeping || taskName() === 'safety' || taskName() === 'wd-retreat' || handled(now) || (ap.dangerUntil && ap.dangerUntil > now) || (ap.walledUntil && ap.walledUntil > now) || (ap.S && ap.S.nightHold && bot.entity && now - W.lastActiveAt < 540000)) return null
    const step = ap.G && ap.G.lastStep, idleFor = now - W.lastActiveAt
    if (idleFor >= ((step && WAIT_STEPS[step]) || 45000)) return { type: 'STALL', cause: `${cause()} idle ${Math.round(idleFor / 1000)}s` }
    const sw = recentSwitches(now)
    if (sw.length >= 3 && !gainTimes.some(t => now - t <= 120000) && displacement(now) < 12) return { type: 'THRASH', cause: `${sw.length} goal switches/retries in 2 min, no item gain, moved ${Math.round(displacement(now))} blocks: ${[...new Set(sw.map(x => x.step))].join('>')}` }
    return null
  }
  function situation() {
    const p = bot.entity.position, S = ap.S
    return `step=${ap.G && ap.G.lastStep} task=${taskName()} pos=${p.floored()} hp=${Math.round(bot.health)} food=${bot.food} night=${!!(S && S.isNight && S.isNight())} nightHold=${!!(S && S.nightHold)} bag=${bot.inventory.items().map(i => i.name + i.count).slice(0, 10).join(',')}`
  }
  function applyFix(a, now) {
    const G = ap.G, S = ap.S, fixes = []
    try {
      ap.enabled = true; if (!(ap.dangerUntil && ap.dangerUntil > Date.now())) ap.keepTaskOff = false
      if (a.level === 1) {
        if (a.type === 'STALL') { kick(a.cause, now - W.lastActiveAt); fixes.push('kick(autopilot resumed, holds released, step cooled)') }
        else {
          for (const x of [...new Set(recentSwitches(now).map(x => x.step))].slice(-3)) if (G && x && G.cool) { G.cool[x] = now + 180000; fixes.push('cooled ' + x + ' 3min') }
          if (S) S.stopMoving()
          if (ap.ensureTask) ap.ensureTask()
          if (taskName() === 'manual') { scheduler.cancel('manual', 'alarm'); fixes.push('manual cancelled') }
        }
      } else if (a.level === 2) {
        if (taskName() === 'manual') { scheduler.cancel('manual', 'alarm'); fixes.push('manual cancelled') }
        if (G && G.cool) { for (const k of Object.keys(G.cool)) delete G.cool[k]; if (G.fails) for (const k of Object.keys(G.fails)) G.fails[k] = 0; fixes.push('cleared all step cooldowns/fails') }
        for (const q of (scheduler.status().parked || [])) if (q.name !== 'furnace') { try { scheduler.resumeParked(q.name) } catch {} }
        if (S) S.stopMoving()
        if (ap.ensureTask) ap.ensureTask()
      } else if (a.level === 3) {
        const r = ap.reload ? ap.reload() : 'no reload'; fixes.push('autopilot hot-reloaded (' + r + ')')
        if (ap.ensureTask) ap.ensureTask()
      } else {
        // Walter 2026-11-04: looping failures end in a command reset, not a wait for a human
        const done = G && G.forceReset && G.forceReset('watchdog ' + a.type + ' ' + a.cause)
        fixes.push(done ? 'reset: teleported home, respawn point at the bed' : 'reset already done in the last 10 min')
      }
    } catch (e) { fixes.push('fix error ' + e.message) }
    a.fixes.push(`L${a.level}: ${fixes.join(', ') || 'none'}`)
    return fixes
  }
  function writeAlarm() { try { fs.writeFileSync(alarmFile, JSON.stringify(W.alarm || { at: new Date().toISOString(), active: false, last: W.alarms[W.alarms.length - 1] || null })) } catch {} }
  function alarmCheck() {
    const now = Date.now()
    trackProgress(now)
    const want = alarmWanted(now)
    if (want && !W.alarm) {
      W.alarm = { active: true, id: 'A' + (W.alarms.length + 1), type: want.type, cause: want.cause, startAt: now, at: new Date(now).toISOString(), level: 1, repeats: 0, lastEscalate: now, fixes: [], situation: situation() }
      alarmClearSince = 0
      applyFix(W.alarm, now)
      const line = `${new Date().toISOString()} ALARM-START ${W.alarm.id} ${W.alarm.type} ${W.alarm.cause} | ${W.alarm.situation} | fix ${W.alarm.fixes.join('; ')}`
      try { fs.appendFileSync(logFile, line + '\n') } catch {}
      log('ALARM', line.slice(0, 400))
      try { fs.appendFileSync(lessonsFile, `\n- ${new Date().toISOString().slice(0, 10)} ${hhmm()} [watchdog] ${W.alarm.type} ${W.alarm.id}: ${W.alarm.cause}. Situation: ${W.alarm.situation}. First fix: ${W.alarm.fixes.join('; ')}.`) } catch {}
      writeAlarm(); return
    }
    if (want && W.alarm) {
      alarmClearSince = 0
      W.alarm.cause = want.cause
      if (now - W.alarm.lastEscalate >= 60000) {
        W.alarm.repeats++; W.alarm.level = Math.min(4, W.alarm.level + 1); W.alarm.lastEscalate = now
        applyFix(W.alarm, now)
        const line = `${new Date().toISOString()} ALARM-REPEAT ${W.alarm.id} x${W.alarm.repeats} ${Math.round((now - W.alarm.startAt) / 1000)}s ${W.alarm.type} ${W.alarm.cause} | fix ${W.alarm.fixes[W.alarm.fixes.length - 1]}`
        try { fs.appendFileSync(logFile, line + '\n') } catch {}
        log('ALARM', line.slice(0, 400)); writeAlarm()
      }
      return
    }
    if (!want && W.alarm) {
      if (!alarmClearSince) alarmClearSince = now
      if (now - alarmClearSince >= 10000) {
        const a = W.alarm, secs = Math.round((now - a.startAt) / 1000)
        W.alarms.push({ id: a.id, type: a.type, at: a.at, secs, repeats: a.repeats, cause: a.cause, fixes: a.fixes }); if (W.alarms.length > 200) W.alarms.shift()
        W.alarmSecs += secs
        W.alarm = null; alarmClearSince = 0
        const line = `${new Date().toISOString()} ALARM-END ${a.id} ${a.type} lasted ${secs}s repeats=${a.repeats} last fix: ${a.fixes[a.fixes.length - 1]}`
        try { fs.appendFileSync(logFile, line + '\n') } catch {}
        log('ALARM', line)
        try { fs.appendFileSync(lessonsFile, `\n- ${new Date().toISOString().slice(0, 10)} ${hhmm()} [watchdog] ${a.id} ${a.type} cleared after ${secs}s (fix: ${a.fixes[a.fixes.length - 1]}).`) } catch {}
        saveTotals(); writeAlarm()
      }
    }
  }

  // ---- night guard: the autopilot must not explore/gather outdoors at night (4 deaths so far); outdoor steps are cooled and S.nightHold stops explore() ----
  const OUTDOOR_STEPS = ['wood', 'stone', 'food', 'wander-work', 'explore', 'cook']
  function nightGuard() {
    const S = ap.S, G = ap.G; if (!S || !G || !bot.entity) return
    S.nightHold = false; return    // survival world: no hiding rule (Walter: don't stall), and the shelter below is a base-world coordinate
    const night =!!(S.isNight && S.isNight()) && bot.game && bot.game.dimension === 'overworld'
    const was = !!S.nightHold
    S.nightHold = !!(night && !bot.isSleeping)
    if (S.nightHold && G.cool) { const t = Date.now() + 20000; for (const k of OUTDOOR_STEPS) G.cool[k] = t }
    // hard rule: outdoors at night far from the base => go to shelter now, whatever step/task is running (safety/sleep/shelter tasks excepted)
    if (S.nightHold && !bot.isSleeping && api.gotoNear && scheduler.submit && holderOf(bot, 'body') !== 'night-guard') {
      const now = Date.now(), p = bot.entity.position, t = taskName()
      const SHELTER = require('vec3').Vec3 ? new (require('vec3').Vec3)(-1051, 151, 2320) : null
      let sky = true; try { sky = S.skyVisible() } catch {}
      let chatQuiet = true; try { chatQuiet = now - (scheduler.lastChatAt || 0) > 120000 } catch {}
      if (SHELTER && sky && chatQuiet && p.distanceTo(SHELTER) > 14 && !['safety', 'sleep', 'night-shelter', 'wd-shelter'].includes(t) && now - (W.lastShelterAt || 0) > 60000) {
        W.lastShelterAt = now
        log('NIGHT', `outdoors at night ${Math.round(p.distanceTo(SHELTER))} blocks from shelter (task ${t}): forcing shelter walk`)
        try {
          scheduler.submit({ name: 'wd-shelter', key: 'wd-shelter', priority: PRIORITY.SHELTER, onUserStop: 'cancel', replace: true,
            async run(ctx) {
              const guard = api.reflexes ? api.reflexes.register({ name: 'night-guard', priority: 40, claims: ['body'], desc: 'night: walk to the shelter and stay out of the dark' }) : null
              if (guard) guard.claim('body', 130000, 'walking to shelter')
              try { try { await api.safehand.ensureSafeForMove() } catch {} await api.gotoNear({ pos: SHELTER, radius: 3, label: 'shelter', ctx, ms: 120000 }); return { status: 'done' } } finally { if (guard) guard.release('body') }
            } })
        } catch (e) { log('NIGHT', 'shelter submit failed ' + e.message) }
      }
    }
    if (S.nightHold !== was) log('NIGHT', S.nightHold ? 'night: outdoor autopilot steps held until dawn' : 'dawn: outdoor steps released')
  }
  const t4 = setInterval(() => { try { nightGuard() } catch {} }, 4000)

  // ---- cave reflex (Walter/coordinator 18:18, six deaths underground): underground, hostile within 15 blocks with a clear line (or just hurt with a hostile near)
  //      => cancel the current task at once and retreat to shelter; the autopilot is held off until it is clear. (Wall-in with filler is the safety module's job.) ----
  const FILLER_RE = /^(cobblestone|cobbled_deepslate|stone|deepslate|dirt|andesite|diorite|granite|tuff|netherrack|blackstone)$/
  let lastHurtAt = 0, lastHp = bot.health, reflexClearSince = 0
  const onHealth = () => { if (bot.health < lastHp - 0.5) lastHurtAt = Date.now(); lastHp = bot.health }
  bot.on('health', onHealth)
  const underRock = () => {
    const p = bot.entity.position, x = Math.floor(p.x), z = Math.floor(p.z), y = Math.floor(p.y) + 2
    for (let dy = 0; dy < 48; dy++) { const b = bot.blockAt(new (require('vec3').Vec3)(x, y + dy, z)); if (b && b.boundingBox === 'block' && !/_leaves$/.test(b.name || '')) return true }
    return false
  }
  const losTo = (e) => { try { const eye = bot.entity.position.offset(0, 1.62, 0), t = e.position.offset(0, 1, 0), dv = t.minus(eye), dist = dv.norm(); return !bot.world.raycast(eye, dv.scaled(1 / dist), dist) } catch { return true } }
  // another danger handler (the planner's seal-in/heal/re-plan) owns the bot while ap.dangerHandled is true (or a future timestamp): stay out of its way
  // (the `danger` lease in brain/reflexes.js: the planner's reflex is registered as 'danger-reflex' and outranks this one; ap.dangerHandled is still written by think.js for old code)
  const caveLease = api.reflexes ? api.reflexes.register({ name: 'cave', priority: 50, claims: ['danger'], desc: 'underground, hostile in sight: cancel the task, retreat to shelter, hold the autopilot off' }) : null
  const handled = (now) => {
    if (api.reflexes && api.reflexes.heldByOther('danger', 'cave')) return true
    const h = ap.dangerHandled; return h === true || (typeof h === 'number' && h > now)
  }
  function caveReflex() {
    const S = ap.S; if (!S || !bot.entity || !S.hostilesNear || bot.isSleeping) return
    // the assistant works on the surface at Walter's farms: no cave retreat (its 'retreat to shelter' at 23:29 ran it off the birch farm
    // into a cave at y57 where a zombie killed it); safety and combat still fight or wall in
    if (ap.G && ap.G.role === 'assistant') return
    const now = Date.now(), t = taskName()
    if (handled(now)) { if (ap.dangerUntil) { ap.dangerUntil = 0; ap.keepTaskOff = false } reflexClearSince = 0; return }
    const under = underRock() && bot.game && bot.game.dimension === 'overworld'
    const seen = under ? S.hostilesNear(15).filter(losTo) : []
    // a thorn, a fall or drowning is not an archer: brain/hurt marks hits with no mob behind them (berry bushes set this reflex off again and again)
    const envHit = bot._lastEnvHurtAt && Math.abs(bot._lastEnvHurtAt - lastHurtAt) < 1500
    const hurtNear = under && !envHit && now - lastHurtAt < 3000 && S.hostilesNear(24).length > 0
    const danger = under && (seen.length > 0 || hurtNear)
    if (danger) {
      reflexClearSince = 0
      const first = !ap.dangerUntil || ap.dangerUntil < now
      ap.dangerUntil = now + 20000
      ap.keepTaskOff = true
      if (caveLease) caveLease.claim('danger', 20000, 'hostile in sight underground')
      if (t && !['safety', 'wd-retreat'].includes(t)) { try { scheduler.cancel(t, 'cave-reflex') } catch {} }
      try { scheduler.cancel('autopilot', 'cave-reflex') } catch {}
      if (first || (t !== 'safety' && t !== 'wd-retreat' && now - (W.lastRetreatAt || 0) > 15000)) {
        W.lastRetreatAt = now; W.reflexes = (W.reflexes || 0) + 1
        // retreat to the bot's own home bed (the fixed -1051,151,2320 was a shelter in an earlier world: the walk went nowhere)
        const hm = ap.G && ap.G.state && ap.G.state.home, SH = hm ? new (require('vec3').Vec3)(hm[0], hm[1], hm[2]) : new (require('vec3').Vec3)(-1051, 151, 2320)
        const filler = bot.inventory.items().filter(i => FILLER_RE.test(i.name)).reduce((s, i) => s + i.count, 0)
        const msg = `cave reflex #${W.reflexes}: ${seen.map(e => e.name).slice(0, 3).join('+') || 'ranged hit'} in sight underground at ${bot.entity.position.floored()} (hp ${Math.round(bot.health)}, filler ${filler}); task ${t} cancelled, retreating to shelter`
        log('REFLEX', msg)
        try { fs.appendFileSync(logFile, `${new Date().toISOString()} REFLEX ${msg}\n`) } catch {}
        if (first) { try { fs.appendFileSync(lessonsFile, `\n- ${new Date().toISOString().slice(0, 10)} ${hhmm()} [watchdog] ${msg}.`) } catch {} }
        try {
          scheduler.submit({ name: 'wd-retreat', key: 'wd-retreat', priority: PRIORITY.RETREAT, onUserStop: 'cancel', replace: true,
            async run(ctx) { await api.gotoNear({ pos: SH, radius: 3, label: 'shelter', ctx, ms: 120000 }); return { status: 'done' } } })
        } catch (e) { log('REFLEX', 'retreat submit failed ' + e.message) }
      }
    } else if (ap.dangerUntil) {
      if (!reflexClearSince) reflexClearSince = now
      if (now - reflexClearSince >= 10000 || now > ap.dangerUntil + 60000) {       // clear for 10 s: hand control back
        ap.dangerUntil = 0; ap.keepTaskOff = false; reflexClearSince = 0
        if (caveLease) caveLease.release('danger')
        log('REFLEX', 'clear: autopilot released')
        try { if (ap.ensureTask) ap.ensureTask() } catch {}
      }
    }
  }
  const t5 = setInterval(() => { try { caveReflex() } catch (e) { log('WD_ERR', 'reflex ' + e.message) } }, 1500)

  W.snapshot = snapshot
  W.monitorStatus = monitorStatus
  W.dispose = () => { ap.WCarry = { startedAt: W.startedAt, samples: W.samples, active: W.active, idle: W.idle, causes: W.causes, deaths: W.deaths, kicks: W.kicks, episodes: W.episodes, alarms: W.alarms, alarmSecs: W.alarmSecs }; clearInterval(t1); clearInterval(t2); clearInterval(t3); clearInterval(t4); clearInterval(t5); bot.removeListener('health', onHealth); clearTimeout(firstWrite); bot.removeListener('diggingCompleted', onDig); bot.removeListener('blockPlaced', onPlace); bot.removeListener('death', onDeath) }
  return W
}
