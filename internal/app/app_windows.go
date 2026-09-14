//go:build windows

package app

import (
	"errors"
	"fmt"
	"io"
	"log"
	"net/url"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"sync"
	"syscall"
	"unsafe"

	webview "github.com/jchv/go-webview2"
	"github.com/symp1ex/symmd/internal/files"
	"github.com/symp1ex/symmd/internal/settings"
	"github.com/symp1ex/symmd/internal/webassets"
	"github.com/symp1ex/symmd/internal/window"
)

const (
	defaultWidth       = 1100
	defaultHeight      = 760
	messageYesNoCancel = 0x00000003
	messageYesNo       = 0x00000004
	messageIconWarning = 0x00000030
	idYes              = 6
	idNo               = 7
)

var (
	user32        = syscall.NewLazyDLL("user32.dll")
	messageBoxW   = user32.NewProc("MessageBoxW")
	getWindowRect = user32.NewProc("GetWindowRect")
	shell32       = syscall.NewLazyDLL("shell32.dll")
	shellExecuteW = shell32.NewProc("ShellExecuteW")
)

type nativeRect struct{ Left, Top, Right, Bottom int32 }

type Application struct {
	frontend   webassets.Frontend
	initial    *files.MarkdownFile
	w          webview.WebView
	hwnd       uintptr
	logger     *log.Logger
	mu         sync.Mutex
	settingsMu sync.Mutex
	dirty      bool
	closing    bool
}

func New(frontend webassets.Frontend, initial *files.MarkdownFile) *Application {
	return &Application{frontend: frontend, initial: initial}
}

func (a *Application) Run() error {
	runtime.LockOSThread()
	defer runtime.UnlockOSThread()
	logger, logFile, logPath := openRuntimeLog()
	a.logger = logger
	if logFile != nil {
		defer logFile.Close()
	}
	a.logf("application starting: frontend_url=%s assets_dir=%s version=%s files=%d bytes=%d initial_file=%t log=%s", a.frontend.URL, a.frontend.Directory, a.frontend.Version, a.frontend.FileCount, a.frontend.TotalBytes, a.initial != nil, logPath)
	window.EnableDPIAwareness()
	config, _ := settings.Load()
	width, height := config.Window.Width, config.Window.Height
	if width < 640 {
		width = defaultWidth
	}
	if height < 480 {
		height = defaultHeight
	}
	dataPath := ""
	if configPath, err := settings.Path(); err == nil {
		dataPath = filepath.Join(filepath.Dir(configPath), "webview")
		if err := os.MkdirAll(dataPath, 0o755); err != nil {
			return fmt.Errorf("create WebView2 data directory: %w", err)
		}
	}
	w := webview.NewWithOptions(webview.WebViewOptions{
		AutoFocus:     true,
		DataPath:      dataPath,
		Debug:         os.Getenv("SYMMD_DEBUG") == "1",
		WindowOptions: webview.WindowOptions{Title: "Symmd", Width: uint(width), Height: uint(height), Center: true},
	})
	if w == nil {
		return errors.New("create WebView2 window: Microsoft Edge WebView2 Runtime is required")
	}
	a.w, a.hwnd = w, uintptr(w.Window())
	a.logf("WebView2 created: hwnd=%d data_dir=%s", a.hwnd, dataPath)
	if a.hwnd == 0 {
		w.Destroy()
		return errors.New("WebView2 window did not provide an HWND")
	}
	if err := a.bind(); err != nil {
		w.Destroy()
		return err
	}
	a.installRuntimeInstrumentation()
	if err := window.ConfigureFrontendOrigin(w, webassets.Host, a.frontend.Directory, func() {
		a.logf("navigation completed")
		w.Eval(`if (typeof window.ReportRuntimeEvent === "function") { window.ReportRuntimeEvent("navigation-completed", window.location.href) }`)
	}); err != nil {
		w.Destroy()
		return fmt.Errorf("configure frontend origin: %w", err)
	}
	if err := window.ApplyChrome(w, 720, 500, a.RequestClose); err != nil {
		w.Destroy()
		return fmt.Errorf("apply window chrome: %w", err)
	}
	a.logf("navigation starting: url=%s", a.frontend.URL)
	w.Navigate(a.frontend.URL)
	w.Run()
	a.logf("message loop stopped")
	a.persistWindowState()
	w.Destroy()
	return nil
}

