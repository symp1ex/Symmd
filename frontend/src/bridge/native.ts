export interface MarkdownFile {
  path: string
  name: string
  content: string
  modifiedNs: number
}

export interface FileState { exists: boolean; modifiedNs: number }
export interface Preferences {
  theme: 'dark' | 'light'
  fontSize: number
  wordWrap: boolean
  viewMode: 'editor' | 'split' | 'preview'
  previewSync: boolean
  previewZoom: number
  split: number
}

export type DroppedItem =
  | { kind: 'file'; file: MarkdownFile }
  | { kind: 'error'; message: string }

declare global {
  interface Window {
    __symmdDropQueue?: DroppedItem[]
    __symmdDropHandlerReady?: boolean
    ReportRuntimeEvent(kind: string, detail: string): Promise<void>
    GetInitialFile(): Promise<MarkdownFile | null>
    OpenFile(): Promise<MarkdownFile | null>
    ReadFile(path: string): Promise<MarkdownFile>
    SaveFile(path: string, content: string): Promise<MarkdownFile>
    SaveFileAs(content: string): Promise<MarkdownFile | null>
    CheckFile(path: string): Promise<FileState>
    ResolveResource(documentPath: string, reference: string): Promise<string>
    OpenLink(documentPath: string, reference: string): Promise<MarkdownFile | null>
    ConfirmDiscard(name: string): Promise<boolean>
    ConfirmReload(name: string): Promise<boolean>
    GetPreferences(): Promise<Preferences>
    SavePreferences(preferences: Preferences): Promise<void>
    SetDirty(dirty: boolean): Promise<void>
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
  initialFile: () => window.GetInitialFile(),
  openFile: () => window.OpenFile(),
  readFile: (path: string) => window.ReadFile(path),
  saveFile: (path: string, content: string) => window.SaveFile(path, content),
  saveFileAs: (content: string) => window.SaveFileAs(content),
  checkFile: (path: string) => window.CheckFile(path),
  resolveResource: (documentPath: string, reference: string) => window.ResolveResource(documentPath, reference),
  openLink: (documentPath: string, reference: string) => window.OpenLink(documentPath, reference),
  confirmDiscard: (name: string) => window.ConfirmDiscard(name),
  confirmReload: (name: string) => window.ConfirmReload(name),
  getPreferences: () => window.GetPreferences(),
  savePreferences: (preferences: Preferences) => window.SavePreferences(preferences),
  setDirty: (dirty: boolean) => window.SetDirty(dirty),
}
