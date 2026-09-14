export type DocumentLanguage = 'markdown' | 'log'
export type ViewMode = 'editor' | 'split' | 'preview'

interface DocumentIdentity {
  path: string
  name: string
}

interface LanguageMetadata {
  id: string
  aliases?: readonly string[]
}

const fenceAliases: Readonly<Record<string, string>> = {
  bash: 'shell',
  cmd: 'bat',
}

export function isSupportedDocumentName(name: string): boolean {
  return /\.(?:md|markdown|log)$/i.test(name)
}

export function isLogDocument(document: DocumentIdentity): boolean {
  return /\.log$/i.test(document.path || document.name)
}

export function languageForDocument(document: DocumentIdentity): DocumentLanguage {
  return isLogDocument(document) ? 'log' : 'markdown'
}

export function effectiveViewMode(document: DocumentIdentity, preferred: ViewMode): ViewMode {
  return isLogDocument(document) ? 'editor' : preferred
}

export function resolveRegisteredLanguageID(name: string, registered: readonly LanguageMetadata[]): string | undefined {
  const normalized = name.trim().toLowerCase()
  const requested = fenceAliases[normalized] ?? normalized
  return registered.find((language) =>
    language.id.toLowerCase() === requested
    || language.aliases?.some((alias) => alias.toLowerCase() === requested)
  )?.id
}
