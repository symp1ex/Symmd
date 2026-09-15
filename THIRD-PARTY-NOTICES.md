# Third-party code and licenses

Symmd includes or builds against the following software. Versions are locked in
`go.sum` and `frontend/package-lock.json`.

| Component | Version | License | Use |
|---|---:|---|---|
| sympllate | local 2026 source | MIT | Adapted WebView2 host, embedded asset, and custom Win32 chrome patterns |
| symp1ex/go-webview2 | 2026-06-29 commit | MIT | Pure-Go WebView2 host with native initial window positioning |
| jchv/go-webview2 | 2026-02-05 commit | MIT | WebView2 edge backend required by the fork |
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
