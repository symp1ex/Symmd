import assert from 'node:assert/strict'
import { after, before, test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { createServer } from 'vite'

let server
let renderMarkdown
let nextPreviewZoom

before(async () => {
  server = await createServer({
    root: fileURLToPath(new URL('../', import.meta.url)),
    configFile: false,
    appType: 'custom',
    logLevel: 'silent',
    server: { middlewareMode: true },
  })
  ;({ renderMarkdown } = await server.ssrLoadModule('/src/markdown/render.ts'))
  ;({ nextPreviewZoom } = await server.ssrLoadModule('/src/preview/zoom.ts'))
})

after(async () => {
  await server?.close()
})

test('renders known and unknown fenced languages with copy controls and source lines', () => {
  const html = renderMarkdown('# Code\n\n```json\n{"enabled": false}\n```\n\n```bash\necho test\n```\n\n```some-unknown-language\nhello\n```')
  assert.match(html, /class="code-block" data-source-line="3"/)
  assert.match(html, /data-language="json">\{&quot;enabled&quot;: false\}<\/code>/)
  assert.match(html, /data-language="bash">echo test<\/code>/)
  assert.match(html, /data-language="some-unknown-language">hello<\/code>/)
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

test('normalizes common br forms without allowing other closing void tags', () => {
  for (const source of ['before<br>after', 'before<br/>after', 'before<br />after', 'before</br>after']) {
    const html = renderMarkdown(source)
    assert.match(html, /before<br>after/)
    assert.doesNotMatch(html, /&lt;\/br&gt;/)
  }
  assert.match(renderMarkdown('before</hr>after'), /before&lt;\/hr&gt;after/)
  assert.match(renderMarkdown('before</col>after'), /before&lt;\/col&gt;after/)
})

test('removes one structural newline only from closed fenced blocks', () => {
  assert.match(renderMarkdown('```text\none line\n```'), /data-language="text">one line<\/code>/)
  assert.match(renderMarkdown('```text\none\ntwo\n```'), /data-language="text">one\ntwo<\/code>/)
  assert.match(renderMarkdown('```text\none\n\n```'), /data-language="text">one\n<\/code>/)
  assert.match(renderMarkdown('```text\nunclosed'), /data-language="text">unclosed<\/code>/)
  assert.match(renderMarkdown('```text\nunclosed\n'), /data-language="text">unclosed\n<\/code>/)
})

test('preserves inline code, task lists, and supported image sources', () => {
  const html = renderMarkdown('Use `<details>` here.\n\n- [x] done\n\n![local](images/example.png)\n\n![remote](https://example.com/image.png)')
  assert.match(html, /<code>&lt;details&gt;<\/code>/)
  assert.match(html, /<input type="checkbox" disabled checked>/)
  assert.match(html, /data-resource-src="images\/example\.png"/)
  assert.match(html, /src="https:\/\/example\.com\/image\.png"/)
  assert.doesNotMatch(html, /data-blocked-src="https:/)
  assert.doesNotMatch(html, /class="code-block"/)
})

test('routes local image paths through native resolution after markdown-it normalization', () => {
  const html = renderMarkdown('![relative](images/test.png)\n\n![dot](./images/test.png)\n\n![parent](../shared/test.png)\n\n![windows-backslash](C:\\images\\test.png)\n\n![windows-slash](C:/images/test.png)\n\n![space](<images/test image.png>)\n\n![reference][image-ref]\n\n[image-ref]: ../shared/test%20image.png')
  assert.match(html, /data-resource-src="images\/test\.png"/)
  assert.match(html, /data-resource-src="\.\/images\/test\.png"/)
  assert.match(html, /data-resource-src="\.\.\/shared\/test\.png"/)
  assert.match(html, /data-resource-src="C:%5Cimages%5Ctest\.png"/)
  assert.match(html, /data-resource-src="C:\/images\/test\.png"/)
  assert.match(html, /data-resource-src="images\/test%20image\.png"/)
  assert.match(html, /data-resource-src="\.\.\/shared\/test%20image\.png"/)
})

test('allows only HTTP(S) and markdown-it safe data image schemes directly', () => {
  const html = renderMarkdown('![https](https://example.com/image.png)\n\n![http](http://example.com/image.png)\n\n![data](data:image/png;base64,AAAA)\n\n![unknown](ftp://example.com/image.png)\n\n![script](javascript:alert(1))')
  assert.match(html, /src="https:\/\/example\.com\/image\.png"/)
  assert.match(html, /src="http:\/\/example\.com\/image\.png"/)
  assert.match(html, /src="data:image\/png;base64,AAAA"/)
  assert.match(html, /data-blocked-src="ftp:\/\/example\.com\/image\.png"/)
  assert.doesNotMatch(html, /<img[^>]+javascript:/i)
})

test('calculates preview zoom in fixed bounded steps', () => {
  assert.equal(nextPreviewZoom(100, -1), 110)
  assert.equal(nextPreviewZoom(100, 1), 90)
  assert.equal(nextPreviewZoom(200, -1), 200)
  assert.equal(nextPreviewZoom(50, 1), 50)
  assert.equal(nextPreviewZoom(100, 0), 100)
})

test('keeps Markdown special characters escaped inside fences', () => {
  const html = renderMarkdown('```html\n<script>alert(`x`)</script> **not bold**\n```')
  assert.match(html, /data-language="html">&lt;script&gt;alert\(`x`\)&lt;\/script&gt; \*\*not bold\*\*<\/code>/)
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
