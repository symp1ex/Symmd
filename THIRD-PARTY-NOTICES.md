# Third-party code and licenses

Symmd includes or builds against the following software. Versions are locked in
`go.sum` and `frontend/package-lock.json`.

| Component | Version | License | Use |
|---|---:|---|---|
| sympllate | local 2026 source | MIT | Adapted WebView2 host, embedded asset, and custom Win32 chrome patterns |
| jchv/go-webview2 | 2026-02-05 commit | MIT | Pure-Go WebView2 host |
| jchv/go-winloader | 2025-04-06 commit | MIT | WebView2Loader support (transitive) |
| golang.org/x/sys | 2021-02-18 commit | BSD-3-Clause | Windows APIs (transitive) |
| monaco-editor | 0.52.2 | MIT | Editor and built-in Markdown tokenization |
| markdown-it | 14.3.2 | MIT | Markdown rendering |
| React / React DOM | 19.3.0 | MIT | Frontend UI |
| Vite | 7.3.6 | MIT; bundled build-time code also carries permissive notices | Frontend build |
| TypeScript | 5.9.3 | Apache-2.0 | Frontend type checking |
| @vitejs/plugin-react | 5.2.0 | MIT | Frontend build |
| DefinitelyTyped packages | locked versions | MIT | Development type declarations |

The Markdown preview behavior and styling were independently adapted with
reference to the MIT-licensed open-source files under
`microsoft/vscode/extensions/markdown-language-features` and
`microsoft/vscode/extensions/markdown-basics`. No proprietary Visual Studio Code
distribution assets, branding, extension host, or workbench code are included.

## sympllate MIT notice

MIT License

Copyright (c) 2026 Eugene S.T.

Permission is hereby granted, free of charge, to any person obtaining a copy of
this software and associated documentation files (the "Software"), to deal in
the Software without restriction, including without limitation the rights to
use, copy, modify, merge, publish, distribute, sublicense, and/or sell copies of
the Software, and to permit persons to whom the Software is furnished to do so,
subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.

Full license texts for installed packages are also present in their source
distributions under `frontend/node_modules` and the Go module cache.
