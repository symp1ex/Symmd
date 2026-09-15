import assert from 'node:assert/strict'
import { after, before, test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { createServer } from 'vite'

let server
let renderMarkdown
let nextPreviewZoom
let classifyLogFragment
let logLanguage
let effectiveViewMode
let languageForDocument
let isSupportedDocumentName
let resolveRegisteredLanguageID
let isSaveableLink
let mermaidConfiguration
let renderMermaidBlocks

class FakeElement {
  constructor(source) {
    this.children = []
    this.dataset = source === undefined ? {} : { mermaidSource: source }
    this.innerHTML = ''
    this.isConnected = true
    this.textContent = ''
    const classes = new Set()
    this.classList = {
      add: (name) => classes.add(name),
      contains: (name) => classes.has(name),
      remove: (name) => classes.delete(name),
    }
    this.ownerDocument = { createElement: () => new FakeElement() }
  }

  replaceChildren(...children) {
    this.children = children
    this.innerHTML = ''
  }
}

function fakeHost(...containers) {
  return { querySelectorAll: () => containers }
}

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
  ;({ classifyLogFragment, logLanguage } = await server.ssrLoadModule('/src/editor/logLanguage.ts'))
  ;({ effectiveViewMode, isSupportedDocumentName, languageForDocument, resolveRegisteredLanguageID } = await server.ssrLoadModule('/src/editor/languages.ts'))
  ;({ isSaveableLink } = await server.ssrLoadModule('/src/preview/linkContext.ts'))
  ;({ mermaidConfiguration, renderMermaidBlocks } = await server.ssrLoadModule('/src/preview/mermaid.ts'))
})

after(async () => {
  await server?.close()
})

test('renders known and unknown fenced languages with copy controls and source lines', () => {
  const html = renderMarkdown('# Code\n\n```json\n{"enabled": false}\n```\n\n```bash\necho test\n```\n\n```cmd\necho test\n```\n\n```powershell\nWrite-Output test\n```\n\n```ini\nenabled=true\n```\n\n```some-unknown-language\nhello\n```')
  assert.match(html, /class="code-block" data-source-line="3"/)
  assert.match(html, /data-language="json">\{&quot;enabled&quot;: false\}<\/code>/)
  assert.match(html, /data-language="bash">echo test<\/code>/)
  assert.match(html, /data-language="cmd">echo test<\/code>/)
  assert.match(html, /data-language="powershell">Write-Output test<\/code>/)
  assert.match(html, /data-language="ini">enabled=true<\/code>/)
  assert.match(html, /data-language="some-unknown-language">hello<\/code>/)
  assert.equal((html.match(/data-copy-code/g) ?? []).length, 6)
})

test('renders Mermaid fences as escaped source-line placeholders without code controls', () => {
  const html = renderMarkdown('Before\n\n```mermaid\nflowchart LR\n  A["<img src=x onerror=alert(1)>"] --> B\n```\n\n```javascript\nconst safe = "<tag>"\n```')
  assert.match(html, /<div class="mermaid-diagram" data-mermaid-source="flowchart LR\n  A\[&quot;&lt;img src=x onerror=alert\(1\)&gt;&quot;\] --&gt; B" data-source-line="3"><\/div>/)
  assert.equal((html.match(/class="mermaid-diagram"/g) ?? []).length, 1)
  assert.equal((html.match(/class="code-block"/g) ?? []).length, 1)
  assert.equal((html.match(/data-copy-code/g) ?? []).length, 1)
  assert.match(html, /data-language="javascript">const safe = &quot;&lt;tag&gt;&quot;<\/code>/)
  assert.doesNotMatch(html, /<img\b/i)
})

test('renders multiple Mermaid placeholders independently as SVG', async () => {
  const first = new FakeElement('flowchart LR\nA --> B')
  const second = new FakeElement('sequenceDiagram\nA->>B: Hi')
  const seen = []
  await renderMermaidBlocks(fakeHost(first, second), 'dark', () => false, async (source, theme) => {
    seen.push([source, theme])
    return { diagramType: 'test', svg: `<svg data-source="${seen.length}"></svg>` }
  })
  assert.deepEqual(seen, [
    ['flowchart LR\nA --> B', 'dark'],
    ['sequenceDiagram\nA->>B: Hi', 'dark'],
  ])
  assert.equal(first.innerHTML, '<svg data-source="1"></svg>')
  assert.equal(second.innerHTML, '<svg data-source="2"></svg>')
})

test('keeps an invalid Mermaid error local and preserves its source as text', async () => {
  const valid = new FakeElement('flowchart LR\nA --> B')
  const invalidSource = 'flowchart LR\nA[<script>alert(1)</script>'
  const invalid = new FakeElement(invalidSource)
  await renderMermaidBlocks(fakeHost(valid, invalid), 'light', () => false, async (source) => {
    if (source === invalidSource) throw new Error('Parse error')
    return { diagramType: 'flowchart', svg: '<svg></svg>' }
  })
  assert.equal(valid.innerHTML, '<svg></svg>')
  assert.equal(invalid.classList.contains('mermaid-diagram--error'), true)
  assert.match(invalid.children[0].textContent, /Parse error/)
  assert.equal(invalid.children[1].textContent, invalidSource)
  assert.equal(invalid.innerHTML, '')
})

