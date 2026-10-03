export interface MarkdownFile {
  path: string
  name: string
  content: string
  modifiedNs: number
}
export interface LogInfo { handle: number; path: string; name: string; size: number; modifiedNs: number; revision: number; dirty: boolean }
export interface LogLine { offset: number; next: number; text: string; truncated: boolean }
export interface LogChunk { lines: LogLine[]; next: number; size: number; revision: number }
export interface LogSearchResult { done: boolean; offset: number; error?: string }
export interface LogCountResult { done: boolean; total: number; ordinal: number; error?: string }
export interface LogWindow { offset: number; text: string; size: number; revision: number; editable: boolean }
export interface LogSaveResult { done: boolean; written: number; total: number; error?: string; info?: LogInfo }

export interface FileState { exists: boolean; modifiedNs: number }
export interface ContextMenuOptions {
  editable: boolean
  hasSelection: boolean
  canSelectAll: boolean
  link: boolean
  canSaveLink: boolean
}
export type ContextMenuCommand = '' | 'cut' | 'copy' | 'paste' | 'selectAll' | 'saveLink' | 'copyLink'
export interface Preferences {
  theme: 'dark' | 'light'
  fontSize: number
  wordWrap: boolean
  viewMode: 'editor' | 'split' | 'preview'
  previewSync: boolean
  previewZoom: number
  split: number
  autoReloadExternalChanges: boolean
  checkForUpdates: boolean
}

export type UpdateCheckStartResult = { ok: boolean; started: boolean; message?: string }
export type UpdateCheckResult = { ok: boolean; updateAvailable: boolean; message?: string }
export type UpdateInstallResult = { ok: boolean; message?: string }

export type DroppedItem =
  | { kind: 'file'; file: MarkdownFile }
  | { kind: 'log' }
  | { kind: 'error'; message: string }

declare global {
  interface Window {
    __symmdDropQueue?: DroppedItem[]
    __symmdDropHandlerReady?: boolean
    ReportRuntimeEvent(kind: string, detail: string): Promise<void>
    GetVersion(): Promise<string>
    GetInitialFile(): Promise<MarkdownFile | null>
    OpenFile(): Promise<MarkdownFile | null>
    ReadFile(path: string): Promise<MarkdownFile>
    OpenLog(path: string): Promise<LogInfo>
    ReadLog(handle: number, offset: number, align: boolean): Promise<LogChunk>
    ReadLogBefore(handle: number, offset: number): Promise<LogChunk>
    ReadLogWindow(handle: number, offset: number): Promise<LogWindow>
    StatLog(handle: number): Promise<LogInfo>
    ReplaceLog(handle: number, start: number, end: number, text: string): Promise<LogInfo>
    UndoLog(handle: number): Promise<LogInfo>
    RedoLog(handle: number): Promise<LogInfo>
    StartLogSave(handle: number, destination: string): Promise<number>
    StartLogSaveAs(handle: number): Promise<number | null>
    PollLogSave(handle: number, id: number): Promise<LogSaveResult>
    CancelLogSave(handle: number, id: number): Promise<void>
    FindLog(handle: number, query: string, offset: number, previous: boolean): Promise<number>
    PollLogSearch(handle: number, id: number): Promise<LogSearchResult>
    CancelLogSearch(handle: number, id: number): Promise<void>
    CountLogMatches(handle: number, query: string): Promise<number>
    PollLogCount(handle: number, id: number, offset: number): Promise<LogCountResult>
    CancelLogCount(handle: number, id: number): Promise<void>
    CloseLog(handle: number): Promise<void>
    SaveFile(path: string, content: string): Promise<MarkdownFile>
    SaveFileAs(content: string): Promise<MarkdownFile | null>
    CheckFile(path: string): Promise<FileState>
    ResolveResource(documentPath: string, reference: string): Promise<string>
    OpenLink(documentPath: string, reference: string): Promise<MarkdownFile | null>
    SaveLinkAs(documentPath: string, reference: string): Promise<void>
    ShowContextMenu(options: ContextMenuOptions): Promise<ContextMenuCommand>
    ConfirmDiscard(name: string): Promise<boolean>
    ConfirmReload(name: string): Promise<boolean>
    GetPreferences(): Promise<Preferences>
    SavePreferences(preferences: Preferences): Promise<void>
    CheckApplicationUpdate(automatic: boolean): Promise<UpdateCheckStartResult>
    InstallApplicationUpdate(): Promise<UpdateInstallResult>
    SetDirty(dirty: boolean): Promise<void>
    SetBrowserFindEnabled(enabled: boolean): Promise<void>
    WindowMinimize(): Promise<void>
    WindowToggleMaximize(): Promise<boolean>
    WindowClose(): Promise<void>
    WindowDrag(): Promise<void>
    WindowResize(hitTest: number): Promise<void>
    CloseAfterSave(): Promise<void>
  }
}

