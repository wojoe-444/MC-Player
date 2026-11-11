// The tab bar across the top of the app window: Dashboard | Claude reviews | Memory loop | Settings (a dot on Settings means an update is available).
function render(s) {
  document.body.replaceChildren(...s.tabs.map(t => {
    const b = document.createElement('button')
    b.textContent = t.label
    b.className = t.id === s.active ? 'on' : ''
    b.title = t.id === 'settings' && s.badges.settings ? 'An update is available' : ''
    const dot = document.createElement('span')
    dot.className = 'dot' + (s.badges[t.id] ? ' show' : '')
    b.append(dot)
    b.onclick = () => window.botApp.selectTab(t.id)
    return b
  }))
}
window.botApp.onTabs(render)
window.botApp.tabsState().then(render)
