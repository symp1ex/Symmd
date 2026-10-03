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

func waitLogCount(t *testing.T, s *LogStore, handle, id uint64, offset int64) LogCountResult {
	t.Helper()
	deadline := time.Now().Add(3 * time.Second)
	for {
		result, err := s.PollCount(handle, id, offset)
		if err != nil {
			t.Fatal(err)
		}
		if result.Done {
			return result
		}
		if time.Now().After(deadline) {
			t.Fatal("count did not finish")
		}
		time.Sleep(time.Millisecond)
	}
}

func TestLogCountMatchesOverlapsAndBlockBoundary(t *testing.T) {
	content := "aaaa\n" + strings.Repeat("x", logSearchSize-8) + "aaaabc\naaaa\n"
	s, info := testLog(t, content)
	id, err := s.StartCount(info.Handle, "aaa")
	if err != nil {
		t.Fatal(err)
	}
	for _, offset := range []int64{0, 1, logSearchSize - 3, logSearchSize - 2, int64(len(content) - 5), int64(len(content) - 4)} {
		found, err := s.Find(info.Handle, "aaa", offset, false)
		if err != nil || found != offset {
			t.Fatalf("find at %d = %d, %v", offset, found, err)
		}
	}
	for _, offset := range []int64{1, logSearchSize - 2, int64(len(content) - 4)} {
		previous, err := s.Find(info.Handle, "aaa", offset, true)
		if err != nil || previous != offset-1 {
			t.Fatalf("previous at %d = %d, %v", offset, previous, err)
		}
	}
	result := waitLogCount(t, s, info.Handle, id, int64(len(content)-4))
	if result.Error != "" || result.Total != 6 || result.Ordinal != 6 {
		t.Fatalf("count: %#v", result)
	}
	first, err := s.PollCount(info.Handle, id, 1)
	if err != nil || first.Ordinal != 2 {
		t.Fatalf("first overlap: %#v, %v", first, err)
	}
}

func TestLogSearchCaseInsensitiveNavigationAndCount(t *testing.T) {
	content := "aAaA A.B a.b АБВ абв K K\n"
	s, info := testLog(t, content)
	for _, test := range []struct {
		query   string
		offsets []int64
	}{
		{"AaA", []int64{0, 1}},
		{"a.b", []int64{5, 9}},
		{"абв", []int64{13, 20}},
		{"k", []int64{27, 31}},
	} {
		id, err := s.StartCount(info.Handle, test.query)
		if err != nil {
			t.Fatal(err)
		}
		for index, offset := range test.offsets {
			found, err := s.Find(info.Handle, test.query, offset, false)
			if err != nil || found != offset {
				t.Fatalf("%q next at %d = %d, %v", test.query, offset, found, err)
			}
			result := waitLogCount(t, s, info.Handle, id, offset)
			if result.Error != "" || result.Total != int64(len(test.offsets)) || result.Ordinal != int64(index+1) {
				t.Fatalf("%q count at %d: %#v", test.query, offset, result)
			}
		}
		previous, err := s.Find(info.Handle, test.query, test.offsets[1], true)
		if err != nil || previous != test.offsets[0] {
			t.Fatalf("%q previous = %d, %v", test.query, previous, err)
		}
	}
}

func TestLogSearchCaseFoldedUTF8AcrossBlockBoundary(t *testing.T) {
	content := strings.Repeat("x", logSearchSize-1) + "K\nK\n"
	s, info := testLog(t, content)
	id, err := s.StartCount(info.Handle, "k")
	if err != nil {
		t.Fatal(err)
	}
	for index, offset := range []int64{logSearchSize - 1, logSearchSize + 3} {
		found, err := s.Find(info.Handle, "k", offset, false)
		if err != nil || found != offset {
			t.Fatalf("next at %d = %d, %v", offset, found, err)
		}
		result := waitLogCount(t, s, info.Handle, id, offset)
		if result.Error != "" || result.Total != 2 || result.Ordinal != int64(index+1) {
			t.Fatalf("count at %d: %#v", offset, result)
		}
	}
	previous, err := s.Find(info.Handle, "k", logSearchSize+3, true)
	if err != nil || previous != logSearchSize-1 {
		t.Fatalf("previous = %d, %v", previous, err)
	}
}

