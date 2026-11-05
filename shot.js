// Captures the bot's first-person view from the prismarine-viewer page into pov/<name>.png
const { chromium } = require('playwright-core')
const fs = require('fs')

;(async () => {
  fs.mkdirSync('pov', { recursive: true })
  const name = process.argv[2] || `pov-${new Date().toISOString().replace(/[:.]/g, '-')}`
  const browser = await chromium.launch({
    channel: 'msedge',
    headless: true,
    args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist']
  })
  const page = await browser.newPage({ viewport: { width: 1280, height: 720 } })
  page.on('console', m => { if (m.type() === 'error') console.log('PAGE_ERROR', m.text().slice(0, 200)) })
  await page.goto('http://localhost:3007', { waitUntil: 'load' })
  await page.waitForTimeout(Number(process.argv[3] || 10000))
  const file = `pov/${name}.png`
  await page.screenshot({ path: file })
  await browser.close()
  console.log('SAVED', require('path').resolve(file))
})().catch(e => { console.log('SHOT_ERROR', e.message); process.exit(1) })
