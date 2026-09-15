import mermaid from 'mermaid'
import type { MermaidConfig, RenderResult } from 'mermaid'

type PreviewTheme = 'dark' | 'light'
type DiagramRenderer = (source: string, theme: PreviewTheme, renderWidth: number) => Promise<RenderResult>
type MermaidRenderer = Pick<typeof mermaid, 'initialize' | 'render'>

const renderCache = new Map<string, Promise<RenderResult>>()
const maxCachedRenders = 50
let nextDiagramID = 0
let renderQueue = Promise.resolve()

export function mermaidConfiguration(theme: PreviewTheme): MermaidConfig {
  return {
    securityLevel: 'strict',
    startOnLoad: false,
    suppressErrorRendering: true,
    theme: theme === 'dark' ? 'dark' : 'default',
  }
}

export function normalizeMermaidSource(source: string): string {
  let declarationStart = 0
  const frontMatter = source.match(/^([^\S\n\r]*)-{3}\s*[\n\r](.*?)[\n\r]\1-{3}\s*[\n\r]+/s)
  if (frontMatter) declarationStart = frontMatter[0].length

  while (declarationStart < source.length) {
    const whitespace = source.slice(declarationStart).match(/^\s+/)?.[0]
    if (whitespace) declarationStart += whitespace.length
    if (source.startsWith('%%{', declarationStart)) {
      const directiveEnd = source.indexOf('}%%', declarationStart + 3)
      if (directiveEnd < 0) return source
      declarationStart = directiveEnd + 3
      continue
    }
    if (source.startsWith('%%', declarationStart)) {
      const lineEnd = source.indexOf('\n', declarationStart + 2)
      if (lineEnd < 0) return source
      declarationStart = lineEnd + 1
      continue
    }
    break
  }

  if (!source.startsWith('gitgraph', declarationStart) || !/\s|$/.test(source[declarationStart + 8] ?? '')) return source
  return `${source.slice(0, declarationStart)}gitGraph${source.slice(declarationStart + 8)}`
}

export async function renderDiagram(
  source: string,
  theme: PreviewTheme,
  renderWidth: number,
  renderer: MermaidRenderer = mermaid,
): Promise<RenderResult> {
  const operation = renderQueue.then(async () => {
    renderer.initialize(mermaidConfiguration(theme))
    const temporaryContainer = document.createElement('div')
    temporaryContainer.style.position = 'absolute'
    temporaryContainer.style.left = '-10000px'
    temporaryContainer.style.visibility = 'hidden'
    temporaryContainer.style.width = `${renderWidth}px`
    temporaryContainer.dataset.symmdMermaidRenderHost = ''
    document.body.appendChild(temporaryContainer)
    try {
      return await renderer.render(`symmd-mermaid-${++nextDiagramID}`, source, temporaryContainer)
    } finally {
      temporaryContainer.remove()
    }
  })
  renderQueue = operation.then(() => undefined, () => undefined)
  return operation
}

function cachedRender(key: string, source: string, theme: PreviewTheme, renderWidth: number, renderer: DiagramRenderer): Promise<RenderResult> {
  const existing = renderCache.get(key)
  if (existing) {
    renderCache.delete(key)
    renderCache.set(key, existing)
    return existing
  }

  if (renderCache.size >= maxCachedRenders) {
    const oldest = renderCache.keys().next().value
    if (oldest !== undefined) renderCache.delete(oldest)
  }
  const rendered = renderer(source, theme, renderWidth)
  renderCache.set(key, rendered)
  void rendered.catch(() => {
    if (renderCache.get(key) === rendered) renderCache.delete(key)
  })
  return rendered
}

function showError(container: HTMLElement, source: string, error: unknown): void {
  const message = container.ownerDocument.createElement('p')
  message.className = 'mermaid-diagram__error'
  message.textContent = `Could not render Mermaid diagram: ${error instanceof Error ? error.message : String(error)}`
  const sourceBlock = container.ownerDocument.createElement('pre')
  sourceBlock.className = 'mermaid-diagram__source'
  sourceBlock.textContent = source
  container.classList.add('mermaid-diagram--error')
  container.replaceChildren(message, sourceBlock)
}

export async function renderMermaidBlocks(
  host: ParentNode,
  theme: PreviewTheme,
  isCancelled: () => boolean,
  renderer: DiagramRenderer = renderDiagram,
): Promise<void> {
  const occurrences = new Map<string, number>()
  const containers = [...host.querySelectorAll<HTMLElement>('.mermaid-diagram[data-mermaid-source]')]
  await Promise.all(containers.map(async (container) => {
    const source = container.dataset.mermaidSource ?? ''
    const renderWidth = container.offsetWidth
    if (renderWidth <= 0) return
    const occurrence = occurrences.get(source) ?? 0
    occurrences.set(source, occurrence + 1)
    const cacheKey = JSON.stringify([source, theme, renderWidth, occurrence])
    try {
      const result = await cachedRender(cacheKey, normalizeMermaidSource(source), theme, renderWidth, renderer)
      if (isCancelled() || !container.isConnected || container.dataset.mermaidSource !== source) return
      container.classList.remove('mermaid-diagram--error')
      container.innerHTML = result.svg
      result.bindFunctions?.(container)
    } catch (error) {
      if (!isCancelled() && container.isConnected && container.dataset.mermaidSource === source) {
        showError(container, source, error)
      }
    }
  }))
}

export function startMermaidRendering(
  host: HTMLElement,
  theme: PreviewTheme,
  renderer: DiagramRenderer = renderDiagram,
): () => void {
  const containers = [...host.querySelectorAll<HTMLElement>('.mermaid-diagram[data-mermaid-source]')]
  let cancelled = false
  let generation = 0
  let widths = containers.map((container) => container.offsetWidth)
  const render = () => {
    const currentGeneration = ++generation
    void renderMermaidBlocks(host, theme, () => cancelled || currentGeneration !== generation, renderer)
  }
  const renderIfWidthChanged = () => {
    if (cancelled) return
    const nextWidths = containers.map((container) => container.offsetWidth)
    if (nextWidths.length === widths.length && nextWidths.every((width, index) => width === widths[index])) return
    widths = nextWidths
    render()
  }

  render()
  const resizeObserver = typeof ResizeObserver === 'undefined' ? undefined : new ResizeObserver(renderIfWidthChanged)
  resizeObserver?.observe(host)
  for (const container of containers) resizeObserver?.observe(container)
  const layoutRoot = host.parentElement?.parentElement
  let mutationObserver: MutationObserver | undefined
  if (typeof MutationObserver !== 'undefined' && layoutRoot) {
    mutationObserver = new MutationObserver(renderIfWidthChanged)
    mutationObserver.observe(layoutRoot, { attributes: true, attributeFilter: ['class', 'style'], subtree: true })
  }
  if (typeof window !== 'undefined') window.addEventListener('resize', renderIfWidthChanged)
  return () => {
    cancelled = true
    generation += 1
    resizeObserver?.disconnect()
    mutationObserver?.disconnect()
    if (typeof window !== 'undefined') window.removeEventListener('resize', renderIfWidthChanged)
  }
}
