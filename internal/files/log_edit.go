package files

import (
	"bytes"
	"errors"
	"fmt"
	"io"
	"os"
	"unicode/utf8"
)

const logWindowSize = 2 << 20

type LogWindow struct {
	Offset   int64  `json:"offset"`
	Text     string `json:"text"`
	Size     int64  `json:"size"`
	Revision uint64 `json:"revision"`
	Editable bool   `json:"editable"`
}

func (e *logEntry) readLogicalAt(buffer []byte, offset int64) (int, error) {
	return readLogTree(e.root, e.file, e.add, buffer, offset)
}

func (s *LogStore) ReadWindow(handle uint64, offset int64) (LogWindow, error) {
	if _, err := s.Stat(handle); err != nil {
		return LogWindow{}, err
	}
	e, err := s.entry(handle)
	if err != nil {
		return LogWindow{}, err
	}
	e.mu.Lock()
	defer e.mu.Unlock()
	if e.file == nil {
		return LogWindow{}, errors.New("log handle is closed")
	}
	if offset < 0 {
		return LogWindow{}, errors.New("negative log offset")
	}
	if offset > e.info.Size {
		offset = e.info.Size
	}
	start := offset
	// Keep the requested position inside a bounded window and at a UTF-8 boundary.
	if start > logWindowSize/4 {
		start -= logWindowSize / 4
	} else {
		start = 0
	}
	for start > 0 {
		var previous [1]byte
		if _, err := e.readLogicalAt(previous[:], start); err != nil {
			return LogWindow{}, err
		}
		if previous[0]&0xc0 != 0x80 {
			break
		}
		start--
	}
	length := min(int64(logWindowSize), e.info.Size-start)
	data := make([]byte, length)
	if n, err := e.readLogicalAt(data, start); err != nil && err != io.EOF || int64(n) != length {
		return LogWindow{}, fmt.Errorf("read log window: %w", err)
	}
	if start+length < e.info.Size {
		for trimmed := 0; trimmed < 3 && len(data) > 0 && !utf8.Valid(data); trimmed++ {
			data = data[:len(data)-1]
		}
		if len(data) > 0 && data[len(data)-1] == '\r' {
			data = data[:len(data)-1]
		}
	}
	valid := utf8.Valid(data) && !e.conflict
	if !valid {
		data = bytes.ToValidUTF8(data, []byte("\uFFFD"))
	}
	return LogWindow{Offset: start, Text: string(data), Size: e.info.Size, Revision: e.info.Revision, Editable: valid}, nil
}

func (s *LogStore) Replace(handle uint64, start, end int64, inserted string) (LogInfo, error) {
	if !utf8.ValidString(inserted) {
		return LogInfo{}, errors.New("inserted text is not valid UTF-8")
	}
	if _, err := s.Stat(handle); err != nil {
		return LogInfo{}, err
	}
	e, err := s.entry(handle)
	if err != nil {
		return LogInfo{}, err
	}
	e.mu.Lock()
	defer e.mu.Unlock()
	if e.file == nil {
		return LogInfo{}, errors.New("log handle is closed")
	}
	if logSaveActive(e) {
		return LogInfo{}, errors.New("log save is in progress")
	}
	if e.conflict {
		return LogInfo{}, errors.New("log changed outside the editor")
	}
	if start < 0 || end < start || end > e.info.Size {
		return LogInfo{}, errors.New("invalid log edit range")
	}
	if start == end && inserted == "" {
		return e.info, nil
	}
	if e.add == nil {
		f, err := os.CreateTemp("", "symmd-log-edit-*")
		if err != nil {
			return LogInfo{}, err
		}
		e.add, e.addPath = f, f.Name()
		e.snapshotSize, e.snapshotNS = e.info.Size, e.info.ModifiedNS
	}
	var addition *logNode
	if inserted != "" {
		at, err := e.add.Seek(0, io.SeekEnd)
		if err != nil {
			return LogInfo{}, err
		}
		if _, err := e.add.WriteString(inserted); err != nil {
			return LogInfo{}, err
		}
		addition = e.newLogNode(logPiece{add: true, offset: at, length: int64(len(inserted))})
	}
	left, tail := e.splitLog(e.root, start)
	_, right := e.splitLog(tail, end-start)
	e.root = mergeLog(mergeLog(left, addition), right)
	e.history = append(e.history[:e.historyAt+1], e.root)
	e.historyAt++
	e.info.Size = logLength(e.root)
	e.info.Dirty = e.root != e.saved
	e.info.Revision++
	e.invalidateLogJobs()
	return e.info, nil
}

func (s *LogStore) Undo(handle uint64) (LogInfo, error) { return s.logHistory(handle, -1) }
func (s *LogStore) Redo(handle uint64) (LogInfo, error) { return s.logHistory(handle, 1) }

func (s *LogStore) logHistory(handle uint64, step int) (LogInfo, error) {
	e, err := s.entry(handle)
	if err != nil {
		return LogInfo{}, err
	}
	e.mu.Lock()
	defer e.mu.Unlock()
	if e.file == nil {
		return LogInfo{}, errors.New("log handle is closed")
	}
	if logSaveActive(e) {
		return LogInfo{}, errors.New("log save is in progress")
	}
	if next := e.historyAt + step; next >= 0 && next < len(e.history) {
		e.historyAt = next
		e.root = e.history[next]
		e.info.Size = logLength(e.root)
		e.info.Dirty = e.root != e.saved
		e.info.Revision++
		e.invalidateLogJobs()
	}
	return e.info, nil
}

func (e *logEntry) invalidateLogJobs() {
	if e.search != nil {
		e.search.cancel()
		e.search = nil
	}
	if e.count != nil {
		e.count.cancel()
		e.count = nil
	}
}
