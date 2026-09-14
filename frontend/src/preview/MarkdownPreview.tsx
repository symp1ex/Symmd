import { useEffect, useMemo, useRef } from 'react'
import { native, type MarkdownFile } from '../bridge/native'
import * as monaco from '../editor/monaco'
import { renderMarkdown } from '../markdown/render'

async function copyText(text: string): Promise<void> {
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text)
      return
    }
  } catch {
    // WebView2 can expose Clipboard API while denying it; use the legacy local fallback.
  }

  const textarea = document.createElement('textarea')
  const selection = document.getSelection()
  const ranges = selection ? [...Array.from({ length: selection.rangeCount }, (_, index) => selection.getRangeAt(index))] : []
  textarea.value = text
  textarea.style.position = 'fixed'
  textarea.style.opacity = '0'
  document.body.appendChild(textarea)
  textarea.select()
  try {
    if (!document.execCommand('copy')) throw new Error('Clipboard is unavailable')
  } finally {
    textarea.remove()
    if (selection) {
      selection.removeAllRanges()
      for (const range of ranges) selection.addRange(range)
    }
  }
}

interface Props {
  source: string
  documentPath: string
  sourceLine: number
  onSourceLine(line: number): void
  onOpenDocument(file: MarkdownFile): void
  onError(message: string): void
  syncEnabled: boolean
  theme: 'dark' | 'light'
  zoom: number
}

export function MarkdownPreview({ source, documentPath, sourceLine, onSourceLine, onOpenDocument, onError, syncEnabled, theme, zoom }: Props) {
  const hostRef = useRef<HTMLDivElement>(null)
  const syncingRef = useRef(false)
  const codeSourcesRef = useRef(new WeakMap<HTMLElement, string>())
  const html = useMemo(() => renderMarkdown(source), [source])

  useEffect(() => {
    let cancelled = false
    const host = hostRef.current
    if (!host) return
    monaco.editor.setTheme(monaco.editorTheme(theme))
    for (const code of host.querySelectorAll<HTMLElement>('.code-block code[data-language]')) {
      const original = codeSourcesRef.current.get(code) ?? code.textContent ?? ''
      codeSourcesRef.current.set(code, original)
      const language = monaco.resolveLanguageID(code.dataset.language ?? '')
      if (!language) continue
      void monaco.editor.colorize(original, language, { tabSize: 4 }).then((highlighted) => {
        if (!cancelled && code.isConnected) code.innerHTML = highlighted
      }).catch(() => undefined)
    }
    return () => { cancelled = true }
  }, [html, theme])

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
        if (!(event.target instanceof Element)) return
        const copyButton = event.target.closest<HTMLButtonElement>('button[data-copy-code]')
        if (copyButton) {
          const code = copyButton.closest('.code-block')?.querySelector<HTMLElement>('code')
          if (!code) return
          const original = codeSourcesRef.current.get(code) ?? code.textContent ?? ''
          void copyText(original).then(() => {
            copyButton.classList.add('code-copy--copied')
            copyButton.ariaLabel = 'Copied'
            window.setTimeout(() => {
              if (!copyButton.isConnected) return
              copyButton.classList.remove('code-copy--copied')
              copyButton.ariaLabel = 'Copy code'
            }, 1500)
          }).catch(() => {
            copyButton.ariaLabel = 'Copy failed'
          })
          return
        }
        const anchor = event.target.closest<HTMLAnchorElement>('a[href]')
        if (!anchor) return
        event.preventDefault()
        void native.openLink(documentPath, anchor.getAttribute('href') ?? '')
          .then((file) => { if (file) onOpenDocument(file) })
          .catch((error: unknown) => onError(error instanceof Error ? error.message : String(error)))
      }}
    >
      <div
        className="markdown-preview__content"
        style={{ zoom: zoom / 100 }}
        // Raw Markdown HTML is reduced to an attribute-free allowlist before it reaches this sink.
        dangerouslySetInnerHTML={{ __html: html }}
      />
    </article>
  )
}
