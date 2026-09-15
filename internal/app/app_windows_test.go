//go:build windows

package app

import (
	"net/http"
	"net/http/httptest"
	"net/url"
	"os"
	"path/filepath"
	"testing"

	"github.com/symp1ex/symmd/internal/settings"
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
