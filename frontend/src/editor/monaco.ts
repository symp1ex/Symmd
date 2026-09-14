import { editor, languages } from 'monaco-editor/esm/vs/editor/editor.api'
import 'monaco-editor/esm/vs/editor/contrib/folding/browser/folding'
import 'monaco-editor/esm/vs/basic-languages/monaco.contribution'
import 'monaco-editor/esm/vs/language/json/monaco.contribution'
import { resolveRegisteredLanguageID } from './languages'
import { logLanguage } from './logLanguage'

export * from 'monaco-editor/esm/vs/editor/editor.api'

// JSON is a rich Monaco contribution and registers its tokenizer on first language encounter.
const jsonActivationModel = editor.createModel('', 'json')
jsonActivationModel.dispose()

languages.register({ id: 'log', extensions: ['.log'], aliases: ['Log', 'log'] })
languages.setMonarchTokensProvider('log', logLanguage)

const darkLogRules: editor.ITokenThemeRule[] = [
  { token: 'comment.log.verbose', foreground: '6A9955' },
  { token: 'markup.changed.log.debug', foreground: '569CD6' },
  { token: 'markup.inserted.log.info', foreground: 'B5CEA8' },
  { token: 'markup.deleted.log.warning', foreground: 'CE9178' },
  { token: 'string.regexp.log.error', foreground: 'D16969', fontStyle: 'bold' },
  { token: 'comment.log.date', foreground: '6A9955' },
  { token: 'constant.language.log.constant', foreground: '569CD6' },
  { token: 'string.log.string', foreground: 'CE9178' },
  { token: 'string.regexp.log.exceptiontype', foreground: 'D16969', fontStyle: 'italic' },
  { token: 'string.key.log.exception', foreground: 'CE9178', fontStyle: 'italic' },
]

const lightLogRules: editor.ITokenThemeRule[] = [
  { token: 'comment.log.verbose', foreground: '008000' },
  { token: 'markup.changed.log.debug', foreground: '0451A5' },
  { token: 'markup.inserted.log.info', foreground: '098658' },
  { token: 'markup.deleted.log.warning', foreground: 'A31515' },
  { token: 'string.regexp.log.error', foreground: '811F3F', fontStyle: 'bold' },
  { token: 'comment.log.date', foreground: '008000' },
  { token: 'constant.language.log.constant', foreground: '0000FF' },
  { token: 'string.log.string', foreground: 'A31515' },
  { token: 'string.regexp.log.exceptiontype', foreground: '811F3F', fontStyle: 'italic' },
  { token: 'string.key.log.exception', foreground: 'A31515', fontStyle: 'italic' },
]

editor.defineTheme('symmd-dark', { base: 'vs-dark', inherit: true, rules: darkLogRules, colors: {} })
editor.defineTheme('symmd-light', { base: 'vs', inherit: true, rules: lightLogRules, colors: {} })

export function editorTheme(theme: 'dark' | 'light'): string {
  return theme === 'dark' ? 'symmd-dark' : 'symmd-light'
}

export function resolveLanguageID(name: string): string | undefined {
  return resolveRegisteredLanguageID(name, languages.getLanguages())
}
