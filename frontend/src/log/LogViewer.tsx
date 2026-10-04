import { forwardRef, useEffect, useImperativeHandle, useLayoutEffect, useMemo, useRef, useState, type CSSProperties } from 'react'
import { native, type LogChunk, type LogCountResult, type LogInfo } from '../bridge/native'
import * as monaco from '../editor/monaco'
import { logTokenRules } from '../editor/logLanguage'
import { LogEditorWindow, type LogEditorWindowHandle } from './LogEditorWindow'
import { appendLogChunk, logGutterWidth, logTextMatches, prependLogChunk, visibleLogLines, visibleLogOffset, visualLogRows, type LogTextMatch, type VisualLogRow } from './viewport'

const logTopPadding = 12
const logTextPadding = 16
const globalThumbHeight = 24

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

function highlighted(row: VisualLogRow, cache: Map<string, monaco.Token[]>, matchCache: Map<number, LogTextMatch[]>, query: string, matchOffset?: number) {
  const parts = []
  let covered = row.start
  let tokens = cache.get(row.line.text)
  if (!tokens) {
    tokens = monaco.editor.tokenize(row.line.text, 'log')[0] ?? []
    cache.set(row.line.text, tokens)
  }
  const end = row.start + row.text.length
  let matches = matchCache.get(row.line.offset)
  if (!matches) {
    matches = logTextMatches(row.line, query, matchOffset)
    matchCache.set(row.line.offset, matches)
  }
  if (matches.length) {
    const cuts = [row.start, end]
    const tokenLimit = tokens[256]?.offset ?? row.line.text.length
    for (const token of tokens.slice(0, 257)) if (token.offset > row.start && token.offset < end) cuts.push(token.offset)
    for (const match of matches) {
      if (match.start < end && match.end > row.start) cuts.push(Math.max(row.start, match.start), Math.min(end, match.end))
    }
    cuts.sort((left, right) => left - right)
    let tokenIndex = 0
    let matchIndex = 0
    const selectedMatch = matches.find((match) => match.selected)
    for (let index = 0; index < cuts.length - 1; index++) {
      const from = cuts[index]
      const to = cuts[index + 1]
      if (from === to) continue
      while (tokenIndex + 1 < tokens.length && tokens[tokenIndex + 1].offset <= from) tokenIndex++
      while (matchIndex + 1 < matches.length && matches[matchIndex].end <= from) matchIndex++
      const token = from < tokenLimit && tokens[tokenIndex]?.offset <= from ? tokens[tokenIndex] : undefined
      const rule = token && logTokenRules.find(({ token: name }) => token.type === name || token.type.startsWith(`${name}.`))
      const selected = !!selectedMatch && selectedMatch.start <= from && from < selectedMatch.end
      const matched = selected || matches[matchIndex].start <= from && from < matches[matchIndex].end
      const className = [rule && `log-token--${rule.token.split('.').at(-1)}`, selected ? 'log-match--selected' : matched && 'log-match'].filter(Boolean).join(' ')
      parts.push(<span key={from} className={className || undefined}>{row.line.text.slice(from, to)}</span>)
    }
    return parts
  }
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
  flush(): Promise<void>
  setSaving(saving: boolean): void
}

interface Props { info: LogInfo; theme: 'dark' | 'light'; fontSize: number; wordWrap: boolean; onInfo(info: LogInfo): void; onPosition(offset: number): void; onError(message: string): void }

