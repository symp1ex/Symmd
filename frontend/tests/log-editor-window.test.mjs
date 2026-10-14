import assert from 'node:assert/strict'
import { before, after, test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { createServer } from 'vite'

let server, harness, LogEditorWindow, native
const wait = (ms = 160) => new Promise((resolve) => setTimeout(resolve, ms))
before(async () => {
  server = await createServer({ root: fileURLToPath(new URL('../', import.meta.url)), configFile: false, appType: 'custom', logLevel: 'silent', optimizeDeps: { noDiscovery: true }, esbuild: { jsx: 'automatic' }, server: { middlewareMode: true }, plugins: [{
    name: 'log-component-double', enforce: 'pre',
    transform(source, id) {
      if (id.endsWith('/src/log/LogEditorWindow.tsx')) return source.replace("from 'react'", "from '/tests/fixtures/log-editor-harness.mjs'").replace("from '../editor/monaco'", "from '/tests/fixtures/log-editor-harness.mjs'")
    },
  }] })
  harness = await server.ssrLoadModule('/tests/fixtures/log-editor-harness.mjs')
  ;({ native } = await server.ssrLoadModule('/src/bridge/native.ts'))
  ;({ LogEditorWindow } = await server.ssrLoadModule('/src/log/LogEditorWindow.tsx'))
})
after(async () => { await server?.close() })

function setup(text = '0123456789abcdef\n'.repeat(400000), encoding = 'UTF-8') {
  const host = new EventTarget()
  host.getBoundingClientRect = () => ({ left: 0, top: 0 })
  globalThis.window = new EventTarget()
  globalThis.window.setTimeout = setTimeout
  const bytes = encoding.startsWith('UTF-16') ? 2 : 1
  const info = { handle: 1, size: text.length * bytes, revision: 1, dirty: false, bom: 0, encoding }
  const reads = [], errors = [], positions = [], edits = []
  native.statLog = async () => info
  native.readLogWindow = async (_handle, target) => {
    reads.push(target)
    const start = Math.max(0, Math.floor((target - (2 << 18)) / bytes))
    const value = text.slice(start, start + (2 << 20) / bytes)
    return { offset: start * bytes, next: (start + value.length) * bytes, text: value, encoding, size: info.size, revision: info.revision, editable: true }
  }
  native.replaceLog = async (_handle, start, end, inserted) => { edits.push({ start, end, inserted }); info.size += inserted.length * bytes - (end - start); info.revision++; return info }
  harness.mount(host)
  const ref = { current: null }
  LogEditorWindow({ info, theme: 'dark', fontSize: 14, wordWrap: false, onInfo() {}, onPosition: (value) => positions.push(value), onPendingEdit() {}, onError: (value) => errors.push(value) }, ref)
  harness.start()
  return { ref, info, host, reads, errors, positions, edits }
}

test('wheel-style scroll shifts bounded windows down and up, preserving a partial row and horizontal scroll', async () => {
  const state = setup()
  try {
    await wait(0)
    const editor = harness.runtime.instance
    const initialCenter = editor.centered
    let previous = state.reads.length
    for (let i = 0; i < 3; i++) {
      editor.scrollTo(editor.getScrollHeight() - editor.height - 7, 43)
      const before = state.ref.current.cursorOffset()
      await wait()
      assert.equal(state.reads.length, ++previous)
      assert.equal(editor.left, 43)
      assert.equal(editor.top % 20, 13)
      assert.equal(editor.centered, initialCenter)
      assert.equal(state.ref.current.cursorOffset(), before)
      assert.ok(editor.getModel().getValueLength() <= 2 << 20)
    }
    const high = state.reads.at(-1)
    editor.scrollTo(7)
    await wait()
    assert.ok(state.reads.at(-1) < high)
    assert.equal(editor.top % 20, 7)
    const stable = state.reads.length
    await wait(250)
    assert.equal(state.reads.length, stable, 'programmatic events do not recursively load')
    assert.equal(editor.readOnly, true, 'cursor outside the window cannot edit at a substituted position')
    editor.setPosition(editor.visiblePosition())
    assert.equal(editor.readOnly, false)
  } finally { harness.dispose() }
})

test('thumb drag waits for release and stale scroll replies cannot move the viewport', async () => {
  const state = setup()
  try {
    await wait(0)
    const editor = harness.runtime.instance
    state.host.dispatchEvent(new Event('pointerdown'))
    editor.scrollTo(editor.getScrollHeight() - editor.height)
    await wait()
    assert.equal(state.reads.length, 1)
    window.dispatchEvent(new Event('pointerup'))
    await wait()
    assert.equal(state.reads.length, 2)
    const read = native.readLogWindow
    let release
    native.readLogWindow = async (...args) => { const value = await read(...args); await new Promise((resolve) => { release = resolve }); return value }
    editor.scrollTo(editor.getScrollHeight() - editor.height)
    await wait(100)
    editor.scrollTo(1000)
    release()
    await wait()
    assert.equal(editor.top, 1000)
  } finally { harness.dispose() }
})

test('wrapped long lines preserve visible character position; short documents never reload', async () => {
  const state = setup('x'.repeat(6 << 20))
  try {
    await wait(0)
    const editor = harness.runtime.instance
    editor.wrappedColumns = 80
    editor.scrollTo(editor.getScrollHeight() - editor.height - 9)
    await wait()
    assert.equal(state.reads.length, 2)
    assert.equal(editor.top % 20, 11)
    assert.equal(editor.centered, 1)
  } finally { harness.dispose() }
  const short = setup('short\nend')
  try {
    await wait(0)
    harness.runtime.instance.scrollTo(0)
    await wait()
    assert.equal(short.reads.length, 1)
  } finally { harness.dispose() }
})

test('UTF-16 edits use original bytes and rejected single-byte inserts leave the model unchanged', async () => {
  const state = setup('a😀\r\nb', 'UTF-16 LE')
  try {
    await wait(0)
    harness.runtime.instance.change(5, 0, 'Ж')
    await state.ref.current.flush()
    assert.deepEqual(state.edits, [{ start: 12, end: 12, inserted: 'Ж' }])
  } finally { harness.dispose() }
  const legacy = setup('test', 'Windows-1251')
  try {
    await wait(0)
    harness.runtime.instance.change(0, 0, '😀')
    await legacy.ref.current.flush()
    assert.equal(legacy.edits.length, 0)
    assert.equal(harness.runtime.instance.getValue(), 'test')
    assert.match(legacy.errors[0], /not representable/)
  } finally { harness.dispose() }
})
