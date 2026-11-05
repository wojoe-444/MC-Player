const mc = require('minecraft-protocol')
const c = mc.createClient({ host: 'localhost', port: 60439, username: process.env.MC_EMAIL, auth: 'microsoft', version: '1.21.6', profilesFolder: './auth-cache' })
const short = (o) => JSON.stringify(o, (k, v) => (typeof v === 'object' && v && v.type === 'Buffer') ? `<buf ${v.data.length}> ${Buffer.from(v.data).toString('latin1').replace(/[^\x20-\x7e]/g, '.').slice(0, 300)}` : v).slice(0, 900)
const chans = ['fabric:registry/sync/direct','fabric:registry/sync/nbt','fabric:registry/sync/complete','fabric:registry/sync/applied','fabric:registry/sync/start','fabric:accepted_attachments_v1','c:version','c:register','fabric:custom_ingredient_sync']
c.on('packet', (data, meta) => {
  if (meta.state === 'play' && meta.name !== 'disconnect') return
  if (['login','encryption_begin','success','compress'].includes(meta.name)) return
  console.log(meta.state, meta.name, short(data))
  if (meta.state === 'configuration' && meta.name === 'custom_payload' && data.channel === 'minecraft:register') {
    c.writeChannel ? 0 : 0
    c.write('custom_payload', { channel: 'minecraft:register', data: Buffer.from(chans.join('\0')) })
  }
  if (meta.state === 'configuration' && meta.name === 'ping') c.write('pong', { id: data.id })
})
c.on('error', e => console.log('ERROR', e.message))
c.on('end', r => { console.log('END', r); process.exit(0) })
setTimeout(() => process.exit(0), 20000)
