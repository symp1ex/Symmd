import type { LogChunk, LogLine } from '../bridge/native'

export function visibleLogLines<T>(lines: T[], scrollTop: number, height: number, rowHeight: number) {
  const first = Math.max(0, Math.floor(scrollTop / rowHeight) - 4)
  return { first, visible: lines.slice(first, first + Math.ceil(height / rowHeight) + 8) }
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
