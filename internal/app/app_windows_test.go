//go:build windows

package app

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"net/url"
	"os"
	"path/filepath"
	"testing"

	"github.com/symp1ex/symmd/internal/settings"
	"github.com/symp1ex/symmd/internal/updater"
	"github.com/symp1ex/symmd/internal/window"
)

func TestLoadInitialSupportedDocuments(t *testing.T) {
	for _, name := range []string{"notes.md", "notes.markdown", "runtime.log", "RUNTIME.LOG"} {
		t.Run(name, func(t *testing.T) {
			path := filepath.Join(t.TempDir(), name)
			if err := os.WriteFile(path, []byte("content"), 0o644); err != nil {
				t.Fatal(err)
			}
			file, err := LoadInitial([]string{path})
			if err != nil || file == nil || file.Path == "" || file.Content != "content" {
				t.Fatalf("LoadInitial() = %#v, %v", file, err)
			}
		})
	}
}

func TestInitialWindowOptionsCentersWithoutSavedState(t *testing.T) {
	options := initialWindowOptions(settings.WindowState{})
	if !options.Center || options.X != nil || options.Y != nil || options.Width != defaultWidth || options.Height != defaultHeight {
		t.Fatalf("unexpected default window options: %#v", options)
	}
}

func TestInitialWindowOptionsUsesVisibleSavedPosition(t *testing.T) {
	state := settings.WindowState{X: 0, Y: 0, Width: 900, Height: 700}
	if !window.IsRectVisible(state.X, state.Y, state.Width, state.Height) {
		t.Skip("Windows desktop monitor is unavailable")
	}
	options := initialWindowOptions(state)
	if options.Center || options.X == nil || options.Y == nil || *options.X != 0 || *options.Y != 0 || options.Width != 900 || options.Height != 700 {
		t.Fatalf("unexpected restored window options: %#v", options)
	}
}

func TestInitialWindowOptionsCentersOffscreenSavedPosition(t *testing.T) {
	options := initialWindowOptions(settings.WindowState{X: 1_000_000_000, Y: 1_000_000_000, Width: 900, Height: 700})
	if !options.Center || options.X != nil || options.Y != nil || options.Width != 900 || options.Height != 700 {
		t.Fatalf("unexpected offscreen window options: %#v", options)
	}
}

func TestLoadInitialRejectsUnsupportedDocument(t *testing.T) {
	if file, err := LoadInitial([]string{"notes.txt"}); err == nil || file != nil {
		t.Fatalf("LoadInitial() = %#v, %v", file, err)
	}
}

func TestLoadInitialAcceptsUpdaterStartCommand(t *testing.T) {
	if file, err := LoadInitial([]string{"start"}); err != nil || file != nil {
		t.Fatalf("LoadInitial(start) = %#v, %v", file, err)
	}
}

func TestUpdaterDisabledBlocksAutomaticManualAndInstallRequests(t *testing.T) {
	t.Setenv("APPDATA", t.TempDir())
	config := settings.Defaults()
	config.Updater.Enabled = false
	if err := settings.Save(config); err != nil {
		t.Fatal(err)
	}
	service := &fakeUpdateService{}
	application := &Application{updater: service}
	for _, automatic := range []bool{true, false} {
		if result := application.checkApplicationUpdate(automatic); result.OK || result.Started || result.Message != "updater is disabled" {
			t.Fatalf("checkApplicationUpdate(%t) = %+v", automatic, result)
		}
	}
	if result := application.installApplicationUpdate(); result.OK || result.Message != "updater is disabled" {
		t.Fatalf("installApplicationUpdate() = %+v", result)
	}
	if service.checks != 0 || service.installs != 0 {
		t.Fatalf("disabled updater calls = checks %d, installs %d", service.checks, service.installs)
	}
}

func TestSavePreferencesPreservesWindowAndLoggerSettings(t *testing.T) {
	t.Setenv("APPDATA", t.TempDir())
	config := settings.Defaults()
	config.Window = settings.WindowState{X: 10, Y: 20, Width: 900, Height: 700}
	config.Logs.LogLevel.Active = settings.LogLevelDebug
	config.Logs.StoreDays = 7
	if err := settings.Save(config); err != nil {
		t.Fatal(err)
	}
	application := &Application{}
	preferences := clientPreferences{Preferences: config.Preferences, CheckForUpdates: false}
	preferences.Theme = "light"
	if err := application.savePreferences(preferences); err != nil {
		t.Fatal(err)
	}
	loaded, err := settings.Load()
	if err != nil {
		t.Fatal(err)
	}
	if loaded.Window != config.Window || loaded.Logs.LogLevel.Active != settings.LogLevelDebug || loaded.Logs.StoreDays != 7 || loaded.Updater.Enabled || loaded.Preferences.Theme != "light" {
		t.Fatalf("saved preferences changed unrelated settings: %#v", loaded)
	}
}

