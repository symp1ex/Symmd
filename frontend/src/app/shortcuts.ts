export type ActivePane = 'editor' | 'preview'

export type ShortcutCommand =
  | 'new-document'
  | 'open-document'
  | 'save'
  | 'save-as'
  | 'show-split'
  | 'show-preview'
  | 'monaco-find'
  | 'monaco-replace'
  | 'monaco-find-next'
  | 'monaco-find-previous'
  | 'browser-find'
  | 'browser-find-next'
  | 'browser-find-previous'

export interface ShortcutKey {
  code: string
  ctrlKey: boolean
  shiftKey: boolean
  altKey: boolean
  metaKey: boolean
  isComposing: boolean
}

export interface ShortcutMatch {
  command?: ShortcutCommand
  chordPending: boolean
  preventDefault: boolean
}

export function matchShortcut(event: ShortcutKey, activePane: ActivePane, chordPending: boolean): ShortcutMatch {
  if (event.isComposing || event.altKey || event.metaKey) return { chordPending: false, preventDefault: false }

  if (chordPending) {
    return event.code === 'KeyV'
      ? { command: 'show-split', chordPending: false, preventDefault: true }
      : { chordPending: false, preventDefault: false }
  }

  if (event.ctrlKey && event.code === 'KeyK') return { chordPending: true, preventDefault: true }

  if (event.ctrlKey) {
    if (event.code === 'KeyF') {
      return { command: activePane === 'editor' ? 'monaco-find' : 'browser-find', chordPending: false, preventDefault: activePane === 'editor' }
    }
    if (event.code === 'KeyH' && activePane === 'editor') return { command: 'monaco-replace', chordPending: false, preventDefault: true }
    if (event.code === 'KeyN') return { command: 'new-document', chordPending: false, preventDefault: true }
    if (event.code === 'KeyO') return { command: 'open-document', chordPending: false, preventDefault: true }
    if (event.code === 'KeyS') return { command: event.shiftKey ? 'save-as' : 'save', chordPending: false, preventDefault: true }
    if (event.shiftKey && event.code === 'KeyV') return { command: 'show-preview', chordPending: false, preventDefault: true }
  }

  if (event.code === 'F3') {
    const command = activePane === 'editor'
      ? event.shiftKey ? 'monaco-find-previous' : 'monaco-find-next'
      : event.shiftKey ? 'browser-find-previous' : 'browser-find-next'
    return { command, chordPending: false, preventDefault: activePane === 'editor' }
  }

  return { chordPending: false, preventDefault: false }
}
