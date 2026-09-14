package files

import (
	"encoding/base64"
	"errors"
	"fmt"
	"mime"
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
	if documentPath == "" {
		return "", errors.New("save the document before using relative resources")
	}
	parsed, err := url.Parse(reference)
	if err != nil {
		return "", fmt.Errorf("parse resource reference: %w", err)
	}
	if parsed.IsAbs() || parsed.Host != "" || parsed.Path == "" {
		return "", errors.New("only local relative resources are supported")
	}
	decodedPath, err := url.PathUnescape(parsed.Path)
	if err != nil {
		return "", fmt.Errorf("decode resource path: %w", err)
	}
	base, err := filepath.Abs(filepath.Dir(documentPath))
	if err != nil {
		return "", fmt.Errorf("resolve document directory: %w", err)
	}
	target, err := filepath.Abs(filepath.Join(base, filepath.FromSlash(decodedPath)))
	if err != nil {
		return "", fmt.Errorf("resolve resource: %w", err)
	}
	rel, err := filepath.Rel(base, target)
	if err != nil || rel == ".." || strings.HasPrefix(rel, ".."+string(filepath.Separator)) {
		return "", errors.New("resource escapes the document directory")
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
	mediaType := mime.TypeByExtension(strings.ToLower(filepath.Ext(target)))
	if !strings.HasPrefix(mediaType, "image/") {
		return "", errors.New("only image resources are supported")
	}
	return "data:" + mediaType + ";base64," + base64.StdEncoding.EncodeToString(data), nil
}

func ModifiedAfter(state FileState, known int64) bool {
	return state.Exists && state.ModifiedNS > known+int64(10*time.Millisecond)
}
