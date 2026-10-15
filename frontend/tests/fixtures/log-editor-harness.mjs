// A public-API Monaco double. Tests execute the component's actual listeners,
// async queue and window loader, rather than matching their source text.
import { CursorMoveCommands } from 'monaco-editor/esm/vs/editor/common/cursor/cursorMoveCommands.js'
import { Range } from 'monaco-editor/esm/vs/editor/common/core/range.js'
import { Selection } from 'monaco-editor/esm/vs/editor/common/core/selection.js'
export { Range, Selection }
export const runtime = { effects: [], cleanups: [], refs: [], index: 0, instance: undefined }
export function forwardRef(component) { return component }
export function useRef(value) { const index = runtime.index++; return runtime.refs[index] ??= { current: value } }
export function useImperativeHandle(ref, create) { ref.current = create() }
export function useEffect(effect) { runtime.effects.push(effect) }
export function mount(host) {
  runtime.refs = [{ current: host }]; runtime.index = 0; runtime.effects = []; runtime.cleanups = []
}
export function start() { runtime.cleanups = runtime.effects.map((effect) => effect()).filter(Boolean) }
export function dispose() { for (const cleanup of runtime.cleanups) cleanup() }

export function editorTheme(theme) { return theme }
export const editor = {
  EditorOption: { readOnly: 'readOnly' }, ScrollType: { Immediate: 1 }, EndOfLineSequence: { LF: 0 },
  setTheme() {},
  create() {
    let value = ''
    const callbacks = {}
    const instance = {
      position: { lineNumber: 1, column: 1 }, selection: Selection.fromPositions({ lineNumber: 1, column: 1 }),
      top: 0, left: 0, height: 200, readOnly: true, centered: 0, focused: 0, wrappedColumns: 0,
      getModel: () => model,
      getValue: () => value,
      getPosition() { return this.position },
      getSelection() { return this.selection },
      getScrollTop() { return this.top }, getScrollLeft() { return this.left },
      getScrollHeight() { return this.getTopForPosition(model.getLineCount(), model.getLineMaxColumn(model.getLineCount())) + 20 },
      getLayoutInfo() { return { height: this.height, contentLeft: 0 } },
      getTopForPosition(lineNumber, column) {
        let rows = 0
        const lines = value.split('\n')
        for (let i = 0; i < lineNumber - 1; i++) rows += this.wrappedColumns ? Math.max(1, Math.ceil((lines[i].length + 1) / this.wrappedColumns)) : 1
        return (rows + (this.wrappedColumns ? Math.floor((column - 1) / this.wrappedColumns) : 0)) * 20
      },
      visiblePosition() {
        const row = Math.floor(this.top / 20)
        let rows = 0
        const lines = value.split('\n')
        for (let line = 0; line < lines.length; line++) {
          const count = this.wrappedColumns ? Math.max(1, Math.ceil((lines[line].length + 1) / this.wrappedColumns)) : 1
          if (rows + count > row) return { lineNumber: line + 1, column: this.wrappedColumns ? (row - rows) * this.wrappedColumns + 1 : 1 }
          rows += count
        }
        return model.getPositionAt(value.length)
      },
      getTargetAtClientPoint() { return { position: this.visiblePosition() } },
      getVisibleRanges() { return [Range.fromPositions(this.visiblePosition())] },
      setScrollPosition({ scrollTop = this.top, scrollLeft = this.left }) { this.top = Math.max(0, scrollTop); this.left = scrollLeft; callbacks.scroll?.({ scrollTopChanged: true }) },
      setPosition(position) { this.position = position; this.selection = Selection.fromPositions(position); callbacks.cursor?.({ position }) },
      setSelection(selection) { this.selection = selection instanceof Selection ? selection : Selection.fromPositions(selection.getStartPosition(), selection.getEndPosition()); this.position = this.selection.getPosition(); callbacks.cursor?.({ position: this.position }) },
      revealRangeInCenter() { this.centered++ }, revealPositionInCenter() { this.centered++ },
      updateOptions(options) { if ('readOnly' in options) this.readOnly = options.readOnly },
      getOption() { return this.readOnly }, focus() { this.focused++ },
      trigger(_source, action) {
        if (action !== 'editor.action.selectAll') throw new Error(`Unsupported action: ${action}`)
        // Use the installed Monaco implementation: anchor at model start, active
        // end at model end, no reveal/scroll. Selection is current before cursor events.
        const state = CursorMoveCommands.selectAll({ model })
        this.setSelection(Selection.fromPositions(state.modelState.selection.getSelectionStart(), state.modelState.position))
      },
      dispose() {},
      scrollTo(top, left = this.left) { this.top = top; this.left = left; callbacks.scroll?.({ scrollTopChanged: true }) },
      change(start, length, text) {
        value = value.slice(0, start) + text + value.slice(start + length)
        callbacks.content?.({ changes: [{ rangeOffset: start, rangeLength: length, text }] })
      },
    }
    const model = {
      getValue: () => value,
      setValue(text) { value = text.replace(/\r\n?/g, '\n'); callbacks.content?.({ changes: [] }); instance.setPosition({ lineNumber: 1, column: 1 }); callbacks.scroll?.({ scrollTopChanged: true }) },
      setEOL() {}, getValueLength: () => value.length,
      getLineCount: () => value.split('\n').length,
      getLineMaxColumn: (line) => (value.split('\n')[line - 1]?.length ?? 0) + 1,
      getOffsetAt({ lineNumber, column }) { const lines = value.split('\n'); return lines.slice(0, lineNumber - 1).reduce((sum, line) => sum + line.length + 1, 0) + column - 1 },
      getPositionAt(index) { const lines = value.slice(0, index).split('\n'); return { lineNumber: lines.length, column: lines.at(-1).length + 1 } },
    }
    for (const [name, key] of [['onDidChangeModelContent', 'content'], ['onDidChangeCursorPosition', 'cursor'], ['onDidScrollChange', 'scroll']]) {
      instance[name] = (callback) => { callbacks[key] = callback; return { dispose: () => { delete callbacks[key] } } }
    }
    runtime.instance = instance
    return instance
  },
}
