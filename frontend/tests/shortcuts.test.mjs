import assert from 'node:assert/strict'
import { after, before, test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { createServer } from 'vite'

let server
let matchShortcut

const key = (code, overrides = {}) => ({
  code,
  key: overrides.key ?? '',
  ctrlKey: true,
  shiftKey: false,
  altKey: false,
  metaKey: false,
  isComposing: false,
  ...overrides,
})

before(async () => {
  server = await createServer({
    root: fileURLToPath(new URL('../', import.meta.url)),
    configFile: false,
    appType: 'custom',
    logLevel: 'silent',
    server: { middlewareMode: true },
  })
  ;({ matchShortcut } = await server.ssrLoadModule('/src/app/shortcuts.ts'))
})

after(async () => {
  await server?.close()
})

test('matches Save and Save As by physical code in English and Russian layouts', () => {
  for (const layoutKey of ['s', 'ы']) {
    assert.deepEqual(matchShortcut(key('KeyS', { key: layoutKey }), 'editor', false), {
      command: 'save', chordPending: false, preventDefault: true,
    })
    assert.deepEqual(matchShortcut(key('KeyS', { key: layoutKey, shiftKey: true }), 'editor', false), {
      command: 'save-as', chordPending: false, preventDefault: true,
    })
  }
})

test('matches every existing global letter shortcut by code', () => {
  assert.equal(matchShortcut(key('KeyN', { key: 'т' }), 'editor', false).command, 'new-document')
  assert.equal(matchShortcut(key('KeyO', { key: 'щ' }), 'editor', false).command, 'open-document')
  assert.deepEqual(matchShortcut(key('KeyK', { key: 'л' }), 'editor', false), {
    chordPending: true, preventDefault: true,
  })
  assert.equal(matchShortcut(key('KeyV', { key: 'м', ctrlKey: false }), 'editor', true).command, 'show-split')
  assert.equal(matchShortcut(key('KeyV', { key: 'м', shiftKey: true }), 'editor', false).command, 'show-preview')
})

test('routes Find and Replace to Monaco when the editor is active', () => {
  assert.deepEqual(matchShortcut(key('KeyF'), 'editor', false), {
    command: 'monaco-find', chordPending: false, preventDefault: true,
  })
  assert.deepEqual(matchShortcut(key('KeyH'), 'editor', false), {
    command: 'monaco-replace', chordPending: false, preventDefault: true,
  })
})

test('leaves native WebView2 Find and result navigation unhandled for Preview', () => {
  assert.deepEqual(matchShortcut(key('KeyF'), 'preview', false), {
    command: 'browser-find', chordPending: false, preventDefault: false,
  })
  assert.equal(matchShortcut(key('F3', { ctrlKey: false }), 'preview', false).command, 'browser-find-next')
  assert.equal(matchShortcut(key('F3', { ctrlKey: false, shiftKey: true }), 'preview', false).command, 'browser-find-previous')
  assert.equal(matchShortcut(key('KeyH'), 'preview', false).command, undefined)
})

test('changes the split-mode route after the active pane changes', () => {
  assert.equal(matchShortcut(key('KeyF'), 'editor', false).command, 'monaco-find')
  assert.equal(matchShortcut(key('KeyF'), 'preview', false).command, 'browser-find')
  assert.equal(matchShortcut(key('KeyF'), 'editor', false).command, 'monaco-find')
})

test('does not run global shortcuts during composition or Alt-modified input', () => {
  assert.equal(matchShortcut(key('KeyS', { isComposing: true }), 'editor', false).command, undefined)
  assert.equal(matchShortcut(key('KeyS', { altKey: true }), 'editor', false).command, undefined)
})
