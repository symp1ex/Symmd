import React, { createRef } from 'react'
import { createRoot } from 'react-dom/client'
import { flushSync } from 'react-dom'
import { LogViewer } from '../../src/log/LogViewer'
import { native } from '../../src/bridge/native'
import * as monaco from '../../src/editor/monaco'
import '../../src/styles/app.css'

// Indented log records exercise Monaco's real indentation-based Sticky Scroll.
let text = `INFO scope\n${'    INFO needle '.concat('x'.repeat(180), '\n').repeat(160)}INFO end\n`
let info = { handle: 1, name: 'test.log', size: text.length, revision: 1, encoding: 'UTF-8', bom: 0, dirty: false }
const errors = [], searches = [], edits = []
let result = 0, query = ''
const matches = () => Array.from(text.matchAll(new RegExp(query, 'g')), (match) => match.index)
const chunk = () => {
  let offset = 0
  return { size: info.size, revision: info.revision, encoding: info.encoding, next: info.size, lines: text.trimEnd().split('\n').map((value) => {
    const line = { offset, next: offset + value.length + 1, text: value, truncated: false }
    offset = line.next
    return line
  }) }
}
Object.assign(native, {
  statLog: async () => info,
  readLog: async () => chunk(), readLogBefore: async () => chunk(),
  readLogWindow: async () => ({ ...info, offset: 0, next: info.size, text, editable: true }),
  reportRuntimeEvent: async () => {}, cancelLogSearch: async () => {}, cancelLogCount: async () => {},
  findLog: async (_handle, value, offset, previous) => {
    query = value
    searches.push({ offset, previous })
    result = previous ? matches().filter((match) => match < offset).at(-1) ?? -1 : matches().find((match) => match >= offset) ?? -1
    return searches.length
  },
  pollLogSearch: async () => ({ done: true, offset: result }),
  countLogMatches: async (_handle, value) => { query = value; return 1 },
  pollLogCount: async (_handle, _id, offset) => ({ done: true, total: matches().length, ordinal: matches().indexOf(offset) + 1 }),
  replaceLog: async (_handle, start, end, inserted) => {
    edits.push({ start, end, inserted })
    text = text.slice(0, start) + inserted + text.slice(end)
    info = { ...info, size: text.length, revision: info.revision + 1, dirty: true }
    return info
  },
})
const root = createRoot(document.getElementById('root'))
const ref = createRef()
const render = (theme) => root.render(<LogViewer ref={ref} info={info} theme={theme} fontSize={14} wordWrap={false} onInfo={() => {}} onPosition={() => {}} onError={(error) => errors.push(error)} />)
render('dark')
// Imperative calls from DevTools need a committed React tree before the focus RAF.
window.logFindFixture = { ref, monaco, errors, searches, edits, render, showFind: () => flushSync(() => ref.current.showFind()) }
