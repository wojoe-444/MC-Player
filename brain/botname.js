// The bot's in-game name for prompts and request headers (one bot per process). Prompts are written with the default name "OzoGo444" in them and
// run through forName() when they are sent, so the other bot (Smeo444) introduces itself correctly. brain/index.js sets it from the profile at start.
let current = 'OzoGo444'
const set = (n) => { if (n && typeof n === 'string') current = n }
const get = () => current
const forName = (text) => String(text).replace(/OzoGo444/g, current)
module.exports = { set, get, forName }
