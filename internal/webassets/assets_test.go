package webassets

import (
	"bytes"
	"io/fs"
	"os"
	"path"
	"path/filepath"
	"strings"
	"testing"

	webview "github.com/symp1ex/go-webview2"
)

func TestLoadReturnsEmbeddedMetadataWithoutCreatingFrontendCache(t *testing.T) {
	appData := t.TempDir()
	t.Setenv("APPDATA", appData)

	bundle, err := Load()
	if err != nil {
		t.Fatal(err)
	}
	if bundle.URL != URL || bundle.Version == "" || bundle.FileCount == 0 || bundle.TotalBytes == 0 {
		t.Fatalf("unexpected frontend metadata: %+v", bundle)
	}
	cache := filepath.Join(appData, "symmd", "cache", "frontend")
	if _, err := os.Stat(cache); !os.IsNotExist(err) {
		t.Fatalf("frontend cache exists after Load: %v", err)
	}
}

func TestHandleWebResourceServesIndex(t *testing.T) {
	bundle := loadFrontend(t)
	response := handle(t, bundle, URL)
	want, err := files.ReadFile("dist/index.html")
	if err != nil {
		t.Fatal(err)
	}
	assertResponse(t, response, 200, "OK", "text/html")
	if !bytes.Equal(response.Content, want) {
		t.Fatal("index response differs from embedded bytes")
	}
}

func TestHandleWebResourceServesJavaScript(t *testing.T) {
	testEmbeddedAsset(t, ".js", "text/javascript")
}

func TestHandleWebResourceServesCSS(t *testing.T) {
	testEmbeddedAsset(t, ".css", "text/css")
}

func TestHandleWebResourcePreservesBinaryAsset(t *testing.T) {
	name := findEmbeddedAsset(t, ".png", ".ico", ".woff", ".woff2", ".wasm")
	if name == "" {
		t.Skip("production bundle contains no separate binary asset")
	}
	bundle := loadFrontend(t)
	response := handle(t, bundle, assetURL(name))
	want, err := files.ReadFile(name)
	if err != nil {
		t.Fatal(err)
	}
	if !bytes.Equal(response.Content, want) {
		t.Fatal("binary response differs from embedded bytes")
	}
}

func TestHandleWebResourceReturnsNotFoundForMissingInternalResource(t *testing.T) {
	bundle := loadFrontend(t)
	for _, uri := range []string{
		"https://app.symmd.local/does-not-exist",
		"https://app.symmd.local/assets",
	} {
		response := handle(t, bundle, uri)
		assertResponse(t, response, 404, "Not Found", "text/plain")
	}
}

func TestHandleWebResourceLeavesForeignOriginsUnhandled(t *testing.T) {
	bundle := loadFrontend(t)
	for _, uri := range []string{
		"https://example.com/app.js",
		"http://app.symmd.local/index.html",
		"https://app.symmd.local:443/index.html",
		"https://app.symmd.local.example/index.html",
	} {
		response, err := bundle.HandleWebResource(webview.WebResourceRequest{URI: uri})
		if err != nil {
			t.Fatalf("HandleWebResource(%q) returned an error: %v", uri, err)
		}
		if response != nil {
			t.Fatalf("HandleWebResource(%q) returned %#v, want unhandled", uri, response)
		}
	}
}

func TestHandleWebResourceMapsRootToIndex(t *testing.T) {
	bundle := loadFrontend(t)
	index := handle(t, bundle, URL)
	for _, uri := range []string{"https://app.symmd.local", "https://app.symmd.local/"} {
		root := handle(t, bundle, uri)
		if !bytes.Equal(root.Content, index.Content) || root.Headers != index.Headers {
			t.Fatalf("root response for %q differs from index response", uri)
		}
	}
}

