//go:build windows

package window

import (
	"fmt"
	"path/filepath"
	"runtime"
	"strings"
	"syscall"
	"unicode/utf16"
	"unsafe"
)

var (
	comdlg32             = syscall.NewLazyDLL("comdlg32.dll")
	getOpenFileNameW     = comdlg32.NewProc("GetOpenFileNameW")
	getSaveFileNameW     = comdlg32.NewProc("GetSaveFileNameW")
	commDlgExtendedError = comdlg32.NewProc("CommDlgExtendedError")
)

const (
	ofnExplorer        = 0x00080000
	ofnFileMustExist   = 0x00001000
	ofnPathMustExist   = 0x00000800
	ofnHideReadOnly    = 0x00000004
	ofnOverwritePrompt = 0x00000002
	ofnDontAddToRecent = 0x02000000
)

type openFileName struct {
	structSize       uint32
	owner            uintptr
	instance         uintptr
	filter           *uint16
	customFilter     *uint16
	maxCustomFilter  uint32
	filterIndex      uint32
	file             *uint16
	maxFile          uint32
	fileTitle        *uint16
	maxFileTitle     uint32
	initialDirectory *uint16
	title            *uint16
	flags            uint32
	fileOffset       uint16
	fileExtension    uint16
	defaultExtension *uint16
	customData       uintptr
	hook             uintptr
	templateName     *uint16
	reserved         uintptr
	reservedFlags    uint32
	flagsEx          uint32
}

type DialogLogFunc func(format string, values ...any)

func selectMarkdownFile(owner uintptr, logf DialogLogFunc) (string, bool, error) {
	return markdownDialog(owner, false, "", "Open document", logf)
}

func SelectMarkdownFile(owner uintptr, logf DialogLogFunc) (string, bool, error) {
	return selectMarkdownFile(owner, logf)
}

func SaveMarkdownFile(owner uintptr, suggestedPath string, logf DialogLogFunc) (string, bool, error) {
	return saveMarkdownFile(owner, suggestedPath, logf)
}

func saveMarkdownFile(owner uintptr, suggestedPath string, logf DialogLogFunc) (string, bool, error) {
	return markdownDialog(owner, true, suggestedPath, "Save Markdown file", logf)
}

func markdownDialog(owner uintptr, save bool, suggestedPath, titleText string, logf DialogLogFunc) (string, bool, error) {
	return fileDialog(owner, save, suggestedPath, titleText, markdownDialogFilter(), "md", save, logf)
}

func SaveLinkFile(owner uintptr, suggestedPath string, logf DialogLogFunc) (string, bool, error) {
	extension := strings.TrimPrefix(filepath.Ext(suggestedPath), ".")
	return fileDialog(owner, true, suggestedPath, "Save link as", allFilesDialogFilter(), extension, false, logf)
}

func fileDialog(owner uintptr, save bool, suggestedPath, titleText string, filter []uint16, defaultExtension string, ensureMarkdown bool, logf DialogLogFunc) (string, bool, error) {
	runtime.LockOSThread()
	defer runtime.UnlockOSThread()
	buffer := make([]uint16, 32768)
	if suggestedPath != "" {
		encoded, err := syscall.UTF16FromString(suggestedPath)
		if err == nil {
			copy(buffer, encoded)
		}
	}
	title, _ := syscall.UTF16PtrFromString(titleText)
	ext, _ := syscall.UTF16PtrFromString(defaultExtension)
	flags := uint32(ofnExplorer | ofnPathMustExist | ofnHideReadOnly | ofnDontAddToRecent)
	proc := getOpenFileNameW
	procName := "GetOpenFileNameW"
	if save {
		flags |= ofnOverwritePrompt
		proc = getSaveFileNameW
		procName = "GetSaveFileNameW"
	} else {
		flags |= ofnFileMustExist
	}
	dialog := openFileName{owner: owner, filter: &filter[0], filterIndex: 1, file: &buffer[0], maxFile: uint32(len(buffer)), title: title, flags: flags, defaultExtension: ext}
	dialog.structSize = uint32(unsafe.Sizeof(dialog))
	if logf != nil {
		logf("native dialog call: function=%s owner=%d struct_size=%d filter_units=%d buffer_units=%d", procName, owner, dialog.structSize, len(filter), len(buffer))
	}
	result, _, _ := proc.Call(uintptr(unsafe.Pointer(&dialog)))
	runtime.KeepAlive(dialog)
	runtime.KeepAlive(buffer)
	runtime.KeepAlive(filter)
	runtime.KeepAlive(title)
	runtime.KeepAlive(ext)
	if logf != nil {
		logf("native dialog return: function=%s result=%d", procName, result)
	}
	if result == 0 {
		code, _, _ := commDlgExtendedError.Call()
		if logf != nil {
			logf("native dialog extended error: function=%s code=0x%x", procName, code)
		}
		if code == 0 {
			return "", true, nil
		}
		return "", false, fmt.Errorf("Windows file dialog failed: 0x%x", code)
	}
	path := syscall.UTF16ToString(buffer)
	if ensureMarkdown {
		path = ensureMarkdownExtension(path)
	}
	return path, false, nil
}

func markdownDialogFilter() []uint16 {
	filter := utf16.Encode([]rune("Supported documents (*.md;*.markdown;*.log)\x00*.md;*.markdown;*.log\x00All files (*.*)\x00*.*\x00"))
	return append(filter, 0)
}

func allFilesDialogFilter() []uint16 {
	filter := utf16.Encode([]rune("All files (*.*)\x00*.*\x00"))
	return append(filter, 0)
}

func ensureMarkdownExtension(path string) string {
	if filepath.Ext(path) == "" {
		return path + ".md"
	}
	return path
}
