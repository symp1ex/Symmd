//go:build windows

package window

import "testing"

func TestDisableBrowserAcceleratorKeysAllowsApplicationShortcuts(t *testing.T) {
	settings := &fakeBrowserAcceleratorSettings{enabled: true}
	if err := disableBrowserAcceleratorKeys(settings); err != nil {
		t.Fatal(err)
	}
	if settings.enabled {
		t.Fatal("browser accelerator keys remain enabled")
	}
}

func TestBrowserFindAcceleratorsAreEnabledOnlyForActivePreview(t *testing.T) {
	tests := []struct {
		name       string
		virtualKey uint
		control    bool
		preview    bool
		want       bool
	}{
		{name: "preview Ctrl+F", virtualKey: virtualKeyF, control: true, preview: true, want: true},
		{name: "editor Ctrl+F", virtualKey: virtualKeyF, control: true, preview: false},
		{name: "preview F without Ctrl", virtualKey: virtualKeyF, preview: true},
		{name: "preview F3", virtualKey: virtualKeyF3, preview: true, want: true},
		{name: "editor F3", virtualKey: virtualKeyF3, preview: false},
		{name: "preview Ctrl+S remains disabled", virtualKey: 'S', control: true, preview: true},
		{name: "preview Ctrl+P remains disabled", virtualKey: 'P', control: true, preview: true},
		{name: "preview F5 remains disabled", virtualKey: 0x74, preview: true},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			if got := isBrowserFindAccelerator(test.virtualKey, test.control, test.preview); got != test.want {
				t.Fatalf("isBrowserFindAccelerator() = %t, want %t", got, test.want)
			}
		})
	}
}

type fakeBrowserAcceleratorSettings struct{ enabled bool }

func (s *fakeBrowserAcceleratorSettings) PutAreBrowserAcceleratorKeysEnabled(enabled bool) error {
	s.enabled = enabled
	return nil
}
