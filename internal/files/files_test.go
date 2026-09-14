package files

import (
	"encoding/base64"
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestReadStripsUTF8BOMAndWriteRoundTrips(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "тест file.md")
	if err := os.WriteFile(path, append([]byte{0xef, 0xbb, 0xbf}, []byte("# hello")...), 0o644); err != nil {
		t.Fatal(err)
	}
	file, err := Read(path)
	if err != nil || file.Content != "# hello" {
		t.Fatalf("Read() = %#v, %v", file, err)
	}
	file, err = Write(path, "changed")
	if err != nil || file.Content != "changed" || file.ModifiedNS == 0 {
		t.Fatalf("Write() = %#v, %v", file, err)
	}
}

func TestMarkdownFileBridgeJSONShape(t *testing.T) {
	data, err := json.Marshal(MarkdownFile{Path: `C:\notes\README.md`, Name: "README.md", Content: "# hi", ModifiedNS: 42})
	if err != nil {
		t.Fatal(err)
	}
	var value map[string]any
	if err := json.Unmarshal(data, &value); err != nil {
		t.Fatal(err)
	}
	for _, key := range []string{"path", "name", "content", "modifiedNs"} {
		if _, ok := value[key]; !ok {
			t.Fatalf("bridge JSON is missing %q: %s", key, data)
		}
	}
}

func TestResourceDataURLStaysWithinDocumentDirectory(t *testing.T) {
	dir := t.TempDir()
	doc := filepath.Join(dir, "README.md")
	imageDir := filepath.Join(dir, "images")
	if err := os.Mkdir(imageDir, 0o755); err != nil {
		t.Fatal(err)
	}
	png := []byte{0x89, 'P', 'N', 'G'}
	if err := os.WriteFile(filepath.Join(imageDir, "test.png"), png, 0o644); err != nil {
		t.Fatal(err)
	}
	dataURL, err := ResourceDataURL(doc, "./images/test.png")
	if err != nil {
		t.Fatal(err)
	}
	if !strings.HasSuffix(dataURL, base64.StdEncoding.EncodeToString(png)) {
		t.Fatalf("unexpected data URL %q", dataURL)
	}
	if _, err := ResourceDataURL(doc, "../outside.png"); err == nil {
		t.Fatal("path traversal was accepted")
	}
}
