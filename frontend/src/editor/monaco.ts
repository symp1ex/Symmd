import { editor, languages } from 'monaco-editor/esm/vs/editor/editor.api'
import 'monaco-editor/esm/vs/editor/contrib/folding/browser/folding'
import 'monaco-editor/esm/vs/basic-languages/markdown/markdown.contribution'
import 'monaco-editor/esm/vs/language/json/monaco.contribution'
import 'monaco-editor/esm/vs/basic-languages/shell/shell.contribution'
import 'monaco-editor/esm/vs/basic-languages/javascript/javascript.contribution'
import 'monaco-editor/esm/vs/basic-languages/typescript/typescript.contribution'
import 'monaco-editor/esm/vs/basic-languages/css/css.contribution'
import 'monaco-editor/esm/vs/basic-languages/html/html.contribution'
import 'monaco-editor/esm/vs/basic-languages/xml/xml.contribution'
import 'monaco-editor/esm/vs/basic-languages/python/python.contribution'
import 'monaco-editor/esm/vs/basic-languages/powershell/powershell.contribution'
import 'monaco-editor/esm/vs/basic-languages/go/go.contribution'

export * from 'monaco-editor/esm/vs/editor/editor.api'

// JSON is a rich Monaco contribution and registers its tokenizer on first language encounter.
const jsonActivationModel = editor.createModel('', 'json')
jsonActivationModel.dispose()

export function resolveLanguageID(name: string): string | undefined {
  const normalized = name.trim().toLowerCase()
  if (normalized === 'bash') return 'shell'
  return languages.getLanguages().find((language) =>
    language.id.toLowerCase() === normalized
    || language.aliases?.some((alias) => alias.toLowerCase() === normalized)
  )?.id
}
