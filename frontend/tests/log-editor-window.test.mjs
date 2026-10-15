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
  const reads = [], windows = [], errors = [], positions = [], edits = []
  native.statLog = async () => info
  native.readLogWindow = async (_handle, target) => {
    reads.push(target)
    const start = Math.max(0, Math.floor((target - (2 << 18)) / bytes))
    const value = text.slice(start, start + (2 << 20) / bytes)
    const window = { offset: start * bytes, next: (start + value.length) * bytes, text: value, encoding, size: info.size, revision: info.revision, editable: true }
    windows.push(window)
    return window
  }
  native.replaceLog = async (_handle, start, end, inserted) => { edits.push({ start, end, inserted }); info.size += inserted.length * bytes - (end - start); info.revision++; return info }
  harness.mount(host)
  const ref = { current: null }
  LogEditorWindow({ info, theme: 'dark', fontSize: 14, wordWrap: false, onInfo() {}, onPosition: (value) => positions.push(value), onPendingEdit() {}, onError: (value) => errors.push(value) }, ref)
  harness.start()
  return { ref, info, host, reads, windows, errors, positions, edits }
}

test('Select All in an intermediate window keeps the whole model selected without loading', async () => {
  const state = setup()
  try {
    await wait(0)
    await state.ref.current.seek(3 << 20)
    const editor = harness.runtime.instance
    const model = editor.getModel()
    const value = model.getValue()
    const reads = state.reads.length
    for (let i = 0; i < 3; i++) {
      editor.trigger('keyboard', 'editor.action.selectAll')
      await wait()
      assert.equal(state.reads.length, reads, 'Select All must not seek from its active end')
      assert.equal(model.getValue(), value)
      assert.equal(model.getOffsetAt(editor.getSelection().getSelectionStart()), 0)
      assert.equal(model.getOffsetAt(editor.getSelection().getPosition()), value.length)
      assert.equal(editor.getSelection().isEmpty(), false)
    }
    assert.deepEqual(state.errors, [])
  } finally { harness.dispose() }
})

test('nonempty selections with an active end near either window boundary do not seek', async () => {
  const state = setup()
  try {
    await wait(0)
    await state.ref.current.seek(3 << 20)
    const editor = harness.runtime.instance
    const model = editor.getModel()
    const reads = state.reads.length
    const start = state.windows.at(-1).offset
    for (const [anchor, active] of [[model.getValueLength() - 4096, model.getValueLength() - 512], [4096, 512], [4096, 0]]) {
      const selection = harness.Selection.fromPositions(model.getPositionAt(anchor), model.getPositionAt(active))
      editor.setSelection(selection)
      await wait()
      assert.equal(state.reads.length, reads)
      assert.deepEqual(editor.getSelection(), selection)
      assert.equal(state.positions.at(-1), start + active, 'selection changes still report the active position')
      assert.equal(state.ref.current.cursorOffset(), start + active)
    }
  } finally { harness.dispose() }
})

test('a single cursor near the lower and upper boundaries still seeks without a load loop', async () => {
  const state = setup()
  try {
    await wait(0)
    await state.ref.current.seek(3 << 20)
    const editor = harness.runtime.instance
    for (const direction of ['down', 'up']) {
      const model = editor.getModel()
      const index = direction === 'down' ? model.getValueLength() - 512 : 512
      const logical = state.windows.at(-1).offset + index
      const reads = state.reads.length
      editor.setPosition(model.getPositionAt(index))
      await wait()
      assert.equal(state.reads.length, reads + 1)
      assert.equal(state.reads.at(-1), logical)
      assert.equal(state.ref.current.cursorOffset(), logical)
      assert.equal(editor.getSelection().isEmpty(), true)
      await wait()
      assert.equal(state.reads.length, reads + 1, 'programmatic cursor/scroll events must not load again')
    }
  } finally { harness.dispose() }
})

for (const direction of ['down', 'up']) {
  test(`thumb drag ${direction} waits for release, then preserves visible text, horizontal scroll and selection`, async () => {
    const state = setup()
    try {
      await wait(0)
      await state.ref.current.seek(3 << 20)
      const editor = harness.runtime.instance
      const model = editor.getModel()
      const start = state.windows.at(-1).offset
      const anchor = direction === 'down' ? model.getValueLength() - 1024 : 2048
      const active = direction === 'down' ? model.getValueLength() - 512 : 1024
      editor.setSelection(harness.Selection.fromPositions(model.getPositionAt(anchor), model.getPositionAt(active)))
      const reads = state.reads.length
      state.host.dispatchEvent(new Event('pointerdown'))
      editor.scrollTo(direction === 'down' ? editor.getScrollHeight() - editor.height - 7 : 7, 43)
      const visible = start + model.getOffsetAt(editor.visiblePosition())
      const rowTop = editor.getTopForPosition(editor.visiblePosition().lineNumber, editor.visiblePosition().column) - editor.top
      await wait()
      assert.equal(state.reads.length, reads, 'no load while the pointer is held')
      window.dispatchEvent(new Event('pointerup'))
      await wait()
      assert.equal(state.reads.length, reads + 1)
      const next = state.windows.at(-1).offset
      assert.ok(direction === 'down' ? next > start : next < start)
      const restored = model.getPositionAt(visible - next)
      assert.equal(state.positions.at(-1), visible)
      assert.equal(editor.getTopForPosition(restored.lineNumber, restored.column) - editor.top, rowTop)
      assert.equal(editor.left, 43)
      assert.equal(next + model.getOffsetAt(editor.getSelection().getSelectionStart()), start + anchor)
      assert.equal(next + model.getOffsetAt(editor.getSelection().getPosition()), start + active)
      assert.equal(state.ref.current.cursorOffset(), start + active)
      assert.equal(editor.readOnly, false)
      assert.deepEqual(state.errors, [])
      await wait()
      assert.equal(state.reads.length, reads + 1)
    } finally { harness.dispose() }
  })
}

