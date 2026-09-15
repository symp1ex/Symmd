export function isSaveableLink(documentPath: string, reference: string): boolean {
  if (/^https?:\/\//i.test(reference)) return true
  if (/^[a-z][a-z0-9+.-]*:/i.test(reference)) return false
  if (!documentPath || reference.startsWith('/') || reference.startsWith('\\') || reference.startsWith('//')) return false
  return reference.split(/[?#]/, 1)[0] !== ''
}