func TestHandleWebResourceIgnoresQueryAndFragment(t *testing.T) {
	name := findEmbeddedAsset(t, ".js")
	if name == "" {
		t.Fatal("production bundle has no JavaScript asset")
	}
	bundle := loadFrontend(t)
	plain := handle(t, bundle, assetURL(name))
	qualified := handle(t, bundle, assetURL(name)+"?v=123#fragment")
	if !bytes.Equal(plain.Content, qualified.Content) || plain.Headers != qualified.Headers {
		t.Fatal("query or fragment changed embedded resource lookup")
	}
}

func TestHandleWebResourceRejectsAmbiguousAndTraversalPaths(t *testing.T) {
	bundle := loadFrontend(t)
	paths := []string{
		"/../index.html",
		"/./index.html",
		"/%2e%2e/index.html",
		"/%2e/index.html",
		"/assets%2f..%2findex.html",
		`/assets\..\index.html`,
		"/assets%5c..%5cindex.html",
		"//index.html",
		"/assets//app.js",
	}
	for _, requestPath := range paths {
		response := handle(t, bundle, "https://app.symmd.local"+requestPath)
		if response.StatusCode != 404 {
			t.Fatalf("path %q returned %d, want 404", requestPath, response.StatusCode)
		}
	}
}

func testEmbeddedAsset(t *testing.T, extension, contentTypePart string) {
	t.Helper()
	name := findEmbeddedAsset(t, extension)
	if name == "" {
		t.Skipf("production bundle contains no %s asset", extension)
	}
	bundle := loadFrontend(t)
	response := handle(t, bundle, assetURL(name))
	want, err := files.ReadFile(name)
	if err != nil {
		t.Fatal(err)
	}
	assertResponse(t, response, 200, "OK", contentTypePart)
	if !bytes.Equal(response.Content, want) {
		t.Fatalf("%s response differs from embedded bytes", extension)
	}
}

func loadFrontend(t *testing.T) Frontend {
	t.Helper()
	bundle, err := Load()
	if err != nil {
		t.Fatal(err)
	}
	return bundle
}

func handle(t *testing.T, bundle Frontend, uri string) *webview.WebResourceResponse {
	t.Helper()
	response, err := bundle.HandleWebResource(webview.WebResourceRequest{URI: uri})
	if err != nil {
		t.Fatalf("HandleWebResource(%q) returned an error: %v", uri, err)
	}
	if response == nil {
		t.Fatalf("HandleWebResource(%q) left an internal request unhandled", uri)
	}
	return response
}

func assertResponse(t *testing.T, response *webview.WebResourceResponse, statusCode int, reasonPhrase, contentTypePart string) {
	t.Helper()
	if response.StatusCode != statusCode || response.ReasonPhrase != reasonPhrase {
		t.Fatalf("response status = %d %q, want %d %q", response.StatusCode, response.ReasonPhrase, statusCode, reasonPhrase)
	}
	if !strings.Contains(strings.ToLower(response.Headers), "content-type: "+strings.ToLower(contentTypePart)) {
		t.Fatalf("response headers %q do not contain Content-Type %q", response.Headers, contentTypePart)
	}
	for _, header := range []string{"X-Content-Type-Options: nosniff", "Cache-Control: no-store"} {
		if !strings.Contains(response.Headers, header) {
			t.Fatalf("response headers %q do not contain %q", response.Headers, header)
		}
	}
}

func findEmbeddedAsset(t *testing.T, extensions ...string) string {
	t.Helper()
	var found string
	err := fs.WalkDir(files, "dist", func(name string, entry fs.DirEntry, walkErr error) error {
		if walkErr != nil {
			return walkErr
		}
		if entry.IsDir() {
			return nil
		}
		for _, extension := range extensions {
			if strings.EqualFold(path.Ext(name), extension) {
				found = name
				return fs.SkipAll
			}
		}
		return nil
	})
	if err != nil {
		t.Fatal(err)
	}
	return found
}

func assetURL(name string) string {
	return "https://" + Host + "/" + strings.TrimPrefix(name, "dist/")
}