export const LogViewer = forwardRef<LogViewerHandle, Props>(function LogViewer({ info, theme, fontSize, wordWrap, onInfo, onPosition, onError }, ref) {
  const [chunk, setChunk] = useState<LogChunk | null>(null)
  const [height, setHeight] = useState(600)
  const [width, setWidth] = useState(800)
  const [charWidth, setCharWidth] = useState(fontSize * 0.602)
  const [scrollTop, setScrollTop] = useState(0)
  const [query, setQuery] = useState('')
  const [findOpen, setFindOpen] = useState(false)
  const [status, setStatus] = useState('')
  const [matchOffset, setMatchOffset] = useState<number>()
  const [countResult, setCountResult] = useState<LogCountResult>()
  const [countOffset, setCountOffset] = useState<number>()
  const [countID, setCountID] = useState(0)
  const [countVersion, setCountVersion] = useState(0)
  const [dragPosition, setDragPosition] = useState<number>()
  const [endSelected, setEndSelected] = useState(false)
  const [navigationOpen, setNavigationOpen] = useState(false)
  const [editorPosition, setEditorPosition] = useState(0)
  const editorRef = useRef<LogEditorWindowHandle>(null)
  const scrollRef = useRef<HTMLDivElement>(null)
  const trackRef = useRef<HTMLDivElement>(null)
  const findRef = useRef<HTMLInputElement>(null)
  const serial = useRef(0)
  const searchSerial = useRef(0)
  const countIDRef = useRef(0)
  const countSizeRef = useRef(info.size)
  const matchRef = useRef<number | undefined>(undefined)
  const visibleOffsetRef = useRef(0)
  const dragRef = useRef<{ pointerId: number; grab: number; lastSeek: number; target: number; sent: number } | undefined>(undefined)
  const currentOffset = useRef(0)
  const loading = useRef(false)
  const suppressScroll = useRef(false)
  const previousLines = useRef<LogChunk['lines']>([])
  const chunkRef = useRef<LogChunk | null>(null)
  const infoRef = useRef(info)
  if (info.revision > infoRef.current.revision || (info.revision === infoRef.current.revision && info.size >= infoRef.current.size)) infoRef.current = info
  chunkRef.current = chunk
  const rowHeight = Math.max(22, fontSize + 7)
  const gutterWidth = useMemo(() => {
    const context = document.createElement('canvas').getContext('2d')
    if (!context) return logGutterWidth(info.size, charWidth)
    context.font = `${fontSize}px Consolas, monospace`
    return Math.ceil(context.measureText(info.size.toLocaleString()).width) + 10
  }, [info.size, fontSize, charWidth])
  const columns = Math.max(1, Math.floor((width - gutterWidth - logTextPadding) / charWidth))
  const lines = chunk?.lines ?? []
  const rows = useMemo(() => visualLogRows(lines, wordWrap, columns), [lines, wordWrap, columns])
  const visiblePosition = visibleLogOffset(rows, Math.max(0, scrollTop - logTopPadding), rowHeight, chunk?.next ?? 0)
  visibleOffsetRef.current = visiblePosition
  matchRef.current = matchOffset
  useEffect(() => { if (navigationOpen) onPosition(visiblePosition) }, [onPosition, visiblePosition, navigationOpen])
  const layoutRef = useRef({ rows, wordWrap, columns, rowHeight })

  useLayoutEffect(() => {
    const previous = layoutRef.current
    const host = scrollRef.current
    if (host && (previous.wordWrap !== wordWrap || previous.columns !== columns || previous.rowHeight !== rowHeight)) {
      const oldRow = previous.rows[Math.floor(Math.max(0, scrollTop - logTopPadding) / previous.rowHeight)]
      const index = oldRow && rows.findIndex((row) => row.line.offset === oldRow.line.offset)
      if (index !== undefined && index >= 0) {
        const request = serial.current
        suppressScroll.current = true
        host.scrollTop = index * rowHeight
        setScrollTop(host.scrollTop)
        window.setTimeout(() => { if (request === serial.current) suppressScroll.current = false }, 100)
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

  const load = async (offset: number, align = false, bottom = false, append = false, reveal?: { offset: number; query: string; searchRequest: number }) => {
    const request = ++serial.current
    loading.current = true
    try {
      const result = bottom && !append ? await native.readLogBefore(info.handle, infoRef.current.size) : await native.readLog(info.handle, Math.max(0, offset), align)
      if (request !== serial.current) return
      if (reveal && reveal.searchRequest !== searchSerial.current) return
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
        if (!bottom) nextScrollTop = (scrollRef.current?.scrollTop ?? 0) - visualLogRows(merged.dropped, wordWrap, columns).length * rowHeight
      } else previousLines.current = []
      if (reveal) {
        const line = display.lines.find((item) => item.offset <= reveal.offset && reveal.offset < item.next)
        const selected = line && logTextMatches(line, reveal.query, reveal.offset).find((match) => match.selected)
        if (line && selected) {
          const matchRow = visualLogRows(display.lines, wordWrap, columns).findIndex((row) => row.line === line && row.start <= selected.start && selected.start < row.start + row.text.length)
          if (matchRow >= 0) nextScrollTop = Math.max(0, (matchRow - 2) * rowHeight + logTopPadding)
        }
      }
      currentOffset.current = display.lines[0]?.offset ?? display.next
      setEndSelected(bottom)
      chunkRef.current = display
      setChunk(display)
      suppressScroll.current = true
      requestAnimationFrame(() => {
        if (request !== serial.current || !scrollRef.current) return
        if (reveal && reveal.searchRequest !== searchSerial.current) { suppressScroll.current = false; return }
        scrollRef.current.scrollTop = nextScrollTop === null ? scrollRef.current.scrollHeight : Math.max(0, nextScrollTop)
        setScrollTop(scrollRef.current.scrollTop)
        if (reveal) requestAnimationFrame(() => {
          if (request === serial.current && reveal.searchRequest === searchSerial.current) scrollRef.current?.querySelector<HTMLElement>('.log-match--selected')?.scrollIntoView({ block: 'nearest', inline: 'nearest' })
        })
        window.setTimeout(() => { if (request === serial.current) suppressScroll.current = false }, 100)
      })
    } catch (error) {
      if (request === serial.current) { suppressScroll.current = false; previousLines.current = []; chunkRef.current = null; setChunk(null); onError(error instanceof Error ? error.message : String(error)) }
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
    return () => { active = false; serial.current++; searchSerial.current++; void native.cancelLogSearch(info.handle).catch(() => undefined); observer.disconnect() }
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
          void load(visibleOffsetRef.current < next.size ? visibleOffsetRef.current : Math.max(0, next.size - 65536), true)
        } else if (next.size !== infoRef.current.size) {
          const host = scrollRef.current
          const wasAtEnd = chunkRef.current?.next === infoRef.current.size && !!host && host.scrollTop + host.clientHeight >= host.scrollHeight - rowHeight
          infoRef.current = next
          onInfo(next)
          if (wasAtEnd) void load(chunkRef.current?.next ?? 0, false, true, true)
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
    const request = ++searchSerial.current
    const start = matchOffset === undefined ? visibleOffsetRef.current : matchOffset + (previous ? 0 : 1)
    setStatus('')
    try {
      const id = await native.findLog(info.handle, query, start, previous)
      if (request !== searchSerial.current) { void native.cancelLogSearch(info.handle, id).catch(() => undefined); return }
      let result = await native.pollLogSearch(info.handle, id)
      while (!result.done && request === searchSerial.current) {
        await new Promise((resolve) => window.setTimeout(resolve, 80))
        if (request !== searchSerial.current) return
        result = await native.pollLogSearch(info.handle, id)
      }
      if (result.error) throw new Error(result.error)
      if (request !== searchSerial.current) return
      if (result.offset < 0) { setStatus('No match'); return }
      setMatchOffset(result.offset)
      matchRef.current = result.offset
      await load(result.offset, true, false, false, { offset: result.offset, query, searchRequest: request })
      if (request !== searchSerial.current) return
      await editorRef.current?.seek(result.offset, query)
    } catch (error) {
      if (request === searchSerial.current) onError(error instanceof Error ? error.message : String(error))
    }
  }

  const updateQuery = (value: string) => {
    searchSerial.current++
    void native.cancelLogSearch(info.handle).catch(() => undefined)
    editorRef.current?.clearSearchSelection()
    setQuery(value)
    setMatchOffset(undefined)
    matchRef.current = undefined
    setCountResult(undefined)
    setCountOffset(undefined)
    setStatus('')
  }

  useEffect(() => {
    let cancelled = false
    let id = 0
    countSizeRef.current = info.size
    setCountResult(undefined)
    setCountOffset(undefined)
    setCountID(0)
    if (findOpen && query) {
      const timer = window.setTimeout(() => {
        void native.countLogMatches(info.handle, query).then(async (started) => {
          id = started
          if (cancelled) { await native.cancelLogCount(info.handle, id); return }
          countIDRef.current = id
          setCountID(id)
          for (;;) {
            const selected = matchRef.current
            const result = await native.pollLogCount(info.handle, id, selected ?? -1)
            if (cancelled) return
            if (selected === matchRef.current) { setCountResult(result); setCountOffset(selected) }
            if (result.done || result.error) return
            await new Promise((resolve) => window.setTimeout(resolve, 150))
          }
        }).catch((error: unknown) => {
          if (!cancelled) setCountResult({ done: true, total: 0, ordinal: 0, error: error instanceof Error ? error.message : String(error) })
        })
      }, 250)
      return () => {
        cancelled = true
        window.clearTimeout(timer)
        if (id) void native.cancelLogCount(info.handle, id).catch(() => undefined)
        if (countIDRef.current === id) countIDRef.current = 0
      }
    }
    return () => { cancelled = true }
  }, [findOpen, query, info.handle, info.revision, countVersion])

  useEffect(() => {
    if (findOpen && query && countResult?.done && info.size !== countSizeRef.current) setCountVersion((current) => current + 1)
  }, [findOpen, query, info.size, countResult?.done])

  useEffect(() => {
    if (chunkRef.current && chunkRef.current.revision !== info.revision) void load(Math.min(editorPosition, info.size), true)
  }, [info.revision])

  useEffect(() => {
    if (!countID || countIDRef.current !== countID) return
    void native.pollLogCount(info.handle, countID, matchOffset ?? -1).then((result) => {
      if (countIDRef.current === countID && matchRef.current === matchOffset) { setCountResult(result); setCountOffset(matchOffset) }
    }).catch(() => undefined)
  }, [countID, matchOffset, info.handle])

  useImperativeHandle(ref, () => ({
    showFind: () => { setFindOpen(true); requestAnimationFrame(() => findRef.current?.focus()) },
    findNext: (previous) => { void find(previous) },
    flush: () => editorRef.current?.flush() ?? Promise.resolve(),
    setSaving: (saving) => editorRef.current?.setSaving(saving),
  }))

  const { first, visible } = visibleLogLines(rows, scrollTop, height, rowHeight)
  const tokenCache = new Map<string, monaco.Token[]>()
  const matchCache = new Map<number, LogTextMatch[]>()
  const atEnd = (endSelected || scrollTop > 0) && chunk?.next === info.size && scrollTop + height >= rows.length * rowHeight + logTopPadding - 1
  const position = dragPosition ?? (navigationOpen && atEnd ? 1 : Math.max(0, Math.min(1, (navigationOpen ? visiblePosition : editorPosition) / Math.max(1, info.size))))
  const trackHeight = trackRef.current?.clientHeight ?? height

  const showPrevious = () => {
    const current = chunkRef.current
    const earlier = previousLines.current
    const host = scrollRef.current
    if (!current || !earlier.length || !host) return false
    const all = [...earlier, ...current.lines].slice(0, 240)
    const request = serial.current
    previousLines.current = []
    setEndSelected(false)
    currentOffset.current = all[0].offset
    chunkRef.current = { ...current, lines: all, next: all.at(-1)?.next ?? current.next }
    setChunk(chunkRef.current)
    suppressScroll.current = true
    const target = host.scrollTop + visualLogRows(earlier, wordWrap, columns).length * rowHeight
    requestAnimationFrame(() => {
      if (request !== serial.current || !scrollRef.current) return
      scrollRef.current.scrollTop = target
      setScrollTop(target)
      window.setTimeout(() => { if (request === serial.current) suppressScroll.current = false }, 100)
    })
    return true
  }

  const loadPrevious = async () => {
    const current = chunkRef.current
    const host = scrollRef.current
    if (!current || !host || currentOffset.current === 0) return
    const request = ++serial.current
    loading.current = true
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
      setEndSelected(false)
      chunkRef.current = merged.chunk
      setChunk(merged.chunk)
      suppressScroll.current = true
      const target = host.scrollTop + visualLogRows(merged.chunk.lines.slice(0, merged.added), wordWrap, columns).length * rowHeight
      requestAnimationFrame(() => {
        if (request !== serial.current || !scrollRef.current) return
        scrollRef.current.scrollTop = target
        setScrollTop(scrollRef.current.scrollTop)
        window.setTimeout(() => { if (request === serial.current) suppressScroll.current = false }, 100)
      })
    } catch (error) {
      if (request === serial.current) { suppressScroll.current = false; previousLines.current = []; chunkRef.current = null; setChunk(null); onError(error instanceof Error ? error.message : String(error)) }
    } finally {
      if (request === serial.current) loading.current = false
    }
  }

  const seekGlobal = (fraction: number) => {
    const target = fraction >= 1 ? info.size : Math.floor(info.size * fraction)
    void editorRef.current?.seek(target).catch((error: unknown) => onError(error instanceof Error ? error.message : String(error)))
    return load(fraction >= 1 ? Math.max(0, info.size - 65536) : target, true, fraction >= 1)
  }
  const pointerPosition = (clientY: number, track: HTMLDivElement, grab: number) => {
    const travel = Math.max(1, track.clientHeight - globalThumbHeight)
    return Math.max(0, Math.min(1, (clientY - track.getBoundingClientRect().top - grab) / travel))
  }

  return <div className={`log-viewer log-viewer--${theme}${wordWrap ? ' log-viewer--wrap' : ''}`} style={{ fontSize, '--log-gutter-width': `${gutterWidth}px`, '--log-top-padding': `${logTopPadding}px`, '--log-text-padding': `${logTextPadding}px`, '--log-global-thumb-height': `${globalThumbHeight}px` } as CSSProperties}>
    <div className="log-editor-toolbar"><button type="button" onClick={() => setNavigationOpen((open) => !open)}>{navigationOpen ? 'Hide navigation' : 'Show navigation'}</button><span>Select All applies to the current 2 MiB editor window</span></div>
    {findOpen && <div className="log-find" onKeyDown={(event) => { if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); setFindOpen(false); scrollRef.current?.focus() } }}>
      <span className="log-find__field"><input ref={findRef} aria-label="Find in log" value={query} onChange={(event) => updateQuery(event.target.value)} onKeyDown={(event) => { if (event.key === 'Enter') void find(event.shiftKey) }} />{query && <button type="button" className="log-find__clear" aria-label="Clear search" title="Clear search" onClick={() => { updateQuery(''); findRef.current?.focus() }}>×</button>}</span>
      <span className="log-find__count" title={countResult?.error}>{countResult?.error ? 'Error' : status || <>{matchOffset === undefined ? 0 : countOffset === matchOffset ? countResult?.ordinal || '…' : '…'} / {countResult?.done ? countResult.total : '…'}</>}</span>
      <button type="button" className="log-find__icon" aria-label="Next match" title="Next match" onClick={() => void find(false)}>↓</button>
      <button type="button" className="log-find__icon" aria-label="Previous match" title="Previous match" onClick={() => void find(true)}>↑</button>
      <button type="button" className="log-find__icon" aria-label="Close find" title="Close find" onClick={() => { setFindOpen(false); scrollRef.current?.focus() }}>×</button>
    </div>}
    <div className="log-body">
    <div className="log-content">
    <div ref={scrollRef} className="log-scroll" style={{ display: navigationOpen ? undefined : 'none' }} tabIndex={0} onScroll={(event) => {
      const host = event.currentTarget
      setScrollTop(host.scrollTop)
      if (host.scrollTop + host.clientHeight < host.scrollHeight - rowHeight) setEndSelected(false)
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
          {visible.map((row) => <div className={`log-row${row.overflow ? ' log-row--overflow' : ''}`} data-log-offset={row.line.offset} key={`${row.line.offset}:${row.part}`} style={{ height: rowHeight }} onClick={() => { void editorRef.current?.seek(row.line.offset); setNavigationOpen(false) }}><span className="log-offset">{row.part === 0 ? row.line.offset.toLocaleString() : ''}</span><span className="log-text">{highlighted(row, tokenCache, matchCache, query, matchOffset)}{row.last && row.line.truncated && <span className="log-truncated"> [line truncated]</span>}</span></div>)}
        </div>
      </div>
    </div>
    <LogEditorWindow ref={editorRef} info={info} theme={theme} fontSize={fontSize} wordWrap={wordWrap} onInfo={(next) => { if (next.revision !== infoRef.current.revision) searchSerial.current++; infoRef.current = next; setMatchOffset(undefined); onInfo(next) }} onPosition={(offset) => { setEditorPosition(offset); onPosition(offset) }} onPendingEdit={() => onInfo({ ...infoRef.current, dirty: true })} onError={onError} />
    </div>
    <div ref={trackRef} className="log-global-scroll" role="scrollbar" aria-label="Log position" aria-orientation="vertical" aria-valuemin={0} aria-valuemax={info.size} aria-valuenow={Math.round(position * info.size)} tabIndex={0} onPointerDown={(event) => {
      if (event.button !== 0) return
      const thumb = (event.target as Element).closest('.log-global-thumb')
      const grab = thumb ? event.clientY - thumb.getBoundingClientRect().top : globalThumbHeight / 2
      const target = pointerPosition(event.clientY, event.currentTarget, grab)
      dragRef.current = { pointerId: event.pointerId, grab, lastSeek: performance.now(), target, sent: target }
      event.currentTarget.setPointerCapture(event.pointerId)
      setDragPosition(target)
      void seekGlobal(target)
      event.preventDefault()
    }} onPointerMove={(event) => {
      const drag = dragRef.current
      if (!drag || drag.pointerId !== event.pointerId) return
      const target = pointerPosition(event.clientY, event.currentTarget, drag.grab)
      drag.target = target
      setDragPosition(target)
      if (performance.now() - drag.lastSeek >= 100 && target !== drag.sent) {
        drag.lastSeek = performance.now()
        drag.sent = target
        void seekGlobal(target)
      }
    }} onPointerUp={(event) => {
      const drag = dragRef.current
      if (!drag || drag.pointerId !== event.pointerId) return
      dragRef.current = undefined
      event.currentTarget.releasePointerCapture(event.pointerId)
      void seekGlobal(drag.target).finally(() => setDragPosition(undefined))
    }} onPointerCancel={() => { dragRef.current = undefined; setDragPosition(undefined) }} onKeyDown={(event) => {
      const step = Math.max(1, Math.floor(info.size / 100))
      const target = event.key === 'Home' ? 0 : event.key === 'End' ? info.size : event.key === 'ArrowDown' || event.key === 'PageDown' ? Math.min(info.size, visiblePosition + step) : event.key === 'ArrowUp' || event.key === 'PageUp' ? Math.max(0, visiblePosition - step) : undefined
      if (target === undefined) return
      event.preventDefault()
      void seekGlobal(target / Math.max(1, info.size))
    }}><div className="log-global-thumb" style={{ top: `${position * Math.max(0, trackHeight - globalThumbHeight)}px` }} /></div>
    </div>
  </div>
})
