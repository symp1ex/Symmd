/// <reference types="vite/client" />

declare module 'monaco-editor/esm/vs/basic-languages/bat/bat' {
  import type { languages } from 'monaco-editor/esm/vs/editor/editor.api'

  export const conf: languages.LanguageConfiguration
  export const language: languages.IMonarchLanguage
}

declare module 'monaco-editor/esm/vs/basic-languages/powershell/powershell' {
  import type { languages } from 'monaco-editor/esm/vs/editor/editor.api'

  export const conf: languages.LanguageConfiguration
  export const language: languages.IMonarchLanguage
}
