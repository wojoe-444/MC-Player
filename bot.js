const mineflayer = require('mineflayer')

const bot = mineflayer.createBot({
  host: 'localhost',
  port: 60439,
  username: process.env.MC_EMAIL,
  auth: 'microsoft',
  version: '1.21.6',
  profilesFolder: './auth-cache',
  onMsaCode: (data) => {
    console.log('MSA_DEVICE_CODE', data.user_code, data.verification_uri)
  }
})

bot.once('spawn', () => {
  const p = bot.entity.position
  const others = Object.values(bot.players)
    .filter(pl => pl.username !== bot.username)
    .map(pl => ({ name: pl.username, dist: pl.entity ? +pl.entity.position.distanceTo(p).toFixed(1) : null }))
  console.log('SPAWNED', JSON.stringify({
    username: bot.username,
    version: bot.version,
    position: { x: +p.x.toFixed(1), y: +p.y.toFixed(1), z: +p.z.toFixed(1) },
    dimension: bot.game.dimension,
    gameMode: bot.game.gameMode,
    health: bot.health,
    time: bot.time.timeOfDay,
    others
  }))
  bot.chat('Hello from the alt account! Walter\'s Claude agent is online.')
})

bot.on('chat', (u, m) => console.log('CHAT', u, m))
bot.on('kicked', (r) => console.log('KICKED', JSON.stringify(r)))
bot.on('error', (e) => console.log('ERROR', e.message))
bot.on('end', (r) => { console.log('END', r); process.exit(0) })
