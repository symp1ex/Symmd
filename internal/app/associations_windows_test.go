//go:build windows

package app

import "testing"

func TestAssociationEntriesUseDistinctProgIDsIconsAndQuotedCommand(t *testing.T) {
	executable := `C:\Program Files\Symmd\symmd.exe`
	entries := associationEntries(executable)
	values := make(map[string]string, len(entries))
	for _, entry := range entries {
		values[entry.path+"\x00"+entry.name] = entry.value
	}

	wantCommand := `"C:\Program Files\Symmd\symmd.exe" "%1"`
	for _, progID := range []string{markdownProgID, logProgID} {
		path := `Software\Classes\` + progID + `\shell\open\command` + "\x00"
		if got := values[path]; got != wantCommand {
			t.Errorf("%s open command = %q, want %q", progID, got, wantCommand)
		}
	}
	if got := values[`Software\Classes\`+markdownProgID+`\DefaultIcon`+"\x00"]; got != `"C:\Program Files\Symmd\symmd.exe",-2` {
		t.Errorf("Markdown DefaultIcon = %q", got)
	}
	if got := values[`Software\Classes\`+logProgID+`\DefaultIcon`+"\x00"]; got != `"C:\Program Files\Symmd\symmd.exe",-3` {
		t.Errorf("Log DefaultIcon = %q", got)
	}
	if got := values[`Software\Symmd\Capabilities`+"\x00ApplicationIcon"]; got != `"C:\Program Files\Symmd\symmd.exe",-1` {
		t.Errorf("application icon = %q", got)
	}
	if got := values[`Software\Symmd\Capabilities\FileAssociations`+"\x00.md"]; got != markdownProgID {
		t.Errorf(".md capability = %q", got)
	}
	if got := values[`Software\Symmd\Capabilities\FileAssociations`+"\x00.log"]; got != logProgID {
		t.Errorf(".log capability = %q", got)
	}
}

func TestExecutableInDirectory(t *testing.T) {
	if !executableInDirectory(`C:\Users\test\AppData\Local\Temp\go-build\symmd.exe`, `C:\Users\test\AppData\Local\Temp`) {
		t.Fatal("temporary executable was not recognized")
	}
	if executableInDirectory(`C:\Program Files\Symmd\symmd.exe`, `C:\Users\test\AppData\Local\Temp`) {
		t.Fatal("installed executable was recognized as temporary")
	}
}
