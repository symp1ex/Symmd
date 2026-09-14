import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { PointerEvent as ReactPointerEvent } from 'react'
import { native, type DroppedItem, type MarkdownFile, type Preferences } from '../bridge/native'
import { MarkdownEditor } from '../editor/MarkdownEditor'
import { MarkdownPreview } from '../preview/MarkdownPreview'

type ViewMode = 'editor' | 'split' | 'preview'

interface DocumentState extends MarkdownFile {
  id: string
  savedContent: string
}

const resizeHandles = [
  ['left', 10], ['right', 11], ['top', 12], ['top-left', 13],
  ['top-right', 14], ['bottom', 15], ['bottom-left', 16], ['bottom-right', 17],
] as const

let nextDocumentID = 1

function documentFromFile(file: MarkdownFile): DocumentState {
  return { ...file, id: `document-${nextDocumentID++}`, savedContent: file.path ? file.content : '' }
}

function newDocument(): DocumentState {
  const number = nextDocumentID++
  return { id: `document-${number}`, path: '', name: `Untitled-${number}.md`, content: '', savedContent: '', modifiedNs: 0 }
}

function isDirty(document: DocumentState): boolean { return document.content !== document.savedContent }

function useDebounced<T>(value: T, delay: number): T {
  const [debounced, setDebounced] = useState(value)
  useEffect(() => {
    const timer = window.setTimeout(() => setDebounced(value), delay)
    return () => window.clearTimeout(timer)
  }, [delay, value])
  return debounced
}

