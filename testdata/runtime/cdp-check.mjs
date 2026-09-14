import fs from 'node:fs/promises'

const port = process.env.SYMMD_CDP_PORT || '9333'
const action = process.argv[2] || 'snapshot'

const targets = await fetch(`http://127.0.0.1:${port}/json`).then((response) => response.json())
const page = targets.find((target) => target.type === 'page' && target.url.includes('app.symmd.local'))
if (!page) throw new Error('Symmd WebView2 page target was not found')

const socket = new WebSocket(page.webSocketDebuggerUrl)
await new Promise((resolve, reject) => {
  socket.addEventListener('open', resolve, { once: true })
  socket.addEventListener('error', reject, { once: true })
})

let sequence = 0
const pending = new Map()
const events = []
socket.addEventListener('message', (event) => {
  const message = JSON.parse(event.data)
  if (message.id) {
    const waiter = pending.get(message.id)
    if (!waiter) return
    pending.delete(message.id)
    if (message.error) waiter.reject(new Error(JSON.stringify(message.error)))
    else waiter.resolve(message.result)
    return
  }
  if (message.method === 'Runtime.exceptionThrown' || message.method === 'Runtime.consoleAPICalled' || message.method === 'Log.entryAdded' || message.method === 'Network.loadingFailed') {
    events.push(message)
  }
})

function send(method, params = {}) {
  const id = ++sequence
  socket.send(JSON.stringify({ id, method, params }))
  return new Promise((resolve, reject) => pending.set(id, { resolve, reject }))
}

async function evaluate(expression, awaitPromise = true) {
  const result = await send('Runtime.evaluate', { expression, awaitPromise, returnByValue: true })
  if (result.exceptionDetails) throw new Error(result.exceptionDetails.text)
  return result.result.value
}

const wait = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds))

await send('Runtime.enable')
await send('Log.enable')
await send('Page.enable')
await send('Network.enable')

async function snapshot() {
  return evaluate(`(async () => ({
    url: location.href,
    title: document.title,
    readyState: document.readyState,
    rootChildren: document.querySelector('#root')?.childElementCount ?? -1,
    windowRoot: document.querySelectorAll('.window-root').length,
    tabs: [...document.querySelectorAll('.tab')].map((tab) => tab.textContent?.trim()),
    activeTab: document.querySelector('.tab--active')?.textContent?.trim(),
    monacoEditors: document.querySelectorAll('.monaco-editor').length,
    editorTextareas: document.querySelectorAll('.monaco-editor textarea.inputarea').length,
    previewHeadings: [...document.querySelectorAll('.markdown-preview h1,.markdown-preview h2')].map((node) => node.textContent),
    previewTables: document.querySelectorAll('.markdown-preview table').length,
    previewFencedCode: document.querySelectorAll('.markdown-preview pre code').length,
    previewImages: [...document.querySelectorAll('.markdown-preview img')].map((node) => ({
      alt: node.alt,
      naturalWidth: node.naturalWidth,
      src: node.src,
    })),
    preferences: await window.GetPreferences(),
    previewZoom: document.querySelector('.markdown-preview__content')?.style.zoom,
    previewScrollTop: document.querySelector('.markdown-preview')?.scrollTop,
    previewScrollHeight: document.querySelector('.markdown-preview')?.scrollHeight,
    previewClientHeight: document.querySelector('.markdown-preview')?.clientHeight,
    titlebarHeight: document.querySelector('.titlebar')?.getBoundingClientRect().height,
    editorFontSize: document.querySelector('.monaco-editor .view-lines') ? getComputedStyle(document.querySelector('.monaco-editor .view-lines')).fontSize : null,
    devicePixelRatio: window.devicePixelRatio,
    innerWidth: window.innerWidth,
    earlyDropProbe: window.__earlyDropProbe,
    status: document.querySelector('.statusbar')?.textContent,
    stylesheets: document.styleSheets.length,
    resources: performance.getEntriesByType('resource').map((entry) => entry.name),
    bridgeMissing: ${JSON.stringify([
      'ReportRuntimeEvent', 'GetInitialFile', 'OpenFile', 'ReadFile', 'SaveFile', 'SaveFileAs',
      'CheckFile', 'ResolveResource', 'OpenLink', 'ConfirmDiscard', 'ConfirmReload',
      'GetPreferences', 'SavePreferences', 'SetDirty', 'WindowMinimize',
      'WindowToggleMaximize', 'WindowClose', 'WindowDrag', 'WindowResize', 'CloseAfterSave',
    ])}.filter((name) => typeof window[name] !== 'function')
  }))()`)
}

