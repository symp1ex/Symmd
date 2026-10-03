package files

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"unicode/utf8"
)

const logReadSize = 256 << 10
const logLineLimit = 16 << 10
const logSearchSize = 1 << 20

type LogInfo struct {
	Handle     uint64 `json:"handle"`
	Path       string `json:"path"`
	Name       string `json:"name"`
	Size       int64  `json:"size"`
	ModifiedNS int64  `json:"modifiedNs"`
	Revision   uint64 `json:"revision"`
}

type LogLine struct {
	Offset    int64  `json:"offset"`
	Next      int64  `json:"next"`
	Text      string `json:"text"`
	Truncated bool   `json:"truncated"`
}

type LogChunk struct {
	Lines    []LogLine `json:"lines"`
	Next     int64     `json:"next"`
	Size     int64     `json:"size"`
	Revision uint64    `json:"revision"`
}

type logEntry struct {
	mu       sync.Mutex
	file     *os.File
	info     LogInfo
	identity os.FileInfo
	search   *logSearch
}

type logSearch struct {
	id     uint64
	cancel context.CancelFunc
	mu     sync.Mutex
	result LogSearchResult
}

type LogSearchResult struct {
	Done   bool   `json:"done"`
	Offset int64  `json:"offset"`
	Error  string `json:"error,omitempty"`
}

type LogStore struct {
	mu      sync.Mutex
	next    uint64
	entries map[uint64]*logEntry
}

