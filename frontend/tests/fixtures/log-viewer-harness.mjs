let slots = [], index = 0, effects = [], cleanups = []
export function forwardRef(component) { return component }
export function useRef(current) { return slots[index++] ??= { current } }
export function useState(initial) {
  const at = index++
  const state = slots[at] ??= { value: initial }
  return [state.value, (next) => { state.value = typeof next === 'function' ? next(state.value) : next }]
}
export function useMemo(create) { return create() }
export function useImperativeHandle(ref, create) { ref.current = create() }
export function useLayoutEffect() {}
export function useEffect(effect, dependencies) {
  const at = index++
  const previous = slots[at]
  if (!previous || dependencies.some((value, i) => value !== previous[i])) {
    slots[at] = dependencies
    effects.push(() => { cleanups[at]?.(); cleanups[at] = effect() })
  }
}
export function reset() { slots = []; effects = []; cleanups = [] }
export function render(component, props, ref) { index = 0; const tree = component(props, ref); const pending = effects; effects = []; for (const run of pending) run(); return tree }
export function dispose() { for (const cleanup of cleanups) cleanup?.() }
