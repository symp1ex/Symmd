import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { after, before, test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { createServer } from 'vite'

let server
let visibleLogLines
let appendLogChunk
let prependLogChunk

before(async () => {
  server = await createServer({ root: fileURLToPath(new URL('../', import.meta.url)), configFile: false, appType: 'custom', logLevel: 'silent', server: { middlewareMode: true } })
  ;({ visibleLogLines, appendLogChunk, prependLogChunk } = await server.ssrLoadModule('/src/log/viewport.ts'))
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

test('log routing keeps full text out of the editor and browser file read', () => {
  const app = readFileSync(new URL('../src/app/App.tsx', import.meta.url), 'utf8')
  const runtime = readFileSync(new URL('../../internal/app/app_windows.go', import.meta.url), 'utf8')
  assert.match(app, /active\.log \? <LogViewer/)
  assert.match(app, /if \(\/\\\.log\$\/i\.test\(file\.name\)\) \{[^\n]*void openFile\(\)/)
  assert.match(runtime, /if \(\/\\\.log\$\/i\.test\(file\.name\)\) \{[\s\S]*?publishDrop\(\{ kind: "log" \}\);[\s\S]*?return;/)
})
