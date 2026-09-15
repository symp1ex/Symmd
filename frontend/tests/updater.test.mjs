import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

const app = readFileSync(new URL('../src/app/App.tsx', import.meta.url), 'utf8')
const styles = readFileSync(new URL('../src/styles/app.css', import.meta.url), 'utf8')

test('shows updater states with sympllate text and exact error color', () => {
  assert.match(app, /\? 'Update error'/)
  assert.match(app, /\? 'Install update'/)
  assert.match(styles, /settings-statusbar__version--available,[\s\S]*settings-statusbar__version--error \{ color: #ffb4ab; \}/)
})

test('starts automatic checks only from the opened Settings popover and keeps manual checks unthrottled', () => {
  assert.match(app, /if \(settingsOpen && settingsLoaded\) void runUpdateCheck\(true\)/)
  assert.match(app, /void runUpdateCheck\(false\)/)
  assert.match(app, /checked=\{preferences\.checkForUpdates\}[\s\S]*Check for updates/)
})

test('increases the Settings status font by exactly one pixel', () => {
  assert.match(styles, /\.settings-statusbar \{[^}]*font-size: 12px;/)
  assert.doesNotMatch(styles, /\.settings-statusbar \{[^}]*font-size: 11px;/)
})

test('handles Save shortcuts with the current active document and prevents browser defaults', () => {
  assert.match(app, /const shortcutActive = activeDocument\(documentsRef\.current, activeIDRef\.current\)/)
  assert.match(app, /else if \(key === 's'\) \{ event\.preventDefault\(\); if \(shortcutActive\) void saveDocument\(shortcutActive, event\.shiftKey\) \}/)
})
