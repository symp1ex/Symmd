package files

import (
	"bytes"
	"context"
	"errors"
	"io"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func encodedTestLog(t *testing.T, name, text string, bom []byte) (*LogStore, LogInfo, []byte) {
	t.Helper()
	data, err := encodeLog(text, name)
	if err != nil {
		t.Fatal(err)
	}
	data = append(append([]byte{}, bom...), data...)
	s, info := testLog(t, string(data))
	if info.Encoding != name {
		info, err = s.ReopenEncoding(info.Handle, name, false)
		if err != nil {
			t.Fatal(err)
		}
	}
	return s, info, data
}

func TestLogEncodingReadEditHistorySave(t *testing.T) {
	for _, tc := range []struct {
		name string
		bom  []byte
		text string
	}{
		{logUTF8, nil, "Привет 😀\r\nend\n"}, {logUTF8, []byte{0xef, 0xbb, 0xbf}, "Привет 😀\r\nend\n"},
		{"UTF-16 LE", []byte{0xff, 0xfe}, "Привет 😀\r\nend\n"}, {"UTF-16 BE", []byte{0xfe, 0xff}, "Привет 😀\r\nend\n"},
		{"UTF-16 LE", nil, "Привет 😀\r\nend\n"}, {"UTF-16 BE", nil, "Привет 😀\r\nend\n"},
		{"Windows-1251", nil, "Привет мир\r\nend\n"}, {"CP866", nil, "Привет мир\r\nend\n"}, {"KOI8-R", nil, "Привет мир\r\nend\n"},
		{"Windows-1252", nil, "café €\r\nend\n"},
	} {
		t.Run(tc.name+string(tc.bom), func(t *testing.T) {
			s, info, original := encodedTestLog(t, tc.name, tc.text, tc.bom)
			window, err := s.ReadWindow(info.Handle, 0)
			if err != nil || !window.Editable || window.Text != tc.text || window.Offset != int64(len(tc.bom)) || window.Next != info.Size {
				t.Fatalf("window %#v, %v", window, err)
			}
			chunk, err := s.Read(info.Handle, 0, false)
			if err != nil || len(chunk.Lines) != 2 || chunk.Lines[0].Text != strings.Split(tc.text, "\r")[0] || chunk.Lines[0].Offset != info.BOM {
				t.Fatalf("read %#v, %v", chunk, err)
			}
			before, err := s.ReadBefore(info.Handle, info.Size)
			if err != nil || len(before.Lines) != 2 || before.Lines[1].Text != "end" || before.Lines[1].Next != info.Size {
				t.Fatalf("before %#v, %v", before, err)
			}
			aligned, err := s.Read(info.Handle, info.Size-2*logUnit(tc.name), true)
			if err != nil || len(aligned.Lines) != 1 || aligned.Lines[0].Text != "end" {
				t.Fatalf("aligned %#v, %v", aligned, err)
			}
			start := info.BOM
			if _, err := s.Replace(info.Handle, start, start, "X\r\n"); err != nil {
				t.Fatal(err)
			}
			inserted, _ := encodeLog("X\r\n", tc.name)
			expected := append(append(append([]byte{}, tc.bom...), inserted...), original[len(tc.bom):]...)
			logBytes(t, s, info.Handle, string(expected))
			if _, err := s.Undo(info.Handle); err != nil {
				t.Fatal(err)
			}
			logBytes(t, s, info.Handle, string(original))
			if _, err := s.Redo(info.Handle); err != nil {
				t.Fatal(err)
			}
			logBytes(t, s, info.Handle, string(expected))
			for _, destination := range []string{filepath.Join(t.TempDir(), "saved.log"), ""} {
				id, err := s.StartSave(info.Handle, destination)
				if err != nil {
					t.Fatal(err)
				}
				result := waitLogSave(t, s, info.Handle, id)
				if result.Error != "" {
					t.Fatal(result.Error)
				}
				actual, err := os.ReadFile(result.Info.Path)
				if err != nil || !bytes.Equal(actual, expected) {
					t.Fatalf("saved bytes differ: %v", err)
				}
			}
		})
	}
}

func TestLogEncodedGlobalSearchCoordinatesAndPieces(t *testing.T) {
	for _, name := range []string{logUTF8, "UTF-16 LE", "UTF-16 BE", "Windows-1251", "Windows-1252", "CP866", "KOI8-R"} {
		t.Run(name, func(t *testing.T) {
			// A match straddles a search block and a piece boundary. Another is
			// beyond the entire Monaco window. Overlaps and Unicode folding remain global.
			unit := logUnit(name)
			prefix := strings.Repeat("x", int(logSearchSize/unit)-1)
			middle := strings.Repeat("z", int((3<<20)/unit))
			query := "AaA"
			text := prefix + "aa" + "aa" + middle + "AAAA"
			s, info, _ := encodedTestLog(t, name, text, nil)
			start := logTextBytes(prefix, name)
			if _, err := s.Replace(info.Handle, start+2*unit, start+2*unit, "a"); err != nil {
				t.Fatal(err)
			}
			last := logTextBytes(prefix+"aaaaa"+middle, name) + unit
			for _, tc := range []struct {
				offset   int64
				previous bool
				want     int64
				ordinal  int64
			}{
				{0, false, start, 1}, {start + 1, false, start + unit, 2}, {info.Size + unit, true, last, 5}, {start + unit, true, start, 1},
			} {
				found, err := s.Find(info.Handle, query, tc.offset, tc.previous)
				if err != nil || found != tc.want {
					t.Fatalf("find %d prev=%v: %d, %v want %d", tc.offset, tc.previous, found, err, tc.want)
				}
				id, err := s.StartCount(info.Handle, query)
				if err != nil {
					t.Fatal(err)
				}
				count := waitLogCount(t, s, info.Handle, id, found)
				if count.Total != 5 || count.Ordinal != tc.ordinal || count.Error != "" {
					t.Fatalf("count %#v", count)
				}
				if _, err := s.ReadWindow(info.Handle, last); err != nil {
					t.Fatal(err)
				}
				again, err := s.Find(info.Handle, query, tc.offset, tc.previous)
				if err != nil || again != found {
					t.Fatalf("window changed global search: %d %v", again, err)
				}
			}
			if name != "Windows-1252" {
				if _, err := s.Replace(info.Handle, 0, 0, "Жж"); err != nil {
					t.Fatal(err)
				}
				found, err := s.Find(info.Handle, "ж", 1, false)
				if err != nil || found != logTextBytes("Ж", name) {
					t.Fatalf("Unicode folding %d, %v", found, err)
				}
			}
			e, _ := s.entry(info.Handle)
			state, _ := s.Stat(info.Handle)
			ctx, cancel := context.WithCancel(context.Background())
			cancel()
			matcher, lookahead, _ := logSearchPattern("a")
			_, _, _, err := scanEncodedLogBlock(ctx, e, state.Revision, state.Size, 0, min(state.Size, logSearchSize), matcher, lookahead)
			if !errors.Is(err, context.Canceled) {
				t.Fatalf("cancel: %v", err)
			}
			id, err := s.StartFind(info.Handle, query, 0, false)
			if err != nil {
				t.Fatal(err)
			}
			if _, err := s.Replace(info.Handle, 0, 0, "q"); err != nil {
				t.Fatal(err)
			}
			if _, err := s.PollFind(info.Handle, id); err == nil {
				t.Fatal("stale search survived an edit")
			}
		})
	}
}

func TestLogEncodingDetectionAndManualProtection(t *testing.T) {
	for _, name := range []string{logUTF8, "UTF-16 LE", "UTF-16 BE", "Windows-1251", "Windows-1252", "CP866", "KOI8-R"} {
		text := "Привет мир это проверка строки журнала\r\n"
		if name == "Windows-1252" {
			text = "café déjà vu — €\r\n"
		}
		data, _ := encodeLog(strings.Repeat(text, 10), name)
		s, info := testLog(t, string(data))
		if info.Encoding != name {
			t.Errorf("detect %s = %s", name, info.Encoding)
		}
		if _, err := s.Replace(info.Handle, info.BOM, info.BOM, "x"); err != nil {
			t.Fatal(err)
		}
		if _, err := s.ReopenEncoding(info.Handle, name, false); err == nil {
			t.Fatal("reopening discarded edits without confirmation")
		}
		if _, err := s.ReopenEncoding(info.Handle, name, true); err != nil {
			t.Fatal(err)
		}
	}
	s, info := testLog(t, "plain ASCII")
	if _, err := s.ReopenEncoding(info.Handle, "Windows-1251", false); err != nil {
		t.Fatal(err)
	}
	window, _ := s.ReadWindow(info.Handle, 0)
	if window.Encoding != "Windows-1251" || window.Text != "plain ASCII" {
		t.Fatalf("manual %#v", window)
	}
	if _, err := s.ReopenEncoding(info.Handle, "unknown", false); err == nil {
		t.Fatal("unknown encoding accepted")
	}
	for _, data := range [][]byte{{0xff, 0xfe, 0, 0, 'a', 0, 0, 0}, {0, 0, 0xfe, 0xff, 0, 0, 0, 'a'}} {
		path := filepath.Join(t.TempDir(), "utf32.log")
		if err := os.WriteFile(path, data, 0600); err != nil {
			t.Fatal(err)
		}
		if _, err := s.Open(path); err == nil {
			t.Fatal("UTF-32 mistaken for UTF-16")
		}
	}
	changed, changedInfo := testLog(t, "old encoding with a longer original document")
	oldFind, err := changed.StartFind(changedInfo.Handle, "encoding", 0, false)
	if err != nil {
		t.Fatal(err)
	}
	oldCount, err := changed.StartCount(changedInfo.Handle, "encoding")
	if err != nil {
		t.Fatal(err)
	}
	utf16Data, _ := encodeLog("new encoding", "UTF-16 LE")
	if err := os.WriteFile(changedInfo.Path, append([]byte{0xff, 0xfe}, utf16Data...), 0600); err != nil {
		t.Fatal(err)
	}
	if _, err := changed.Stat(changedInfo.Handle); err == nil {
		t.Fatal("conflicting BOM silently changed the pinned encoding")
	}
	if _, err := changed.PollFind(changedInfo.Handle, oldFind); err == nil {
		t.Fatal("failed source decoding left stale search active")
	}
	if _, err := changed.PollCount(changedInfo.Handle, oldCount, 0); err == nil {
		t.Fatal("failed source decoding left stale count active")
	}
	if _, err := changed.ReopenEncoding(changedInfo.Handle, "UTF-16 LE", false); err != nil {
		t.Fatal(err)
	}
	window, err = changed.ReadWindow(changedInfo.Handle, 0)
	if err != nil || !window.Editable || window.Text != "new encoding" {
		t.Fatalf("reopen replaced encoding %#v, %v", window, err)
	}
}

func TestLogEncodingInvalidIncompleteAndAppend(t *testing.T) {
	for _, name := range []string{logUTF8, "UTF-16 LE", "UTF-16 BE"} {
		t.Run(name, func(t *testing.T) {
			s, info, _ := encodedTestLog(t, name, "a😀b\r\n", nil)
			first := logTextBytes("a", name)
			if _, err := s.Replace(info.Handle, first+1, first+1, "x"); err == nil {
				t.Fatal("split character accepted")
			}
			bom := []byte{0xef, 0xbb, 0xbf}
			if name == "UTF-16 LE" {
				bom = []byte{0xff, 0xfe}
			}
			if name == "UTF-16 BE" {
				bom = []byte{0xfe, 0xff}
			}
			s2, i2, _ := encodedTestLog(t, name, "abc", bom)
			if _, err := s2.Replace(i2.Handle, 0, 0, "x"); err == nil {
				t.Fatal("BOM edit accepted")
			}
			data, _ := encodeLog("a😀", name)
			if err := os.WriteFile(i2.Path, append(append([]byte{}, bom...), data[:len(data)-1]...), 0600); err != nil {
				t.Fatal(err)
			}
			window, err := s2.ReadWindow(i2.Handle, 0)
			if err != nil || window.Editable || !strings.Contains(window.Error, io.ErrUnexpectedEOF.Error()) {
				t.Fatalf("incomplete %#v, %v", window, err)
			}
			if _, err := s2.Replace(i2.Handle, window.Size, window.Size, "x"); err == nil {
				t.Fatal("edit at incomplete EOF accepted")
			}
			f, err := os.OpenFile(i2.Path, os.O_APPEND|os.O_WRONLY, 0600)
			if err != nil {
				t.Fatal(err)
			}
			if _, err := f.Write(data[len(data)-1:]); err != nil {
				t.Fatal(err)
			}
			f.Close()
			window, err = s2.ReadWindow(i2.Handle, 0)
			if err != nil || !window.Editable || window.Text != "a😀" {
				t.Fatalf("append %#v, %v", window, err)
			}
			invalid := []byte{0xff}
			if name != "UTF-8" {
				invalid = []byte{0, 0xd8, 65, 0}
				if name == "UTF-16 BE" {
					invalid = []byte{0xd8, 0, 0, 65}
				}
			}
			if err := os.WriteFile(i2.Path, append(append([]byte{}, bom...), invalid...), 0600); err != nil {
				t.Fatal(err)
			}
			window, err = s2.ReadWindow(i2.Handle, 0)
			if err != nil || window.Editable || window.Error == "" || strings.Contains(window.Error, io.ErrUnexpectedEOF.Error()) {
				t.Fatalf("damaged %#v, %v", window, err)
			}
			if _, err := s2.Read(i2.Handle, 0, false); err == nil {
				t.Fatal("Read hid damaged data")
			}
			if _, err := s2.ReadBefore(i2.Handle, window.Size); err == nil {
				t.Fatal("ReadBefore hid damaged data")
			}
		})
	}
	for _, name := range []string{"Windows-1251", "Windows-1252", "CP866", "KOI8-R"} {
		s, info, original := encodedTestLog(t, name, "text", nil)
		if _, err := s.Replace(info.Handle, 0, 0, "😀"); err == nil {
			t.Fatal("unrepresentable insertion accepted")
		}
		logBytes(t, s, info.Handle, string(original))
	}
}

func TestLogUTF8ReadDoesNotSplitBoundaryOrHideDamage(t *testing.T) {
	prefix := strings.Repeat("a", logReadSize-1)
	s, info := testLog(t, prefix+"😀\nend\n")
	chunk, err := s.Read(info.Handle, 0, false)
	if err != nil || chunk.Next != int64(len(prefix)) {
		t.Fatalf("boundary next=%d, %v", chunk.Next, err)
	}
	chunk, err = s.Read(info.Handle, chunk.Next, false)
	if err != nil || len(chunk.Lines) != 2 || chunk.Lines[0].Text != "😀" || chunk.Lines[1].Text != "end" {
		t.Fatalf("boundary continuation %#v, %v", chunk, err)
	}
	before, err := s.ReadBefore(info.Handle, info.Size)
	if err != nil || len(before.Lines) != 2 || !strings.HasSuffix(before.Lines[0].Text, "😀") || strings.Contains(before.Lines[0].Text, "�") {
		t.Fatalf("before boundary: %v", err)
	}
	if err := os.WriteFile(info.Path, []byte("a\xffb\n"), 0600); err != nil {
		t.Fatal(err)
	}
	if _, err := s.Read(info.Handle, 0, false); err == nil {
		t.Fatal("UTF-8 Read hid damage")
	}
	if _, err := s.ReadBefore(info.Handle, 4); err == nil {
		t.Fatal("UTF-8 ReadBefore hid damage")
	}
}

func TestLogEncodingPinnedAcrossSourceChanges(t *testing.T) {
	for _, name := range []string{logUTF8, "UTF-16 LE", "UTF-16 BE", "Windows-1251", "Windows-1252", "CP866", "KOI8-R"} {
		t.Run(name, func(t *testing.T) {
			s, info, original := encodedTestLog(t, name, "first\r\n", nil)
			tail, _ := encodeLog("second\n", name)
			f, err := os.OpenFile(info.Path, os.O_APPEND|os.O_WRONLY, 0600)
			if err != nil {
				t.Fatal(err)
			}
			if _, err := f.Write(tail); err != nil {
				t.Fatal(err)
			}
			f.Close()
			state, err := s.Stat(info.Handle)
			if err != nil || state.Encoding != name || state.Size != int64(len(original)+len(tail)) {
				t.Fatalf("append %#v, %v", state, err)
			}
			window, err := s.ReadWindow(info.Handle, 0)
			if err != nil || window.Text != "first\r\nsecond\n" {
				t.Fatalf("append read %#v, %v", window, err)
			}
			short, _ := encodeLog("a\n", name)
			if err := os.WriteFile(info.Path, short, 0600); err != nil {
				t.Fatal(err)
			}
			state, err = s.Stat(info.Handle)
			if err != nil || state.Encoding != name || state.Revision <= info.Revision {
				t.Fatalf("truncate %#v, %v", state, err)
			}
			replacement, _ := encodeLog("replacement\r\n", name)
			temporary := filepath.Join(filepath.Dir(info.Path), "replacement.log")
			if err := os.WriteFile(temporary, replacement, 0600); err != nil {
				t.Fatal(err)
			}
			if err := os.Rename(info.Path, info.Path+".old"); err != nil {
				t.Fatal(err)
			}
			if err := os.Rename(temporary, info.Path); err != nil {
				t.Fatal(err)
			}
			window, err = s.ReadWindow(info.Handle, 0)
			if err != nil || window.Encoding != name || window.Text != "replacement\r\n" {
				t.Fatalf("replace source %#v, %v", window, err)
			}
			if _, err := s.Replace(info.Handle, 0, 0, "edit"); err != nil {
				t.Fatal(err)
			}
			if err := os.WriteFile(info.Path, short, 0600); err != nil {
				t.Fatal(err)
			}
			if _, err := s.Replace(info.Handle, 0, 0, "unsafe"); err == nil {
				t.Fatal("external conflict allowed editing")
			}
			if _, err := s.StartSave(info.Handle, ""); err == nil {
				t.Fatal("external conflict allowed saving")
			}
		})
	}
}

func TestLogUTF16WindowAndSearchSurrogateBoundaries(t *testing.T) {
	for _, name := range []string{"UTF-16 LE", "UTF-16 BE"} {
		prefix := strings.Repeat("a", logWindowSize/2-1)
		s, info, _ := encodedTestLog(t, name, prefix+"😀\r\nЖ😀\n", nil)
		window, err := s.ReadWindow(info.Handle, 0)
		if err != nil || !window.Editable || window.Text != prefix || window.Next != logWindowSize-2 {
			t.Fatalf("surrogate window end: next=%d editable=%v err=%v", window.Next, window.Editable, err)
		}
		window, err = s.ReadWindow(info.Handle, window.Next+1)
		if err != nil || !window.Editable || !strings.Contains(window.Text, "😀\r\nЖ😀") {
			t.Fatalf("surrogate window start: %v", err)
		}
		for _, previous := range []bool{false, true} {
			offset := int64(0)
			if previous {
				offset = info.Size
			}
			found, err := s.Find(info.Handle, "😀", offset, previous)
			want := int64(logWindowSize - 2)
			if previous {
				want += 10
			}
			if err != nil || found != want {
				t.Fatalf("emoji search %d want %d, %v", found, want, err)
			}
			id, err := s.StartCount(info.Handle, "😀")
			if err != nil {
				t.Fatal(err)
			}
			result := waitLogCount(t, s, info.Handle, id, found)
			ordinal := int64(1)
			if previous {
				ordinal = 2
			}
			if result.Total != 2 || result.Ordinal != ordinal || result.Error != "" {
				t.Fatalf("emoji count %#v", result)
			}
		}
	}
}
