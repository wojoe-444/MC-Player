// Observe-only scanner: never digs, places, attacks, takes items, or opens containers.
const mineflayer = require('mineflayer')
const fs = require('fs')

const bot = mineflayer.createBot({
  host: 'localhost', port: 60439, username: process.env.MC_EMAIL,
  auth: 'microsoft', version: '1.21.6', profilesFolder: './auth-cache',
  onMsaCode: (d) => console.log('MSA_DEVICE_CODE', d.user_code, d.verification_uri)
})

// The world runs Fabric; answer its registry-sync handshake so a plain client is accepted.
const FABRIC_CHANNELS = ['fabric:registry/sync/direct', 'fabric:registry/sync/nbt', 'fabric:registry/sync/complete',
  'fabric:accepted_attachments_v1', 'c:version', 'c:register', 'fabric:custom_ingredient_sync']
bot._client.on('custom_payload', (p) => {
  const c = bot._client
  if (c.state !== 'configuration') return
  if (p.channel === 'minecraft:register') {
    c.write('custom_payload', { channel: 'minecraft:register', data: Buffer.from(FABRIC_CHANNELS.join('\0')) })
  } else if (p.channel === 'fabric:registry/sync/direct' && p.data.length === 0) {
    c.write('custom_payload', { channel: 'fabric:registry/sync/complete', data: Buffer.alloc(0) })
  }
})

const fmt = (p) => `${Math.round(p.x)}, ${Math.round(p.y)}, ${Math.round(p.z)}`

const TARGETS = {
  chests: ['chest', 'trapped_chest', 'barrel', 'ender_chest'],
  shulkers: ['shulker_box'],
  crafting: ['crafting_table', 'smithing_table', 'fletching_table', 'cartography_table', 'loom', 'stonecutter', 'grindstone', 'anvil', 'enchanting_table', 'brewing_stand'],
  smelting: ['furnace', 'blast_furnace', 'smoker'],
  beds: ['white_bed', 'orange_bed', 'magenta_bed', 'light_blue_bed', 'yellow_bed', 'lime_bed', 'pink_bed', 'gray_bed', 'light_gray_bed', 'cyan_bed', 'purple_bed', 'blue_bed', 'brown_bed', 'green_bed', 'red_bed', 'black_bed'],
  portals: ['nether_portal', 'end_portal_frame', 'end_portal'],
  farmland: ['farmland'],
  crops: ['wheat', 'carrots', 'potatoes', 'beetroots', 'melon', 'pumpkin', 'sugar_cane', 'nether_wart', 'bamboo', 'cocoa'],
  beacons_etc: ['beacon', 'conduit', 'spawner', 'bell', 'lectern', 'jukebox'],
  hazards: ['lava', 'fire', 'magma_block', 'cactus', 'sweet_berry_bush']
}

function cluster(points, r = 8) {
  const groups = []
  for (const p of points) {
    const g = groups.find(g => g.c.distanceTo(p) <= r)
    if (g) { g.n++; g.min = g.min.y < p.y ? g.min : p; g.sum = g.sum.plus(p) }
    else groups.push({ c: p, n: 1, min: p, sum: p })
  }
  return groups.map(g => ({ at: fmt(g.sum.scaled(1 / g.n)), count: g.n }))
}

function scan() {
  const out = []
  const me = bot.entity.position
  out.push(`# Scan from ${fmt(me)} (${bot.game.dimension}) at ${new Date().toISOString()}`)
  out.push('## Players')
  for (const pl of Object.values(bot.players)) {
    out.push(`- ${pl.username}${pl.entity ? ' @ ' + fmt(pl.entity.position) : ' (not in range)'}`)
  }
  out.push('## Hostile/other nearby entities')
  const ents = Object.values(bot.entities).filter(e => e !== bot.entity && e.type !== 'player' && e.position.distanceTo(me) < 48)
  const counts = {}
  for (const e of ents) { const k = e.name || e.displayName || e.type; counts[k] = (counts[k] || 0) + 1 }
  out.push(Object.entries(counts).map(([k, v]) => `- ${k} x${v}`).join('\n') || '- none')
  for (const [cat, names] of Object.entries(TARGETS)) {
    const ids = names.map(n => bot.registry.blocksByName[n]).filter(Boolean).map(b => b.id)
    const pts = bot.findBlocks({ matching: ids, maxDistance: 128, count: 4000 })
    out.push(`## ${cat} (${pts.length} blocks)`)
    if (pts.length) for (const g of cluster(pts)) out.push(`- ~(${g.at}) x${g.count}`)
  }
  return out.join('\n')
}

bot.once('spawn', async () => {
  console.log('SPAWNED', fmt(bot.entity.position), bot.version)
  bot.chat("Hello! Walter's Claude agent here, just looking around. I won't touch anything.")
  await bot.waitForChunksToLoad()
  await new Promise(r => setTimeout(r, 4000))
  const text = scan()
  fs.writeFileSync('base-notes.md', text + '\n')
  console.log(text)
  console.log('SCAN_DONE')
})

bot.on('chat', (u, m) => console.log('CHAT', u, m))
bot.on('health', () => { if (bot.health < 10) console.log('LOW_HEALTH', bot.health) })
bot.on('kicked', r => console.log('KICKED', JSON.stringify(r)))
bot.on('error', e => console.log('ERROR', e.message))
bot.on('end', r => { console.log('END', r) })
