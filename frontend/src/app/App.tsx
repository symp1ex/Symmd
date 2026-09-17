import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { PointerEvent as ReactPointerEvent } from 'react'
import { native, type DroppedItem, type MarkdownFile, type Preferences, type UpdateCheckResult } from '../bridge/native'
import { MarkdownEditor, type MarkdownEditorHandle } from '../editor/MarkdownEditor'
import { MarkdownPreview } from '../preview/MarkdownPreview'
import { defaultPreviewZoom, nextPreviewZoom } from '../preview/zoom'
import { effectiveViewMode, isLogDocument, isSupportedDocumentName, languageForDocument, type ViewMode } from '../editor/languages'
import { activeDocument, applySavedFile, isDirty, requiresSaveAs, type DocumentState } from './documents'
import { matchShortcut, type ActivePane } from './shortcuts'

type UpdateState = 'disabled' | 'idle' | 'checking' | 'available' | 'installing' | 'error'

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
  const [preferences, setPreferences] = useState<Preferences>({ theme: 'dark', fontSize: 14, wordWrap: true, viewMode: 'split', previewSync: true, previewZoom: defaultPreviewZoom, split: 50, autoReloadExternalChanges: false, checkForUpdates: true })
  const [version, setVersion] = useState('')
  const [settingsLoaded, setSettingsLoaded] = useState(false)
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [editorLine, setEditorLine] = useState(1)
  const [previewLine, setPreviewLine] = useState<number>()
  const [message, setMessage] = useState('')
  const [updateState, setUpdateState] = useState<UpdateState>('idle')
  const [updateMessage, setUpdateMessage] = useState('')
  const keyChordRef = useRef(false)
  const promptedChangesRef = useRef(new Set<string>())
  const settingsButtonRef = useRef<HTMLButtonElement>(null)
  const settingsPopoverRef = useRef<HTMLElement>(null)
  const settingsOpenRef = useRef(settingsOpen)
  const markdownEditorRef = useRef<MarkdownEditorHandle>(null)
  const activePaneRef = useRef<ActivePane>('editor')
  const browserFindEnabledRef = useRef(false)
  const documentsRef = useRef(documents)
  const activeIDRef = useRef(activeID)
  const autoReloadExternalChangesRef = useRef(preferences.autoReloadExternalChanges)
  const checkForUpdatesRef = useRef(preferences.checkForUpdates)
  const updateStateRef = useRef<UpdateState>('idle')
  const updateCheckInFlightRef = useRef(false)
  documentsRef.current = documents
  activeIDRef.current = activeID
  autoReloadExternalChangesRef.current = preferences.autoReloadExternalChanges
  checkForUpdatesRef.current = preferences.checkForUpdates
  settingsOpenRef.current = settingsOpen

  const active = activeDocument(documents, activeID)
  const logDocument = active ? isLogDocument(active) : false
  const activeViewMode = active ? effectiveViewMode(active, viewMode) : viewMode
  const previewSource = useDebounced(active?.content ?? '', 100)
  const persistedSplit = useDebounced(splitPercent, 300)
  const anyDirty = documents.some(isDirty)

  const setActivePane = useCallback((pane: ActivePane) => {
    activePaneRef.current = pane
    const browserFindEnabled = pane === 'preview' && !settingsOpenRef.current
    if (browserFindEnabledRef.current === browserFindEnabled) return
    browserFindEnabledRef.current = browserFindEnabled
    void native.setBrowserFindEnabled(browserFindEnabled)
  }, [])

  const setUpdateStateValue = useCallback((nextState: UpdateState) => {
    updateStateRef.current = nextState
    setUpdateState(nextState)
  }, [])

  const applyUpdateCheckResult = useCallback((result: UpdateCheckResult) => {
    updateCheckInFlightRef.current = false
    if (!checkForUpdatesRef.current) {
      setUpdateStateValue('disabled')
      setUpdateMessage('')
      return
    }
    if (result.ok && result.updateAvailable) {
      setUpdateStateValue('available')
      setUpdateMessage('Update available')
      return
    }
    if (!result.ok) {
      setUpdateStateValue('error')
      if (result.message) setUpdateMessage(`Update check: ${result.message}`)
      return
    }
    setUpdateStateValue('idle')
    setUpdateMessage('Application is up to date')
  }, [setUpdateStateValue])

  const runUpdateCheck = useCallback(async (automatic: boolean) => {
    if (!checkForUpdatesRef.current) {
      setUpdateStateValue('disabled')
      setUpdateMessage('')
      return
    }
    const currentState = updateStateRef.current
    if (updateCheckInFlightRef.current || currentState === 'available' || currentState === 'installing') return
    updateCheckInFlightRef.current = true
    setUpdateStateValue('checking')
    setUpdateMessage('Checking for updates')
    try {
      const result = await native.checkApplicationUpdate(automatic)
      if (!result.ok) {
        updateCheckInFlightRef.current = false
        if (result.message === 'updater is disabled') {
          setUpdateStateValue('disabled')
          setUpdateMessage('')
          return
        }
        setUpdateStateValue('error')
        setUpdateMessage(result.message || 'Failed to start update check')
      } else if (!result.started) {
        updateCheckInFlightRef.current = false
        setUpdateStateValue('idle')
        setUpdateMessage('')
      }
    } catch (error) {
      updateCheckInFlightRef.current = false
      setUpdateStateValue('error')
      setUpdateMessage(`Update check failed: ${error instanceof Error ? error.message : String(error)}`)
    }
  }, [setUpdateStateValue])

  const installUpdate = useCallback(async () => {
    if (!checkForUpdatesRef.current || updateStateRef.current !== 'available') return
    setUpdateStateValue('installing')
    try {
      const result = await native.installApplicationUpdate()
      if (!result.ok) {
        setUpdateStateValue('available')
        setUpdateMessage(result.message || 'Failed to start update installation')
        return
      }
      setUpdateMessage('Starting update installation')
    } catch (error) {
      setUpdateStateValue('available')
      setUpdateMessage(`Update installation failed: ${error instanceof Error ? error.message : String(error)}`)
    }
  }, [setUpdateStateValue])

  useEffect(() => { void native.setDirty(anyDirty) }, [anyDirty])

  useEffect(() => {
    void native.version().then(setVersion).catch(() => undefined)
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
    const onApplicationUpdateCheckResult = (event: Event) => {
      const result = (event as CustomEvent<UpdateCheckResult>).detail
      if (result) applyUpdateCheckResult(result)
    }
    window.addEventListener('application-update-check-result', onApplicationUpdateCheckResult)
    return () => window.removeEventListener('application-update-check-result', onApplicationUpdateCheckResult)
  }, [applyUpdateCheckResult])

  useEffect(() => {
    if (!preferences.checkForUpdates) {
      setUpdateStateValue('disabled')
      setUpdateMessage('')
    } else if (updateStateRef.current === 'disabled') {
      setUpdateStateValue('idle')
    }
  }, [preferences.checkForUpdates, setUpdateStateValue])

  useEffect(() => {
    if (settingsOpen && settingsLoaded) void runUpdateCheck(true)
  }, [runUpdateCheck, settingsLoaded, settingsOpen])

  useEffect(() => {
    const handleWheel = (event: WheelEvent) => {
      if (!event.ctrlKey) return
      event.preventDefault()
      if (!(event.target instanceof Element) || !event.target.closest('.markdown-preview')) return
      setPreferences((current) => {
        const previewZoom = nextPreviewZoom(current.previewZoom, event.deltaY)
        return previewZoom === current.previewZoom ? current : { ...current, previewZoom }
      })
    }
    window.addEventListener('wheel', handleWheel, { passive: false })
    return () => window.removeEventListener('wheel', handleWheel)
  }, [])

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
      const file = requiresSaveAs(document, saveAs)
        ? await native.saveFileAs(document.content)
        : await native.saveFile(document.path, document.content)
      if (!file) return false
      setDocuments((current) => applySavedFile(current, document.id, file))
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
          try {
            const currentDocument = documentsRef.current.find((item) => item.id === document.id && item.path === document.path)
            if (!currentDocument) return
            if (autoReloadExternalChangesRef.current) {
              if (isDirty(currentDocument)) {
                setDocuments((current) => current.map((item) => item.id === document.id && item.path === document.path ? { ...item, modifiedNs: state.modifiedNs } : item))
              } else {
                const file = await native.readFile(document.path)
                setDocuments((current) => current.map((item) => {
                  if (item.id !== document.id || item.path !== document.path) return item
                  return isDirty(item) ? { ...item, modifiedNs: file.modifiedNs } : { ...item, ...file, savedContent: file.content }
                }))
              }
            } else {
              const reload = await native.confirmReload(document.name)
              if (reload) {
                const file = await native.readFile(document.path)
                setDocuments((current) => current.map((item) => item.id === document.id ? { ...item, ...file, savedContent: file.content } : item))
              } else {
                setDocuments((current) => current.map((item) => item.id === document.id ? { ...item, modifiedNs: state.modifiedNs } : item))
              }
            }
          } finally {
            window.setTimeout(() => promptedChangesRef.current.delete(document.path), 1500)
          }
        }).catch(() => undefined)
      }
    }, 1800)
    return () => window.clearInterval(timer)
  }, [])

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.target instanceof Element && event.target.closest('.settings-popover') && ['KeyF', 'KeyH', 'F3'].includes(event.code)) return
      const match = matchShortcut(event, activePaneRef.current, keyChordRef.current)
      keyChordRef.current = match.chordPending
      if (match.preventDefault) {
        event.preventDefault()
        event.stopPropagation()
      }
      if (!match.command) return
      if (event.repeat && ['new-document', 'open-document', 'save', 'save-as', 'show-split', 'show-preview'].includes(match.command)) return
      const shortcutActive = activeDocument(documentsRef.current, activeIDRef.current)
      if (match.command === 'new-document') { const document = newDocument(); setDocuments((current) => [...current, document]); setActiveID(document.id) }
      else if (match.command === 'open-document') { void openFile() }
      else if (match.command === 'save' || match.command === 'save-as') { if (shortcutActive) void saveDocument(shortcutActive, match.command === 'save-as') }
      else if (match.command === 'show-split') { if (!shortcutActive || !isLogDocument(shortcutActive)) setViewMode('split') }
      else if (match.command === 'show-preview') { if (!shortcutActive || !isLogDocument(shortcutActive)) setViewMode('preview') }
      else if (match.command === 'monaco-find' || match.command === 'monaco-replace') { markdownEditorRef.current?.showFind(match.command === 'monaco-replace') }
      else if (match.command === 'monaco-find-next' || match.command === 'monaco-find-previous') { markdownEditorRef.current?.findNext(match.command === 'monaco-find-previous') }
    }
    window.addEventListener('keydown', onKeyDown, true)
    return () => window.removeEventListener('keydown', onKeyDown, true)
  }, [])

  useEffect(() => {
    if (activeViewMode === 'editor') setActivePane('editor')
    else if (activeViewMode === 'preview') setActivePane('preview')
  }, [activeViewMode, setActivePane])

  useEffect(() => {
    setActivePane(activePaneRef.current)
  }, [settingsOpen, setActivePane])

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

  const activateVersionAction = () => {
    if (updateState === 'available') {
      void installUpdate()
    } else if (updateState === 'error') {
      setUpdateStateValue('idle')
      void runUpdateCheck(false)
    } else if (updateState === 'idle') {
      void runUpdateCheck(false)
    }
  }
  const versionText = updateState === 'error'
    ? 'Update error'
    : updateState === 'available' || updateState === 'installing'
      ? 'Install update'
      : version
  const versionAriaLabel = updateState === 'error'
    ? 'Retry update check'
    : updateState === 'available' ? 'Install update' : `Application version ${versionText}`
  const updateSpinnerVisible = updateState === 'checking' || updateState === 'installing'

  return (
    <div
      className={`window-root theme-${preferences.theme}`}
      onDragEnter={(event) => { event.preventDefault(); event.dataTransfer.dropEffect = 'copy' }}
      onDragOver={(event) => { event.preventDefault(); event.dataTransfer.dropEffect = 'copy' }}
      onDrop={(event) => {
        if (event.defaultPrevented) return
        event.preventDefault()
        for (const file of event.dataTransfer.files) {
          if (!isSupportedDocumentName(file.name)) {
            setMessage(`Unsupported file: ${file.name}. Only Markdown and log files can be opened.`)
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
        </nav>
        <div className="titlebar__controls" onPointerDown={(event) => event.stopPropagation()}>
          <button
            ref={settingsButtonRef}
            type="button"
            className="titlebar__button titlebar__button--settings"
            aria-label="Settings"
            title="Settings"
            onClick={() => setSettingsOpen((open) => !open)}
          >
            <svg viewBox="0 0 16 16" aria-hidden="true" focusable="false">
              <path d="M6.4 1.5h3.2l.4 1.6 1.4.8 1.5-.6 1.6 2.8-1.1 1.2v1.6l1.1 1.2-1.6 2.8-1.5-.6-1.4.8-.4 1.6H6.4L6 12.9l-1.4-.8-1.5.6-1.6-2.8 1.1-1.2V7.1L1.5 5.9l1.6-2.8 1.5.6L6 2.9l.4-1.4Z" />
              <circle cx="8" cy="8" r="2.1" />
            </svg>
          </button>
          <button
            type="button"
            className="titlebar__button"
            aria-label="Minimize"
            title="Minimize"
            onClick={() => void window.WindowMinimize()}
          >
            <svg viewBox="0 0 16 16" aria-hidden="true" focusable="false">
              <path d="M3.5 8h9" />
            </svg>
          </button>
          <button
            type="button"
            className="titlebar__button titlebar__button--maximize"
            aria-label="Maximize or restore"
            title="Maximize or restore"
            onClick={() => void window.WindowToggleMaximize()}
          >
            <svg viewBox="0 0 16 16" aria-hidden="true" focusable="false">
              <rect x="4" y="4" width="8" height="8" />
            </svg>
          </button>
          <button
            type="button"
            className="titlebar__button titlebar__button--close"
            aria-label="Close"
            title="Close"
            onClick={() => void window.WindowClose()}
          >
            <svg viewBox="0 0 16 16" aria-hidden="true" focusable="false">
              <path d="m4.5 4.5 7 7m0-7-7 7" />
            </svg>
          </button>
        </div>
      </header>
      {settingsOpen && (
        <aside ref={settingsPopoverRef} className="settings-popover" onPointerDown={(event) => event.stopPropagation()}>
          <label>Theme<select value={preferences.theme} onChange={(event) => setPreferences((current) => ({ ...current, theme: event.target.value as Preferences['theme'] }))}><option value="dark">Dark+</option><option value="light">Light+</option></select></label>
          <label>Editor font size<input type="number" min="10" max="32" value={preferences.fontSize} onChange={(event) => setPreferences((current) => ({ ...current, fontSize: Math.min(32, Math.max(10, Number(event.target.value))) }))} /></label>
          <label><input type="checkbox" checked={preferences.wordWrap} onChange={(event) => setPreferences((current) => ({ ...current, wordWrap: event.target.checked }))} /> Word wrap</label>
          <label><input type="checkbox" checked={preferences.previewSync} onChange={(event) => setPreferences((current) => ({ ...current, previewSync: event.target.checked }))} /> Preview scroll sync</label>
          <label><input type="checkbox" checked={preferences.autoReloadExternalChanges} onChange={(event) => setPreferences((current) => ({ ...current, autoReloadExternalChanges: event.target.checked }))} /> Autoreload external changes</label>
          <label><input type="checkbox" checked={preferences.checkForUpdates} onChange={(event) => setPreferences((current) => ({ ...current, checkForUpdates: event.target.checked }))} /> Check for updates</label>
          <footer className="settings-statusbar">
            {versionText && (
              <button
                type="button"
                className={`settings-statusbar__version settings-statusbar__version--${updateState}`}
                aria-label={versionAriaLabel}
                aria-disabled={updateState === 'disabled' || updateState === 'checking' || updateState === 'installing'}
                title={updateMessage || versionAriaLabel}
                onClick={activateVersionAction}
              >
                {versionText}
              </button>
            )}
            {updateSpinnerVisible && <span className="settings-statusbar__spinner" role="status" aria-label={updateState === 'installing' ? 'Starting update installation' : 'Checking for updates'} />}
          </footer>
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
          <button className={activeViewMode === 'editor' ? 'active' : ''} onClick={() => { setActivePane('editor'); setViewMode('editor') }}>Editor</button>
          <button className={activeViewMode === 'split' ? 'active' : ''} disabled={logDocument} title={logDocument ? 'Unavailable for log files' : undefined} onClick={() => setViewMode('split')}>Split</button>
          <button className={activeViewMode === 'preview' ? 'active' : ''} disabled={logDocument} title={logDocument ? 'Unavailable for log files' : undefined} onClick={() => { setActivePane('preview'); setViewMode('preview') }}>Preview</button>
        </div>
      </div>
      <main className={`workspace workspace--${activeViewMode}`}>
        {activeViewMode !== 'preview' && <section className="editor-pane" style={activeViewMode === 'split' ? { width: `${splitPercent}%` } : undefined} onPointerDownCapture={() => setActivePane('editor')} onFocusCapture={() => setActivePane('editor')}><MarkdownEditor ref={markdownEditorRef} value={active.content} onChange={updateActiveContent} onScrollLine={setEditorLine} revealLine={preferences.previewSync ? previewLine : undefined} theme={preferences.theme} fontSize={preferences.fontSize} wordWrap={preferences.wordWrap} language={languageForDocument(active)} /></section>}
        {activeViewMode === 'split' && <div className="splitter" role="separator" aria-orientation="vertical" onPointerDown={beginSplitterDrag} />}
        {activeViewMode !== 'editor' && <section className="preview-pane" onPointerDownCapture={() => setActivePane('preview')} onFocusCapture={() => setActivePane('preview')}><MarkdownPreview source={previewSource} documentPath={active.path} sourceLine={editorLine} onSourceLine={setPreviewLine} onOpenDocument={addFile} onError={setMessage} syncEnabled={preferences.previewSync} theme={preferences.theme} zoom={preferences.previewZoom} /></section>}
      </main>
      <footer className="statusbar"><span>{message || (active.path || 'Unsaved document')}</span><span>{logDocument ? 'Log' : 'Markdown'} · UTF-8</span></footer>
    </div>
  )
}
