import { useEffect, useRef } from 'react'
import * as monaco from 'monaco-editor/esm/vs/editor/editor.api'
import EditorWorker from 'monaco-editor/esm/vs/editor/editor.worker?worker&inline'
import 'monaco-editor/min/vs/editor/editor.main.css'
import { native } from '../bridge/native'

type MonacoGlobal = typeof globalThis & { MonacoEnvironment?: { getWorker(): Worker } }
;(self as MonacoGlobal).MonacoEnvironment = {
  getWorker: () => {
    const worker = new EditorWorker()
    worker.addEventListener('error', (event) => {
      void native.reportRuntimeEvent('monaco-worker-error', event.message)
    })
    void native.reportRuntimeEvent('monaco-worker-created', 'editor')
    return worker
  },
}

interface Props {
  value: string
  onChange(value: string): void
  onScrollLine(line: number): void
  revealLine?: number
  theme: 'dark' | 'light'
  fontSize: number
  wordWrap: boolean
}

export function MarkdownEditor({ value, onChange, onScrollLine, revealLine, theme, fontSize, wordWrap }: Props) {
  const hostRef = useRef<HTMLDivElement>(null)
  const editorRef = useRef<monaco.editor.IStandaloneCodeEditor | null>(null)
  const changingRef = useRef(false)
  const onChangeRef = useRef(onChange)
  const onScrollLineRef = useRef(onScrollLine)
  onChangeRef.current = onChange
  onScrollLineRef.current = onScrollLine

  useEffect(() => {
    if (!hostRef.current) return
    const editor = monaco.editor.create(hostRef.current, {
      value,
      language: 'markdown',
      theme: theme === 'dark' ? 'vs-dark' : 'vs',
      automaticLayout: true,
      wordWrap: wordWrap ? 'on' : 'off',
      minimap: { enabled: false },
      lineNumbers: 'on',
      scrollBeyondLastLine: false,
      fontSize,
      renderWhitespace: 'selection',
      padding: { top: 12 },
    })
    editorRef.current = editor
    void native.reportRuntimeEvent('monaco-editor-ready', `models=${monaco.editor.getModels().length}`)
    const contentSubscription = editor.onDidChangeModelContent(() => {
      if (!changingRef.current) onChangeRef.current(editor.getValue())
    })
    const scrollSubscription = editor.onDidScrollChange((event) => {
      if (event.scrollTopChanged) onScrollLineRef.current(editor.getVisibleRanges()[0]?.startLineNumber ?? 1)
    })
    return () => {
      contentSubscription.dispose()
      scrollSubscription.dispose()
      editor.dispose()
      editorRef.current = null
    }
  }, [])

  useEffect(() => {
    const editor = editorRef.current
    if (!editor || editor.getValue() === value) return
    changingRef.current = true
    editor.setValue(value)
    changingRef.current = false
  }, [value])

  useEffect(() => {
    monaco.editor.setTheme(theme === 'dark' ? 'vs-dark' : 'vs')
    editorRef.current?.updateOptions({ fontSize, wordWrap: wordWrap ? 'on' : 'off' })
  }, [fontSize, theme, wordWrap])

  useEffect(() => {
    if (revealLine) editorRef.current?.revealLineInCenter(revealLine, monaco.editor.ScrollType.Smooth)
  }, [revealLine])

  return <div className="editor-host" ref={hostRef} />
}
