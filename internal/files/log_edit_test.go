package files

import (
	"bytes"
	"context"
	"errors"
	"io"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"sync/atomic"
	"testing"
	"time"
)

type failingLogWriter struct{}

func (failingLogWriter) Write([]byte) (int, error) { return 0, io.ErrClosedPipe }

func logBytes(t *testing.T, s *LogStore, handle uint64, expected string) {
	t.Helper()
	e, err := s.entry(handle)
	if err != nil {
		t.Fatal(err)
	}
	e.mu.Lock()
	defer e.mu.Unlock()
	buffer := make([]byte, len(expected))
	if len(buffer) > 0 {
		if n, err := e.readLogicalAt(buffer, 0); err != nil || n != len(buffer) {
			t.Fatalf("read = %d, %v", n, err)
		}
	}
	if string(buffer) != expected || e.info.Size != int64(len(expected)) {
		t.Fatalf("logical bytes = %q, size %d; want %q", buffer, e.info.Size, expected)
	}
}

func TestLogPieceEditsAndHistory(t *testing.T) {
	for _, tc := range []struct {
		name, before, after, insert string
		start, end                  int64
	}{
		{"empty", "", "x", "x", 0, 0},
		{"insert start", "abc", "Xabc", "X", 0, 0},
		{"insert middle", "abc", "aXbc", "X", 1, 1},
		{"insert end", "abc", "abcX", "X", 3, 3},
		{"delete start", "abc", "bc", "", 0, 1},
		{"delete middle", "abc", "ac", "", 1, 2},
		{"delete end", "abc", "ab", "", 2, 3},
		{"replace", "abc", "aXYc", "XY", 1, 2},
		{"unicode", "aб😀z", "aЖ😀z", "Ж", 1, 3},
		{"CRLF", "a\r\nb\r\n", "a\r\nXb\r\n", "X", 3, 3},
		{"LF", "a\nb\n", "a\nXb\n", "X", 2, 2},
	} {
		t.Run(tc.name, func(t *testing.T) {
			s, info := testLog(t, tc.before)
			result, err := s.Replace(info.Handle, tc.start, tc.end, tc.insert)
			if err != nil || !result.Dirty {
				t.Fatalf("replace: %#v, %v", result, err)
			}
			logBytes(t, s, info.Handle, tc.after)
			undone, err := s.Undo(info.Handle)
			if err != nil || undone.Dirty {
				t.Fatalf("undo: %#v, %v", undone, err)
			}
			logBytes(t, s, info.Handle, tc.before)
			redone, err := s.Redo(info.Handle)
			if err != nil || !redone.Dirty {
				t.Fatalf("redo: %#v, %v", redone, err)
			}
			logBytes(t, s, info.Handle, tc.after)
		})
	}
}

func TestLogPieceCrossingsAndRedoBranch(t *testing.T) {
	s, info := testLog(t, "abcdef")
	for _, edit := range []struct {
		start, end int64
		text       string
	}{{2, 2, "XY"}, {3, 4, "Q"}, {1, 6, "!"}} {
		if _, err := s.Replace(info.Handle, edit.start, edit.end, edit.text); err != nil {
			t.Fatal(err)
		}
	}
	logBytes(t, s, info.Handle, "a!ef")
	if _, err := s.Undo(info.Handle); err != nil {
		t.Fatal(err)
	}
	logBytes(t, s, info.Handle, "abXQcdef")
	if _, err := s.Undo(info.Handle); err != nil {
		t.Fatal(err)
	}
	logBytes(t, s, info.Handle, "abXYcdef")
	if _, err := s.Replace(info.Handle, 3, 5, "!"); err != nil {
		t.Fatal(err)
	}
	logBytes(t, s, info.Handle, "abX!def")
	if _, err := s.Redo(info.Handle); err != nil {
		t.Fatal(err)
	}
	logBytes(t, s, info.Handle, "abX!def")
	if _, err := s.Replace(info.Handle, 0, 0, ""); err != nil {
		t.Fatal(err)
	}
	logBytes(t, s, info.Handle, "abX!def")
}

