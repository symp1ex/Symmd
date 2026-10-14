package files

import (
	"bytes"
	"encoding/binary"
	"errors"
	"fmt"
	"io"
	"os"
	"strings"
	"unicode"
	"unicode/utf16"
	"unicode/utf8"

	"golang.org/x/text/encoding/charmap"
)

const logUTF8 = "UTF-8"

func logCharmap(name string) *charmap.Charmap {
	switch name {
	case "Windows-1251":
		return charmap.Windows1251
	case "Windows-1252":
		return charmap.Windows1252
	case "CP866":
		return charmap.CodePage866
	case "KOI8-R":
		return charmap.KOI8R
	}
	return nil
}

func logEncodingAllowed(name string) bool {
	return name == logUTF8 || name == "UTF-16 LE" || name == "UTF-16 BE" || logCharmap(name) != nil
}

// Detection is deliberately bounded and advisory without a BOM. The chosen
// encoding belongs to the handle, never to an individual window or search block.
func detectLogEncoding(f *os.File, forced string) (name string, bom int64, err error) {
	sample := make([]byte, 64<<10)
	n, err := f.ReadAt(sample, 0)
	if err != nil && err != io.EOF {
		return "", 0, err
	}
	sample = sample[:n]
	if bytes.HasPrefix(sample, []byte{0xff, 0xfe, 0, 0}) || bytes.HasPrefix(sample, []byte{0, 0, 0xfe, 0xff}) {
		return "", 0, errors.New("UTF-32 logs are not supported")
	}
	switch {
	case bytes.HasPrefix(sample, []byte{0xef, 0xbb, 0xbf}):
		name, bom = logUTF8, 3
	case bytes.HasPrefix(sample, []byte{0xff, 0xfe}):
		name, bom = "UTF-16 LE", 2
	case bytes.HasPrefix(sample, []byte{0xfe, 0xff}):
		name, bom = "UTF-16 BE", 2
	}
	if forced != "" {
		if !logEncodingAllowed(forced) {
			return "", 0, errors.New("unsupported log encoding")
		}
		if name != "" && name != forced {
			return "", 0, errors.New("selected encoding conflicts with the log BOM")
		}
		return forced, bom, nil
	}
	if name != "" {
		return name, bom, nil
	}
	var even, odd int
	for i, b := range sample {
		if b == 0 {
			if i%2 == 0 {
				even++
			} else {
				odd++
			}
		}
	}
	if len(sample) >= 4 {
		if odd > len(sample)/8 && odd > even*3 {
			return "UTF-16 LE", 0, nil
		}
		if even > len(sample)/8 && even > odd*3 {
			return "UTF-16 BE", 0, nil
		}
		// Cyrillic UTF-16 commonly has no zero high bytes.
		for _, candidate := range []string{"UTF-16 LE", "UTF-16 BE"} {
			high := 1
			if candidate == "UTF-16 BE" {
				high = 0
			}
			cyrillic := 0
			for i := high; i < len(sample); i += 2 {
				if sample[i] == 4 {
					cyrillic++
				}
			}
			if cyrillic > len(sample)/6 {
				return candidate, 0, nil
			}
		}
	}
	validSample := sample
	valid := true
	for len(validSample) > 0 {
		if !utf8.FullRune(validSample) {
			break
		}
		r, width := utf8.DecodeRune(validSample)
		if r == utf8.RuneError && width == 1 {
			valid = false
			break
		}
		validSample = validSample[width:]
	}
	if valid {
		return logUTF8, 0, nil
	}
	// A small language score distinguishes common Russian logs from Western
	// text. Short samples remain ambiguous; the UI always offers manual reopening.
	best, bestScore := "Windows-1252", 0
	for _, candidate := range []string{"Windows-1252", "Windows-1251", "CP866", "KOI8-R"} {
		score := 0
		previous := rune(0)
		for _, b := range sample {
			r := logCharmap(candidate).DecodeByte(b)
			isCyrillic := func(r rune) bool { return r >= 'А' && r <= 'я' || r == 'ё' || r == 'Ё' }
			isASCII := func(r rune) bool { return r >= 'a' && r <= 'z' || r >= 'A' && r <= 'Z' }
			if isCyrillic(r) && isASCII(previous) || isASCII(r) && isCyrillic(previous) {
				score -= 8
			}
			switch {
			case r == utf8.RuneError || unicode.IsControl(r) && r != '\n' && r != '\r' && r != '\t':
				score -= 12
			case r >= 'а' && r <= 'я' || r == 'ё':
				score += 3
			case r >= 'А' && r <= 'Я':
				score++
			case r >= 0x2500 && r <= 0x259f:
				score -= 5
			}
			if previous != 0 && strings.Contains("ст но то на ен ов ни ра во ко ро по пр ос ал ли ре ер", string([]rune{unicode.ToLower(previous), unicode.ToLower(r)})) && r > 127 {
				score += 5
			}
			previous = r
		}
		if score > bestScore {
			best, bestScore = candidate, score
		}
	}
	return best, 0, nil
}

