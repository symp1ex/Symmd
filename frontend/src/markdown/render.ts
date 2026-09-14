import MarkdownIt from 'markdown-it'
import type Token from 'markdown-it/lib/token.mjs'

const transparentPixel = 'data:image/gif;base64,R0lGODlhAQABAAD/ACwAAAAAAQABAAACADs='

const markdown = new MarkdownIt({
  html: false,
  linkify: true,
  typographer: false,
  breaks: false,
})

markdown.core.ruler.push('symmd_source_lines', (state) => {
  for (const token of state.tokens) {
    if (token.map && (token.nesting === 1 || token.type === 'fence' || token.type === 'code_block')) {
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
