package files

import (
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
	"time"
)

func testLog(t *testing.T, content string) (*LogStore, LogInfo) {
	t.Helper()
	path := filepath.Join(t.TempDir(), "runtime.log")
	if err := os.WriteFile(path, []byte(content), 0o644); err != nil {
		t.Fatal(err)
	}
	s := &LogStore{}
	info, err := s.Open(path)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = s.CloseAll() })
	return s, info
}

func TestLogReadBoundariesAndEncodings(t *testing.T) {
	s, info := testLog(t, "α\r\nβ\nthird\n")
	first, err := s.Read(info.Handle, 0, false)
	if err != nil {
		t.Fatal(err)
	}
	if len(first.Lines) != 3 || first.Lines[0].Text != "α" || first.Lines[1].Text != "β" || first.Lines[2].Text != "third" {
		t.Fatalf("lines: %#v", first.Lines)
	}
	middle, err := s.Read(info.Handle, 6, true)
	if err != nil || len(middle.Lines) == 0 || middle.Lines[0].Text != "β" {
		t.Fatalf("middle: %#v, %v", middle, err)
	}
	end, err := s.Read(info.Handle, info.Size-2, true)
	if err != nil || len(end.Lines) == 0 || end.Lines[0].Text != "third" {
		t.Fatalf("end: %#v, %v", end, err)
	}
	eof, err := s.Read(info.Handle, info.Size, false)
	if err != nil || len(eof.Lines) != 0 || eof.Next != info.Size {
		t.Fatalf("EOF: %#v, %v", eof, err)
	}
}

func TestLogReadLongLineAndChunkBoundary(t *testing.T) {
	s, info := testLog(t, strings.Repeat("x", logReadSize+100)+"\nend\n")
	first, err := s.Read(info.Handle, 0, false)
	if err != nil || len(first.Lines) != 1 || !first.Lines[0].Truncated || len(first.Lines[0].Text) != logLineLimit || first.Next != logReadSize {
		t.Fatalf("first: %#v, %v", first, err)
	}
	second, err := s.Read(info.Handle, first.Next, false)
	if err != nil || len(second.Lines) != 2 || !second.Lines[0].Truncated || second.Lines[1].Text != "end" {
		t.Fatalf("second: %#v, %v", second, err)
	}
	if second.Next != info.Size {
		t.Fatalf("next = %d, want %d", second.Next, info.Size)
	}
}

func TestLogReadReassemblesShortLineAcrossChunk(t *testing.T) {
	prefix := strings.Repeat(strings.Repeat("a", 2199)+"\n", 119)
	crossing := strings.Repeat("β", 2500)
	s, info := testLog(t, prefix+crossing+"\nnext\n")
	first, err := s.Read(info.Handle, 0, false)
	if err != nil || len(first.Lines) != 119 {
		t.Fatalf("first: %d lines, %v", len(first.Lines), err)
	}
	second, err := s.Read(info.Handle, first.Next, false)
	if err != nil || len(second.Lines) != 2 || second.Lines[0].Text != crossing || second.Lines[1].Text != "next" || second.Next != info.Size {
		t.Fatalf("crossing: %#v, %v", second, err)
	}
}

func TestLogReadBeforeAdjacentLinesAndLongLine(t *testing.T) {
	s, info := testLog(t, "one\n二\nthree\n")
	startOfThree := int64(len("one\n二\n"))
	before, err := s.ReadBefore(info.Handle, startOfThree)
	if err != nil || len(before.Lines) != 2 || before.Lines[0].Text != "one" || before.Lines[1].Text != "二" || before.Lines[1].Next != startOfThree {
		t.Fatalf("before: %#v, %v", before, err)
	}
	eof, err := s.ReadBefore(info.Handle, info.Size)
	if err != nil || eof.Lines[len(eof.Lines)-1].Text != "three" {
		t.Fatalf("before EOF: %#v, %v", eof, err)
	}
	long, metadata := testLog(t, strings.Repeat("x", 300000)+"\nend\n")
	endStart := metadata.Size - int64(len("end\n"))
	clipped, err := long.ReadBefore(metadata.Handle, endStart)
	if err != nil || len(clipped.Lines) != 1 || !clipped.Lines[0].Truncated || len(clipped.Lines[0].Text) > logLineLimit || clipped.Lines[0].Next != endStart {
		t.Fatalf("long line: %#v, %v", clipped, err)
	}
	earlier, err := long.ReadBefore(metadata.Handle, clipped.Lines[0].Offset)
	if err != nil || len(earlier.Lines) != 1 || earlier.Lines[0].Next != clipped.Lines[0].Offset {
		t.Fatalf("earlier: %#v, %v", earlier, err)
	}
}

