import { useEffect, useRef } from 'react'
import * as monaco from './monaco'
import EditorWorker from 'monaco-editor/esm/vs/editor/editor.worker?worker&inline'
import 'monaco-editor/min/vs/editor/editor.main.css'
import { native } from '../bridge/native'
import type { DocumentLanguage } from './languages'

interface Heading {
  line: number
  level: number
}

monaco.languages.registerFoldingRangeProvider('markdown', {
  provideFoldingRanges(model) {
    const ranges: monaco.languages.FoldingRange[] = []
    const headings: Heading[] = []
    let fence: { line: number; marker: string } | undefined

    const closeHeadings = (level: number, end: number) => {
      while (headings.length && headings[headings.length - 1].level >= level) {
        const heading = headings.pop()
        if (heading && end > heading.line) ranges.push({ start: heading.line, end })
      }
    }

    for (let line = 1; line <= model.getLineCount(); line += 1) {
      const content = model.getLineContent(line)
      if (fence) {
        const closing = content.match(/^ {0,3}(`{3,}|~{3,})\s*$/)
        if (closing && closing[1][0] === fence.marker[0] && closing[1].length >= fence.marker.length) {
          if (line > fence.line) ranges.push({ start: fence.line, end: line })
          fence = undefined
        }
        continue
      }

      const opening = content.match(/^ {0,3}(`{3,}|~{3,})(.*)$/)
      if (opening && !(opening[1][0] === '`' && opening[2].includes('`'))) {
        fence = { line, marker: opening[1] }
        continue
      }

      const heading = content.match(/^ {0,3}(#{1,6})(?:\s+|$)/)
      if (!heading) continue
      const level = heading[1].length
      closeHeadings(level, line - 1)
      headings.push({ line, level })
    }

    const lastLine = model.getLineCount()
    if (fence && lastLine > fence.line) ranges.push({ start: fence.line, end: lastLine })
    closeHeadings(0, lastLine)
    return ranges.sort((left, right) => left.start - right.start)
  },
})

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
  language: DocumentLanguage
}

export function MarkdownEditor({ value, onChange, onScrollLine, revealLine, theme, fontSize, wordWrap, language }: Props) {
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
      language,
      theme: monaco.editorTheme(theme),
      automaticLayout: true,
      wordWrap: wordWrap ? 'on' : 'off',
      minimap: { enabled: false },
      folding: true,
      foldingStrategy: 'auto',
      showFoldingControls: 'mouseover',
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
    const model = editorRef.current?.getModel()
    if (model && model.getLanguageId() !== language) monaco.editor.setModelLanguage(model, language)
  }, [language])

  useEffect(() => {
    monaco.editor.setTheme(monaco.editorTheme(theme))
    editorRef.current?.updateOptions({ fontSize, wordWrap: wordWrap ? 'on' : 'off' })
  }, [fontSize, theme, wordWrap])

  useEffect(() => {
    if (revealLine) editorRef.current?.revealLineInCenter(revealLine, monaco.editor.ScrollType.Smooth)
  }, [revealLine])

  return <div className="editor-host" ref={hostRef} />
}
