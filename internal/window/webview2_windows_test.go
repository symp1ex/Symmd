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

type fakeBrowserAcceleratorSettings struct{ enabled bool }

func (s *fakeBrowserAcceleratorSettings) PutAreBrowserAcceleratorKeysEnabled(enabled bool) error {
	s.enabled = enabled
	return nil
}
