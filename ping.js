const mc = require('minecraft-protocol')
mc.ping({ host: 'localhost', port: Number(process.env.MC_PORT) || parseInt(require("fs").readFileSync("lan-port.txt", "utf8"), 10) || 56585 }, (err, r) => {
  if (err) { console.log('PING ERROR', err.message); process.exit(1) }
  console.log(JSON.stringify({ version: r.version, players: r.players, motd: r.description }, null, 2))
  process.exit(0)
})
