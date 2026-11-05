// Sleep / bed routine (Walter's rules): at night, when 48000 ticks (every 3rd night) have passed since the bot last woke, walk to a bed
// and sleep; ping Walter if the night has not skipped after 20 s; if it still has not skipped after 90 s, get up and go back to what
// the bot was doing (the scheduler resumes the task that was paused). Game time (bot.time.age) is used because bot.time.day reads 0 here.
const { Vec3 } = require('vec3')
const common = require('./common')
const makeMover = require('./move')
const makeLos = require('./los')

module.exports = function createSleep({ bot, say, goals, tryGoto, safehand, stopNav = () => {}, config, state, save, ownerName = 'OGWO', canSee = null, now = Date.now, log = () => {} }) {
  const S = config.sleep
  const mover = makeMover({ bot, goals, tryGoto, safehand, stopNav })
  const los = makeLos({ bot, goals, mover, canSee, log })     // Walter's survival-legit rule: no using a bed through a wall
  const st = state.sleep
  let busy = false, cooldownUntil = 0, last = null
  const note = (m) => { last = { at: now(), msg: m }; log(m) }
  const age = () => (bot.time && bot.time.age) || 0
  const dayNow = () => Math.floor(age() / 24000)
  const isNight = () => !!bot.time && bot.time.timeOfDay >= S.nightStart && bot.time.timeOfDay < S.nightEnd
  // Walter: spectators do not count towards sleeping. When every other player is a spectator (gamemode 3) the bot is the only one who has to
  // sleep, so it sleeps EVERY night; anyone else in survival/creative/adventure brings back the every-3rd-night rule.
  const onlySurvivalPlayer = () => { const others = Object.values(bot.players || {}).filter(p => p.username !== bot.username); return others.length > 0 && others.every(p => p.gamemode === 3) }
  const dueNow = () => onlySurvivalPlayer() || age() - st.lastWakeAge >= S.dueTicks
  const attemptsTonight = () => (st.night === dayNow() ? st.attempts : 0)

  // Beds near the bot, heads first (a bed is two blocks; use the head). Nearest first.
  function findBeds() {
    const ids = bot.registry.blocksArray.filter(b => b.name.endsWith('_bed')).map(b => b.id)
    const me = bot.entity.position
    const pts = bot.findBlocks({ matching: ids, maxDistance: S.bedSearchRadius, count: 60 }).sort((a, b) => a.distanceTo(me) - b.distanceTo(me))
    const blocks = pts.map(p => bot.blockAt(p)).filter(Boolean)
    const heads = blocks.filter(b => { try { return b.getProperties().part === 'head' } catch { return false } })
    return (heads.length ? heads : blocks).slice(0, S.bedsToTry)
  }

  async function toBedAndSleep(ctx) {
    const beds = findBeds()
    if (!beds.length) {
      if (st.noBedDay !== dayNow()) { st.noBedDay = dayNow(); save(); say(`It's getting dark, but I can't find a bed within ${S.bedSearchRadius} blocks.`) }
      return { ok: false, why: 'no bed' }
    }
    let err = 'could not reach any bed'
    for (const [i, bed] of beds.entries()) {
      const p = bed.position
      if (i === 0) say(`It's night. Heading to the bed at ${p.x}, ${p.y}, ${p.z} to sleep.`)
      let reached = false
      try { reached = await mover.near(ctx, p, 2, 'the bed', 90000) } catch (e) { if (e && e.name === 'AbortError') throw e; err = e.message }
      if (!reached) { err = `could not reach the bed at ${p.x}, ${p.y}, ${p.z}`; continue }
      if (!(await los.ensure(ctx, bed, 'the bed'))) { err = `no clear line to the bed at ${p.x}, ${p.y}, ${p.z}`; continue }
      try { await bot.sleep(bed); say('In bed.'); return { ok: true } }
      catch (e) { err = e.message; log(`sleep at ${p.x},${p.y},${p.z}: ${e.message}`); if (/monster/i.test(e.message)) break }
    }
    return { ok: false, why: err }
  }

  // In bed: ping after pingAfterMs, get up after giveUpAfterMs if the night has not skipped. Wakes up if the task is stopped.
  async function waitInBed(ctx) {
    const t0 = now()
    const day = dayNow()
    try {
      while (bot.isSleeping) {
        await ctx.sleep(S.pollMs)
        if (!bot.isSleeping) break
        const elapsed = now() - t0
        if (elapsed >= S.pingAfterMs && st.pingedDay !== day) {
          st.pingedDay = day; save()
          say(`${ownerName}, it is night and I am in bed, but the night has not skipped yet. Please get into a bed so we can sleep through it.`)
        }
        if (elapsed >= S.giveUpAfterMs) {
          say(`The night has not skipped after ${Math.round(S.giveUpAfterMs / 1000)} seconds, so I am getting up and going back to what I was doing.`)
          cooldownUntil = now() + S.retryAfterGiveUpMs
          note('gave up waiting in bed')
          await bot.wake()
          return { slept: false, gaveUp: true }
        }
      }
      return { slept: true }
    } catch (e) {
      // stopped by Walter or by something more important (safety): get out of bed so the bot can move
      if (e && e.name === 'AbortError' && bot.isSleeping) { try { await bot.wake() } catch {} }
      throw e
    }
  }

  async function run(ctx, { force = false } = {}) {
    if (busy) return { status: 'done' }
    busy = true
    try {
      if (common.dimOf(bot) !== 'overworld' || !bot.time) return { status: 'done' }
      if (!isNight()) { if (force) say('It is not night yet, so I cannot sleep.'); return { status: 'done' } }
      if (!bot.isSleeping) {
        if (!force && !dueNow()) return { status: 'done' }
        if (common.danger(bot, { minHealth: 6, radius: 8 })) { cooldownUntil = now() + S.retryAfterFailureMs; return { status: 'done' } }
        if (st.night !== dayNow()) { st.night = dayNow(); st.attempts = 0 }
        st.attempts++; save()
        await safehand.stow()
        const r = await toBedAndSleep(ctx)
        if (!r.ok) {
          cooldownUntil = now() + S.retryAfterFailureMs
          if (r.why !== 'no bed') say(`I couldn't sleep: ${r.why}. Retrying in a minute.`.slice(0, 200))
          st.lastResult = { at: now(), ok: false, why: r.why }; save()
          return { status: 'done' }
        }
      }
      const w = await waitInBed(ctx)
      st.lastResult = { at: now(), ok: true, ...w }; save()
      return { status: 'done' }
    } finally { busy = false }
  }

  // 'wake' event: sleeping (even briefly) resets the clock, same as the vanilla rest counter
  function onWake() { st.lastWakeAge = age(); save() }

  // routine due check (every 15 s): night, due, not already in bed, cooldown over, at most maxAttemptsPerNight tries tonight
  function due() {
    return !!(bot.entity && bot.time && common.dimOf(bot) === 'overworld' && isNight() && !bot.isSleeping && !busy && now() >= cooldownUntil && dueNow() && attemptsTonight() < S.maxAttemptsPerNight)
  }

  function snapshot() {
    const since = age() - st.lastWakeAge
    return {
      sleeping: !!bot.isSleeping, busy, night: isNight(), dueNow: dueNow(), ticksSinceWake: Number.isFinite(since) && since < 1e8 ? since : null,
      ticksUntilDue: Math.max(0, S.dueTicks - since), attemptsTonight: attemptsTonight(), pingedDay: st.pingedDay, lastResult: st.lastResult, last: last && { agoS: Math.round((now() - last.at) / 1000), msg: last.msg }
    }
  }

  function abort() { try { stopNav() } catch {} }

  return { run, abort, onWake, due, snapshot, findBeds, isBusy: () => busy, resetCooldown: () => { cooldownUntil = 0 } }
}
