package webassets

import (
	"bytes"
	"crypto/sha256"
	"embed"
	"fmt"
	"io/fs"
	"os"
	"path"
	"path/filepath"
	"strings"
)

const (
	// Host is deliberately not a real network host. WebView2 maps it directly
	// to the extracted, trusted application bundle.
	Host = "app.symmd.local"
	URL  = "https://" + Host + "/index.html"
)

//go:embed dist
var files embed.FS

type Frontend struct {
	URL        string
	Directory  string
	Version    string
	FileCount  int
	TotalBytes int64
}

type embeddedAsset struct {
	name string
	data []byte
}

// Load extracts the trusted embedded application bundle into a versioned user
// cache directory. WebView2 NavigateToString has a 2 MiB limit, which Monaco
// exceeds, so the caller exposes this directory through virtual host mapping.
func Load() (Frontend, error) {
	cache, err := os.UserConfigDir()
	if err != nil {
		return Frontend{}, fmt.Errorf("locate user cache: %w", err)
	}
	return extractTo(filepath.Join(cache, "symmd", "frontend"))
}

func extractTo(root string) (Frontend, error) {
	assets, version, totalBytes, err := readEmbeddedAssets()
	if err != nil {
		return Frontend{}, err
	}
	targetRoot := filepath.Join(root, version)
	for _, asset := range assets {
		relative := strings.TrimPrefix(path.Clean(asset.name), "dist/")
		if relative == "." || relative == "dist" || strings.HasPrefix(relative, "../") {
			return Frontend{}, fmt.Errorf("invalid embedded asset path %q", asset.name)
		}
		target := filepath.Join(targetRoot, filepath.FromSlash(relative))
		if err := os.MkdirAll(filepath.Dir(target), 0o700); err != nil {
			return Frontend{}, fmt.Errorf("create frontend asset directory: %w", err)
		}
		// Rewrite even an existing version directory. This makes a modified or
		// partially-written cache self-healing on the next launch.
		if err := os.WriteFile(target, asset.data, 0o600); err != nil {
			return Frontend{}, fmt.Errorf("extract frontend asset %q: %w", relative, err)
		}
	}
	if err := verifyExtracted(targetRoot, assets); err != nil {
		return Frontend{}, err
	}
	return Frontend{URL: URL, Directory: targetRoot, Version: version, FileCount: len(assets), TotalBytes: totalBytes}, nil
}

func readEmbeddedAssets() ([]embeddedAsset, string, int64, error) {
	hash := sha256.New()
	assets := make([]embeddedAsset, 0, 3)
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
		assets = append(assets, embeddedAsset{name: name, data: data})
		totalBytes += int64(len(data))
		return nil
	})
	if err != nil {
		return nil, "", 0, fmt.Errorf("read embedded frontend: %w", err)
	}
	if len(assets) == 0 {
		return nil, "", 0, fmt.Errorf("embedded frontend is empty")
	}
	return assets, fmt.Sprintf("%x", hash.Sum(nil)[:8]), totalBytes, nil
}

func verifyExtracted(root string, assets []embeddedAsset) error {
	for _, asset := range assets {
		relative := strings.TrimPrefix(path.Clean(asset.name), "dist/")
		actual, err := os.ReadFile(filepath.Join(root, filepath.FromSlash(relative)))
		if err != nil {
			return fmt.Errorf("verify extracted frontend asset %q: %w", relative, err)
		}
		if !bytes.Equal(actual, asset.data) {
			return fmt.Errorf("verify extracted frontend asset %q: content mismatch", relative)
		}
	}
	return nil
}
