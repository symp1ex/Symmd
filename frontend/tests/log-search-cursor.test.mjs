import assert from 'node:assert/strict'
import { before, after, test } from 'node:test'
import { createServer } from 'vite'
import { fileURLToPath } from 'node:url'

let server, harness, LogViewer, native
const wait = (ms = 0) => new Promise((resolve) => setTimeout(resolve, ms))
before(async () => {
  server = await createServer({ root: fileURLToPath(new URL('../', import.meta.url)), configFile: false, appType: 'custom', logLevel: 'silent', optimizeDeps: { noDiscovery: true }, esbuild: { jsx: 'automatic' }, server: { middlewareMode: true }, plugins: [{
    name: 'log-viewer-double', enforce: 'pre', transform(source, id) {
      if (id.endsWith('/src/log/LogViewer.tsx')) return source.replace("from 'react'", "from '/tests/fixtures/log-viewer-harness.mjs'").replace("from '../editor/monaco'", "from '/tests/fixtures/log-editor-harness.mjs'")
      if (id.endsWith('/src/log/LogEditorWindow.tsx')) return 'export const LogEditorWindow = () => null'
    },
  }] })
  harness = await server.ssrLoadModule('/tests/fixtures/log-viewer-harness.mjs')
  ;({ native } = await server.ssrLoadModule('/src/bridge/native.ts'))
  ;({ LogViewer } = await server.ssrLoadModule('/src/log/LogViewer.tsx'))
})
after(async () => { await server?.close() })
function nodes(element) {
  if (!element || typeof element !== 'object') return []
  return [element, ...[element.props?.children].flat(3).flatMap(nodes)]
}

test('debounced global search retains the cursor origin while typing and uses backend ordinals', async () => {
  globalThis.document = { createElement: () => ({ getContext: () => null }) }
  globalThis.requestAnimationFrame = (callback) => { callback(); return 0 }
  globalThis.window = { setTimeout, clearTimeout, setInterval, clearInterval }
  harness.reset()
  const info = { handle: 7, size: 20 << 20, revision: 1, encoding: 'UTF-16 LE', bom: 2, dirty: false }
  const searches = [], polls = [], reveals = [], errors = []
  let cursor = 1234, id = 0, focused = 0, resultOffset = 9 << 20
  native.statLog = async () => info
  native.readLog = async () => ({ lines: [], next: 0, size: info.size, revision: info.revision })
  native.findLog = async (...args) => { searches.push(args); return ++id }
  native.pollLogSearch = async () => ({ done: true, offset: resultOffset })
  native.cancelLogSearch = async () => {}
  native.countLogMatches = async () => 42
  native.pollLogCount = async (_handle, _id, offset) => { polls.push(offset); return { done: true, total: 120, ordinal: offset === resultOffset ? 87 : 0 } }
  native.cancelLogCount = async () => {}
  native.reportRuntimeEvent = async () => {}
  const props = { info, theme: 'dark', fontSize: 14, wordWrap: true, onInfo() {}, onPosition() {}, onError: (error) => errors.push(error) }
  const ref = { current: null }
  let tree = harness.render(LogViewer, props, ref)
  const editor = nodes(tree).find((node) => node.type?.name === 'LogEditorWindow')
  editor.props.ref.current = { cursorOffset: () => cursor, flush: async () => {}, clearSearchSelection() {}, setSaving() {}, focus: () => { focused++ }, seek: async (...args) => { reveals.push(args); cursor = args[0] } }
  try {
    ref.current.showFind()
    tree = harness.render(LogViewer, props, ref)
    let input = nodes(tree).find((node) => node.props?.['aria-label'] === 'Find in log')
    input.props.ref.current = { focus() {} }
    input.props.onChange({ target: { value: 'a' } })
    tree = harness.render(LogViewer, props, ref)
    await wait(300)
    tree = harness.render(LogViewer, props, ref)
    assert.deepEqual(searches[0], [7, 'a', 1234, false])
    assert.deepEqual(reveals[0], [resultOffset, 'a'])
    assert.equal(focused, 0)
    assert.ok(polls.includes(resultOffset))
    input = nodes(tree).find((node) => node.props?.['aria-label'] === 'Find in log')
    input.props.onChange({ target: { value: 'ab' } })
    tree = harness.render(LogViewer, props, ref)
    await wait(300)
    tree = harness.render(LogViewer, props, ref)
    assert.deepEqual(searches[1], [7, 'ab', 1234, false], 'typing retains the original cursor instead of the short-query result')
    const count = nodes(tree).find((node) => node.props?.className === 'log-find__count')
    assert.match(JSON.stringify(count.props.children), /87/)
    // Scrolling reports viewport coordinates, which must not replace the origin
    // or the selected global result.
    editor.props.onPosition(17 << 20)
    editor.props.onInfo({ ...info })
    tree = harness.render(LogViewer, props, ref)
    ref.current.findNext(false)
    await wait()
    assert.deepEqual(searches[2], [7, 'ab', resultOffset + 1, false])
    ref.current.findNext(true)
    await wait()
    assert.deepEqual(searches[3], [7, 'ab', resultOffset, true])
    resultOffset = -1
    ref.current.findNext(false)
    await wait()
    assert.equal(searches.length, 6, 'a missing forward match retries from the beginning')
    assert.deepEqual(searches.slice(4), [[7, 'ab', (9 << 20) + 1, false], [7, 'ab', 0, false]])
    tree = harness.render(LogViewer, props, ref)
    assert.match(JSON.stringify(tree), /No match/)
    let resolveStale
    native.pollLogSearch = async () => new Promise((resolve) => { resolveStale = resolve })
    ref.current.findNext(false)
    await wait()
    const previousReveals = reveals.length
    input = nodes(tree).find((node) => node.props?.['aria-label'] === 'Find in log')
    input.props.onChange({ target: { value: 'new query' } })
    tree = harness.render(LogViewer, props, ref)
    resolveStale({ done: true, offset: 5 << 20 })
    await wait()
    assert.equal(reveals.length, previousReveals, 'an old query cannot select a result')
    const reopened = []
    info.dirty = true
    native.confirmDiscard = async () => false
    native.reopenLogEncoding = async (...args) => { reopened.push(args); Object.assign(info, { encoding: args[1], dirty: false, revision: info.revision + 1 }); return info }
    let encoding = nodes(tree).find((node) => node.props?.['aria-label'] === 'Log encoding')
    encoding.props.onChange({ target: { value: 'Windows-1251' } })
    await wait()
    tree = harness.render(LogViewer, props, ref)
    assert.equal(reopened.length, 0, 'canceling the existing discard dialog preserves unsaved edits')
    assert.equal(info.dirty, true)
    native.confirmDiscard = async () => true
    encoding = nodes(tree).find((node) => node.props?.['aria-label'] === 'Log encoding')
    encoding.props.onChange({ target: { value: 'Windows-1251' } })
    await wait()
    assert.deepEqual(reopened, [[7, 'Windows-1251', true]])
    assert.deepEqual(errors, [])
  } finally { harness.dispose() }
})