func TestLogCountUTF8AndFileChanges(t *testing.T) {
	s, info := testLog(t, "ααα\n")
	id, err := s.StartCount(info.Handle, "αα")
	if err != nil {
		t.Fatal(err)
	}
	result := waitLogCount(t, s, info.Handle, id, 2)
	if result.Total != 2 || result.Ordinal != 2 {
		t.Fatalf("UTF-8 count: %#v", result)
	}
	f, err := os.OpenFile(info.Path, os.O_APPEND|os.O_WRONLY, 0)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := f.WriteString("αα\n"); err != nil {
		t.Fatal(err)
	}
	_ = f.Close()
	grown, err := s.Stat(info.Handle)
	if err != nil || grown.Size <= info.Size || grown.Revision != info.Revision {
		t.Fatalf("append: %#v, %v", grown, err)
	}
	newID, err := s.StartCount(info.Handle, "αα")
	if err != nil {
		t.Fatal(err)
	}
	result = waitLogCount(t, s, info.Handle, newID, int64(len("ααα\n")))
	if result.Total != 3 || result.Ordinal != 3 {
		t.Fatalf("appended count: %#v", result)
	}
	if err := os.Truncate(info.Path, 2); err != nil {
		t.Fatal(err)
	}
	truncated, err := s.Stat(info.Handle)
	if err != nil || truncated.Revision == grown.Revision {
		t.Fatalf("truncate: %#v, %v", truncated, err)
	}
	if err := s.CancelCount(info.Handle, newID); err != nil {
		t.Fatal(err)
	}
	if _, err := s.PollCount(info.Handle, newID, 0); err == nil {
		t.Fatal("cancelled count is still active")
	}
}

func TestLogCountCancelAndClose(t *testing.T) {
	s, info := testLog(t, strings.Repeat("needle\n", 1<<18))
	id, err := s.StartCount(info.Handle, "needle")
	if err != nil {
		t.Fatal(err)
	}
	e, err := s.entry(info.Handle)
	if err != nil {
		t.Fatal(err)
	}
	e.mu.Lock()
	firstJob := e.count
	e.mu.Unlock()
	if err := s.CancelCount(info.Handle, id); err != nil {
		t.Fatal(err)
	}
	select {
	case <-firstJob.finished:
	case <-time.After(2 * time.Second):
		t.Fatal("cancelled count goroutine did not stop")
	}
	if _, err := s.PollCount(info.Handle, id, 0); err == nil {
		t.Fatal("cancelled count is still active")
	}
	id, err = s.StartCount(info.Handle, "needle")
	if err != nil {
		t.Fatal(err)
	}
	e.mu.Lock()
	secondJob := e.count
	e.mu.Unlock()
	searchID, err := s.StartFind(info.Handle, "missing", 0, false)
	if err != nil {
		t.Fatal(err)
	}
	e.mu.Lock()
	searchJob := e.search
	e.mu.Unlock()
	if err := s.Close(info.Handle); err != nil {
		t.Fatal(err)
	}
	select {
	case <-secondJob.finished:
	case <-time.After(2 * time.Second):
		t.Fatal("closed count goroutine did not stop")
	}
	select {
	case <-searchJob.finished:
	case <-time.After(2 * time.Second):
		t.Fatal("closed navigation goroutine did not stop")
	}
	if _, err := s.PollCount(info.Handle, id, 0); err == nil {
		t.Fatal("closed count is still active")
	}
	if _, err := s.PollFind(info.Handle, searchID); err == nil {
		t.Fatal("closed navigation is still active")
	}
}

func TestLogNavigationRunsWhileCounting(t *testing.T) {
	s, info := testLog(t, "needle\n"+strings.Repeat("other\n", 1<<18))
	countID, err := s.StartCount(info.Handle, "needle")
	if err != nil {
		t.Fatal(err)
	}
	searchID, err := s.StartFind(info.Handle, "needle", 0, false)
	if err != nil {
		t.Fatal(err)
	}
	deadline := time.Now().Add(2 * time.Second)
	for {
		result, err := s.PollFind(info.Handle, searchID)
		if err != nil {
			t.Fatal(err)
		}
		if result.Done {
			if result.Error != "" || result.Offset != 0 {
				t.Fatalf("navigation: %#v", result)
			}
			break
		}
		if time.Now().After(deadline) {
			t.Fatal("navigation waited for count")
		}
		time.Sleep(time.Millisecond)
	}
	if _, err := s.PollCount(info.Handle, countID, 0); err != nil {
		t.Fatalf("navigation cancelled count: %v", err)
	}
	newID, err := s.StartCount(info.Handle, "other")
	if err != nil {
		t.Fatal(err)
	}
	if _, err := s.PollCount(info.Handle, countID, 0); err == nil {
		t.Fatal("new query kept the old count active")
	}
	if result := waitLogCount(t, s, info.Handle, newID, -1); result.Total != 1<<18 {
		t.Fatalf("new query count: %#v", result)
	}
}

func TestLogReplacementInvalidatesRevision(t *testing.T) {
	s, info := testLog(t, "old\n")
	oldCount, err := s.StartCount(info.Handle, "old")
	if err != nil {
		t.Fatal(err)
	}
	if result := waitLogCount(t, s, info.Handle, oldCount, 0); result.Total != 1 {
		t.Fatalf("old count: %#v", result)
	}
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
	newCount, err := s.StartCount(info.Handle, "old")
	if err != nil {
		t.Fatal(err)
	}
	if result := waitLogCount(t, s, info.Handle, newCount, -1); result.Total != 0 {
		t.Fatalf("replacement count: %#v", result)
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
