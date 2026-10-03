package files

import (
	"context"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"sync/atomic"
)

type LogSaveResult struct {
	Done    bool     `json:"done"`
	Written int64    `json:"written"`
	Total   int64    `json:"total"`
	Error   string   `json:"error,omitempty"`
	Info    *LogInfo `json:"info,omitempty"`
}

type logSave struct {
	id       uint64
	cancel   context.CancelFunc
	finished chan struct{}
	written  atomic.Int64
	total    int64
	mu       sync.Mutex
	result   LogSaveResult
}

func (s *LogStore) StartSave(handle uint64, destination string) (uint64, error) {
	if _, err := s.Stat(handle); err != nil {
		return 0, err
	}
	e, err := s.entry(handle)
	if err != nil {
		return 0, err
	}
	e.mu.Lock()
	if e.file == nil {
		e.mu.Unlock()
		return 0, errors.New("log handle is closed")
	}
	if logSaveActive(e) {
		e.mu.Unlock()
		return 0, errors.New("log save is already in progress")
	}
	if e.conflict {
		e.mu.Unlock()
		return 0, errors.New("log changed outside the editor; reopen it before saving")
	}
	if destination == "" {
		destination = e.info.Path
	}
	abs, err := filepath.Abs(destination)
	if err != nil {
		e.mu.Unlock()
		return 0, err
	}
	if !strings.EqualFold(filepath.Ext(abs), ".log") {
		e.mu.Unlock()
		return 0, errors.New("log destination must have .log extension")
	}
	originalPath := e.info.Path
	root, original, add := e.root, e.file, e.add
	snapshotSize, snapshotNS, identity := e.snapshotSize, e.snapshotNS, e.identity
	ctx, cancel := context.WithCancel(context.Background())
	s.mu.Lock()
	s.next++
	id := s.next
	s.mu.Unlock()
	job := &logSave{id: id, cancel: cancel, finished: make(chan struct{}), total: logLength(root)}
	e.saving = job
	if abs == originalPath && !e.info.Dirty {
		info := e.info
		job.result = LogSaveResult{Done: true, Info: &info}
		close(job.finished)
		e.mu.Unlock()
		return id, nil
	}
	e.mu.Unlock()
	go func() {
		defer close(job.finished)
		temporary, err := saveLogPieces(ctx, root, original, add, originalPath, abs, identity, snapshotSize, snapshotNS, &job.written)
		if temporary != "" {
			defer os.Remove(temporary)
		}
		if err == nil {
			e.mu.Lock()
			if err = ctx.Err(); err == nil {
				err = checkLogSource(originalPath, identity, snapshotSize, snapshotNS)
			}
			var newFile *os.File
			var stat os.FileInfo
			if err == nil {
				newFile, err = openLogFile(temporary)
				if err == nil {
					stat, err = newFile.Stat()
				}
			}
			closedOriginal := false
			if err == nil && abs == originalPath {
				err = original.Close()
				closedOriginal = err == nil
			}
			if err == nil {
				err = replaceLogFile(temporary, abs)
			}
			if err != nil && closedOriginal {
				if reopened, reopenErr := openLogFile(originalPath); reopenErr == nil {
					e.file = reopened
				} else {
					err = errors.Join(err, fmt.Errorf("reopen original log: %w", reopenErr))
				}
			}
			if err != nil && newFile != nil {
				_ = newFile.Close()
			}
			if err == nil {
				oldFile, oldAdd, oldAddPath := e.file, e.add, e.addPath
				e.file, e.add, e.addPath = newFile, nil, ""
				e.identity = stat
				e.info.Path, e.info.Name = abs, filepath.Base(abs)
				e.info.Size, e.info.ModifiedNS = stat.Size(), stat.ModTime().UnixNano()
				e.snapshotSize, e.snapshotNS = e.info.Size, e.info.ModifiedNS
				e.root = nil
				if stat.Size() > 0 {
					e.root = e.newLogNode(logPiece{length: stat.Size()})
				}
				e.saved, e.history, e.historyAt = e.root, []*logNode{e.root}, 0
				e.info.Dirty = false
				e.info.Revision++
				e.conflict = false
				e.invalidateLogJobs()
				info := e.info
				job.mu.Lock()
				job.result.Info = &info
				job.mu.Unlock()
				_ = oldFile.Close()
				if oldAdd != nil {
					_ = oldAdd.Close()
					_ = os.Remove(oldAddPath)
				}
			}
			e.mu.Unlock()
		}
		job.mu.Lock()
		job.result.Done = true
		if err != nil {
			job.result.Error = err.Error()
		}
		job.mu.Unlock()
	}()
	return id, nil
}