func (a *Application) bind() error {
	bindings := []struct {
		name string
		fn   any
	}{
		{"ReportRuntimeEvent", a.reportRuntimeEvent},
		{"GetInitialFile", func() *files.MarkdownFile { return a.initial }},
		{"OpenFile", a.openFile},
		{"ReadFile", files.Read},
		{"SaveFile", files.Write},
		{"SaveFileAs", a.saveFileAs},
		{"CheckFile", files.State},
		{"ResolveResource", files.ResourceDataURL},
		{"OpenLink", a.openLink},
		{"ConfirmDiscard", a.confirmDiscard},
		{"ConfirmReload", a.confirmReload},
		{"GetPreferences", a.getPreferences},
		{"SavePreferences", a.savePreferences},
		{"SetDirty", a.setDirty},
		{"WindowMinimize", func() { window.Minimize(a.w) }},
		{"WindowToggleMaximize", func() bool { return window.ToggleMaximized(a.w) }},
		{"WindowClose", a.RequestClose},
		{"WindowDrag", func() { window.Drag(a.w) }},
		{"WindowResize", func(hit float64) { window.Resize(a.w, uintptr(hit)) }},
		{"CloseAfterSave", a.closeAfterSave},
	}
	for _, binding := range bindings {
		if err := a.w.Bind(binding.name, binding.fn); err != nil {
			return fmt.Errorf("bind %s: %w", binding.name, err)
		}
	}
	a.logf("JavaScript bridge registered: methods=%d", len(bindings))
	return nil
}

const runtimeInstrumentation = `(function () {
  if (window.__symmdRuntimeInstalled) return;
  window.__symmdRuntimeInstalled = true;
  window.__symmdDropQueue = window.__symmdDropQueue || [];
  window.__symmdDropHandlerReady = false;

  var report = function (kind, detail) {
    if (typeof window.ReportRuntimeEvent === "function") {
      window.ReportRuntimeEvent(String(kind), String(detail || "")).catch(function () {});
    }
  };
  var publishDrop = function (item) {
    if (window.__symmdDropHandlerReady) {
      window.dispatchEvent(new CustomEvent("symmd-drop", { detail: item }));
    } else {
      window.__symmdDropQueue.push(item);
    }
  };
  var blockDrag = function (event) {
    event.preventDefault();
    if (event.dataTransfer) event.dataTransfer.dropEffect = "copy";
  };

  window.addEventListener("dragenter", blockDrag, true);
  window.addEventListener("dragover", blockDrag, true);
  window.addEventListener("drop", function (event) {
    blockDrag(event);
    var dropped = event.dataTransfer ? Array.from(event.dataTransfer.files || []) : [];
    if (dropped.length === 0) {
      publishDrop({ kind: "error", message: "The dropped item is not a file." });
      return;
    }
    dropped.forEach(function (file) {
      if (!/\.(md|markdown)$/i.test(file.name)) {
        publishDrop({ kind: "error", message: "Unsupported file: " + file.name + ". Only Markdown files can be opened." });
        report("drop-rejected", file.name);
        return;
      }
      file.text().then(function (content) {
        publishDrop({ kind: "file", file: { path: "", name: file.name, content: content, modifiedNs: 0 } });
        report("drop-imported", file.name);
      }).catch(function (error) {
        publishDrop({ kind: "error", message: "Could not read " + file.name + ": " + String(error) });
        report("drop-error", file.name + ": " + String(error));
      });
    });
  }, true);

  window.addEventListener("error", function (event) {
    var target = event.target;
    if (target && target !== window && (target.src || target.href)) {
      report("resource-error", target.src || target.href);
      return;
    }
    report("frontend-error", event.message + " @ " + event.filename + ":" + event.lineno + ":" + event.colno);
  }, true);
  window.addEventListener("unhandledrejection", function (event) {
    report("unhandled-rejection", event.reason && event.reason.stack ? event.reason.stack : String(event.reason));
  });
  document.addEventListener("DOMContentLoaded", function () { report("dom-content-loaded", window.location.href); }, { once: true });
  window.addEventListener("load", function () { report("window-loaded", window.location.href); }, { once: true });
})()`

