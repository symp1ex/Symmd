import type { LogChunk, LogLine } from '../bridge/native'

export function visibleLogLines(lines: LogLine[], scrollTop: number, height: number, rowHeight: number) {
  const first = Math.max(0, Math.floor(scrollTop / rowHeight) - 4)
  return { first, visible: lines.slice(first, first + Math.ceil(height / rowHeight) + 8) }
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
