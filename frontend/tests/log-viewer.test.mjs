import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { after, before, test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { createServer } from 'vite'

let server
let visibleLogLines
let appendLogChunk
let prependLogChunk
let visualLogRows
let maxWrappedRows
let classifyLogFragment
let logLanguage

before(async () => {
  server = await createServer({ root: fileURLToPath(new URL('../', import.meta.url)), configFile: false, appType: 'custom', logLevel: 'silent', server: { middlewareMode: true } })
  ;({ visibleLogLines, appendLogChunk, prependLogChunk, visualLogRows, maxWrappedRows } = await server.ssrLoadModule('/src/log/viewport.ts'))
  ;({ classifyLogFragment, logLanguage } = await server.ssrLoadModule('/src/editor/logLanguage.ts'))
})

test('adjacent chunks keep a fixed number of rows while advancing', () => {
  const line = (offset) => ({ offset, next: offset + 1, text: String(offset), truncated: false })
  const first = { lines: [0, 1, 2, 3].map(line), next: 4, size: 100, revision: 1 }
  const second = { lines: [4, 5, 6, 7].map(line), next: 8, size: 100, revision: 1 }
  const merged = appendLogChunk(first, second, 6)
  assert.deepEqual(merged.chunk.lines.map((item) => item.offset), [2, 3, 4, 5, 6, 7])
  assert.deepEqual(merged.dropped.map((item) => item.offset), [0, 1])
  assert.equal(merged.chunk.next, 8)
  const following = appendLogChunk(merged.chunk, { lines: [8, 9, 10].map(line), next: 11, size: 100, revision: 1 }, 6)
  assert.deepEqual(following.chunk.lines.map((item) => item.offset), [5, 6, 7, 8, 9, 10])
  const back = prependLogChunk(following.chunk, { lines: [2, 3, 4].map(line), next: 5, size: 100, revision: 1 }, 6)
  assert.deepEqual(back.chunk.lines.map((item) => item.offset), [2, 3, 4, 5, 6, 7])
  assert.equal(back.chunk.next, 8)
})
after(async () => { await server?.close() })

test('viewport renders a bounded set and moves without retaining previous rows', () => {
  const lines = Array.from({ length: 120 }, (_, offset) => ({ offset, next: offset + 1, text: String(offset), truncated: false }))
  const first = visibleLogLines(lines, 0, 220, 22)
  const later = visibleLogLines(lines, 1760, 220, 22)
  assert.ok(first.visible.length <= 18)
  assert.ok(later.visible.length <= 18)
  assert.equal(first.visible[0].offset, 0)
  assert.ok(later.visible[0].offset >= 70)
  assert.ok(!later.visible.includes(first.visible[0]))
})

test('word wrap follows the setting, viewport width, and keeps every character', () => {
  const line = { offset: 0, next: 18, text: 'ERROR one two three', truncated: false }
  const unwrapped = visualLogRows([line], false, 8)
  const wrapped = visualLogRows([line], true, 8)
  assert.equal(unwrapped.length, 1)
  assert.ok(wrapped.length > 1)
  assert.equal(wrapped.map((row) => row.text).join(''), line.text)
  assert.ok(visualLogRows([line], true, 20).length < wrapped.length)
  assert.equal(visualLogRows([line], false, 8)[0].text, line.text)
})

test('pathological lines have bounded visual rows, cache, and DOM window', () => {
  const line = (offset) => ({ offset, next: offset + 16384, text: 'x'.repeat(16384), truncated: true })
  const first = { lines: Array.from({ length: 120 }, (_, i) => line(i * 16384)), next: 120 * 16384, size: 1e9, revision: 1 }
  const second = { lines: Array.from({ length: 120 }, (_, i) => line((i + 120) * 16384)), next: 240 * 16384, size: 1e9, revision: 1 }
  const third = { lines: Array.from({ length: 120 }, (_, i) => line((i + 240) * 16384)), next: 360 * 16384, size: 1e9, revision: 1 }
  const cached = appendLogChunk(appendLogChunk(first, second).chunk, third).chunk
  assert.equal(cached.lines.length, 240)
  const rows = visualLogRows(cached.lines, true, 1)
  assert.ok(rows.length <= 240 * maxWrappedRows)
  assert.equal(rows[0].text + rows.slice(1, maxWrappedRows).map((row) => row.text).join(''), cached.lines[0].text)
  assert.equal(rows[maxWrappedRows - 1].overflow, true)
  assert.ok(visibleLogLines(rows, 0, 660, 22).visible.length <= 38)
  assert.ok(visibleLogLines(rows, rows.length * 11, 660, 22).visible.length <= 38)
})

test('log highlighting uses Monaco token priority and original theme colors', () => {
  const viewer = readFileSync(new URL('../src/log/LogViewer.tsx', import.meta.url), 'utf8')
  const css = readFileSync(new URL('../src/styles/app.css', import.meta.url), 'utf8')
  const app = readFileSync(new URL('../src/app/App.tsx', import.meta.url), 'utf8')
  assert.match(viewer, /monaco\.editor\.tokenize\(row\.line\.text, 'log'\)/)
  assert.equal(logLanguage.tokenizer.root[0][1], 'string.key.log.exception')
  assert.equal(classifyLogFragment('  at [ERROR] foo'), 'string.key.log.exception')
  assert.match(app, /wordWrap=\{preferences\.wordWrap\} onInfo=/)
  assert.doesNotMatch(app, /checked=\{preferences\.wordWrap\} disabled=\{logDocument\}/)
  for (const color of ['#d16969', '#811f3f', '#6a9955', '#008000', '#569cd6', '#0000ff']) assert.ok(css.includes(color))
  assert.match(css, /\.log-token--error \{ color: #d16969; font-weight: bold; \}/)
  assert.match(css, /\.log-viewer--light \.log-token--error, \.log-viewer--light \.log-token--exceptiontype \{ color: #811f3f; \}/)
  assert.match(css, /\.log-viewer--light \.log-scroll/)
  assert.match(css, /\.log-scroll::-webkit-scrollbar-thumb/)
})

test('log routing keeps full text out of the editor and browser file read', () => {
  const app = readFileSync(new URL('../src/app/App.tsx', import.meta.url), 'utf8')
  const runtime = readFileSync(new URL('../../internal/app/app_windows.go', import.meta.url), 'utf8')
  assert.match(app, /active\.log \? <LogViewer/)
  assert.match(app, /if \(\/\\\.log\$\/i\.test\(file\.name\)\) \{[^\n]*void openFile\(\)/)
  assert.match(runtime, /if \(\/\\\.log\$\/i\.test\(file\.name\)\) \{[\s\S]*?publishDrop\(\{ kind: "log" \}\);[\s\S]*?return;/)
})
