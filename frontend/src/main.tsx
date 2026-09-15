import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { App } from './app/App'
import './styles/app.css'
import './styles/preview.css'

const bridgeMethods = [
  'ReportRuntimeEvent', 'GetVersion', 'GetInitialFile', 'OpenFile', 'ReadFile', 'SaveFile', 'SaveFileAs',
  'CheckFile', 'ResolveResource', 'OpenLink', 'ConfirmDiscard', 'ConfirmReload',
  'SaveLinkAs', 'ShowContextMenu',
  'GetPreferences', 'SavePreferences', 'SetDirty', 'WindowMinimize',
  'WindowToggleMaximize', 'WindowClose', 'WindowDrag', 'WindowResize', 'CloseAfterSave',
] as const

const report = (kind: string, detail: string) => {
  if (typeof window.ReportRuntimeEvent === 'function') {
    void window.ReportRuntimeEvent(kind, detail).catch(() => undefined)
  }
}

try {
  const missing = bridgeMethods.filter((name) => typeof window[name] !== 'function')
  if (missing.length) report('bridge-missing', missing.join(', '))
  const root = document.getElementById('root')
  if (!root) throw new Error('Frontend root element is missing')
  createRoot(root).render(<StrictMode><App /></StrictMode>)
  report('frontend-bootstrap-scheduled', window.location.href)
} catch (error) {
  const message = error instanceof Error ? `${error.message}\n${error.stack ?? ''}` : String(error)
  report('bootstrap-error', message)
  document.body.textContent = `Symmd frontend failed to start: ${message}`
}
