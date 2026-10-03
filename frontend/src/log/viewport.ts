import type { LogChunk, LogLine } from '../bridge/native'

export function visibleLogLines<T>(lines: T[], scrollTop: number, height: number, rowHeight: number) {
  const first = Math.max(0, Math.floor(scrollTop / rowHeight) - 4)
  return { first, visible: lines.slice(first, first + Math.ceil(height / rowHeight) + 8) }
}

export function visibleLogOffset(rows: VisualLogRow[], scrollTop: number, rowHeight: number, fallback: number) {
  return rows[Math.floor(scrollTop / rowHeight)]?.line.offset ?? fallback
}

export function logGutterWidth(size: number, charWidth: number) {
  return size.toLocaleString().length * charWidth + 10
}

export function utf8ByteOffsetToStringIndex(text: string, byteOffset: number): number | undefined {
  let bytes = 0
  for (let index = 0; index < text.length;) {
    if (bytes === byteOffset) return index
    const codePoint = text.codePointAt(index)!
    bytes += codePoint < 0x80 ? 1 : codePoint < 0x800 ? 2 : codePoint < 0x10000 ? 3 : 4
    index += codePoint > 0xffff ? 2 : 1
  }
  return bytes === byteOffset ? text.length : undefined
}

export interface LogTextMatch { start: number; end: number; selected: boolean }

export function logTextMatches(line: LogLine, query: string, selectedOffset?: number): LogTextMatch[] {
  if (!query) return []
  const selectedIndex = selectedOffset !== undefined && selectedOffset >= line.offset && selectedOffset < line.next
    ? utf8ByteOffsetToStringIndex(line.text, selectedOffset - line.offset) : undefined
  const matches: LogTextMatch[] = []
  const pattern = new RegExp(query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'giu')
  for (let match = pattern.exec(line.text); match && matches.length < 256; match = pattern.exec(line.text)) {
    matches.push({ start: match.index, end: match.index + match[0].length, selected: match.index === selectedIndex })
    pattern.lastIndex = match.index + (line.text.codePointAt(match.index)! > 0xffff ? 2 : 1)
  }
  if (selectedIndex !== undefined && !matches.some((match) => match.selected)) {
    pattern.lastIndex = selectedIndex
    const match = pattern.exec(line.text)
    if (match?.index === selectedIndex) {
      matches.push({ start: selectedIndex, end: selectedIndex + match[0].length, selected: true })
      matches.sort((left, right) => left.start - right.start)
    }
  }
  return matches
}

// A long native line is at most 16 KiB. Keep its visual row count bounded too;
// the remainder stays selectable in one horizontally scrollable row.
export const maxWrappedRows = 64

export interface VisualLogRow { line: LogLine; text: string; start: number; part: number; overflow: boolean; last: boolean }

export function visualLogRows(lines: LogLine[], wordWrap: boolean, columns: number): VisualLogRow[] {
  const rows: VisualLogRow[] = []
  const width = Math.max(1, columns)
  for (const line of lines) {
    if (!wordWrap) { rows.push({ line, text: line.text, start: 0, part: 0, overflow: false, last: true }); continue }
    let start = 0
    let part = 0
    while (line.text.length - start > width && part < maxWrappedRows - 1) {
      let end = start + width
      if (end < line.text.length && line.text.charCodeAt(end - 1) >= 0xd800 && line.text.charCodeAt(end - 1) <= 0xdbff && line.text.charCodeAt(end) >= 0xdc00 && line.text.charCodeAt(end) <= 0xdfff) {
        end += end === start + 1 ? 1 : -1
      }
      const space = line.text.lastIndexOf(' ', end)
      if (space > start) end = space + 1
      rows.push({ line, text: line.text.slice(start, end), start, part: part++, overflow: false, last: false })
      start = end
    }
    rows.push({ line, text: line.text.slice(start), start, part, overflow: line.text.length - start > width, last: true })
  }
  return rows
}

export function appendLogChunk(current: LogChunk, next: LogChunk, limit = 240) {
  const added = next.lines.filter((line) => line.offset >= current.next)
  const all = [...current.lines, ...added]
  const removed = Math.max(0, all.length - limit)
  return { chunk: { ...next, lines: all.slice(removed) }, dropped: all.slice(0, removed) }
}

export function prependLogChunk(current: LogChunk, previous: LogChunk, limit = 240) {
  const firstOffset = current.lines[0]?.offset ?? current.next
  const added = previous.lines.filter((line) => line.next <= firstOffset)
  const lines = [...added, ...current.lines].slice(0, limit)
  return { chunk: { ...current, lines, next: lines.at(-1)?.next ?? current.next }, added: added.length }
}