func (s *LogStore) PollSave(handle, id uint64) (LogSaveResult, error) {
	e, err := s.entry(handle)
	if err != nil {
		return LogSaveResult{}, err
	}
	e.mu.Lock()
	job := e.saving
	e.mu.Unlock()
	if job == nil || job.id != id {
		return LogSaveResult{}, errors.New("save is no longer active")
	}
	job.mu.Lock()
	result := job.result
	job.mu.Unlock()
	result.Total, result.Written = job.total, job.written.Load()
	return result, nil
}

func (s *LogStore) CancelSave(handle, id uint64) error {
	e, err := s.entry(handle)
	if err != nil {
		return err
	}
	e.mu.Lock()
	job := e.saving
	e.mu.Unlock()
	if job != nil && (id == 0 || job.id == id) {
		job.cancel()
	}
	return nil
}

func logSaveActive(e *logEntry) bool {
	if e.saving == nil {
		return false
	}
	e.saving.mu.Lock()
	defer e.saving.mu.Unlock()
	return !e.saving.result.Done
}

func saveLogPieces(ctx context.Context, root *logNode, original, add *os.File, sourcePath, destination string, identity os.FileInfo, snapshotSize, snapshotNS int64, written *atomic.Int64) (string, error) {
	if err := checkLogSource(sourcePath, identity, snapshotSize, snapshotNS); err != nil {
		return "", err
	}
	out, err := os.CreateTemp(filepath.Dir(destination), ".symmd-log-save-*")
	if err != nil {
		return "", err
	}
	temporary := out.Name()
	completed := false
	defer func() {
		_ = out.Close()
		if !completed {
			_ = os.Remove(temporary)
		}
	}()
	if err := out.Chmod(identity.Mode().Perm()); err != nil {
		return "", err
	}
	if err := streamLogPieces(ctx, root, original, add, out, written); err != nil {
		return "", err
	}
	if err := out.Sync(); err != nil {
		return "", err
	}
	if err := out.Close(); err != nil {
		return "", err
	}
	if err := ctx.Err(); err != nil {
		return "", err
	}
	if err := checkLogSource(sourcePath, identity, snapshotSize, snapshotNS); err != nil {
		return "", err
	}
	if destination != sourcePath {
		// Save As may overwrite only the path explicitly chosen by the user.
		if stat, err := os.Stat(destination); err == nil && os.SameFile(identity, stat) {
			return "", errors.New("destination aliases original log")
		} else if err != nil && !errors.Is(err, os.ErrNotExist) {
			return "", err
		}
	}
	completed = true
	return temporary, nil
}

func streamLogPieces(ctx context.Context, root *logNode, original, add *os.File, output io.Writer, written *atomic.Int64) error {
	buffer := make([]byte, 1<<20)
	var writeTree func(*logNode) error
	writeTree = func(node *logNode) error {
		if node == nil {
			return nil
		}
		if err := writeTree(node.left); err != nil {
			return err
		}
		file := original
		if node.piece.add {
			file = add
		}
		if file == nil {
			return errors.New("log backing store is closed")
		}
		for remaining, offset := node.piece.length, node.piece.offset; remaining > 0; {
			if err := ctx.Err(); err != nil {
				return err
			}
			length := min(int64(len(buffer)), remaining)
			n, err := file.ReadAt(buffer[:length], offset)
			if err != nil && err != io.EOF {
				return err
			}
			if int64(n) != length {
				return io.ErrUnexpectedEOF
			}
			count, err := output.Write(buffer[:n])
			if err != nil {
				return err
			}
			if count != n {
				return io.ErrShortWrite
			}
			written.Add(int64(count))
			offset += int64(n)
			remaining -= int64(n)
		}
		return writeTree(node.right)
	}
	return writeTree(root)
}

func checkLogSource(path string, identity os.FileInfo, size, modifiedNS int64) error {
	stat, err := os.Stat(path)
	if err != nil {
		return err
	}
	if !os.SameFile(identity, stat) || stat.Size() != size || stat.ModTime().UnixNano() != modifiedNS {
		return errors.New("log changed outside the editor; original was not overwritten")
	}
	return nil
}