func logUnit(name string) int64 {
	if strings.HasPrefix(name, "UTF-16") {
		return 2
	}
	return 1
}

func logRune(data []byte, name string) (rune, int, error) {
	if len(data) == 0 {
		return 0, 0, io.ErrUnexpectedEOF
	}
	if name == logUTF8 {
		if !utf8.FullRune(data) {
			return 0, 0, io.ErrUnexpectedEOF
		}
		r, n := utf8.DecodeRune(data)
		if r == utf8.RuneError && n == 1 {
			return 0, 0, errors.New("invalid UTF-8 sequence")
		}
		return r, n, nil
	}
	if cm := logCharmap(name); cm != nil {
		r := cm.DecodeByte(data[0])
		if r == utf8.RuneError {
			return 0, 0, fmt.Errorf("undefined byte in %s", name)
		}
		return r, 1, nil
	}
	if len(data) < 2 {
		return 0, 0, io.ErrUnexpectedEOF
	}
	var order binary.ByteOrder = binary.LittleEndian
	if name == "UTF-16 BE" {
		order = binary.BigEndian
	}
	u := order.Uint16(data)
	if u >= 0xd800 && u <= 0xdbff {
		if len(data) < 4 {
			return 0, 0, io.ErrUnexpectedEOF
		}
		v := order.Uint16(data[2:])
		if v < 0xdc00 || v > 0xdfff {
			return 0, 0, errors.New("invalid UTF-16 surrogate pair")
		}
		return utf16.DecodeRune(rune(u), rune(v)), 4, nil
	}
	if u >= 0xdc00 && u <= 0xdfff {
		return 0, 0, errors.New("unpaired UTF-16 surrogate")
	}
	return rune(u), 2, nil
}

func logRuneBytes(r rune, name string) int {
	if name == logUTF8 {
		return utf8.RuneLen(r)
	}
	if logUnit(name) == 2 {
		if r > 0xffff {
			return 4
		}
		return 2
	}
	return 1
}

// Decode complete characters only. An incomplete suffix is retained in storage
// and reported separately from malformed data, including while a file grows.
func decodeLog(data []byte, name string) (string, int, error) {
	var out strings.Builder
	for at := 0; at < len(data); {
		r, n, err := logRune(data[at:], name)
		if err != nil {
			return out.String(), at, err
		}
		out.WriteRune(r)
		at += n
	}
	return out.String(), len(data), nil
}

func encodeLog(text, name string) ([]byte, error) {
	if !utf8.ValidString(text) {
		return nil, errors.New("inserted text is not valid Unicode")
	}
	if name == logUTF8 {
		return []byte(text), nil
	}
	if cm := logCharmap(name); cm != nil {
		out, err := cm.NewEncoder().Bytes([]byte(text))
		if err != nil {
			return nil, fmt.Errorf("text contains characters not representable in %s", name)
		}
		return out, nil
	}
	var order binary.ByteOrder = binary.LittleEndian
	if name == "UTF-16 BE" {
		order = binary.BigEndian
	}
	units := utf16.Encode([]rune(text))
	out := make([]byte, len(units)*2)
	for i, u := range units {
		order.PutUint16(out[i*2:], u)
	}
	return out, nil
}

