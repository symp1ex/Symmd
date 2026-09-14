import { useEffect, useMemo, useRef } from 'react'
import { native, type MarkdownFile } from '../bridge/native'
import { renderMarkdown } from '../markdown/render'

interface Props {
  source: string
  documentPath: string
  sourceLine: number
  onSourceLine(line: number): void
  onOpenDocument(file: MarkdownFile): void
  onError(message: string): void
  syncEnabled: boolean
  theme: 'dark' | 'light'
}

export function MarkdownPreview({ source, documentPath, sourceLine, onSourceLine, onOpenDocument, onError, syncEnabled, theme }: Props) {
  const hostRef = useRef<HTMLDivElement>(null)
  const syncingRef = useRef(false)
  const html = useMemo(() => renderMarkdown(source), [source])

  useEffect(() => {
    let cancelled = false
    const host = hostRef.current
    if (!host) return
    for (const image of host.querySelectorAll<HTMLImageElement>('img[data-resource-src]')) {
      const reference = image.dataset.resourceSrc
      if (!reference || !documentPath) continue
      void native.resolveResource(documentPath, reference).then((dataURL) => {
        if (!cancelled && image.isConnected) image.src = dataURL
      }).catch(() => {
        if (!cancelled && image.isConnected) image.alt = `${image.alt} (image unavailable)`
      })
    }
    return () => { cancelled = true }
  }, [documentPath, html])

  useEffect(() => {
    const host = hostRef.current
    if (!host || !syncEnabled || sourceLine < 1) return
    const blocks = [...host.querySelectorAll<HTMLElement>('[data-source-line]')]
    let target = blocks[0]
    for (const block of blocks) {
      if (Number(block.dataset.sourceLine) > sourceLine) break
      target = block
    }
    if (target) {
      syncingRef.current = true
      target.scrollIntoView({ block: 'start' })
      requestAnimationFrame(() => { syncingRef.current = false })
    }
  }, [sourceLine, html, syncEnabled])

  return (
    <article
      className={`markdown-preview markdown-preview--${theme}`}
      ref={hostRef}
      onScroll={(event) => {
        if (syncingRef.current || !syncEnabled) return
        const root = event.currentTarget
        const blocks = [...root.querySelectorAll<HTMLElement>('[data-source-line]')]
        const top = root.getBoundingClientRect().top + 8
        let current = blocks[0]
        for (const block of blocks) { if (block.getBoundingClientRect().top <= top) current = block; else break }
        if (current) onSourceLine(Number(current.dataset.sourceLine) || 1)
      }}
      onClick={(event) => {
        const anchor = (event.target as Element).closest<HTMLAnchorElement>('a[href]')
        if (!anchor) return
        event.preventDefault()
        void native.openLink(documentPath, anchor.getAttribute('href') ?? '')
          .then((file) => { if (file) onOpenDocument(file) })
          .catch((error: unknown) => onError(error instanceof Error ? error.message : String(error)))
      }}
      // markdown-it runs with html:false; the renderer only emits escaped Markdown and controlled attributes.
      dangerouslySetInnerHTML={{ __html: html }}
    />
  )
}
