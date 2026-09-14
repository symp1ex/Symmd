//go:build windows

package window

import (
	"runtime"
	"testing"
	"unicode/utf16"
	"unsafe"
)

func TestOpenFileNameAMD64Layout(t *testing.T) {
	if runtime.GOARCH != "amd64" {
		t.Skip("OPENFILENAMEW x64 layout only")
	}
	dialog := openFileName{}
	if size := unsafe.Sizeof(dialog); size != 152 {
		t.Fatalf("OPENFILENAMEW size = %d, want 152", size)
	}
	offsets := map[string]struct {
		got  uintptr
		want uintptr
	}{
		"owner":            {unsafe.Offsetof(dialog.owner), 8},
		"filter":           {unsafe.Offsetof(dialog.filter), 24},
		"file":             {unsafe.Offsetof(dialog.file), 48},
		"title":            {unsafe.Offsetof(dialog.title), 88},
		"flags":            {unsafe.Offsetof(dialog.flags), 96},
		"defaultExtension": {unsafe.Offsetof(dialog.defaultExtension), 104},
		"reserved":         {unsafe.Offsetof(dialog.reserved), 136},
		"flagsEx":          {unsafe.Offsetof(dialog.flagsEx), 148},
	}
	for name, offset := range offsets {
		if offset.got != offset.want {
			t.Errorf("OPENFILENAMEW %s offset = %d, want %d", name, offset.got, offset.want)
		}
	}
}

func TestMarkdownDialogFilterUsesEmbeddedAndDoubleTrailingNUL(t *testing.T) {
	filter := markdownDialogFilter()
	if len(filter) < 2 || filter[len(filter)-1] != 0 || filter[len(filter)-2] != 0 {
		t.Fatalf("filter is not double-NUL terminated: %v", filter)
	}
	decoded := string(utf16.Decode(filter[:len(filter)-2]))
	want := "Markdown files (*.md;*.markdown)\x00*.md;*.markdown\x00All files (*.*)\x00*.*"
	if decoded != want {
		t.Fatalf("filter = %q, want %q", decoded, want)
	}
}

func TestEnsureMarkdownExtension(t *testing.T) {
	tests := map[string]string{
		`C:\notes\draft`:          `C:\notes\draft.md`,
		`C:\notes\draft.md`:       `C:\notes\draft.md`,
		`C:\notes\draft.markdown`: `C:\notes\draft.markdown`,
		`C:\notes\draft.txt`:      `C:\notes\draft.txt`,
	}
	for input, want := range tests {
		if got := ensureMarkdownExtension(input); got != want {
			t.Errorf("ensureMarkdownExtension(%q) = %q, want %q", input, got, want)
		}
	}
}