func TestEmptyLog(t *testing.T) {
	s, info := testLog(t, "")
	chunk, err := s.Read(info.Handle, 0, false)
	if err != nil || info.Size != 0 || len(chunk.Lines) != 0 {
		t.Fatalf("empty: %#v, %v", chunk, err)
	}
}

func TestLogFindNextPreviousAndBoundary(t *testing.T) {
	content := strings.Repeat("a", logSearchSize-2) + "MATCH" + "\nMATCH\n"
	s, info := testLog(t, content)
	first, err := s.Find(info.Handle, "MATCH", 0, false)
	if err != nil || first != logSearchSize-2 {
		t.Fatalf("first = %d, %v", first, err)
	}
	second, err := s.Find(info.Handle, "MATCH", first+1, false)
	if err != nil || second <= first {
		t.Fatalf("second = %d, %v", second, err)
	}
	previous, err := s.Find(info.Handle, "MATCH", second, true)
	if err != nil || previous != first {
		t.Fatalf("previous = %d, %v", previous, err)
	}
	missing, err := s.Find(info.Handle, "absent", 0, false)
	if err != nil || missing != -1 {
		t.Fatalf("missing = %d, %v", missing, err)
	}
	atEOF, err := s.Find(info.Handle, "MATCH", info.Size-5, false)
	if err != nil || atEOF != -1 {
		t.Fatalf("EOF = %d, %v", atEOF, err)
	}
}

func TestLogChangesAndClose(t *testing.T) {
	s, info := testLog(t, "first\n")
	f, err := os.OpenFile(info.Path, os.O_APPEND|os.O_WRONLY, 0)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := f.WriteString("second\n"); err != nil {
		t.Fatal(err)
	}
	_ = f.Close()
	grown, err := s.Stat(info.Handle)
	if err != nil || grown.Size <= info.Size {
		t.Fatalf("grown: %#v, %v", grown, err)
	}
	chunk, err := s.Read(info.Handle, info.Size, false)
	if err != nil || len(chunk.Lines) != 1 || chunk.Lines[0].Text != "second" {
		t.Fatalf("append: %#v, %v", chunk, err)
	}
	if err := os.Truncate(info.Path, 2); err != nil {
		t.Fatal(err)
	}
	truncated, err := s.Stat(info.Handle)
	if err != nil || truncated.Revision == grown.Revision || truncated.Size != 2 {
		t.Fatalf("truncated: %#v, %v", truncated, err)
	}
	if err := s.Close(info.Handle); err != nil {
		t.Fatal(err)
	}
	if _, err := s.Read(info.Handle, 0, false); err == nil {
		t.Fatal("closed handle still readable")
	}
}