func (a *Application) installRuntimeInstrumentation() {
	a.w.Init(runtimeInstrumentation)
	// NewWithOptions displays its initial about:blank document immediately.
	// Install the drag guard there too, covering the short interval before the
	// trusted frontend navigation creates its own instrumented document.
	a.w.Eval(runtimeInstrumentation)
}

func (a *Application) reportRuntimeEvent(kind, detail string) {
	if len(kind) > 80 {
		kind = kind[:80]
	}
	detail = strings.ReplaceAll(strings.ReplaceAll(detail, "\r", " "), "\n", " ")
	runes := []rune(detail)
	if len(runes) > 2048 {
		detail = string(runes[:2048]) + "..."
	}
	a.logf("frontend event: %s: %s", kind, detail)
}

func (a *Application) logf(format string, values ...any) {
	if a.logger != nil {
		a.logger.Printf(format, values...)
	}
}

func openRuntimeLog() (*log.Logger, *os.File, string) {
	configPath, err := settings.Path()
	if err != nil {
		return log.New(io.Discard, "", 0), nil, "unavailable"
	}
	logPath := filepath.Join(filepath.Dir(configPath), "runtime.log")
	if err := os.MkdirAll(filepath.Dir(logPath), 0o755); err != nil {
		return log.New(io.Discard, "", 0), nil, "unavailable"
	}
	flags := os.O_CREATE | os.O_WRONLY | os.O_APPEND
	if info, err := os.Stat(logPath); err == nil && info.Size() > 1<<20 {
		flags = os.O_CREATE | os.O_WRONLY | os.O_TRUNC
	}
	file, err := os.OpenFile(logPath, flags, 0o600)
	if err != nil {
		return log.New(io.Discard, "", 0), nil, "unavailable"
	}
	return log.New(file, "symmd ", log.Ldate|log.Ltime|log.Lmicroseconds), file, logPath
}

func (a *Application) openFile() (*files.MarkdownFile, error) {
	path, cancelled, err := window.SelectMarkdownFile(a.hwnd)
	if err != nil || cancelled {
		return nil, err
	}
	file, err := files.Read(path)
	if err != nil {
		return nil, err
	}
	return &file, nil
}

func (a *Application) saveFileAs(content string) (*files.MarkdownFile, error) {
	path, cancelled, err := window.SaveMarkdownFile(a.hwnd, "document.md")
	if err != nil || cancelled {
		return nil, err
	}
	file, err := files.Write(path, content)
	if err != nil {
		return nil, err
	}
	return &file, nil
}

func (a *Application) setDirty(dirty bool) { a.mu.Lock(); a.dirty = dirty; a.mu.Unlock() }

func (a *Application) RequestClose() {
	a.mu.Lock()
	if a.closing {
		a.mu.Unlock()
		return
	}
	dirty := a.dirty
	a.mu.Unlock()
	if dirty {
		choice := a.message("Save changes before closing Symmd?", "Unsaved changes", messageYesNoCancel|messageIconWarning)
		switch choice {
		case idYes:
			a.w.Eval("window.dispatchEvent(new Event('symmd-save-and-close'))")
			return
		case idNo:
		default:
			return
		}
	}
	a.closeAfterSave()
}

func (a *Application) closeAfterSave() {
	a.mu.Lock()
	if a.closing {
		a.mu.Unlock()
		return
	}
	a.closing, a.dirty = true, false
	a.mu.Unlock()
	a.persistWindowState()
	a.w.Dispatch(func() { a.w.Terminate() })
}

func (a *Application) confirmDiscard(name string) bool {
	return a.message("Discard unsaved changes in "+name+"?", "Unsaved changes", messageYesNo|messageIconWarning) == idYes
}

func (a *Application) confirmReload(name string) bool {
	return a.message(name+" was changed by another application. Reload it from disk?", "File changed", messageYesNo|messageIconWarning) == idYes
}

func (a *Application) getPreferences() settings.Preferences {
	a.settingsMu.Lock()
	defer a.settingsMu.Unlock()
	config, err := settings.Load()
	if err != nil {
		return settings.Defaults().Preferences
	}
	return config.Preferences
}

