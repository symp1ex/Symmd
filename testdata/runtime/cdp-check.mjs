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
    previewMermaid: document.querySelectorAll('.markdown-preview .mermaid-diagram').length,
    previewMermaidSourceLines: [...document.querySelectorAll('.markdown-preview .mermaid-diagram')].map((node) => node.dataset.sourceLine),
    previewMermaidSvg: document.querySelectorAll('.markdown-preview .mermaid-diagram > svg').length,
    previewMermaidErrors: document.querySelectorAll('.markdown-preview .mermaid-diagram--error').length,
    previewMermaidErrorText: [...document.querySelectorAll('.markdown-preview .mermaid-diagram__error')].map((node) => node.textContent),
    previewMermaidUnsafe: document.querySelectorAll('.markdown-preview .mermaid-diagram script,.markdown-preview .mermaid-diagram iframe,.markdown-preview .mermaid-diagram [onload],.markdown-preview .mermaid-diagram [onerror],.markdown-preview .mermaid-diagram [onclick]').length,
    previewMermaidJavascriptLinks: [...document.querySelectorAll('.markdown-preview .mermaid-diagram a')].filter((node) => /^javascript:/i.test(node.getAttribute('href') ?? '')).length,
    previewLowercaseGitGraphSvg: Boolean([...document.querySelectorAll('.mermaid-diagram')].find((node) => /^\\s*gitgraph(?:\\s|$)/.test(node.dataset.mermaidSource ?? ''))?.querySelector(':scope > svg')),
    previewCanonicalGitGraphSvg: Boolean([...document.querySelectorAll('.mermaid-diagram')].find((node) => /^\\s*gitGraph(?:\\s|$)/.test(node.dataset.mermaidSource ?? ''))?.querySelector(':scope > svg')),
    previewGanttGeometry: (() => {
      const container = [...document.querySelectorAll('.mermaid-diagram')].find((node) => /^\\s*gantt(?:\\s|$)/.test(node.dataset.mermaidSource ?? ''))
      const svg = container?.querySelector(':scope > svg')
      return container && svg ? { containerWidth: container.offsetWidth, viewBoxWidth: svg.viewBox.baseVal.width } : null
    })(),
    temporaryMermaidContainers: document.querySelectorAll('[data-symmd-mermaid-render-host]').length,
    mermaidInjected: window.__mermaidInjected === true,
    mermaidThemeProbe: window.__symmdMermaidThemeProbe,
    mermaidResizeProbe: window.__symmdMermaidResizeProbe,
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
      'CheckFile', 'ResolveResource', 'OpenLink', 'SaveLinkAs', 'ShowContextMenu', 'ConfirmDiscard', 'ConfirmReload',
      'GetPreferences', 'SavePreferences', 'SetDirty', 'WindowMinimize',
      'WindowToggleMaximize', 'WindowClose', 'WindowDrag', 'WindowResize', 'CloseAfterSave',
    ])}.filter((name) => typeof window[name] !== 'function'),
    contextMenuProbe: window.__symmdContextMenuProbe,
    editorContextMenuActions: window.__symmdEditorContextMenuActions,
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
} else if (action === 'context-menu-probe') {
  await evaluate(`new Promise((resolve) => {
    const original = window.ShowContextMenu
    const calls = []
    window.ShowContextMenu = async (options) => { calls.push(options); return '' }
    document.querySelector('.editor-host')?.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true }))
    const link = document.createElement('a')
    link.href = '../shared/file.md'
    link.textContent = 'relative link'
    document.querySelector('.markdown-preview__content')?.appendChild(link)
    link.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true }))
    setTimeout(() => {
      window.ShowContextMenu = original
      link.remove()
      window.__symmdContextMenuProbe = calls
      resolve()
    }, 100)
  })`)
} else if (action === 'editor-context-menu-actions') {
  await wait(1000)
  await evaluate(`document.querySelector('.monaco-editor textarea.inputarea')?.focus()`)
  await evaluate(`new Promise(async (resolve, reject) => {
    const originalShow = window.ShowContextMenu
    const host = document.querySelector('.editor-host')
    const run = async (command) => {
      window.ShowContextMenu = async () => command
      host.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true }))
      await new Promise((done) => setTimeout(done, 100))
    }
    try {
      const originalText = document.querySelector('.view-lines')?.textContent ?? ''
      await run('selectAll')
      await run('copy')
      const copyPreservedContent = document.querySelector('.view-lines')?.textContent === originalText
      await run('cut')
      const cutCleared = !document.querySelector('.view-lines')?.textContent
      await run('paste')
      const pasteRestoredContent = document.querySelector('.view-lines')?.textContent === originalText
      window.__symmdEditorContextMenuActions = { copyPreservedContent, cutCleared, pasteRestoredContent }
      resolve()
    } catch (error) {
      reject(error)
    } finally {
      window.ShowContextMenu = originalShow
    }
  })`)
  await wait(300)
} else if (action === 'mermaid-theme') {
  await wait(2500)
  const previousSvg = await evaluate(`document.querySelector('.mermaid-diagram > svg')?.outerHTML ?? ''`)
  const nextTheme = await evaluate(`document.querySelector('.markdown-preview--light') ? 'dark' : 'light'`)
  await evaluate(`if (!document.querySelector('.settings-popover select')) document.querySelector('.titlebar__button--settings')?.click()`)
  await wait(200)
  await evaluate(`(() => {
    const select = document.querySelector('.settings-popover select')
    if (!select) return
    Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value')?.set.call(select, ${JSON.stringify(nextTheme)})
    select.dispatchEvent(new Event('change', { bubbles: true }))
  })()`)
  await wait(2500)
  await evaluate(`window.__symmdMermaidThemeProbe = {
    changed: ${JSON.stringify(previousSvg)} !== (document.querySelector('.mermaid-diagram > svg')?.outerHTML ?? ''),
    previewClass: document.querySelector('.markdown-preview')?.className,
  }`)
} else if (action === 'mermaid-resize') {
  await wait(2500)
  await evaluate(`(() => {
    window.__symmdMermaidTemporaryWidths = []
    window.__symmdMermaidTemporaryObserver = new MutationObserver((records) => {
      for (const record of records) for (const node of record.addedNodes) {
        if (node instanceof HTMLElement && 'symmdMermaidRenderHost' in node.dataset) {
          window.__symmdMermaidTemporaryWidths.push({ style: node.style.width, offset: node.offsetWidth })
        }
      }
    })
    window.__symmdMermaidTemporaryObserver.observe(document.body, { childList: true })
  })()`)
  const measureGantt = () => evaluate(`(() => {
    const container = [...document.querySelectorAll('.mermaid-diagram')].find((node) => /^\\s*gantt(?:\\s|$)/.test(node.dataset.mermaidSource ?? ''))
    const svg = container?.querySelector(':scope > svg')
    return container && svg ? { containerWidth: container.offsetWidth, viewBoxWidth: svg.viewBox.baseVal.width } : null
  })()`)
  const waitForGanttWidth = async (previousWidth) => {
    await wait(100)
    const deadline = Date.now() + 10000
    let geometry
    do {
      geometry = await measureGantt()
      if (geometry?.containerWidth === geometry?.viewBoxWidth && geometry?.containerWidth !== previousWidth) return geometry
      await wait(100)
    } while (Date.now() < deadline)
    return geometry
  }
  const initial = await measureGantt()
  await evaluate(`[...document.querySelectorAll('.view-switcher button')].find((button) => button.textContent === 'Preview')?.click()`)
  const preview = await waitForGanttWidth(initial?.containerWidth)
  await evaluate(`document.querySelector('.markdown-preview')?.dispatchEvent(new WheelEvent('wheel', { bubbles: true, ctrlKey: true, deltaY: -1 }))`)
  const zoomedPreview = await waitForGanttWidth(preview?.containerWidth)
  await evaluate(`document.querySelector('.markdown-preview')?.dispatchEvent(new WheelEvent('wheel', { bubbles: true, ctrlKey: true, deltaY: 1 }))`)
  const restoredZoom = await waitForGanttWidth(zoomedPreview?.containerWidth)
  await evaluate(`[...document.querySelectorAll('.view-switcher button')].find((button) => button.textContent === 'Split')?.click()`)
  const split = await waitForGanttWidth(restoredZoom?.containerWidth)
  await evaluate(`document.querySelector('.editor-pane')?.style.setProperty('width', '35%')`)
  const resizedSplit = await waitForGanttWidth(split?.containerWidth)
  await evaluate(`(() => {
    window.__symmdMermaidTemporaryObserver?.disconnect()
    window.__symmdMermaidResizeProbe = {
      initial: ${JSON.stringify(initial)},
      preview: ${JSON.stringify(preview)},
      zoomedPreview: ${JSON.stringify(zoomedPreview)},
      restoredZoom: ${JSON.stringify(restoredZoom)},
      split: ${JSON.stringify(split)},
      resizedSplit: ${JSON.stringify(resizedSplit)},
      temporaryWidths: window.__symmdMermaidTemporaryWidths,
      temporaryRemaining: document.querySelectorAll('[data-symmd-mermaid-render-host]').length,
    }
  })()`)
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
if (action === 'mermaid-resize') {
  const geometries = ['initial', 'preview', 'zoomedPreview', 'restoredZoom', 'split', 'resizedSplit'].map((name) => [name, state.mermaidResizeProbe?.[name]])
  for (const [name, geometry] of geometries) {
    if (!geometry || geometry.containerWidth !== geometry.viewBoxWidth || geometry.viewBoxWidth <= 300) {
      throw new Error(`Unexpected Gantt geometry for ${name}: ${JSON.stringify(geometry)}`)
    }
  }
  if (!state.previewLowercaseGitGraphSvg || !state.previewCanonicalGitGraphSvg || state.previewMermaidUnsafe || state.mermaidInjected) {
    throw new Error('Mermaid Git Graph or security runtime regression detected')
  }
  if (!state.mermaidResizeProbe.temporaryWidths.length || state.mermaidResizeProbe.temporaryWidths.some((width) => Number.parseFloat(width.style) !== width.offset) || state.mermaidResizeProbe.temporaryRemaining) {
    throw new Error('Temporary Mermaid render container width or cleanup regression detected')
  }
}
await wait(250)
console.log(JSON.stringify({ action, state, events }, null, 2))
socket.close()
