package webassets

import (
	"os"
	"path/filepath"
	"testing"
)

func TestExtractToProducesVerifiedVirtualHostBundle(t *testing.T) {
	bundle, err := extractTo(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	if bundle.URL != URL {
		t.Fatalf("unexpected frontend URL %q", bundle.URL)
	}
	if bundle.Version == "" || bundle.FileCount != 3 || bundle.TotalBytes <= 2<<20 {
		t.Fatalf("unexpected frontend metadata: %+v", bundle)
	}
	for _, relative := range []string{"index.html", "assets/app.js", "assets/style.css"} {
		if _, err := os.Stat(filepath.Join(bundle.Directory, filepath.FromSlash(relative))); err != nil {
			t.Fatalf("missing extracted asset %q: %v", relative, err)
		}
	}
}

func TestExtractToRepairsStaleCache(t *testing.T) {
	root := t.TempDir()
	first, err := extractTo(root)
	if err != nil {
		t.Fatal(err)
	}
	script := filepath.Join(first.Directory, "assets", "app.js")
	if err := os.WriteFile(script, []byte("stale"), 0o600); err != nil {
		t.Fatal(err)
	}
	second, err := extractTo(root)
	if err != nil {
		t.Fatal(err)
	}
	if first.Directory != second.Directory {
		t.Fatalf("same embedded bundle changed cache directory: %q != %q", first.Directory, second.Directory)
	}
	data, err := os.ReadFile(script)
	if err != nil {
		t.Fatal(err)
	}
	if string(data) == "stale" {
		t.Fatal("stale cached asset was not repaired")
	}
}