func TestLogReadAcrossPieceBoundaryAndReadBefore(t *testing.T) {
	s, info := testLog(t, "one\ntwo\n")
	if _, err := s.Replace(info.Handle, 4, 4, "Ж\n"); err != nil {
		t.Fatal(err)
	}
	e, _ := s.entry(info.Handle)
	e.mu.Lock()
	buffer := make([]byte, len("e\nЖ\nt"))
	n, err := e.readLogicalAt(buffer, 2)
	e.mu.Unlock()
	if err != nil || n != len(buffer) || string(buffer) != "e\nЖ\nt" {
		t.Fatalf("cross-piece read: %q, %d, %v", buffer, n, err)
	}
	chunk, err := s.Read(info.Handle, 0, false)
	if err != nil || len(chunk.Lines) != 3 || chunk.Lines[1].Text != "Ж" {
		t.Fatalf("forward: %#v, %v", chunk, err)
	}
	before, err := s.ReadBefore(info.Handle, int64(len("one\nЖ\n")))
	if err != nil || len(before.Lines) != 2 || before.Lines[1].Text != "Ж" {
		t.Fatalf("before: %#v, %v", before, err)
	}
}

func waitLogSave(t *testing.T, s *LogStore, handle, id uint64) LogSaveResult {
	t.Helper()
	deadline := time.Now().Add(5 * time.Second)
	for {
		result, err := s.PollSave(handle, id)
		if err != nil {
			t.Fatal(err)
		}
		if result.Done {
			return result
		}
		if time.Now().After(deadline) {
			t.Fatal("save did not finish")
		}
		time.Sleep(time.Millisecond)
	}
}

func TestLogStreamingSaveAndSaveAs(t *testing.T) {
	for _, tc := range []struct {
		before, after string
		edits         []struct {
			start, end int64
			text       string
		}
	}{
		{"abc", "abc", nil},
		{"abc", "aXbc", []struct {
			start, end int64
			text       string
		}{{1, 1, "X"}}},
		{"abc", "ac", []struct {
			start, end int64
			text       string
		}{{1, 2, ""}}},
		{"abc", "aЖc", []struct {
			start, end int64
			text       string
		}{{1, 2, "Ж"}}},
		{"abc", "", []struct {
			start, end int64
			text       string
		}{{0, 3, ""}}},
		{"a\r\nb\n", "Xа\r\nb\n", []struct {
			start, end int64
			text       string
		}{{0, 1, "Xа"}}},
	} {
		s, info := testLog(t, tc.before)
		for _, edit := range tc.edits {
			if _, err := s.Replace(info.Handle, edit.start, edit.end, edit.text); err != nil {
				t.Fatal(err)
			}
		}
		id, err := s.StartSave(info.Handle, "")
		if err != nil {
			t.Fatal(err)
		}
		result := waitLogSave(t, s, info.Handle, id)
		if result.Error != "" || result.Info == nil || result.Info.Dirty {
			t.Fatalf("save: %#v", result)
		}
		physical, err := os.ReadFile(info.Path)
		if err != nil || !bytes.Equal(physical, []byte(tc.after)) {
			t.Fatalf("physical = %q, %v; want %q", physical, err, tc.after)
		}
		window, err := s.ReadWindow(info.Handle, 0)
		if err != nil || window.Text != tc.after || window.Size != int64(len(tc.after)) {
			t.Fatalf("saved handle = %#v, %v", window, err)
		}
	}
	s, info := testLog(t, "old")
	if _, err := s.Replace(info.Handle, 3, 3, "new"); err != nil {
		t.Fatal(err)
	}
	destination := filepath.Join(t.TempDir(), "saved.log")
	id, err := s.StartSave(info.Handle, destination)
	if err != nil {
		t.Fatal(err)
	}
	result := waitLogSave(t, s, info.Handle, id)
	if result.Error != "" || result.Info.Path != destination {
		t.Fatalf("save as: %#v", result)
	}
	original, _ := os.ReadFile(info.Path)
	saved, _ := os.ReadFile(destination)
	if string(original) != "old" || string(saved) != "oldnew" {
		t.Fatalf("original %q, saved %q", original, saved)
	}
}

