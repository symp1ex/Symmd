//go:build windows

package app

import (
	"os"
	"path/filepath"
	"testing"
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

func TestLoadInitialRejectsUnsupportedDocument(t *testing.T) {
	if file, err := LoadInitial([]string{"notes.txt"}); err == nil || file != nil {
		t.Fatalf("LoadInitial() = %#v, %v", file, err)
	}
}
