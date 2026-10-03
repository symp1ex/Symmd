import { forwardRef, useEffect, useImperativeHandle, useRef, useState } from 'react'
import { native, type LogChunk, type LogInfo } from '../bridge/native'
import { logTokenRules } from '../editor/logLanguage'
import { appendLogChunk, prependLogChunk, visibleLogLines } from './viewport'

const highlightRules = logTokenRules.map(({ pattern, token }) => ({ pattern: new RegExp(pattern.source, `${pattern.flags}g`), token }))

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

function highlighted(text: string) {
  const parts = []
  let position = 0
  while (position < text.length && parts.length < 80) {
    let found: { index: number; value: string; token: string } | undefined
    for (const rule of highlightRules) {
      rule.pattern.lastIndex = position
      const match = rule.pattern.exec(text)
      if (match && match[0] && (!found || match.index < found.index)) found = { index: match.index, value: match[0], token: rule.token }
    }
    if (!found) break
    if (found.index > position) parts.push(<span key={position}>{text.slice(position, found.index)}</span>)
    parts.push(<span key={found.index} className={`log-token--${found.token.split('.').at(-1)}`}>{found.value}</span>)
    position = found.index + found.value.length
  }
  if (position < text.length) parts.push(<span key={position}>{text.slice(position)}</span>)
  return parts
}

export interface LogViewerHandle {
  showFind(): void
  findNext(previous: boolean): void
}

interface Props { info: LogInfo; theme: 'dark' | 'light'; fontSize: number; onInfo(info: LogInfo): void; onError(message: string): void }

export const LogViewer = forwardRef<LogViewerHandle, Props>(function LogViewer({ info, theme, fontSize, onInfo, onError }, ref) {
  const [chunk, setChunk] = useState<LogChunk | null>(null)
  const [height, setHeight] = useState(600)
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
        nextScrollTop = (scrollRef.current?.scrollTop ?? 0) - merged.dropped.length * rowHeight
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
    const observer = new ResizeObserver(() => setHeight(host.clientHeight))
    observer.observe(host)
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
    const start = matchOffset === undefined ? (lines[Math.floor(scrollTop / rowHeight)]?.offset ?? currentOffset.current) : matchOffset + (previous ? 0 : 1)
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

  const lines = chunk?.lines ?? []
  const { first, visible } = visibleLogLines(lines, scrollTop, height, rowHeight)
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
    const target = host.scrollTop + earlier.length * rowHeight
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
      const target = host.scrollTop + merged.added * rowHeight
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

  return <div className={`log-viewer log-viewer--${theme}`} style={{ fontSize }}>
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
      if (host.scrollHeight > host.clientHeight && host.scrollTop + host.clientHeight >= host.scrollHeight - rowHeight * 6 && chunkRef.current.next < infoRef.current.size) void load(chunkRef.current.next, false, false, true)
    }} onWheel={(event) => {
      const host = event.currentTarget
      if (loading.current || suppressScroll.current) return
      if (event.deltaY < 0 && host.scrollTop === 0 && currentOffset.current > 0 && !showPrevious()) void loadPrevious()
      else if (event.deltaY > 0 && host.scrollHeight <= host.clientHeight && chunkRef.current && chunkRef.current.next < infoRef.current.size) void load(chunkRef.current.next, false, false, true)
    }} onContextMenu={(event) => {
      event.preventDefault()
      const selection = window.getSelection()
      const selected = selection?.toString() ?? ''
      void native.showContextMenu({ editable: false, hasSelection: !!selected, canSelectAll: false, link: false, canSaveLink: false }).then((command) => {
        if (command === 'copy' && selected) {
          void copySelectedText(selected).catch((error: unknown) => onError(error instanceof Error ? error.message : String(error)))
        }
      }).catch((error: unknown) => onError(error instanceof Error ? error.message : String(error)))
    }}>
      <div style={{ height: lines.length * rowHeight, position: 'relative' }}>
        <div style={{ position: 'absolute', top: first * rowHeight, left: 0, right: 0 }}>
          {visible.map((line) => <div className="log-row" key={line.offset} style={{ height: rowHeight }}><span className="log-offset">{line.offset.toLocaleString()}</span><span className="log-text">{highlighted(line.text)}{line.truncated && <span className="log-truncated"> [line truncated]</span>}</span></div>)}
        </div>
      </div>
    </div>
  </div>
})