func (s *LogStore) Open(path string) (LogInfo, error) {
	if !strings.EqualFold(filepath.Ext(path), ".log") {
		return LogInfo{}, errors.New("not a log file")
	}
	abs, err := filepath.Abs(path)
	if err != nil {
		return LogInfo{}, err
	}
	f, err := openLogFile(abs)
	if err != nil {
		return LogInfo{}, err
	}
	stat, err := f.Stat()
	if err != nil || !stat.Mode().IsRegular() {
		f.Close()
		if err != nil {
			return LogInfo{}, err
		}
		return LogInfo{}, errors.New("log is not a regular file")
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	s.next++
	info := LogInfo{Handle: s.next, Path: abs, Name: filepath.Base(abs), Size: stat.Size(), ModifiedNS: stat.ModTime().UnixNano(), Revision: 1}
	if s.entries == nil {
		s.entries = make(map[uint64]*logEntry)
	}
	s.entries[info.Handle] = &logEntry{file: f, info: info, identity: stat}
	return info, nil
}

func (s *LogStore) entry(handle uint64) (*logEntry, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	e := s.entries[handle]
	if e == nil {
		return nil, errors.New("log handle is closed")
	}
	return e, nil
}

func (s *LogStore) Stat(handle uint64) (LogInfo, error) {
	e, err := s.entry(handle)
	if err != nil {
		return LogInfo{}, err
	}
	e.mu.Lock()
	defer e.mu.Unlock()
	if e.file == nil {
		return LogInfo{}, errors.New("log handle is closed")
	}
	stat, err := os.Stat(e.info.Path)
	if err != nil {
		return LogInfo{}, err
	}
	if !stat.Mode().IsRegular() {
		return LogInfo{}, errors.New("log is not a regular file")
	}
	if !os.SameFile(e.identity, stat) {
		if e.search != nil {
			e.search.cancel()
		}
		f, err := openLogFile(e.info.Path)
		if err != nil {
			return LogInfo{}, err
		}
		if err := e.file.Close(); err != nil {
			f.Close()
			return LogInfo{}, err
		}
		e.file, e.identity = f, stat
		e.info.Revision++
	} else if stat.Size() < e.info.Size || (stat.Size() == e.info.Size && stat.ModTime().UnixNano() != e.info.ModifiedNS) {
		e.info.Revision++
	}
	e.info.Size, e.info.ModifiedNS = stat.Size(), stat.ModTime().UnixNano()
	return e.info, nil
}

func (s *LogStore) Read(handle uint64, offset int64, align bool) (LogChunk, error) {
	if _, err := s.Stat(handle); err != nil {
		return LogChunk{}, err
	}
	e, err := s.entry(handle)
	if err != nil {
		return LogChunk{}, err
	}
	e.mu.Lock()
	defer e.mu.Unlock()
	if e.file == nil {
		return LogChunk{}, errors.New("log handle is closed")
	}
	if offset < 0 {
		return LogChunk{}, errors.New("negative log offset")
	}
	size := e.info.Size
	if offset > size {
		offset = size
	}
	result := LogChunk{Lines: []LogLine{}, Next: offset, Size: size, Revision: e.info.Revision}
	if offset == size {
		return result, nil
	}
	// Align arbitrary seeks to a nearby line start without scanning a pathological line.
	if align && offset > 0 {
		back := offset
		if back > logReadSize {
			back = logReadSize
		}
		previous := make([]byte, back)
		if _, err := e.file.ReadAt(previous, offset-back); err != nil && err != io.EOF {
			return LogChunk{}, err
		}
		if at := bytes.LastIndexByte(previous, '\n'); at >= 0 && len(previous)-at-1 <= logLineLimit {
			offset = offset - back + int64(at) + 1
		}
	}
	partial := false
	if offset > 0 {
		previous := []byte{0}
		if _, err := e.file.ReadAt(previous, offset-1); err != nil && err != io.EOF {
			return LogChunk{}, err
		}
		partial = previous[0] != '\n'
	}
	data := make([]byte, min(int64(logReadSize), size-offset))
	n, err := e.file.ReadAt(data, offset)
	if err != nil && err != io.EOF {
		return LogChunk{}, err
	}
	data = data[:n]
	position := offset
	for len(data) > 0 && len(result.Lines) < 120 {
		newline := bytes.IndexByte(data, '\n')
		end := len(data)
		if newline >= 0 {
			end = newline + 1
		}
		// Leave an incomplete trailing line for the next request, except for long lines.
		if newline < 0 && position+int64(end) < size && end < logLineLimit {
			break
		}
		segment := data[:end]
		visible := bytes.TrimSuffix(bytes.TrimSuffix(segment, []byte{'\n'}), []byte{'\r'})
		truncated := partial || len(visible) > logLineLimit || (newline < 0 && position+int64(end) < size)
		if len(visible) > logLineLimit {
			visible = visible[:logLineLimit]
		}
		visible = bytes.ToValidUTF8(visible, []byte("�"))
		if !utf8.Valid(visible) {
			return LogChunk{}, errors.New("invalid UTF-8 conversion")
		}
		result.Lines = append(result.Lines, LogLine{Offset: position, Next: position + int64(end), Text: string(visible), Truncated: truncated})
		position += int64(end)
		data = data[end:]
		partial = false
	}
	result.Next = position
	return result, nil
}

func (s *LogStore) ReadBefore(handle uint64, offset int64) (LogChunk, error) {
	if _, err := s.Stat(handle); err != nil {
		return LogChunk{}, err
	}
	e, err := s.entry(handle)
	if err != nil {
		return LogChunk{}, err
	}
	e.mu.Lock()
	defer e.mu.Unlock()
	if e.file == nil {
		return LogChunk{}, errors.New("log handle is closed")
	}
	if offset < 0 {
		return LogChunk{}, errors.New("negative log offset")
	}
	if offset > e.info.Size {
		offset = e.info.Size
	}
	result := LogChunk{Lines: []LogLine{}, Next: offset, Size: e.info.Size, Revision: e.info.Revision}
	if offset == 0 {
		return result, nil
	}
	start := max(int64(0), offset-logReadSize)
	data := make([]byte, offset-start)
	n, err := e.file.ReadAt(data, start)
	if err != nil && err != io.EOF {
		return LogChunk{}, err
	}
	if n != len(data) {
		return LogChunk{}, errors.New("log changed while reading")
	}
	for end := len(data); end > 0 && len(result.Lines) < 120; {
		contentEnd := end
		if data[contentEnd-1] == '\n' {
			contentEnd--
		}
		if contentEnd > 0 && data[contentEnd-1] == '\r' {
			contentEnd--
		}
		begin := bytes.LastIndexByte(data[:contentEnd], '\n') + 1
		clipped := begin == 0 && start > 0
		if contentEnd-begin > logLineLimit {
			begin = contentEnd - logLineLimit
			clipped = true
		}
		visible := bytes.ToValidUTF8(data[begin:contentEnd], []byte("�"))
		result.Lines = append(result.Lines, LogLine{Offset: start + int64(begin), Next: start + int64(end), Text: string(visible), Truncated: clipped})
		if clipped || begin == 0 {
			break
		}
		end = begin
	}
	for left, right := 0, len(result.Lines)-1; left < right; left, right = left+1, right-1 {
		result.Lines[left], result.Lines[right] = result.Lines[right], result.Lines[left]
	}
	return result, nil
}

func (s *LogStore) Find(handle uint64, query string, offset int64, previous bool) (int64, error) {
	return s.find(context.Background(), handle, query, offset, previous)
}

func (s *LogStore) find(ctx context.Context, handle uint64, query string, offset int64, previous bool) (int64, error) {
	if query == "" || len(query) > logSearchSize/2 {
		return -1, errors.New("search text must be 1 to 524288 bytes")
	}
	e, err := s.entry(handle)
	if err != nil {
		return -1, err
	}
	e.mu.Lock()
	needle := []byte(query)
	size := e.info.Size
	revision := e.info.Revision
	if e.file == nil {
		e.mu.Unlock()
		return -1, errors.New("log handle is closed")
	}
	e.mu.Unlock()
	if offset < 0 {
		offset = 0
	}
	if offset > size {
		offset = size
	}
	buffer := make([]byte, logSearchSize+len(needle)-1)
	if !previous {
		for start := offset; start < size; start += logSearchSize {
			if err := ctx.Err(); err != nil {
				return -1, err
			}
			n, readErr := readSearchBlock(e, revision, buffer, start)
			if readErr != nil && readErr != io.EOF {
				return -1, readErr
			}
			if at := bytes.Index(buffer[:n], needle); at >= 0 {
				return start + int64(at), nil
			}
		}
	} else {
		for end := offset; end > 0; {
			if err := ctx.Err(); err != nil {
				return -1, err
			}
			start := end - int64(logSearchSize)
			if start < 0 {
				start = 0
			}
			n, readErr := readSearchBlock(e, revision, buffer, start)
			if readErr != nil && readErr != io.EOF {
				return -1, readErr
			}
			limit := min(n, int(end-start))
			if at := bytes.LastIndex(buffer[:limit], needle); at >= 0 {
				return start + int64(at), nil
			}
			end = start
		}
	}
	return -1, nil
}

func (s *LogStore) StartFind(handle uint64, query string, offset int64, previous bool) (uint64, error) {
	if query == "" || len(query) > logSearchSize/2 {
		return 0, errors.New("search text must be 1 to 524288 bytes")
	}
	if _, err := s.Stat(handle); err != nil {
		return 0, err
	}
	e, err := s.entry(handle)
	if err != nil {
		return 0, err
	}
	s.mu.Lock()
	s.next++
	id := s.next
	s.mu.Unlock()
	ctx, cancel := context.WithCancel(context.Background())
	job := &logSearch{id: id, cancel: cancel, result: LogSearchResult{Offset: -1}}
	e.mu.Lock()
	if e.file == nil {
		e.mu.Unlock()
		cancel()
		return 0, errors.New("log handle is closed")
	}
	if e.search != nil {
		e.search.cancel()
	}
	e.search = job
	e.mu.Unlock()
	go func() {
		found, err := s.find(ctx, handle, query, offset, previous)
		job.mu.Lock()
		job.result = LogSearchResult{Done: true, Offset: found}
		if err != nil {
			job.result.Error = err.Error()
		}
		job.mu.Unlock()
	}()
	return id, nil
}

func (s *LogStore) PollFind(handle, id uint64) (LogSearchResult, error) {
	e, err := s.entry(handle)
	if err != nil {
		return LogSearchResult{}, err
	}
	e.mu.Lock()
	job := e.search
	e.mu.Unlock()
	if job == nil || job.id != id {
		return LogSearchResult{}, errors.New("search is no longer active")
	}
	job.mu.Lock()
	defer job.mu.Unlock()
	return job.result, nil
}

func (s *LogStore) CancelFind(handle, id uint64) error {
	e, err := s.entry(handle)
	if err != nil {
		return err
	}
	e.mu.Lock()
	if e.search != nil && (id == 0 || e.search.id == id) {
		e.search.cancel()
		e.search = nil
	}
	e.mu.Unlock()
	return nil
}

func readSearchBlock(e *logEntry, revision uint64, buffer []byte, offset int64) (int, error) {
	e.mu.Lock()
	defer e.mu.Unlock()
	if e.file == nil {
		return 0, errors.New("log handle is closed")
	}
	if e.info.Revision != revision {
		return 0, errors.New("log changed during search")
	}
	return e.file.ReadAt(buffer, offset)
}

func (s *LogStore) Close(handle uint64) error {
	s.mu.Lock()
	e := s.entries[handle]
	delete(s.entries, handle)
	s.mu.Unlock()
	if e == nil {
		return nil
	}
	e.mu.Lock()
	defer e.mu.Unlock()
	if e.search != nil {
		e.search.cancel()
	}
	f := e.file
	e.file = nil
	return f.Close()
}

func (s *LogStore) CloseAll() error {
	s.mu.Lock()
	entries := s.entries
	s.entries = nil
	s.mu.Unlock()
	var result error
	for _, e := range entries {
		e.mu.Lock()
		if e.search != nil {
			e.search.cancel()
		}
		if e.file != nil {
			result = errors.Join(result, e.file.Close())
			e.file = nil
		}
		e.mu.Unlock()
	}
	return result
}

func DescribeLog(path string) (MarkdownFile, error) {
	abs, err := filepath.Abs(path)
	if err != nil {
		return MarkdownFile{}, err
	}
	stat, err := os.Stat(abs)
	if err != nil {
		return MarkdownFile{}, err
	}
	if !stat.Mode().IsRegular() {
		return MarkdownFile{}, fmt.Errorf("not a regular file: %q", abs)
	}
	return MarkdownFile{Path: abs, Name: filepath.Base(abs), ModifiedNS: stat.ModTime().UnixNano()}, nil
}
