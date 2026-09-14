import assert from 'node:assert/strict'
import { after, before, test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { createServer } from 'vite'

let server
let renderMarkdown

before(async () => {
  server = await createServer({
    root: fileURLToPath(new URL('../', import.meta.url)),
    configFile: false,
    appType: 'custom',
    logLevel: 'silent',
    server: { middlewareMode: true },
  })
  ;({ renderMarkdown } = await server.ssrLoadModule('/src/markdown/render.ts'))
})

after(async () => {
  await server?.close()
})

test('renders known and unknown fenced languages with copy controls and source lines', () => {
  const html = renderMarkdown('# Code\n\n```json\n{"enabled": false}\n```\n\n```bash\necho test\n```\n\n```some-unknown-language\nhello\n```')
  assert.match(html, /class="code-block" data-source-line="3"/)
  assert.match(html, /data-language="json">\{&quot;enabled&quot;: false\}\n<\/code>/)
  assert.match(html, /data-language="bash">echo test\n<\/code>/)
  assert.match(html, /data-language="some-unknown-language">hello\n<\/code>/)
  assert.equal((html.match(/data-copy-code/g) ?? []).length, 3)
})

test('allows safe details HTML and parses a fenced block inside it', () => {
  const html = renderMarkdown('<details>\n<summary>Example <b>remote-access.json</b></summary>\n\n```json\n{"enabled": false}\n```\n\n</details>')
  assert.match(html, /^<details data-source-line="1">/)
  assert.match(html, /<summary>Example <b>remote-access\.json<\/b><\/summary>/)
  assert.match(html, /<div class="code-block" data-source-line="4">/)
  assert.match(html, /<\/details>$/)
})

test('neutralizes executable raw HTML and attributes', () => {
  const html = renderMarkdown('<script>alert(1)</script>\n\n<img src=x onerror=alert(2)>\n\n<a href="javascript:alert(3)" onclick="alert(4)">x</a>\n\n<iframe src="https://example.com"></iframe>\n\n<style>body{display:none}</style>\n\n<svg onload="alert(5)"></svg>\n\n<details onclick="alert(6)" open><summary style="color:red">safe</summary></details>')
  assert.doesNotMatch(html, /<(?:script|img|a|iframe|style|svg)\b/i)
  assert.doesNotMatch(html, /<(?:details|summary)\b[^>]+(?:on\w+|style)\s*=/i)
  assert.match(html, /<details open data-source-line="13"><summary>safe<\/summary><\/details>/)
})

test('preserves inline code, task lists, and local image resolution metadata', () => {
  const html = renderMarkdown('Use `<details>` here.\n\n- [x] done\n\n![local](images/example.png)\n\n![remote](https://example.com/image.png)')
  assert.match(html, /<code>&lt;details&gt;<\/code>/)
  assert.match(html, /<input type="checkbox" disabled checked>/)
  assert.match(html, /data-resource-src="images\/example\.png"/)
  assert.match(html, /data-blocked-src="https:\/\/example\.com\/image\.png"/)
  assert.doesNotMatch(html, /class="code-block"/)
})

test('keeps Markdown special characters escaped inside fences', () => {
  const html = renderMarkdown('```html\n<script>alert(`x`)</script> **not bold**\n```')
  assert.match(html, /data-language="html">&lt;script&gt;alert\(`x`\)&lt;\/script&gt; \*\*not bold\*\*\n<\/code>/)
  assert.doesNotMatch(html, /<script>/)
})

test('keeps existing Markdown block and inline features working', () => {
  const html = renderMarkdown('# H1\n\n###### H6\n\nParagraph  \nhard break\nsoft break\n\n- outer\n  - nested\n\n1. ordered\n\n> quote\n\n    indented `code`\n\n**strong** *emphasis* ~~strike~~ [query](https://example.com/a?x=1&y=2) <https://example.com> \\*escaped\\*\n\n---\n\n| A | B |\n| - | - |\n| 1 | 2 |\n\n```some-unknown-language\nunclosed')
  assert.match(html, /<h1 data-source-line="1">H1<\/h1>/)
  assert.match(html, /<h6 data-source-line="3">H6<\/h6>/)
  assert.match(html, /Paragraph<br>\nhard break\nsoft break/)
  assert.match(html, /<ul data-source-line="9">[\s\S]*<ul data-source-line="10">/)
  assert.match(html, /<ol data-source-line="12">/)
  assert.match(html, /<blockquote data-source-line="14">/)
  assert.match(html, /<pre data-source-line="16"><code>indented `code`\n<\/code><\/pre>/)
  assert.match(html, /<strong>strong<\/strong> <em>emphasis<\/em> <s>strike<\/s>/)
  assert.match(html, /href="https:\/\/example\.com\/a\?x=1&amp;y=2"/)
  assert.match(html, /<em>escaped<\/em>|\*escaped\*/)
  assert.match(html, /<table data-source-line="22">/)
  assert.match(html, /data-language="some-unknown-language">unclosed<\/code>/)
})