func TestLogSearchJobAndCancellation(t *testing.T) {
	s, info := testLog(t, "before\nneedle\nafter\n")
	id, err := s.StartFind(info.Handle, "needle", 0, false)
	if err != nil {
		t.Fatal(err)
	}
	deadline := time.Now().Add(2 * time.Second)
	for {
		result, err := s.PollFind(info.Handle, id)
		if err != nil {
			t.Fatal(err)
		}
		if result.Done {
			if result.Error != "" || result.Offset != 7 {
				t.Fatalf("result: %#v", result)
			}
			break
		}
		if time.Now().After(deadline) {
			t.Fatal("search did not finish")
		}
		time.Sleep(time.Millisecond)
	}
	other, err := s.StartFind(info.Handle, "after", 0, false)
	if err != nil {
		t.Fatal(err)
	}
	if err := s.CancelFind(info.Handle, id); err != nil {
		t.Fatal(err)
	}
	if _, err := s.PollFind(info.Handle, other); err != nil {
		t.Fatalf("stale cancel removed newer search: %v", err)
	}
	if err := s.CancelFind(info.Handle, other); err != nil {
		t.Fatal(err)
	}
	if _, err := s.PollFind(info.Handle, other); err == nil {
		t.Fatal("cancelled job is still active")
	}
}

func TestLogReplacementInvalidatesRevision(t *testing.T) {
	s, info := testLog(t, "old\n")
	replacement := filepath.Join(filepath.Dir(info.Path), "new.log")
	if err := os.WriteFile(replacement, []byte("new\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	rotated := filepath.Join(filepath.Dir(info.Path), "rotated.log")
	if err := os.Rename(info.Path, rotated); err != nil {
		if err := os.Remove(info.Path); err != nil {
			t.Skipf("replace while open unavailable: %v", err)
		}
	}
	if err := os.Rename(replacement, info.Path); err != nil {
		t.Fatal(err)
	}
	changed, err := s.Stat(info.Handle)
	if err != nil || changed.Revision == info.Revision {
		t.Fatalf("changed: %#v, %v", changed, err)
	}
	chunk, err := s.Read(info.Handle, 0, false)
	if err != nil || len(chunk.Lines) != 1 || chunk.Lines[0].Text != "new" {
		t.Fatalf("replacement: %#v, %v", chunk, err)
	}
}

func TestSparseThirtyGiBLogUsesBoundedHeap(t *testing.T) {
	path := filepath.Join(t.TempDir(), "sparse.log")
	f, err := os.Create(path)
	if err != nil {
		t.Fatal(err)
	}
	const size = int64(30) << 30
	if err := f.Truncate(size); err != nil {
		_ = f.Close()
		t.Skipf("sparse file unavailable: %v", err)
	}
	_ = f.Close()
	runtime.GC()
	var before, after runtime.MemStats
	runtime.ReadMemStats(&before)
	s := &LogStore{}
	info, err := s.Open(path)
	if err != nil {
		t.Fatal(err)
	}
	defer s.CloseAll()
	for _, offset := range []int64{0, size / 2, size - 1024} {
		chunk, err := s.Read(info.Handle, offset, true)
		if err != nil || len(chunk.Lines) == 0 {
			t.Fatalf("offset %d: %#v, %v", offset, chunk, err)
		}
	}
	runtime.ReadMemStats(&after)
	if after.Alloc > before.Alloc+(16<<20) {
		t.Fatalf("heap grew by %d bytes", after.Alloc-before.Alloc)
	}
}

func TestGeneratedHundredMiBLogRandomSeeks(t *testing.T) {
	path := filepath.Join(t.TempDir(), "generated.log")
	f, err := os.Create(path)
	if err != nil {
		t.Fatal(err)
	}
	block := []byte(strings.Repeat("[INFO] generated line\n", 1<<16))
	for written := 0; written < 100<<20; written += len(block) {
		if _, err := f.Write(block); err != nil {
			_ = f.Close()
			t.Fatal(err)
		}
	}
	if err := f.Close(); err != nil {
		t.Fatal(err)
	}
	s := &LogStore{}
	info, err := s.Open(path)
	if err != nil {
		t.Fatal(err)
	}
	defer s.CloseAll()
	for _, offset := range []int64{0, info.Size / 3, info.Size / 2, info.Size - 1024} {
		chunk, err := s.Read(info.Handle, offset, true)
		if err != nil || len(chunk.Lines) == 0 || chunk.Lines[0].Text != "[INFO] generated line" {
			t.Fatalf("offset %d: %#v, %v", offset, chunk, err)
		}
	}
}
