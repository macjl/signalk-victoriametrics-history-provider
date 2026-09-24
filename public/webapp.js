const tabs = document.getElementById('tabs')
const frame = document.getElementById('interface')
const message = document.getElementById('message')
let selectedId = null

function selectInterface(item) {
  selectedId = item.id
  for (const button of tabs.children) button.setAttribute('aria-selected', String(button.dataset.id === item.id))
  if (frame.getAttribute('src') !== item.path) frame.setAttribute('src', item.path)
  frame.title = item.title
  frame.hidden = false
  message.hidden = true
}

async function loadInterfaces() {
  try {
    const response = await fetch('/plugins/signalk-victoriametrics-history-provider/ui/manifest', {
      credentials: 'same-origin', cache: 'no-store'
    })
    if (!response.ok) throw new Error(response.status === 401 || response.status === 403
      ? 'Administrator sign-in required.' : 'Interfaces are unavailable.')
    const entries = await response.json()
    tabs.replaceChildren()
    for (const item of entries) {
      const button = document.createElement('button')
      button.type = 'button'
      button.role = 'tab'
      button.dataset.id = item.id
      button.textContent = item.title
      button.addEventListener('click', () => selectInterface(item))
      tabs.append(button)
    }
    const selected = entries.find(item => item.id === selectedId) ?? entries[0]
    if (selected) selectInterface(selected)
    else {
      selectedId = null
      frame.hidden = true
      frame.removeAttribute('src')
      message.textContent = 'No interfaces exposed.'
      message.hidden = false
    }
  } catch (error) {
    frame.hidden = true
    frame.removeAttribute('src')
    message.textContent = error.message
    message.hidden = false
  }
}

loadInterfaces()
setInterval(loadInterfaces, 10000)
