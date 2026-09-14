# symmd

`symmd` is a lightweight Windows 10/11 Markdown editor built with Go, WebView2,
React, Vite, TypeScript, Monaco Editor, and markdown-it. It does not use
Electron and the production frontend is embedded in one `symmd.exe`.

## What works

- Native Open and Save As dialogs; new, save, multiple tabs, dirty indicators,
  native discard/exit confirmation, command-line file opening, and UTF-8 BOM input.
- Monaco Markdown editing with wrapping, line numbers, find/replace, automatic
  layout, no minimap, and no scroll past the final line.
- Editor, preview, and split modes with a resizable splitter and 100 ms preview debounce.
- Headings, paragraphs, emphasis, blockquotes, lists, task lists, tables, rules,
  code, links, local images, and strikethrough through markdown-it.
- Block-level editor ↔ preview scroll synchronization using source-line metadata.
- Dark+ inspired and light themes, editor font size, word wrap, preview sync,
  view mode, splitter persistence, external-change polling, DPI awareness, and
  custom resizable Win32 chrome.
- `Ctrl+N`, `Ctrl+O`, `Ctrl+S`, `Ctrl+Shift+S`, `Ctrl+F`, `Ctrl+H`,
  `Ctrl+Shift+V`, and `Ctrl+K V`.

Dropped `.md` files are accepted by the WebView as new unsaved documents because
the browser drag API intentionally does not expose a trustworthy full Windows path.

## Architecture

```text
Windows
   │
   ▼
Go host ── filesystem / dialogs / settings / Win32 chrome
   │
WebView2 (one instance)
   │
React / Vite / TypeScript
   ├── Monaco Editor
   └── markdown-it Preview
```

Go is deliberately thin. Markdown parsing, editor state, tabs, preview rendering,
themes, and view behavior remain in the frontend. Named bindings are centralized
in `frontend/src/bridge/native.ts` and `internal/app/app_windows.go`.

The trusted embedded application bundle is extracted into a content-versioned,
user-private cache directory because WebView2 limits `NavigateToString` to 2 MiB
and Monaco exceeds that limit. WebView2 maps only that verified directory to the
fixed `https://app.symmd.local/` virtual origin with cross-origin access denied;
it is protected by CSP and contains no user Markdown resources.

Local preview images are resolved relative to the saved Markdown document by Go,
restricted to image files under the document directory and to 25 MiB, then returned
as a `data:` URL. Raw `file://`, arbitrary HTML, scripts, iframes, event handlers,
absolute images, remote images, and non-HTTP link schemes are blocked. The embedded
page also uses a restrictive Content Security Policy.

## Development

Requirements: Go 1.24+, a current Node.js/npm, and Microsoft Edge WebView2 Runtime.

```powershell
cd frontend
npm.cmd install
npm.cmd run build
cd ..
go run ./cmd/symmd
```

To open a document during development:

```powershell
go run ./cmd/symmd README.md
```

The Vite-only UI server is available with `npm.cmd run dev`, but native file and
window operations require the Go host.

## Production build

```powershell
powershell -ExecutionPolicy Bypass -File .\build.ps1
```

For an already installed `node_modules` directory:

```powershell
powershell -ExecutionPolicy Bypass -File .\build.ps1 -SkipInstall
```

Output: `dist\symmd.exe`. Node.js is only a build dependency and is not required
to run the executable.

Concise startup, navigation, frontend bootstrap, bridge, Monaco, and drop events
are written to `%AppData%\symmd\runtime.log` (rotated at 1 MiB). Set
`SYMMD_DEBUG=1` before launching to enable the WebView2 developer tools for a
diagnostic session; they remain disabled by default.

## Third-party code and licenses

See [THIRD-PARTY-NOTICES.md](THIRD-PARTY-NOTICES.md). Sympllate, VS Code's
open-source repository, Monaco, React, and markdown-it are permissively licensed;
their relevant notices and roles are recorded there.

## Known limitations / next version

- Drag-and-drop imports content as an unsaved document instead of retaining its path.
- File watching is polling-based and currently asks per changed open document.
- Scroll synchronization is stable block-level mapping, not pixel interpolation.
- Preview code blocks are styled but do not yet have semantic language highlighting.
- Window size is restored; exact monitor position and maximized state are not yet restored.
- There is no session/tab restoration, autosave, command palette, extension host,
  terminal, workspace model, or other VS Code workbench subsystem.
