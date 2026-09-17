package webassets

import (
	"crypto/sha256"
	"embed"
	"errors"
	"fmt"
	"io/fs"
	"mime"
	"net/url"
	"path"
	"strings"

	webview "github.com/symp1ex/go-webview2"
)

const (
	// Host is deliberately not a real network host. Requests for this origin
	// are served directly from the trusted application bundle embedded below.
	Host = "app.symmd.local"
	URL  = "https://" + Host + "/index.html"
)

//go:embed dist
var files embed.FS

type Frontend struct {
	URL        string
	Version    string
	FileCount  int
	TotalBytes int64
}

// Load validates the trusted embedded application bundle and returns its
// diagnostic metadata. It does not materialize the bundle on the filesystem.
func Load() (Frontend, error) {
	version, fileCount, totalBytes, err := embeddedMetadata()
	if err != nil {
		return Frontend{}, err
	}
	return Frontend{URL: URL, Version: version, FileCount: fileCount, TotalBytes: totalBytes}, nil
}

// HandleWebResource serves requests for the trusted frontend origin directly
// from the executable. Requests for every other origin remain unhandled.
func (Frontend) HandleWebResource(request webview.WebResourceRequest) (*webview.WebResourceResponse, error) {
	requestURL, err := url.Parse(request.URI)
	if err != nil || requestURL.Scheme != "https" || requestURL.Host != Host || requestURL.User != nil || requestURL.Opaque != "" {
		return nil, nil
	}

	embeddedPath, valid := resourcePath(requestURL.Path)
	if !valid {
		return errorResponse(404, "Not Found"), nil
	}
	info, err := fs.Stat(files, embeddedPath)
	if errors.Is(err, fs.ErrNotExist) || err == nil && info.IsDir() {
		return errorResponse(404, "Not Found"), nil
	}
	if err != nil {
		return errorResponse(500, "Internal Server Error"), nil
	}
	content, err := files.ReadFile(embeddedPath)
	if err != nil {
		return errorResponse(500, "Internal Server Error"), nil
	}

	return &webview.WebResourceResponse{
		Content:      content,
		StatusCode:   200,
		ReasonPhrase: "OK",
		Headers:      responseHeaders(contentType(embeddedPath)),
	}, nil
}

func embeddedMetadata() (string, int, int64, error) {
	hash := sha256.New()
	fileCount := 0
	var totalBytes int64
	err := fs.WalkDir(files, "dist", func(name string, entry fs.DirEntry, walkErr error) error {
		if walkErr != nil {
			return walkErr
		}
		if entry.IsDir() {
			return nil
		}
		data, err := files.ReadFile(name)
		if err != nil {
			return err
		}
		_, _ = hash.Write([]byte(name))
		_, _ = hash.Write(data)
		fileCount++
		totalBytes += int64(len(data))
		return nil
	})
	if err != nil {
		return "", 0, 0, fmt.Errorf("read embedded frontend: %w", err)
	}
	if fileCount == 0 {
		return "", 0, 0, fmt.Errorf("embedded frontend is empty")
	}
	return fmt.Sprintf("%x", hash.Sum(nil)[:8]), fileCount, totalBytes, nil
}

func resourcePath(urlPath string) (string, bool) {
	if urlPath == "" || urlPath == "/" {
		return "dist/index.html", true
	}
	if !strings.HasPrefix(urlPath, "/") {
		return "", false
	}
	relative := strings.TrimPrefix(urlPath, "/")
	if strings.ContainsRune(relative, '\\') || !fs.ValidPath(relative) {
		return "", false
	}
	return "dist/" + relative, true
}

func contentType(name string) string {
	if value := mime.TypeByExtension(strings.ToLower(path.Ext(name))); value != "" {
		return value
	}
	return "application/octet-stream"
}

func errorResponse(statusCode int, reasonPhrase string) *webview.WebResourceResponse {
	return &webview.WebResourceResponse{
		Content:      []byte(reasonPhrase + "\n"),
		StatusCode:   statusCode,
		ReasonPhrase: reasonPhrase,
		Headers:      responseHeaders("text/plain; charset=utf-8"),
	}
}

func responseHeaders(contentType string) string {
	return "Content-Type: " + contentType + "\r\n" +
		"X-Content-Type-Options: nosniff\r\n" +
		"Cache-Control: no-store"
}
