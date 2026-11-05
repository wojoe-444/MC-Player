const mc = require('minecraft-protocol')
const c = mc.createClient({
  host: 'localhost', port: 60439, username: process.env.MC_EMAIL,
  auth: 'microsoft', version: '1.21.6', profilesFolder: './auth-cache'
})
const short = (o) => JSON.stringify(o, (k, v) => (typeof v === 'object' && v && v.type === 'Buffer') ? `<buf ${v.data.length}> ${Buffer.from(v.data).toString('latin1').replace(/[^\x20-\x7e]/g, '.').slice(0, 120)}` : v).slice(0, 400)
c.on('packet', (data, meta) => {
  if (meta.state === 'play' && meta.name !== 'disconnect') return
  console.log(meta.state, meta.name, short(data))
})
c.on('error', e => console.log('ERROR', e.message))
c.on('end', r => { console.log('END', r); process.exit(0) })