func TestLogSaveFailurePreservesOriginalAndDirty(t *testing.T) {
	s, info := testLog(t, "original")
	if _, err := s.Replace(info.Handle, 0, 0, "edit"); err != nil {
		t.Fatal(err)
	}
	id, err := s.StartSave(info.Handle, filepath.Join(info.Path, "impossible.log"))
	if err != nil {
		t.Fatal(err)
	}
	result := waitLogSave(t, s, info.Handle, id)
	if result.Error == "" {
		t.Fatal("expected save error")
	}
	physical, _ := os.ReadFile(info.Path)
	state, _ := s.Stat(info.Handle)
	if string(physical) != "original" || !state.Dirty {
		t.Fatalf("original %q, state %#v", physical, state)
	}
}

func TestLogStreamingWriteErrorDoesNotTouchOriginal(t *testing.T) {
	s, info := testLog(t, "original")
	if _, err := s.Replace(info.Handle, 0, 0, "edit"); err != nil {
		t.Fatal(err)
	}
	e, _ := s.entry(info.Handle)
	e.mu.Lock()
	err := streamLogPieces(context.Background(), e.root, e.file, e.add, failingLogWriter{}, &atomic.Int64{})
	e.mu.Unlock()
	if !errors.Is(err, io.ErrClosedPipe) {
		t.Fatalf("write error = %v", err)
	}
	physical, readErr := os.ReadFile(info.Path)
	if readErr != nil || string(physical) != "original" {
		t.Fatalf("original = %q, %v", physical, readErr)
	}
	state, _ := s.Stat(info.Handle)
	if !state.Dirty {
		t.Fatal("failed stream cleared dirty state")
	}
}

func TestLogCanceledSaveRemovesPartialOutput(t *testing.T) {
	s, info := testLog(t, "original")
	if _, err := s.Replace(info.Handle, 0, 0, "edit"); err != nil {
		t.Fatal(err)
	}
	e, _ := s.entry(info.Handle)
	e.mu.Lock()
	root, original, add, identity := e.root, e.file, e.add, e.identity
	size, modified := e.snapshotSize, e.snapshotNS
	e.mu.Unlock()
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	_, err := saveLogPieces(ctx, root, original, add, info.Path, info.Path, identity, size, modified, &atomic.Int64{})
	if !errors.Is(err, context.Canceled) {
		t.Fatalf("cancel = %v", err)
	}
	partials, err := filepath.Glob(filepath.Join(filepath.Dir(info.Path), ".symmd-log-save-*"))
	if err != nil || len(partials) != 0 {
		t.Fatalf("partial outputs = %v, %v", partials, err)
	}
	physical, _ := os.ReadFile(info.Path)
	if string(physical) != "original" {
		t.Fatalf("original = %q", physical)
	}
}

func TestLogExternalModificationRejectsSave(t *testing.T) {
	s, info := testLog(t, "original")
	if _, err := s.Replace(info.Handle, 0, 0, "edit"); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(info.Path, []byte("external change"), 0o644); err != nil {
		t.Fatal(err)
	}
	if _, err := s.StartSave(info.Handle, ""); err == nil {
		t.Fatal("save overwrote an external edit")
	}
	physical, _ := os.ReadFile(info.Path)
	state, _ := s.Stat(info.Handle)
	if string(physical) != "external change" || !state.Dirty {
		t.Fatalf("physical %q; state %#v", physical, state)
	}
}

func TestLogEditedSearchAndCountAcrossPieces(t *testing.T) {
	s, info := testLog(t, "ab\nremoved\n")
	if _, err := s.Replace(info.Handle, 2, 10, "Ж"); err != nil {
		t.Fatal(err)
	}
	if _, err := s.Replace(info.Handle, 1, 1, "c"); err != nil {
		t.Fatal(err)
	}
	for _, query := range []string{"bЖ", "Ж"} {
		found, err := s.Find(info.Handle, query, 0, false)
		if err != nil || found < 0 {
			t.Fatalf("find %q = %d, %v", query, found, err)
		}
		id, err := s.StartCount(info.Handle, query)
		if err != nil {
			t.Fatal(err)
		}
		if result := waitLogCount(t, s, info.Handle, id, found); result.Total != 1 || result.Ordinal != 1 {
			t.Fatalf("count %q: %#v", query, result)
		}
	}
	if found, _ := s.Find(info.Handle, "removed", 0, false); found >= 0 {
		t.Fatalf("deleted text found at %d", found)
	}
}