// Caller holds e.mu. Only a bounded neighborhood of the offset is inspected.
func (e *logEntry) characterStart(at int64) (int64, error) {
	at = max(min(at, e.info.Size), e.info.BOM)
	if at == e.info.Size {
		return at, nil
	}
	if logUnit(e.info.Encoding) == 2 {
		at -= (at - e.info.BOM) % 2
	}
	var data [4]byte
	n, err := e.readLogicalAt(data[:], at)
	if err != nil && err != io.EOF {
		return 0, err
	}
	if e.info.Encoding == logUTF8 {
		for i := 0; i < 3 && at > e.info.BOM && n > 0 && data[0]&0xc0 == 0x80; i++ {
			at--
			n, err = e.readLogicalAt(data[:], at)
			if err != nil && err != io.EOF {
				return 0, err
			}
		}
	} else if logUnit(e.info.Encoding) == 2 && n >= 2 && at >= e.info.BOM+2 {
		var order binary.ByteOrder = binary.LittleEndian
		if e.info.Encoding == "UTF-16 BE" {
			order = binary.BigEndian
		}
		u := order.Uint16(data[:])
		if u >= 0xdc00 && u <= 0xdfff {
			at -= 2
		}
	}
	return at, nil
}

func (e *logEntry) editBoundary(at int64) error {
	if at < e.info.BOM {
		return errors.New("edit range includes the log BOM")
	}
	start, err := e.characterStart(at)
	if err != nil {
		return err
	}
	if start != at {
		return errors.New("edit splits an encoded character or BOM")
	}
	// EOF is safe only after a complete character.
	if at == e.info.Size && at > e.info.BOM {
		start, err = e.characterStart(at - 1)
		if err != nil {
			return err
		}
		data := make([]byte, at-start)
		if _, err = e.readLogicalAt(data, start); err != nil {
			return err
		}
		if _, _, err = decodeLog(data, e.info.Encoding); err != nil {
			return fmt.Errorf("incomplete or damaged log suffix: %w", err)
		}
	}
	return nil
}

func logTextBytes(text, name string) int64 {
	var n int64
	for _, r := range text {
		n += int64(logRuneBytes(r, name))
	}
	return n
}