test('does not apply a stale asynchronous Mermaid result after source changes', async () => {
  const oldSource = 'flowchart LR\nStaleOld --> Target'
  const newSource = 'flowchart LR\nStaleNew --> Target'
  const container = new FakeElement(oldSource)
  const resolvers = new Map()
  const renderer = (source) => new Promise((resolve) => resolvers.set(source, resolve))
  let generation = 1
  const first = renderMermaidBlocks(fakeHost(container), 'dark', () => generation !== 1, renderer)
  container.dataset.mermaidSource = newSource
  generation = 2
  const second = renderMermaidBlocks(fakeHost(container), 'dark', () => generation !== 2, renderer)
  resolvers.get(newSource)({ diagramType: 'flowchart', svg: '<svg data-current="true"></svg>' })
  await second
  resolvers.get(oldSource)({ diagramType: 'flowchart', svg: '<svg data-stale="true"></svg>' })
  await first
  assert.equal(container.innerHTML, '<svg data-current="true"></svg>')
})

test('caches unchanged Mermaid SVG by source and theme and rerenders on theme change', async () => {
  let calls = 0
  const renderer = async (_source, theme) => {
    calls += 1
    return { diagramType: 'flowchart', svg: `<svg data-theme="${theme}"></svg>` }
  }
  const first = new FakeElement('flowchart LR\nThemeA --> ThemeB')
  await renderMermaidBlocks(fakeHost(first), 'dark', () => false, renderer)
  const unchanged = new FakeElement('flowchart LR\nThemeA --> ThemeB')
  await renderMermaidBlocks(fakeHost(unchanged), 'dark', () => false, renderer)
  const changedTheme = new FakeElement('flowchart LR\nThemeA --> ThemeB')
  await renderMermaidBlocks(fakeHost(changedTheme), 'light', () => false, renderer)
  assert.equal(calls, 2)
  assert.equal(unchanged.innerHTML, '<svg data-theme="dark"></svg>')
  assert.equal(changedTheme.innerHTML, '<svg data-theme="light"></svg>')
})

test('uses strict Mermaid security configuration for both preview themes', () => {
  assert.deepEqual(mermaidConfiguration('dark'), {
    securityLevel: 'strict',
    startOnLoad: false,
    suppressErrorRendering: true,
    theme: 'dark',
  })
  assert.equal(mermaidConfiguration('light').theme, 'default')
  assert.equal(mermaidConfiguration('light').securityLevel, 'strict')
})

test('offers Save link as only for link types supported by existing navigation', () => {
  assert.equal(isSaveableLink('C:\\notes\\README.md', 'https://example.com/file.md'), true)
  assert.equal(isSaveableLink('C:\\notes\\README.md', '../shared/file.md#section'), true)
  assert.equal(isSaveableLink('', '../shared/file.md'), false)
  assert.equal(isSaveableLink('C:\\notes\\README.md', '#section'), false)
  assert.equal(isSaveableLink('C:\\notes\\README.md', 'mailto:user@example.com'), false)
  assert.equal(isSaveableLink('C:\\notes\\README.md', 'file:///C:/notes/file.md'), false)
  assert.equal(isSaveableLink('C:\\notes\\README.md', '/absolute/file.md'), false)
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

test('selects the document language and disables preview modes for log files', () => {
  assert.equal(isSupportedDocumentName('runtime.LOG'), true)
  assert.equal(isSupportedDocumentName('runtime.txt'), false)
  assert.equal(languageForDocument({ path: 'C:\\logs\\runtime.LOG', name: 'runtime.LOG' }), 'log')
  assert.equal(languageForDocument({ path: '', name: 'README.markdown' }), 'markdown')
  assert.equal(effectiveViewMode({ path: '', name: 'runtime.log' }, 'split'), 'editor')
  assert.equal(effectiveViewMode({ path: '', name: 'README.md' }, 'preview'), 'preview')
})

test('resolves representative Monaco language ids and aliases', () => {
  const registered = [
    { id: 'shell', aliases: ['Shell', 'sh'] },
    { id: 'bat', aliases: ['Batch', 'bat'] },
    { id: 'powershell', aliases: ['PowerShell', 'ps1'] },
    { id: 'ini', aliases: ['Ini'] },
    { id: 'json', aliases: ['JSON'] },
  ]
  for (const [alias, expected] of [['bash', 'shell'], ['sh', 'shell'], ['cmd', 'bat'], ['bat', 'bat'], ['batch', 'bat'], ['powershell', 'powershell'], ['ps1', 'powershell'], ['ini', 'ini'], ['json', 'json']]) {
    assert.equal(resolveRegisteredLanguageID(alias, registered), expected)
  }
  assert.equal(resolveRegisteredLanguageID('unknown-language', registered), undefined)
})

test('classifies VS Code-style log tokens', () => {
  assert.equal(logLanguage.ignoreCase, true)
  assert.equal(classifyLogFragment('[INFO]'), 'markup.inserted.log.info')
  assert.equal(classifyLogFragment('[WARN]'), 'markup.deleted.log.warning')
  assert.equal(classifyLogFragment('[ERROR]'), 'string.regexp.log.error')
  assert.equal(classifyLogFragment('[DEBUG]'), 'markup.changed.log.debug')
  assert.equal(classifyLogFragment('2026-09-12'), 'comment.log.date')
  assert.equal(classifyLogFragment('01:34:00,351'), 'comment.log.date')
  assert.equal(classifyLogFragment('10.127.33.42'), 'constant.language.log.constant')
  assert.equal(classifyLogFragment('64ee11e7-de20-4657-8679-d65f6a0f61c2'), 'constant.language.log.constant')
  assert.equal(classifyLogFragment('42'), 'constant.language.log.constant')
  assert.equal(classifyLogFragment('"connected"'), 'string.log.string')
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
