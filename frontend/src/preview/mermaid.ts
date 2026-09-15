import mermaid from 'mermaid'
import type { MermaidConfig, RenderResult } from 'mermaid'

type PreviewTheme = 'dark' | 'light'
type DiagramRenderer = (source: string, theme: PreviewTheme) => Promise<RenderResult>

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

async function renderDiagram(source: string, theme: PreviewTheme): Promise<RenderResult> {
  const operation = renderQueue.then(async () => {
    mermaid.initialize(mermaidConfiguration(theme))
    const temporaryContainer = document.createElement('div')
    temporaryContainer.style.position = 'absolute'
    temporaryContainer.style.left = '-10000px'
    document.body.appendChild(temporaryContainer)
    try {
      return await mermaid.render(`symmd-mermaid-${++nextDiagramID}`, source, temporaryContainer)
    } finally {
      temporaryContainer.remove()
    }
  })
  renderQueue = operation.then(() => undefined, () => undefined)
  return operation
}

function cachedRender(key: string, source: string, theme: PreviewTheme, renderer: DiagramRenderer): Promise<RenderResult> {
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
  const rendered = renderer(source, theme)
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
    const occurrence = occurrences.get(source) ?? 0
    occurrences.set(source, occurrence + 1)
    const cacheKey = JSON.stringify([source, theme, occurrence])
    try {
      const result = await cachedRender(cacheKey, source, theme, renderer)
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
