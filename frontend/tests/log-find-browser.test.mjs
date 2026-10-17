import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { test } from 'node:test'
import { createServer } from 'vite'

const browserPath = [process.env.BROWSER_PATH, 'C:/Program Files/Google/Chrome/Application/chrome.exe', 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe', '/usr/bin/chromium', '/usr/bin/google-chrome'].find((path) => path && existsSync(path))

test('log find stays clickable above real Monaco Sticky Scroll', { skip: !browserPath ? 'Set BROWSER_PATH to a Chromium browser' : typeof WebSocket === 'undefined' ? 'Browser test requires Node.js 22+ with global WebSocket' : false, timeout: 90000 }, async () => {
  const profile = await mkdtemp(join(tmpdir(), 'symmd-log-find-'))
  let browser, socket, server
  try {
    server = await createServer({ root: fileURLToPath(new URL('../', import.meta.url)), configFile: false, logLevel: 'error', cacheDir: join(profile, 'vite-cache'), esbuild: { jsx: 'automatic' }, optimizeDeps: { noDiscovery: true, include: ['react', 'react/jsx-runtime', 'react/jsx-dev-runtime', 'react-dom', 'react-dom/client'] }, server: { host: '127.0.0.1', port: 0 }, plugins: [{
      name: 'log-find-browser-fixture', configureServer(vite) {
        vite.middlewares.use('/log-find-test', (_req, res) => { res.setHeader('Content-Type', 'text/html'); res.end('<div id="root"></div><script type="module" src="/tests/fixtures/log-find-browser.jsx"></script>') })
      },
    }] })
    await server.listen()
    browser = spawn(browserPath, ['--headless=new', '--no-first-run', '--no-default-browser-check', '--remote-debugging-port=0', `--user-data-dir=${profile}`, '--window-size=1100,760', 'about:blank'], { windowsHide: true, stdio: ['ignore', 'ignore', 'pipe'] })
    const endpoint = await new Promise((resolve, reject) => {
      let output = ''
      const timer = setTimeout(() => reject(new Error(`Browser startup timed out: ${output}`)), 15000)
      browser.once('error', (error) => { clearTimeout(timer); reject(error) })
      browser.once('exit', (code) => { clearTimeout(timer); reject(new Error(`Browser exited: ${code}; ${output}`)) })
      browser.stderr.on('data', (data) => { output += data; const match = output.match(/DevTools listening on (ws:\/\/[^\s]+)/); if (match) { clearTimeout(timer); resolve(match[1]) } })
    })
    socket = new WebSocket(endpoint)
    await once(socket, 'open')
    let serial = 0
    const pending = new Map(), pageErrors = []
    socket.addEventListener('message', ({ data }) => {
      const message = JSON.parse(data)
      if (message.method === 'Runtime.exceptionThrown') pageErrors.push(message.params.exceptionDetails)
      if (!pending.has(message.id)) return
      const { resolve, reject, timer } = pending.get(message.id)
      pending.delete(message.id); clearTimeout(timer)
      if (message.error) reject(new Error(JSON.stringify(message.error))); else resolve(message.result)
    })
    const send = (method, params = {}, sessionId) => new Promise((resolve, reject) => {
      const id = ++serial
      const timer = setTimeout(() => { pending.delete(id); reject(new Error(`CDP timeout: ${method} ${params.expression ?? ''}`)) }, 15000)
      pending.set(id, { resolve, reject, timer })
      socket.send(JSON.stringify({ id, method, params, sessionId }))
    })
    const { targetId } = await send('Target.createTarget', { url: 'about:blank' })
    const { sessionId } = await send('Target.attachToTarget', { targetId, flatten: true })
    const evaluate = async (expression) => {
      const value = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true }, sessionId)
      assert.equal(value.exceptionDetails, undefined, JSON.stringify(value.exceptionDetails))
      return value.result.value
    }
    const waitFor = async (expression) => {
      const deadline = Date.now() + 15000
      while (Date.now() < deadline) { if (await evaluate(`Boolean(${expression})`)) return; await new Promise((resolve) => setTimeout(resolve, 50)) }
      assert.fail(`Timed out: ${expression}; browser errors: ${JSON.stringify(pageErrors)}; focus: ${await evaluate('document.activeElement.outerHTML.slice(0, 300)')}; sticky height: ${await evaluate('document.querySelector(".sticky-widget")?.getBoundingClientRect().height')}`)
    }
    const click = async (selector) => {
      const point = await evaluate(`(() => { const e = document.querySelector(${JSON.stringify(selector)}); const r = e.getBoundingClientRect(); const x = r.x + r.width / 2, y = r.y + r.height / 2; return { x, y, hit: e.contains(document.elementFromPoint(x, y)), top: document.elementFromPoint(x, y)?.outerHTML.slice(0, 200) } })()`)
      assert.equal(point.hit, true, `${selector} is covered by ${point.top}`)
      await send('Input.dispatchMouseEvent', { type: 'mousePressed', x: point.x, y: point.y, button: 'left', clickCount: 1 }, sessionId)
      await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: point.x, y: point.y, button: 'left', clickCount: 1 }, sessionId)
    }
    const key = async (key, code, modifiers = 0) => {
      await send('Input.dispatchKeyEvent', { type: 'keyDown', key, code, modifiers, windowsVirtualKeyCode: key === 'Enter' ? 13 : key === 'Escape' ? 27 : 0 }, sessionId)
      await send('Input.dispatchKeyEvent', { type: 'keyUp', key, code, modifiers }, sessionId)
    }
    await send('Runtime.enable', {}, sessionId)
    await send('Page.navigate', { url: `${server.resolvedUrls.local[0]}log-find-test` }, sessionId)
    await waitFor('window.logFindFixture?.ref.current && logFindFixture.monaco.editor.getEditors()[0]?.getValue().includes("needle")')
    await evaluate('window.e = logFindFixture.monaco.editor.getEditors()[0]; e.setScrollTop(180); logFindFixture.showFind()')
    await waitFor('document.querySelector(".sticky-widget")?.getBoundingClientRect().height > 0 && document.querySelector(".log-find input") === document.activeElement')
    assert.equal(await evaluate('e.getOption(logFindFixture.monaco.editor.EditorOption.stickyScroll).enabled'), true)
    // The real sticky widget must intersect the panel; otherwise hit testing would be vacuous.
    assert.equal(await evaluate('document.querySelector(".sticky-widget").getBoundingClientRect().top < document.querySelector(".log-find").getBoundingClientRect().bottom'), true)
    for (const theme of ['dark', 'light']) {
      await evaluate(`logFindFixture.render('${theme}')`)
      await waitFor(`document.querySelector('.log-viewer--${theme}')`)
      await click('[aria-label="Find in log"]')
      await send('Input.insertText', { text: 'needle' }, sessionId)
      await waitFor('document.querySelector(".log-find__count")?.textContent.includes("/ 160")')
      await evaluate('e.setScrollTop(180)')
      await waitFor('document.querySelector(".sticky-widget").getBoundingClientRect().height > 0')
      assert.deepEqual(await evaluate(`Array.from(document.querySelectorAll('.log-find__field, .log-find__count, .log-find__icon')).filter(element => {
        const r = element.getBoundingClientRect()
        return [0.1, 0.5, 0.9].some(x => [0.1, 0.5, 0.9].some(y => !element.contains(document.elementFromPoint(r.x + r.width * x, r.y + r.height * y))))
      }).map(element => element.className)`), [], 'the field, counter and buttons must remain unobscured across their area')
      await click('[aria-label="Next match"]')
      await waitFor('document.querySelector(".log-find__count").textContent.includes("2 / 160")')
      assert.equal(await evaluate('e.getModel().getValueInRange(e.getSelection())'), 'needle')
      await click('[aria-label="Previous match"]')
      await waitFor('document.querySelector(".log-find__count").textContent.includes("1 / 160")')
      await click('[aria-label="Find in log"]')
      await key('Enter', 'Enter')
      await waitFor('document.querySelector(".log-find__count").textContent.includes("2 / 160")')
      await key('Enter', 'Enter', 8)
      await waitFor('document.querySelector(".log-find__count").textContent.includes("1 / 160")')
      await click('[aria-label="Clear search"]')
      assert.equal(await evaluate('document.activeElement.value'), '')
      await key('Escape', 'Escape')
      await waitFor('!document.querySelector(".log-find") && e.hasTextFocus()')
      await evaluate('new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))')
      await evaluate('logFindFixture.showFind(); e.setScrollTop(180)')
      await waitFor('document.querySelector(".log-find input") === document.activeElement && document.querySelector(".sticky-widget").getBoundingClientRect().height > 0')
      await click('[aria-label="Close find"]')
      await waitFor('!document.querySelector(".log-find") && e.hasTextFocus()')
      await evaluate('logFindFixture.showFind()')
      await waitFor('document.querySelector(".log-find input") === document.activeElement')
    }
    // Other Monaco overlays retain their own order inside the editor context.
    await evaluate('e.getAction("actions.find").run()')
    await waitFor('document.querySelector(".monaco-editor .find-widget.visible")')
    await click('[aria-label="Find in log"]')
    await evaluate('e.getContribution("editor.contrib.findController").closeFindWidget()')
    await click('.log-editor-toolbar button')
    await waitFor('document.querySelector(".log-scroll").clientHeight > 0')
    await click('[aria-label="Find in log"]')
    await click('.log-editor-toolbar button')
    await waitFor('document.querySelector(".log-scroll").clientHeight === 0')
    await click('[aria-label="Log position"]')
    await waitFor('e.getScrollTop() > 0')
    await click('.monaco-editor .scrollbar.horizontal')
    await waitFor('e.getScrollLeft() > 0')
    await click('.monaco-editor .scrollbar.vertical')
    await waitFor('e.getScrollTop() > 0')
    await evaluate('e.setScrollPosition({ scrollTop: 0, scrollLeft: 0 }); e.setSelection(new logFindFixture.monaco.Selection(1, 1, 1, 5)); e.focus()')
    await waitFor('e.hasTextFocus() && !e.getOption(logFindFixture.monaco.editor.EditorOption.readOnly)')
    assert.equal(await evaluate('e.getModel().getValueInRange(e.getSelection())'), 'INFO')
    await send('Input.insertText', { text: 'W' }, sessionId)
    await waitFor('logFindFixture.edits.length === 1')
    await evaluate('logFindFixture.ref.current.flush()')
    assert.deepEqual(await evaluate('logFindFixture.edits'), [{ start: 0, end: 4, inserted: 'W' }])
    assert.equal(await evaluate('e.getValue().startsWith("W scope")'), true)
    assert.deepEqual(await evaluate('logFindFixture.errors'), [])
    assert.deepEqual(pageErrors, [])
  } finally {
    socket?.close()
    if (browser && browser.exitCode === null) { browser.kill(); await once(browser, 'exit') }
    await server?.close()
    await rm(profile, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
  }
})
