//go:build windows

package app

import (
	"fmt"
	"os"
	"path/filepath"
	"strings"

	"golang.org/x/sys/windows/registry"
)

const (
	markdownProgID    = "Symmd.Markdown"
	logProgID         = "Symmd.Log"
	markdownIconID    = 2
	logIconID         = 3
	shcneAssocChanged = 0x08000000
	shcnfIDList       = 0x0000
)

type associationEntry struct {
	path  string
	name  string
	value string
}

var shChangeNotify = shell32.NewProc("SHChangeNotify")

func associationEntries(executable string) []associationEntry {
	openCommand := `"` + executable + `" "%1"`
	return []associationEntry{
		{`Software\Classes\` + markdownProgID, "", "Symmd Markdown Document"},
		{`Software\Classes\` + markdownProgID + `\DefaultIcon`, "", iconLocation(executable, markdownIconID)},
		{`Software\Classes\` + markdownProgID + `\shell\open\command`, "", openCommand},
		{`Software\Classes\` + logProgID, "", "Symmd Log Document"},
		{`Software\Classes\` + logProgID + `\DefaultIcon`, "", iconLocation(executable, logIconID)},
		{`Software\Classes\` + logProgID + `\shell\open\command`, "", openCommand},
		{`Software\Classes\.md\OpenWithProgids`, markdownProgID, ""},
		{`Software\Classes\.log\OpenWithProgids`, logProgID, ""},
		{`Software\Symmd\Capabilities`, "ApplicationName", "Symmd"},
		{`Software\Symmd\Capabilities`, "ApplicationDescription", "Markdown and log file editor"},
		{`Software\Symmd\Capabilities`, "ApplicationIcon", iconLocation(executable, applicationIconID)},
		{`Software\Symmd\Capabilities\FileAssociations`, ".md", markdownProgID},
		{`Software\Symmd\Capabilities\FileAssociations`, ".log", logProgID},
		{`Software\RegisteredApplications`, "Symmd", `Software\Symmd\Capabilities`},
		{`Software\Classes\Applications\symmd.exe`, "FriendlyAppName", "Symmd"},
		{`Software\Classes\Applications\symmd.exe\shell\open\command`, "", openCommand},
		{`Software\Classes\Applications\symmd.exe\SupportedTypes`, ".md", ""},
		{`Software\Classes\Applications\symmd.exe\SupportedTypes`, ".log", ""},
	}
}

func iconLocation(executable string, resourceID int) string {
	return fmt.Sprintf(`"%s",-%d`, executable, resourceID)
}

func registerFileAssociations() (bool, error) {
	executable, err := os.Executable()
	if err != nil {
		return false, fmt.Errorf("locate executable for file associations: %w", err)
	}
	executable, err = filepath.Abs(executable)
	if err != nil {
		return false, fmt.Errorf("resolve executable for file associations: %w", err)
	}
	if strings.EqualFold(filepath.Ext(executable), ".test") || executableInDirectory(executable, os.TempDir()) {
		return false, nil
	}

	changed := false
	for _, entry := range associationEntries(executable) {
		key, _, err := registry.CreateKey(registry.CURRENT_USER, entry.path, registry.QUERY_VALUE|registry.SET_VALUE)
		if err != nil {
			return changed, fmt.Errorf("create file association key %q: %w", entry.path, err)
		}
		current, valueType, readErr := key.GetStringValue(entry.name)
		if readErr != nil && readErr != registry.ErrNotExist && readErr != registry.ErrUnexpectedType {
			key.Close()
			return changed, fmt.Errorf("read file association value %q in %q: %w", entry.name, entry.path, readErr)
		}
		if readErr == registry.ErrNotExist || readErr == registry.ErrUnexpectedType || valueType != registry.SZ || current != entry.value {
			if err := key.SetStringValue(entry.name, entry.value); err != nil {
				key.Close()
				return changed, fmt.Errorf("write file association value %q in %q: %w", entry.name, entry.path, err)
			}
			changed = true
		}
		if err := key.Close(); err != nil {
			return changed, fmt.Errorf("close file association key %q: %w", entry.path, err)
		}
	}
	if changed {
		shChangeNotify.Call(shcneAssocChanged, shcnfIDList, 0, 0)
	}
	return changed, nil
}

func executableInDirectory(executable, directory string) bool {
	relative, err := filepath.Rel(directory, executable)
	return err == nil && relative != "." && relative != ".." && !strings.HasPrefix(relative, `..\`) && !strings.HasPrefix(relative, "../")
}
