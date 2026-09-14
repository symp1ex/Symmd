import MarkdownIt from 'markdown-it'
import type Token from 'markdown-it/lib/token.mjs'

const transparentPixel = 'data:image/gif;base64,R0lGODlhAQABAAD/ACwAAAAAAQABAAACADs='
const allowedHtmlTags = new Set([
  'article', 'aside', 'b', 'blockquote', 'br', 'caption', 'code', 'col', 'colgroup',
  'dd', 'del', 'details', 'div', 'dl', 'dt', 'em', 'figcaption', 'figure', 'footer',
  'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'header', 'hr', 'i', 'ins', 'kbd', 'li',
  'main', 'mark', 'ol', 'p', 'pre', 's', 'section', 'small', 'span', 'strong', 'sub',
  'summary', 'sup', 'table', 'tbody', 'td', 'tfoot', 'th', 'thead', 'tr', 'ul',
])
const blockHtmlTags = new Set([
  'article', 'aside', 'blockquote', 'details', 'div', 'dl', 'figure', 'footer', 'h1',
  'h2', 'h3', 'h4', 'h5', 'h6', 'header', 'hr', 'main', 'ol', 'p', 'pre', 'section',
  'table', 'ul',
])
const voidHtmlTags = new Set(['br', 'col', 'hr'])

const markdown = new MarkdownIt({
  html: true,
  linkify: true,
  typographer: false,
  breaks: false,
})

function sanitizeHtml(raw: string, sourceLine?: string): string {
  const tagPattern = /<!--[\s\S]*?-->|<![^>]*>|<\/?[^>]*>/g
  let rendered = ''
  let offset = 0
  let sourceLineAdded = false

  for (const match of raw.matchAll(tagPattern)) {
    const index = match.index ?? 0
    rendered += markdown.utils.escapeHtml(raw.slice(offset, index))
    const rawTag = match[0]
    const tag = rawTag.match(/^<\s*(\/?)\s*([a-z][a-z0-9-]*)(?:\s[^<>]*?)?\s*(\/?)>$/i)
    if (!tag) {
      rendered += markdown.utils.escapeHtml(rawTag)
      offset = index + rawTag.length
      continue
    }

    const closing = tag[1] === '/'
    const name = tag[2].toLowerCase()
    if (name === 'input' && !closing) {
      const checked = /\schecked(?:\s|=|\/?>)/i.test(rawTag)
      rendered += `<input type="checkbox" disabled${checked ? ' checked' : ''}>`
    } else if (!allowedHtmlTags.has(name) || (closing && voidHtmlTags.has(name))) {
      rendered += markdown.utils.escapeHtml(rawTag)
    } else if (closing) {
      rendered += `</${name}>`
    } else {
      const open = name === 'details' && /\sopen(?:\s|=|\/?>)/i.test(rawTag) ? ' open' : ''
      const line: string = sourceLine && !sourceLineAdded && blockHtmlTags.has(name)
        ? ` data-source-line="${markdown.utils.escapeHtml(sourceLine)}"`
        : ''
      sourceLineAdded ||= Boolean(line)
      rendered += `<${name}${open}${line}>`
    }
    offset = index + rawTag.length
  }

  return rendered + markdown.utils.escapeHtml(raw.slice(offset))
}

markdown.renderer.rules.html_block = (tokens, index) => sanitizeHtml(tokens[index].content, tokens[index].attrGet('data-source-line') ?? undefined)
markdown.renderer.rules.html_inline = (tokens, index) => sanitizeHtml(tokens[index].content)

markdown.core.ruler.push('symmd_source_lines', (state) => {
  for (const token of state.tokens) {
    if (token.map && (token.nesting === 1 || token.type === 'fence' || token.type === 'code_block' || token.type === 'html_block')) {
      token.attrSet('data-source-line', String(token.map[0] + 1))
    }
  }
})