func (a *Application) savePreferences(preferences settings.Preferences) error {
	a.settingsMu.Lock()
	defer a.settingsMu.Unlock()
	config, err := settings.Load()
	if err != nil {
		return err
	}
	config.Preferences = settings.NormalizePreferences(preferences)
	return settings.Save(config)
}

func (a *Application) message(text, title string, flags uintptr) uintptr {
	message, _ := syscall.UTF16PtrFromString(text)
	caption, _ := syscall.UTF16PtrFromString(title)
	result, _, _ := messageBoxW.Call(a.hwnd, uintptr(unsafe.Pointer(message)), uintptr(unsafe.Pointer(caption)), flags)
	return result
}

func (a *Application) openLink(documentPath, reference string) (*files.MarkdownFile, error) {
	parsed, err := url.Parse(reference)
	if err != nil {
		return nil, fmt.Errorf("parse link: %w", err)
	}
	if parsed.Fragment != "" && parsed.Path == "" {
		return nil, nil
	}
	if parsed.Scheme != "" {
		scheme := strings.ToLower(parsed.Scheme)
		if scheme != "https" && scheme != "http" && scheme != "mailto" {
			return nil, errors.New("link scheme is blocked")
		}
		return nil, a.openShell(reference)
	}
	if documentPath == "" {
		return nil, errors.New("save the document before opening relative links")
	}
	if strings.HasPrefix(parsed.Path, "/") || strings.HasPrefix(parsed.Path, "\\") {
		return nil, errors.New("absolute local links are blocked")
	}
	decoded, err := url.PathUnescape(parsed.Path)
	if err != nil {
		return nil, fmt.Errorf("decode link path: %w", err)
	}
	target := filepath.Join(filepath.Dir(documentPath), filepath.FromSlash(decoded))
	if ext := strings.ToLower(filepath.Ext(target)); ext != ".md" && ext != ".markdown" {
		info, err := os.Stat(target)
		if err != nil {
			return nil, fmt.Errorf("open relative link: %w", err)
		}
		if info.IsDir() {
			return nil, errors.New("relative link points to a directory")
		}
		return nil, a.openShell(target)
	}
	file, err := files.Read(target)
	if err != nil {
		return nil, err
	}
	return &file, nil
}

func (a *Application) openShell(target string) error {
	verb, _ := syscall.UTF16PtrFromString("open")
	encoded, err := syscall.UTF16PtrFromString(target)
	if err != nil {
		return fmt.Errorf("encode link: %w", err)
	}
	result, _, _ := shellExecuteW.Call(a.hwnd, uintptr(unsafe.Pointer(verb)), uintptr(unsafe.Pointer(encoded)), 0, 0, 1)
	if result <= 32 {
		return fmt.Errorf("open link: Windows error %d", result)
	}
	return nil
}

func (a *Application) persistWindowState() {
	a.settingsMu.Lock()
	defer a.settingsMu.Unlock()
	if a.hwnd == 0 {
		return
	}
	var r nativeRect
	if ok, _, _ := getWindowRect.Call(a.hwnd, uintptr(unsafe.Pointer(&r))); ok == 0 {
		return
	}
	width, height := r.Right-r.Left, r.Bottom-r.Top
	if width < 640 || height < 480 {
		return
	}
	config, err := settings.Load()
	if err != nil {
		config = settings.Defaults()
	}
	config.Window = settings.WindowState{X: r.Left, Y: r.Top, Width: width, Height: height}
	_ = settings.Save(config)
}

func LoadInitial(arguments []string) (*files.MarkdownFile, error) {
	if len(arguments) == 0 {
		return nil, nil
	}
	path := arguments[0]
	if strings.HasPrefix(path, "-") {
		return nil, fmt.Errorf("unknown option %q", path)
	}
	if ext := strings.ToLower(filepath.Ext(path)); ext != ".md" && ext != ".markdown" {
		return nil, fmt.Errorf("not a Markdown file: %q", path)
	}
	file, err := files.Read(path)
	if err != nil {
		return nil, err
	}
	return &file, nil
}

func ShowError(err error) {
	if err == nil {
		return
	}
	message, _ := syscall.UTF16PtrFromString(err.Error())
	title, _ := syscall.UTF16PtrFromString("Symmd — Error")
	messageBoxW.Call(0, uintptr(unsafe.Pointer(message)), uintptr(unsafe.Pointer(title)), 0x10)
}
