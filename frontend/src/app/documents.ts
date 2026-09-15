import type { MarkdownFile } from '../bridge/native'

export interface DocumentState extends MarkdownFile {
  id: string
  savedContent: string
}

export function activeDocument(documents: DocumentState[], activeID: string): DocumentState | undefined {
  return documents.find((document) => document.id === activeID) ?? documents[0]
}

export function isDirty(document: DocumentState): boolean {
  return document.content !== document.savedContent
}

export function requiresSaveAs(document: DocumentState, requested: boolean): boolean {
  return !document.path || requested
}

export function applySavedFile(documents: DocumentState[], id: string, file: MarkdownFile): DocumentState[] {
  return documents.map((document) => document.id === id ? { ...document, ...file, savedContent: file.content } : document)
}
