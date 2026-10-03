import { forwardRef, useEffect, useImperativeHandle, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { native, type LogChunk, type LogInfo } from '../bridge/native'
import * as monaco from '../editor/monaco'
import { logTokenRules } from '../editor/logLanguage'
import { appendLogChunk, prependLogChunk, visibleLogLines, visualLogRows, type VisualLogRow } from './viewport'

async function copySelectedText(text: string) {
  try {
    if (navigator.clipboard?.writeText) { await navigator.clipboard.writeText(text); return }
  } catch { /* WebView2 may expose Clipboard API without granting access. */ }
  const selection = document.getSelection()
  const ranges = selection ? Array.from({ length: selection.rangeCount }, (_, index) => selection.getRangeAt(index)) : []
  const textarea = document.createElement('textarea')
  textarea.value = text
  textarea.style.position = 'fixed'
  textarea.style.opacity = '0'
  document.body.appendChild(textarea)
  textarea.select()
  try {
    if (!document.execCommand('copy')) throw new Error('Clipboard is unavailable')
  } finally {
    textarea.remove()
    selection?.removeAllRanges()
    for (const range of ranges) selection?.addRange(range)
  }
}

function selectedLogText(host: HTMLElement): string {
  const selection = window.getSelection()
  if (!selection?.rangeCount) return ''
  const range = selection.getRangeAt(0)
  const pieces: string[] = []
  let previousOffset: string | undefined
  for (const row of host.querySelectorAll<HTMLElement>('.log-row')) {
    const content = row.querySelector<HTMLElement>('.log-text')
    if (!content || !range.intersectsNode(content)) continue
    const rowRange = document.createRange()
    rowRange.selectNodeContents(content)
    const overlap = range.cloneRange()
    if (overlap.compareBoundaryPoints(Range.START_TO_START, rowRange) < 0) overlap.setStart(rowRange.startContainer, rowRange.startOffset)
    if (overlap.compareBoundaryPoints(Range.END_TO_END, rowRange) > 0) overlap.setEnd(rowRange.endContainer, rowRange.endOffset)
    const text = overlap.toString()
    if (!text) continue
    const offset = row.dataset.logOffset
    if (pieces.length && offset !== previousOffset) pieces.push('\n')
    pieces.push(text)
    previousOffset = offset
  }
  return pieces.join('')
}

function highlighted(row: VisualLogRow, cache: Map<string, monaco.Token[]>) {
  const parts = []
  let covered = row.start
  let tokens = cache.get(row.line.text)
  if (!tokens) {
    tokens = monaco.editor.tokenize(row.line.text, 'log')[0] ?? []
    cache.set(row.line.text, tokens)
  }
  const end = row.start + row.text.length
  for (let index = 0; index < tokens.length && parts.length < 256; index++) {
    const token = tokens[index]
    const from = Math.max(row.start, token.offset)
    const to = Math.min(end, tokens[index + 1]?.offset ?? row.line.text.length)
    if (from >= to) continue
    const rule = logTokenRules.find(({ token: name }) => token.type === name || token.type.startsWith(`${name}.`))
    parts.push(<span key={from} className={rule ? `log-token--${rule.token.split('.').at(-1)}` : undefined}>{row.line.text.slice(from, to)}</span>)
    covered = to
  }
  if (covered < end) parts.push(<span key={covered}>{row.line.text.slice(covered, end)}</span>)
  return parts
}

export interface LogViewerHandle {
  showFind(): void
  findNext(previous: boolean): void
}

interface Props { info: LogInfo; theme: 'dark' | 'light'; fontSize: number; wordWrap: boolean; onInfo(info: LogInfo): void; onError(message: string): void }

export const LogViewer = forwardRef<LogViewerHandle, Props>(function LogViewer({ info, theme, fontSize, wordWrap, onInfo, onError }, ref) {
  const [chunk, setChunk] = useState<LogChunk | null>(null)
  const [height, setHeight] = useState(600)
  const [width, setWidth] = useState(800)
  const [charWidth, setCharWidth] = useState(fontSize * 0.602)
  const [scrollTop, setScrollTop] = useState(0)
  const [query, setQuery] = useState('')
  const [findOpen, setFindOpen] = useState(false)
  const [status, setStatus] = useState('')
  const [matchOffset, setMatchOffset] = useState<number>()
  const scrollRef = useRef<HTMLDivElement>(null)
  const findRef = useRef<HTMLInputElement>(null)
  const serial = useRef(0)
  const currentOffset = useRef(0)
  const loading = useRef(false)
  const suppressScroll = useRef(false)
  const previousLines = useRef<LogChunk['lines']>([])
  const chunkRef = useRef<LogChunk | null>(null)
  const infoRef = useRef(info)
  if (info.revision > infoRef.current.revision || (info.revision === infoRef.current.revision && info.size >= infoRef.current.size)) infoRef.current = info
  chunkRef.current = chunk
  const rowHeight = Math.max(22, fontSize + 7)
  const columns = Math.max(1, Math.floor((width - 126) / charWidth))
  const lines = chunk?.lines ?? []
  const rows = useMemo(() => visualLogRows(lines, wordWrap, columns), [lines, wordWrap, columns])
  const layoutRef = useRef({ rows, wordWrap, columns, rowHeight })

  useLayoutEffect(() => {
    const previous = layoutRef.current
    const host = scrollRef.current
    if (host && (previous.wordWrap !== wordWrap || previous.columns !== columns || previous.rowHeight !== rowHeight)) {
      const oldRow = previous.rows[Math.floor(scrollTop / previous.rowHeight)]
      const index = oldRow && rows.findIndex((row) => row.line.offset === oldRow.line.offset)
      if (index !== undefined && index >= 0) {
        host.scrollTop = index * rowHeight
        setScrollTop(host.scrollTop)
      }
    }
    layoutRef.current = { rows, wordWrap, columns, rowHeight }
  })

  useEffect(() => {
    const context = document.createElement('canvas').getContext('2d')
    if (!context) return
    context.font = `${fontSize}px Consolas, monospace`
    setCharWidth(context.measureText('M').width || fontSize * 0.602)
  }, [fontSize])

  const load = async (offset: number, align = false, bottom = false, append = false) => {
    const request = ++serial.current
    void native.cancelLogSearch(info.handle).catch(() => undefined)
    loading.current = true
    try {
      const result = await native.readLog(info.handle, Math.max(0, offset), align)
      if (request !== serial.current) return
      if (result.revision !== infoRef.current.revision || result.size !== infoRef.current.size) {
        const next = await native.statLog(info.handle)
        if (request !== serial.current) return
        if (next.revision !== infoRef.current.revision) { setMatchOffset(undefined); setStatus('Log changed') }
        infoRef.current = next
        previousLines.current = []
        chunkRef.current = null
        setChunk(null)
        onInfo(next)
        void load(Math.min(offset, next.size), align, bottom)
        return
      }
      let display = result
      let nextScrollTop: number | null = bottom ? null : 0
      if (append && chunkRef.current && chunkRef.current.revision === result.revision) {
        const current = chunkRef.current
        const merged = appendLogChunk(current, result)
        previousLines.current = merged.dropped.slice(-120)
        display = merged.chunk
        nextScrollTop = (scrollRef.current?.scrollTop ?? 0) - visualLogRows(merged.dropped, wordWrap, columns).length * rowHeight
      } else previousLines.current = []
      currentOffset.current = display.lines[0]?.offset ?? display.next
      chunkRef.current = display
      setChunk(display)
      suppressScroll.current = true
      requestAnimationFrame(() => {
        if (request !== serial.current || !scrollRef.current) return
        scrollRef.current.scrollTop = nextScrollTop === null ? scrollRef.current.scrollHeight : Math.max(0, nextScrollTop)
        setScrollTop(scrollRef.current.scrollTop)
        window.setTimeout(() => { suppressScroll.current = false }, 100)
      })
    } catch (error) {
      if (request === serial.current) { previousLines.current = []; chunkRef.current = null; setChunk(null); onError(error instanceof Error ? error.message : String(error)) }
    } finally {
      if (request === serial.current) loading.current = false
    }
  }

  useEffect(() => {
    let active = true
    void native.statLog(info.handle).then((next) => {
      if (!active) return
      infoRef.current = next
      if (next.revision !== info.revision || next.size !== info.size) onInfo(next)
      void load(0)
    }).catch((error: unknown) => { if (active) onError(error instanceof Error ? error.message : String(error)) })
    const host = scrollRef.current
    if (!host) return () => { active = false; serial.current++ }
    const observer = new ResizeObserver(() => { setHeight(host.clientHeight); setWidth(host.clientWidth) })
    observer.observe(host)
    setHeight(host.clientHeight)
    setWidth(host.clientWidth)
    return () => { active = false; serial.current++; void native.cancelLogSearch(info.handle).catch(() => undefined); observer.disconnect() }
  }, [info.handle])

  useEffect(() => {
    let active = true
    const timer = window.setInterval(() => {
      void native.statLog(info.handle).then((next) => {
        if (!active) return
        if (next.revision < infoRef.current.revision || (next.revision === infoRef.current.revision && next.size < infoRef.current.size)) return
        if (next.revision !== infoRef.current.revision) {
          infoRef.current = next
          previousLines.current = []
          chunkRef.current = null
          setChunk(null)
          onInfo(next)
          setMatchOffset(undefined)
          void load(currentOffset.current < next.size ? currentOffset.current : Math.max(0, next.size - 65536), true)
        } else if (next.size !== infoRef.current.size) {
          const wasAtEnd = chunkRef.current?.next === infoRef.current.size
          infoRef.current = next
          onInfo(next)
          if (wasAtEnd) void load(currentOffset.current)
        }
      }).catch((error: unknown) => {
        if (!active) return
        serial.current++
        loading.current = false
        previousLines.current = []
        chunkRef.current = null
        setChunk(null)
        onError(error instanceof Error ? error.message : String(error))
      })
    }, 1800)
    return () => { active = false; window.clearInterval(timer) }
  }, [info.handle])

  const find = async (previous: boolean) => {
    if (!query) { setFindOpen(true); findRef.current?.focus(); return }
    const request = ++serial.current
    loading.current = false
    const start = matchOffset === undefined ? (rows[Math.floor(scrollTop / rowHeight)]?.line.offset ?? currentOffset.current) : matchOffset + (previous ? 0 : 1)
    setStatus('Searching…')
    try {
      const id = await native.findLog(info.handle, query, start, previous)
      if (request !== serial.current) { void native.cancelLogSearch(info.handle, id).catch(() => undefined); return }
      let result = await native.pollLogSearch(info.handle, id)
      while (!result.done && request === serial.current) {
        await new Promise((resolve) => window.setTimeout(resolve, 80))
        if (request !== serial.current) return
        result = await native.pollLogSearch(info.handle, id)
      }
      if (result.error) throw new Error(result.error)
      if (request !== serial.current) return
      if (result.offset < 0) { setStatus('No match'); return }
      setMatchOffset(result.offset)
      setStatus(`Match at byte ${result.offset.toLocaleString()}`)
      await load(result.offset, true)
    } catch (error) {
      if (request === serial.current) onError(error instanceof Error ? error.message : String(error))
    }
  }

  useImperativeHandle(ref, () => ({
    showFind: () => { setFindOpen(true); requestAnimationFrame(() => findRef.current?.focus()) },
    findNext: (previous) => { void find(previous) },
  }))

  const { first, visible } = visibleLogLines(rows, scrollTop, height, rowHeight)
  const tokenCache = new Map<string, monaco.Token[]>()
  const position = Math.round(1_000_000 * (currentOffset.current / Math.max(1, info.size)))

  const showPrevious = () => {
    const current = chunkRef.current
    const earlier = previousLines.current
    const host = scrollRef.current
    if (!current || !earlier.length || !host) return false
    const all = [...earlier, ...current.lines].slice(0, 240)
    previousLines.current = []
    currentOffset.current = all[0].offset
    chunkRef.current = { ...current, lines: all, next: all.at(-1)?.next ?? current.next }
    setChunk(chunkRef.current)
    suppressScroll.current = true
    const target = host.scrollTop + visualLogRows(earlier, wordWrap, columns).length * rowHeight
    requestAnimationFrame(() => {
      if (!scrollRef.current) return
      scrollRef.current.scrollTop = target
      setScrollTop(target)
      window.setTimeout(() => { suppressScroll.current = false }, 100)
    })
    return true
  }

  const loadPrevious = async () => {
    const current = chunkRef.current
    const host = scrollRef.current
    if (!current || !host || currentOffset.current === 0) return
    const request = ++serial.current
    loading.current = true
    void native.cancelLogSearch(info.handle).catch(() => undefined)
    try {
      const result = await native.readLogBefore(info.handle, currentOffset.current)
      if (request !== serial.current) return
      if (result.revision !== infoRef.current.revision || result.size !== infoRef.current.size) {
        const next = await native.statLog(info.handle)
        if (request !== serial.current) return
        infoRef.current = next
        previousLines.current = []
        chunkRef.current = null
        setChunk(null)
        onInfo(next)
        void load(Math.max(0, Math.min(currentOffset.current, next.size) - 65536), true)
        return
      }
      const merged = prependLogChunk(current, result)
      if (!merged.added) return
      currentOffset.current = merged.chunk.lines[0].offset
      chunkRef.current = merged.chunk
      setChunk(merged.chunk)
      suppressScroll.current = true
      const target = host.scrollTop + visualLogRows(merged.chunk.lines.slice(0, merged.added), wordWrap, columns).length * rowHeight
      requestAnimationFrame(() => {
        if (request !== serial.current || !scrollRef.current) return
        scrollRef.current.scrollTop = target
        setScrollTop(scrollRef.current.scrollTop)
        window.setTimeout(() => { suppressScroll.current = false }, 100)
      })
    } catch (error) {
      if (request === serial.current) { previousLines.current = []; chunkRef.current = null; setChunk(null); onError(error instanceof Error ? error.message : String(error)) }
    } finally {
      if (request === serial.current) loading.current = false
    }
  }

  return <div className={`log-viewer log-viewer--${theme}${wordWrap ? ' log-viewer--wrap' : ''}`} style={{ fontSize }}>
    <div className="log-toolbar">
      <span>Byte {currentOffset.current.toLocaleString()} / {info.size.toLocaleString()}</span>
      <input aria-label="Log position" type="range" min="0" max="1000000" value={position} onChange={(event) => void load(Math.floor(info.size * Number(event.target.value) / 1_000_000), true)} />
      <button onClick={() => void load(0)}>Start</button><button onClick={() => void load(Math.max(0, info.size - 65536), true, true)}>End</button>
      <button onClick={() => { setFindOpen(true); requestAnimationFrame(() => findRef.current?.focus()) }}>Find</button>
    </div>
    {findOpen && <div className="log-find"><input ref={findRef} aria-label="Find in log" value={query} onChange={(event) => { serial.current++; loading.current = false; void native.cancelLogSearch(info.handle).catch(() => undefined); setQuery(event.target.value); setMatchOffset(undefined); setStatus('') }} onKeyDown={(event) => { if (event.key === 'Enter') void find(event.shiftKey) }} /><button onClick={() => void find(false)}>Next</button><button onClick={() => void find(true)}>Previous</button><button onClick={() => setFindOpen(false)}>Close</button><span>{status}</span></div>}
    <div ref={scrollRef} className="log-scroll" tabIndex={0} onScroll={(event) => {
      const host = event.currentTarget
      setScrollTop(host.scrollTop)
      if (loading.current || suppressScroll.current || !chunkRef.current) return
      if (host.scrollTop === 0 && currentOffset.current > 0 && !showPrevious()) { void loadPrevious(); return }
      if (host.scrollHeight > host.clientHeight && host.scrollTop + host.clientHeight >= host.scrollHeight - rowHeight * 6 && chunkRef.current.next < infoRef.current.size) void load(chunkRef.current.next, false, false, true)
    }} onWheel={(event) => {
      const host = event.currentTarget
      if (loading.current || suppressScroll.current) return
      if (event.deltaY < 0 && host.scrollTop === 0 && currentOffset.current > 0 && !showPrevious()) void loadPrevious()
      else if (event.deltaY > 0 && host.scrollHeight <= host.clientHeight && chunkRef.current && chunkRef.current.next < infoRef.current.size) void load(chunkRef.current.next, false, false, true)
    }} onCopy={(event) => {
      const selected = selectedLogText(event.currentTarget)
      if (selected && event.clipboardData) { event.preventDefault(); event.clipboardData.setData('text/plain', selected) }
    }} onContextMenu={(event) => {
      event.preventDefault()
      const selected = selectedLogText(event.currentTarget)
      void native.showContextMenu({ editable: false, hasSelection: !!selected, canSelectAll: false, link: false, canSaveLink: false }).then((command) => {
        if (command === 'copy' && selected) {
          void copySelectedText(selected).catch((error: unknown) => onError(error instanceof Error ? error.message : String(error)))
        }
      }).catch((error: unknown) => onError(error instanceof Error ? error.message : String(error)))
    }}>
      <div style={{ height: rows.length * rowHeight, position: 'relative' }}>
        <div style={{ position: 'absolute', top: first * rowHeight, left: 0, right: 0 }}>
          {visible.map((row) => <div className={`log-row${row.overflow ? ' log-row--overflow' : ''}`} data-log-offset={row.line.offset} key={`${row.line.offset}:${row.part}`} style={{ height: rowHeight }}><span className="log-offset">{row.part === 0 ? row.line.offset.toLocaleString() : ''}</span><span className="log-text">{highlighted(row, tokenCache)}{row.last && row.line.truncated && <span className="log-truncated"> [line truncated]</span>}</span></div>)}
        </div>
      </div>
    </div>
  </div>
})
