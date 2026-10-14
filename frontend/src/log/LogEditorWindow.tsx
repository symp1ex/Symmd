import { forwardRef, useEffect, useImperativeHandle, useRef } from 'react'
import { native, type LogInfo, type LogWindow } from '../bridge/native'
import * as monaco from '../editor/monaco'
import { logTextMatches, logByteOffsetToStringIndex, logInsertedBytes, logStringIndexToByteOffset, modelIndexToRawStringIndex, normalizeLogWindowText, preferredLogEOL, rawStringIndexToModelIndex } from './viewport'

const maxLogWindowBytes = 2 << 20

interface ScrollAnchor { logical: number; top: number; left: number; version: number; selection?: { anchor: number; active: number } }

export interface LogEditorWindowHandle {
  seek(offset: number, searchQuery?: string): Promise<void>
  clearSearchSelection(): void
  flush(): Promise<void>
  focus(): void
  setSaving(saving: boolean): void
  cursorOffset(): number | undefined
}

interface Props {
  info: LogInfo
  theme: 'dark' | 'light'
  fontSize: number
  wordWrap: boolean
  onInfo(info: LogInfo): void
  onPosition(offset: number): void
  onPendingEdit(): void
  onError(message: string): void
}

export const LogEditorWindow = forwardRef<LogEditorWindowHandle, Props>(function LogEditorWindow({ info, theme, fontSize, wordWrap, onInfo, onPosition, onPendingEdit, onError }, ref) {
  const hostRef = useRef<HTMLDivElement>(null)
  const editorRef = useRef<monaco.editor.IStandaloneCodeEditor | null>(null)
  const windowRef = useRef<LogWindow | null>(null)
  const textRef = useRef('')
  const rawRef = useRef('')
  const eolRef = useRef<'\r\n' | '\n'>('\n')
  const suppressRef = useRef(false)
  const loadingRef = useRef(0)
  const pendingRef = useRef<Promise<void>>(Promise.resolve())
  const savingRef = useRef(false)
  const displayEditableRef = useRef(false)
  const pendingErrorRef = useRef<Error | null>(null)
  const windowBytesRef = useRef(0)
  const lastScrollPositionRef = useRef<monaco.IPosition | undefined>(undefined)
  const searchSelectionRef = useRef<monaco.Range | undefined>(undefined)
  const searchRequestRef = useRef(0)
  const detachedSelectionRef = useRef<ScrollAnchor['selection']>(undefined)
  const viewportVersionRef = useRef(0)
  const navigatingRef = useRef(0)
  const callbacksRef = useRef({ onInfo, onPosition, onPendingEdit, onError })
  callbacksRef.current = { onInfo, onPosition, onPendingEdit, onError }

  const positionOffset = (position: monaco.IPosition) => {
    const window = windowRef.current
    const model = editorRef.current?.getModel()
    if (!window || !model) return
    const index = model.getOffsetAt(position)
    const rawIndex = modelIndexToRawStringIndex(rawRef.current, index)
    const bytes = rawIndex === undefined ? undefined : logStringIndexToByteOffset(rawRef.current, rawIndex, window.encoding)
    return bytes === undefined ? undefined : { index, logical: window.offset + bytes }
  }

  const loadWindow = async (target: number, searchQuery?: string, anchor?: ScrollAnchor) => {
    const request = ++loadingRef.current
    const searchRequest = searchRequestRef.current
    let pending: Promise<void>
    do { pending = pendingRef.current; await pending } while (pending !== pendingRef.current)
    const window = await native.readLogWindow(info.handle, Math.max(0, target))
    if (request !== loadingRef.current || (searchQuery && searchRequest !== searchRequestRef.current)) return
    if (anchor && anchor.version !== viewportVersionRef.current) return
    if (pending !== pendingRef.current) { if (!anchor) await loadWindow(target, searchQuery); return }
    const editor = editorRef.current
    const model = editor?.getModel()
    if (!editor || !model) return
    suppressRef.current = true
    model.setValue(window.text)
    model.setEOL(monaco.editor.EndOfLineSequence.LF)
    const actual = model.getValue()
    textRef.current = actual
    rawRef.current = window.text
    eolRef.current = preferredLogEOL(window.text)
    windowRef.current = window
    pendingErrorRef.current = null
    windowBytesRef.current = window.next - window.offset
    displayEditableRef.current = window.editable && actual === normalizeLogWindowText(window.text)
    editor.updateOptions({ readOnly: savingRef.current || !displayEditableRef.current })
    let byteOffset = Math.max(0, target - window.offset)
    byteOffset = Math.min(byteOffset, windowBytesRef.current)
    while (byteOffset > 0 && logByteOffsetToStringIndex(window.text, byteOffset, window.encoding) === undefined) byteOffset--
    let rawIndex = logByteOffsetToStringIndex(window.text, byteOffset, window.encoding) ?? 0
    if (rawIndex > 0 && window.text[rawIndex - 1] === '\r' && window.text[rawIndex] === '\n') rawIndex--
    const relative = rawStringIndexToModelIndex(window.text, rawIndex) ?? 0
    const start = model.getPositionAt(relative)
    const selected = searchQuery ? logTextMatches({ offset: window.offset, next: window.next, text: window.text, truncated: false, encoding: window.encoding }, searchQuery, target).find((match) => match.selected) : undefined
    const selectedStart = selected ? rawStringIndexToModelIndex(window.text, selected.start) : undefined
    const end = selected ? rawStringIndexToModelIndex(window.text, selected.end) : undefined
    if (anchor) {
      const position = (logical: number) => {
        const raw = logByteOffsetToStringIndex(window.text, logical - window.offset, window.encoding)
        const index = raw === undefined ? undefined : rawStringIndexToModelIndex(window.text, raw)
        return index === undefined ? undefined : model.getPositionAt(index)
      }
      const visible = position(anchor.logical)
      if (visible) {
        const from = anchor.selection && position(anchor.selection.anchor)
        const to = anchor.selection && position(anchor.selection.active)
        if (from && to) {
          editor.setSelection(monaco.Selection.fromPositions(from, to))
          detachedSelectionRef.current = undefined
          if (searchSelectionRef.current) searchSelectionRef.current = editor.getSelection() ?? undefined
        } else {
          editor.setPosition(visible)
          if (!detachedSelectionRef.current) callbacksRef.current.onError('Cursor or selection is outside the loaded window. Click or move the cursor to edit.')
          detachedSelectionRef.current = anchor.selection
          searchSelectionRef.current = undefined
        }
        editor.setScrollPosition({ scrollTop: editor.getTopForPosition(visible.lineNumber, visible.column) - anchor.top, scrollLeft: anchor.left }, monaco.editor.ScrollType.Immediate)
      }
      editor.updateOptions({ readOnly: savingRef.current || !displayEditableRef.current || !!detachedSelectionRef.current })
    } else if (selectedStart !== undefined && end !== undefined) {
      detachedSelectionRef.current = undefined
      const range = monaco.Range.fromPositions(model.getPositionAt(selectedStart), model.getPositionAt(end))
      searchSelectionRef.current = range
      editor.setSelection(range)
      editor.revealRangeInCenter(range)
    } else {
      detachedSelectionRef.current = undefined
      searchSelectionRef.current = undefined
      editor.setPosition(start)
      editor.revealPositionInCenter(start)
    }
    suppressRef.current = false
    lastScrollPositionRef.current = undefined
    callbacksRef.current.onPosition(anchor?.logical ?? target)
    if (!displayEditableRef.current && window.editable) callbacksRef.current.onError('This window cannot be mapped to original byte offsets and is view-only')
    else if (!window.editable) callbacksRef.current.onError(window.error ?? 'This window cannot be decoded safely and is view-only')
    if (window.revision !== info.revision) callbacksRef.current.onInfo(await native.statLog(info.handle))
  }
  const seek = async (target: number, searchQuery?: string) => {
    navigatingRef.current++
    viewportVersionRef.current++
    try { await loadWindow(target, searchQuery) } finally { navigatingRef.current-- }
  }

  useImperativeHandle(ref, () => ({
    seek,
    clearSearchSelection: () => {
      searchRequestRef.current++
      const editor = editorRef.current
      const selection = editor?.getSelection()
      if (searchSelectionRef.current && selection?.equalsRange(searchSelectionRef.current)) {
        suppressRef.current = true
        try { editor?.setPosition(selection.getStartPosition()) } finally { suppressRef.current = false }
      }
      searchSelectionRef.current = undefined
    },
    flush: async () => { let pending: Promise<void>; do { pending = pendingRef.current; await pending } while (pending !== pendingRef.current); if (pendingErrorRef.current) throw pendingErrorRef.current },
    focus: () => editorRef.current?.focus(),
    setSaving: (saving) => { savingRef.current = saving; editorRef.current?.updateOptions({ readOnly: saving || !displayEditableRef.current || !!detachedSelectionRef.current }) },
    cursorOffset: () => detachedSelectionRef.current?.active ?? (editorRef.current?.getPosition() ? positionOffset(editorRef.current.getPosition()!)?.logical : undefined),
  }))

  useEffect(() => {
    const host = hostRef.current
    if (!host) return
    const editor = monaco.editor.create(host, {
      value: '', language: 'log', theme: monaco.editorTheme(theme), automaticLayout: true,
      wordWrap: wordWrap ? 'on' : 'off', minimap: { enabled: false },
      scrollBeyondLastLine: false, fontSize, contextmenu: false, readOnly: true,
      renderWhitespace: 'selection', padding: { top: 12 },
    })
    editorRef.current = editor
    const content = editor.onDidChangeModelContent((event) => {
      if (suppressRef.current) return
      viewportVersionRef.current++
      const window = windowRef.current
      if (!window || !window.editable) return
      const before = textRef.current
      const rawBefore = rawRef.current
      let edits: { start: number; end: number; rawStart: number; rawEnd: number; text: string }[]
      try {
        edits = event.changes.map((change) => {
          const rawStart = modelIndexToRawStringIndex(rawBefore, change.rangeOffset)
          const rawEnd = modelIndexToRawStringIndex(rawBefore, change.rangeOffset + change.rangeLength)
          const start = rawStart === undefined ? undefined : logStringIndexToByteOffset(rawBefore, rawStart, window.encoding)
          const end = rawEnd === undefined ? undefined : logStringIndexToByteOffset(rawBefore, rawEnd, window.encoding)
          if (start === undefined || end === undefined || rawStart === undefined || rawEnd === undefined) throw new Error('Edit splits an encoded character')
          const text = normalizeLogWindowText(change.text).replaceAll('\n', eolRef.current)
          logInsertedBytes(text, window.encoding)
          return { start: window.offset + start, end: window.offset + end, rawStart, rawEnd, text }
        }).sort((left, right) => right.start - left.start)
      } catch (error) {
        suppressRef.current = true
        editor.getModel()?.setValue(before)
        editor.getModel()?.setEOL(monaco.editor.EndOfLineSequence.LF)
        suppressRef.current = false
        callbacksRef.current.onError(error instanceof Error ? error.message : String(error))
        return
      }
      let nextRaw = rawBefore
      for (const edit of edits) nextRaw = nextRaw.slice(0, edit.rawStart) + edit.text + nextRaw.slice(edit.rawEnd)
      const nextBytes = windowBytesRef.current + edits.reduce((delta, edit) => delta + logInsertedBytes(edit.text, window.encoding) - (edit.end - edit.start), 0)
      if (nextBytes > maxLogWindowBytes + 8192 || normalizeLogWindowText(nextRaw) !== editor.getValue()) {
        suppressRef.current = true
        editor.getModel()?.setValue(before)
        editor.getModel()?.setEOL(monaco.editor.EndOfLineSequence.LF)
        suppressRef.current = false
        callbacksRef.current.onError(nextBytes > maxLogWindowBytes + 8192 ? 'Paste exceeds the 2 MiB editor window' : 'Could not map the edit to original bytes')
        return
      }
      textRef.current = editor.getValue()
      rawRef.current = nextRaw
      windowBytesRef.current = nextBytes
      window.next = window.offset + nextBytes
      callbacksRef.current.onPendingEdit()
      pendingRef.current = pendingRef.current.then(async () => {
        if (pendingErrorRef.current) throw pendingErrorRef.current
        for (const edit of edits) {
          const next = await native.replaceLog(info.handle, edit.start, edit.end, edit.text)
          window.size = next.size
          window.revision = next.revision
          callbacksRef.current.onInfo(next)
        }
      }).catch((error: unknown) => {
        pendingErrorRef.current = error instanceof Error ? error : new Error(String(error))
        displayEditableRef.current = false
        editor.updateOptions({ readOnly: true })
        callbacksRef.current.onError(error instanceof Error ? error.message : String(error))
        void native.statLog(info.handle).then((state) => callbacksRef.current.onInfo(state)).catch(() => undefined)
      })
    })
    const cursor = editor.onDidChangeCursorPosition((event) => {
      if (suppressRef.current || !windowRef.current) return
      viewportVersionRef.current++
      const window = windowRef.current
      if (detachedSelectionRef.current) {
        detachedSelectionRef.current = undefined
        editor.updateOptions({ readOnly: savingRef.current || !displayEditableRef.current })
      }
      const offset = positionOffset(event.position)
      if (!offset) return
      const { index, logical } = offset
      lastScrollPositionRef.current = undefined
      callbacksRef.current.onPosition(logical)
      if (textRef.current.length > 65536 && ((index > textRef.current.length - 2048 && window.offset + windowBytesRef.current < window.size) || (index < 2048 && window.offset > 0))) {
        void seek(logical).catch((error: unknown) => callbacksRef.current.onError(error instanceof Error ? error.message : String(error)))
      }
    })
    let shiftTimer: ReturnType<typeof setTimeout> | undefined
    let shiftActive = false
    let pointerHeld = false
    let shiftPending = false
    let disposed = false
    const shiftWindow = async () => {
      if (disposed || shiftActive || pointerHeld || suppressRef.current || savingRef.current || navigatingRef.current) return
      shiftActive = true
      try {
        let pending: Promise<void>
        do { pending = pendingRef.current; await pending } while (pending !== pendingRef.current)
        if (disposed || pendingErrorRef.current || pointerHeld) return
        const window = windowRef.current
        const range = editor.getVisibleRanges()[0]
        if (!window || !range) return
        const layout = editor.getLayoutInfo()
        const rect = host.getBoundingClientRect()
        const hit = editor.getTargetAtClientPoint(rect.left + layout.contentLeft + 1, rect.top + 1)?.position
        const visible = hit ?? range.getStartPosition()
        const offset = positionOffset(visible)
        if (!offset) return
        const distance = Math.max(200, layout.height * 2)
        const above = editor.getScrollTop() < distance && window.offset > info.bom
        const below = editor.getScrollTop() + layout.height > editor.getScrollHeight() - distance && window.next < window.size
        if (!above && !below) return
        const selection = editor.getSelection()
        const from = selection && positionOffset(selection.getSelectionStart())
        const to = selection && positionOffset(selection.getPosition())
        const anchor: ScrollAnchor = {
          logical: offset.logical, top: editor.getTopForPosition(visible.lineNumber, visible.column) - editor.getScrollTop(), left: editor.getScrollLeft(),
          version: viewportVersionRef.current,
          selection: detachedSelectionRef.current ?? (from && to ? { anchor: from.logical, active: to.logical } : undefined),
        }
        // ReadWindow puts the target a quarter-window from its start. Bias
        // upward shifts so the same visible character has room above and below.
        const target = above ? Math.max(info.bom, offset.logical - maxLogWindowBytes / 4) : offset.logical
        await loadWindow(target, undefined, anchor)
      } catch (error) {
        if (!disposed) callbacksRef.current.onError(error instanceof Error ? error.message : String(error))
      } finally { shiftActive = false; if (shiftPending && !disposed && !pointerHeld) scheduleShift() }
    }
    const scheduleShift = () => {
      shiftPending = true
      if (shiftTimer) clearTimeout(shiftTimer)
      shiftTimer = setTimeout(() => { shiftTimer = undefined; if (!pointerHeld && !shiftActive) { shiftPending = false; void shiftWindow() } }, 80)
    }
    const pointerDown = () => { pointerHeld = true }
    const pointerUp = () => { pointerHeld = false; if (shiftPending) scheduleShift() }
    const scroll = editor.onDidScrollChange((event) => {
      if (!event.scrollTopChanged || suppressRef.current) return
      viewportVersionRef.current++
      const position = editor.getVisibleRanges()[0]?.getStartPosition()
      const previous = lastScrollPositionRef.current
      scheduleShift()
      if (!position || position.lineNumber === previous?.lineNumber && position.column === previous?.column) return
      const offset = positionOffset(position)
      if (!offset) return
      lastScrollPositionRef.current = position
      callbacksRef.current.onPosition(offset.logical)
    })
    const keydown = (event: KeyboardEvent) => {
      if (!event.ctrlKey || event.altKey || event.metaKey || !['KeyZ', 'KeyY'].includes(event.code)) return
      event.preventDefault()
      event.stopPropagation()
      const redo = event.code === 'KeyY' || event.shiftKey
      const current = windowRef.current
      const index = editor.getModel()?.getOffsetAt(editor.getPosition()!) ?? 0
      const rawIndex = modelIndexToRawStringIndex(rawRef.current, index)
      const offset = (current?.offset ?? 0) + (rawIndex === undefined ? 0 : logStringIndexToByteOffset(rawRef.current, rawIndex, current?.encoding) ?? 0)
      void pendingRef.current.then(async () => {
        const next = redo ? await native.redoLog(info.handle) : await native.undoLog(info.handle)
        callbacksRef.current.onInfo(next)
        await seek(Math.min(offset, next.size))
      }).catch((error: unknown) => callbacksRef.current.onError(error instanceof Error ? error.message : String(error)))
    }
    const menu = (event: MouseEvent) => {
      event.preventDefault()
      const selection = editor.getSelection()
      void native.showContextMenu({ editable: !editor.getOption(monaco.editor.EditorOption.readOnly), hasSelection: Boolean(selection && !selection.isEmpty()), canSelectAll: Boolean(editor.getModel()?.getValueLength()), link: false, canSaveLink: false }).then((command) => {
        const action = command === 'cut' ? 'editor.action.clipboardCutAction'
          : command === 'copy' ? 'editor.action.clipboardCopyAction'
          : command === 'paste' ? 'editor.action.clipboardPasteAction'
          : command === 'selectAll' ? 'editor.action.selectAll' : undefined
        if (action) { editor.focus(); editor.trigger('contextMenu', action, undefined) }
      }).catch((error: unknown) => callbacksRef.current.onError(error instanceof Error ? error.message : String(error)))
    }
    const paste = (event: ClipboardEvent) => {
      if ((event.clipboardData?.getData('text/plain').length ?? 0) > maxLogWindowBytes) {
        event.preventDefault()
        callbacksRef.current.onError('Paste exceeds the 2 MiB editor window')
      }
    }
    host.addEventListener('keydown', keydown, true)
    host.addEventListener('contextmenu', menu, true)
    host.addEventListener('paste', paste, true)
    host.addEventListener('pointerdown', pointerDown, true)
    window.addEventListener('pointerup', pointerUp, true)
    window.addEventListener('pointercancel', pointerUp, true)
    window.addEventListener('blur', pointerUp)
    void seek(0).catch((error: unknown) => callbacksRef.current.onError(error instanceof Error ? error.message : String(error)))
    return () => {
      loadingRef.current++
      disposed = true
      if (shiftTimer) clearTimeout(shiftTimer)
      content.dispose(); cursor.dispose(); scroll.dispose()
      host.removeEventListener('keydown', keydown, true)
      host.removeEventListener('contextmenu', menu, true)
      host.removeEventListener('paste', paste, true)
      host.removeEventListener('pointerdown', pointerDown, true)
      window.removeEventListener('pointerup', pointerUp, true)
      window.removeEventListener('pointercancel', pointerUp, true)
      window.removeEventListener('blur', pointerUp)
      editor.dispose()
      editorRef.current = null
    }
  }, [info.handle])

  useEffect(() => {
    monaco.editor.setTheme(monaco.editorTheme(theme))
    editorRef.current?.updateOptions({ fontSize, wordWrap: wordWrap ? 'on' : 'off' })
  }, [theme, fontSize, wordWrap])

  return <div className="log-editor-window" ref={hostRef} aria-label="Log editor window" />
})