export const native = {
  reportRuntimeEvent: (kind: string, detail: string) => window.ReportRuntimeEvent(kind, detail),
  version: () => window.GetVersion(),
  initialFile: () => window.GetInitialFile(),
  openFile: () => window.OpenFile(),
  readFile: (path: string) => window.ReadFile(path),
  openLog: (path: string) => window.OpenLog(path),
  readLog: (handle: number, offset: number, align = false) => window.ReadLog(handle, offset, align),
  readLogBefore: (handle: number, offset: number) => window.ReadLogBefore(handle, offset),
  readLogWindow: (handle: number, offset: number) => window.ReadLogWindow(handle, offset),
  statLog: (handle: number) => window.StatLog(handle),
  replaceLog: (handle: number, start: number, end: number, text: string) => window.ReplaceLog(handle, start, end, text),
  undoLog: (handle: number) => window.UndoLog(handle),
  redoLog: (handle: number) => window.RedoLog(handle),
  startLogSave: (handle: number) => window.StartLogSave(handle, ''),
  startLogSaveAs: (handle: number) => window.StartLogSaveAs(handle),
  pollLogSave: (handle: number, id: number) => window.PollLogSave(handle, id),
  cancelLogSave: (handle: number, id: number) => window.CancelLogSave(handle, id),
  findLog: (handle: number, query: string, offset: number, previous: boolean) => window.FindLog(handle, query, offset, previous),
  pollLogSearch: (handle: number, id: number) => window.PollLogSearch(handle, id),
  cancelLogSearch: (handle: number, id = 0) => window.CancelLogSearch(handle, id),
  countLogMatches: (handle: number, query: string) => window.CountLogMatches(handle, query),
  pollLogCount: (handle: number, id: number, offset = -1) => window.PollLogCount(handle, id, offset),
  cancelLogCount: (handle: number, id = 0) => window.CancelLogCount(handle, id),
  closeLog: (handle: number) => window.CloseLog(handle),
  saveFile: (path: string, content: string) => window.SaveFile(path, content),
  saveFileAs: (content: string) => window.SaveFileAs(content),
  checkFile: (path: string) => window.CheckFile(path),
  resolveResource: (documentPath: string, reference: string) => window.ResolveResource(documentPath, reference),
  openLink: (documentPath: string, reference: string) => window.OpenLink(documentPath, reference),
  saveLinkAs: (documentPath: string, reference: string) => window.SaveLinkAs(documentPath, reference),
  showContextMenu: (options: ContextMenuOptions) => window.ShowContextMenu(options),
  confirmDiscard: (name: string) => window.ConfirmDiscard(name),
  confirmReload: (name: string) => window.ConfirmReload(name),
  getPreferences: () => window.GetPreferences(),
  savePreferences: (preferences: Preferences) => window.SavePreferences(preferences),
  checkApplicationUpdate: (automatic: boolean) => window.CheckApplicationUpdate(automatic),
  installApplicationUpdate: () => window.InstallApplicationUpdate(),
  setDirty: (dirty: boolean) => window.SetDirty(dirty),
  setBrowserFindEnabled: (enabled: boolean) => window.SetBrowserFindEnabled(enabled),
}