if (action === 'snapshot') {
  await wait(1000)
} else if (action === 'new-edit') {
  await evaluate(`[...document.querySelectorAll('button')].find((button) => button.textContent === 'New')?.click()`)
  await wait(300)
  await evaluate(`if (!document.querySelector('.monaco-editor textarea.inputarea')) [...document.querySelectorAll('button')].find((button) => button.textContent === 'Split')?.click()`)
  await wait(500)
  await evaluate(`document.querySelector('.monaco-editor textarea.inputarea')?.focus()`)
  await send('Input.insertText', { text: '# Live Preview Check\n\nTyped through WebView2 into Monaco.\n' })
  await wait(700)
} else if (action === 'edit-more') {
  await evaluate(`document.querySelector('.monaco-editor textarea.inputarea')?.focus()`)
  await send('Input.insertText', { text: '\nSaved again through the native Save action.\n' })
  await wait(500)
} else if (action === 'drop') {
  await evaluate(`(() => {
    const before = location.href
    const transfer = new DataTransfer()
    transfer.items.add(new File(['# Dropped Markdown\\n\\n| A | B |\\n|---|---|\\n| 1 | 2 |\\n'], 'dropped-runtime.md', { type: 'text/markdown' }))
    for (const type of ['dragenter', 'dragover', 'drop']) {
      window.dispatchEvent(new DragEvent(type, { bubbles: true, cancelable: true, dataTransfer: transfer }))
    }
    return { before, after: location.href }
  })()`)
  await wait(700)
} else if (action === 'unsupported-drop') {
  await evaluate(`(() => {
    const transfer = new DataTransfer()
    transfer.items.add(new File(['not markdown'], 'blocked.txt', { type: 'text/plain' }))
    window.dispatchEvent(new DragEvent('dragenter', { bubbles: true, cancelable: true, dataTransfer: transfer }))
    window.dispatchEvent(new DragEvent('dragover', { bubbles: true, cancelable: true, dataTransfer: transfer }))
    window.dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: transfer }))
  })()`)
  await wait(300)
} else if (action === 'early-drop-reload') {
  await send('Page.addScriptToEvaluateOnNewDocument', { source: `(() => {
    window.__earlyDropProbe = { installed: true, dispatched: false }
    const dispatchBeforeReact = () => {
      if (!window.__symmdRuntimeInstalled) {
        setTimeout(dispatchBeforeReact, 0)
        return
      }
      const queue = window.__symmdDropQueue
      const originalPush = queue.push
      queue.push = function (...items) {
        window.__earlyDropProbe.queuedBeforeReact = !window.__symmdDropHandlerReady
        window.__earlyDropProbe.queueLengthAtPush = this.length + items.length
        queue.push = originalPush
        return originalPush.apply(this, items)
      }
      const before = location.href
      const transfer = new DataTransfer()
      transfer.items.add(new File(['# Early Drop Before React\\n\\nQueued before the React mount.\\n'], 'early-boot-drop.md', { type: 'text/markdown' }))
      for (const type of ['dragenter', 'dragover', 'drop']) {
        window.dispatchEvent(new DragEvent(type, { bubbles: true, cancelable: true, dataTransfer: transfer }))
      }
      window.__earlyDropProbe = {
        installed: true,
        dispatched: true,
        handlerReadyAtDrop: window.__symmdDropHandlerReady,
        queueLengthImmediatelyAfterDrop: window.__symmdDropQueue?.length ?? -1,
        before,
        after: location.href,
      }
    }
    dispatchBeforeReact()
  })()` })
  events.length = 0
  await send('Page.reload', { ignoreCache: true })
  await wait(2500)
} else if (action === 'navigate-file') {
  const fileURL = process.argv[3]
  if (!fileURL) throw new Error('navigate-file requires a file URL argument')
  events.length = 0
  await send('Page.navigate', { url: fileURL })
  await wait(2000)
} else if (action === 'worker') {
  await evaluate(`new Promise((resolve) => {
    const worker = self.MonacoEnvironment.getWorker()
    let failed = false
    worker.addEventListener('error', () => { failed = true })
    setTimeout(() => { worker.terminate(); resolve({ created: true, failed }) }, 750)
  })`)
} else if (action === 'click-open') {
  await evaluate(`[...document.querySelectorAll('button')].find((button) => button.textContent === 'Open')?.click()`)
} else if (action === 'click-save') {
  await evaluate(`[...document.querySelectorAll('button')].find((button) => button.textContent === 'Save')?.click()`)
} else if (action === 'click-save-as') {
  await evaluate(`[...document.querySelectorAll('button')].find((button) => button.textContent === 'Save As')?.click()`)
} else if (action === 'close-active-tab') {
  await evaluate(`document.querySelector('.tab--active .tab__close')?.click()`)
} else if (action === 'close-app') {
  await evaluate(`window.WindowClose()`)
  console.log(JSON.stringify({ action, requested: true }, null, 2))
  socket.close()
  process.exit(0)
} else if (action === 'view') {
  const mode = process.argv[3]
  if (!['Editor', 'Split', 'Preview'].includes(mode)) throw new Error('view requires Editor, Split, or Preview')
  await evaluate(`[...document.querySelectorAll('.view-switcher button')].find((button) => button.textContent === ${JSON.stringify(mode)})?.click()`)
  await wait(300)
} else if (action === 'wheel') {
  const selector = process.argv[3]
  const deltaY = Number(process.argv[4])
  const control = process.argv[5] === 'ctrl'
  if (!selector || !Number.isFinite(deltaY)) throw new Error('wheel requires a selector and numeric deltaY')
  const point = await evaluate(`(() => {
    const bounds = document.querySelector(${JSON.stringify(selector)})?.getBoundingClientRect()
    return bounds ? { x: bounds.left + bounds.width / 2, y: bounds.top + bounds.height / 2 } : null
  })()`)
  if (!point) throw new Error(`wheel target ${selector} was not found`)
  await send('Input.dispatchMouseEvent', { type: 'mouseWheel', x: point.x, y: point.y, deltaX: 0, deltaY, modifiers: control ? 2 : 0 })
  await wait(500)
} else if (action === 'screenshot') {
  const capture = await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false })
  const output = process.argv[3] || 'testdata/runtime/symmd-runtime.png'
  await fs.writeFile(output, Buffer.from(capture.data, 'base64'))
}

const state = await snapshot()
await wait(250)
console.log(JSON.stringify({ action, state, events }, null, 2))
socket.close()
