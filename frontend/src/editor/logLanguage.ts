import type { languages } from 'monaco-editor/esm/vs/editor/editor.api'

interface LogTokenRule {
  pattern: RegExp
  token: string
}

export const logTokenRules: readonly LogTokenRule[] = [
  { pattern: /^\s*at\s+.*$/, token: 'string.key.log.exception' },
  { pattern: /\[(?:trace|verbose|verb|vrb|vb|v)\]|\b(?:trace|verbose)\b:?/i, token: 'comment.log.verbose' },
  { pattern: /\[(?:debug|dbug|dbg|de|d)\]|\bdebug\b:?/i, token: 'markup.changed.log.debug' },
  { pattern: /\[(?:information|info|inf|in|i)\]|\b(?:hint|info|information|notice)\b:?/i, token: 'markup.inserted.log.info' },
  { pattern: /\[(?:warning|warn|wrn|wn|w)\]|\b(?:warning|warn)\b:?/i, token: 'markup.deleted.log.warning' },
  { pattern: /\[(?:error|eror|err|er|e|fatal|fatl|ftl|fa|f)\]|\b(?:alert|critical|emergency|error|failure|fail|fatal)\b:?/i, token: 'string.regexp.log.error' },
  { pattern: /\b\d{4}-\d{2}-\d{2}(?=T|\b)|\b\d{2}[^\w\s]\d{2}[^\w\s]\d{4}\b|T?\d{1,2}:\d{2}(?::\d{2}(?:[.,]\d+)?)?(?:Z|\s?[+-]\d{1,2}:?\d{2})?\b/i, token: 'comment.log.date' },
  { pattern: /\b[0-9a-f]{8}-?(?:[0-9a-f]{4}-?){3}[0-9a-f]{12}\b/i, token: 'constant.language.log.constant' },
  { pattern: /\b(?:[0-9a-f]{40}|[0-9a-f]{10}|[0-9a-f]{7})\b/i, token: 'constant.language.log.constant' },
  { pattern: /\b(?:[0-9a-f]{2,}[:-])+[0-9a-f]{2,}\b/i, token: 'constant.language.log.constant' },
  { pattern: /\b(?:\d{1,3}\.){3}\d{1,3}\b/, token: 'constant.language.log.constant' },
  { pattern: /\b[a-z][a-z0-9+.-]*:\/\/\S+\b\/?/i, token: 'constant.language.log.constant' },
  { pattern: /\b[a-zA-Z.]*Exception\b/, token: 'string.regexp.log.exceptiontype' },
  { pattern: /"[^"]*"|'[^']*'/, token: 'string.log.string' },
  { pattern: /\b(?:0x[0-9a-f]+|\d+|true|false|null)\b/i, token: 'constant.language.log.constant' },
  { pattern: /(?:[\w-]+\.)+[\w-]+/, token: 'constant.language.log.constant' },
]

export const logLanguage: languages.IMonarchLanguage = {
  defaultToken: '',
  tokenizer: {
    root: logTokenRules.map(({ pattern, token }) => [pattern, token]),
  },
}

export function classifyLogFragment(fragment: string): string | undefined {
  return logTokenRules.find(({ pattern }) => {
    const match = pattern.exec(fragment)
    return match?.index === 0 && match[0].length === fragment.length
  })?.token
}