func TestLogPreservesHiddenLongLineAndInvalidUTF8(t *testing.T) {
	data := append([]byte("before\n"+strings.Repeat("x", logReadSize+100)+"\n"), 0xff, 0xfe, '\n')
	path := filepath.Join(t.TempDir(), "invalid.log")
	if err := os.WriteFile(path, data, 0o644); err != nil {
		t.Fatal(err)
	}
	s := &LogStore{}
	info, err := s.Open(path)
	if err != nil {
		t.Fatal(err)
	}
	defer s.CloseAll()
	if _, err := s.Replace(info.Handle, 0, 0, "edit\n"); err != nil {
		t.Fatal(err)
	}
	id, err := s.StartSave(info.Handle, "")
	if err != nil {
		t.Fatal(err)
	}
	if result := waitLogSave(t, s, info.Handle, id); result.Error != "" {
		t.Fatal(result.Error)
	}
	physical, err := os.ReadFile(path)
	if err != nil || !bytes.Equal(physical, append([]byte("edit\n"), data...)) {
		t.Fatal("hidden or invalid bytes changed")
	}
}

func TestSparseLargeLogEditsUseBoundedHeap(t *testing.T) {
	path := filepath.Join(t.TempDir(), "large.log")
	f, err := os.Create(path)
	if err != nil {
		t.Fatal(err)
	}
	const size = int64(50) << 30
	if err := f.Truncate(size); err != nil {
		f.Close()
		t.Skipf("sparse file unavailable: %v", err)
	}
	f.Close()
	runtime.GC()
	var before, after runtime.MemStats
	runtime.ReadMemStats(&before)
	s := &LogStore{}
	info, err := s.Open(path)
	if err != nil {
		t.Fatal(err)
	}
	defer s.CloseAll()
	for _, offset := range []int64{0, 5 << 30, size - 1} {
		if _, err := s.Replace(info.Handle, offset, offset, "X"); err != nil {
			t.Fatal(err)
		}
	}
	window, err := s.ReadWindow(info.Handle, 5<<30)
	if err != nil || !strings.Contains(window.Text, "X") {
		t.Fatalf("large window: %v", err)
	}
	runtime.ReadMemStats(&after)
	if after.Alloc > before.Alloc+(16<<20) {
		t.Fatalf("heap grew by %d bytes", after.Alloc-before.Alloc)
	}
	for _, offset := range []int64{0, 5 << 30, size + 1} {
		window, err := s.ReadWindow(info.Handle, offset)
		if err != nil || window.Size != size+3 {
			t.Fatalf("window at %d: size %d, %v", offset, window.Size, err)
		}
	}
	for _, offset := range []int64{0, 5 << 30, size - 1} {
		e, _ := s.entry(info.Handle)
		e.mu.Lock()
		buffer := []byte{0}
		_, err := e.readLogicalAt(buffer, offset)
		e.mu.Unlock()
		if err != nil || buffer[0] != 'X' {
			t.Fatalf("read at %d = %q, %v", offset, buffer, err)
		}
	}
	for range 3 {
		if _, err := s.Undo(info.Handle); err != nil {
			t.Fatal(err)
		}
	}
	undone, err := s.Stat(info.Handle)
	if err != nil || undone.Size != size || undone.Dirty {
		t.Fatalf("undo large edits: %#v, %v", undone, err)
	}
	for range 3 {
		if _, err := s.Redo(info.Handle); err != nil {
			t.Fatal(err)
		}
	}
	redone, err := s.Stat(info.Handle)
	if err != nil || redone.Size != size+3 || !redone.Dirty {
		t.Fatalf("redo large edits: %#v, %v", redone, err)
	}
}
