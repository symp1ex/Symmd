import { forwardRef, useEffect, useImperativeHandle, useRef } from 'react'
import { native, type LogInfo, type LogWindow } from '../bridge/native'
import * as monaco from '../editor/monaco'
import { modelIndexToRawStringIndex, normalizeLogWindowText, preferredLogEOL, rawStringIndexToModelIndex, stringIndexToUtf8ByteOffset, utf8ByteOffsetToStringIndex } from './viewport'

const maxLogWindowBytes = 2 << 20

export interface LogEditorWindowHandle {
  seek(offset: number): Promise<void>
  flush(): Promise<void>
  focus(): void
  setSaving(saving: boolean): void
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
  const callbacksRef = useRef({ onInfo, onPosition, onPendingEdit, onError })
  callbacksRef.current = { onInfo, onPosition, onPendingEdit, onError }

  const seek = async (target: number) => {
    const request = ++loadingRef.current
    let pending: Promise<void>
    do { pending = pendingRef.current; await pending } while (pending !== pendingRef.current)
    const window = await native.readLogWindow(info.handle, Math.max(0, target))
    if (request !== loadingRef.current) return
    if (pending !== pendingRef.current) { void seek(target); return }
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
    windowBytesRef.current = new TextEncoder().encode(window.text).length
    displayEditableRef.current = window.editable && actual === normalizeLogWindowText(window.text)
    editor.updateOptions({ readOnly: savingRef.current || !displayEditableRef.current })
    let byteOffset = Math.max(0, target - window.offset)
    while (byteOffset > 0 && utf8ByteOffsetToStringIndex(window.text, byteOffset) === undefined) byteOffset--
    let rawIndex = utf8ByteOffsetToStringIndex(window.text, byteOffset) ?? 0
    if (rawIndex > 0 && window.text[rawIndex - 1] === '\r' && window.text[rawIndex] === '\n') rawIndex--
    const relative = rawStringIndexToModelIndex(window.text, rawIndex) ?? 0
    editor.setPosition(model.getPositionAt(relative))
    editor.revealPositionInCenter(model.getPositionAt(relative))
    suppressRef.current = false
    callbacksRef.current.onPosition(target)
    if (!displayEditableRef.current && window.editable) callbacksRef.current.onError('This window cannot be mapped to original byte offsets and is view-only')
    else if (!window.editable) callbacksRef.current.onError('This window contains invalid UTF-8 or an external conflict and is view-only')
    if (window.revision !== info.revision) callbacksRef.current.onInfo(await native.statLog(info.handle))
  }

  useImperativeHandle(ref, () => ({
    seek,
    flush: async () => { let pending: Promise<void>; do { pending = pendingRef.current; await pending } while (pending !== pendingRef.current); if (pendingErrorRef.current) throw pendingErrorRef.current },
    focus: () => editorRef.current?.focus(),
    setSaving: (saving) => { savingRef.current = saving; editorRef.current?.updateOptions({ readOnly: saving || !displayEditableRef.current }) },
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
      const window = windowRef.current
      if (!window || !window.editable) return
      const before = textRef.current
      const rawBefore = rawRef.current
      let edits: { start: number; end: number; rawStart: number; rawEnd: number; text: string }[]
      try {
        edits = event.changes.map((change) => {
          const rawStart = modelIndexToRawStringIndex(rawBefore, change.rangeOffset)
          const rawEnd = modelIndexToRawStringIndex(rawBefore, change.rangeOffset + change.rangeLength)
          const start = rawStart === undefined ? undefined : stringIndexToUtf8ByteOffset(rawBefore, rawStart)
          const end = rawEnd === undefined ? undefined : stringIndexToUtf8ByteOffset(rawBefore, rawEnd)
          if (start === undefined || end === undefined || rawStart === undefined || rawEnd === undefined) throw new Error('Edit splits a UTF-8 character')
          return { start: window.offset + start, end: window.offset + end, rawStart, rawEnd, text: normalizeLogWindowText(change.text).replaceAll('\n', eolRef.current) }
        }).sort((left, right) => right.start - left.start)
      } catch (error) {
        displayEditableRef.current = false
        editor.updateOptions({ readOnly: true })
        callbacksRef.current.onError(error instanceof Error ? error.message : String(error))
        return
      }
      let nextRaw = rawBefore
      for (const edit of edits) nextRaw = nextRaw.slice(0, edit.rawStart) + edit.text + nextRaw.slice(edit.rawEnd)
      const nextBytes = windowBytesRef.current + edits.reduce((delta, edit) => delta + new TextEncoder().encode(edit.text).length - (edit.end - edit.start), 0)
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
      callbacksRef.current.onPendingEdit()
      pendingRef.current = pendingRef.current.then(async () => {
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
      const window = windowRef.current
      const index = editor.getModel()?.getOffsetAt(event.position) ?? 0
      const rawIndex = modelIndexToRawStringIndex(rawRef.current, index)
      const bytes = rawIndex === undefined ? undefined : stringIndexToUtf8ByteOffset(rawRef.current, rawIndex)
      if (bytes === undefined) return
      const logical = window.offset + bytes
      callbacksRef.current.onPosition(logical)
      if (textRef.current.length > 65536 && ((index > textRef.current.length - 2048 && window.offset + windowBytesRef.current < window.size) || (index < 2048 && window.offset > 0))) {
        void seek(logical).catch((error: unknown) => callbacksRef.current.onError(error instanceof Error ? error.message : String(error)))
      }
    })
    const keydown = (event: KeyboardEvent) => {
      if (!event.ctrlKey || event.altKey || event.metaKey || !['KeyZ', 'KeyY'].includes(event.code)) return
      event.preventDefault()
      event.stopPropagation()
      const redo = event.code === 'KeyY' || event.shiftKey
      const current = windowRef.current
      const index = editor.getModel()?.getOffsetAt(editor.getPosition()!) ?? 0
      const rawIndex = modelIndexToRawStringIndex(rawRef.current, index)
      const offset = (current?.offset ?? 0) + (rawIndex === undefined ? 0 : stringIndexToUtf8ByteOffset(rawRef.current, rawIndex) ?? 0)
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
    void seek(0).catch((error: unknown) => callbacksRef.current.onError(error instanceof Error ? error.message : String(error)))
    return () => {
      loadingRef.current++
      content.dispose(); cursor.dispose()
      host.removeEventListener('keydown', keydown, true)
      host.removeEventListener('contextmenu', menu, true)
      host.removeEventListener('paste', paste, true)
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