// Navigation uses the same decoder and original byte coordinates as the editor.
// Caller holds e.mu; no full-file conversion or index is retained.
func (e *logEntry) readEncodedLines(offset int64, before, align bool) (LogChunk, error) {
	size, name := e.info.Size, e.info.Encoding
	offset = max(e.info.BOM, min(offset, size))
	result := LogChunk{Lines: []LogLine{}, Next: offset, Size: size, Revision: e.info.Revision}
	if !before && offset >= size || before && offset <= e.info.BOM {
		return result, nil
	}
	start := offset
	if before {
		start = max(e.info.BOM, offset-logReadSize)
	} else if align && offset > e.info.BOM {
		back, err := e.characterStart(max(e.info.BOM, offset-logLineLimit))
		if err != nil {
			return result, err
		}
		previous := make([]byte, offset-back)
		if n, err := e.readLogicalAt(previous, back); err != nil && err != io.EOF || n != len(previous) {
			return result, errors.New("log changed while reading")
		}
		text, consumed, err := decodeLog(previous, name)
		if err != nil && !errors.Is(err, io.ErrUnexpectedEOF) {
			return result, fmt.Errorf("decode %s log at byte %d: %w", name, back+int64(consumed), err)
		}
		if at := strings.LastIndexByte(text, '\n'); at >= 0 {
			start = back + logTextBytes(text[:at+1], name)
		}
	}
	var err error
	start, err = e.characterStart(start)
	if err != nil {
		return result, err
	}
	end := min(size, start+logReadSize)
	if before {
		end = offset
	}
	if start >= end {
		return result, nil
	}
	data := make([]byte, end-start)
	if n, err := e.readLogicalAt(data, start); err != nil && err != io.EOF || n != len(data) {
		return result, errors.New("log changed while reading")
	}
	text, consumed, decodeErr := decodeLog(data, name)
	if decodeErr != nil && !(errors.Is(decodeErr, io.ErrUnexpectedEOF) && end < size) {
		return result, fmt.Errorf("decode %s log at byte %d: %w", name, start+int64(consumed), decodeErr)
	}
	for len(text) > 0 {
		at := strings.IndexByte(text, '\n')
		length := len(text)
		if at >= 0 {
			length = at + 1
		}
		segment := text[:length]
		byteLength := logTextBytes(segment, name)
		if !before && at < 0 && start+byteLength < size && byteLength < logLineLimit {
			break
		}
		visible := strings.TrimSuffix(strings.TrimSuffix(segment, "\n"), "\r")
		clipped := start > e.info.BOM && len(result.Lines) == 0
		if clipped {
			unit := logUnit(name)
			previous := make([]byte, unit)
			if _, err := e.readLogicalAt(previous, start-unit); err != nil {
				return result, err
			}
			r, _, err := logRune(previous, name)
			clipped = err != nil || r != '\n'
		}
		if logTextBytes(visible, name) > logLineLimit {
			clipped = true
			if before {
				cut := len(visible)
				var kept int64
				for cut > 0 {
					r, n := utf8.DecodeLastRuneInString(visible[:cut])
					if kept+int64(logRuneBytes(r, name)) > logLineLimit {
						break
					}
					kept += int64(logRuneBytes(r, name))
					cut -= n
				}
				start += logTextBytes(visible[:cut], name)
				byteLength -= logTextBytes(visible[:cut], name)
				visible = visible[cut:]
			} else {
				cut := 0
				var kept int64
				for i, r := range visible {
					if kept+int64(logRuneBytes(r, name)) > logLineLimit {
						break
					}
					kept += int64(logRuneBytes(r, name))
					cut = i + utf8.RuneLen(r)
				}
				visible = visible[:cut]
			}
		}
		result.Lines = append(result.Lines, LogLine{Offset: start, Next: start + byteLength, Text: visible, Truncated: clipped || at < 0 && start+byteLength < size, Encoding: name})
		start += byteLength
		text = text[length:]
		if !before && len(result.Lines) == 120 {
			break
		}
	}
	if before && len(result.Lines) > 120 {
		result.Lines = result.Lines[len(result.Lines)-120:]
	}
	if !before {
		result.Next = start
	}
	return result, nil
}

func (s *LogStore) ReopenEncoding(handle uint64, encoding string, discard bool) (LogInfo, error) {
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
	if e.info.Dirty && !discard {
		return LogInfo{}, errors.New("unsaved log changes must be saved or explicitly discarded before reopening")
	}
	f, err := openLogFile(e.info.Path)
	if err != nil {
		return LogInfo{}, err
	}
	name, bom, err := detectLogEncoding(f, encoding)
	if err != nil {
		f.Close()
		return LogInfo{}, err
	}
	stat, err := f.Stat()
	if err != nil || !stat.Mode().IsRegular() {
		f.Close()
		if err == nil {
			err = errors.New("log is not a regular file")
		}
		return LogInfo{}, err
	}
	if err := e.file.Close(); err != nil {
		f.Close()
		return LogInfo{}, err
	}
	var cleanupErr error
	if e.add != nil {
		closeErr := e.add.Close()
		removeErr := os.Remove(e.addPath)
		cleanupErr = errors.Join(closeErr, removeErr)
	}
	e.invalidateLogJobs()
	e.file, e.add, e.addPath, e.identity = f, nil, "", stat
	e.info.Encoding, e.info.BOM = name, bom
	e.info.Size, e.info.ModifiedNS, e.info.Dirty = stat.Size(), stat.ModTime().UnixNano(), false
	e.info.Revision++
	e.snapshotSize, e.snapshotNS, e.conflict = stat.Size(), stat.ModTime().UnixNano(), false
	e.root = nil
	if stat.Size() > 0 {
		e.root = e.newLogNode(logPiece{length: stat.Size()})
	}
	e.saved, e.history, e.historyAt = e.root, []*logNode{e.root}, 0
	return e.info, cleanupErr
}
