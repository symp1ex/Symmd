package files

import (
	"context"
	"errors"
	"fmt"
	"io"
	"regexp"
	"unicode/utf8"
)

// Each block owns match starts in [start,end). Its lookahead is decoded too,
// but never counted. Find, total and ordinal share these exact boundaries.
func scanEncodedLogBlock(ctx context.Context, e *logEntry, revision uint64, size, start, end int64, matcher *regexp.Regexp, matchBytes int) (count, first, last int64, err error) {
	first, last = -1, -1
	e.mu.Lock()
	if e.file == nil || e.info.Revision != revision {
		e.mu.Unlock()
		return 0, -1, -1, errors.New("log changed during search")
	}
	name := e.info.Encoding
	aligned, err := e.characterStart(start)
	if err != nil {
		e.mu.Unlock()
		return 0, -1, -1, err
	}
	limit := min(size, end+int64(matchBytes))
	data := make([]byte, max(int64(0), limit-aligned))
	n, readErr := e.readLogicalAt(data, aligned)
	e.mu.Unlock()
	if readErr != nil && readErr != io.EOF || n != len(data) {
		return 0, -1, -1, errors.New("log changed during search")
	}
	text, consumed, decodeErr := decodeLog(data, name)
	if decodeErr != nil && !(errors.Is(decodeErr, io.ErrUnexpectedEOF) && limit < size) {
		return 0, -1, -1, fmt.Errorf("decode %s log at byte %d: %w", name, aligned+int64(consumed), decodeErr)
	}
	// Move the source coordinate along with the Unicode matcher. This keeps
	// memory bounded without a per-character map of the entire document.
	mapped, source := 0, aligned
	for at := 0; at < len(text); {
		if err := ctx.Err(); err != nil {
			return 0, -1, -1, err
		}
		match := matcher.FindStringIndex(text[at:])
		if match == nil {
			break
		}
		index := at + match[0]
		for mapped < index {
			r, width := utf8.DecodeRuneInString(text[mapped:])
			mapped += width
			source += int64(logRuneBytes(r, name))
		}
		if source >= end {
			break
		}
		if source >= start {
			count++
			last = source
			if first < 0 {
				first = source
			}
		}
		_, width := utf8.DecodeRuneInString(text[index:])
		at = index + width
	}
	return count, first, last, nil
}

func findEncodedLog(ctx context.Context, e *logEntry, revision uint64, size, offset int64, previous bool, matcher *regexp.Regexp, matchBytes int) (int64, error) {
	if previous {
		for end := offset; end > 0; {
			start := max(int64(0), end-logSearchSize)
			_, _, last, err := scanEncodedLogBlock(ctx, e, revision, size, start, end, matcher, matchBytes)
			if err != nil || last >= 0 {
				return last, err
			}
			end = start
		}
	} else {
		for start := offset; start < size; start += logSearchSize {
			_, first, _, err := scanEncodedLogBlock(ctx, e, revision, size, start, min(size, start+logSearchSize), matcher, matchBytes)
			if err != nil || first >= 0 {
				return first, err
			}
		}
	}
	return -1, nil
}
