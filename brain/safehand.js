// Walter's rule #1: never walk or path with a lava bucket as the selected item.
// - stow(): switch the hand to something harmless (sword > pickaxe > blocks > anything non-bucket > empty hand).
// - lavaMoment(fn): the only place lava may be held; stands still, runs fn, then always stows.
// - install(): backstop that fixes the hand within ~100 ms whenever lava ends up selected outside a lavaMoment
//   (e.g. the last empty bucket of a stack turns into lava in the hand) and stops movement first.
const PREFER = [/_sword$/, /_pickaxe$/, /_axe$/, /_shovel$/, /^cobblestone$/, /^stone$/, /^dirt$/, /^cobbled_deepslate$/]
const UNSAFE = /(^|_)(bucket|lava|fire_charge|flint_and_steel|tnt|potion|spawn_egg)$/

module.exports = function install({ bot, log = () => {}, pollMs = 100, reflexes = null }) {
  let allowDepth = 0, fixing = false, timer = null
  // the held slot belongs to this reflex while it stows a lava bucket or while a lava moment runs: it leases `hands` (brain/reflexes.js), so the combat
  // reflex does not swap the slot underneath it. Without a registry (tests, arena) nothing changes.
  const lease = reflexes ? reflexes.register({ name: 'safehand', priority: 95, claims: ['hands'], desc: 'never move with a lava bucket selected: stow it, hold lava only in a lava moment' }) : null
  const isLava = (it) => !!it && it.name === 'lava_bucket'
  const holdingLava = () => isLava(bot.heldItem)

  function safeItem() {
    const items = bot.inventory.items().filter(i => !UNSAFE.test(i.name) && i.name !== 'lava_bucket')
    for (const re of PREFER) { const f = items.find(i => re.test(i.name)); if (f) return f }
    return items[0] || null
  }

  async function stow() {
    if (!holdingLava()) return false
    const it = safeItem()
    if (it) await bot.equip(it, 'hand'); else await bot.unequip('hand')
    log(`stowed lava bucket, now holding ${bot.heldItem ? bot.heldItem.name : 'nothing'}`)
    return true
  }

  function stopMoving() {
    try { bot.pathfinder && bot.pathfinder.setGoal && bot.pathfinder.setGoal(null) } catch {}
    try { bot.clearControlStates() } catch {}
  }

  async function fix() {
    if (fixing || allowDepth > 0 || !holdingLava()) return
    fixing = true
    if (lease) lease.claim('hands', 3000, 'stowing lava')
    try { stopMoving(); await stow() } catch (e) { log('stow failed: ' + e.message) } finally { fixing = false; if (lease && allowDepth === 0) lease.release('hands') }
  }

  // Hold lava only while standing still, only inside fn.
  async function lavaMoment(fn) {
    stopMoving()
    allowDepth++
    if (lease) lease.claim('hands', 120000, 'lava moment')
    try { return await fn() } finally { allowDepth--; await stow().catch(e => log('stow failed: ' + e.message)); if (lease && allowDepth === 0) lease.release('hands') }
  }

  // Call before any navigate/goto; throws if the hand cannot be made safe.
  async function ensureSafeForMove() {
    if (!holdingLava()) return true
    await stow()
    if (holdingLava()) throw new Error('refusing to move while holding a lava bucket')
    return true
  }

  function start() {
    if (timer) return
    bot.on('heldItemChanged', fix)
    timer = setInterval(fix, pollMs); if (timer.unref) timer.unref()
  }
  function stop() { bot.removeListener('heldItemChanged', fix); clearInterval(timer); timer = null }

  return { start, stop, stow, lavaMoment, ensureSafeForMove, holdingLava, safeItem, lavaCount: () => bot.inventory.items().filter(isLava).reduce((s, i) => s + i.count, 0) }
}
