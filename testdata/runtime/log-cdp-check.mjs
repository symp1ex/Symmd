// Run against a diagnostic Symmd instance opened on a synthetic multi-MiB log:
// SYMMD_DEBUG=1 WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS=--remote-debugging-port=9333
// node testdata/runtime/log-cdp-check.mjs
import assert from 'node:assert/strict'

const targets = await fetch(`http://127.0.0.1:${process.env.SYMMD_CDP_PORT || 9333}/json`).then((response) => response.json())
const target = targets.find((page) => page.type === 'page' && page.url.includes('app.symmd.local'))
assert.ok(target, 'Symmd WebView2 target')
const socket = new WebSocket(target.webSocketDebuggerUrl)
await new Promise((resolve) => socket.addEventListener('open', resolve, { once: true }))
let sequence = 0
const pending = new Map()
socket.addEventListener('message', ({ data }) => {
  const message = JSON.parse(data)
  if (message.id) { const job = pending.get(message.id); pending.delete(message.id); message.error ? job.reject(new Error(JSON.stringify(message.error))) : job.resolve(message.result) }
})
function send(method, params = {}) {
  const id = ++sequence
  socket.send(JSON.stringify({ id, method, params }))
  return new Promise((resolve, reject) => pending.set(id, { resolve, reject }))
}
async function evaluate(expression) {
  const result = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true })
  if (result.exceptionDetails) throw new Error(JSON.stringify(result.exceptionDetails))
  return result.result.value
}
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
const mouse = (type, x, y, down = false) => send('Input.dispatchMouseEvent', { type, x, y, button: type === 'mouseMoved' && !down ? 'none' : 'left', buttons: down ? 1 : 0, clickCount: 1 })
const state = () => evaluate(`(() => {
  const host = document.querySelector('.log-editor-window').getBoundingClientRect();
  const lines = [...document.querySelectorAll('.log-editor-window .view-line')].map(node => ({text: node.textContent, top: node.getBoundingClientRect().top, bottom: node.getBoundingClientRect().bottom}));
  return { reads: window.__logProbe.reads, searches: window.__logProbe.searches, count: document.querySelector('.log-find__count')?.textContent, focused: document.activeElement?.getAttribute('aria-label'), anchor: lines.find(line => line.bottom > host.top + 1 && line.top < host.bottom) };
})()`)
try {
  await send('Emulation.setFocusEmulationEnabled', { enabled: false })
  const bridge = await evaluate(`(async () => {
    const initial = await window.GetInitialFile();
    const info = await window.OpenLog(${JSON.stringify(process.env.SYMMD_CDP_LOG || '')} || initial.path);
    try {
      const first = await window.ReadLogWindow(info.handle, 0);
      const find = async () => {
        const id = await window.FindLog(info.handle, 'cursor-search-target', 0, false);
        for (;;) { const result = await window.PollLogSearch(info.handle, id); if (result.error) throw new Error(result.error); if (result.done) return result.offset; await new Promise(resolve => setTimeout(resolve, 20)); }
      };
      const offset = await find();
      const id = await window.CountLogMatches(info.handle, 'cursor-search-target');
      let count;
      for (;;) { count = await window.PollLogCount(info.handle, id, offset); if (count.error) throw new Error(count.error); if (count.done) break; await new Promise(resolve => setTimeout(resolve, 20)); }
      await window.ReadLogWindow(info.handle, Math.min(info.size, 3 << 20));
      return {encoding:info.encoding, offset, unchanged:offset===await find(), total:count.total, ordinal:count.ordinal, bounded:first.next-first.offset<=2<<20};
    } finally { await window.CloseLog(info.handle); }
  })()`)
  assert.ok(bridge.offset > 2 << 20)
  assert.equal(bridge.total, 1)
  assert.equal(bridge.ordinal, 1)
  assert.ok(bridge.unchanged && bridge.bounded)
  if (await evaluate('document.hidden')) {
    console.log(JSON.stringify({ bridge, visual: 'skipped: hidden WebView cannot reliably render or receive text input; run on a visible diagnostic instance' }, null, 2))
  } else {
  // A background diagnostic WebView otherwise pauses animation frames.
  await send('Emulation.setFocusEmulationEnabled', { enabled: true })
  await send('Page.reload')
  await wait(1400)
  await evaluate(`(() => {
    const read = window.ReadLogWindow, find = window.FindLog;
    window.__logProbe = {reads:[], searches:[], read, find};
    window.ReadLogWindow = async (...args) => { const result = await read(...args); window.__logProbe.reads.push({target:args[1], offset:result.offset, next:result.next, editable:result.editable}); return result; };
    window.FindLog = (...args) => { window.__logProbe.searches.push({offset:args[2],previous:args[3]}); return find(...args); };
  })()`)
  const report = []
  for (const direction of [1, 1, -1]) {
    const geometry = await evaluate(`(() => {
      const track = document.querySelector('.log-editor-window .scrollbar.vertical').getBoundingClientRect();
      const slider = document.querySelector('.log-editor-window .scrollbar.vertical .slider').getBoundingClientRect();
      return {x: slider.x+slider.width/2, y: slider.y+slider.height/2, end: ${direction} > 0 ? track.bottom-slider.height/2+2 : track.top+slider.height/2-2};
    })()`)
    const initial = await state()
    await mouse('mouseMoved', geometry.x, geometry.y)
    await wait(50)
    await mouse('mousePressed', geometry.x, geometry.y, true)
    await wait(50)
    for (let step = 1; step <= 5; step++) { await mouse('mouseMoved', geometry.x, geometry.y+(geometry.end-geometry.y)*step/5, true); await wait(20) }
    await wait(180)
    const held = await state()
    assert.equal(held.reads.length, initial.reads.length, 'window stays fixed while thumb is held')
    await mouse('mouseReleased', geometry.x, geometry.end)
    await mouse('mouseMoved', 800, 400)
    await wait(550)
    const shifted = await state()
    assert.equal(shifted.reads.length, initial.reads.length+1, 'thumb release shifts one window')
    assert.ok(shifted.reads.at(-1).next-shifted.reads.at(-1).offset <= 2 << 20)
    assert.equal(shifted.anchor.text, held.anchor.text, 'visible text stays anchored')
    assert.ok(Math.abs(shifted.anchor.top-held.anchor.top) <= 1, 'partial row retains its screen position')
    assert.equal(shifted.searches.length, 0, 'scrolling does not search')
    report.push({ direction, offset: shifted.reads.at(-1).offset, anchored: true })
  }
  // Exercise the real input, delayed Go search and global count through IPC.
  await evaluate(`document.querySelector('.log-editor-window textarea').focus()`)
  await send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'f', code: 'KeyF', modifiers: 2, windowsVirtualKeyCode: 70 })
  await send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'f', code: 'KeyF', modifiers: 2, windowsVirtualKeyCode: 70 })
  await wait(120)
  await send('Input.insertText', { text: 'cursor-search-target' })
  // Hidden WebViews may not accept IME text from Input.insertText. In that case
  // use the public DOM input event; React and the native Go bridge still run.
  await evaluate(`(() => {
    const input = document.querySelector('.log-find input');
    if (!input.value) { Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(input, 'cursor-search-target'); input.dispatchEvent(new Event('input', {bubbles:true})); }
  })()`)
  await wait(1000)
  const found = await state()
  assert.equal(found.focused, 'Find in log', 'search leaves input focused')
  assert.match(found.count.replace(/\s/g,''), /^1\/1$/)
  assert.ok(found.searches.length >= 1)
  console.log(JSON.stringify({ scroll: report, globalSearch: { count: found.count, focus: found.focused, starts: found.searches } }, null, 2))
  }
} finally {
  await evaluate(`(() => { const probe = window.__logProbe; if (probe) { window.ReadLogWindow = probe.read; window.FindLog = probe.find; delete window.__logProbe; } })()`).catch(() => {})
  await send('Emulation.setFocusEmulationEnabled', { enabled: false }).catch(() => {})
  socket.close()
}