export function App() {
  const firstDocument = useMemo(() => newDocument(), [])
  const [documents, setDocuments] = useState<DocumentState[]>([firstDocument])
  const [activeID, setActiveID] = useState(firstDocument.id)
  const [viewMode, setViewMode] = useState<ViewMode>('split')
  const [splitPercent, setSplitPercent] = useState(50)
  const [preferences, setPreferences] = useState<Preferences>({ theme: 'dark', fontSize: 14, wordWrap: true, viewMode: 'split', previewSync: true, split: 50 })
  const [settingsLoaded, setSettingsLoaded] = useState(false)
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [editorLine, setEditorLine] = useState(1)
  const [previewLine, setPreviewLine] = useState<number>()
  const [message, setMessage] = useState('')
  const keyChordRef = useRef(false)
  const promptedChangesRef = useRef(new Set<string>())
  const settingsButtonRef = useRef<HTMLButtonElement>(null)
  const settingsPopoverRef = useRef<HTMLElement>(null)
  const documentsRef = useRef(documents)
  documentsRef.current = documents

  const active = documents.find((document) => document.id === activeID) ?? documents[0]
  const previewSource = useDebounced(active?.content ?? '', 100)
  const persistedSplit = useDebounced(splitPercent, 300)
  const anyDirty = documents.some(isDirty)

  useEffect(() => { void native.setDirty(anyDirty) }, [anyDirty])

  useEffect(() => {
    void native.getPreferences().then((loaded) => {
      setPreferences(loaded)
      setViewMode(loaded.viewMode)
      setSplitPercent(Math.min(75, Math.max(25, loaded.split)))
      setSettingsLoaded(true)
    }).catch(() => setSettingsLoaded(true))
  }, [])

  useEffect(() => {
    if (!settingsLoaded) return
    void native.savePreferences({ ...preferences, viewMode, split: persistedSplit })
  }, [preferences, settingsLoaded, persistedSplit, viewMode])

  useEffect(() => {
    if (!settingsOpen) return
    const closeSettings = (event: PointerEvent) => {
      if (!(event.target instanceof Node)) return
      if (settingsPopoverRef.current?.contains(event.target) || settingsButtonRef.current?.contains(event.target)) return
      setSettingsOpen(false)
    }
    document.addEventListener('pointerdown', closeSettings, true)
    return () => document.removeEventListener('pointerdown', closeSettings, true)
  }, [settingsOpen])

  useEffect(() => {
    let mounted = true
    void native.initialFile().then((file) => {
      if (!mounted || !file) return
      const document = documentFromFile(file)
      setDocuments([document])
      setActiveID(document.id)
    }).catch((error: unknown) => setMessage(error instanceof Error ? error.message : String(error)))
    return () => { mounted = false }
  }, [])

  const addFile = useCallback((file: MarkdownFile) => {
    const existing = documentsRef.current.find((document) => document.path && document.path.toLocaleLowerCase() === file.path.toLocaleLowerCase())
    if (existing) {
      setActiveID(existing.id)
      return
    }
    const document = documentFromFile(file)
    setDocuments((current) => [...current, document])
    setActiveID(document.id)
  }, [])

  useEffect(() => {
    const consume = (item: DroppedItem) => {
      if (item.kind === 'file') addFile(item.file)
      else setMessage(item.message)
    }
    const onDrop = (event: Event) => consume((event as CustomEvent<DroppedItem>).detail)
    window.addEventListener('symmd-drop', onDrop)
    window.__symmdDropHandlerReady = true
    window.__symmdDropQueue?.splice(0).forEach(consume)
    void native.reportRuntimeEvent('react-ready', `url=${window.location.href} stylesheets=${document.styleSheets.length}`)
    return () => {
      window.__symmdDropHandlerReady = false
      window.removeEventListener('symmd-drop', onDrop)
    }
  }, [addFile])

  const openFile = async () => {
    try {
      const file = await native.openFile()
      if (file) addFile(file)
    } catch (error) { setMessage(error instanceof Error ? error.message : String(error)) }
  }

  const saveDocument = async (document: DocumentState, saveAs = false): Promise<boolean> => {
    try {
      const file = !document.path || saveAs
        ? await native.saveFileAs(document.content)
        : await native.saveFile(document.path, document.content)
      if (!file) return false
      setDocuments((current) => current.map((item) => item.id === document.id
        ? { ...item, ...file, savedContent: file.content }
        : item))
      setMessage(`Saved ${file.name}`)
      return true
    } catch (error) {
      setMessage(error instanceof Error ? error.message : String(error))
      return false
    }
  }

  const closeDocument = async (id: string) => {
    const index = documentsRef.current.findIndex((document) => document.id === id)
    if (index < 0) return
    const document = documentsRef.current[index]
    if (isDirty(document) && !await native.confirmDiscard(document.name)) return
    const remaining = documentsRef.current.filter((item) => item.id !== id)
    const nextDocuments = remaining.length ? remaining : [newDocument()]
    setDocuments(nextDocuments)
    if (activeID === id) {
      setActiveID(nextDocuments[Math.min(index, nextDocuments.length - 1)].id)
    }
  }

  useEffect(() => {
    const saveAndClose = async () => {
      for (const document of documentsRef.current) {
        if (isDirty(document) && !await saveDocument(document)) return
      }
      await window.CloseAfterSave()
    }
    window.addEventListener('symmd-save-and-close', saveAndClose)
    return () => window.removeEventListener('symmd-save-and-close', saveAndClose)
  }, [])

  useEffect(() => {
    const timer = window.setInterval(() => {
      for (const document of documentsRef.current) {
        if (!document.path || promptedChangesRef.current.has(document.path)) continue
        void native.checkFile(document.path).then(async (state) => {
          if (!state.exists || !document.modifiedNs || state.modifiedNs === document.modifiedNs) return
          promptedChangesRef.current.add(document.path)
          const reload = await native.confirmReload(document.name)
          if (reload) {
            const file = await native.readFile(document.path)
            setDocuments((current) => current.map((item) => item.id === document.id ? { ...item, ...file, savedContent: file.content } : item))
          } else {
            setDocuments((current) => current.map((item) => item.id === document.id ? { ...item, modifiedNs: state.modifiedNs } : item))
          }
          window.setTimeout(() => promptedChangesRef.current.delete(document.path), 1500)
        }).catch(() => undefined)
      }
    }, 1800)
    return () => window.clearInterval(timer)
  }, [])

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      const key = event.key.toLowerCase()
      if (keyChordRef.current) {
        keyChordRef.current = false
        if (key === 'v') { event.preventDefault(); setViewMode('split') }
        return
      }
      if (event.ctrlKey && key === 'k') { keyChordRef.current = true; return }
      if (!event.ctrlKey) return
      if (key === 'n') { event.preventDefault(); const document = newDocument(); setDocuments((current) => [...current, document]); setActiveID(document.id) }
      else if (key === 'o') { event.preventDefault(); void openFile() }
      else if (key === 's') { event.preventDefault(); if (active) void saveDocument(active, event.shiftKey) }
      else if (event.shiftKey && key === 'v') { event.preventDefault(); setViewMode('preview') }
    }
    window.addEventListener('keydown', onKeyDown, true)
    return () => window.removeEventListener('keydown', onKeyDown, true)
  }, [active])

  useEffect(() => {
    setEditorLine(1)
    setPreviewLine(undefined)
  }, [activeID])

  if (!active) return null

  const updateActiveContent = (content: string) => {
    void native.setDirty(true)
    setDocuments((current) => current.map((document) => document.id === active.id ? { ...document, content } : document))
  }

  const beginSplitterDrag = (event: ReactPointerEvent<HTMLDivElement>) => {
    event.currentTarget.setPointerCapture(event.pointerId)
    const container = event.currentTarget.parentElement
    if (!container) return
    const move = (moveEvent: PointerEvent) => {
      const bounds = container.getBoundingClientRect()
      setSplitPercent(Math.min(75, Math.max(25, ((moveEvent.clientX - bounds.left) / bounds.width) * 100)))
    }
    const stop = () => { window.removeEventListener('pointermove', move); window.removeEventListener('pointerup', stop) }
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', stop)
  }

  return (
    <div
      className={`window-root theme-${preferences.theme}`}
      onDragEnter={(event) => { event.preventDefault(); event.dataTransfer.dropEffect = 'copy' }}
      onDragOver={(event) => { event.preventDefault(); event.dataTransfer.dropEffect = 'copy' }}
      onDrop={(event) => {
        if (event.defaultPrevented) return
        event.preventDefault()
        for (const file of event.dataTransfer.files) {
          if (!/\.(md|markdown)$/i.test(file.name)) {
            setMessage(`Unsupported file: ${file.name}. Only Markdown files can be opened.`)
            continue
          }
          void file.text()
            .then((content) => addFile({ path: '', name: file.name, content, modifiedNs: 0 }))
            .catch((error: unknown) => setMessage(`Could not read ${file.name}: ${error instanceof Error ? error.message : String(error)}`))
        }
      }}
    >
      {resizeHandles.map(([edge, hit]) => <div key={edge} className={`resize-handle resize-handle--${edge}`} onPointerDown={(event) => { event.preventDefault(); void window.WindowResize(hit) }} />)}
      <header className="titlebar" onPointerDown={(event) => { if (event.button === 0) void window.WindowDrag() }}>
        <span className="titlebar__name">Symmd</span>
        <nav className="titlebar__menu" onPointerDown={(event) => event.stopPropagation()}>
          <button onClick={() => void openFile()}>Open</button>
          <button onClick={() => void saveDocument(active)}>Save</button>
          <button onClick={() => void saveDocument(active, true)}>Save As</button>
          <button ref={settingsButtonRef} aria-label="Settings" onClick={() => setSettingsOpen((open) => !open)}>⚙</button>
        </nav>
        <div className="titlebar__controls" onPointerDown={(event) => event.stopPropagation()}>
          <button aria-label="Minimize" onClick={() => void window.WindowMinimize()}>—</button>
          <button aria-label="Maximize or restore" onClick={() => void window.WindowToggleMaximize()}>□</button>
          <button className="close-button" aria-label="Close" onClick={() => void window.WindowClose()}>×</button>
        </div>
      </header>
      {settingsOpen && (
        <aside ref={settingsPopoverRef} className="settings-popover" onPointerDown={(event) => event.stopPropagation()}>
          <label>Theme<select value={preferences.theme} onChange={(event) => setPreferences((current) => ({ ...current, theme: event.target.value as Preferences['theme'] }))}><option value="dark">Dark+</option><option value="light">Light+</option></select></label>
          <label>Editor font size<input type="number" min="10" max="32" value={preferences.fontSize} onChange={(event) => setPreferences((current) => ({ ...current, fontSize: Math.min(32, Math.max(10, Number(event.target.value))) }))} /></label>
          <label><input type="checkbox" checked={preferences.wordWrap} onChange={(event) => setPreferences((current) => ({ ...current, wordWrap: event.target.checked }))} /> Word wrap</label>
          <label><input type="checkbox" checked={preferences.previewSync} onChange={(event) => setPreferences((current) => ({ ...current, previewSync: event.target.checked }))} /> Preview scroll sync</label>
        </aside>
      )}
      <div className="tabs" role="tablist">
        <div className="tabs__documents">
          {documents.map((document) => (
            <button className={`tab ${document.id === active.id ? 'tab--active' : ''}`} key={document.id} role="tab" onClick={() => setActiveID(document.id)}>
              <span>{document.name}{isDirty(document) ? ' ●' : ''}</span>
              <span className="tab__close" role="button" aria-label={`Close ${document.name}`} onClick={(event) => { event.stopPropagation(); void closeDocument(document.id) }}>×</span>
            </button>
          ))}
        </div>
        <button className="tabs__new" aria-label="New document" onClick={() => { const document = newDocument(); setDocuments((current) => [...current, document]); setActiveID(document.id) }}>+</button>
        <div className="view-switcher">
          <button className={viewMode === 'editor' ? 'active' : ''} onClick={() => setViewMode('editor')}>Editor</button>
          <button className={viewMode === 'split' ? 'active' : ''} onClick={() => setViewMode('split')}>Split</button>
          <button className={viewMode === 'preview' ? 'active' : ''} onClick={() => setViewMode('preview')}>Preview</button>
        </div>
      </div>
      <main className={`workspace workspace--${viewMode}`}>
        {viewMode !== 'preview' && <section className="editor-pane" style={viewMode === 'split' ? { width: `${splitPercent}%` } : undefined}><MarkdownEditor value={active.content} onChange={updateActiveContent} onScrollLine={setEditorLine} revealLine={preferences.previewSync ? previewLine : undefined} theme={preferences.theme} fontSize={preferences.fontSize} wordWrap={preferences.wordWrap} /></section>}
        {viewMode === 'split' && <div className="splitter" role="separator" aria-orientation="vertical" onPointerDown={beginSplitterDrag} />}
        {viewMode !== 'editor' && <section className="preview-pane"><MarkdownPreview source={previewSource} documentPath={active.path} sourceLine={editorLine} onSourceLine={setPreviewLine} onOpenDocument={addFile} onError={setMessage} syncEnabled={preferences.previewSync} theme={preferences.theme} /></section>}
      </main>
      <footer className="statusbar"><span>{message || (active.path || 'Unsaved document')}</span><span>Markdown · UTF-8</span></footer>
    </div>
  )
}