markdown.core.ruler.push('symmd_task_lists', (state) => {
  for (const token of state.tokens) {
    if (token.type !== 'inline' || !/^\[[ xX]\]\s+/.test(token.content)) continue
    const checked = /^\[[xX]\]/.test(token.content)
    token.content = token.content.replace(/^\[[ xX]\]\s+/, '')
    const firstText = token.children?.find((child) => child.type === 'text')
    if (firstText) firstText.content = firstText.content.replace(/^\[[ xX]\]\s+/, '')
    const checkbox = new state.Token('html_inline', '', 0)
    checkbox.content = `<input type="checkbox" disabled${checked ? ' checked' : ''}>`
    token.children?.unshift(checkbox)
  }
})

markdown.renderer.rules.fence = (tokens, index) => {
  const token = tokens[index]
  const language = token.info.trim().split(/\s+/)[0]?.toLowerCase() ?? ''
  const safeLanguage = /^[a-z0-9_+#.-]+$/.test(language) ? language : ''
  const languageAttributes = safeLanguage
    ? ` class="language-${markdown.utils.escapeHtml(safeLanguage)}" data-language="${markdown.utils.escapeHtml(safeLanguage)}"`
    : ''
  const sourceLine = token.attrGet('data-source-line')
  const sourceLineAttribute = sourceLine ? ` data-source-line="${markdown.utils.escapeHtml(sourceLine)}"` : ''
  const copyIcon = '<svg class="code-copy__copy" viewBox="0 0 16 16" aria-hidden="true"><path d="M4 4V2.75C4 1.78 4.78 1 5.75 1h7.5C14.22 1 15 1.78 15 2.75v7.5c0 .97-.78 1.75-1.75 1.75H12v1.25c0 .97-.78 1.75-1.75 1.75h-7.5C1.78 15 1 14.22 1 13.25v-7.5C1 4.78 1.78 4 2.75 4H4Zm1.5 0h4.75C11.22 4 12 4.78 12 5.75v4.75h1.25a.25.25 0 0 0 .25-.25v-7.5a.25.25 0 0 0-.25-.25h-7.5a.25.25 0 0 0-.25.25V4Zm-2.75 1.5a.25.25 0 0 0-.25.25v7.5c0 .14.11.25.25.25h7.5a.25.25 0 0 0 .25-.25v-7.5a.25.25 0 0 0-.25-.25h-7.5Z"/></svg>'
  const successIcon = '<svg class="code-copy__success" viewBox="0 0 16 16" aria-hidden="true"><path d="m6.5 11.2-3.2-3.2 1.05-1.05L6.5 9.08l5.15-5.13L12.7 5l-6.2 6.2Z"/></svg>'
  return `<div class="code-block"${sourceLineAttribute}><button type="button" class="code-copy" data-copy-code aria-label="Copy code" title="Copy code">${copyIcon}${successIcon}</button><pre><code${languageAttributes}>${markdown.utils.escapeHtml(token.content)}</code></pre></div>\n`
}

const defaultImageRule = markdown.renderer.rules.image
markdown.renderer.rules.image = (tokens, index, options, env, self) => {
  const token = tokens[index]
  const source = token.attrGet('src') ?? ''
  if (/^(https?:|file:|javascript:|\\\\|\/)/i.test(source)) {
    token.attrSet('src', transparentPixel)
    token.attrSet('data-blocked-src', source)
    token.attrSet('title', 'Remote or absolute images are blocked')
  } else if (!source.startsWith('data:image/')) {
    token.attrSet('src', transparentPixel)
    token.attrSet('data-resource-src', source)
  }
  const renderer = defaultImageRule ?? ((items: Token[], tokenIndex: number, rendererOptions, _rendererEnv, rendererSelf) => rendererSelf.renderToken(items, tokenIndex, rendererOptions))
  return renderer(tokens, index, options, env, self)
}

export function renderMarkdown(source: string): string {
  return markdown.render(source)
}