test('scrolling with Select All detaches an out-of-window selection and restores it on return', async () => {
  const state = setup()
  try {
    await wait(0)
    const editor = harness.runtime.instance
    const model = editor.getModel()
    editor.trigger('keyboard', 'editor.action.selectAll')
    const selection = editor.getSelection()
    const end = model.getValueLength()
    editor.scrollTo(editor.getScrollHeight() - editor.height)
    await wait()
    assert.equal(state.reads.length, 2, 'a selection must not disable scroll-based loading')
    assert.equal(editor.readOnly, true)
    assert.equal(state.ref.current.cursorOffset(), end, 'the logical active end survives detachment')
    assert.match(state.errors[0], /Cursor or selection is outside/)
    state.ref.current.setSaving(true)
    state.ref.current.setSaving(false)
    assert.equal(editor.readOnly, true, 'ending save must not remove the detached-selection guard')
    for (let i = 0; i < 4 && state.windows.at(-1).offset > 0; i++) {
      editor.scrollTo(0)
      await wait()
    }
    assert.equal(state.windows.at(-1).offset, 0)
    assert.deepEqual(editor.getSelection(), selection)
    assert.equal(editor.readOnly, false)
    assert.equal(state.errors.length, 1)
  } finally { harness.dispose() }
})

test('a new selection invalidates an in-flight scroll reply without seeking from its active end', async () => {
  const state = setup()
  let release
  try {
    await wait(0)
    await state.ref.current.seek(3 << 20)
    const editor = harness.runtime.instance
    const value = editor.getValue()
    const read = native.readLogWindow
    native.readLogWindow = async (...args) => { const value = await read(...args); await new Promise((resolve) => { release = resolve }); return value }
    editor.scrollTo(editor.getScrollHeight() - editor.height)
    await wait(100)
    assert.equal(typeof release, 'function')
    const reads = state.reads.length
    editor.trigger('keyboard', 'editor.action.selectAll')
    const selection = editor.getSelection()
    release()
    await wait()
    assert.equal(state.reads.length, reads)
    assert.equal(editor.getValue(), value, 'a stale anchor must not replace the model')
    assert.deepEqual(editor.getSelection(), selection)
  } finally { release?.(); harness.dispose() }
})

test('a newer explicit seek wins over an older asynchronous window reply', async () => {
  const state = setup()
  const replies = []
  try {
    await wait(0)
    const read = native.readLogWindow
    native.readLogWindow = async (...args) => { const value = await read(...args); return new Promise((resolve) => replies.push(() => resolve(value))) }
    const older = state.ref.current.seek(2 << 20)
    await wait(0)
    const newer = state.ref.current.seek(4 << 20)
    await wait(0)
    assert.equal(replies.length, 2)
    replies[1]()
    await newer
    const editor = harness.runtime.instance
    const value = editor.getValue()
    const position = editor.getPosition()
    replies[0]()
    await older
    assert.equal(editor.getValue(), value)
    assert.deepEqual(editor.getPosition(), position)
    assert.equal(state.ref.current.cursorOffset(), 4 << 20)
    await wait()
    assert.equal(state.reads.length, 3)
  } finally { for (const reply of replies) reply(); harness.dispose() }
})

for (const document of ['short', 'last window']) {
  test(`Select All, a cursor at EOF and a bottom thumb drag do not reload a ${document}`, async () => {
    const state = document === 'short' ? setup('short\nend') : setup()
    try {
      await wait(0)
      if (document === 'last window') await state.ref.current.seek(state.info.size)
      const editor = harness.runtime.instance
      const model = editor.getModel()
      const reads = state.reads.length
      assert.equal(state.windows.at(-1).next, state.info.size)
      editor.trigger('keyboard', 'editor.action.selectAll')
      await wait()
      assert.equal(state.reads.length, reads)
      assert.equal(model.getOffsetAt(editor.getSelection().getSelectionStart()), 0)
      assert.equal(model.getOffsetAt(editor.getSelection().getPosition()), model.getValueLength())
      editor.setPosition(model.getPositionAt(model.getValueLength()))
      await wait()
      state.host.dispatchEvent(new Event('pointerdown'))
      editor.scrollTo(Math.max(0, editor.getScrollHeight() - editor.height))
      await wait()
      window.dispatchEvent(new Event('pointerup'))
      await wait()
      assert.equal(state.reads.length, reads)
    } finally { harness.dispose() }
  })
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