func TestClientPreferencesBridgeShapeIncludesUpdaterSetting(t *testing.T) {
	preferences := clientPreferences{Preferences: settings.Defaults().Preferences, CheckForUpdates: true}
	data, err := json.Marshal(preferences)
	if err != nil {
		t.Fatal(err)
	}
	var decoded map[string]any
	if err := json.Unmarshal(data, &decoded); err != nil {
		t.Fatal(err)
	}
	if decoded["theme"] != "dark" || decoded["checkForUpdates"] != true {
		t.Fatalf("client preferences JSON = %s", data)
	}
}

func TestManualUpdateRequestIgnoresAutomaticTimestamp(t *testing.T) {
	root := t.TempDir()
	t.Setenv("APPDATA", root)
	if err := settings.Save(settings.Defaults()); err != nil {
		t.Fatal(err)
	}
	statePath := filepath.Join(root, "symmd", "last-update-check")
	if err := os.WriteFile(statePath, []byte("2999-01-01T00:00:00Z"), 0o600); err != nil {
		t.Fatal(err)
	}
	service := &fakeUpdateService{}
	application := &Application{updater: service}
	if result := application.checkApplicationUpdate(false); !result.OK || !result.Started {
		t.Fatalf("manual update check = %+v", result)
	}
	if service.checks != 1 {
		t.Fatalf("manual updater calls = %d, want 1", service.checks)
	}
}

func TestResolveLinkTargetUsesExistingLinkRules(t *testing.T) {
	document := filepath.Join(`C:\notes`, "README.md")
	parsed, target, err := resolveLinkTarget(document, "../shared/other%20file.md#section")
	if err != nil {
		t.Fatal(err)
	}
	if parsed.Fragment != "section" || target != filepath.Clean(`C:\shared\other file.md`) {
		t.Fatalf("resolveLinkTarget() = %#v, %q", parsed, target)
	}
	parsed, target, err = resolveLinkTarget(document, "https://example.com/files/readme.md")
	if err != nil || parsed.Scheme != "https" || target != "https://example.com/files/readme.md" {
		t.Fatalf("resolveLinkTarget(https) = %#v, %q, %v", parsed, target, err)
	}
	if _, _, err := resolveLinkTarget(document, "file:///C:/notes/secret.md"); err == nil {
		t.Fatal("file URL was not blocked")
	}
}

func TestLinkFileNameSanitizesURLName(t *testing.T) {
	parsed, err := url.Parse("https://example.com/files/report%20final.md?download=1")
	if err != nil {
		t.Fatal(err)
	}
	if got := linkFileName(parsed, parsed.String()); got != "report final.md" {
		t.Fatalf("linkFileName() = %q", got)
	}
	parsed, _ = url.Parse("https://example.com/")
	if got := linkFileName(parsed, parsed.String()); got != "download" {
		t.Fatalf("root linkFileName() = %q", got)
	}
}

func TestSaveLinkTargetCopiesLocalFileAndReplacesDestination(t *testing.T) {
	directory := t.TempDir()
	source := filepath.Join(directory, "source file.md")
	destination := filepath.Join(directory, "saved file.md")
	if err := os.WriteFile(source, []byte("new content"), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(destination, []byte("old content"), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := saveLinkTarget(&url.URL{}, source, destination); err != nil {
		t.Fatal(err)
	}
	content, err := os.ReadFile(destination)
	if err != nil {
		t.Fatal(err)
	}
	if string(content) != "new content" {
		t.Fatalf("saved content = %q", content)
	}
}

func TestSaveLinkTargetDownloadsHTTPLink(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(response http.ResponseWriter, request *http.Request) {
		if request.URL.Path != "/linked file.txt" {
			http.NotFound(response, request)
			return
		}
		_, _ = response.Write([]byte("downloaded content"))
	}))
	defer server.Close()

	target := server.URL + "/linked%20file.txt"
	parsed, err := url.Parse(target)
	if err != nil {
		t.Fatal(err)
	}
	destination := filepath.Join(t.TempDir(), "downloaded file.txt")
	if err := saveLinkTarget(parsed, target, destination); err != nil {
		t.Fatal(err)
	}
	content, err := os.ReadFile(destination)
	if err != nil {
		t.Fatal(err)
	}
	if string(content) != "downloaded content" {
		t.Fatalf("downloaded content = %q", content)
	}
}

type fakeUpdateService struct {
	checks   int
	installs int
}

func (s *fakeUpdateService) StartCheck(context.Context) (updater.CheckResult, <-chan updater.CheckResult) {
	s.checks++
	results := make(chan updater.CheckResult, 1)
	results <- updater.CheckResult{OK: true}
	close(results)
	return updater.CheckResult{OK: true, Message: "update check started"}, results
}

func (s *fakeUpdateService) Install() updater.InstallResult {
	s.installs++
	return updater.InstallResult{OK: true}
}
