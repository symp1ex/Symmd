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

func TestResourceDataURLResolvesRelativeParentAbsoluteAndEscapedPaths(t *testing.T) {
	dir := t.TempDir()
	documentDir := filepath.Join(dir, "docs")
	imageDir := filepath.Join(dir, "shared")
	if err := os.Mkdir(documentDir, 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.Mkdir(imageDir, 0o755); err != nil {
		t.Fatal(err)
	}
	doc := filepath.Join(documentDir, "README.md")
	png, err := base64.StdEncoding.DecodeString("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=")
	if err != nil {
		t.Fatal(err)
	}
	imagePath := filepath.Join(imageDir, "test image.png")
	if err := os.WriteFile(imagePath, png, 0o644); err != nil {
		t.Fatal(err)
	}
	for _, test := range []struct {
		name, documentPath, reference string
	}{
		{"parent relative", doc, "../shared/test%20image.png"},
		{"absolute slash path", "", filepath.ToSlash(imagePath)},
		{"absolute escaped backslash path", "", strings.ReplaceAll(imagePath, `\`, "%5C")},
	} {
		t.Run(test.name, func(t *testing.T) {
			dataURL, err := ResourceDataURL(test.documentPath, test.reference)
			if err != nil {
				t.Fatal(err)
			}
			if !strings.HasPrefix(dataURL, "data:image/png;base64,") || !strings.HasSuffix(dataURL, base64.StdEncoding.EncodeToString(png)) {
				t.Fatalf("unexpected data URL %q", dataURL)
			}
		})
	}
}

func TestResourceDataURLResolvesDotRelativePath(t *testing.T) {
	dir := t.TempDir()
	imageDir := filepath.Join(dir, "images")
	if err := os.Mkdir(imageDir, 0o755); err != nil {
		t.Fatal(err)
	}
	png, _ := base64.StdEncoding.DecodeString("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=")
	if err := os.WriteFile(filepath.Join(imageDir, "test.png"), png, 0o644); err != nil {
		t.Fatal(err)
	}
	if _, err := ResourceDataURL(filepath.Join(dir, "README.md"), "./images/test.png"); err != nil {
		t.Fatal(err)
	}
}

func TestResourceDataURLRejectsInvalidResources(t *testing.T) {
	dir := t.TempDir()
	doc := filepath.Join(dir, "README.md")
	invalidImage := filepath.Join(dir, "not-image.png")
	if err := os.WriteFile(invalidImage, []byte("not an image"), 0o644); err != nil {
		t.Fatal(err)
	}
	largeImage := filepath.Join(dir, "too-large.png")
	if err := os.WriteFile(largeImage, nil, 0o644); err != nil {
		t.Fatal(err)
	}
	if err := os.Truncate(largeImage, maxResourceSize+1); err != nil {
		t.Fatal(err)
	}
	for _, reference := range []string{"missing.png", "not-image.png", "too-large.png", ".", "https://example.com/image.png", "file:///C:/image.png", "javascript:alert(1)"} {
		if _, err := ResourceDataURL(doc, reference); err == nil {
			t.Fatalf("ResourceDataURL accepted %q", reference)
		}
	}
}

func TestResourceDataURLAcceptsValidSVG(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "image.svg")
	if err := os.WriteFile(path, []byte(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1 1"><rect width="1" height="1"/></svg>`), 0o644); err != nil {
		t.Fatal(err)
	}
	dataURL, err := ResourceDataURL("", path)
	if err != nil {
		t.Fatal(err)
	}
	if !strings.HasPrefix(dataURL, "data:image/svg+xml;base64,") {
		t.Fatalf("unexpected data URL %q", dataURL)
	}
}
