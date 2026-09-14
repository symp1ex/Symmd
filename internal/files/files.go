package files

import (
	"bytes"
	"encoding/base64"
	"encoding/xml"
	"errors"
	"fmt"
	"mime"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"strings"
	"time"
)

const maxResourceSize = 25 << 20

type MarkdownFile struct {
	Path       string `json:"path"`
	Name       string `json:"name"`
	Content    string `json:"content"`
	ModifiedNS int64  `json:"modifiedNs"`
}

type FileState struct {
	Exists     bool  `json:"exists"`
	ModifiedNS int64 `json:"modifiedNs"`
}

func IsSupportedDocument(path string) bool {
	switch strings.ToLower(filepath.Ext(path)) {
	case ".md", ".markdown", ".log":
		return true
	default:
		return false
	}
}

func Read(path string) (MarkdownFile, error) {
	abs, err := filepath.Abs(path)
	if err != nil {
		return MarkdownFile{}, fmt.Errorf("resolve path: %w", err)
	}
	data, err := os.ReadFile(abs)
	if err != nil {
		return MarkdownFile{}, fmt.Errorf("read %q: %w", abs, err)
	}
	if len(data) >= 3 && data[0] == 0xef && data[1] == 0xbb && data[2] == 0xbf {
		data = data[3:]
	}
	info, err := os.Stat(abs)
	if err != nil {
		return MarkdownFile{}, fmt.Errorf("stat %q: %w", abs, err)
	}
	return MarkdownFile{Path: abs, Name: filepath.Base(abs), Content: string(data), ModifiedNS: info.ModTime().UnixNano()}, nil
}

func Write(path, content string) (MarkdownFile, error) {
	abs, err := filepath.Abs(path)
	if err != nil {
		return MarkdownFile{}, fmt.Errorf("resolve path: %w", err)
	}
	if err := os.WriteFile(abs, []byte(content), 0o644); err != nil {
		return MarkdownFile{}, fmt.Errorf("write %q: %w", abs, err)
	}
	return Read(abs)
}

func State(path string) (FileState, error) {
	info, err := os.Stat(path)
	if errors.Is(err, os.ErrNotExist) {
		return FileState{}, nil
	}
	if err != nil {
		return FileState{}, fmt.Errorf("stat %q: %w", path, err)
	}
	return FileState{Exists: true, ModifiedNS: info.ModTime().UnixNano()}, nil
}

func ResourceDataURL(documentPath, reference string) (string, error) {
	parsed, err := url.Parse(reference)
	if err != nil {
		return "", fmt.Errorf("parse resource reference: %w", err)
	}
	resourcePath, windowsAbsolute, err := resourcePath(parsed)
	if err != nil {
		return "", err
	}
	localPath := filepath.FromSlash(resourcePath)
	if !windowsAbsolute && !filepath.IsAbs(localPath) {
		if documentPath == "" {
			return "", errors.New("save the document before using relative resources")
		}
		localPath = filepath.Join(filepath.Dir(documentPath), localPath)
	}
	target, err := filepath.Abs(localPath)
	if err != nil {
		return "", fmt.Errorf("resolve resource: %w", err)
	}
	info, err := os.Stat(target)
	if err != nil {
		return "", fmt.Errorf("stat resource: %w", err)
	}
	if info.IsDir() || info.Size() > maxResourceSize {
		return "", errors.New("resource is not a file or is larger than 25 MiB")
	}
	data, err := os.ReadFile(target)
	if err != nil {
		return "", fmt.Errorf("read resource: %w", err)
	}
	mediaType, err := imageMediaType(target, data)
	if err != nil {
		return "", err
	}
	return "data:" + mediaType + ";base64," + base64.StdEncoding.EncodeToString(data), nil
}

func resourcePath(parsed *url.URL) (string, bool, error) {
	if len(parsed.Scheme) == 1 && ((parsed.Scheme[0] >= 'a' && parsed.Scheme[0] <= 'z') || (parsed.Scheme[0] >= 'A' && parsed.Scheme[0] <= 'Z')) {
		suffix := parsed.Path
		if parsed.Opaque != "" {
			var err error
			suffix, err = url.PathUnescape(parsed.Opaque)
			if err != nil {
				return "", false, fmt.Errorf("decode resource path: %w", err)
			}
		}
		if strings.HasPrefix(suffix, "/") || strings.HasPrefix(suffix, `\`) {
			return parsed.Scheme + ":" + suffix, true, nil
		}
	}
	if parsed.IsAbs() || parsed.Host != "" || parsed.Path == "" {
		return "", false, errors.New("only local filesystem resources are supported")
	}
	return parsed.Path, false, nil
}

func imageMediaType(path string, data []byte) (string, error) {
	mediaType, _, err := mime.ParseMediaType(mime.TypeByExtension(strings.ToLower(filepath.Ext(path))))
	if err != nil || !strings.HasPrefix(mediaType, "image/") {
		return "", errors.New("only image resources are supported")
	}
	detectedType, _, _ := mime.ParseMediaType(http.DetectContentType(data))
	if strings.HasPrefix(detectedType, "image/") || (mediaType == "image/svg+xml" && isSVG(data)) {
		return mediaType, nil
	}
	return "", errors.New("resource content is not an image")
}

func isSVG(data []byte) bool {
	decoder := xml.NewDecoder(bytes.NewReader(data))
	for {
		token, err := decoder.Token()
		if err != nil {
			return false
		}
		if start, ok := token.(xml.StartElement); ok {
			return start.Name.Local == "svg"
		}
	}
}

func ModifiedAfter(state FileState, known int64) bool {
	return state.Exists && state.ModifiedNS > known+int64(10*time.Millisecond)
}
